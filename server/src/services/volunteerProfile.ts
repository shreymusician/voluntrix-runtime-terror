import { z } from 'zod';
import {
  ACTIVITY_TYPES,
  DEPARTMENTS,
  MAX_AVAILABILITY_SLOTS,
  SEMESTERS,
  isValidDate,
  isValidTime,
  localToday,
  normalizeActivityType,
  normalizeSkills,
  skillKey,
  toMinutes,
} from '../catalog.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden } from '../errors.js';
import { StudentProfile, type StudentProfileDoc, type UserDoc } from '../models.js';

export interface AvailabilitySlot {
  date: string;
  startTime: string;
  endTime: string;
}

// Shape only; the meaning of each field is validated below so that every
// problem can be reported against the field it belongs to.
const inputSchema = z
  .object({
    fullName: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    department: z.string().optional(),
    semester: z.number().optional(),
    skills: z.array(z.unknown()).optional(),
    preferences: z.array(z.unknown()).optional(),
    availability: z.array(z.unknown()).optional(),
    maxHoursPerDay: z.number().optional(),
    finalize: z.boolean().optional(),
  })
  .strict();

const slotId = (s: AvailabilitySlot) => `${s.date}|${s.startTime}|${s.endTime}`;

function validateAvailability(input: unknown[], stored: AvailabilitySlot[], today: string): { slots: AvailabilitySlot[]; error?: string } {
  if (input.length > MAX_AVAILABILITY_SLOTS) return { slots: [], error: `You can add at most ${MAX_AVAILABILITY_SLOTS} availability slots` };
  const alreadySaved = new Set(stored.map(slotId));
  const slots: AvailabilitySlot[] = [];

  for (const [i, raw] of input.entries()) {
    const label = `Slot ${i + 1}`;
    const slot = raw as Partial<AvailabilitySlot> | null;
    if (!slot || typeof slot !== 'object') return { slots: [], error: `${label} is not valid` };
    if (!isValidDate(slot.date)) return { slots: [], error: `${label}: choose a valid date` };
    if (!isValidTime(slot.startTime) || !isValidTime(slot.endTime)) return { slots: [], error: `${label}: choose a valid start and end time` };
    if (toMinutes(slot.startTime) >= toMinutes(slot.endTime)) return { slots: [], error: `${label}: the start time must be earlier than the end time` };
    const clean = { date: slot.date, startTime: slot.startTime, endTime: slot.endTime };
    // Slots saved earlier may have slipped into the past; only new ones must be upcoming.
    if (clean.date < today && !alreadySaved.has(slotId(clean))) return { slots: [], error: `${label}: the date ${clean.date} is in the past` };
    slots.push(clean);
  }

  slots.sort((a, b) => a.date.localeCompare(b.date) || toMinutes(a.startTime) - toMinutes(b.startTime));
  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1];
    const cur = slots[i];
    if (prev.date === cur.date && toMinutes(cur.startTime) < toMinutes(prev.endTime)) {
      return {
        slots: [],
        error: `Two slots overlap on ${cur.date} (${prev.startTime}–${prev.endTime} and ${cur.startTime}–${cur.endTime})`,
      };
    }
  }
  return { slots };
}

type ProfileDoc = StudentProfileDoc;

function completion(user: UserDoc, profile: ProfileDoc) {
  const items: [string, boolean][] = [
    ['fullName', Boolean(user.fullName)],
    ['phone', Boolean(user.phone)],
    ['department', Boolean(profile.department)],
    ['semester', profile.semester !== null && profile.semester !== undefined],
    ['skills', profile.skills.length > 0],
    ['availability', profile.availability.length > 0],
    ['maxHoursPerDay', profile.maxHoursPerDay !== null && profile.maxHoursPerDay !== undefined],
  ];
  const missing = items.filter(([, done]) => !done).map(([name]) => name);
  return { percent: Math.round(((items.length - missing.length) / items.length) * 100), missing };
}

export function serializeProfile(user: UserDoc, profile: ProfileDoc) {
  return {
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    usn: profile.usn,
    department: profile.department,
    semester: profile.semester,
    skills: profile.skills,
    preferences: profile.preferences,
    availability: profile.availability.map((s) => ({ date: s.date!, startTime: s.startTime!, endTime: s.endTime! })),
    maxHoursPerDay: profile.maxHoursPerDay,
    complete: Boolean(profile.profileCompletedAt),
    completion: completion(user, profile),
  };
}

/** The profile always belongs to the signed-in user; no id is ever taken from the request. */
async function ownProfile(user: UserDoc) {
  const profile = await StudentProfile.findOne({ userId: user._id });
  // Only accounts that registered as students have one (organizers keep theirs).
  if (!profile) throw forbidden('Only student accounts have a volunteer profile');
  return profile;
}

export async function getOwnProfile(user: UserDoc) {
  return serializeProfile(user, await ownProfile(user));
}

/**
 * Saves the volunteer profile onto the student's existing profile document,
 * so repeated submissions update one record instead of creating more.
 * Fields that are sent are always validated. With `finalize`, or once a
 * profile has been completed, every required field must also be present.
 */
export async function saveOwnProfile(ctx: AppContext, user: UserDoc, body: unknown) {
  const parsed = inputSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.code === 'unrecognized_keys' ? issue.keys[0] : String(issue.path[0] ?? '_');
      fields[key] ??= issue.code === 'unrecognized_keys' ? 'This field cannot be set' : 'Invalid value';
    }
    throw badRequest('Some fields are invalid', fields);
  }
  const input = parsed.data;
  const profile = await ownProfile(user);
  const errors: Record<string, string> = {};

  if (input.fullName !== undefined) {
    const name = input.fullName.trim();
    if (name.length < 2 || name.length > 100) errors.fullName = 'Enter your full name';
    else user.fullName = name;
  }

  if (input.email !== undefined && input.email.trim().toLowerCase() !== user.email) {
    errors.email = 'The email address must match your account and cannot be changed here';
  }

  if (input.phone !== undefined) {
    const phone = input.phone.replace(/[\s()-]/g, '');
    const looksIndian = phone.startsWith('+91') || /^\d{10}$/.test(phone);
    if (looksIndian && !/^(\+91)?[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a valid Indian mobile number (10 digits starting with 6–9)';
    else if (!/^\+?[0-9]{10,15}$/.test(phone)) errors.phone = 'Enter a valid phone number';
    else user.phone = phone;
  }

  if (input.department !== undefined) {
    if (!(DEPARTMENTS as readonly string[]).includes(input.department)) errors.department = 'Choose your department from the list';
    else profile.department = input.department;
  }

  if (input.semester !== undefined) {
    if (!(SEMESTERS as readonly number[]).includes(input.semester)) errors.semester = 'Choose a semester between 1 and 8';
    else profile.semester = input.semester;
  }

  if (input.skills !== undefined) {
    const result = normalizeSkills(input.skills, ctx.config.maxSkills);
    if (result.error) errors.skills = result.error;
    else {
      profile.skills = result.skills;
      profile.skillKeys = result.skills.map(skillKey);
    }
  }

  if (input.preferences !== undefined) {
    const normalized = input.preferences.map((p) => (typeof p === 'string' ? normalizeActivityType(p) : null));
    if (normalized.some((p) => p === null)) {
      errors.preferences = 'Choose preferences from the listed activity types';
    } else {
      profile.preferences = [...new Set(normalized as string[])];
    }
  }

  if (input.availability !== undefined) {
    const stored = profile.availability.map((s) => ({ date: s.date!, startTime: s.startTime!, endTime: s.endTime! }));
    const result = validateAvailability(input.availability, stored, localToday(ctx.config.utcOffsetMinutes));
    if (result.error) errors.availability = result.error;
    else profile.set('availability', result.slots);
  }

  if (input.maxHoursPerDay !== undefined) {
    const hours = input.maxHoursPerDay;
    if (!Number.isFinite(hours) || hours <= 0) errors.maxHoursPerDay = 'Enter a number of hours greater than zero';
    else if (hours > ctx.config.maxHoursPerDayLimit) errors.maxHoursPerDay = `The maximum allowed is ${ctx.config.maxHoursPerDayLimit} hours per day`;
    else profile.maxHoursPerDay = Math.round(hours * 2) / 2;
  }

  if (Object.keys(errors).length) throw badRequest('Some fields are invalid', errors);

  const { missing } = completion(user, profile);
  const mustBeComplete = Boolean(input.finalize) || Boolean(profile.profileCompletedAt);
  if (missing.length && mustBeComplete) {
    const messages: Record<string, string> = {
      fullName: 'Enter your full name',
      phone: 'Enter your phone number',
      department: 'Choose your department',
      semester: 'Choose your semester',
      skills: 'Select at least one skill',
      availability: 'Add at least one availability slot',
      maxHoursPerDay: 'Enter the maximum hours you can volunteer per day',
    };
    throw badRequest(
      'Complete the required fields to finish your profile',
      Object.fromEntries(missing.map((m) => [m, messages[m]])),
    );
  }
  if (!missing.length && !profile.profileCompletedAt) profile.profileCompletedAt = new Date();

  await user.save();
  // Written with $set rather than save(): concurrent submissions of the form
  // then simply apply in turn instead of failing on a document version clash.
  await StudentProfile.updateOne(
    { _id: profile._id },
    {
      $set: {
        department: profile.department,
        semester: profile.semester,
        skills: profile.skills,
        skillKeys: profile.skillKeys,
        preferences: profile.preferences,
        availability: profile.availability.map((s) => ({ date: s.date, startTime: s.startTime, endTime: s.endTime })),
        maxHoursPerDay: profile.maxHoursPerDay,
        profileCompletedAt: profile.profileCompletedAt,
      },
    },
  );
  return serializeProfile(user, profile);
}
