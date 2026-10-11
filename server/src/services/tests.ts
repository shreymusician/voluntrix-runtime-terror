import { randomInt } from 'node:crypto';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { ACTIVITY_TYPES, type ActivityCategory } from '../catalog.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.js';
import { Activity, Event, Question, StudentProfile, TestAttempt, type ActivityDoc, type QuestionDoc, type TestAttemptDoc, type UserDoc } from '../models.js';
import { activityBlocker, checkVolunteer, loadVolunteers } from './eligibility.js';
import { loadTestSettings, type TestSettings } from './questionBank.js';

/** Allowance for network delay between the browser timer reaching zero and the request arriving. */
const SUBMIT_GRACE_MS = 10_000;

/** Exactly how many questions an activity-gated assessment carries, regardless of the category's configured practice-test length. */
const ACTIVITY_TEST_QUESTION_COUNT = 10;
const WEAK_TOPIC_PERCENT = 60;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --------------------------------------------------------------- evaluation

/** Marks an attempt from the answer key stored with it. Runs only on the server. */
function evaluate(attempt: TestAttemptDoc) {
  const topics = new Map<string, { topic: string; totalMarks: number; marksObtained: number; questions: number; correct: number }>();
  let totalMarks = 0;
  let marksObtained = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;

  for (const q of attempt.questions) {
    const entry = topics.get(q.topic) ?? { topic: q.topic, totalMarks: 0, marksObtained: 0, questions: 0, correct: 0 };
    entry.totalMarks += q.marks;
    entry.questions += 1;
    totalMarks += q.marks;
    if (q.selectedIndex === null || q.selectedIndex === undefined) unanswered++;
    else if (q.selectedIndex === q.correctIndex) {
      correct++;
      marksObtained += q.marks;
      entry.marksObtained += q.marks;
      entry.correct += 1;
    } else incorrect++;
    topics.set(q.topic, entry);
  }

  const percent = totalMarks ? Math.round((marksObtained / totalMarks) * 1000) / 10 : 0;
  return {
    totalMarks,
    marksObtained,
    percent,
    correct,
    incorrect,
    unanswered,
    passed: percent >= attempt.passingPercent,
    topics: [...topics.values()],
  };
}

/**
 * Closes attempts whose time has run out, marking them from whatever
 * answers had been saved by then. This is what makes an interrupted test
 * safe: closing the tab neither loses the saved answers nor leaves the
 * attempt open, and nothing sent after the deadline can add marks.
 */
export async function closeExpiredAttempts(filter: { studentId?: Types.ObjectId | string; category?: string } = {}) {
  const cutoff = new Date(Date.now() - SUBMIT_GRACE_MS);
  const expired = await TestAttempt.find({ ...filter, status: 'in_progress', deadlineAt: { $lt: cutoff } });
  for (const attempt of expired) {
    await TestAttempt.updateOne(
      { _id: attempt._id, status: 'in_progress' },
      { status: 'submitted', submittedAt: attempt.deadlineAt, autoSubmitted: true, result: evaluate(attempt) },
    );
  }
  return expired.length;
}

// ---------------------------------------------------------------- qualifying

export interface QualifyingResult {
  attemptId: string;
  studentId: string;
  category: ActivityCategory;
  percent: number;
  passed: boolean;
  submittedAt: Date;
  attemptsUsed: number;
}

/**
 * The one completed attempt per student and category that counts, chosen by
 * the category's policy ('best' or 'latest'). Rankings, eligibility and
 * allocation all read test results through this function, so a student can
 * never appear twice for one category.
 */
export async function loadQualifyingResults(filter: { studentIds?: (Types.ObjectId | string)[]; category?: string } = {}) {
  await closeExpiredAttempts(filter.category ? { category: filter.category } : {});
  const settings = await loadTestSettings();
  const attempts = await TestAttempt.find({
    status: 'submitted',
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.studentIds ? { studentId: { $in: filter.studentIds } } : {}),
  })
    .select('studentId category attemptNumber submittedAt result')
    .sort({ attemptNumber: 1 });

  const chosen = new Map<string, QualifyingResult>();
  for (const attempt of attempts) {
    const policy = settings.get(attempt.category as ActivityCategory)?.qualifyingAttempt ?? 'best';
    const key = `${attempt.studentId}|${attempt.category}`;
    const current = chosen.get(key);
    const percent = attempt.result?.percent ?? 0;
    // Attempts arrive oldest first: 'latest' always replaces; 'best' only on a strictly higher score.
    const replaces = !current || policy === 'latest' || percent > current.percent;
    chosen.set(key, {
      ...(replaces
        ? {
            attemptId: attempt.id as string,
            studentId: String(attempt.studentId),
            category: attempt.category as ActivityCategory,
            percent,
            passed: Boolean(attempt.result?.passed),
            submittedAt: attempt.submittedAt ?? attempt.updatedAt,
          }
        : current!),
      attemptsUsed: (current?.attemptsUsed ?? 0) + 1,
    });
  }
  return chosen;
}

export const resultKey = (studentId: string, category: string) => `${studentId}|${category}`;

// -------------------------------------------------------------- student API

type Access = { allowed: true } | { allowed: false; reason: string };

/** A student may take a category's test once their profile is complete and they have chosen that category as a preference. */
function accessFor(profile: { profileCompletedAt?: Date | null; preferences: string[] } | null, settings: TestSettings, questionsAvailable: number): Access {
  if (!profile) return { allowed: false, reason: 'Only student accounts can take mock tests' };
  if (!profile.profileCompletedAt) return { allowed: false, reason: 'Complete your volunteer profile first' };
  if (!settings.active) return { allowed: false, reason: 'This test is not open at the moment' };
  if (!profile.preferences.includes(settings.category)) return { allowed: false, reason: 'Add this activity to your preferences in your profile to unlock its test' };
  if (questionsAvailable === 0) return { allowed: false, reason: 'No questions are available for this test yet' };
  return { allowed: true };
}

async function activeQuestionCounts() {
  const rows = await Question.aggregate<{ _id: string; count: number }>([{ $match: { active: true } }, { $group: { _id: '$category', count: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, r.count]));
}

function summarize(attempt: TestAttemptDoc) {
  return {
    id: attempt.id as string,
    category: attempt.category,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    autoSubmitted: attempt.autoSubmitted,
    result: attempt.result
      ? {
          totalMarks: attempt.result.totalMarks,
          marksObtained: attempt.result.marksObtained,
          percent: attempt.result.percent,
          correct: attempt.result.correct,
          incorrect: attempt.result.incorrect,
          unanswered: attempt.result.unanswered,
          passed: attempt.result.passed,
        }
      : null,
  };
}

/** The mock-test selection page: every category, whether this student may take it, and where they stand. */
export async function listTestsForStudent(student: UserDoc) {
  await closeExpiredAttempts({ studentId: student._id });
  const [settings, profile, counts, attempts, qualifying] = await Promise.all([
    loadTestSettings(),
    StudentProfile.findOne({ userId: student._id }),
    activeQuestionCounts(),
    TestAttempt.find({ studentId: student._id }).sort({ attemptNumber: 1 }),
    loadQualifyingResults({ studentIds: [student._id] }),
  ]);

  return ACTIVITY_TYPES.map((category) => {
    const config = settings.get(category)!;
    const mine = attempts.filter((a) => a.category === category);
    const open = mine.find((a) => a.status === 'in_progress');
    const completed = mine.filter((a) => a.status === 'submitted');
    const available = counts.get(category) ?? 0;
    const access = accessFor(profile, config, available);
    const attemptsLeft = Math.max(0, config.maxAttempts - mine.length);
    const best = qualifying.get(resultKey(student.id as string, category));
    return {
      category,
      durationMinutes: config.durationMinutes,
      questionCount: Math.min(config.questionCount, available),
      passingPercent: config.passingPercent,
      maxAttempts: config.maxAttempts,
      qualifyingAttempt: config.qualifyingAttempt,
      preferred: Boolean(profile?.preferences.includes(category)),
      allowed: access.allowed,
      blockedReason: access.allowed ? null : access.reason,
      attemptsUsed: mine.length,
      attemptsLeft,
      canStart: access.allowed && !open && attemptsLeft > 0,
      inProgressAttemptId: open ? (open.id as string) : null,
      latest: completed.length ? summarize(completed[completed.length - 1]) : null,
      qualifying: best ? { attemptId: best.attemptId, percent: best.percent, passed: best.passed } : null,
    };
  });
}

/** An attempt as the student may see it while it is running: no answer key, no explanations. */
function runningView(attempt: TestAttemptDoc) {
  return {
    ...summarize(attempt),
    deadlineAt: attempt.deadlineAt,
    // The client counts down from this; the deadline itself is enforced here.
    remainingSeconds: Math.max(0, Math.ceil((attempt.deadlineAt.getTime() - Date.now()) / 1000)),
    passingPercent: attempt.passingPercent,
    questions: attempt.questions.map((q) => ({
      questionId: String(q.questionId),
      text: q.text,
      topic: q.topic,
      options: q.options,
      marks: q.marks,
      selectedIndex: q.selectedIndex ?? null,
      markedForReview: q.markedForReview,
    })),
  };
}

/**
 * Starts a test, or returns the one already running for that category so a
 * refresh or a second tab resumes the same attempt (with the same deadline)
 * instead of starting another.
 */
export async function startAttempt(student: UserDoc, category: ActivityCategory) {
  await closeExpiredAttempts({ studentId: student._id, category });
  const [settings, profile, questions, existing] = await Promise.all([
    loadTestSettings(),
    StudentProfile.findOne({ userId: student._id }),
    Question.find({ category, active: true }),
    TestAttempt.find({ studentId: student._id, category }).sort({ attemptNumber: 1 }),
  ]);
  const config = settings.get(category)!;
  const access = accessFor(profile, config, questions.length);
  if (!access.allowed) throw forbidden(access.reason, 'TEST_NOT_PERMITTED');

  const open = existing.find((a) => a.status === 'in_progress');
  if (open) return runningView(open);
  if (existing.length >= config.maxAttempts) {
    throw conflict(`You have used all ${config.maxAttempts} attempt${config.maxAttempts === 1 ? '' : 's'} for this test`, 'NO_ATTEMPTS_LEFT');
  }

  return createAttempt(student, category, questions, existing.length, config.questionCount, config.durationMinutes, config.passingPercent);
}

/**
 * Loads the activity and its event, and confirms the activity is open to
 * volunteering (not cancelled, closed or already ended) — never trusting
 * anything about eligibility from the client.
 */
async function loadOpenActivity(activityId: string) {
  const activity = await Activity.findById(activityId);
  if (!activity) throw notFound('Activity not found');
  const event = await Event.findById(activity.eventId);
  if (!event) throw notFound('Activity not found');
  const blocked = activityBlocker(activity, event);
  if (blocked) throw conflict(blocked, 'ACTIVITY_NOT_OPEN');
  return { activity, event };
}

/**
 * Re-checks every mandatory rule for this activity except the mock-test
 * pass itself (that is exactly what this test unlocks) — required skills,
 * availability, schedule conflicts, daily hours, prior-experience and
 * profile completeness all still apply. Throws if anything else is unmet,
 * so a student can never reach a test for an activity they do not
 * otherwise qualify for.
 */
async function testEligibilityViolations(student: UserDoc, activity: ActivityDoc) {
  const volunteer = (await loadVolunteers({ studentIds: [student._id] })).get(student.id as string);
  if (!volunteer) return null; // not a student account
  return checkVolunteer(volunteer, activity, undefined, ['TEST_REQUIRED', 'ALREADY_ASSIGNED']);
}

async function requireTestEligible(student: UserDoc, activity: ActivityDoc) {
  const violations = await testEligibilityViolations(student, activity);
  if (violations === null) throw forbidden('Only student accounts can take mock tests');
  if (violations.length) {
    throw forbidden(`Not eligible for this activity yet: ${violations.map((v) => v.message).join('; ')}`, 'NOT_ELIGIBLE_FOR_ACTIVITY');
  }
}

async function isStillTestEligible(student: UserDoc, activity: ActivityDoc) {
  const violations = await testEligibilityViolations(student, activity);
  return violations !== null && violations.length === 0;
}

/**
 * Starts (or resumes) the mock test unlocked by a specific activity. Unlike
 * `startAttempt`, access is never based on the client's claim of eligibility
 * or on the student merely preferring the category: every mandatory rule
 * for this exact activity is re-checked against the database first, and
 * exactly `ACTIVITY_TEST_QUESTION_COUNT` questions are drawn for it.
 */
export async function startAttemptForActivity(student: UserDoc, activityId: string) {
  const { activity } = await loadOpenActivity(activityId);
  if (!activity.activityType) throw new HttpError(400, 'NO_TEST_CATEGORY', 'This activity has no test category');
  if (!activity.requireTestPass) throw new HttpError(400, 'TEST_NOT_REQUIRED', 'This activity does not require a mock test');
  await requireTestEligible(student, activity);

  const category = activity.activityType as ActivityCategory;
  await closeExpiredAttempts({ studentId: student._id, category });
  const [settings, questions, existing] = await Promise.all([
    loadTestSettings(),
    Question.find({ category, active: true }),
    TestAttempt.find({ studentId: student._id, category }).sort({ attemptNumber: 1 }),
  ]);
  const config = settings.get(category)!;
  if (!config.active) throw forbidden('This test is not open at the moment', 'TEST_NOT_PERMITTED');
  if (questions.length < ACTIVITY_TEST_QUESTION_COUNT) {
    throw conflict(`This category needs at least ${ACTIVITY_TEST_QUESTION_COUNT} active questions configured before it can be taken`, 'INSUFFICIENT_QUESTIONS');
  }

  const open = existing.find((a) => a.status === 'in_progress');
  if (open) return runningView(open);
  if (existing.length >= config.maxAttempts) {
    throw conflict(`You have used all ${config.maxAttempts} attempt${config.maxAttempts === 1 ? '' : 's'} for this test`, 'NO_ATTEMPTS_LEFT');
  }

  return createAttempt(student, category, questions, existing.length, ACTIVITY_TEST_QUESTION_COUNT, config.durationMinutes, config.passingPercent, activity._id);
}

async function createAttempt(
  student: UserDoc,
  category: ActivityCategory,
  questions: QuestionDoc[],
  attemptsSoFar: number,
  questionCount: number,
  durationMinutes: number,
  passingPercent: number,
  activityId?: Types.ObjectId,
) {
  const now = new Date();
  const picked = shuffle(questions).slice(0, questionCount);
  try {
    const attempt = await TestAttempt.create({
      studentId: student._id,
      category,
      activityId: activityId ?? null,
      attemptNumber: attemptsSoFar + 1,
      startedAt: now,
      deadlineAt: new Date(now.getTime() + durationMinutes * 60_000),
      passingPercent,
      questions: picked.map((q) => {
        // Options are shuffled per attempt; the key is stored against the shuffled order.
        const order = shuffle(q.options.map((_, i) => i));
        return {
          questionId: q._id,
          text: q.text,
          topic: q.topic,
          difficulty: q.difficulty,
          options: order.map((i) => q.options[i]),
          correctIndex: order.indexOf(q.correctIndex),
          explanation: q.explanation,
          marks: q.marks,
        };
      }),
    });
    return runningView(attempt);
  } catch (err) {
    // Two "start" requests raced; the unique indexes let only one through.
    if ((err as { code?: number }).code === 11000) {
      const winner = await TestAttempt.findOne({ studentId: student._id, category, status: 'in_progress' });
      if (winner) return runningView(winner);
      throw conflict('This test has already been started or completed', 'NO_ATTEMPTS_LEFT');
    }
    throw err;
  }
}

const answersSchema = z
  .object({
    answers: z
      .array(
        z
          .object({ questionId: z.string().regex(/^[a-f0-9]{24}$/i), selectedIndex: z.number().int().min(0).nullable(), markedForReview: z.boolean().optional() })
          .strict(),
      )
      .max(200),
  })
  .strict();

/** Copies submitted answers onto the attempt, ignoring anything that is not one of its questions. */
function applyAnswers(attempt: TestAttemptDoc, body: unknown) {
  const parsed = answersSchema.safeParse(body ?? {});
  if (!parsed.success) throw badRequest('The answers could not be read', { answers: 'Invalid answer format' });
  for (const answer of parsed.data.answers) {
    const question = attempt.questions.find((q) => String(q.questionId) === answer.questionId);
    if (!question) throw badRequest('The answers could not be read', { answers: 'An answer refers to a question that is not in this test' });
    if (answer.selectedIndex !== null && answer.selectedIndex >= question.options.length) {
      throw badRequest('The answers could not be read', { answers: 'An answer refers to an option that does not exist' });
    }
    question.selectedIndex = answer.selectedIndex;
    if (answer.markedForReview !== undefined) question.markedForReview = answer.markedForReview;
  }
}

/** Attempts are always looked up together with their owner, so another student's id is simply "not found". */
async function ownAttempt(student: UserDoc, attemptId: string) {
  await closeExpiredAttempts({ studentId: student._id });
  const attempt = await TestAttempt.findOne({ _id: attemptId, studentId: student._id });
  if (!attempt) throw notFound('Test attempt not found');
  return attempt;
}

const inTime = (attempt: TestAttemptDoc) => Date.now() <= attempt.deadlineAt.getTime() + SUBMIT_GRACE_MS;

/** Saves progress while the test is running, so an interruption does not lose answers. */
export async function saveAnswers(student: UserDoc, attemptId: string, body: unknown) {
  const attempt = await ownAttempt(student, attemptId);
  if (attempt.status !== 'in_progress' || !inTime(attempt)) throw conflict('This test is no longer open for answers', 'ATTEMPT_CLOSED');
  applyAnswers(attempt, body);
  const saved = await TestAttempt.findOneAndUpdate({ _id: attempt._id, status: 'in_progress' }, { questions: attempt.questions }, { new: true });
  if (!saved) throw conflict('This test is no longer open for answers', 'ATTEMPT_CLOSED');
  return { saved: true, remainingSeconds: runningView(saved).remainingSeconds };
}

/**
 * Submits a test. The body may carry the final answers; a score, marks or
 * pass flag in it would be rejected by the strict schema, and the result is
 * always computed here from the stored key. The conditional update means a
 * double click or a retry can complete the attempt only once.
 */
export async function submitAttempt(student: UserDoc, attemptId: string, body: unknown) {
  const attempt = await ownAttempt(student, attemptId);
  if (attempt.status !== 'in_progress') throw conflict('This test has already been submitted', 'ALREADY_SUBMITTED');
  // If eligibility for the activity that unlocked this test has changed
  // since it started (e.g. the activity was cancelled, or another
  // assignment now conflicts with it), the submission is refused. The
  // attempt stays open and is still closed safely by the deadline.
  if (attempt.activityId) {
    const activity = await Activity.findById(attempt.activityId);
    const event = activity ? await Event.findById(activity.eventId) : null;
    const stillOpen = activity && event && !activityBlocker(activity, event);
    if (!stillOpen || !(await isStillTestEligible(student, activity!))) {
      throw conflict('You are no longer eligible for the activity this test was for, so it cannot be submitted.', 'NOT_ELIGIBLE_FOR_ACTIVITY');
    }
  }
  // Answers arriving after the deadline are not counted; what was saved in time is.
  if (body && typeof body === 'object' && Object.keys(body).length) {
    if (inTime(attempt)) applyAnswers(attempt, body);
  }
  const late = !inTime(attempt);
  const updated = await TestAttempt.findOneAndUpdate(
    { _id: attempt._id, status: 'in_progress' },
    {
      status: 'submitted',
      questions: attempt.questions,
      submittedAt: late ? attempt.deadlineAt : new Date(),
      autoSubmitted: late,
      result: evaluate(attempt),
    },
    { new: true },
  );
  if (!updated) throw conflict('This test has already been submitted', 'ALREADY_SUBMITTED');
  return attemptResult(student, updated);
}

/** The results page: score, topic breakdown, review and suggestions. */
async function attemptResult(student: UserDoc, attempt: TestAttemptDoc) {
  const settings = (await loadTestSettings()).get(attempt.category as ActivityCategory)!;
  const used = await TestAttempt.countDocuments({ studentId: student._id, category: attempt.category });
  const attemptsLeft = Math.max(0, settings.maxAttempts - used);
  const revealAnswers = settings.showAnswers === 'always' || (settings.showAnswers === 'after_final_attempt' && attemptsLeft === 0);
  const result = attempt.result!;
  const topics = result.topics.map((t) => ({
    topic: t.topic!,
    totalMarks: t.totalMarks!,
    marksObtained: t.marksObtained!,
    questions: t.questions!,
    correct: t.correct!,
    percent: t.totalMarks ? Math.round((t.marksObtained! / t.totalMarks) * 100) : 0,
  }));
  const weak = topics.filter((t) => t.percent < WEAK_TOPIC_PERCENT).sort((a, b) => a.percent - b.percent);

  return {
    ...summarize(attempt),
    durationSeconds: attempt.submittedAt ? Math.max(0, Math.round((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000)) : null,
    passingPercent: attempt.passingPercent,
    attemptsLeft,
    topics,
    suggestions: weak.length
      ? weak.map((t) => `${t.topic}: you scored ${t.marksObtained} of ${t.totalMarks} marks. Review this area${revealAnswers ? ' using the explanations below' : ''} before your next activity.`)
      : ['No weak topics in this attempt. Keep your knowledge current by reviewing the activity instructions before each event.'],
    answersRevealed: revealAnswers,
    review: attempt.questions.map((q) => ({
      text: q.text,
      topic: q.topic,
      marks: q.marks,
      options: q.options,
      selectedIndex: q.selectedIndex ?? null,
      correct: q.selectedIndex !== null && q.selectedIndex !== undefined && q.selectedIndex === q.correctIndex,
      // The key and explanations are held back while a retake is still possible.
      ...(revealAnswers ? { correctIndex: q.correctIndex, explanation: q.explanation } : {}),
    })),
  };
}

export async function getAttempt(student: UserDoc, attemptId: string) {
  const attempt = await ownAttempt(student, attemptId);
  return attempt.status === 'in_progress' ? { running: runningView(attempt) } : { result: await attemptResult(student, attempt) };
}

export async function listOwnAttempts(student: UserDoc) {
  await closeExpiredAttempts({ studentId: student._id });
  const attempts = await TestAttempt.find({ studentId: student._id }).sort({ startedAt: -1 });
  return attempts.map(summarize);
}

