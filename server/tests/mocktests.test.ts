import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { Assignment, PerformanceEvaluation, Question, RatingAudit, TestAttempt, User } from '../src/models.js';
import { ensureQuestionBank } from '../src/services/questionBank.js';
import {
  activityPayload,
  addAttendance,
  createFaculty,
  createStudent,
  createVolunteer,
  eventPayload,
  loginAs,
  profilePayload,
  useTestApp,
  type VolunteerOptions,
} from './helpers.js';

const t = useTestApp('mocktests');
beforeEach(async () => {
  await ensureQuestionBank();
});

const TECH = 'Technical Support';
const HOSP = 'Hospitality';
type Agent = Awaited<ReturnType<typeof loginAs>>;

const tester = (options: VolunteerOptions = {}) => createVolunteer(t.app, { preferences: [TECH], ...options });

async function facultyAgent() {
  const faculty = await createFaculty(t.app);
  return { ...faculty, agent: await loginAs(t.app, faculty.username, 'faculty') };
}

const start = (agent: Agent, category = TECH) => agent.post('/api/student/tests/start').send({ category });

/**
 * Takes a test through the API, answering the first `correct` questions
 * correctly. The answer key is read from the database, which a real client
 * cannot do.
 */
async function takeTest(agent: Agent, category: string, correct: number | 'all') {
  const started = await start(agent, category).expect(201);
  const attempt = await TestAttempt.findById(started.body.attempt.id);
  const answers = attempt!.questions.map((q, i) => ({
    questionId: String(q.questionId),
    selectedIndex: correct === 'all' || i < correct ? q.correctIndex : (q.correctIndex + 1) % q.options.length,
  }));
  const res = await agent.post(`/api/student/attempts/${started.body.attempt.id}/submit`).send({ answers }).expect(200);
  return { attemptId: started.body.attempt.id as string, result: res.body.result, questions: attempt!.questions };
}

const board = async (agent: Agent, query: string) => (await agent.get(`/api/leaderboard?${query}`).expect(200)).body;
const CRITERIA = (n: number) => ({ taskCompletion: n, punctuality: n, communication: n, teamwork: n, responsibility: n, problemSolving: n });

describe('access to mock tests', () => {
  it('only lets a student with a complete profile take tests for their preferred activities', async () => {
    const incomplete = await createStudent(t.app);
    const incompleteAgent = await loginAs(t.app, incomplete.username, 'student');
    expect((await start(incompleteAgent).expect(403)).body.code).toBe('TEST_NOT_PERMITTED');

    const student = await tester();
    const notPreferred = await start(student.agent, HOSP).expect(403);
    expect(notPreferred.body.error).toMatch(/preferences/);
    await start(student.agent, 'Juggling').expect(400);
    await request(t.app).post('/api/student/tests/start').send({ category: TECH }).expect(401);

    const faculty = await facultyAgent();
    await start(faculty.agent).expect(403);

    const list = (await student.agent.get('/api/student/tests').expect(200)).body.tests;
    expect(list).toHaveLength(11);
    expect(list.find((x: { category: string }) => x.category === TECH)).toMatchObject({ allowed: true, canStart: true, attemptsLeft: 2, questionCount: 8, durationMinutes: 15 });
    expect(list.find((x: { category: string }) => x.category === HOSP)).toMatchObject({ allowed: false, canStart: false });

    await start(student.agent).expect(201);
    expect(await TestAttempt.countDocuments()).toBe(1);
  });

  it('gives each activity category its own questions', async () => {
    const student = await tester({ preferences: [TECH, HOSP] });
    const tech = (await start(student.agent, TECH).expect(201)).body.attempt;
    const hosp = (await start(student.agent, HOSP).expect(201)).body.attempt;
    const categoriesOf = async (attempt: { questions: { questionId: string }[] }) =>
      new Set((await Question.find({ _id: { $in: attempt.questions.map((q) => q.questionId) } })).map((q) => q.category));

    expect([...(await categoriesOf(tech))]).toEqual([TECH]);
    expect([...(await categoriesOf(hosp))]).toEqual([HOSP]);
    expect(tech.questions).toHaveLength(8);
    const techIds = new Set(tech.questions.map((q: { questionId: string }) => q.questionId));
    expect(hosp.questions.some((q: { questionId: string }) => techIds.has(q.questionId))).toBe(false);
  });

  it('respects a test that faculty have closed', async () => {
    const student = await tester();
    const faculty = await facultyAgent();
    const settings = { category: TECH, durationMinutes: 10, questionCount: 5, passingPercent: 50, maxAttempts: 1, qualifyingAttempt: 'latest', showAnswers: 'always', active: false };
    await student.agent.put('/api/faculty/test-settings').send(settings).expect(403);
    await faculty.agent.put('/api/faculty/test-settings').send({ ...settings, durationMinutes: 0 }).expect(400);
    await faculty.agent.put('/api/faculty/test-settings').send(settings).expect(200);
    await start(student.agent).expect(403);

    await faculty.agent.put('/api/faculty/test-settings').send({ ...settings, active: true }).expect(200);
    const attempt = (await start(student.agent).expect(201)).body.attempt;
    expect(attempt.questions).toHaveLength(5);
    expect(attempt.remainingSeconds).toBeGreaterThan(590);
    expect(attempt.remainingSeconds).toBeLessThanOrEqual(600);
  });
});

describe('answer key protection', () => {
  it('never sends correct answers or explanations before the test is finished', async () => {
    const student = await tester();
    const started = await start(student.agent).expect(201);
    const id = started.body.attempt.id;
    const resumed = await student.agent.get(`/api/student/attempts/${id}`).expect(200);
    const list = await student.agent.get('/api/student/tests').expect(200);
    const history = await student.agent.get('/api/student/attempts').expect(200);
    const saved = await student.agent.put(`/api/student/attempts/${id}/answers`).send({ answers: [{ questionId: started.body.attempt.questions[0].questionId, selectedIndex: 0 }] }).expect(200);

    for (const res of [started, resumed, list, history, saved]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('correctIndex');
      expect(text).not.toContain('explanation');
    }
    // The question bank itself, which holds the key, is for faculty only.
    await student.agent.get('/api/faculty/questions').expect(403);
    await request(t.app).get('/api/faculty/questions').expect(401);
  });

  it('holds the answers back while a retake is possible, then shows them', async () => {
    const student = await tester();
    const first = await takeTest(student.agent, TECH, 3);
    expect(first.result).toMatchObject({ answersRevealed: false, attemptsLeft: 1 });
    expect(JSON.stringify(first.result)).not.toContain('correctIndex');
    expect(first.result.review[0]).toHaveProperty('correct');

    const second = await takeTest(student.agent, TECH, 5);
    expect(second.result).toMatchObject({ answersRevealed: true, attemptsLeft: 0 });
    expect(second.result.review[0]).toHaveProperty('correctIndex');
    expect(second.result.review[0]).toHaveProperty('explanation');
    // Once revealed for the final attempt, the earlier one can be reviewed too.
    const earlier = await student.agent.get(`/api/student/attempts/${first.attemptId}`).expect(200);
    expect(earlier.body.result.answersRevealed).toBe(true);
  });
});

describe('evaluation on the server', () => {
  it('calculates marks, percentage, counts and topic performance from the stored key', async () => {
    const student = await tester();
    const started = (await start(student.agent).expect(201)).body.attempt;
    const attempt = (await TestAttempt.findById(started.id))!;
    // Two right, one wrong, the rest unanswered.
    const answers = [
      { questionId: String(attempt.questions[0].questionId), selectedIndex: attempt.questions[0].correctIndex },
      { questionId: String(attempt.questions[1].questionId), selectedIndex: attempt.questions[1].correctIndex },
      { questionId: String(attempt.questions[2].questionId), selectedIndex: (attempt.questions[2].correctIndex + 1) % 4 },
    ];
    const res = await student.agent.post(`/api/student/attempts/${started.id}/submit`).send({ answers }).expect(200);

    const total = attempt.questions.reduce((sum, q) => sum + q.marks, 0);
    const obtained = attempt.questions[0].marks + attempt.questions[1].marks;
    const percent = Math.round((obtained / total) * 1000) / 10;
    expect(res.body.result.result).toEqual({ totalMarks: total, marksObtained: obtained, percent, correct: 2, incorrect: 1, unanswered: 5, passed: percent >= 60 });
    expect(res.body.result.topics.reduce((sum: number, x: { totalMarks: number }) => sum + x.totalMarks, 0)).toBe(total);
    expect(res.body.result.topics.reduce((sum: number, x: { marksObtained: number }) => sum + x.marksObtained, 0)).toBe(obtained);
    expect(res.body.result.suggestions.length).toBeGreaterThan(0);
    expect(res.body.result.durationSeconds).toBeGreaterThanOrEqual(0);

    const stored = await TestAttempt.findById(started.id);
    expect(stored).toMatchObject({ status: 'submitted', autoSubmitted: false });
    expect(stored?.result).toMatchObject({ marksObtained: obtained, percent });
  });

  it('awards full marks and a pass only for correct answers', async () => {
    const student = await tester();
    const perfect = await takeTest(student.agent, TECH, 'all');
    expect(perfect.result.result).toMatchObject({ percent: 100, incorrect: 0, unanswered: 0, passed: true });
    const other = await tester();
    const none = await takeTest(other.agent, TECH, 0);
    expect(none.result.result).toMatchObject({ percent: 0, correct: 0, passed: false });
  });

  it('rejects a client-supplied score and other invalid submissions', async () => {
    const student = await tester();
    const started = (await start(student.agent).expect(201)).body.attempt;
    const url = `/api/student/attempts/${started.id}`;
    const q = started.questions[0];

    await student.agent.post(`${url}/submit`).send({ answers: [], score: 100 }).expect(400);
    await student.agent.post(`${url}/submit`).send({ answers: [], result: { percent: 100, passed: true } }).expect(400);
    await student.agent.post(`${url}/submit`).send({ answers: [{ questionId: q.questionId, selectedIndex: 99 }] }).expect(400);
    await student.agent.post(`${url}/submit`).send({ answers: [{ questionId: '64b7f0f0f0f0f0f0f0f0f0f0', selectedIndex: 0 }] }).expect(400);
    await student.agent.post(`${url}/submit`).send({ answers: [{ questionId: q.questionId, selectedIndex: 0, correct: true }] }).expect(400);
    await student.agent.put(`${url}/answers`).send({ answers: 'all correct' }).expect(400);
    expect((await TestAttempt.findById(started.id))?.status).toBe('in_progress');

    // Another student cannot see, answer or submit this attempt.
    const other = await tester();
    await other.agent.get(url).expect(404);
    await other.agent.put(`${url}/answers`).send({ answers: [] }).expect(404);
    await other.agent.post(`${url}/submit`).send({}).expect(404);
    expect((await TestAttempt.findById(started.id))?.status).toBe('in_progress');
  });

  it('accepts one submission only, even when sent twice at once', async () => {
    const student = await tester();
    const started = (await start(student.agent).expect(201)).body.attempt;
    const url = `/api/student/attempts/${started.id}/submit`;
    const results = await Promise.all([student.agent.post(url).send({}), student.agent.post(url).send({}), student.agent.post(url).send({})]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);

    const before = (await TestAttempt.findById(started.id))!.toObject();
    const again = await student.agent.post(url).send({ answers: started.questions.map((q: { questionId: string }) => ({ questionId: q.questionId, selectedIndex: 0 })) }).expect(409);
    expect(again.body.code).toBe('ALREADY_SUBMITTED');
    await student.agent.put(`/api/student/attempts/${started.id}/answers`).send({ answers: [] }).expect(409);
    // A completed attempt can no longer be changed.
    expect((await TestAttempt.findById(started.id))!.toObject().result).toEqual(before.result);
    expect(await TestAttempt.countDocuments()).toBe(1);
  });
});

describe('timing and attempt policy', () => {
  it('enforces the deadline on the server and keeps only answers saved in time', async () => {
    const student = await tester();
    const started = (await start(student.agent).expect(201)).body.attempt;
    const attempt = (await TestAttempt.findById(started.id))!;
    const allCorrect = attempt.questions.map((q) => ({ questionId: String(q.questionId), selectedIndex: q.correctIndex }));
    // One answer saved while the test was open.
    await student.agent.put(`/api/student/attempts/${started.id}/answers`).send({ answers: [allCorrect[0]] }).expect(200);

    // Time runs out (the browser clock is irrelevant: the deadline lives in the database).
    await TestAttempt.updateOne({ _id: started.id }, { deadlineAt: new Date(Date.now() - 60_000) });
    await student.agent.put(`/api/student/attempts/${started.id}/answers`).send({ answers: allCorrect }).expect(409);
    const late = await student.agent.post(`/api/student/attempts/${started.id}/submit`).send({ answers: allCorrect });
    expect(late.status).toBe(409);

    const closed = (await TestAttempt.findById(started.id))!;
    expect(closed).toMatchObject({ status: 'submitted', autoSubmitted: true });
    expect(closed.result).toMatchObject({ correct: 1, unanswered: attempt.questions.length - 1 });
    const view = await student.agent.get(`/api/student/attempts/${started.id}`).expect(200);
    expect(view.body.result.autoSubmitted).toBe(true);
  });

  it('resumes an interrupted test instead of starting another', async () => {
    const student = await tester();
    const first = (await start(student.agent).expect(201)).body.attempt;
    await student.agent.put(`/api/student/attempts/${first.id}/answers`).send({ answers: [{ questionId: first.questions[2].questionId, selectedIndex: 1, markedForReview: true }] }).expect(200);

    const again = (await start(student.agent).expect(201)).body.attempt;
    expect(again.id).toBe(first.id);
    expect(again.deadlineAt).toBe(first.deadlineAt);
    expect(again.questions[2]).toMatchObject({ selectedIndex: 1, markedForReview: true });
    expect((await student.agent.get('/api/student/tests')).body.tests.find((x: { category: string }) => x.category === TECH)).toMatchObject({ inProgressAttemptId: first.id, canStart: false });
    expect(await TestAttempt.countDocuments()).toBe(1);
  });

  it('enforces the attempt limit, including under simultaneous starts', async () => {
    const student = await tester();
    const simultaneous = await Promise.all([start(student.agent), start(student.agent), start(student.agent)]);
    expect(new Set(simultaneous.map((r) => r.body.attempt?.id)).size).toBe(1);
    expect(await TestAttempt.countDocuments()).toBe(1);

    await student.agent.post(`/api/student/attempts/${simultaneous[0].body.attempt.id}/submit`).send({}).expect(200);
    await takeTest(student.agent, TECH, 2);
    const third = await start(student.agent).expect(409);
    expect(third.body.code).toBe('NO_ATTEMPTS_LEFT');
    expect(await TestAttempt.countDocuments()).toBe(2);
  });

  it('counts the best or the latest attempt, as configured', async () => {
    const student = await tester();
    const faculty = await facultyAgent();
    await takeTest(student.agent, TECH, 'all');
    await takeTest(student.agent, TECH, 0);

    let entry = (await board(faculty.agent, `category=${TECH}`)).entries;
    expect(entry).toHaveLength(1);
    expect(entry[0].testPercent).toBe(100);

    await faculty.agent
      .put('/api/faculty/test-settings')
      .send({ category: TECH, durationMinutes: 15, questionCount: 8, passingPercent: 60, maxAttempts: 2, qualifyingAttempt: 'latest', showAnswers: 'never', active: true })
      .expect(200);
    entry = (await board(faculty.agent, `category=${TECH}`)).entries;
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ testPercent: 0, eligibility: 'Below pass mark' });
  });
});

describe('live ranking', () => {
  it('ranks each category separately and updates when results change', async () => {
    const strong = await tester();
    const weak = await tester();
    const host = await tester({ preferences: [HOSP], skills: ['Hospitality'] });
    await takeTest(weak.agent, TECH, 4);
    let tech = await board(weak.agent, `category=${TECH}`);
    expect(tech.entries).toHaveLength(1);
    expect(tech.myRank).toBe(1);

    await takeTest(strong.agent, TECH, 'all');
    await takeTest(host.agent, HOSP, 5);
    tech = await board(weak.agent, `category=${TECH}`);
    expect(tech.entries.map((e: { rank: number; isMe: boolean }) => [e.rank, e.isMe])).toEqual([[1, false], [2, true]]);
    expect(tech.entries.every((e: { category: string }) => e.category === TECH)).toBe(true);
    expect(tech.entries[0].overall).toBeGreaterThan(tech.entries[1].overall);

    const hosp = await board(host.agent, `category=${HOSP}`);
    expect(hosp.entries).toHaveLength(1);
    expect(hosp.entries[0]).toMatchObject({ category: HOSP, isMe: true, rank: 1 });

    // A better retake replaces the earlier result: one entry per student, new order.
    await takeTest(weak.agent, TECH, 'all');
    tech = await board(weak.agent, `category=${TECH}`);
    expect(tech.entries).toHaveLength(2);
    expect(tech.entries.map((e: { testPercent: number }) => e.testPercent)).toEqual([100, 100]);
    // Equal scores: the earlier submission ranks first.
    expect(tech.entries[0].isMe).toBe(false);
  });

  it('reacts to skill changes and to performance ratings', async () => {
    const a = await tester({ skills: ['Communication'] });
    const b = await tester({ skills: ['Communication'] });
    const faculty = await facultyAgent();
    await takeTest(a.agent, TECH, 'all');
    await takeTest(b.agent, TECH, 'all');
    const rankOf = async (who: typeof a) => (await board(who.agent, `category=${TECH}`)).myRank;
    expect(await rankOf(a)).toBe(1); // tie broken by earlier submission

    await b.agent.put('/api/volunteer-profile').send({ skills: ['Technical Support', 'Networking'] }).expect(200);
    let rows = (await board(faculty.agent, `category=${TECH}`)).entries;
    expect(rows[0]).toMatchObject({ studentId: b.id, skillMatch: 50 });
    expect(rows[1]).toMatchObject({ studentId: a.id, skillMatch: 0 });

    // A strong evaluation for A, then a correction downwards.
    const past = await addAttendance(a.id, 'attended');
    await a.agent.put('/api/volunteer-profile').send({ skills: ['Technical Support', 'Networking'] }).expect(200);
    const created = await faculty.agent.post(`/api/manage/assignments/${past.id}/evaluation`).send({ criteria: CRITERIA(5) }).expect(201);
    rows = (await board(faculty.agent, `category=${TECH}`)).entries;
    expect(rows[0]).toMatchObject({ studentId: a.id, historyCount: 1 });
    expect(rows[0].history.score).toBeGreaterThan(70);

    await faculty.agent.put(`/api/manage/evaluations/${created.body.evaluation.id}`).send({ criteria: CRITERIA(1), reason: 'Entered against the wrong student' }).expect(200);
    rows = (await board(faculty.agent, `category=${TECH}`)).entries;
    expect(rows[0].studentId).toBe(b.id);
    expect(rows[1].history.score).toBeLessThan(70);
  });

  it('does not disadvantage a volunteer for having no history', async () => {
    const newcomer = await tester();
    const average = await tester();
    const star = await tester();
    const faculty = await facultyAgent();
    for (const v of [newcomer, average, star]) await takeTest(v.agent, TECH, 'all');
    await addAttendance(average.id, 'attended', 3);
    await addAttendance(star.id, 'attended', 5);
    await addAttendance(star.id, 'attended', 5);

    const rows = (await board(faculty.agent, `category=${TECH}`)).entries as { studentId: string; history: { label: string; score: number; provisional: boolean }; rank: number }[];
    const of = (id: string) => rows.find((r) => r.studentId === id)!;
    expect(of(newcomer.id).history).toEqual({ label: 'No history yet', score: 70, provisional: true });
    // Neutral baseline: above a mediocre record, below an excellent one, never zero.
    expect(of(newcomer.id).rank).toBeLessThan(of(average.id).rank);
    expect(of(star.id).rank).toBe(1);
    expect(of(star.id).history.provisional).toBe(true); // only two evaluations so far
    expect(of(average.id).history.score).toBeCloseTo((50 + 2 * 70) / 3, 1);
  });

  it('keeps private details off the student leaderboard and filters correctly', async () => {
    const a = await tester();
    const b = await tester();
    const faculty = await facultyAgent();
    await takeTest(a.agent, TECH, 'all');
    await takeTest(b.agent, TECH, 1);

    const forStudent = await a.agent.get(`/api/leaderboard?category=${TECH}`).expect(200);
    const text = JSON.stringify(forStudent.body);
    for (const secret of ['@example.com', '9876543210', b.usn, b.id, 'studentId', 'reasons']) expect(text).not.toContain(secret);
    expect(forStudent.body.entries[0]).toMatchObject({ rank: 1, isMe: true, eligibility: 'Qualified' });
    expect(Object.keys(forStudent.body.entries[1]).sort()).toEqual(['category', 'displayName', 'eligibility', 'eligible', 'history', 'isMe', 'overall', 'rank', 'skillMatch', 'testPercent']);

    expect((await board(faculty.agent, `category=${TECH}&eligible=true`)).entries).toHaveLength(1);
    const low = (await board(faculty.agent, `category=${TECH}&maxScore=40`)).entries;
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ rank: 2, studentId: b.id }); // rank stays the position in the full ranking
    await request(t.app).get(`/api/leaderboard?category=${TECH}`).expect(401);
    await a.agent.get('/api/leaderboard').expect(422);
  });
});

describe('allocation uses test results without overriding hard rules', () => {
  async function scenario(activity: Record<string, unknown>) {
    const faculty = await facultyAgent();
    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const created = (await faculty.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload({ activityType: TECH, ...activity })).expect(201)).body.activity;
    const allocate = () => faculty.agent.post(`/api/manage/events/${event.id}/allocate`).send({}).expect(200);
    return { faculty, event, activity: created, allocate };
  }

  it('prefers the volunteer with the better relevant test score', async () => {
    const tested = await tester();
    const untested = await tester();
    const wrongCategory = await tester({ preferences: [TECH, HOSP] });
    await takeTest(tested.agent, TECH, 'all');
    await takeTest(wrongCategory.agent, HOSP, 'all'); // a Hospitality score must not count for Technical Support
    const s = await scenario({ requiredCount: 1 });

    const report = (await s.allocate()).body.report;
    expect(report.activities[0].newlyAssigned.map((n: { studentId: string }) => n.studentId)).toEqual([tested.id]);
    expect(report.activities[0].newlyAssigned[0].explanation.join(' ')).toMatch(/Mock test 100%/);

    const candidates = (await s.faculty.agent.get(`/api/manage/activities/${s.activity.id}/candidates`).expect(200)).body.eligible;
    expect(candidates.map((c: { id: string }) => c.id).sort()).toEqual([untested.id, wrongCategory.id].sort());
    expect(candidates.every((c: { explanation: string[] }) => c.explanation.join(' ').includes('No Technical Support mock test taken'))).toBe(true);

    // The activity ranking for organizers shows only people with a result in this category.
    const ranking = await board(s.faculty.agent, `activityId=${s.activity.id}`);
    expect(ranking.entries.map((e: { studentId: string }) => e.studentId)).toEqual([tested.id]);
    await tested.agent.get(`/api/leaderboard?activityId=${s.activity.id}`).expect(403);
  });

  it('never lets a high score override availability or required skills', async () => {
    const brilliantButUnskilled = await tester({ skills: ['Photography'] });
    const brilliantButBusy = await tester({ availability: [{ date: activityPayload().date, startTime: '15:00', endTime: '18:00' }] });
    const plain = await tester();
    await takeTest(brilliantButUnskilled.agent, TECH, 'all');
    await takeTest(brilliantButBusy.agent, TECH, 'all');
    const s = await scenario({ requiredCount: 3 });

    const report = (await s.allocate()).body.report;
    expect(report.activities[0].newlyAssigned.map((n: { studentId: string }) => n.studentId)).toEqual([plain.id]);
    expect(report.activities[0]).toMatchObject({ vacancies: 2, status: 'shortage' });
    expect(await Assignment.countDocuments()).toBe(1);

    const ranking = await board(s.faculty.agent, `activityId=${s.activity.id}`);
    expect(ranking.entries.map((e: { eligibility: string }) => e.eligibility)).toEqual(['Not eligible', 'Not eligible']);
    expect(ranking.entries[0].reasons.length).toBeGreaterThan(0);
  });

  it('can require a passed mock test, and reports a shortage when nobody qualifies', async () => {
    const passed = await tester();
    const failed = await tester();
    const untested = await tester();
    await takeTest(passed.agent, TECH, 'all');
    await takeTest(failed.agent, TECH, 1);

    const faculty = await facultyAgent();
    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const url = `/api/manage/events/${event.id}/activities`;
    const noType = await faculty.agent.post(url).send(activityPayload({ requireTestPass: true })).expect(400);
    expect(noType.body.details).toHaveProperty('requireTestPass');
    const activity = (await faculty.agent.post(url).send(activityPayload({ activityType: TECH, requireTestPass: true, requiredCount: 3 })).expect(201)).body.activity;

    const report = (await faculty.agent.post(`/api/manage/events/${event.id}/allocate`).send({}).expect(200)).body.report;
    expect(report.activities[0].newlyAssigned.map((n: { studentId: string }) => n.studentId)).toEqual([passed.id]);
    expect(report.activities[0]).toMatchObject({ vacancies: 2, status: 'shortage' });
    expect(report.activities[0].shortageReason).toMatch(/2 have not passed the required mock test/);

    for (const v of [failed, untested]) {
      const manual = await faculty.agent.post(`/api/manage/activities/${activity.id}/assignments`).send({ studentId: v.id }).expect(422);
      expect(manual.body.details.violations[0].code).toBe('TEST_REQUIRED');
    }
    expect(await Assignment.countDocuments()).toBe(1);
  });
});

describe('activity-gated mock test access', () => {
  async function activityRequiringTest(overrides: Record<string, unknown> = {}) {
    const faculty = await facultyAgent();
    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const activity = (
      await faculty.agent
        .post(`/api/manage/events/${event.id}/activities`)
        .send(activityPayload({ activityType: TECH, requireTestPass: true, requiredSkills: ['Communication'], ...overrides }))
        .expect(201)
    ).body.activity;
    return { faculty, event, activity };
  }

  it('never unlocks the test for a student who is not otherwise eligible for the activity', async () => {
    const { activity } = await activityRequiringTest({ requiredSkills: ['Programming'] });
    const student = await tester(); // only has 'Communication', not the required 'Programming'

    const res = await student.agent.post(`/api/student/activities/${activity.id}/tests/start`).expect(403);
    expect(res.body.code).toBe('NOT_ELIGIBLE_FOR_ACTIVITY');
    expect(res.body.error).toMatch(/Programming/);
    expect(await TestAttempt.countDocuments({ studentId: student.id })).toBe(0);
  });

  it('unlocks exactly 10 questions tied to the activity for a student who is otherwise eligible', async () => {
    const { activity } = await activityRequiringTest();
    const student = await tester();

    const res = await student.agent.post(`/api/student/activities/${activity.id}/tests/start`).expect(201);
    expect(res.body.attempt.category).toBe(TECH);
    expect(res.body.attempt.questions).toHaveLength(10);

    const attempt = await TestAttempt.findById(res.body.attempt.id);
    expect(String(attempt!.activityId)).toBe(activity.id);
  });

  it('refuses to start a test for an activity with no category attached', async () => {
    const faculty = await facultyAgent();
    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const activity = (await faculty.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload()).expect(201)).body.activity;
    const student = await tester();

    const res = await student.agent.post(`/api/student/activities/${activity.id}/tests/start`).expect(400);
    expect(res.body.code).toBe('NO_TEST_CATEGORY');
  });

  it('refuses to start a test for an activity that has a category but does not require passing it', async () => {
    const faculty = await facultyAgent();
    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const activity = (
      await faculty.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload({ activityType: TECH, requireTestPass: false })).expect(201)
    ).body.activity;
    const student = await tester();

    const res = await student.agent.post(`/api/student/activities/${activity.id}/tests/start`).expect(400);
    expect(res.body.code).toBe('TEST_NOT_REQUIRED');
  });

  it('lists the activity as test-locked while ineligible, then available once the blocking requirement is met', async () => {
    const { activity } = await activityRequiringTest({ requiredSkills: ['Programming'] });
    const student = await tester();

    const before = (await student.agent.get('/api/student/activities').expect(200)).body.activities;
    const lockedCard = before.find((a: { id: string }) => a.id === activity.id);
    expect(lockedCard.testStatus).toBe('locked');
    expect(lockedCard.testLockedReasons.join(' ')).toMatch(/Programming/);

    await student.agent.put('/api/volunteer-profile').send(profilePayload({ skills: ['Communication', 'Programming'], preferences: [TECH] })).expect(200);

    const after = (await student.agent.get('/api/student/activities').expect(200)).body.activities;
    const unlockedCard = after.find((a: { id: string }) => a.id === activity.id);
    expect(unlockedCard.testStatus).toBe('available');
  });

  it('marks the activity as eligible once the unlocked test is passed', async () => {
    const { activity } = await activityRequiringTest();
    const student = await tester();
    const started = await student.agent.post(`/api/student/activities/${activity.id}/tests/start`).expect(201);
    const attempt = await TestAttempt.findById(started.body.attempt.id);
    const answers = attempt!.questions.map((q) => ({ questionId: String(q.questionId), selectedIndex: q.correctIndex }));
    await student.agent.post(`/api/student/attempts/${started.body.attempt.id}/submit`).send({ answers }).expect(200);

    const list = (await student.agent.get('/api/student/activities').expect(200)).body.activities;
    const card = list.find((a: { id: string }) => a.id === activity.id);
    expect(card.testStatus).toBe('passed');
    expect(card.eligible).toBe(true);
  });

  it('blocks submitting the test once the student is no longer eligible for the activity that unlocked it', async () => {
    const { faculty, activity } = await activityRequiringTest();
    const student = await tester();
    const started = await student.agent.post(`/api/student/activities/${activity.id}/tests/start`).expect(201);

    await faculty.agent.delete(`/api/manage/activities/${activity.id}`).expect(200);

    const attempt = await TestAttempt.findById(started.body.attempt.id);
    const answers = attempt!.questions.map((q) => ({ questionId: String(q.questionId), selectedIndex: q.correctIndex }));
    const res = await student.agent.post(`/api/student/attempts/${started.body.attempt.id}/submit`).send({ answers }).expect(409);
    expect(res.body.code).toBe('NOT_ELIGIBLE_FOR_ACTIVITY');
    expect((await TestAttempt.findById(started.body.attempt.id))!.status).toBe('in_progress');
  });

  it('returns 404 for an activity that does not exist and 409 for one that is closed', async () => {
    const { faculty, activity } = await activityRequiringTest();
    const student = await tester();

    const missing = await student.agent.post('/api/student/activities/000000000000000000000000/tests/start').expect(404);
    expect(missing.body.code).toBe('NOT_FOUND');

    await faculty.agent
      .put(`/api/manage/activities/${activity.id}`)
      .send(activityPayload({ activityType: TECH, requireTestPass: true, requiredSkills: ['Communication'], status: 'closed' }))
      .expect(200);
    const closed = await student.agent.post(`/api/student/activities/${activity.id}/tests/start`).expect(409);
    expect(closed.body.code).toBe('ACTIVITY_NOT_OPEN');
  });
});

describe('post-event performance evaluations', () => {
  async function finished() {
    const faculty = await facultyAgent();
    const volunteer = await tester();
    const assignment = await addAttendance(volunteer.id, 'attended');
    const url = `/api/manage/assignments/${assignment.id}/evaluation`;
    return { faculty, volunteer, assignment, url };
  }

  it('lets an authorized reviewer rate an assigned volunteer and computes the overall rating', async () => {
    const { faculty, volunteer, assignment, url } = await finished();
    const criteria = { taskCompletion: 5, punctuality: 4, communication: 4, teamwork: 5, responsibility: 3, problemSolving: 3 };

    await faculty.agent.post(url).send({ criteria: { ...criteria, teamwork: 6 } }).expect(400);
    await faculty.agent.post(url).send({ criteria: { taskCompletion: 5 } }).expect(400);
    await faculty.agent.post(url).send({ criteria, overall: 5 }).expect(400); // the overall rating cannot be supplied
    await faculty.agent.post(url).send({ criteria, studentId: faculty.id }).expect(400);

    const res = await faculty.agent.post(url).send({ criteria, feedback: 'Handled the desk well.' }).expect(201);
    expect(res.body.evaluation.overall).toBe(4);
    const stored = await PerformanceEvaluation.findOne({ assignmentId: assignment.id });
    expect(stored).toMatchObject({ overall: 4, status: 'submitted', feedback: 'Handled the desk well.' });
    expect(String(stored?.reviewerId)).toBe(faculty.id);
    expect(String(stored?.studentId)).toBe(volunteer.id);
    expect(stored?.createdAt).toBeInstanceOf(Date);
    expect(await RatingAudit.countDocuments({ evaluationId: stored!._id, action: 'created' })).toBe(1);

    // No second evaluation by the same reviewer for the same assignment.
    const dup = await faculty.agent.post(url).send({ criteria }).expect(409);
    expect(dup.body.code).toBe('ALREADY_EVALUATED');
    expect(await PerformanceEvaluation.countDocuments()).toBe(1);

    const awaiting = (await faculty.agent.get('/api/manage/evaluations/awaiting').expect(200)).body.awaiting;
    expect(awaiting).toEqual([]);
    expect((await faculty.agent.get('/api/manage/evaluations').expect(200)).body.evaluations[0]).toMatchObject({ overall: 4, student: { id: volunteer.id } });
  });

  it('refuses ratings from anyone who is not an authorized reviewer of that event', async () => {
    const { volunteer, assignment, url } = await finished();
    const body = { criteria: CRITERIA(5) };
    await request(t.app).post(url).send(body).expect(401);
    await volunteer.agent.post(url).send(body).expect(403); // a student rating themselves

    const other = await tester();
    await other.agent.post(url).send(body).expect(403);
    await User.updateOne({ _id: other.id }, { role: 'organizer' });
    const organizer = await loginAs(t.app, other.username, 'organizer');
    await organizer.post(url).send(body).expect(403); // an organizer who does not manage this event

    // An organizer cannot rate their own earlier volunteering in an event they now run.
    const own = (await organizer.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    await Assignment.updateOne({ _id: assignment.id }, { studentId: other.id, eventId: own.id });
    const { Activity } = await import('../src/models.js');
    await Activity.updateOne({ _id: assignment.activityId }, { eventId: own.id });
    const self = await organizer.post(url).send(body).expect(403);
    expect(self.body.error).toMatch(/own performance/);
    expect(await PerformanceEvaluation.countDocuments()).toBe(0);
  });

  it('only accepts ratings for volunteers who actually served on a finished activity', async () => {
    const faculty = await facultyAgent();
    const volunteer = await tester();
    const absent = await addAttendance(volunteer.id, 'absent');
    expect((await faculty.agent.post(`/api/manage/assignments/${absent.id}/evaluation`).send({ criteria: CRITERIA(4) }).expect(422)).body.code).toBe('VOLUNTEER_ABSENT');

    const rejected = await addAttendance(volunteer.id, 'attended');
    await Assignment.updateOne({ _id: rejected.id }, { status: 'cancelled' });
    await faculty.agent.post(`/api/manage/assignments/${rejected.id}/evaluation`).send({ criteria: CRITERIA(4) }).expect(409);

    // An upcoming, confirmed assignment cannot be rated yet.
    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const activity = (await faculty.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload()).expect(201)).body.activity;
    const upcoming = (await faculty.agent.post(`/api/manage/activities/${activity.id}/assignments`).send({ studentId: volunteer.id }).expect(201)).body.assignment;
    await faculty.agent.post(`/api/manage/assignments/${upcoming.id}/confirm`).expect(200);
    await faculty.agent.post(`/api/manage/assignments/${upcoming.id}/evaluation`).send({ criteria: CRITERIA(4) }).expect(409);
    await faculty.agent.post('/api/manage/assignments/64b7f0f0f0f0f0f0f0f0f0f0/evaluation').send({ criteria: CRITERIA(4) }).expect(404);
    expect(await PerformanceEvaluation.countDocuments()).toBe(0);
  });

  it('shows students their own feedback and never lets them change it', async () => {
    const { faculty, volunteer, url } = await finished();
    const created = await faculty.agent.post(url).send({ criteria: CRITERIA(4), feedback: 'Reliable and calm.' }).expect(201);
    const id = created.body.evaluation.id;

    const mine = (await volunteer.agent.get('/api/student/evaluations').expect(200)).body;
    expect(mine).toMatchObject({ count: 1, average: 4 });
    expect(mine.evaluations[0]).toMatchObject({ overall: 4, feedback: 'Reliable and calm.', reviewer: { role: 'faculty' } });
    expect(mine.evaluations[0].criteria.teamwork).toBe(4);

    const other = await tester();
    expect((await other.agent.get('/api/student/evaluations')).body).toMatchObject({ count: 0, evaluations: [], average: null });
    for (const agent of [volunteer.agent, other.agent]) {
      await agent.put(`/api/manage/evaluations/${id}`).send({ criteria: CRITERIA(5), reason: 'I deserve better' }).expect(403);
      await agent.get('/api/manage/evaluations').expect(403);
      await agent.get(`/api/manage/evaluations/${id}/audit`).expect(403);
    }
    expect((await PerformanceEvaluation.findById(id))?.overall).toBe(4);
    expect((await volunteer.agent.get('/api/notifications')).body.notifications[0].type).toBe('performance_evaluated');
  });

  it('corrects a rating only with a reason, and keeps an audit trail', async () => {
    const { faculty, url } = await finished();
    const id = (await faculty.agent.post(url).send({ criteria: CRITERIA(2), feedback: 'Late.' }).expect(201)).body.evaluation.id;

    await faculty.agent.put(`/api/manage/evaluations/${id}`).send({ criteria: CRITERIA(4) }).expect(400);
    await faculty.agent.put(`/api/manage/evaluations/${id}`).send({ criteria: CRITERIA(4), reason: 'x' }).expect(400);
    // Another faculty member may correct an inaccurate rating.
    const second = await facultyAgent();
    const corrected = await second.agent.put(`/api/manage/evaluations/${id}`).send({ criteria: CRITERIA(4), feedback: 'On time after all.', reason: 'Attendance sheet was misread' }).expect(200);
    expect(corrected.body.evaluation).toMatchObject({ overall: 4, status: 'corrected' });

    const audit = (await faculty.agent.get(`/api/manage/evaluations/${id}/audit`).expect(200)).body.audit;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['created', 'corrected']);
    expect(audit[1]).toMatchObject({ reason: 'Attendance sheet was misread', before: { overall: 2, feedback: 'Late.' }, after: { overall: 4, feedback: 'On time after all.' } });
    expect(audit[1].actor).not.toBe(audit[0].actor);
  });

  it('feeds evaluations into the promotion review and the faculty performance dashboard', async () => {
    const { faculty, volunteer, url } = await finished();
    await takeTest(volunteer.agent, TECH, 'all');
    await faculty.agent.post(url).send({ criteria: CRITERIA(5), feedback: 'Excellent' }).expect(201);

    const created = await volunteer.agent.post('/api/promotion-requests').send({}).expect(201);
    const detail = (await faculty.agent.get(`/api/faculty/promotion-requests/${created.body.request.id}`).expect(200)).body.request;
    expect(detail.evidence.summary).toMatchObject({ recordedEvents: 1, attendedEvents: 1, feedbackCount: 1, averageRating: 5 });
    expect(detail.evidence.records[0].feedback).toMatchObject({ rating: 5, comments: 'Excellent' });

    const untested = await tester();
    const summary = (await faculty.agent.get('/api/faculty/performance').expect(200)).body;
    expect(summary.participation).toMatchObject({ students: 2, studentsTested: 1, attempts: 1, completedEvaluations: 1, awaitingEvaluation: 0 });
    expect(summary.byCategory.find((c: { category: string }) => c.category === TECH)).toMatchObject({ participants: 1, averagePercent: 100, passRate: 100 });
    expect(summary.byCategory.find((c: { category: string }) => c.category === HOSP)).toMatchObject({ participants: 0, averagePercent: null });
    const row = (id: string) => summary.students.find((s: { id: string }) => s.id === id);
    expect(row(volunteer.id)).toMatchObject({ testsTaken: 1, attendedCount: 1, promotion: { mayBeReady: true, openRequest: true } });
    expect(row(untested.id)).toMatchObject({ testsTaken: 0, promotion: { mayBeReady: false } });
    // The hint changes nothing by itself: the student is still a student.
    expect((await User.findById(volunteer.id))?.role).toBe('student');
    await volunteer.agent.get('/api/faculty/performance').expect(403);
  });
});

describe('question management', () => {
  const question = (overrides: Record<string, unknown> = {}) => ({
    category: TECH,
    text: 'Which cable carries both video and audio to a modern projector?',
    topic: 'Equipment',
    difficulty: 'easy',
    options: ['HDMI', 'RJ11', 'PS/2', 'Coaxial power'],
    correctIndex: 0,
    explanation: 'HDMI carries digital video and audio.',
    marks: 2,
    active: true,
    ...overrides,
  });

  it('is restricted to faculty and validates questions', async () => {
    const faculty = await facultyAgent();
    const student = await tester();
    await student.agent.post('/api/faculty/questions').send(question()).expect(403);
    await User.updateOne({ _id: student.id }, { role: 'organizer' });
    await (await loginAs(t.app, student.username, 'organizer')).get('/api/faculty/questions').expect(403);

    for (const [bad, field] of [
      [{ correctIndex: 7 }, 'correctIndex'],
      [{ options: ['Only one'] }, 'options'],
      [{ options: ['Same', 'same', 'Other'] }, 'options'],
      [{ category: 'Juggling' }, 'category'],
      [{ text: 'Short?' }, 'text'],
      [{ marks: 0 }, 'marks'],
    ] as const) {
      expect((await faculty.agent.post('/api/faculty/questions').send(question(bad)).expect(400)).body.details).toHaveProperty(field);
    }

    const all = (await faculty.agent.get('/api/faculty/questions').expect(200)).body.questions;
    expect(all).toHaveLength(110);
    expect(all[0]).toHaveProperty('correctIndex');
    expect((await faculty.agent.get(`/api/faculty/questions?category=${HOSP}`)).body.questions).toHaveLength(10);
  });

  it('uses added questions and leaves out deactivated ones', async () => {
    const faculty = await facultyAgent();
    const student = await tester();
    const created = (await faculty.agent.post('/api/faculty/questions').send(question()).expect(201)).body.question;
    const edited = (await faculty.agent.put(`/api/faculty/questions/${created.id}`).send(question({ marks: 3, topic: 'Cables' })).expect(200)).body.question;
    expect(edited).toMatchObject({ marks: 3, topic: 'Cables', builtIn: false });

    // Deactivate every built-in Technical Support question: only the new one remains.
    const builtIn = (await faculty.agent.get(`/api/faculty/questions?category=${TECH}`)).body.questions.filter((q: { builtIn: boolean }) => q.builtIn);
    for (const q of builtIn) await faculty.agent.post(`/api/faculty/questions/${q.id}/active`).send({ active: false }).expect(200);

    const attempt = (await start(student.agent).expect(201)).body.attempt;
    expect(attempt.questions).toHaveLength(1);
    expect(attempt.questions[0]).toMatchObject({ questionId: created.id, marks: 3, topic: 'Cables' });
    // Loading the built-in bank again neither duplicates nor reactivates anything.
    expect(await ensureQuestionBank()).toBe(0);
    expect(await Question.countDocuments({ category: TECH, active: true })).toBe(1);

    // Editing a question later does not change an attempt already in progress.
    await faculty.agent.put(`/api/faculty/questions/${created.id}`).send(question({ correctIndex: 1, marks: 5 })).expect(200);
    const stored = (await TestAttempt.findById(attempt.id))!;
    const res = await student.agent.post(`/api/student/attempts/${attempt.id}/submit`).send({ answers: [{ questionId: created.id, selectedIndex: stored.questions[0].correctIndex }] }).expect(200);
    expect(res.body.result.result).toMatchObject({ totalMarks: 3, marksObtained: 3, percent: 100 });
  });
});
