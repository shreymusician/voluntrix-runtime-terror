import { describe, expect, it } from 'vitest';
import { createFaculty, createStudent, loginAs, useTestApp } from './helpers.js';

const t = useTestApp('chat');

describe('in-app chat', () => {
  it('creates a direct thread and allows messages between users', async () => {
    const { app } = t;
    const student = await createStudent(app);
    const faculty = await createFaculty(app);

    const studentAgent = await loginAs(app, student.username, 'student');
    const createRes = await studentAgent.post('/api/chats').send({ participantId: faculty.id });
    expect(createRes.status).toBe(201);
    expect(createRes.body.thread).toBeTruthy();
    expect(createRes.body.thread.participants).toHaveLength(2);

    const threadId = createRes.body.thread.id;
    const sendRes = await studentAgent.post(`/api/chats/${threadId}/messages`).send({ content: 'Hello faculty, can we discuss the event schedule?' });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.message.content).toBe('Hello faculty, can we discuss the event schedule?');

    const listRes = await studentAgent.get('/api/chats');
    expect(listRes.status).toBe(200);
    expect(listRes.body.threads.length).toBeGreaterThanOrEqual(1);

    const messagesRes = await studentAgent.get(`/api/chats/${threadId}/messages`);
    expect(messagesRes.status).toBe(200);
    expect(messagesRes.body.messages[0].content).toContain('event schedule');

    const facultyAgent = await loginAs(app, faculty.username, 'faculty');
    const facultyMessagesRes = await facultyAgent.get(`/api/chats/${threadId}/messages`);
    expect(facultyMessagesRes.status).toBe(200);
    expect(facultyMessagesRes.body.messages[0].content).toContain('event schedule');
  });

  it('prevents users from creating a thread with themselves', async () => {
    const { app } = t;
    const student = await createStudent(app);
    const agent = await loginAs(app, student.username, 'student');

    const res = await agent.post('/api/chats').send({ participantId: student.id });
    expect(res.status).toBe(400);
  });
});
