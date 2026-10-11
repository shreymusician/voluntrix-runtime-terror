import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { Activity, Assignment, EmergencyAudit, EmergencyInvitation, EmergencyRequest, Event, Notification, StudentProfile, User, VolunteerLocation, type UserDoc } from '../models.js';
import { loadManagedEvent } from './events.js';

const SESSION_TTL_MS = 2 * 60_000;
const LIVE_FRESHNESS_MS = 90_000;
const coordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(10_000),
  capturedAt: z.number().int().refine((value) => value >= Date.now() - 60_000 && value <= Date.now() + 10_000, 'Location fix is stale or invalid'),
}).strict();

export async function getLocationPreferences(student: UserDoc) {
  const profile = await StudentProfile.findOne({ userId: student._id }).select('emergencyDiscoveryEnabled');
  if (!profile) throw notFound('Volunteer profile not found');
  return { emergencyDiscoveryEnabled: Boolean(profile.emergencyDiscoveryEnabled) };
}

export async function updateLocationPreferences(student: UserDoc, enabled: boolean) {
  const profile = await StudentProfile.findOneAndUpdate({ userId: student._id }, { emergencyDiscoveryEnabled: enabled }, { new: true });
  if (!profile) throw notFound('Volunteer profile not found');
  if (!enabled) {
    await VolunteerLocation.deleteMany({ volunteerId: student._id, scope: 'emergency' });
    const pending = await EmergencyInvitation.find({ studentId: student._id, status: 'pending' });
    if (pending.length) {
      const now = new Date();
      await EmergencyInvitation.updateMany({ _id: { $in: pending.map((invitation) => invitation._id) } }, { status: 'cancelled', respondedAt: now });
      const requests = await EmergencyRequest.find({ _id: { $in: pending.map((invitation) => invitation.requestId) } }).select('createdBy title');
      await Notification.create(requests.map((request) => ({
        userId: request.createdBy,
        type: 'emergency_volunteer_opted_out',
        title: 'Emergency request declined',
        message: `${student.fullName} disabled emergency discovery and is no longer available for "${request.title}".`,
      })), { ordered: true });
      await EmergencyAudit.create(pending.map((invitation) => ({
        requestId: invitation.requestId,
        invitationId: invitation._id,
        actorId: student._id,
        action: 'opted_out',
      })), { ordered: true });
    }
  }
  return { emergencyDiscoveryEnabled: Boolean(profile.emergencyDiscoveryEnabled) };
}

export async function activeLocationSession(student: UserDoc) {
  const now = new Date();
  const session = await VolunteerLocation.findOne({ volunteerId: student._id, sharingEnabled: true, expiresAt: { $gt: now } }).select('sessionId eventId scope updatedAt expiresAt accuracyMeters');
  return session
    ? {
        sessionId: session.sessionId,
        eventId: session.eventId?.toString() ?? null,
        scope: session.scope,
        updatedAt: session.updatedAt,
        expiresAt: session.expiresAt,
        accuracyMeters: session.accuracyMeters,
      }
    : null;
}

export async function startLocationSharing(student: UserDoc, eventId?: string) {
  let scope: 'event' | 'emergency';
  let scopedEventId = null;
  if (eventId) {
    const event = await Event.findById(eventId);
    if (!event || event.status !== 'published') throw notFound('Event not found');
    const assignment = await Assignment.findOne({ studentId: student._id, eventId: event._id, status: 'confirmed' });
    if (!assignment) throw forbidden('Location sharing is available only to volunteers with a confirmed assignment for this event');
    const activity = await Activity.findById(assignment.activityId).select('endAt status');
    if (!activity || activity.status === 'cancelled' || activity.endAt <= new Date()) throw forbidden('Location sharing is only available for an upcoming or active assignment');
    scope = 'event';
    scopedEventId = event._id;
  } else {
    const preferences = await getLocationPreferences(student);
    if (!preferences.emergencyDiscoveryEnabled) throw forbidden('Enable emergency volunteer discovery before sharing your location for nearby requests');
    scope = 'emergency';
  }

  await VolunteerLocation.deleteMany({ volunteerId: student._id, sharingEnabled: true });
  const now = new Date();
  const sessionId = randomUUID();
  let session;
  try {
    session = await VolunteerLocation.create({
      volunteerId: student._id,
      eventId: scopedEventId,
      sessionId,
      scope,
      sharingEnabled: true,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw conflict('A location-sharing session is already active', 'SESSION_ACTIVE');
    throw error;
  }
  return { sessionId: session.sessionId, eventId: session.eventId?.toString() ?? null, scope, expiresAt: session.expiresAt };
}

export async function updateLocation(student: UserDoc, sessionId: string, body: unknown) {
  const parsed = coordinatesSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? '_')] ??= issue.message;
    throw badRequest('Some fields are invalid', fields);
  }

  const now = new Date();
  const updated = await VolunteerLocation.findOneAndUpdate(
    { sessionId, volunteerId: student._id, sharingEnabled: true, expiresAt: { $gt: now } },
    {
      location: { type: 'Point', coordinates: [parsed.data.longitude, parsed.data.latitude] },
      accuracyMeters: parsed.data.accuracyMeters,
      locationCapturedAt: new Date(parsed.data.capturedAt),
      updatedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    },
    { new: true },
  ).select('sessionId eventId scope updatedAt expiresAt accuracyMeters');
  if (!updated) throw notFound('Location-sharing session is stopped or expired');
  return { sessionId: updated.sessionId, updatedAt: updated.updatedAt, expiresAt: updated.expiresAt };
}

export async function stopLocationSharing(student: UserDoc, sessionId: string) {
  const result = await VolunteerLocation.deleteOne({ sessionId, volunteerId: student._id, sharingEnabled: true });
  if (!result.deletedCount) throw notFound('Location-sharing session not found');
  return { stopped: true };
}

export async function listLiveEventLocations(manager: UserDoc, eventId: string) {
  const event = await loadManagedEvent(manager, eventId);
  const now = new Date();
  const assignments = await Assignment.find({ eventId: event._id, status: 'confirmed' }).select('studentId activityId status emergencyRequestId');
  if (!assignments.length) return { eventId, locations: [] };

  const studentIds = [...new Set(assignments.map((assignment) => assignment.studentId.toString()))];
  const emergencyStudentIds = [...new Set(assignments.filter((assignment) => assignment.emergencyRequestId).map((assignment) => assignment.studentId.toString()))];
  const activityIds = [...new Set(assignments.map((assignment) => assignment.activityId.toString()))];
  const [locations, users, activities] = await Promise.all([
    VolunteerLocation.find({
      volunteerId: { $in: studentIds },
      $or: [
        { eventId: event._id, scope: 'event' },
        ...(emergencyStudentIds.length ? [{ scope: 'emergency', volunteerId: { $in: emergencyStudentIds } }] : []),
      ],
      sharingEnabled: true,
      locationCapturedAt: { $gt: new Date(now.getTime() - LIVE_FRESHNESS_MS) },
      expiresAt: { $gt: now },
    }).select('volunteerId scope location accuracyMeters locationCapturedAt expiresAt'),
    User.find({ _id: { $in: studentIds }, accountStatus: 'active' }).select('fullName'),
    Activity.find({ _id: { $in: activityIds } }).select('name location'),
  ]);
  const userById = new Map(users.map((user) => [user.id as string, user]));
  const activityById = new Map(activities.map((activity) => [activity.id as string, activity]));
  const assignmentsByStudent = new Map<string, typeof assignments>();
  for (const assignment of assignments) {
    const current = assignmentsByStudent.get(assignment.studentId.toString()) ?? [];
    current.push(assignment);
    assignmentsByStudent.set(assignment.studentId.toString(), current);
  }

  return {
    eventId,
    locations: locations.flatMap((location) => {
      const volunteerId = location.volunteerId.toString();
      const user = userById.get(volunteerId);
      const matchingAssignments = assignmentsByStudent.get(volunteerId) ?? [];
      const assignment = matchingAssignments.find((item) => Boolean(item.emergencyRequestId) === (location.scope === 'emergency')) ?? matchingAssignments[0];
      const activity = assignment ? activityById.get(assignment.activityId.toString()) : null;
      if (!location.location || !user || !assignment || !activity) return [];
      return [{
        volunteerId,
        displayName: user.fullName,
        position: activity.name,
        positionLocation: activity.location,
        assignmentStatus: assignment.status,
        latitude: Math.round(location.location.coordinates[1] * 1000) / 1000,
        longitude: Math.round(location.location.coordinates[0] * 1000) / 1000,
        accuracyMeters: location.accuracyMeters,
        updatedAt: location.locationCapturedAt,
        expiresAt: location.expiresAt,
      }];
    }),
  };
}
