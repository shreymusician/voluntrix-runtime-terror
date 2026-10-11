import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { toInstant } from '../src/catalog.js';
import { Activity, Assignment, Event, StudentProfile, TestAttempt, User } from '../src/models.js';
import { ensureQuestionBank } from '../src/services/questionBank.js';
import { activityPayload, createFaculty, createVolunteer, dayFromNow, eventPayload, loginAs, useTestApp } from './helpers.js';

const t = useTestApp('eligibility');

const DAY = () => dayFromNow(5);
type Agent = Awaited<ReturnType<typeof loginAs>>;

async function facultyAgent() {
  const faculty = await createFaculty(t.app);
  return { ...faculty, agent: await loginAs(t.app, faculty.username, 'faculty') };
}

/** Creates a published event and returns a helper that adds activities to it. */
async function publishedEvent() {
  const faculty = await facultyAgent();
  const event = (await faculty.agent.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
  const addActivity = async (overrides: Record<string, unknown> = {}) =>
    (await faculty.agent.post(`/api/manage/events/${event.id}/activities`).send(activityPayload(overrides)).expect(201)).body.activity;
  return { faculty, event, addActivity };
}

const activities = async (agent: Agent) => (await agent.get('/api/student/activities').expect(200)).body.activities;
const vacancies = async (agent: Agent) => (await agent.get('/api/student/vacancies').expect(200)).body;
// Responses are plain JSON here; the server-side types are asserted by the API itself.
const byName = (list: any[], name: string) => list.find((a) => a.name === name)!;

const allDay = [{ date: DAY(), startTime: '08:00', endTime: '20:00' }];

describe('eligibility is decided per activity from the saved profile', () => {
  // 1
  it('recognises a student with several skills as eligible for the activity they match', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Reg', requiredSkills: ['Registration Management'], startTime: '09:00', endTime: '11:00' });

    const student = await createVolunteer(t.app, {
      skills: ['Registration Management', 'Technical Support', 'Communication', 'Teamwork'],
      preferences: ['Registration Management', 'Technical Support'],
      availability: allDay,
      maxHoursPerDay: 8,
    });

    const list = await activities(student.agent);
    expect(byName(list, 'Reg')).toMatchObject({ eligible: true, reasons: [] });
  });

  // 2
  it('matches every selected preference, not only the first, and lists all eligible activities', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Reg', activityType: 'Registration Management', requiredSkills: ['Registration Management'], startTime: '09:00', endTime: '10:00' });
    await addActivity({ name: 'Tech', activityType: 'Technical Support', requiredSkills: ['Technical Support'], startTime: '11:00', endTime: '12:00' });
    await addActivity({ name: 'Host', activityType: 'Hospitality', requiredSkills: ['Hospitality'], startTime: '13:00', endTime: '14:00' });

    const student = await createVolunteer(t.app, {
      skills: ['Registration Management', 'Technical Support', 'Hospitality'],
      // Three preferences: all three must be honoured.
      preferences: ['Registration Management', 'Technical Support', 'Hospitality'],
      availability: allDay,
      maxHoursPerDay: 8,
    });

    const list = await activities(student.agent);
    expect(list.filter((a: { eligible: boolean }) => a.eligible).map((a: { name: string }) => a.name).sort()).toEqual(['Host', 'Reg', 'Tech']);
  });

  // 3
  it('keeps a student eligible when only an optional nice-to-have skill is missing', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Optional', requiredSkills: ['Communication'], preferredSkills: ['Photography', 'Leadership'], startTime: '09:00', endTime: '11:00' });

    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });
    expect(byName(await activities(student.agent), 'Optional')).toMatchObject({ eligible: true, reasons: [] });
  });

  it('does not disqualify a student whose preferred category differs from the activity category', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Host', activityType: 'Hospitality', requiredSkills: ['Communication'], startTime: '09:00', endTime: '11:00' });

    const student = await createVolunteer(t.app, { skills: ['Communication'], preferences: ['Technical Support'], availability: allDay });
    expect(byName(await activities(student.agent), 'Host')).toMatchObject({ eligible: true });
  });

  it('does not reject anyone from an activity that lists no mandatory skills', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Anyone', requiredSkills: [], startTime: '09:00', endTime: '11:00' });

    const student = await createVolunteer(t.app, { skills: ['Photography'], availability: allDay });
    expect(byName(await activities(student.agent), 'Anyone')).toMatchObject({ eligible: true, reasons: [] });
  });

  it('treats consecutive availability slots as one continuous block', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'LongShift', requiredSkills: ['Technical Support'], startTime: '09:00', endTime: '13:00' });

    // Entered as two touching blocks: the student is genuinely free 09:00-13:00.
    const student = await createVolunteer(t.app, {
      skills: ['Technical Support'],
      availability: [
        { date: DAY(), startTime: '09:00', endTime: '11:00' },
        { date: DAY(), startTime: '11:00', endTime: '13:00' },
      ],
      maxHoursPerDay: 8,
    });
    expect(byName(await activities(student.agent), 'LongShift')).toMatchObject({ eligible: true, reasons: [] });
  });

  it('matches skills saved with different capitalisation or spacing', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Reg', requiredSkills: ['Registration Management'], startTime: '09:00', endTime: '11:00' });

    const student = await createVolunteer(t.app, { skills: ['  registration   MANAGEMENT '], availability: allDay });
    expect(byName(await activities(student.agent), 'Reg')).toMatchObject({ eligible: true, reasons: [] });
  });

  it('still matches when the denormalised key arrays are missing on either side', async () => {
    const faculty = await createFaculty(t.app);
    const owner = await User.findById(faculty.id);
    const date = DAY();
    const event = await Event.create({ name: 'Imported', startDate: date, endDate: date, venue: 'Hall', status: 'published', createdBy: owner!._id });
    // Written straight to the database, as a seed or import would: no requiredSkillKeys.
    await Activity.create({
      eventId: event._id,
      name: 'Imported',
      date,
      startTime: '09:00',
      endTime: '11:00',
      startAt: toInstant(date, '09:00', 330),
      endAt: toInstant(date, '11:00', 330),
      location: 'Hall',
      requiredSkills: ['Communication'],
      requiredCount: 2,
    });

    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });
    // ...and a profile whose skillKeys were never populated.
    await StudentProfile.updateOne({ userId: student.id }, { $set: { skillKeys: [] } });

    expect(byName(await activities(student.agent), 'Imported')).toMatchObject({ eligible: true, reasons: [] });
  });

  // 4
  it('marks a student ineligible, with the reason, when a genuine mandatory rule fails', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'NeedsSkill', requiredSkills: ['Stage Management'], startTime: '09:00', endTime: '11:00' });
    await addActivity({ name: 'NeedsTime', requiredSkills: [], startTime: '18:00', endTime: '20:00' });
    await addActivity({ name: 'TooLong', requiredSkills: [], startTime: '09:00', endTime: '15:00' });
    await addActivity({ name: 'NeedsHistory', requiredSkills: [], minPriorEvents: 3, startTime: '09:00', endTime: '10:00' });

    const student = await createVolunteer(t.app, {
      skills: ['Communication'],
      availability: [{ date: DAY(), startTime: '08:00', endTime: '16:00' }],
      maxHoursPerDay: 4,
    });

    const list = await activities(student.agent);
    expect(byName(list, 'NeedsSkill')).toMatchObject({ eligible: false });
    expect(byName(list, 'NeedsSkill').reasons.join()).toMatch(/Missing required skill: Stage Management/);
    expect(byName(list, 'NeedsTime').reasons.join()).toMatch(/Not available/);
    expect(byName(list, 'TooLong').reasons.join()).toMatch(/limit is 4 h/);
    expect(byName(list, 'NeedsHistory').reasons.join()).toMatch(/Needs 3 attended/);
  });
});

describe('mock tests follow per-activity eligibility', () => {
  // 5
  it('unlocks the test only for the activity the student qualifies for', async () => {
    await ensureQuestionBank();
    const { addActivity } = await publishedEvent();
    const ok = await addActivity({ name: 'Ok', activityType: 'Technical Support', requiredSkills: ['Technical Support'], requireTestPass: true, startTime: '09:00', endTime: '10:00' });
    const no = await addActivity({ name: 'No', activityType: 'Hospitality', requiredSkills: ['Hospitality'], requireTestPass: true, startTime: '11:00', endTime: '12:00' });

    const student = await createVolunteer(t.app, { skills: ['Technical Support'], availability: allDay, maxHoursPerDay: 8 });

    const list = await activities(student.agent);
    expect(byName(list, 'Ok').testStatus).toBe('available');
    expect(byName(list, 'No').testStatus).toBe('locked');
    expect(byName(list, 'No').testLockedReasons.join()).toMatch(/Hospitality/);

    await student.agent.post(`/api/student/activities/${ok.id}/tests/start`).expect(201);
    // 12: the ineligible activity's test cannot be reached by calling the API directly.
    const blocked = await student.agent.post(`/api/student/activities/${no.id}/tests/start`).expect(403);
    expect(blocked.body.code).toBe('NOT_ELIGIBLE_FOR_ACTIVITY');
    expect(await TestAttempt.countDocuments({ studentId: student.id, category: 'Hospitality' })).toBe(0);
  });
});

describe('vacancy discovery', () => {
  // 6 + 9
  it('offers schedule-matching vacancies as skill-gap requests and shows why they are not yet eligible', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Stage', requiredSkills: ['Stage Management'], requiredCount: 3, startTime: '09:00', endTime: '11:00' });
    await addActivity({ name: 'Photo', requiredSkills: ['Photography'], requiredCount: 2, startTime: '12:00', endTime: '14:00' });

    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay, maxHoursPerDay: 8 });

    const list = await activities(student.agent);
    expect(list.every((a: { eligible: boolean }) => !a.eligible)).toBe(true);

    const res = await vacancies(student.agent);
    expect(res.eligibleForAnyActivity).toBe(true);
    expect(res.opportunities).toHaveLength(2);
    // The requests are allowed, but neither opportunity is yet eligible for confirmation.
    expect(res.opportunities.every((o: { kind: string }) => o.kind === 'explore')).toBe(true);
    expect(res.opportunities.every((o: { eligible: boolean }) => o.eligible === false)).toBe(true);
    expect(res.opportunities.every((o: { canRequest: boolean }) => o.canRequest)).toBe(true);
    expect(byName(res.opportunities, 'Stage').reasons.join()).toMatch(/Missing required skill: Stage Management/);
    expect(byName(res.opportunities, 'Stage').suggestionReason).toMatch(/schedule and other requirements match/);
    // Every field the popup needs is present.
    expect(byName(res.opportunities, 'Stage')).toMatchObject({
      requiredCount: 3,
      confirmedCount: 0,
      pendingCount: 0,
      vacancies: 3,
      location: 'Front Gate',
      date: DAY(),
    });
    expect(byName(res.opportunities, 'Stage').eligibilityRequirements.requiredSkills).toEqual(['Stage Management']);
  });

  // 7
  it('puts vacant activities the student does qualify for first, labelled eligible', async () => {
    const { addActivity } = await publishedEvent();
    await addActivity({ name: 'Stage', requiredSkills: ['Stage Management'], requiredCount: 2, startTime: '09:00', endTime: '11:00' });
    await addActivity({ name: 'Comms', activityType: 'Hospitality', requiredSkills: ['Communication'], requiredCount: 2, startTime: '12:00', endTime: '14:00' });

    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay, maxHoursPerDay: 8 });

    const res = await vacancies(student.agent);
    expect(res.opportunities[0]).toMatchObject({ name: 'Comms', kind: 'eligible', eligible: true });
    expect(res.opportunities[0].suggestionReason).toMatch(/meet every requirement/);
    expect(res.opportunities[1]).toMatchObject({ name: 'Stage', kind: 'explore', eligible: false });
  });

  // 8
  it('allows a schedule-matching student to request despite a skill gap, but blocks confirmation until the skill is added', async () => {
    const { faculty, addActivity } = await publishedEvent();
    const stage = await addActivity({ name: 'Stage', requiredSkills: ['Stage Management'], requiredCount: 2, startTime: '09:00', endTime: '11:00' });
    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });

    const listed = byName(await activities(student.agent), 'Stage');
    expect(listed).toMatchObject({ eligible: false, canRequest: true, reasons: ['Missing required skill: Stage Management'] });
    const request = await student.agent.post(`/api/student/activities/${stage.id}/apply`).send({}).expect(201);
    expect(request.body.assignment.status).toBe('pending');

    const blocked = await faculty.agent.post(`/api/manage/assignments/${request.body.assignment.id}/confirm`).send({}).expect(422);
    expect(blocked.body.details.violations[0].code).toBe('MISSING_SKILL');

    await student.agent.put('/api/volunteer-profile').send({ skills: ['Communication', 'Stage Management'] }).expect(200);
    await faculty.agent.post(`/api/manage/assignments/${request.body.assignment.id}/confirm`).send({}).expect(200);
  });

  it('refuses the application when the student is unavailable, even if skills are missing too', async () => {
    const { addActivity } = await publishedEvent();
    const stage = await addActivity({ name: 'Stage', requiredSkills: ['Stage Management'], requiredCount: 2, startTime: '09:00', endTime: '11:00' });

    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: [{ date: DAY(), startTime: '13:00', endTime: '18:00' }] });
    const res = await student.agent.post(`/api/student/activities/${stage.id}/apply`).send({}).expect(422);
    expect(res.body.code).toBe('NOT_ELIGIBLE');
    expect(res.body.details.violations[0].code).toBe('UNAVAILABLE');
  });

  it('does not call a student stranded once they already hold a place', async () => {
    const { addActivity } = await publishedEvent();
    const taken = await addActivity({ name: 'Taken', requiredSkills: ['Communication'], requiredCount: 2, startTime: '09:00', endTime: '11:00' });
    // A second activity that clashes with the first, so it can never be eligible too.
    await addActivity({ name: 'Clashes', requiredSkills: ['Communication'], requiredCount: 2, startTime: '10:00', endTime: '12:00' });

    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay, maxHoursPerDay: 8 });
    await student.agent.post(`/api/student/activities/${taken.id}/apply`).send({}).expect(201);

    // Everything still open now clashes, but the student plainly has a place.
    const list = await activities(student.agent);
    expect(byName(list, 'Clashes').eligible).toBe(false);
    expect((await vacancies(student.agent)).eligibleForAnyActivity).toBe(true);
  });

  it('excludes activities the student already holds a seat on', async () => {
    const { addActivity } = await publishedEvent();
    const comms = await addActivity({ name: 'Comms', requiredSkills: ['Communication'], requiredCount: 2, startTime: '09:00', endTime: '11:00' });
    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });

    await student.agent.post(`/api/student/activities/${comms.id}/apply`).send({}).expect(201);
    expect((await vacancies(student.agent)).opportunities).toHaveLength(0);
  });
});

describe('applying is re-validated on the server', () => {
  it('lets an eligible student volunteer, and the seat starts as pending', async () => {
    const { addActivity } = await publishedEvent();
    const comms = await addActivity({ name: 'Comms', requiredSkills: ['Communication'], requiredCount: 2, startTime: '09:00', endTime: '11:00' });
    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });

    const res = await student.agent.post(`/api/student/activities/${comms.id}/apply`).send({}).expect(201);
    expect(res.body.assignment.status).toBe('pending');
  });

  it('prevents duplicate applications', async () => {
    const { addActivity } = await publishedEvent();
    const comms = await addActivity({ name: 'Comms', requiredSkills: ['Communication'], requiredCount: 2, startTime: '09:00', endTime: '11:00' });
    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });

    await student.agent.post(`/api/student/activities/${comms.id}/apply`).send({}).expect(201);
    await student.agent.post(`/api/student/activities/${comms.id}/apply`).send({}).expect(422);
    // Exactly one live seat, so the second attempt added nothing.
    expect(await Assignment.countDocuments({ activityId: comms.id, studentId: student.id, status: { $in: ['pending', 'confirmed'] } })).toBe(1);
  });

  // 10
  it('reports a full activity as full rather than as a failed qualification', async () => {
    const { addActivity } = await publishedEvent();
    const only = await addActivity({ name: 'Only', requiredSkills: ['Communication'], requiredCount: 1, startTime: '09:00', endTime: '11:00' });

    const first = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });
    await first.agent.post(`/api/student/activities/${only.id}/apply`).send({}).expect(201);

    const second = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });
    const res = await second.agent.post(`/api/student/activities/${only.id}/apply`).send({}).expect(409);
    expect(res.body.code).toBe('CAPACITY_FULL');
    // The student still qualifies; the activity is simply full.
    expect(byName(await activities(second.agent), 'Only')).toMatchObject({ eligible: true, vacancies: 0 });
    // A full activity is not offered as a vacancy.
    expect((await vacancies(second.agent)).opportunities).toHaveLength(0);
  });

  it('refuses an application to a closed activity', async () => {
    const { faculty, addActivity } = await publishedEvent();
    const act = await addActivity({ name: 'Closing', requiredSkills: ['Communication'], startTime: '09:00', endTime: '11:00' });
    const student = await createVolunteer(t.app, { skills: ['Communication'], availability: allDay });

    await faculty.agent
      .put(`/api/manage/activities/${act.id}`)
      .send(activityPayload({ name: 'Closing', requiredSkills: ['Communication'], startTime: '09:00', endTime: '11:00', status: 'closed' }))
      .expect(200);

    const res = await student.agent.post(`/api/student/activities/${act.id}/apply`).send({}).expect(409);
    expect(res.body.code).toBe('ACTIVITY_NOT_OPEN');
  });

  // 12
  it('keeps these endpoints closed to other roles and to signed-out callers', async () => {
    const { addActivity } = await publishedEvent();
    const act = await addActivity({ name: 'Comms', requiredSkills: ['Communication'], startTime: '09:00', endTime: '11:00' });

    await request(t.app).post(`/api/student/activities/${act.id}/apply`).send({}).expect(401);
    await request(t.app).get('/api/student/vacancies').expect(401);

    const faculty = await facultyAgent();
    await faculty.agent.post(`/api/student/activities/${act.id}/apply`).send({}).expect(403);
    await faculty.agent.get('/api/student/vacancies').expect(403);
  });
});
