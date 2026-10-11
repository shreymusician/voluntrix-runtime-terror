import mongoose, { type ClientSession } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  Activity,
  Assignment,
  EmergencyAudit,
  EmergencyInvitation,
  EmergencyRequest,
  Event,
  Notification,
  StudentProfile,
  User,
  VolunteerLocation,
  type EmergencyRequestDoc,
  type UserDoc,
} from '../models.js';
import { loadManagedActivity, loadManagedEvent } from './events.js';

const FRESH_MS = 90_000;
const ACTIVE_ASSIGNMENTS = ['pending', 'confirmed'];
const createSchema = z.object({
  activityId: z.string().regex(/^[a-f0-9]{24}$/i),
  description: z.string().trim().min(5).max(2000),
  instructions: z.string().trim().max(1000).default(''),
  requiredCount: z.number().int().min(1).max(100),
  radiusKm: z.number().min(0.5).max(50),
  urgency: z.enum(['normal', 'high', 'critical']),
  specialistSkills: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
}).strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) fields[String(issue.path[0] ?? '_')] ??= issue.message;
  throw badRequest('Some fields are invalid', fields);
}

function distanceMetres(a: [number, number], b: [number, number]) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

async function managedRequest(manager: UserDoc, requestId: string) {
  const emergency = await EmergencyRequest.findById(requestId);
  if (!emergency) throw notFound('Emergency request not found');
  const event = await loadManagedEvent(manager, String(emergency.eventId));
  return { emergency, event };
}

export async function createEmergencyRequest(manager: UserDoc, eventId: string, body: unknown) {
  const event = await loadManagedEvent(manager, eventId);
  if (event.status !== 'published' || !event.venueLocation) {
    throw conflict('Publish the event and set its venue on the map before requesting nearby emergency volunteers', 'EVENT_LOCATION_REQUIRED');
  }
  const venueLocation = event.venueLocation;
  const input = parseBody(createSchema, body);
  const source = await loadManagedActivity(manager, input.activityId);
  if (String(source.event._id) !== String(event._id) || source.activity.status === 'cancelled' || source.activity.endAt <= new Date()) {
    throw badRequest('Choose an upcoming activity from this event', { activityId: 'Choose an upcoming activity from this event' });
  }
  const specialistSkills = [...new Set((input.specialistSkills ?? []).map((skill) => skill.trim().replace(/\s+/g, ' ')))];
  const emergencyActivity = {
    eventId: event._id,
    name: `Emergency support: ${source.activity.name}`,
    description: input.description,
    activityType: null,
    date: source.activity.date,
    startTime: source.activity.startTime,
    endTime: source.activity.endTime,
    startAt: source.activity.startAt,
    endAt: source.activity.endAt,
    location: source.activity.location,
    requiredSkills: specialistSkills,
    requiredSkillKeys: specialistSkills.map((skill) => skill.toLowerCase()),
    preferredSkills: [],
    preferredSkillKeys: [],
    requiredCount: input.requiredCount,
    minPriorEvents: 0,
    requireTestPass: false,
    instructions: input.instructions,
    status: 'closed' as const,
  };

  return mongoose.connection.transaction(async (session) => {
    const [activity] = await Activity.create([emergencyActivity], { session });
    const [request] = await EmergencyRequest.create([{
      eventId: event._id,
      activityId: activity._id,
      sourceActivityId: source.activity._id,
      createdBy: manager._id,
      title: activity.name,
      description: input.description,
      locationLabel: [event.venue, event.venueAddress].filter(Boolean).join(' · '),
      location: venueLocation,
      startAt: source.activity.startAt,
      endAt: source.activity.endAt,
      requiredCount: input.requiredCount,
      radiusMeters: Math.round(input.radiusKm * 1000),
      urgency: input.urgency,
      instructions: input.instructions,
      specialistSkills,
    }], { session });
    await EmergencyAudit.create([{ requestId: request._id, actorId: manager._id, action: 'created', details: { sourceActivityId: source.activity.id, requiredCount: input.requiredCount, radiusMeters: request.radiusMeters } }], { session });
    return serializeRequest(request, event.name, event.venue, event.venueAddress || null, venueLocation.coordinates);
  });
}

function serializeRequest(request: EmergencyRequestDoc, eventName: string, venue: string, venueAddress: string | null, coordinates: number[]) {
  return {
    id: request.id as string,
    eventId: request.eventId.toString(),
    eventName,
    activityId: request.activityId.toString(),
    title: request.title,
    description: request.description,
    instructions: request.instructions,
    venue,
    venueAddress,
    venueLocation: { longitude: coordinates[0], latitude: coordinates[1] },
    startAt: request.startAt,
    endAt: request.endAt,
    requiredCount: request.requiredCount,
    radiusMeters: request.radiusMeters,
    urgency: request.urgency,
    specialistSkills: request.specialistSkills,
    status: request.status,
  };
}

export async function listEmergencyRequests(manager: UserDoc, eventId: string) {
  const event = await loadManagedEvent(manager, eventId);
  const now = new Date();
  await EmergencyRequest.updateMany({ eventId: event._id, status: 'open', endAt: { $lte: now } }, { status: 'expired' });
  const requests = await EmergencyRequest.find({ eventId: event._id }).sort({ createdAt: -1 });
  return Promise.all(requests.map(async (request) => {
    const [pending, accepted] = await Promise.all([
      EmergencyInvitation.countDocuments({ requestId: request._id, status: 'pending' }),
      EmergencyInvitation.countDocuments({ requestId: request._id, status: 'accepted' }),
    ]);
    return {
      ...serializeRequest(request, event.name, event.venue, event.venueAddress || null, request.location.coordinates),
      pendingCount: pending,
      acceptedCount: accepted,
    };
  }));
}

async function candidateConflicts(studentIds: string[], startAt: Date, endAt: Date) {
  const assignments = await Assignment.find({ studentId: { $in: studentIds }, status: { $in: ACTIVE_ASSIGNMENTS } }).select('studentId activityId');
  if (!assignments.length) return new Set<string>();
  const activities = await Activity.find({
    _id: { $in: assignments.map((assignment) => assignment.activityId) },
    startAt: { $lt: endAt },
    endAt: { $gt: startAt },
  }).select('_id');
  const conflictActivityIds = new Set(activities.map((activity) => activity.id as string));
  return new Set(assignments.filter((assignment) => conflictActivityIds.has(assignment.activityId.toString())).map((assignment) => assignment.studentId.toString()));
}

export async function discoverEmergencyCandidates(manager: UserDoc, requestId: string) {
  const { emergency } = await managedRequest(manager, requestId);
  if (emergency.status !== 'open' || emergency.endAt <= new Date()) throw conflict('This emergency request is no longer accepting volunteers', 'INVALID_STATE');
  const now = new Date();
  const freshAfter = new Date(now.getTime() - FRESH_MS);
  const locations = await VolunteerLocation.find({
    location: { $near: { $geometry: emergency.location, $maxDistance: emergency.radiusMeters } },
    scope: 'emergency',
    sharingEnabled: true,
    locationCapturedAt: { $gt: freshAfter },
    expiresAt: { $gt: now },
  }).select('volunteerId location accuracyMeters locationCapturedAt');
  const ids = [...new Set(locations.map((location) => location.volunteerId.toString()))];
  if (!ids.length) return { candidates: [], radiusMeters: emergency.radiusMeters };

  const [students, profiles, users, existingInvitations, conflicts] = await Promise.all([
    User.find({ _id: { $in: ids }, role: 'student', accountStatus: 'active' }).select('_id fullName'),
    StudentProfile.find({ userId: { $in: ids }, emergencyDiscoveryEnabled: true }).select('userId skillKeys'),
    User.find({ _id: { $in: ids }, role: 'student', accountStatus: 'active' }).select('fullName'),
    EmergencyInvitation.find({ requestId: emergency._id }).select('studentId status'),
    candidateConflicts(ids, emergency.startAt, emergency.endAt),
  ]);
  const eligibleIds = new Set(students.map((student) => student.id as string));
  const profileById = new Map(profiles.map((profile) => [String(profile.userId), profile]));
  const userById = new Map(users.map((user) => [user.id as string, user]));
  const existingById = new Map(existingInvitations.map((invitation) => [String(invitation.studentId), invitation.status]));
  const origin: [number, number] = [emergency.location.coordinates[0], emergency.location.coordinates[1]];
  const candidates = locations.flatMap((location) => {
    const studentId = location.volunteerId.toString();
    const profile = profileById.get(studentId);
    const user = userById.get(studentId);
    if (!eligibleIds.has(studentId) || !profile || !user || !location.location || !location.locationCapturedAt || conflicts.has(studentId)) return [];
    if (existingById.get(studentId) === 'pending' || existingById.get(studentId) === 'accepted') return [];
    const skills = new Set(profile.skillKeys);
    if (emergency.specialistSkills.some((skill) => !skills.has(skill.toLowerCase()))) return [];
    const point: [number, number] = [location.location.coordinates[0], location.location.coordinates[1]];
    const distance = haversineDistance(origin, point);
    if (distance > emergency.radiusMeters) return [];
    return [{
      studentId,
      displayName: user.fullName,
      latitude: Math.round(point[1] * 1000) / 1000,
      longitude: Math.round(point[0] * 1000) / 1000,
      distanceMeters: distance,
      accuracyMeters: location.accuracyMeters,
      locationUpdatedAt: location.locationCapturedAt,
      availabilityStatus: 'AWAITING_CONFIRMATION' as const,
      requestStatus: existingById.get(studentId) ?? null,
    }];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters);
  return { candidates, radiusMeters: emergency.radiusMeters };
}

function haversineDistance(a: [number, number], b: [number, number]) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

const inviteBody = z.object({ studentIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(20) }).strict();
const radiusBody = z.object({ radiusKm: z.number().min(0.5).max(50) }).strict();

export async function expandEmergencyRadius(manager: UserDoc, requestId: string, body: unknown) {
  const { emergency } = await managedRequest(manager, requestId);
  if (emergency.status !== 'open') throw conflict('Only an open emergency request can expand its search radius', 'INVALID_STATE');
  const { radiusKm } = parseBody(radiusBody, body);
  const radiusMeters = Math.round(radiusKm * 1000);
  if (radiusMeters <= emergency.radiusMeters) throw badRequest('Choose a larger search radius', { radiusKm: 'The new radius must be larger than the current search radius' });
  emergency.radiusMeters = radiusMeters;
  await emergency.save();
  await EmergencyAudit.create({ requestId: emergency._id, actorId: manager._id, action: 'radius_expanded', details: { radiusExpandedToMeters: radiusMeters } });
  return { radiusMeters: emergency.radiusMeters };
}

export async function listEmergencyInvitations(manager: UserDoc, requestId: string) {
  await managedRequest(manager, requestId);
  const invitations = await EmergencyInvitation.find({ requestId }).sort({ notifiedAt: -1 }).populate('studentId', 'fullName');
  return {
    invitations: invitations.map((invitation) => ({
      id: invitation.id as string,
      studentId: (invitation.studentId as unknown as { id: string }).id,
      displayName: (invitation.studentId as unknown as { fullName: string }).fullName,
      status: invitation.status,
      distanceMeters: invitation.distanceMeters,
      notifiedAt: invitation.notifiedAt,
      respondedAt: invitation.respondedAt,
      assignmentId: invitation.assignmentId?.toString() ?? null,
    })),
  };
}

export async function sendEmergencyInvitations(manager: UserDoc, requestId: string, body: unknown) {
  const { emergency, event } = await managedRequest(manager, requestId);
  if (emergency.status !== 'open' || emergency.endAt <= new Date()) throw conflict('This emergency request is no longer open', 'INVALID_STATE');
  const { studentIds } = parseBody(inviteBody, body);
  const uniqueIds = [...new Set(studentIds)];
  const { candidates } = await discoverEmergencyCandidates(manager, requestId);
  const candidateMap = new Map(candidates.map((candidate) => [candidate.studentId, candidate]));
  const invalid = uniqueIds.filter((studentId) => !candidateMap.has(studentId));
  if (invalid.length) throw conflict('One or more selected students are no longer eligible for this emergency request', 'CANDIDATE_UNAVAILABLE');

  return mongoose.connection.transaction(async (session) => {
    const invitations = [];
    for (const studentId of uniqueIds) {
      const candidate = candidateMap.get(studentId)!;
      const [invitation] = await EmergencyInvitation.create([{
        requestId: emergency._id,
        studentId,
        status: 'pending',
        distanceMeters: candidate.distanceMeters,
      }], { session });
      invitations.push(invitation);
      await Notification.create([{
        userId: studentId,
        type: 'emergency_volunteer_request',
        title: `Urgent volunteering opportunity: ${emergency.title}`,
        message: `${emergency.urgency.toUpperCase()} · ${event.name} · ${emergency.locationLabel} · ${emergency.startAt.toLocaleString()}. Availability is not assumed; respond to confirm or decline.`,
        relatedEmergencyInvitationId: invitation._id,
      }], { session });
      await EmergencyAudit.create([{ requestId: emergency._id, invitationId: invitation._id, actorId: manager._id, action: 'invited', details: { studentId, distanceMeters: candidate.distanceMeters } }], { session });
    }
    return { sent: invitations.length, invitationIds: invitations.map((invitation) => invitation.id as string) };
  });
}

export async function listOwnEmergencyInvitations(student: UserDoc) {
  const now = new Date();
  const pending = await EmergencyInvitation.find({ studentId: student._id, status: 'pending' });
  for (const invitation of pending) {
    const request = await EmergencyRequest.findById(invitation.requestId);
    if (!request || request.status !== 'open' || request.endAt <= now) {
      invitation.status = 'expired';
      invitation.respondedAt = now;
      await invitation.save();
      if (request) await EmergencyAudit.create({ requestId: request._id, invitationId: invitation._id, actorId: student._id, action: 'expired' });
    }
  }
  const invitations = await EmergencyInvitation.find({ studentId: student._id, status: 'pending' }).sort({ createdAt: -1 });
  const serialized = await Promise.all(invitations.map(async (invitation) => {
    const request = await EmergencyRequest.findById(invitation.requestId);
    const event = request ? await Event.findById(request.eventId).select('name venue venueAddress venueLocation') : null;
    if (!request || !event) return null;
    return {
      id: invitation.id as string,
      status: invitation.status,
      distanceMeters: invitation.distanceMeters,
      request: {
        id: request.id as string,
        title: request.title,
        description: request.description,
        instructions: request.instructions,
        urgency: request.urgency,
        requiredCount: request.requiredCount,
        startAt: request.startAt,
        endAt: request.endAt,
        specialistSkills: request.specialistSkills,
      },
      event: {
        id: event.id as string,
        name: event.name,
        venue: event.venue,
        venueAddress: event.venueAddress,
        venueLocation: event.venueLocation ? { longitude: event.venueLocation.coordinates[0], latitude: event.venueLocation.coordinates[1] } : null,
      },
    };
  }));
  return serialized.filter((item) => item !== null);
}

async function hasScheduleConflict(studentId: unknown, startAt: Date, endAt: Date, session: ClientSession) {
  const assignments = await Assignment.find({ studentId, status: { $in: ACTIVE_ASSIGNMENTS } }).select('activityId').session(session);
  if (!assignments.length) return false;
  return Boolean(await Activity.exists({ _id: { $in: assignments.map((assignment) => assignment.activityId) }, startAt: { $lt: endAt }, endAt: { $gt: startAt } }).session(session));
}

export async function respondToEmergencyInvitation(student: UserDoc, invitationId: string, response: 'accept' | 'decline') {
  if (response === 'decline') {
    return mongoose.connection.transaction(async (session) => {
      const invitation = await EmergencyInvitation.findOneAndUpdate(
        { _id: invitationId, studentId: student._id, status: 'pending' },
        { status: 'declined', respondedAt: new Date() },
        { new: true, session },
      );
      if (!invitation) throw notFound('Pending emergency request not found');
      const request = await EmergencyRequest.findById(invitation.requestId).session(session);
      if (request) await EmergencyAudit.create([{ requestId: request._id, invitationId: invitation._id, actorId: student._id, action: 'declined' }], { session });
      return { status: 'declined' as const };
    });
  }

  return mongoose.connection.transaction(async (session) => {
    const invitation = await EmergencyInvitation.findOne({ _id: invitationId, studentId: student._id, status: 'pending' }).session(session);
    if (!invitation) throw notFound('Pending emergency request not found');
    const request = await EmergencyRequest.findOne({ _id: invitation.requestId, status: 'open', endAt: { $gt: new Date() } }).session(session);
    if (!request) throw conflict('This emergency request is no longer available', 'INVALID_STATE');
    const [profile, location] = await Promise.all([
      StudentProfile.findOneAndUpdate({ userId: student._id, emergencyDiscoveryEnabled: true }, { $inc: { assignmentVersion: 1 } }, { new: true, session }),
      VolunteerLocation.findOne({ volunteerId: student._id, scope: 'emergency', sharingEnabled: true, expiresAt: { $gt: new Date() }, locationCapturedAt: { $gt: new Date(Date.now() - FRESH_MS) } }).session(session),
    ]);
    if (!profile || !location) throw forbidden('Enable emergency discovery and refresh your location-sharing session before accepting');
    if (await hasScheduleConflict(student._id, request.startAt, request.endAt, session)) throw conflict('You have a confirmed or pending assignment during this time', 'SCHEDULE_CONFLICT');
    if (request.specialistSkills.some((skill) => !profile.skillKeys.includes(skill.toLowerCase()))) throw forbidden('Your profile does not include the specialist skills required for this request');

    const acceptedCount = await EmergencyInvitation.countDocuments({ requestId: request._id, status: 'accepted' }).session(session);
    if (acceptedCount >= request.requiredCount) throw conflict('The emergency request has already been filled', 'CAPACITY_FULL');
    const activity = await Activity.findById(request.activityId).session(session);
    if (!activity || activity.status !== 'closed') throw conflict('The emergency activity is no longer available', 'INVALID_STATE');
    await Activity.findOneAndUpdate({ _id: activity._id, status: 'closed' }, { $inc: { seatVersion: 1 } }, { session });

    invitation.status = 'accepted';
    invitation.respondedAt = new Date();
    const [assignment] = await Assignment.create([{
      eventId: request.eventId,
      activityId: activity._id,
      studentId: student._id,
      status: 'confirmed',
      source: 'manual',
      explanation: ['Emergency volunteer: student opted in, confirmed availability, and accepted the request'],
      createdBy: request.createdBy,
      decidedBy: request.createdBy,
      decidedAt: new Date(),
      emergencyRequestId: request._id,
    }], { session });
    invitation.assignmentId = assignment._id;
    await invitation.save({ session });
    await Notification.create([
      { userId: student._id, type: 'emergency_assignment_confirmed', title: 'Emergency volunteer request confirmed', message: `You are confirmed for "${request.title}" at ${request.locationLabel}.` },
      { userId: request.createdBy, type: 'emergency_volunteer_accepted', title: 'Emergency volunteer accepted', message: `${student.fullName} accepted "${request.title}".` },
    ], { session, ordered: true });
    await EmergencyAudit.create([{ requestId: request._id, invitationId: invitation._id, actorId: student._id, action: 'accepted', details: { assignmentId: assignment.id } }], { session });

    const isFilled = acceptedCount + 1 >= request.requiredCount;
    if (isFilled) {
      request.status = 'filled';
      await request.save({ session });
      const waiting = await EmergencyInvitation.find({ requestId: request._id, status: 'pending' }).session(session);
      if (waiting.length) {
        await EmergencyInvitation.updateMany({ _id: { $in: waiting.map((item) => item._id) } }, { status: 'cancelled', respondedAt: new Date() }, { session });
        await Notification.create(waiting.map((item) => ({ userId: item.studentId, type: 'emergency_request_filled', title: 'Emergency position filled', message: `The request for "${request.title}" has been filled. No response is needed.`, relatedEmergencyInvitationId: item._id })), { session, ordered: true });
      }
      await EmergencyAudit.create([{ requestId: request._id, actorId: request.createdBy, action: 'filled' }], { session });
    }
    return { status: 'accepted' as const, assignmentId: assignment.id as string, requestStatus: isFilled ? 'filled' as const : 'open' as const };
  });
}

export async function cancelEmergencyRequest(manager: UserDoc, requestId: string) {
  const { emergency } = await managedRequest(manager, requestId);
  if (emergency.status === 'cancelled' || emergency.status === 'expired') throw conflict('This emergency request is already closed', 'INVALID_STATE');
  return mongoose.connection.transaction(async (session) => {
    const request = await EmergencyRequest.findOneAndUpdate({ _id: emergency._id, status: { $in: ['open', 'filled'] } }, { status: 'cancelled' }, { new: true, session });
    if (!request) throw conflict('This emergency request is already closed', 'INVALID_STATE');
    const invitations = await EmergencyInvitation.find({ requestId: request._id, status: { $in: ['pending', 'accepted'] } }).session(session);
    if (invitations.length) {
      await EmergencyInvitation.updateMany({ _id: { $in: invitations.map((invitation) => invitation._id) } }, { status: 'cancelled', respondedAt: new Date() }, { session });
      await Notification.create(invitations.map((invitation) => ({ userId: invitation.studentId, type: 'emergency_request_cancelled', title: 'Emergency request cancelled', message: `The request for "${request.title}" has been cancelled.`, relatedEmergencyInvitationId: invitation._id })), { session, ordered: true });
    }
    await Assignment.updateMany({ emergencyRequestId: request._id, status: 'confirmed' }, { status: 'cancelled', statusReason: 'Emergency request cancelled', decidedBy: manager._id, decidedAt: new Date() }, { session });
    await Activity.updateOne({ _id: request.activityId }, { status: 'cancelled' }, { session });
    await EmergencyAudit.create([{ requestId: request._id, actorId: manager._id, action: 'cancelled' }], { session });
    return { status: 'cancelled' as const, affected: invitations.length };
  });
}
