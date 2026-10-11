import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { ACTIVITY_TYPES, isValidDate } from './catalog.js';
import type { AppContext } from './context.js';
import { EVALUATION_CRITERIA } from './domain.js';
import { forbidden } from './errors.js';
import { currentUser, type createMiddleware } from './middleware.js';
import * as evaluations from './services/evaluations.js';
import { isManager } from './services/events.js';
import { getLeaderboard, myRanks } from './services/leaderboard.js';
import { performanceSummary } from './services/performance.js';
import * as bank from './services/questionBank.js';
import * as tests from './services/tests.js';
import { objectId, parse } from './validation.js';

/** Mock tests, the question bank, rankings and post-event performance evaluations. */
export function createTestRoutes(ctx: AppContext, mw: ReturnType<typeof createMiddleware>) {
  const router = Router();
  const { requireAuth, requireRole, requireVerifiedFaculty } = mw;
  const id = (req: Request) => parse(objectId, req.params.id);
  const date = z.string().refine(isValidDate, 'Choose a valid date').optional();

  const requireManager: RequestHandler = async (req, _res, next) => {
    if (!(await isManager(currentUser(req)))) throw forbidden();
    next();
  };

  // ------------------------------------------------------- student: tests
  // Every route here acts on the signed-in student; no user id is accepted.
  const student = Router();
  student.use(requireAuth, requireRole('student'));

  student.get('/tests', async (req, res) => {
    const user = currentUser(req);
    res.json({ tests: await tests.listTestsForStudent(user), ranks: await myRanks(ctx, user) });
  });
  student.post('/tests/start', mw.sensitiveLimiter, async (req, res) => {
    const { category } = parse(z.object({ category: z.enum(ACTIVITY_TYPES) }).strict(), req.body);
    res.status(201).json({ attempt: await tests.startAttempt(currentUser(req), category) });
  });
  // The eligibility-gated route: re-checks every mandatory rule for this
  // specific activity (skills, availability, conflicts, hours, experience)
  // against the database before unlocking its mock test. Nothing about
  // eligibility is taken from the client beyond the activity id.
  student.post('/activities/:id/tests/start', mw.sensitiveLimiter, async (req, res) => {
    res.status(201).json({ attempt: await tests.startAttemptForActivity(currentUser(req), id(req)) });
  });
  student.get('/attempts', async (req, res) => res.json({ attempts: await tests.listOwnAttempts(currentUser(req)) }));
  student.get('/attempts/:id', async (req, res) => res.json(await tests.getAttempt(currentUser(req), id(req))));
  student.put('/attempts/:id/answers', async (req, res) => res.json(await tests.saveAnswers(currentUser(req), id(req), req.body)));
  student.post('/attempts/:id/submit', mw.sensitiveLimiter, async (req, res) => {
    res.json({ result: await tests.submitAttempt(currentUser(req), id(req), req.body) });
  });
  student.get('/evaluations', async (req, res) => res.json(await evaluations.listOwnEvaluations(currentUser(req))));
  router.use('/student', student);

  // ------------------------------------------------------------ leaderboard
  // Students get the public columns for a category; organizers can also rank
  // against a specific activity. The service decides what each may see.
  router.get('/leaderboard', requireAuth, async (req, res) => {
    const q = parse(
      z.object({
        category: z.enum(ACTIVITY_TYPES).optional(),
        activityId: objectId.optional(),
        minScore: z.coerce.number().min(0).max(100).optional(),
        maxScore: z.coerce.number().min(0).max(100).optional(),
        eligible: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    res.json(await getLeaderboard(ctx, currentUser(req), { ...q, eligible: q.eligible === undefined ? undefined : q.eligible === 'true' }));
  });

  // ------------------------------------------- faculty: question management
  const faculty = Router();
  faculty.use(requireAuth, requireRole('faculty'), requireVerifiedFaculty);

  faculty.get('/questions', async (req, res) => {
    const q = parse(z.object({ category: z.enum(ACTIVITY_TYPES).optional(), active: z.enum(['true', 'false']).optional(), q: z.string().max(100).optional() }), req.query);
    res.json({ questions: await bank.listQuestions({ category: q.category, q: q.q, active: q.active === undefined ? undefined : q.active === 'true' }) });
  });
  faculty.post('/questions', async (req, res) => res.status(201).json({ question: await bank.createQuestion(currentUser(req), req.body) }));
  faculty.put('/questions/:id', async (req, res) => res.json({ question: await bank.updateQuestion(currentUser(req), id(req), req.body) }));
  faculty.post('/questions/:id/active', async (req, res) => {
    const { active } = parse(z.object({ active: z.boolean() }).strict(), req.body);
    res.json({ question: await bank.setQuestionActive(currentUser(req), id(req), active) });
  });

  faculty.get('/test-settings', async (_req, res) => res.json({ settings: [...(await bank.loadTestSettings()).values()] }));
  faculty.put('/test-settings', async (req, res) => {
    const { category, ...settings } = (req.body ?? {}) as Record<string, unknown>;
    res.json({ settings: await bank.saveTestSettings(currentUser(req), bank.parseCategory(category), settings) });
  });

  faculty.get('/performance', async (req, res) => {
    const filters = parse(z.object({ category: z.enum(ACTIVITY_TYPES).optional(), q: z.string().max(100).optional(), from: date, to: date }), req.query);
    res.json(await performanceSummary(ctx, currentUser(req), filters));
  });
  router.use('/faculty', faculty);

  // ------------------------------------------ managers: performance ratings
  const manage = Router();
  manage.use(requireAuth, requireManager);
  const evaluationFilters = z.object({ eventId: objectId.optional(), activityId: objectId.optional(), studentId: objectId.optional(), q: z.string().max(100).optional(), from: date, to: date });

  manage.get('/evaluations/criteria', (_req, res) => {
    res.json({ criteria: EVALUATION_CRITERIA.map((key) => ({ key, label: evaluations.CRITERIA_LABELS[key], weight: evaluations.CRITERIA_WEIGHTS[key] })) });
  });
  manage.get('/evaluations', async (req, res) => {
    res.json({ evaluations: await evaluations.listEvaluations(currentUser(req), parse(evaluationFilters, req.query)) });
  });
  manage.get('/evaluations/awaiting', async (req, res) => {
    res.json({ awaiting: await evaluations.listAwaitingEvaluation(currentUser(req), parse(evaluationFilters, req.query)) });
  });
  manage.post('/assignments/:id/evaluation', mw.sensitiveLimiter, async (req, res) => {
    res.status(201).json({ evaluation: await evaluations.submitEvaluation(currentUser(req), id(req), req.body) });
  });
  manage.put('/evaluations/:id', mw.sensitiveLimiter, async (req, res) => {
    res.json({ evaluation: await evaluations.correctEvaluation(currentUser(req), id(req), req.body) });
  });
  manage.get('/evaluations/:id/audit', async (req, res) => res.json({ audit: await evaluations.evaluationAudit(currentUser(req), id(req)) }));
  router.use('/manage', manage);

  return router;
}
