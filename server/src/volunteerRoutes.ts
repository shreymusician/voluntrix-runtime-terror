import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { ACTIVITY_TYPES, DEPARTMENTS, MAX_AVAILABILITY_SLOTS, MAX_SKILL_LENGTH, SEMESTERS, SUGGESTED_SKILLS, isValidDate } from './catalog.js';
import type { AppContext } from './context.js';
import { ASSIGNMENT_STATUSES } from './domain.js';
import { forbidden } from './errors.js';
import { currentUser, type createMiddleware } from './middleware.js';
import { generateAllocation } from './services/allocation.js';
import * as assignments from './services/assignments.js';
import * as events from './services/events.js';
import * as insights from './services/insights.js';
import { getOwnProfile, saveOwnProfile } from './services/volunteerProfile.js';
import { objectId, parse } from './validation.js';

/** Volunteer profiles, events, activities, allocation, assignments and analytics. */
export function createVolunteerRoutes(ctx: AppContext, mw: ReturnType<typeof createMiddleware>) {
  const router = Router();
  const { requireAuth, requireRole } = mw;
  const id = (req: Request) => parse(objectId, req.params.id);

  /** Verified faculty or a promoted organizer; checked against the database on every request. */
  const requireManager: RequestHandler = async (req, _res, next) => {
    if (!(await events.isManager(currentUser(req)))) throw forbidden();
    next();
  };

  const reasonBody = z.object({ reason: z.string().trim().max(500).default('') }).strict();
  const studentBody = z.object({ studentId: objectId }).strict();

  // Option lists and limits for the forms. Not sensitive, but sign-in is still required.
  router.get('/meta', requireAuth, (_req, res) => {
    res.json({
      suggestedSkills: SUGGESTED_SKILLS,
      activityTypes: ACTIVITY_TYPES,
      departments: DEPARTMENTS,
      semesters: SEMESTERS,
      limits: {
        maxSkills: ctx.config.maxSkills,
        maxSkillLength: MAX_SKILL_LENGTH,
        maxHoursPerDay: ctx.config.maxHoursPerDayLimit,
        maxAvailabilitySlots: MAX_AVAILABILITY_SLOTS,
      },
    });
  });

  // ----------------------------------------------------- student: own data
  // None of these take a user id: the student is always the session's user.
  router.get('/volunteer-profile', requireAuth, async (req, res) => {
    res.json({ profile: await getOwnProfile(currentUser(req)) });
  });

  router.put('/volunteer-profile', requireAuth, requireRole('student'), async (req, res) => {
    res.json({ profile: await saveOwnProfile(ctx, currentUser(req), req.body) });
  });

  const student = Router();
  student.use(requireAuth, requireRole('student'));
  student.get('/dashboard', async (req, res) => res.json(await insights.studentDashboard(ctx, currentUser(req))));
  student.get('/activities', async (req, res) => res.json({ activities: await insights.listAvailableActivities(currentUser(req)) }));
  // Vacant positions to explore when nothing currently suits the student.
  // Eligibility is evaluated per activity here too; a vacancy never implies one.
  student.get('/vacancies', async (req, res) => res.json(await insights.listVacantOpportunities(currentUser(req))));
  student.get('/assignments', async (req, res) => res.json({ assignments: await assignments.listOwnAssignments(currentUser(req)) }));
  // Volunteering for an activity. Eligibility, capacity, conflicts and
  // duplicates are all re-checked on the server inside one transaction.
  student.post('/activities/:id/apply', mw.sensitiveLimiter, async (req, res) => {
    res.status(201).json({ assignment: await assignments.applyForActivity(currentUser(req), id(req)) });
  });
  student.post('/assignments/:id/cancel', mw.sensitiveLimiter, async (req, res) => {
    const { reason } = parse(reasonBody, req.body);
    res.json({ assignment: await assignments.cancelOwnAssignment(currentUser(req), id(req), reason) });
  });
  router.use('/student', student);

  // ------------------------------------------------- managers: events etc.
  const manage = Router();
  manage.use(requireAuth, requireManager);

  manage.get('/events', async (req, res) => res.json({ events: await events.listEvents(currentUser(req)) }));
  manage.post('/events', async (req, res) => res.status(201).json({ event: await events.createEvent(currentUser(req), req.body) }));
  manage.get('/events/:id', async (req, res) => res.json({ event: await events.getEventDetail(currentUser(req), id(req)) }));
  manage.put('/events/:id', async (req, res) => res.json({ event: await events.updateEvent(currentUser(req), id(req), req.body) }));
  manage.delete('/events/:id', async (req, res) => {
    await events.deleteEvent(currentUser(req), id(req));
    res.json({ ok: true });
  });

  manage.post('/events/:id/activities', async (req, res) => {
    res.status(201).json({ activity: await events.createActivity(ctx, currentUser(req), id(req), req.body) });
  });
  manage.put('/activities/:id', async (req, res) => {
    const manager = currentUser(req);
    const activity = await events.updateActivity(ctx, manager, id(req), req.body);
    // Changing an activity re-validates everyone assigned to it; anything
    // that no longer satisfies the rules is returned (and flagged in lists).
    const affected = (await assignments.listManagedAssignments(manager, { activityId: activity.id })).filter((a) => a.issues.length);
    res.json({ activity, affectedAssignments: affected.map((a) => ({ id: a.id, student: a.student, status: a.status, issues: a.issues })) });
  });
  manage.delete('/activities/:id', async (req, res) => {
    await events.deleteActivity(currentUser(req), id(req));
    res.json({ ok: true });
  });

  // -------------------------------------------------------------- allocation
  manage.post('/events/:id/allocate', mw.sensitiveLimiter, async (req, res) => {
    const options = parse(z.object({ clearPending: z.boolean().default(false) }).strict(), req.body);
    res.json({ report: await generateAllocation(ctx, currentUser(req), id(req), options) });
  });
  manage.post('/events/:id/assignments/confirm-all', mw.sensitiveLimiter, async (req, res) => {
    res.json(await assignments.confirmAllPending(ctx, currentUser(req), id(req)));
  });
  manage.get('/activities/:id/candidates', async (req, res) => res.json(await assignments.listCandidates(ctx, currentUser(req), id(req))));
  manage.post('/activities/:id/assignments', mw.sensitiveLimiter, async (req, res) => {
    const { studentId } = parse(studentBody, req.body);
    res.status(201).json({ assignment: await assignments.assignManually(currentUser(req), id(req), studentId) });
  });

  // ------------------------------------------------------------- assignments
  manage.get('/assignments', async (req, res) => {
    const filters = parse(
      z.object({
        eventId: objectId.optional(),
        activityId: objectId.optional(),
        status: z.enum(ASSIGNMENT_STATUSES).optional(),
        date: z.string().refine(isValidDate, 'Choose a valid date').optional(),
        q: z.string().max(100).optional(),
      }),
      req.query,
    );
    res.json({ assignments: await assignments.listManagedAssignments(currentUser(req), filters) });
  });
  manage.post('/assignments/:id/confirm', mw.sensitiveLimiter, async (req, res) => {
    res.json({ assignment: await assignments.confirmAssignment(ctx, currentUser(req), id(req)) });
  });
  manage.post('/assignments/:id/reject', mw.sensitiveLimiter, async (req, res) => {
    const { reason } = parse(reasonBody, req.body);
    res.json({ assignment: await assignments.rejectAssignment(currentUser(req), id(req), reason) });
  });
  manage.post('/assignments/:id/cancel', mw.sensitiveLimiter, async (req, res) => {
    const { reason } = parse(reasonBody, req.body);
    res.json({ assignment: await assignments.cancelAssignmentAsManager(currentUser(req), id(req), reason) });
  });
  manage.post('/assignments/:id/replace', mw.sensitiveLimiter, async (req, res) => {
    const { studentId } = parse(studentBody, req.body);
    res.json({ assignment: await assignments.replaceVolunteer(currentUser(req), id(req), studentId) });
  });
  manage.post('/assignments/:id/outcome', mw.sensitiveLimiter, async (req, res) => {
    const input = parse(
      z.object({ attendance: z.enum(['attended', 'absent']) }).strict(),
      req.body,
    );
    res.json({ assignment: await assignments.recordOutcome(currentUser(req), id(req), input) });
  });

  // ---------------------------------------------------- volunteers, analytics
  manage.get('/volunteers', async (req, res) => {
    const filters = parse(z.object({ q: z.string().max(100).optional(), skill: z.string().max(60).optional() }), req.query);
    res.json({ volunteers: await insights.listVolunteers(currentUser(req), filters) });
  });
  manage.get('/analytics', async (req, res) => {
    const { eventId } = parse(z.object({ eventId: objectId.optional() }), req.query);
    res.json(await insights.analytics(currentUser(req), eventId));
  });

  router.use('/manage', manage);
  return router;
}
