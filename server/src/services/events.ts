import mongoose from 'mongoose';
import { z } from 'zod';
import { ACTIVITY_TYPES, isValidDate, isValidTime, normalizeSkills, skillKey, toInstant, toMinutes } from '../catalog.js';
import type { AppContext } from '../context.js';
import { ACTIVE_ASSIGNMENT_STATUSES, ACTIVITY_STATUSES, EVENT_STATUSES } from '../domain.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { Activity, Assignment, Event, Notification, type ActivityDoc, type EventDoc, type UserDoc } from '../models.js';
import { isVerifiedFaculty } from './accounts.js';

// ------------------------------------------------------------ authorization

/** Verified faculty and promoted organizers are the only people who manage events. */
export async function isManager(user: UserDoc): Promise<boolean> {
  if (user.accountStatus !== 'active') return false;
  return user.role === 'organizer' || (await isVerifiedFaculty(user));
}

/**
 * Faculty oversee every event. An organizer (a promoted student) manages
 * only the events they created themselves.
 */
export async function canManageEvent(user: UserDoc, event: EventDoc): Promise<boolean> {
  if (!(await isManager(user))) return false;
  return user.role === 'faculty' || String(event.createdBy) === String(user._id);
}

export async function loadManagedEvent(user: UserDoc, eventId: string): Promise<EventDoc> {
  const event = await Event.findById(eventId);
  if (!event) throw notFound('Event not found');
  if (!(await canManageEvent(user, event))) throw forbidden();
  return event;
}

export async function loadManagedActivity(user: UserDoc, activityId: string) {
  const activity = await Activity.findById(activityId);
  if (!activity) throw notFound('Activity not found');
  const event = await loadManagedEvent(user, String(activity.eventId));
  return { activity, event };
}

/** Mongo filter for the events this manager may see. */
export const managedEventFilter = (user: UserDoc) => (user.role === 'faculty' ? {} : { createdBy: user._id });

// ----------------------------------------------------------------- parsing

function fieldErrors(error: z.ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.code === 'unrecognized_keys' ? issue.keys[0] : String(issue.path[0] ?? '_');
    fields[key] ??= issue.code === 'unrecognized_keys' ? 'This field cannot be set' : issue.message;
  }
  return fields;
}

const text = (label: string, max: number) => z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);
const dateField = z.string({ required_error: 'Choose a date' }).refine(isValidDate, 'Choose a valid date');
const timeField = z.string({ required_error: 'Choose a time' }).refine(isValidTime, 'Choose a valid time');

const eventSchema = z
  .object({
    name: text('Event name', 120),
    description: z.string().trim().max(2000).default(''),
    startDate: dateField,
    endDate: dateField,
    venue: text('Venue', 200),
    status: z.enum(EVENT_STATUSES).default('draft'),
  })
  .strict();

const activitySchema = z
  .object({
    name: text('Activity name', 120),
    description: z.string().trim().max(2000).default(''),
    activityType: z.enum(ACTIVITY_TYPES).nullable().default(null),
    date: dateField,
    startTime: timeField,
    endTime: timeField,
    location: text('Location', 200),
    requiredSkills: z.array(z.unknown()).default([]),
    preferredSkills: z.array(z.unknown()).default([]),
    requiredCount: z
      .number({ required_error: 'Enter how many volunteers are needed', invalid_type_error: 'Enter a whole number' })
      .int('Enter a whole number')
      .min(1, 'At least one volunteer is required')
      .max(500),
    minPriorEvents: z.number().int('Enter a whole number').min(0).max(50).default(0),
    requireTestPass: z.boolean().default(false),
    instructions: z.string().trim().max(2000).default(''),
    status: z.enum(ACTIVITY_STATUSES).default('open'),
  })
  .strict();

function parseEvent(body: unknown) {
  const result = eventSchema.safeParse(body ?? {});
  if (!result.success) throw badRequest('Some fields are invalid', fieldErrors(result.error));
  if (result.data.endDate < result.data.startDate) throw badRequest('Some fields are invalid', { endDate: 'The end date cannot be before the start date' });
  return result.data;
}

function parseActivity(ctx: AppContext, body: unknown, event: EventDoc) {
  const result = activitySchema.safeParse(body ?? {});
  if (!result.success) throw badRequest('Some fields are invalid', fieldErrors(result.error));
  const data = result.data;
  const errors: Record<string, string> = {};

  if (toMinutes(data.endTime) <= toMinutes(data.startTime)) errors.endTime = 'The end time must be later than the start time';
  if (data.date < event.startDate || data.date > event.endDate) {
    errors.date = `The date must fall within the event (${event.startDate} to ${event.endDate})`;
  }
  if (data.requireTestPass && !data.activityType) errors.requireTestPass = 'Choose an activity type to require its mock test';
  const required = normalizeSkills(data.requiredSkills, 10);
  if (required.error) errors.requiredSkills = required.error;
  const preferred = normalizeSkills(data.preferredSkills, 10);
  if (preferred.error) errors.preferredSkills = preferred.error;
  if (Object.keys(errors).length) throw badRequest('Some fields are invalid', errors);

  const requiredKeys = new Set(required.skills.map(skillKey));
  const preferredSkills = preferred.skills.filter((s) => !requiredKeys.has(skillKey(s)));
  return {
    ...data,
    requiredSkills: required.skills,
    requiredSkillKeys: required.skills.map(skillKey),
    preferredSkills,
    preferredSkillKeys: preferredSkills.map(skillKey),
    startAt: toInstant(data.date, data.startTime, ctx.config.utcOffsetMinutes),
    endAt: toInstant(data.date, data.endTime, ctx.config.utcOffsetMinutes),
  };
}

// ------------------------------------------------------------ serializing

export function serializeEvent(event: EventDoc) {
  return {
    id: event.id as string,
    name: event.name,
    description: event.description,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    status: event.status,
    isSampleData: event.isSampleData,
    createdBy: String(event.createdBy),
    ...eventMapSummary(event),
  };
}

/**
 * The venue map data shared with anyone who can already see this event — a
 * confirmed public venue location is not sensitive the way a person's live
 * position is, so this is embedded wherever an event is summarised for a
 * student (dashboard, activities, assignments), not just for managers.
 */
export function eventMapSummary(event: Pick<EventDoc, 'id' | 'name' | 'venue' | 'venueAddress' | 'venueLocation' | 'locationUpdatedAt'>) {
  return {
    venueAddress: event.venueAddress || null,
    venueLocation: event.venueLocation ? { latitude: event.venueLocation.coordinates[1], longitude: event.venueLocation.coordinates[0] } : null,
    locationUpdatedAt: event.locationUpdatedAt ?? null,
  };
}

const locationSchema = z
  .object({
    venueAddress: z.string().trim().max(300).default(''),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

/**
 * Sets or corrects the event's venue point on the map. Separate from
 * `updateEvent` so picking a location on the map is its own small, focused
 * action rather than requiring the whole event form to be resubmitted.
 */
export async function updateEventLocation(user: UserDoc, eventId: string, body: unknown) {
  const event = await loadManagedEvent(user, eventId);
  const parsed = locationSchema.safeParse(body ?? {});
  if (!parsed.success) throw badRequest('Some fields are invalid', fieldErrors(parsed.error));
  const { venueAddress, latitude, longitude } = parsed.data;

  event.set({
    venueAddress,
    venueLocation: { type: 'Point', coordinates: [longitude, latitude] },
    locationUpdatedAt: new Date(),
    locationUpdatedBy: user._id,
  });
  await event.save();
  return serializeEvent(event);
}

/** Clears a previously set venue point, e.g. if it was set in error. */
export async function clearEventLocation(user: UserDoc, eventId: string) {
  const event = await loadManagedEvent(user, eventId);
  event.set({ venueAddress: '', venueLocation: null, locationUpdatedAt: new Date(), locationUpdatedBy: user._id });
  await event.save();
  return serializeEvent(event);
}

export function serializeActivity(activity: ActivityDoc) {
  return {
    id: activity.id as string,
    eventId: String(activity.eventId),
    name: activity.name,
    description: activity.description,
    activityType: activity.activityType ?? null,
    date: activity.date,
    startTime: activity.startTime,
    endTime: activity.endTime,
    location: activity.location,
    requiredSkills: activity.requiredSkills,
    preferredSkills: activity.preferredSkills,
    requiredCount: activity.requiredCount,
    minPriorEvents: activity.minPriorEvents ?? 0,
    requireTestPass: Boolean(activity.requireTestPass),
    instructions: activity.instructions,
    status: activity.status,
  };
}

/** Seats taken per activity, split by status. */
export async function seatCounts(activityIds: mongoose.Types.ObjectId[]) {
  const rows = await Assignment.aggregate<{ _id: { activityId: mongoose.Types.ObjectId; status: string }; count: number }>([
    { $match: { activityId: { $in: activityIds }, status: { $in: ACTIVE_ASSIGNMENT_STATUSES } } },
    { $group: { _id: { activityId: '$activityId', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const counts = new Map<string, { pending: number; confirmed: number }>();
  for (const row of rows) {
    const entry = counts.get(String(row._id.activityId)) ?? { pending: 0, confirmed: 0 };
    entry[row._id.status as 'pending' | 'confirmed'] = row.count;
    counts.set(String(row._id.activityId), entry);
  }
  return (activityId: string) => counts.get(activityId) ?? { pending: 0, confirmed: 0 };
}

// ------------------------------------------------------------------ events

export async function listEvents(user: UserDoc) {
  const events = await Event.find(managedEventFilter(user)).sort({ startDate: -1 }).limit(200);
  const activities = await Activity.find({ eventId: { $in: events.map((e) => e._id) }, status: { $ne: 'cancelled' } });
  const counts = await seatCounts(activities.map((a) => a._id));
  return events.map((event) => {
    const own = activities.filter((a) => String(a.eventId) === event.id);
    const required = own.reduce((sum, a) => sum + a.requiredCount, 0);
    const filled = own.reduce((sum, a) => sum + counts(a.id as string).confirmed + counts(a.id as string).pending, 0);
    return { ...serializeEvent(event), activityCount: own.length, positionsRequired: required, positionsFilled: filled };
  });
}

export async function createEvent(user: UserDoc, body: unknown) {
  if (!(await isManager(user))) throw forbidden();
  const event = await Event.create({ ...parseEvent(body), createdBy: user._id });
  return serializeEvent(event);
}

export async function getEventDetail(user: UserDoc, eventId: string) {
  const event = await loadManagedEvent(user, eventId);
  const activities = await Activity.find({ eventId: event._id }).sort({ startAt: 1 });
  const counts = await seatCounts(activities.map((a) => a._id));
  return {
    ...serializeEvent(event),
    lastAllocation: event.lastAllocation ?? null,
    activities: activities.map((a) => {
      const c = counts(a.id as string);
      return { ...serializeActivity(a), ...c, vacancies: Math.max(0, a.requiredCount - c.pending - c.confirmed) };
    }),
  };
}

/** Releases every live seat on the given activities and tells the volunteers why. */
async function releaseSeats(activityIds: mongoose.Types.ObjectId[], actor: UserDoc, reason: string, session: mongoose.ClientSession) {
  const live = await Assignment.find({ activityId: { $in: activityIds }, status: { $in: ACTIVE_ASSIGNMENT_STATUSES } }).session(session);
  if (!live.length) return 0;
  await Assignment.updateMany(
    { _id: { $in: live.map((a) => a._id) } },
    { status: 'cancelled', statusReason: reason, decidedBy: actor._id, decidedAt: new Date() },
    { session },
  );
  await Notification.create(
    live.map((a) => ({ userId: a.studentId, type: 'assignment_cancelled', title: 'Assignment cancelled', message: reason })),
    { session, ordered: true },
  );
  return live.length;
}

export async function updateEvent(user: UserDoc, eventId: string, body: unknown) {
  const event = await loadManagedEvent(user, eventId);
  const data = parseEvent(body);

  const outside = await Activity.findOne({ eventId: event._id, status: { $ne: 'cancelled' }, $or: [{ date: { $lt: data.startDate } }, { date: { $gt: data.endDate } }] });
  if (outside) {
    throw badRequest('Some fields are invalid', { endDate: `Activity "${outside.name}" on ${outside.date} would fall outside these dates` });
  }

  let released = 0;
  await mongoose.connection.transaction(async (session) => {
    event.set(data);
    await event.save({ session });
    if (data.status === 'cancelled') {
      const activities = await Activity.find({ eventId: event._id }).session(session);
      released = await releaseSeats(activities.map((a) => a._id), user, `The event "${event.name}" was cancelled.`, session);
    }
  });
  return { ...serializeEvent(event), releasedAssignments: released };
}

export async function deleteEvent(user: UserDoc, eventId: string) {
  const event = await loadManagedEvent(user, eventId);
  if (await Assignment.exists({ eventId: event._id })) {
    throw conflict('This event has assignment history, so it cannot be deleted. Cancel it instead.', 'HAS_ASSIGNMENTS');
  }
  await mongoose.connection.transaction(async (session) => {
    await Activity.deleteMany({ eventId: event._id }, { session });
    await event.deleteOne({ session });
  });
}

// -------------------------------------------------------------- activities

export async function createActivity(ctx: AppContext, user: UserDoc, eventId: string, body: unknown) {
  const event = await loadManagedEvent(user, eventId);
  if (event.status === 'cancelled' || event.status === 'completed') throw conflict(`Activities cannot be added to a ${event.status} event`, 'INVALID_STATE');
  const activity = await Activity.create({ ...parseActivity(ctx, body, event), eventId: event._id });
  return serializeActivity(activity);
}

export async function updateActivity(ctx: AppContext, user: UserDoc, activityId: string, body: unknown) {
  const { activity, event } = await loadManagedActivity(user, activityId);
  const data = parseActivity(ctx, body, event);

  await mongoose.connection.transaction(async (session) => {
    activity.set(data);
    await activity.save({ session });
    if (data.status === 'cancelled') {
      await releaseSeats([activity._id], user, `The activity "${activity.name}" was cancelled.`, session);
    }
  });
  return serializeActivity(activity);
}

export async function deleteActivity(user: UserDoc, activityId: string) {
  const { activity } = await loadManagedActivity(user, activityId);
  if (await Assignment.exists({ activityId: activity._id })) {
    throw conflict('This activity has assignment history, so it cannot be deleted. Cancel it instead.', 'HAS_ASSIGNMENTS');
  }
  await activity.deleteOne();
}
