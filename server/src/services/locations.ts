import { z } from 'zod';
import { conflict, forbidden, notFound } from '../errors.js';
import { Activity, Assignment, Event, User, VolunteerLocation, type UserDoc, type VolunteerLocationDoc } from '../models.js';

/**
 * Sharing lapses on its own after this long, even if the volunteer never
 * presses stop — a forgotten tab must not broadcast someone's position
 * indefinitely. Each update pushes the window forward.
 */
export const SHARING_WINDOW_MS = 4 * 3600_000;
/**
 * A position older than this is treated as no longer live: the device has
 * gone quiet (closed tab, lost signal) and we must not imply it is current.
 */
export const STALE_AFTER_MS = 5 * 60_000;

/** Sharing may only start within this margin around the activity's own times. */
const EARLY_START_MS = 2 * 3600_000;

export const positionSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMetres: z.number().min(0).max(100_000).nullable().optional(),
  })
  .strict();

/** True while the volunteer is actively sharing: not stopped, not lapsed, still reporting. */
export function isLive(record: Pick<VolunteerLocationDoc, 'endedAt' | 'expiresAt' | 'updatedAt'>, now = Date.now()): boolean {
  if (record.endedAt) return false;
  if (record.expiresAt.getTime() <= now) return false;
  return now - record.updatedAt.getTime() <= STALE_AFTER_MS;
}

/** Great-circle distance in metres, used only to say roughly how far off-post someone is. */
export function distanceMetres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * The volunteer's own confirmed assignment, which is the only thing they may
 * share a location against. Taken from the session user, never from the body.
 */
async function ownConfirmedAssignment(student: UserDoc, assignmentId: string) {
  const assignment = await Assignment.findOne({ _id: assignmentId, studentId: student._id });
  if (!assignment) throw notFound('Assignment not found');
  if (assignment.status !== 'confirmed') throw conflict('Only a confirmed duty can share a location', 'NOT_CONFIRMED');
  const activity = await Activity.findById(assignment.activityId);
  const event = activity ? await Event.findById(activity.eventId) : null;
  if (!activity || !event) throw notFound('Assignment not found');
  return { assignment, activity, event };
}

/**
 * Starts (or resumes) location sharing for one of the volunteer's own duties.
 * This call is the consent: nothing is stored until the volunteer makes it,
 * and `startedAt` records when they agreed.
 */
export async function startSharing(student: UserDoc, assignmentId: string, body: unknown) {
  const position = positionSchema.parse(body ?? {});
  const { assignment, activity, event } = await ownConfirmedAssignment(student, assignmentId);

  const now = Date.now();
  if (event.status === 'cancelled' || event.status === 'completed') throw conflict(`The event is ${event.status}`, 'ACTIVITY_NOT_OPEN');
  if (activity.startAt.getTime() - now > EARLY_START_MS) throw conflict('Sharing opens closer to the start of your duty', 'TOO_EARLY');
  if (activity.endAt.getTime() <= now) throw conflict('This duty has already finished', 'ACTIVITY_ENDED');

  // Sharing never outlives the duty it belongs to.
  const expiresAt = new Date(Math.min(now + SHARING_WINDOW_MS, activity.endAt.getTime()));
  const update = {
    studentId: student._id,
    eventId: activity.eventId,
    activityId: activity._id,
    latitude: position.latitude,
    longitude: position.longitude,
    accuracyMetres: position.accuracyMetres ?? null,
    updatedAt: new Date(now),
    expiresAt,
    endedAt: null,
  };
  const record = await VolunteerLocation.findOneAndUpdate(
    { assignmentId: assignment._id },
    { $set: update, $setOnInsert: { startedAt: new Date(now) } },
    { new: true, upsert: true },
  );
  return serializeOwn(record!);
}

/** A position update from a volunteer who is already sharing. */
export async function updateSharing(student: UserDoc, assignmentId: string, body: unknown) {
  const position = positionSchema.parse(body ?? {});
  const record = await VolunteerLocation.findOne({ assignmentId, studentId: student._id });
  if (!record) throw notFound('You are not sharing a location for this duty');
  if (record.endedAt) throw conflict('You have stopped sharing for this duty. Start again to share.', 'SHARING_ENDED');

  const activity = await Activity.findById(record.activityId);
  const now = Date.now();
  if (!activity || activity.endAt.getTime() <= now) throw conflict('This duty has already finished', 'ACTIVITY_ENDED');

  record.set({
    latitude: position.latitude,
    longitude: position.longitude,
    accuracyMetres: position.accuracyMetres ?? null,
    updatedAt: new Date(now),
    // Each update renews the window, so sharing lasts as long as the volunteer is active.
    expiresAt: new Date(Math.min(now + SHARING_WINDOW_MS, activity.endAt.getTime())),
  });
  await record.save();
  return serializeOwn(record);
}

/** Stops sharing. The position disappears from every viewer immediately. */
export async function stopSharing(student: UserDoc, assignmentId: string) {
  const record = await VolunteerLocation.findOne({ assignmentId, studentId: student._id });
  if (!record) throw notFound('You are not sharing a location for this duty');
  if (!record.endedAt) {
    record.endedAt = new Date();
    await record.save();
  }
  return serializeOwn(record);
}

/** What the volunteer sees about their own sharing. */
function serializeOwn(record: VolunteerLocationDoc) {
  return {
    assignmentId: String(record.assignmentId),
    sharing: isLive(record),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    endedAt: record.endedAt,
  };
}

/** The volunteer's own sharing state for each of their duties. */
export async function listOwnSharing(student: UserDoc) {
  const records = await VolunteerLocation.find({ studentId: student._id }).sort({ updatedAt: -1 });
  return records.map(serializeOwn);
}

/**
 * Live volunteer positions for the student information dashboard.
 *
 * Only volunteers who are sharing right now appear: stopped, lapsed and
 * stale records are filtered out, so a position is never shown once sharing
 * ends. Only published, in-progress events are in scope, and nothing is
 * returned for volunteers who never opted in.
 */
export async function listLiveLocations() {
  const now = Date.now();
  const records = await VolunteerLocation.find({ endedAt: null, expiresAt: { $gt: new Date(now) } }).sort({ updatedAt: -1 });
  const live = records.filter((r) => isLive(r, now));
  if (!live.length) return [];

  const [activities, events, users] = await Promise.all([
    Activity.find({ _id: { $in: live.map((r) => r.activityId) } }),
    Event.find({ _id: { $in: live.map((r) => r.eventId) }, status: 'published' }),
    User.find({ _id: { $in: live.map((r) => r.studentId) } }).select('fullName'),
  ]);
  const activityById = new Map(activities.map((a) => [a.id as string, a]));
  const eventById = new Map(events.map((e) => [e.id as string, e]));
  const userById = new Map(users.map((u) => [u.id as string, u]));

  return live
    .map((record) => {
      const activity = activityById.get(String(record.activityId));
      const event = eventById.get(String(record.eventId));
      const user = userById.get(String(record.studentId));
      // Unpublished or missing events are out of scope for this view.
      if (!activity || !event || !user) return null;

      const venue =
        activity.latitude !== null && activity.latitude !== undefined && activity.longitude !== null && activity.longitude !== undefined
          ? { latitude: activity.latitude, longitude: activity.longitude }
          : null;

      return {
        volunteerId: user.id as string,
        // They consented to being shown by name on the live map.
        displayName: user.fullName,
        event: { id: event.id as string, name: event.name, venue: event.venue },
        activity: { id: activity.id as string, name: activity.name, location: activity.location, date: activity.date, startTime: activity.startTime, endTime: activity.endTime },
        role: activity.activityType ?? activity.name,
        latitude: record.latitude,
        longitude: record.longitude,
        accuracyMetres: record.accuracyMetres ?? null,
        updatedAt: record.updatedAt,
        secondsSinceUpdate: Math.max(0, Math.round((now - record.updatedAt.getTime()) / 1000)),
        sharingSince: record.startedAt,
        sharingStatus: 'live' as const,
        // Null when the organizer has not pinned the venue on the map.
        distanceFromVenueMetres: venue ? distanceMetres(record.latitude, record.longitude, venue.latitude, venue.longitude) : null,
        venue,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
