import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createFaculty, createStudent, createVolunteer, dayFromNow, eventPayload, loginAs, useTestApp } from './helpers.js';
import { Event } from '../src/models.js';

const t = useTestApp('event-map');

describe('event map finder', () => {
  it('lets an organizer save a venue point and a completed volunteer read it', async () => {
    const faculty = await createFaculty(t.app);
    const manager = await loginAs(t.app, faculty.username, 'faculty');
    const created = await manager.post('/api/manage/events').send(eventPayload()).expect(201);

    await manager.put(`/api/manage/events/${created.body.event.id}/location`)
      .send({ venueAddress: 'Main Block, Room 204', latitude: 12.9716, longitude: 77.5946 })
      .expect(200);

    const volunteer = await createVolunteer(t.app);
    const map = await volunteer.agent.get(`/api/student/events/${created.body.event.id}/map`).expect(200);
    expect(map.body.event).toMatchObject({
      id: created.body.event.id,
      venue: 'Main Campus',
      venueAddress: 'Main Block, Room 204',
      venueLocation: { latitude: 12.9716, longitude: 77.5946 },
    });

    const stored = await Event.findById(created.body.event.id).lean();
    expect(stored?.venueLocation?.coordinates).toEqual([77.5946, 12.9716]);
  });

  it('does not expose map details to anonymous or incomplete student accounts', async () => {
    const faculty = await createFaculty(t.app);
    const manager = await loginAs(t.app, faculty.username, 'faculty');
    const created = await manager.post('/api/manage/events').send(eventPayload()).expect(201);
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');

    await request(t.app).get(`/api/student/events/${created.body.event.id}/map`).expect(401);
    await agent.get(`/api/student/events/${created.body.event.id}/map`).expect(403);
  });

  it('does not show unpublished events and rejects invalid coordinates', async () => {
    const faculty = await createFaculty(t.app);
    const manager = await loginAs(t.app, faculty.username, 'faculty');
    const created = await manager.post('/api/manage/events').send(eventPayload({ status: 'draft' })).expect(201);
    const student = await createVolunteer(t.app);

    await student.agent.get(`/api/student/events/${created.body.event.id}/map`).expect(404);
    await manager.put(`/api/manage/events/${created.body.event.id}/location`)
      .send({ venueAddress: '', latitude: 91, longitude: 181 })
      .expect(400);
    const stored = await Event.findById(created.body.event.id).lean();
    expect(stored?.venueLocation).toBeNull();
  });

  it('does not invent coordinates when an event has only a venue description', async () => {
    const faculty = await createFaculty(t.app);
    const manager = await loginAs(t.app, faculty.username, 'faculty');
    const created = await manager.post('/api/manage/events').send(eventPayload({ startDate: dayFromNow(3), endDate: dayFromNow(3) })).expect(201);
    const volunteer = await createVolunteer(t.app);

    const map = await volunteer.agent.get(`/api/student/events/${created.body.event.id}/map`).expect(200);
    expect(map.body.event.venueLocation).toBeNull();
  });
});
