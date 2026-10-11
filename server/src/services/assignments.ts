import mongoose, { type ClientSession, type Types } from 'mongoose';
import { hoursBetween } from '../catalog.js';
import type { AppContext } from '../context.js';
import { ACTIVE_ASSIGNMENT_STATUSES, type AssignmentStatus } from '../domain.js';
import { HttpError, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import {
  Activity,
  Assignment,
  Event,
  Notification,
  PerformanceEvaluation,
  StudentProfile,
  User,
  type ActivityDoc,
  type AssignmentDoc,
  type EventDoc,
  type UserDoc,
} from '../models.js';
import { activityBlocker, checkVolunteer, loadVolunteers, type Violation, type Volunteer } from './eligibility.js';
import { eventMapSummary, loadManagedActivity, loadManagedEvent, managedEventFilter } from './events.js';
import { defaultScoring, scoreVolunteer, totalLoad } from './scoring.js';

const notEligible = (name: string, violations: Violation[]) =>
  unprocessable(`${name} cannot take this activity: ${violations.map((v) => v.message).join('; ')}`, 'NOT_ELIGIBLE', { violations });

const liveCount = (activityId: Types.ObjectId, statuses: AssignmentStatus[], session: ClientSession) =>
  Assignment.countDocuments({ activityId, status: { $in: statuses } }).session(session);

/**
 * Takes the per-student and per-activity write locks for this transaction.
 * Bumping these counters makes concurrent transactions touching the same
 * student or activity conflict and retry, so two requests cannot both pass
 * the overlap / hours / capacity checks and then both write.
 */
async function lockForSeat(studentId: Types.ObjectId | string, activityId: Types.ObjectId | string, session: ClientSession) {
  const profile = await StudentProfile.findOneAndUpdate({ userId: studentId }, { $inc: { assignmentVersion: 1 } }, { session });
  if (!profile) throw notFound('Student not found');
  const activity = await Activity.findOneAndUpdate({ _id: activityId }, { $inc: { seatVersion: 1 } }, { session, new: true });
  if (!activity) throw notFound('Activity not found');
  const event = await Event.findById(activity.eventId).session(session);
  if (!event) throw notFound('Event not found');
  const volunteer = (await loadVolunteers({ studentIds: [studentId], session })).get(String(studentId));
  if (!volunteer) throw notFound('Student not found');
  return { activity, event, volunteer };
}

interface Placement {
  activityId: Types.ObjectId | string;
  studentId: Types.ObjectId | string;
  source: 'auto' | 'manual';
  actor: UserDoc;
  score?: number | null;
  explanation?: string[];
}

/**
 * Creates one pending assignment inside an open transaction, re-checking
 * every hard constraint against the latest committed data first. Automatic
 * allocation and manual changes both end up here.
 */
export async function placeVolunteer(placement: Placement, session: ClientSession): Promise<AssignmentDoc> {
  const { activity, event, volunteer } = await lockForSeat(placement.studentId, placement.activityId, session);

  const blocker = activityBlocker(activity, event);
  if (blocker) throw conflict(blocker, 'ACTIVITY_NOT_OPEN');
  const violations = checkVolunteer(volunteer, activity);
  if (violations.length) throw notEligible(volunteer.user.fullName, violations);
  if ((await liveCount(activity._id, ACTIVE_ASSIGNMENT_STATUSES, session)) >= activity.requiredCount) {
    throw conflict(`"${activity.name}" already has all ${activity.requiredCount} positions filled`, 'CAPACITY_FULL');
  }

  const [assignment] = await Assignment.create(
    [
      {
        eventId: activity.eventId,
        activityId: activity._id,
        studentId: volunteer.user._id,
        status: 'pending',
        source: placement.source,
        score: placement.score ?? null,
        explanation: placement.explanation ?? [],
        createdBy: placement.actor._id,
      },
    ],
    { session },
  );
  await Notification.create(
    [
      {
        userId: volunteer.user._id,
        type: 'assignment_pending',
        title: 'New volunteer assignment proposed',
        message: `You have been proposed for "${activity.name}" (${event.name}) on ${activity.date}, ${activity.startTime}–${activity.endTime}. It is awaiting confirmation.`,
      },
    ],
    { session },
  );
  return assignment;
}

// ------------------------------------------------------------- candidates

/**
 * Every active student, split into those who pass all mandatory rules for
 * the activity (ranked by suitability) and those who do not (with reasons).
 */
export async function rankCandidates(ctx: AppContext, activity: ActivityDoc, volunteers: Map<string, Volunteer>) {
  const weights = { ...defaultScoring, ...ctx.scoring };
  const eligible: Volunteer[] = [];
  const ineligible: { volunteer: Volunteer; violations: Violation[] }[] = [];
  for (const volunteer of volunteers.values()) {
    const violations = checkVolunteer(volunteer, activity);
    if (violations.length) ineligible.push({ volunteer, violations });
    else eligible.push(volunteer);
  }
  const maxLoad = Math.max(0, ...eligible.map(totalLoad));
  const ranked = eligible
    .map((volunteer) => ({ volunteer, ...scoreVolunteer(volunteer, activity, maxLoad, weights) }))
    .sort((a, b) => b.score - a.score || totalLoad(a.volunteer) - totalLoad(b.volunteer) || a.volunteer.usn.localeCompare(b.volunteer.usn));
  return { ranked, ineligible };
}

const volunteerCard = (v: Volunteer) => ({ id: v.id, fullName: v.user.fullName, usn: v.usn, department: v.department, skills: v.skills });

export async function listCandidates(ctx: AppContext, manager: UserDoc, activityId: string) {
  const { activity } = await loadManagedActivity(manager, activityId);
  const { ranked, ineligible } = await rankCandidates(ctx, activity, await loadVolunteers());
  return {
    eligible: ranked.map((r) => ({ ...volunteerCard(r.volunteer), score: r.score, explanation: r.explanation })),
    ineligible: ineligible.map((i) => ({ ...volunteerCard(i.volunteer), reasons: i.violations.map((v) => v.message) })),
  };
}

// ---------------------------------------------------------- manager actions

async function loadManagedAssignment(manager: UserDoc, assignmentId: string) {
  const assignment = await Assignment.findById(assignmentId);
  if (!assignment) throw notFound('Assignment not found');
  const { activity, event } = await loadManagedActivity(manager, String(assignment.activityId));
  return { assignment, activity, event };
}

export async function assignManually(manager: UserDoc, activityId: string, studentId: string) {
  await loadManagedActivity(manager, activityId);
  const assignment = await mongoose.connection.transaction((session) =>
    placeVolunteer({ activityId, studentId, source: 'manual', actor: manager, explanation: ['Assigned manually'] }, session),
  );
  return { id: assignment.id as string, status: assignment.status };
}

/**
 * A student volunteering for an activity themselves. The student id is taken
 * from the session and never from the request, and `placeVolunteer` re-checks
 * the activity's state, every mandatory rule, schedule conflicts and capacity
 * inside the transaction — so a stale page, a direct API call or a double
 * submission cannot bypass eligibility or overfill the activity (the unique
 * live-assignment index rejects the duplicate). The result is `pending`, like
 * any other proposal, until an organizer confirms it.
 */
export async function applyForActivity(student: UserDoc, activityId: string) {
  const assignment = await mongoose.connection.transaction((session) =>
    placeVolunteer({ activityId, studentId: student.id as string, source: 'manual', actor: student, explanation: ['Volunteered by the student'] }, session),
  );
  return { id: assignment.id as string, status: assignment.status };
}

/**
 * Confirms a pending assignment. All constraints are checked again at this
 * moment, on the server, because availability, other assignments or the
 * activity itself may have changed since the proposal was made.
 */
export async function confirmAssignment(ctx: AppContext, manager: UserDoc, assignmentId: string) {
  const { assignment, activity } = await loadManagedAssignment(manager, assignmentId);
  try {
    await mongoose.connection.transaction(async (session) => {
      const locked = await lockForSeat(assignment.studentId, assignment.activityId, session);
      const current = await Assignment.findById(assignment._id).session(session);
      if (!current || current.status !== 'pending') throw conflict('Only a pending assignment can be confirmed', 'INVALID_STATE');

      const blocker = activityBlocker(locked.activity, locked.event);
      if (blocker) throw conflict(blocker, 'ACTIVITY_NOT_OPEN');
      const violations = checkVolunteer(locked.volunteer, locked.activity, current.id as string);
      if (violations.length) throw notEligible(locked.volunteer.user.fullName, violations);
      if ((await liveCount(locked.activity._id, ['confirmed'], session)) >= locked.activity.requiredCount) {
        throw conflict(`"${locked.activity.name}" already has ${locked.activity.requiredCount} confirmed volunteers`, 'CAPACITY_FULL');
      }

      current.set({ status: 'confirmed', decidedBy: manager._id, decidedAt: new Date(), statusReason: null });
      await current.save({ session });
      await Notification.create(
        [
          {
            userId: current.studentId,
            type: 'assignment_confirmed',
            title: 'Assignment confirmed',
            message: `You are confirmed for "${locked.activity.name}" (${locked.event.name}) on ${locked.activity.date}, ${locked.activity.startTime}–${locked.activity.endTime} at ${locked.activity.location}.`,
          },
        ],
        { session },
      );
    });
  } catch (err) {
    // An invalid assignment is refused, with eligible alternatives offered.
    if (err instanceof HttpError && err.code === 'NOT_ELIGIBLE') {
      const { ranked } = await rankCandidates(ctx, activity, await loadVolunteers());
      err.details = {
        ...(err.details as object),
        alternatives: ranked.slice(0, 5).map((r) => ({ ...volunteerCard(r.volunteer), score: r.score })),
      };
    }
    throw err;
  }
  return { id: assignment.id as string, status: 'confirmed' as const };
}

async function closeAssignment(
  assignment: AssignmentDoc,
  actor: UserDoc,
  status: 'rejected' | 'cancelled',
  reason: string,
  notice: { userId: Types.ObjectId; type: string; title: string; message: string } | null,
  session: ClientSession,
) {
  const allowedFrom: AssignmentStatus[] = status === 'rejected' ? ['pending'] : ['pending', 'confirmed'];
  const updated = await Assignment.findOneAndUpdate(
    { _id: assignment._id, status: { $in: allowedFrom } },
    { status, statusReason: reason, decidedBy: actor._id, decidedAt: new Date() },
    { session },
  );
  if (!updated) throw conflict(`This assignment is ${assignment.status} and cannot be ${status}`, 'INVALID_STATE');
  if (notice) await Notification.create([notice], { session });
}

export async function rejectAssignment(manager: UserDoc, assignmentId: string, reason: string) {
  const { assignment, activity } = await loadManagedAssignment(manager, assignmentId);
  await mongoose.connection.transaction((session) =>
    closeAssignment(assignment, manager, 'rejected', reason, {
      userId: assignment.studentId,
      type: 'assignment_rejected',
      title: 'Assignment not confirmed',
      message: `Your proposed assignment to "${activity.name}" was not confirmed.${reason ? ` Reason: ${reason}` : ''}`,
    }, session),
  );
  return { id: assignment.id as string, status: 'rejected' as const };
}

export async function cancelAssignmentAsManager(manager: UserDoc, assignmentId: string, reason: string) {
  const { assignment, activity } = await loadManagedAssignment(manager, assignmentId);
  await mongoose.connection.transaction((session) =>
    closeAssignment(assignment, manager, 'cancelled', reason, {
      userId: assignment.studentId,
      type: 'assignment_cancelled',
      title: 'Assignment cancelled',
      message: `Your assignment to "${activity.name}" was cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    }, session),
  );
  return { id: assignment.id as string, status: 'cancelled' as const };
}

/** A student withdrawing from their own assignment; the seat becomes a vacancy. */
export async function cancelOwnAssignment(student: UserDoc, assignmentId: string, reason: string) {
  // Looked up by owner, so another student's assignment is simply not found.
  const assignment = await Assignment.findOne({ _id: assignmentId, studentId: student._id });
  if (!assignment) throw notFound('Assignment not found');
  const activity = await Activity.findById(assignment.activityId);
  const event = await Event.findById(assignment.eventId);
  if (!activity || !event) throw notFound('Assignment not found');
  if (activity.startAt <= new Date()) throw conflict('This activity has already started, so the assignment can no longer be cancelled', 'INVALID_STATE');

  await mongoose.connection.transaction((session) =>
    closeAssignment(assignment, student, 'cancelled', reason || 'Cancelled by the volunteer', {
      userId: event.createdBy,
      type: 'volunteer_cancelled',
      title: 'A volunteer cancelled',
      message: `${student.fullName} cancelled their assignment to "${activity.name}" (${event.name}). The position is vacant again.`,
    }, session),
  );
  return { id: assignment.id as string, status: 'cancelled' as const };
}

/**
 * Swaps the volunteer on an assignment. The old seat is released and the
 * replacement placed in one transaction, so if the replacement fails any
 * rule the original assignment is left exactly as it was.
 */
export async function replaceVolunteer(manager: UserDoc, assignmentId: string, studentId: string) {
  const { assignment, activity } = await loadManagedAssignment(manager, assignmentId);
  if (String(assignment.studentId) === studentId) throw conflict('That volunteer already holds this assignment', 'INVALID_STATE');
  const replacement = await mongoose.connection.transaction(async (session) => {
    await closeAssignment(assignment, manager, 'cancelled', 'Replaced by another volunteer', {
      userId: assignment.studentId,
      type: 'assignment_cancelled',
      title: 'Assignment reassigned',
      message: `Your assignment to "${activity.name}" was given to another volunteer.`,
    }, session);
    return placeVolunteer({ activityId: activity._id, studentId, source: 'manual', actor: manager, explanation: ['Assigned as a replacement'] }, session);
  });
  return { id: replacement.id as string, status: replacement.status, replaced: assignment.id as string };
}

/** Confirms every pending assignment of an event that still passes the rules. */
export async function confirmAllPending(ctx: AppContext, manager: UserDoc, eventId: string) {
  const event = await loadManagedEvent(manager, eventId);
  const pending = await Assignment.find({ eventId: event._id, status: 'pending' }).sort({ createdAt: 1 });
  const failed: { id: string; error: string }[] = [];
  let confirmed = 0;
  for (const assignment of pending) {
    try {
      await confirmAssignment(ctx, manager, assignment.id as string);
      confirmed++;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      failed.push({ id: assignment.id as string, error: err.message });
    }
  }
  return { confirmed, failed };
}

/**
 * Attendance, recorded once the activity is over. Ratings are a separate
 * record (see evaluations.ts) so they have their own reviewer and audit trail.
 */
export async function recordOutcome(manager: UserDoc, assignmentId: string, input: { attendance: 'attended' | 'absent' }) {
  const { assignment, activity } = await loadManagedAssignment(manager, assignmentId);
  if (assignment.status !== 'confirmed') throw conflict('Attendance can only be recorded for confirmed assignments', 'INVALID_STATE');
  if (activity.endAt > new Date()) throw conflict('Attendance can be recorded after the activity has ended', 'INVALID_STATE');
  if (input.attendance === 'absent' && (await PerformanceEvaluation.exists({ assignmentId: assignment._id }))) {
    throw conflict('This volunteer already has a performance evaluation for this activity, so they cannot be marked absent', 'INVALID_STATE');
  }
  assignment.attendance = input.attendance;
  await assignment.save();
  return { id: assignment.id as string, attendance: assignment.attendance };
}

// ------------------------------------------------------------------ listing

/**
 * Problems with live assignments, computed from current data each time so a
 * changed activity, profile or capacity shows up immediately.
 */
export async function findIssues(assignments: AssignmentDoc[], activities: Map<string, ActivityDoc>, events: Map<string, EventDoc>) {
  const live = assignments.filter((a) => (ACTIVE_ASSIGNMENT_STATUSES as string[]).includes(a.status));
  const now = new Date();
  const volunteers = await loadVolunteers({ studentIds: [...new Set(live.map((a) => String(a.studentId)))] });
  const confirmedPerActivity = new Map<string, number>();
  for (const a of live) if (a.status === 'confirmed') confirmedPerActivity.set(String(a.activityId), (confirmedPerActivity.get(String(a.activityId)) ?? 0) + 1);

  const issues = new Map<string, string[]>();
  for (const assignment of live) {
    const activity = activities.get(String(assignment.activityId));
    const event = events.get(String(assignment.eventId));
    const volunteer = volunteers.get(String(assignment.studentId));
    if (!activity || !event || activity.endAt <= now) continue; // finished activities are history, not conflicts
    const found: string[] = [];
    const blocker = activityBlocker(activity, event, now);
    if (blocker) found.push(blocker);
    if (!volunteer) found.push('Student account no longer exists');
    else found.push(...checkVolunteer(volunteer, activity, assignment.id as string).map((v) => v.message));
    if (assignment.status === 'confirmed' && (confirmedPerActivity.get(activity.id as string) ?? 0) > activity.requiredCount) {
      found.push(`More volunteers confirmed than the ${activity.requiredCount} required`);
    }
    if (found.length) issues.set(assignment.id as string, found);
  }
  return issues;
}

function describe(assignment: AssignmentDoc, activity: ActivityDoc, event: EventDoc, rating: number | null) {
  return {
    id: assignment.id as string,
    status: assignment.status as AssignmentStatus,
    source: assignment.source,
    statusReason: assignment.statusReason ?? null,
    attendance: assignment.attendance ?? null,
    // Average overall rating from post-event evaluations of this assignment, if any.
    rating,
    hours: Math.round(hoursBetween(activity.startAt, activity.endAt) * 100) / 100,
    ended: activity.endAt <= new Date(),
    started: activity.startAt <= new Date(),
    activity: {
      id: activity.id as string,
      name: activity.name,
      date: activity.date,
      startTime: activity.startTime,
      endTime: activity.endTime,
      location: activity.location,
      instructions: activity.instructions,
      requiredCount: activity.requiredCount,
    },
    event: { id: event.id as string, name: event.name, venue: event.venue, ...eventMapSummary(event) },
  };
}

async function withContext(assignments: AssignmentDoc[]) {
  const [activities, events] = await Promise.all([
    Activity.find({ _id: { $in: assignments.map((a) => a.activityId) } }),
    Event.find({ _id: { $in: assignments.map((a) => a.eventId) } }),
  ]);
  const ratings = await PerformanceEvaluation.aggregate<{ _id: unknown; rating: number }>([
    { $match: { assignmentId: { $in: assignments.map((a) => a._id) } } },
    { $group: { _id: '$assignmentId', rating: { $avg: '$overall' } } },
  ]);
  return {
    activities: new Map(activities.map((a) => [a.id as string, a])),
    events: new Map(events.map((e) => [e.id as string, e])),
    ratings: new Map(ratings.map((r) => [String(r._id), Math.round(r.rating * 10) / 10])),
  };
}

export interface AssignmentFilters {
  eventId?: string;
  activityId?: string;
  status?: AssignmentStatus;
  date?: string;
  q?: string;
}

export async function listManagedAssignments(manager: UserDoc, filters: AssignmentFilters) {
  const events = await Event.find({ ...managedEventFilter(manager), ...(filters.eventId ? { _id: filters.eventId } : {}) });
  if (filters.eventId && !events.length) throw forbidden();
  const query: Record<string, unknown> = { eventId: { $in: events.map((e) => e._id) } };
  if (filters.activityId) query.activityId = filters.activityId;
  if (filters.status) query.status = filters.status;
  if (filters.date) {
    const onDate = await Activity.find({ eventId: { $in: events.map((e) => e._id) }, date: filters.date }).select('_id');
    query.activityId = filters.activityId ? { $in: onDate.map((a) => a._id).filter((id) => String(id) === filters.activityId) } : { $in: onDate.map((a) => a._id) };
  }

  const assignments = await Assignment.find(query).sort({ createdAt: -1 }).limit(1000);
  const ctx = await withContext(assignments);
  const [students, profiles, issues] = await Promise.all([
    User.find({ _id: { $in: assignments.map((a) => a.studentId) } }),
    StudentProfile.find({ userId: { $in: assignments.map((a) => a.studentId) } }),
    findIssues(assignments, ctx.activities, ctx.events),
  ]);
  const studentById = new Map(students.map((s) => [s.id as string, s]));
  const usnById = new Map(profiles.map((p) => [String(p.userId), p.usn]));
  const needle = filters.q?.trim().toLowerCase();

  return assignments.flatMap((assignment) => {
    const activity = ctx.activities.get(String(assignment.activityId));
    const event = ctx.events.get(String(assignment.eventId));
    const student = studentById.get(String(assignment.studentId));
    if (!activity || !event || !student) return [];
    const usn = usnById.get(student.id as string) ?? '';
    if (needle && !student.fullName.toLowerCase().includes(needle) && !usn.toLowerCase().includes(needle)) return [];
    return [
      {
        ...describe(assignment, activity, event, ctx.ratings.get(assignment.id as string) ?? null),
        score: assignment.score ?? null,
        explanation: assignment.explanation,
        issues: issues.get(assignment.id as string) ?? [],
        student: { id: student.id as string, fullName: student.fullName, usn },
      },
    ];
  });
}

/** A student's own assignments only — the query is always scoped to their id. */
export async function listOwnAssignments(student: UserDoc) {
  const assignments = await Assignment.find({ studentId: student._id }).sort({ createdAt: -1 }).limit(500);
  const ctx = await withContext(assignments);
  return assignments
    .flatMap((assignment) => {
      const activity = ctx.activities.get(String(assignment.activityId));
      const event = ctx.events.get(String(assignment.eventId));
      return activity && event ? [describe(assignment, activity, event, ctx.ratings.get(assignment.id as string) ?? null)] : [];
    })
    .sort((a, b) => a.activity.date.localeCompare(b.activity.date) || a.activity.startTime.localeCompare(b.activity.startTime));
}
