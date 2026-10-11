import { describe, expect, it } from 'vitest';
import { Activity, Assignment, EmergencyAudit, EmergencyInvitation } from '../src/models.js';
import { toInstant } from '../src/catalog.js';
import { activityPayload, createFaculty, createVolunteer, eventPayload, loginAs, useTestApp } from './helpers.js';

const t = useTestApp('emergency-discovery');

async function emergencySetup(specialistSkills: string[] = []) {
  const faculty = await createFaculty(t.app);
  const manager = await loginAs(t.app, faculty.username, 'faculty');
  const event = (await manager.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
  await manager.put(`/api/manage/events/${event.id}/location`).send({ venueAddress: 'Main Block', latitude: 12.9716, longitude: 77.5946 }).expect(200);
  const activity = (await manager.post(`/api/manage/events/${event.id}/activities`).send(activityPayload()).expect(201)).body.activity;
  const request = (await manager.post(`/api/manage/events/${event.id}/emergency-requests`).send({
    activityId: activity.id,
    description: 'Urgent help coordinating registration arrivals.',
    instructions: 'Meet at the main entrance.',
    requiredCount: 1,
    radiusKm: 3,
    urgency: 'high',
    specialistSkills,
  }).expect(201)).body.request;
  return { manager, event, activity, request };
}

async function optInAndShare(student: Awaited<ReturnType<typeof createVolunteer>>) {
  await student.agent.put('/api/student/location-preferences').send({ emergencyDiscoveryEnabled: true }).expect(200);
  const session = (await student.agent.post('/api/student/location-sharing/start').send({}).expect(201)).body.session;
  await student.agent.patch(`/api/student/location-sharing/${session.sessionId}`).send({
    latitude: 12.9717,
    longitude: 77.5947,
    accuracyMeters: 22,
    capturedAt: Date.now(),
  }).expect(200);
}

describe('emergency volunteer discovery', () => {
  it('keeps nearby candidates awaiting confirmation and confirms a real assignment only after acceptance', async () => {
    const { manager, event, request: emergencyRequest } = await emergencySetup();
    const student = await createVolunteer(t.app, { skills: ['Painting'] });
    await optInAndShare(student);

    const found = await manager.get(`/api/manage/emergency-requests/${emergencyRequest.id}/candidates`).expect(200);
    expect(found.body.candidates).toHaveLength(1);
    expect(found.body.candidates[0]).toMatchObject({ displayName: expect.any(String), availabilityStatus: 'AWAITING_CONFIRMATION' });
    expect(found.body.candidates[0]).not.toHaveProperty('usn');
    expect(found.body.candidates[0].distanceMeters).toBeLessThan(100);

    await manager.post(`/api/manage/emergency-requests/${emergencyRequest.id}/invitations`).send({ studentIds: [student.id] }).expect(201);
    const inbox = await student.agent.get('/api/student/emergency-invitations').expect(200);
    expect(inbox.body.invitations).toHaveLength(1);
    expect(inbox.body.invitations[0].request.description).toContain('Urgent help');
    expect(inbox.body.invitations[0].event.venueLocation).toMatchObject({ latitude: 12.9716, longitude: 77.5946 });

    const response = await student.agent.post(`/api/student/emergency-invitations/${inbox.body.invitations[0].id}/respond`).send({ response: 'accept' }).expect(200);
    expect(response.body).toMatchObject({ status: 'accepted', requestStatus: 'filled' });
    const assigned = await Assignment.find({ emergencyRequestId: emergencyRequest.id }).lean();
    expect(assigned).toHaveLength(1);
    expect(assigned[0].status).toBe('confirmed');
    expect(await EmergencyInvitation.countDocuments({ requestId: emergencyRequest.id, status: 'accepted' })).toBe(1);
    expect(await EmergencyAudit.exists({ requestId: emergencyRequest.id, action: 'accepted' })).toBeTruthy();
    const liveMap = await manager.get(`/api/manage/events/${event.id}/live-locations`).expect(200);
    expect(liveMap.body.locations).toHaveLength(1);
    expect(liveMap.body.locations[0].position).toContain('Emergency support');

    const requests = await manager.get(`/api/manage/events/${event.id}/emergency-requests`).expect(200);
    expect(requests.body.requests[0]).toMatchObject({ status: 'filled', acceptedCount: 1 });
  });

  it('does not return students who have not opted into emergency discovery', async () => {
    const { manager, request } = await emergencySetup();
    const student = await createVolunteer(t.app);
    const session = (await student.agent.post('/api/student/location-sharing/start').send({}).expect(403));
    expect(session.status).toBe(403);
    const found = await manager.get(`/api/manage/emergency-requests/${request.id}/candidates`).expect(200);
    expect(found.body.candidates).toEqual([]);
  });

  it('prevents duplicate invitations and declining never creates an assignment', async () => {
    const { manager, request } = await emergencySetup();
    const student = await createVolunteer(t.app);
    await optInAndShare(student);
    await manager.post(`/api/manage/emergency-requests/${request.id}/invitations`).send({ studentIds: [student.id] }).expect(201);
    await manager.post(`/api/manage/emergency-requests/${request.id}/invitations`).send({ studentIds: [student.id] }).expect(409);
    const inbox = await student.agent.get('/api/student/emergency-invitations').expect(200);
    await student.agent.post(`/api/student/emergency-invitations/${inbox.body.invitations[0].id}/respond`).send({ response: 'decline' }).expect(200);
    expect(await Assignment.countDocuments({ emergencyRequestId: request.id })).toBe(0);
  });

  it('reports invitation state, permits only larger radius changes, and cancels invites after opt-out', async () => {
    const { manager, request } = await emergencySetup();
    const student = await createVolunteer(t.app);
    await optInAndShare(student);
    await manager.post(`/api/manage/emergency-requests/${request.id}/invitations`).send({ studentIds: [student.id] }).expect(201);

    const expanded = await manager.patch(`/api/manage/emergency-requests/${request.id}/radius`).send({ radiusKm: 5 }).expect(200);
    expect(expanded.body.radiusMeters).toBe(5000);
    await manager.patch(`/api/manage/emergency-requests/${request.id}/radius`).send({ radiusKm: 1 }).expect(400);

    const sent = await manager.get(`/api/manage/emergency-requests/${request.id}/invitations`).expect(200);
    expect(sent.body.invitations[0]).toMatchObject({ displayName: expect.any(String), status: 'pending' });
    await student.agent.put('/api/student/location-preferences').send({ emergencyDiscoveryEnabled: false }).expect(200);
    const afterOptOut = await manager.get(`/api/manage/emergency-requests/${request.id}/invitations`).expect(200);
    expect(afterOptOut.body.invitations[0].status).toBe('cancelled');
    expect((await student.agent.get('/api/student/emergency-invitations').expect(200)).body.invitations).toHaveLength(0);
  });

  it('allows general help without normal role skills but enforces specialist requirements', async () => {
    const general = await emergencySetup();
    const helper = await createVolunteer(t.app, { skills: ['Painting'] });
    await optInAndShare(helper);
    const generalCandidates = await general.manager.get(`/api/manage/emergency-requests/${general.request.id}/candidates`).expect(200);
    expect(generalCandidates.body.candidates.map((candidate: { studentId: string }) => candidate.studentId)).toContain(helper.id);

    const specialist = await emergencySetup(['First Aid']);
    const unqualified = await createVolunteer(t.app, { skills: ['Painting'] });
    await optInAndShare(unqualified);
    const specialistCandidates = await specialist.manager.get(`/api/manage/emergency-requests/${specialist.request.id}/candidates`).expect(200);
    expect(specialistCandidates.body.candidates).toEqual([]);
    await specialist.manager.post(`/api/manage/emergency-requests/${specialist.request.id}/invitations`).send({ studentIds: [unqualified.id] }).expect(409);
  });

  it('excludes volunteers with known schedule conflicts', async () => {
    const { manager, event, request: emergencyRequest } = await emergencySetup();
    const volunteer = await createVolunteer(t.app, { skills: ['Painting'] });
    await optInAndShare(volunteer);
    const conflictActivity = await Activity.create({
      eventId: event.id,
      name: 'Existing duty',
      date: activityPayload().date,
      startTime: '09:30',
      endTime: '10:30',
      startAt: toInstant(activityPayload().date, '09:30', 330),
      endAt: toInstant(activityPayload().date, '10:30', 330),
      location: 'Hall B',
      requiredCount: 1,
    });
    await Assignment.create({ eventId: event.id, activityId: conflictActivity._id, studentId: volunteer.id, status: 'confirmed', source: 'manual', createdBy: event.createdBy });
    const candidates = await manager.get(`/api/manage/emergency-requests/${emergencyRequest.id}/candidates`).expect(200);
    expect(candidates.body.candidates).toEqual([]);
  });

  it('never exceeds emergency headcount when multiple volunteers accept concurrently', async () => {
    const { manager, request } = await emergencySetup();
    const first = await createVolunteer(t.app, { skills: ['Painting'] });
    const second = await createVolunteer(t.app, { skills: ['Painting'] });
    await Promise.all([optInAndShare(first), optInAndShare(second)]);
    await manager.post(`/api/manage/emergency-requests/${request.id}/invitations`).send({ studentIds: [first.id, second.id] }).expect(201);
    const [firstInbox, secondInbox] = await Promise.all([
      first.agent.get('/api/student/emergency-invitations').expect(200),
      second.agent.get('/api/student/emergency-invitations').expect(200),
    ]);
    const responses = await Promise.all([
      first.agent.post(`/api/student/emergency-invitations/${firstInbox.body.invitations[0].id}/respond`).send({ response: 'accept' }),
      second.agent.post(`/api/student/emergency-invitations/${secondInbox.body.invitations[0].id}/respond`).send({ response: 'accept' }),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(await Assignment.countDocuments({ emergencyRequestId: request.id, status: 'confirmed' })).toBe(1);
  });
});
