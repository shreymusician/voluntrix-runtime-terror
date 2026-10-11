import type { ClientSession, Types } from 'mongoose';
import { hoursBetween, skillKey, toMinutes } from '../catalog.js';
import { ACTIVE_ASSIGNMENT_STATUSES } from '../domain.js';
import { Activity, Assignment, PerformanceEvaluation, StudentProfile, User, type ActivityDoc, type EventDoc, type UserDoc } from '../models.js';
import { loadQualifyingResults } from './tests.js';

/** An upcoming seat the volunteer currently holds (pending or confirmed). */
export interface LiveSeat {
  assignmentId: string;
  activityId: string;
  activityName: string;
  date: string;
  startAt: Date;
  endAt: Date;
  status: string;
}

export interface Volunteer {
  id: string;
  user: UserDoc;
  usn: string;
  department: string | null;
  semester: number | null;
  skills: string[];
  skillKeys: Set<string>;
  preferences: string[];
  availability: { date: string; startTime: string; endTime: string }[];
  maxHoursPerDay: number | null;
  profileComplete: boolean;
  seats: LiveSeat[];
  /** Past activities the volunteer is recorded as having attended. */
  attendedCount: number;
  /** Qualifying mock-test result per activity category. */
  tests: Map<string, { percent: number; passed: boolean }>;
  /** Post-event performance evaluations: how many, and their average overall rating (1-5). */
  history: { count: number; average: number | null };
}

export interface Violation {
  code:
    | 'NOT_ACTIVE_STUDENT'
    | 'PROFILE_INCOMPLETE'
    | 'MISSING_SKILL'
    | 'EXPERIENCE'
    | 'UNAVAILABLE'
    | 'TIME_CONFLICT'
    | 'HOURS_EXCEEDED'
    | 'ALREADY_ASSIGNED'
    | 'TEST_REQUIRED';
  message: string;
}

/** The slice of an activity the rules need; lets allocation test hypothetical seats too. */
export type ActivityLike = Pick<
  ActivityDoc,
  'name' | 'date' | 'startTime' | 'endTime' | 'startAt' | 'endAt' | 'requiredSkills' | 'requiredSkillKeys' | 'minPriorEvents' | 'activityType' | 'requireTestPass'
> & { _id: Types.ObjectId };

/**
 * Loads volunteers with everything the hard constraints depend on. Pass
 * `studentIds` to load specific people (whatever their role or status, so
 * the checks can explain why they are not eligible), or nothing for every
 * active student.
 */
export async function loadVolunteers(
  options: { studentIds?: (Types.ObjectId | string)[]; session?: ClientSession } = {},
): Promise<Map<string, Volunteer>> {
  const session = options.session ?? null;
  const users = await User.find(options.studentIds ? { _id: { $in: options.studentIds } } : { role: 'student', accountStatus: 'active' }).session(session);
  const ids = users.map((u) => u._id);

  const [profiles, live, attended, evaluations, testResults] = await Promise.all([
    StudentProfile.find({ userId: { $in: ids } }).session(session),
    Assignment.find({ studentId: { $in: ids }, status: { $in: ACTIVE_ASSIGNMENT_STATUSES } }).session(session),
    Assignment.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { studentId: { $in: ids }, status: 'confirmed', attendance: 'attended' } },
      { $group: { _id: '$studentId', count: { $sum: 1 } } },
    ]).session(session),
    PerformanceEvaluation.aggregate<{ _id: Types.ObjectId; count: number; average: number }>([
      { $match: { studentId: { $in: ids } } },
      { $group: { _id: '$studentId', count: { $sum: 1 }, average: { $avg: '$overall' } } },
    ]).session(session),
    loadQualifyingResults({ studentIds: ids }),
  ]);
  const historyByUser = new Map(evaluations.map((e) => [String(e._id), { count: e.count, average: e.average }]));
  const activities = await Activity.find({ _id: { $in: live.map((a) => a.activityId) } }).session(session);
  const activityById = new Map(activities.map((a) => [a.id as string, a]));
  const profileByUser = new Map(profiles.map((p) => [String(p.userId), p]));
  const attendedByUser = new Map(attended.map((a) => [String(a._id), a.count]));

  const now = new Date();
  const volunteers = new Map<string, Volunteer>();
  for (const user of users) {
    const profile = profileByUser.get(user.id as string);
    if (!profile) continue; // not a student account
    volunteers.set(user.id as string, {
      id: user.id as string,
      user,
      usn: profile.usn,
      department: profile.department ?? null,
      semester: profile.semester ?? null,
      skills: profile.skills,
      // Derived from the skill *names*, which are the source of truth, and
      // unioned with the denormalised `skillKeys`. A profile written before
      // `skillKeys` existed (or imported/seeded without it) would otherwise
      // match nothing and the student would be told they lack skills they
      // have listed. `skillKey` is idempotent, so re-keying stored keys is safe.
      skillKeys: new Set([...profile.skills, ...profile.skillKeys].map(skillKey)),
      preferences: profile.preferences,
      availability: profile.availability.map((s) => ({ date: s.date!, startTime: s.startTime!, endTime: s.endTime! })),
      maxHoursPerDay: profile.maxHoursPerDay ?? null,
      profileComplete: Boolean(profile.profileCompletedAt),
      seats: [],
      attendedCount: attendedByUser.get(user.id as string) ?? 0,
      tests: new Map(),
      history: historyByUser.get(user.id as string) ?? { count: 0, average: null },
    });
  }
  for (const result of testResults.values()) {
    volunteers.get(result.studentId)?.tests.set(result.category, { percent: result.percent, passed: result.passed });
  }
  for (const assignment of live) {
    const activity = activityById.get(String(assignment.activityId));
    const volunteer = volunteers.get(String(assignment.studentId));
    // Finished activities are history: they no longer occupy time or count as workload.
    if (!activity || !volunteer || activity.endAt <= now) continue;
    volunteer.seats.push({
      assignmentId: assignment.id as string,
      activityId: activity.id as string,
      activityName: activity.name,
      date: activity.date,
      startAt: activity.startAt,
      endAt: activity.endAt,
      status: assignment.status,
    });
  }
  return volunteers;
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

/**
 * The volunteer's availability on one date as maximal `[fromMinute, toMinute]`
 * intervals, with touching and overlapping slots merged. Students commonly
 * enter their free time in several consecutive blocks; without merging, an
 * activity spanning two of them would wrongly count as unavailable.
 */
export function availableIntervalsOn(volunteer: Volunteer, date: string): [number, number][] {
  const ranges = volunteer.availability
    .filter((s) => s.date === date)
    .map((s) => [toMinutes(s.startTime), toMinutes(s.endTime)] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const [from, to] of ranges) {
    const last = merged[merged.length - 1];
    // `from <= last[1]` merges touching blocks (11:00 start after a 11:00 end) too.
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Hours the volunteer is already committed to on a given date. */
export function hoursOn(volunteer: Volunteer, date: string, ignoreAssignmentId?: string): number {
  return volunteer.seats
    .filter((s) => s.date === date && s.assignmentId !== ignoreAssignmentId)
    .reduce((sum, s) => sum + hoursBetween(s.startAt, s.endAt), 0);
}

/**
 * The mandatory rules for putting one volunteer on one activity. Automatic
 * allocation and confirmation use every rule; student requests may defer only
 * missing skills until confirmation. Scores are never consulted here.
 *
 * `ignoreAssignmentId` excludes the assignment being re-checked from the
 * volunteer's own seats. `excludeCodes` drops specific violation codes from
 * the result afterwards — used to ask "is everything but the mock test in
 * order?" when deciding whether to unlock that test in the first place.
 */
export function checkVolunteer(volunteer: Volunteer, activity: ActivityLike, ignoreAssignmentId?: string, excludeCodes?: Violation['code'][]): Violation[] {
  const violations = checkVolunteerAll(volunteer, activity, ignoreAssignmentId);
  return excludeCodes?.length ? violations.filter((v) => !excludeCodes.includes(v.code)) : violations;
}

function checkVolunteerAll(volunteer: Volunteer, activity: ActivityLike, ignoreAssignmentId?: string): Violation[] {
  const violations: Violation[] = [];
  const add = (code: Violation['code'], message: string) => violations.push({ code, message });

  if (volunteer.user.role !== 'student' || volunteer.user.accountStatus !== 'active') {
    add('NOT_ACTIVE_STUDENT', 'Not an active student account');
    return violations;
  }
  if (!volunteer.profileComplete) {
    add('PROFILE_INCOMPLETE', 'Volunteer profile is not complete');
    return violations;
  }

  const start = toMinutes(activity.startTime);
  const end = toMinutes(activity.endTime);
  // Availability is the first gate: only after a full time-window match do
  // skill gaps become relevant to allocation or student requests.
  const covered = availableIntervalsOn(volunteer, activity.date).some(([from, to]) => from <= start && to >= end);
  if (!covered) add('UNAVAILABLE', `Not available on ${activity.date} from ${activity.startTime} to ${activity.endTime}`);

  // Keyed from each required skill's own name rather than by index into the
  // denormalised `requiredSkillKeys`. That array can be shorter, stale or
  // absent on activities written outside `parseActivity` (seeds, imports,
  // older records); indexing into it then yields `undefined`, which matches
  // nothing and reports *every* required skill as missing.
  const missing = activity.requiredSkills.filter((name) => !volunteer.skillKeys.has(skillKey(name)));
  if (missing.length) add('MISSING_SKILL', `Missing required skill${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);

  const needed = activity.minPriorEvents ?? 0;
  if (volunteer.attendedCount < needed) {
    add('EXPERIENCE', `Needs ${needed} attended activit${needed === 1 ? 'y' : 'ies'}, has ${volunteer.attendedCount}`);
  }

  // An activity can demand a passed mock test in its category. Like every
  // rule here it is pass/fail; a high score elsewhere cannot stand in for it.
  if (activity.requireTestPass && activity.activityType) {
    const test = volunteer.tests.get(activity.activityType);
    if (!test) add('TEST_REQUIRED', `Has not taken the ${activity.activityType} mock test`);
    else if (!test.passed) add('TEST_REQUIRED', `Did not pass the ${activity.activityType} mock test (${test.percent}%)`);
  }

  const activityId = String(activity._id);
  const others = volunteer.seats.filter((s) => s.assignmentId !== ignoreAssignmentId);
  if (others.some((s) => s.activityId === activityId)) add('ALREADY_ASSIGNED', 'Already assigned to this activity');
  const clash = others.find((s) => s.activityId !== activityId && overlaps(s.startAt, s.endAt, activity.startAt, activity.endAt));
  if (clash) add('TIME_CONFLICT', `Overlaps with "${clash.activityName}" (${clash.status})`);

  if (volunteer.maxHoursPerDay !== null) {
    const total = hoursOn(volunteer, activity.date, ignoreAssignmentId) + hoursBetween(activity.startAt, activity.endAt);
    if (total > volunteer.maxHoursPerDay + 1e-9) {
      add('HOURS_EXCEEDED', `Would total ${formatHours(total)} on ${activity.date}; limit is ${formatHours(volunteer.maxHoursPerDay)}`);
    }
  }
  return violations;
}

/** Whether a student may request organizer review despite missing required skills. */
export function canSubmitSkillGapRequest(violations: Violation[]): boolean {
  return violations.every((violation) => violation.code === 'MISSING_SKILL');
}

export const formatHours = (h: number) => `${Math.round(h * 100) / 100} h`;

/** Why new seats cannot be created on this activity right now, if anything. */
export function activityBlocker(activity: ActivityDoc, event: EventDoc, now = new Date()): string | null {
  if (event.status === 'cancelled' || event.status === 'completed') return `The event is ${event.status}`;
  if (activity.status !== 'open') return `The activity is ${activity.status}`;
  if (activity.endAt <= now) return 'The activity has already ended';
  return null;
}
