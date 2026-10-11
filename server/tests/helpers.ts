import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { createApp } from '../src/app.js';
import { LocalAuthProvider } from '../src/auth/provider.js';
import { loadConfig } from '../src/config/env.js';
import { defaultPromotionPolicy, type PromotionPolicy } from '../src/config/promotionPolicy.js';
import type { AppContext } from '../src/context.js';
import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { localToday, toInstant } from '../src/catalog.js';
import { EVALUATION_CRITERIA } from '../src/domain.js';
import { Activity, Assignment, Event, PerformanceEvaluation, User } from '../src/models.js';
import { MemoryPhotoStorage } from '../src/storage/photoStorage.js';

export const PASSWORD = 'Passw0rd!x';

/** Boots the real app against a fresh database for the calling test file. */
export function useTestApp(dbName: string) {
  const ctx: AppContext = {
    config: { ...loadConfig(), nodeEnv: 'test', isProduction: false, facultyEmailDomains: ['college.edu'], facultyIdAllowlist: [], utcOffsetMinutes: 330, maxHoursPerDayLimit: 12, maxSkills: 15 },
    auth: new LocalAuthProvider(4),
    storage: new MemoryPhotoStorage(),
    policy: { ...defaultPromotionPolicy },
    rateLimits: { enabled: false, authMax: 5, sensitiveMax: 5 },
  };
  const state = { ctx, app: createApp(ctx) };

  beforeAll(async () => {
    const base = new URL(inject('mongoBaseUri'));
    base.pathname = `/${dbName}`;
    await connectDatabase(base.toString());
  });
  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
    ctx.policy = { ...defaultPromotionPolicy };
    ctx.rateLimits.enabled = false;
    state.app = createApp(ctx);
  });
  afterAll(disconnectDatabase);

  return state;
}

type App = ReturnType<typeof createApp>;
let counter = 0;

export function studentPayload(overrides: Record<string, unknown> = {}) {
  const n = ++counter;
  return {
    fullName: `Student ${n}`,
    usn: `1VX22CS${String(n).padStart(3, '0')}`,
    email: `student${n}@example.com`,
    phone: '9876543210',
    username: `student${n}`,
    password: PASSWORD,
    confirmPassword: PASSWORD,
    ...overrides,
  };
}

export function facultyPayload(overrides: Record<string, unknown> = {}) {
  const n = ++counter;
  return {
    fullName: `Faculty ${n}`,
    facultyId: `FAC-${1000 + n}`,
    email: `faculty${n}@college.edu`,
    phone: '9876543211',
    username: `faculty${n}`,
    password: PASSWORD,
    confirmPassword: PASSWORD,
    ...overrides,
  };
}

/** Logs in and returns an agent that carries the session cookie. */
export async function loginAs(app: App, username: string, role: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password, role });
  if (res.status !== 200) throw new Error(`login as ${role} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function createStudent(app: App, overrides: Record<string, unknown> = {}) {
  const payload = studentPayload(overrides);
  const res = await request(app).post('/api/auth/register/student').send(payload);
  if (res.status !== 201) throw new Error(`student registration failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id as string, username: payload.username as string, usn: payload.usn as string };
}

/** Registers a faculty account (active immediately; there is no approval step). */
export async function createFaculty(app: App, overrides: Record<string, unknown> = {}) {
  const payload = facultyPayload(overrides);
  const res = await request(app).post('/api/auth/register/faculty').send(payload);
  if (res.status !== 201) throw new Error(`faculty registration failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id as string, username: payload.username as string };
}

/** A calendar date `days` from today at the institution (negative = past). */
export const dayFromNow = (days: number) => localToday(330, Date.now() + days * 86_400_000);

/**
 * Writes a finished, confirmed assignment straight into the database (the
 * API rightly refuses to create assignments in the past), optionally with
 * recorded attendance and a performance evaluation with the given rating.
 */
export async function addAttendance(studentId: string, status: 'attended' | 'absent' | null = 'attended', rating?: number) {
  const n = ++counter;
  const owner = (await User.findOne({ role: 'faculty' })) ?? (await User.findById(studentId))!;
  const date = dayFromNow(-(n % 300) - 2);
  const event = await Event.create({ name: `[TEST] Past event ${n}`, startDate: date, endDate: date, venue: 'Hall', status: 'completed', createdBy: owner._id, isSampleData: true });
  const activity = await Activity.create({
    eventId: event._id,
    name: 'Helper',
    date,
    startTime: '10:00',
    endTime: '12:00',
    startAt: toInstant(date, '10:00', 330),
    endAt: toInstant(date, '12:00', 330),
    location: 'Hall',
    requiredCount: 5,
  });
  const assignment = await Assignment.create({ eventId: event._id, activityId: activity._id, studentId, status: 'confirmed', source: 'manual', createdBy: owner._id, attendance: status });
  if (rating !== undefined) {
    await PerformanceEvaluation.create({
      assignmentId: assignment._id,
      studentId,
      eventId: event._id,
      activityId: activity._id,
      reviewerId: owner._id,
      criteria: Object.fromEntries(EVALUATION_CRITERIA.map((c) => [c, rating])),
      overall: rating,
    });
  }
  return assignment;
}

export interface VolunteerOptions {
  skills?: string[];
  preferences?: string[];
  availability?: { date: string; startTime: string; endTime: string }[];
  maxHoursPerDay?: number;
}

export const profilePayload = (options: VolunteerOptions = {}) => ({
  department: 'Computer Science & Engineering',
  semester: 4,
  skills: options.skills ?? ['Communication'],
  preferences: options.preferences ?? [],
  availability: options.availability ?? [{ date: dayFromNow(5), startTime: '08:00', endTime: '18:00' }],
  maxHoursPerDay: options.maxHoursPerDay ?? 8,
  finalize: true,
});

/** Registers a student and completes their volunteer profile through the API. */
export async function createVolunteer(app: App, options: VolunteerOptions = {}) {
  const student = await createStudent(app);
  const agent = await loginAs(app, student.username, 'student');
  const res = await agent.put('/api/volunteer-profile').send(profilePayload(options));
  if (res.status !== 200) throw new Error(`profile setup failed: ${JSON.stringify(res.body)}`);
  return { ...student, agent };
}

export const eventPayload = (overrides: Record<string, unknown> = {}) => ({
  name: 'Tech Fest',
  description: 'Annual fest',
  startDate: dayFromNow(5),
  endDate: dayFromNow(6),
  venue: 'Main Campus',
  status: 'published',
  ...overrides,
});

export const activityPayload = (overrides: Record<string, unknown> = {}) => ({
  name: 'Registration Desk',
  date: dayFromNow(5),
  startTime: '09:00',
  endTime: '11:00',
  location: 'Front Gate',
  requiredSkills: ['Communication'],
  requiredCount: 2,
  ...overrides,
});

// 1x1 transparent PNG.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
