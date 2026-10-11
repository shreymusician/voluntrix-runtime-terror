import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Assignment, StudentProfile, User } from '../src/models.js';
import {
  activityPayload,
  addAttendance,
  createFaculty,
  createStudent,
  createVolunteer,
  dayFromNow,
  eventPayload,
  loginAs,
  profilePayload,
  useTestApp,
} from './helpers.js';

const t = useTestApp('volunteer');
const DAY = dayFromNow(5);
const slot = (startTime: string, endTime: string, date = DAY) => ({ date, startTime, endTime });

async function facultyAgent() {
  const faculty = await createFaculty(t.app);
  return { ...faculty, agent: await loginAs(t.app, faculty.username, 'faculty') };
}

/** A published event with the given activities, owned by a new faculty member. */
async function scenario(...activities: Record<string, unknown>[]) {
  const faculty = await facultyAgent();
  const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
  const created = [];
  for (const activity of activities) {
    created.push((await faculty.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload(activity)).expect(201)).body.activity);
  }
  const allocate = (clearPending = false) => faculty.agent.post(`/api/manage/events/${event.id}/allocate`).send({ clearPending }).expect(200);
  const assignments = async (query = '') =>
    (await faculty.agent.get(`/api/manage/assignments?eventId=${event.id}${query}`).expect(200)).body.assignments as {
      id: string;
      status: string;
      issues: string[];
      student: { id: string };
      activity: { id: string };
    }[];
  return { faculty, event, activities: created, allocate, assignments };
}

const assignedTo = (report: { activities: { activityId: string; newlyAssigned: { studentId: string }[] }[] }, activityId: string) =>
  report.activities.find((a) => a.activityId === activityId)!.newlyAssigned.map((n) => n.studentId);

describe('volunteer profile', () => {
  it('saves a valid profile, marks it complete and reloads it', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    expect((await agent.get('/api/me')).body.studentProfile.profileComplete).toBe(false);

    const payload = profilePayload({ skills: ['Communication', 'Leadership', 'Video Editing'], preferences: ['Registration Management'] });
    const saved = await agent.put('/api/volunteer-profile').send(payload).expect(200);
    expect(saved.body.profile).toMatchObject({ complete: true, skills: ['Communication', 'Leadership', 'Video Editing'], department: payload.department });
    expect(saved.body.profile.completion.percent).toBe(100);

    const reloaded = await agent.get('/api/volunteer-profile').expect(200);
    expect(reloaded.body.profile.skills).toEqual(['Communication', 'Leadership', 'Video Editing']);
    expect(reloaded.body.profile.availability).toEqual(payload.availability);
    expect((await agent.get('/api/me')).body.studentProfile.profileComplete).toBe(true);
    expect((await StudentProfile.findOne({ userId: student.id }))?.skillKeys).toEqual(['communication', 'leadership', 'video editing']);
  });

  it('cannot be completed with an empty skills list', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    const res = await agent.put('/api/volunteer-profile').send(profilePayload({ skills: [] })).expect(400);
    expect(res.body.details.skills).toMatch(/at least one skill/i);
    expect((await agent.get('/api/volunteer-profile')).body.profile.complete).toBe(false);
  });

  it('normalizes duplicate skills and rejects bad ones', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    const res = await agent
      .put('/api/volunteer-profile')
      .send(profilePayload({ skills: ['Leadership', ' leadership ', 'LEADERSHIP', '  video   editing ', 'Video Editing'] }))
      .expect(200);
    expect(res.body.profile.skills).toEqual(['Leadership', 'video editing']);

    for (const skills of [['Ok', '   '], ['x'.repeat(41)], ['<script>'], Array.from({ length: 16 }, (_, i) => `Skill ${i}`), [42]]) {
      const bad = await agent.put('/api/volunteer-profile').send({ skills }).expect(400);
      expect(bad.body.details.skills).toBeDefined();
    }
    expect((await agent.get('/api/volunteer-profile')).body.profile.skills).toEqual(['Leadership', 'video editing']);
  });

  it('accepts legacy activity-type aliases and stores their canonical names', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    const saved = await agent.put('/api/volunteer-profile').send(profilePayload({ preferences: ['registration', 'PHOTOGRAPHY'] })).expect(200);
    expect(saved.body.profile.preferences).toEqual(['Registration Management', 'Photography and Media']);

    const faculty = await facultyAgent();
    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const activity = (await faculty.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload({ activityType: 'Photography' })).expect(201)).body.activity;
    expect(activity.activityType).toBe('Photography and Media');
  });

  it('rejects invalid, overlapping and past availability', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    const cases = [
      [slot('14:00', '10:00')],
      [slot('10:00', '10:00')],
      [slot('09:00', '12:00'), slot('11:00', '13:00')],
      [slot('09:00', '12:00'), slot('09:00', '12:00')],
      [slot('09:00', '12:00', dayFromNow(-1))],
      [slot('09:00', '12:00', '2026-02-30')],
      [slot('25:00', '26:00')],
    ];
    for (const availability of cases) {
      const res = await agent.put('/api/volunteer-profile').send({ availability }).expect(400);
      expect(res.body.details.availability).toBeDefined();
    }
    // Back-to-back slots do not overlap.
    await agent.put('/api/volunteer-profile').send({ availability: [slot('09:00', '12:00'), slot('12:00', '15:00')] }).expect(200);
  });

  it('validates hours, phone, email and protected fields', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    const expectField = async (body: Record<string, unknown>, field: string) =>
      expect((await agent.put('/api/volunteer-profile').send(body).expect(400)).body.details).toHaveProperty(field);

    await expectField({ maxHoursPerDay: 0 }, 'maxHoursPerDay');
    await expectField({ maxHoursPerDay: 13 }, 'maxHoursPerDay');
    await expectField({ phone: '+911234567890' }, 'phone');
    await expectField({ email: 'someone.else@example.com' }, 'email');
    await expectField({ department: 'Wizardry' }, 'department');
    await expectField({ semester: 9 }, 'semester');
    await expectField({ preferences: ['Juggling'] }, 'preferences');
    await expectField({ role: 'organizer' }, 'role');
    await expectField({ userId: '64b7f0f0f0f0f0f0f0f0f0f0' }, 'userId');
    await expectField({ usn: '1VX22CS999' }, 'usn');
    expect((await User.findById(student.id))?.role).toBe('student');
  });

  it('keeps one profile per student however often it is submitted', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    await Promise.all(Array.from({ length: 4 }, () => agent.put('/api/volunteer-profile').send(profilePayload())));
    await agent.put('/api/volunteer-profile').send(profilePayload({ skills: ['Logistics'] })).expect(200);
    expect(await StudentProfile.countDocuments({ userId: student.id })).toBe(1);
    expect(await StudentProfile.countDocuments()).toBe(1);
    // A completed profile cannot be emptied again.
    await agent.put('/api/volunteer-profile').send({ skills: [] }).expect(400);
  });

  it("never exposes another student's profile or the volunteer list", async () => {
    const other = await createVolunteer(t.app, { skills: ['First Aid'] });
    const me = await createVolunteer(t.app, { skills: ['Logistics'] });

    const mine = await me.agent.get('/api/volunteer-profile').expect(200);
    expect(mine.body.profile.skills).toEqual(['Logistics']);
    expect(JSON.stringify(mine.body)).not.toContain(other.usn);
    await me.agent.get(`/api/volunteer-profile?userId=${other.id}`).expect(200).then((r) => expect(r.body.profile.usn).toBe(me.usn));
    await me.agent.get('/api/manage/volunteers').expect(403);
    await request(t.app).get('/api/volunteer-profile').expect(401);

    // Faculty have no volunteer profile and cannot write one.
    const faculty = await facultyAgent();
    await faculty.agent.put('/api/volunteer-profile').send(profilePayload()).expect(403);
    const list = await faculty.agent.get('/api/manage/volunteers?skill=first aid').expect(200);
    expect(list.body.volunteers.map((v: { id: string }) => v.id)).toEqual([other.id]);
  });
});

describe('events and activities', () => {
  it('lets faculty create events and activities with validation', async () => {
    const faculty = await facultyAgent();
    await faculty.agent.post('/api/manage/events').send(eventPayload({ name: '' })).expect(400);
    const badDates = await faculty.agent.post('/api/manage/events').send(eventPayload({ endDate: dayFromNow(4) })).expect(400);
    expect(badDates.body.details.endDate).toBeDefined();

    const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
    const url = `/api/manage/events/${event.id}/activities`;
    for (const [overrides, field] of [
      [{ endTime: '08:00' }, 'endTime'],
      [{ date: dayFromNow(9) }, 'date'],
      [{ requiredCount: 0 }, 'requiredCount'],
      [{ requiredCount: 1.5 }, 'requiredCount'],
      [{ name: ' ' }, 'name'],
      [{ requiredSkills: ['  '] }, 'requiredSkills'],
    ] as const) {
      const res = await faculty.agent.post(url).send(activityPayload(overrides)).expect(400);
      expect(res.body.details).toHaveProperty(field);
    }
    const activity = (await faculty.agent.post(url).send(activityPayload({ requiredSkills: [' communication ', 'COMMUNICATION'] })).expect(201)).body.activity;
    expect(activity.requiredSkills).toEqual(['Communication']);

    const detail = await faculty.agent.get(`/api/manage/events/${event.id}`).expect(200);
    expect(detail.body.event.activities[0]).toMatchObject({ name: 'Registration Desk', vacancies: 2, confirmed: 0 });
  });

  it('refuses event management to students and to organizers of other events', async () => {
    const { event, activities } = await scenario({});
    const student = await createVolunteer(t.app);

    await request(t.app).get('/api/manage/events').expect(401);
    await student.agent.get('/api/manage/events').expect(403);
    await student.agent.post('/api/manage/events').send(eventPayload()).expect(403);
    await student.agent.put(`/api/manage/events/${event.id}`).send(eventPayload()).expect(403);
    await student.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload()).expect(403);
    await student.agent.post(`/api/manage/events/${event.id}/allocate`).send({}).expect(403);
    await student.agent.get('/api/manage/analytics').expect(403);

    // A promoted organizer manages their own events only.
    await User.updateOne({ _id: student.id }, { role: 'organizer' });
    const organizer = await loginAs(t.app, student.username, 'organizer');
    await organizer.put(`/api/manage/events/${event.id}`).send(eventPayload()).expect(403);
    await organizer.put(`/api/manage/activities/${activities[0].id}`).send(activityPayload()).expect(403);
    await organizer.post(`/api/manage/events/${event.id}/allocate`).send({}).expect(403);
    expect((await organizer.get('/api/manage/events').expect(200)).body.events).toEqual([]);
    const own = (await organizer.post('/api/manage/events').send(eventPayload({ name: 'Club Day' })).expect(201)).body.event;
    await organizer.post(`/api/manage/events/${own.id}/activities`).send(activityPayload()).expect(201);
    expect((await organizer.get('/api/manage/events')).body.events).toHaveLength(1);
  });
});

describe('allocation engine', () => {
  it('assigns only volunteers with the mandatory skill who are available', async () => {
    const qualified = await createVolunteer(t.app, { skills: ['Communication'] });
    const unskilled = await createVolunteer(t.app, { skills: ['Photography'] });
    const unavailable = await createVolunteer(t.app, { skills: ['Communication'], availability: [slot('13:00', '18:00')] });
    const partlyAvailable = await createVolunteer(t.app, { skills: ['Communication'], availability: [slot('10:00', '18:00')] });
    const s = await scenario({ requiredCount: 3 });

    const report = (await s.allocate()).body.report;
    expect(assignedTo(report, s.activities[0].id)).toEqual([qualified.id]);
    for (const excluded of [unskilled, unavailable, partlyAvailable]) {
      expect(await Assignment.countDocuments({ studentId: excluded.id })).toBe(0);
    }

    // Shortage is reported, with the reason, instead of inventing assignments.
    const entry = report.activities[0];
    expect(entry).toMatchObject({ required: 3, assigned: 1, vacancies: 2, status: 'shortage' });
    expect(entry.shortageReason).toMatch(/Only 1 of 4/);
    expect(entry.shortageReason).toMatch(/1 lack a required skill/);
    expect(entry.shortageReason).toMatch(/2 are not available/);
    expect(await Assignment.countDocuments()).toBe(1);
  });

  it('saves generated assignments as pending with a score and explanation', async () => {
    const volunteer = await createVolunteer(t.app, { preferences: ['Registration Management'] });
    const s = await scenario({ activityType: 'Registration Management', requiredCount: 1 });
    await s.allocate();

    const [assignment] = await s.assignments();
    expect(assignment).toMatchObject({ status: 'pending', source: 'auto', issues: [] });
    const stored = await Assignment.findById(assignment.id);
    expect(stored?.score).toBeGreaterThan(0);
    expect(stored?.explanation.join(' ')).toMatch(/Prefers Registration Management/);

    const mine = (await volunteer.agent.get('/api/student/assignments').expect(200)).body.assignments;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'pending', activity: { name: 'Registration Desk', location: 'Front Gate' } });
    expect((await volunteer.agent.get('/api/notifications')).body.notifications[0].type).toBe('assignment_pending');
  });

  it('never exceeds capacity, automatically or manually', async () => {
    const volunteers = [await createVolunteer(t.app), await createVolunteer(t.app), await createVolunteer(t.app)];
    const s = await scenario({ requiredCount: 2 });
    const report = (await s.allocate()).body.report;
    expect(report.activities[0]).toMatchObject({ assigned: 2, vacancies: 0, status: 'filled' });

    const taken = new Set(assignedTo(report, s.activities[0].id));
    const left = volunteers.find((v) => !taken.has(v.id))!;
    const res = await s.faculty.agent.post(`/api/manage/activities/${s.activities[0].id}/assignments`).send({ studentId: left.id }).expect(409);
    expect(res.body.code).toBe('CAPACITY_FULL');
    // Running the allocation again adds nothing.
    await s.allocate();
    expect(await Assignment.countDocuments({ status: { $in: ['pending', 'confirmed'] } })).toBe(2);
  });

  it('fills a single seat correctly under concurrent manual assignment', async () => {
    const volunteers = [await createVolunteer(t.app), await createVolunteer(t.app), await createVolunteer(t.app)];
    const s = await scenario({ requiredCount: 1 });
    const results = await Promise.all(
      volunteers.map((v) => s.faculty.agent.post(`/api/manage/activities/${s.activities[0].id}/assignments`).send({ studentId: v.id })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await Assignment.countDocuments({ status: 'pending' })).toBe(1);
  });

  it('never gives one volunteer overlapping activities', async () => {
    const volunteer = await createVolunteer(t.app);
    const s = await scenario(
      { name: 'Morning A', startTime: '09:00', endTime: '11:00', requiredCount: 1 },
      { name: 'Morning B', startTime: '10:00', endTime: '12:00', requiredCount: 1 },
      { name: 'Afternoon', startTime: '11:00', endTime: '12:30', requiredCount: 1 },
    );
    const report = (await s.allocate()).body.report;
    const mine = await Assignment.find({ studentId: volunteer.id });
    const names = report.activities.filter((a: { newlyAssigned: unknown[] }) => a.newlyAssigned.length).map((a: { name: string }) => a.name);
    // Two of the three overlap; the volunteer gets a compatible pair or a single one, never an overlap.
    expect(names.includes('Morning A') && names.includes('Morning B')).toBe(false);
    expect(names.includes('Morning B') && names.includes('Afternoon')).toBe(false);
    expect(mine.length).toBe(names.length);

    const free = report.activities.find((a: { newlyAssigned: unknown[] }) => !a.newlyAssigned.length);
    expect(free.shortageReason).toMatch(/overlapping assignment/);
    const manual = await s.faculty.agent.post(`/api/manage/activities/${free.activityId}/assignments`).send({ studentId: volunteer.id }).expect(422);
    expect(manual.body.code).toBe('NOT_ELIGIBLE');
    expect(manual.body.details.violations[0].code).toBe('TIME_CONFLICT');
  });

  it('cannot double-book a volunteer through concurrent requests', async () => {
    const volunteer = await createVolunteer(t.app);
    const s = await scenario(
      { name: 'A', startTime: '09:00', endTime: '11:00' },
      { name: 'B', startTime: '10:00', endTime: '12:00' },
      { name: 'C', startTime: '10:30', endTime: '11:30' },
    );
    const results = await Promise.all(
      s.activities.map((a) => s.faculty.agent.post(`/api/manage/activities/${a.id}/assignments`).send({ studentId: volunteer.id })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Assignment.countDocuments({ studentId: volunteer.id, status: 'pending' })).toBe(1);
  });

  it('enforces the maximum working hours per day', async () => {
    const volunteer = await createVolunteer(t.app, { maxHoursPerDay: 3 });
    const s = await scenario(
      { name: 'First', startTime: '09:00', endTime: '11:00', requiredCount: 1 },
      { name: 'Second', startTime: '12:00', endTime: '14:00', requiredCount: 1 },
    );
    const report = (await s.allocate()).body.report;
    expect(await Assignment.countDocuments({ studentId: volunteer.id })).toBe(1);
    const unfilled = report.activities.find((a: { newlyAssigned: unknown[] }) => !a.newlyAssigned.length);
    expect(unfilled.shortageReason).toMatch(/daily hours limit/);
    const manual = await s.faculty.agent.post(`/api/manage/activities/${unfilled.activityId}/assignments`).send({ studentId: volunteer.id }).expect(422);
    expect(manual.body.details.violations[0].code).toBe('HOURS_EXCEEDED');
  });

  it('requires prior experience where an activity asks for it', async () => {
    const novice = await createVolunteer(t.app);
    const veteran = await createVolunteer(t.app);
    await addAttendance(veteran.id, 'attended');
    const s = await scenario({ minPriorEvents: 1, requiredCount: 2 });
    const report = (await s.allocate()).body.report;
    expect(assignedTo(report, s.activities[0].id)).toEqual([veteran.id]);
    expect(await Assignment.countDocuments({ studentId: novice.id })).toBe(0);
  });

  it('uses preferences to rank, but never to override a hard rule', async () => {
    const keen = await createVolunteer(t.app, { preferences: ['Hospitality'] });
    const neutral = await createVolunteer(t.app);
    const keenButUnqualified = await createVolunteer(t.app, { preferences: ['Hospitality'], skills: ['Photography'] });
    const s = await scenario({ activityType: 'Hospitality', requiredCount: 1 });
    const report = (await s.allocate()).body.report;
    expect(assignedTo(report, s.activities[0].id)).toEqual([keen.id]);

    const candidates = (await s.faculty.agent.get(`/api/manage/activities/${s.activities[0].id}/candidates`).expect(200)).body;
    expect(candidates.eligible.map((c: { id: string }) => c.id)).toEqual([neutral.id]);
    const reasons = Object.fromEntries(candidates.ineligible.map((c: { id: string; reasons: string[] }) => [c.id, c.reasons.join(' ')]));
    expect(reasons[keenButUnqualified.id]).toMatch(/Missing required skill/);
    expect(reasons[keen.id]).toMatch(/Already assigned/);
  });

  it('spreads work across volunteers instead of loading one person', async () => {
    const a = await createVolunteer(t.app);
    const b = await createVolunteer(t.app);
    const s = await scenario(
      { name: 'One', startTime: '09:00', endTime: '10:00', requiredCount: 1 },
      { name: 'Two', startTime: '11:00', endTime: '12:00', requiredCount: 1 },
    );
    await s.allocate();
    expect(await Assignment.countDocuments({ studentId: a.id })).toBe(1);
    expect(await Assignment.countDocuments({ studentId: b.id })).toBe(1);
  });

  it('does not overwrite confirmed assignments when regenerating', async () => {
    await createVolunteer(t.app);
    await createVolunteer(t.app);
    const s = await scenario({ requiredCount: 2 });
    await s.allocate();
    const [first, second] = await s.assignments();
    await s.faculty.agent.post(`/api/manage/assignments/${first.id}/confirm`).expect(200);

    const report = (await s.allocate(true)).body.report;
    expect(report.clearedPending).toBe(1);
    expect((await Assignment.findById(first.id))?.status).toBe('confirmed');
    expect(await Assignment.findById(second.id)).toBeNull();
    expect(await Assignment.countDocuments({ status: 'confirmed' })).toBe(1);
    expect(await Assignment.countDocuments({ status: 'pending' })).toBe(1);
    expect(report.activities[0]).toMatchObject({ alreadyAssigned: 1, assigned: 2, vacancies: 0 });
  });
});

describe('approval, conflicts and reallocation', () => {
  it('only lets authorized managers approve assignments', async () => {
    const volunteer = await createVolunteer(t.app);
    const s = await scenario({ requiredCount: 1 });
    await s.allocate();
    const [assignment] = await s.assignments();
    const url = `/api/manage/assignments/${assignment.id}/confirm`;

    await request(t.app).post(url).expect(401);
    await volunteer.agent.post(url).expect(403);
    const outsider = await createVolunteer(t.app);
    await User.updateOne({ _id: outsider.id }, { role: 'organizer' });
    await (await loginAs(t.app, outsider.username, 'organizer')).post(url).expect(403);
    expect((await Assignment.findById(assignment.id))?.status).toBe('pending');

    await s.faculty.agent.post(url).expect(200);
    await s.faculty.agent.post(url).expect(409);
    expect((await volunteer.agent.get('/api/notifications')).body.notifications[0].type).toBe('assignment_confirmed');
  });

  it('re-validates at confirmation and offers alternatives when it fails', async () => {
    const volunteer = await createVolunteer(t.app);
    const s = await scenario({ requiredCount: 1 });
    await s.allocate();
    const [assignment] = await s.assignments();
    const backup = await createVolunteer(t.app);

    // The volunteer withdraws their availability after being proposed.
    await volunteer.agent.put('/api/volunteer-profile').send({ availability: [slot('15:00', '18:00')] }).expect(200);
    expect((await s.assignments())[0].issues.join(' ')).toMatch(/Not available/);

    const res = await s.faculty.agent.post(`/api/manage/assignments/${assignment.id}/confirm`).expect(422);
    expect(res.body.code).toBe('NOT_ELIGIBLE');
    expect(res.body.details.alternatives.map((a: { id: string }) => a.id)).toEqual([backup.id]);
    expect((await Assignment.findById(assignment.id))?.status).toBe('pending');
  });

  it('re-validates assignments when the activity changes', async () => {
    await createVolunteer(t.app, { availability: [slot('09:00', '11:00')] });
    const s = await scenario({ requiredCount: 1 });
    await s.allocate();
    const [assignment] = await s.assignments();
    await s.faculty.agent.post(`/api/manage/assignments/${assignment.id}/confirm`).expect(200);

    const moved = await s.faculty.agent
      .put(`/api/manage/activities/${s.activities[0].id}`)
      .send(activityPayload({ requiredCount: 1, startTime: '13:00', endTime: '15:00' }))
      .expect(200);
    expect(moved.body.affectedAssignments).toHaveLength(1);
    expect(moved.body.affectedAssignments[0].issues.join(' ')).toMatch(/Not available/);
    expect((await s.faculty.agent.get('/api/manage/analytics').expect(200)).body.totals.conflicts).toBe(1);

    const needsSkill = await s.faculty.agent
      .put(`/api/manage/activities/${s.activities[0].id}`)
      .send(activityPayload({ requiredCount: 1, requiredSkills: ['First Aid'] }))
      .expect(200);
    expect(needsSkill.body.affectedAssignments[0].issues.join(' ')).toMatch(/Missing required skill: First Aid/);
  });

  it('replaces a volunteer only with someone who passes every rule', async () => {
    const original = await createVolunteer(t.app);
    const s = await scenario({ requiredCount: 1 });
    await s.allocate();
    const [assignment] = await s.assignments();
    const unqualified = await createVolunteer(t.app, { skills: ['Photography'] });
    const qualified = await createVolunteer(t.app);
    const url = `/api/manage/assignments/${assignment.id}/replace`;

    await s.faculty.agent.post(url).send({ studentId: unqualified.id }).expect(422);
    // The failed replacement left the original untouched.
    expect((await Assignment.findById(assignment.id))?.status).toBe('pending');
    expect(await Assignment.countDocuments()).toBe(1);

    await s.faculty.agent.post(url).send({ studentId: qualified.id }).expect(200);
    expect((await Assignment.findById(assignment.id))?.status).toBe('cancelled');
    expect(await Assignment.countDocuments({ studentId: qualified.id, status: 'pending' })).toBe(1);
    expect(await Assignment.countDocuments({ studentId: original.id, status: { $in: ['pending', 'confirmed'] } })).toBe(0);
  });

  it('lets a volunteer cancel only their own assignment, and refills the vacancy', async () => {
    const volunteer = await createVolunteer(t.app);
    const s = await scenario({ requiredCount: 1 });
    await s.allocate();
    const [assignment] = await s.assignments();
    await s.faculty.agent.post(`/api/manage/assignments/${assignment.id}/confirm`).expect(200);

    const other = await createVolunteer(t.app, { skills: ['Photography'] });
    await other.agent.post(`/api/student/assignments/${assignment.id}/cancel`).send({}).expect(404);
    expect((await other.agent.get('/api/student/assignments')).body.assignments).toEqual([]);

    await volunteer.agent.post(`/api/student/assignments/${assignment.id}/cancel`).send({ reason: 'Exam' }).expect(200);
    expect((await s.faculty.agent.get('/api/notifications')).body.notifications[0].type).toBe('volunteer_cancelled');

    // No suitable replacement: the vacancy stays, with the reason.
    let report = (await s.allocate()).body.report;
    expect(report.activities[0]).toMatchObject({ assigned: 1, vacancies: 0 });
    await Assignment.deleteMany({ status: 'pending' });
    await volunteer.agent.put('/api/volunteer-profile').send({ availability: [slot('15:00', '18:00')] }).expect(200);
    report = (await s.allocate()).body.report;
    expect(report.activities[0]).toMatchObject({ assigned: 0, vacancies: 1, status: 'shortage' });
    expect(report.activities[0].shortageReason).toMatch(/None of the 2/);

    const replacement = await createVolunteer(t.app);
    report = (await s.allocate()).body.report;
    expect(assignedTo(report, s.activities[0].id)).toEqual([replacement.id]);
  });

  it('confirms all valid pending assignments and reports the ones that fail', async () => {
    const ok = await createVolunteer(t.app);
    const changed = await createVolunteer(t.app);
    const s = await scenario({ requiredCount: 2 });
    await s.allocate();
    await changed.agent.put('/api/volunteer-profile').send({ skills: ['Photography'] }).expect(200);

    const res = await s.faculty.agent.post(`/api/manage/events/${s.event.id}/assignments/confirm-all`).expect(200);
    expect(res.body.confirmed).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    expect(await Assignment.countDocuments({ studentId: ok.id, status: 'confirmed' })).toBe(1);
    expect(await Assignment.countDocuments({ studentId: changed.id, status: 'pending' })).toBe(1);
  });

  it('releases seats and notifies volunteers when an event is cancelled', async () => {
    const volunteer = await createVolunteer(t.app);
    const s = await scenario({ requiredCount: 1 });
    await s.allocate();
    const res = await s.faculty.agent.put(`/api/manage/events/${s.event.id}`).send(eventPayload({ status: 'cancelled' })).expect(200);
    expect(res.body.event.releasedAssignments).toBe(1);
    expect(await Assignment.countDocuments({ studentId: volunteer.id, status: 'cancelled' })).toBe(1);
    await s.faculty.agent.post(`/api/manage/events/${s.event.id}/allocate`).send({}).expect(409);
    await s.faculty.agent.delete(`/api/manage/events/${s.event.id}`).expect(409);
  });
});

describe('dashboards and analytics', () => {
  it('shows a student their own real data', async () => {
    const volunteer = await createVolunteer(t.app, { skills: ['Communication', 'Logistics'] });
    await addAttendance(volunteer.id, 'attended');
    await addAttendance(volunteer.id, 'absent');
    const s = await scenario({ requiredCount: 1 }, { name: 'Stage', requiredSkills: ['Stage Management'], startTime: '12:00', endTime: '13:00' });
    await s.allocate();

    let dashboard = (await volunteer.agent.get('/api/student/dashboard').expect(200)).body;
    expect(dashboard.profile).toMatchObject({ complete: true, skills: ['Communication', 'Logistics'] });
    expect(dashboard.upcomingEvents.map((e: { name: string }) => e.name)).toEqual(['Tech Fest']);
    expect(dashboard.pendingAssignments).toHaveLength(1);
    expect(dashboard.confirmedAssignments).toHaveLength(0);
    // Two hours attended; the absent activity does not count.
    expect(dashboard.totals).toMatchObject({ completedHours: 2, upcomingHours: 0, completedActivities: 1 });

    const available = Object.fromEntries(dashboard.availableActivities.map((a: { name: string }) => [a.name, a]));
    expect(available['Registration Desk']).toMatchObject({ eligible: true, myStatus: 'pending', vacancies: 0 });
    expect(available.Stage).toMatchObject({ eligible: false, myStatus: null });
    expect(available.Stage.reasons.join(' ')).toMatch(/Stage Management/);

    await s.faculty.agent.post(`/api/manage/assignments/${(await s.assignments())[0].id}/confirm`).expect(200);
    dashboard = (await volunteer.agent.get('/api/student/dashboard')).body;
    expect(dashboard.pendingAssignments).toHaveLength(0);
    expect(dashboard.schedule).toHaveLength(1);
    expect(dashboard.totals.upcomingHours).toBe(2);
  });

  it('derives analytics from the stored records', async () => {
    await createVolunteer(t.app, { skills: ['Communication', 'Logistics'] });
    await createVolunteer(t.app, { skills: ['Communication'] });
    await createStudent(t.app); // registered, profile not completed
    const s = await scenario({ requiredCount: 3 }, { name: 'Stage', requiredSkills: ['Stage Management'], requiredCount: 2, startTime: '12:00', endTime: '13:00' });

    let stats = (await s.faculty.agent.get('/api/manage/analytics').expect(200)).body;
    expect(stats.totals).toMatchObject({
      volunteers: 3,
      volunteersWithCompleteProfile: 2,
      events: 1,
      activities: 2,
      positionsRequired: 5,
      positionsAssigned: 0,
      pendingApprovals: 0,
      vacancies: 5,
      conflicts: 0,
    });
    expect(stats.skillDistribution).toEqual([
      { skill: 'Communication', volunteers: 2 },
      { skill: 'Logistics', volunteers: 1 },
    ]);

    await s.allocate();
    await s.faculty.agent.post(`/api/manage/assignments/${(await s.assignments())[0].id}/confirm`).expect(200);
    stats = (await s.faculty.agent.get('/api/manage/analytics')).body;
    expect(stats.totals).toMatchObject({ positionsAssigned: 2, positionsConfirmed: 1, pendingApprovals: 1, vacancies: 3 });
    expect(stats.activityAllocation.find((a: { name: string }) => a.name === 'Registration Desk')).toMatchObject({ required: 3, confirmed: 1, pending: 1, vacancies: 1 });
    expect(stats.understaffed.map((a: { name: string }) => a.name).sort()).toEqual(['Registration Desk', 'Stage']);
    expect(stats.workloadDistribution).toEqual(expect.arrayContaining([{ label: 'No duties', volunteers: 1 }, { label: 'Up to 2 h', volunteers: 2 }]));
  });

  it('records attendance after an activity, for organizers only', async () => {
    const volunteer = await createVolunteer(t.app);
    const s = await scenario();
    const past = await addAttendance(volunteer.id, null);

    const url = `/api/manage/assignments/${past.id}/outcome`;
    await volunteer.agent.post(url).send({ attendance: 'attended' }).expect(403);
    await s.faculty.agent.post(url).send({ attendance: 'attended', rating: 5 }).expect(400);
    await s.faculty.agent.post(url).send({ attendance: 'attended' }).expect(200);

    const created = await volunteer.agent.post('/api/promotion-requests').send({}).expect(201);
    const detail = (await s.faculty.agent.get(`/api/faculty/promotion-requests/${created.body.request.id}`).expect(200)).body.request;
    expect(detail.evidence.summary).toMatchObject({ recordedEvents: 1, attendedEvents: 1, feedbackCount: 0, averageRating: null });
  });
});
