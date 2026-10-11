import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createFaculty, createVolunteer, activityPayload, eventPayload, loginAs, useTestApp } from './helpers.js';

const t = useTestApp('location-sharing');

async function setupAssignedVolunteer() {
  const faculty = await createFaculty(t.app);
  const organizer = await loginAs(t.app, faculty.username, 'faculty');
  const event = (await organizer.post('/api/manage/events').send(eventPayload()).expect(201)).body.event;
  const activity = (await organizer.post(`/api/manage/events/${event.id}/activities`).send(activityPayload()).expect(201)).body.activity;
  const volunteer = await createVolunteer(t.app);
  const assignment = (await volunteer.agent.post(`/api/student/activities/${activity.id}/apply`).send({}).expect(201)).body.assignment;
  await organizer.post(`/api/manage/assignments/${assignment.id}/confirm`).send({}).expect(200);
  return { organizer, event, activity, volunteer };
}

describe('consented location sharing', () => {
  it('requires a confirmed assignment, accepts real coordinates, and limits map data to authorized managers', async () => {
    const { organizer, event, activity, volunteer } = await setupAssignedVolunteer();
    const started = await volunteer.agent.post('/api/student/location-sharing/start').send({ eventId: event.id }).expect(201);
    const sessionId = started.body.session.sessionId as string;

    await volunteer.agent.patch(`/api/student/location-sharing/${sessionId}`).send({ latitude: 12.9716, longitude: 77.5946, accuracyMeters: 18, capturedAt: Date.now() }).expect(200);
    const live = await organizer.get(`/api/manage/events/${event.id}/live-locations`).expect(200);
    expect(live.body.locations).toHaveLength(1);
    expect(live.body.locations[0]).toMatchObject({
      displayName: volunteer.username.replace('student', 'Student '),
      position: activity.name,
      assignmentStatus: 'confirmed',
      latitude: 12.972,
      longitude: 77.595,
      accuracyMeters: 18,
    });
    expect(live.body.locations[0]).not.toHaveProperty('usn');
    expect(JSON.stringify(live.body.locations[0])).not.toContain(volunteer.usn);

    await volunteer.agent.delete(`/api/student/location-sharing/${sessionId}`).expect(200);
    await volunteer.agent.patch(`/api/student/location-sharing/${sessionId}`).send({ latitude: 12.9, longitude: 77.5, accuracyMeters: 20, capturedAt: Date.now() }).expect(404);
    expect((await organizer.get(`/api/manage/events/${event.id}/live-locations`).expect(200)).body.locations).toHaveLength(0);
  });

  it('requires emergency discovery opt-in before starting a general emergency-scoped session', async () => {
    const volunteer = await createVolunteer(t.app);
    expect((await volunteer.agent.get('/api/student/location-preferences').expect(200)).body.emergencyDiscoveryEnabled).toBe(false);
    await volunteer.agent.post('/api/student/location-sharing/start').send({}).expect(403);

    await volunteer.agent.put('/api/student/location-preferences').send({ emergencyDiscoveryEnabled: true }).expect(200);
    const session = await volunteer.agent.post('/api/student/location-sharing/start').send({}).expect(201);
    expect(session.body.session).toMatchObject({ scope: 'emergency', eventId: null });

    await volunteer.agent.put('/api/student/location-preferences').send({ emergencyDiscoveryEnabled: false }).expect(200);
    expect((await volunteer.agent.get('/api/student/location-sharing').expect(200)).body.session).toBeNull();
  });

  it('rejects invalid coordinates, anonymous updates, and non-assigned students', async () => {
    const { event, volunteer } = await setupAssignedVolunteer();
    const sessionId = (await volunteer.agent.post('/api/student/location-sharing/start').send({ eventId: event.id }).expect(201)).body.session.sessionId;
    await volunteer.agent.patch(`/api/student/location-sharing/${sessionId}`).send({ latitude: 91, longitude: 0, accuracyMeters: 1, capturedAt: Date.now() }).expect(400);
    await volunteer.agent.patch(`/api/student/location-sharing/${sessionId}`).send({ latitude: 12, longitude: 77, accuracyMeters: 1, capturedAt: Date.now() - 120_000 }).expect(400);
    await request(t.app).patch(`/api/student/location-sharing/${sessionId}`).send({ latitude: 12, longitude: 77, accuracyMeters: 1, capturedAt: Date.now() }).expect(401);
    const stranger = await createVolunteer(t.app);
    await stranger.agent.post('/api/student/location-sharing/start').send({ eventId: event.id }).expect(403);
  });
});
