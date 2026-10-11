import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import {
  ACCOUNT_STATUSES,
  ATTEMPT_STATUSES,
  DIFFICULTIES,
  EVALUATION_CRITERIA,
  ACTIVE_ASSIGNMENT_STATUSES,
  ACTIVITY_STATUSES,
  ASSIGNMENT_STATUSES,
  EVENT_STATUSES,
  AUDIT_ACTIONS,
  OPEN_PROMOTION_STATUSES,
  PROMOTION_STATUSES,
  ROLES,
  VERIFICATION_STATUSES,
} from './domain.js';

const ref = (model: string, required = true) => ({ type: Schema.Types.ObjectId, ref: model, required });

// ---------------------------------------------------------------- users
const userSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    accountStatus: { type: String, enum: ACCOUNT_STATUSES, required: true, default: 'active' },
    // Id of the credential document holding the password hash.
    // Passwords are never stored on this document.
    authProvider: { type: String, enum: ['local'], required: true },
    authId: { type: String, required: true, unique: true },
    photoKey: { type: String, default: null },
    photoContentType: { type: String, default: null },
  },
  { timestamps: true },
);
export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = mongoose.model('User', userSchema);

// ------------------------------------------------------- studentProfiles
// Kept when a student is promoted, so volunteering history stays attached.
const studentProfileSchema = new Schema(
  {
    userId: { ...ref('User'), unique: true },
    usn: { type: String, required: true, unique: true, uppercase: true, trim: true },
    // ---- volunteer profile (filled in after first login) ----
    department: { type: String, default: null },
    semester: { type: Number, default: null },
    skills: { type: [String], default: [] },
    // Lower-cased skills, the form used for all matching.
    skillKeys: { type: [String], default: [], index: true },
    preferences: { type: [String], default: [] },
    emergencyDiscoveryEnabled: { type: Boolean, default: false },
    availability: {
      type: [new Schema({ date: String, startTime: String, endTime: String }, { _id: false })],
      default: [],
    },
    maxHoursPerDay: { type: Number, default: null },
    profileCompletedAt: { type: Date, default: null },
    // Bumped inside every transaction that adds or confirms an assignment for
    // this student, so two concurrent changes cannot both pass the checks.
    assignmentVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export type StudentProfileDoc = HydratedDocument<InferSchemaType<typeof studentProfileSchema>>;
export const StudentProfile = mongoose.model('StudentProfile', studentProfileSchema);

// ------------------------------------------------------- facultyProfiles
const facultyProfileSchema = new Schema(
  {
    userId: { ...ref('User'), unique: true },
    facultyId: { type: String, required: true, unique: true, uppercase: true, trim: true },
    verificationStatus: { type: String, enum: VERIFICATION_STATUSES, required: true, default: 'pending' },
    verifiedAt: { type: Date, default: null },
    verificationReason: { type: String, default: null },
  },
  { timestamps: true },
);
export const FacultyProfile = mongoose.model('FacultyProfile', facultyProfileSchema);

// ----------------------------------------------------- promotionRequests
const reviewEntrySchema = new Schema(
  {
    status: { type: String, enum: PROMOTION_STATUSES, required: true },
    reviewedBy: ref('User'),
    reason: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const promotionRequestSchema = new Schema(
  {
    studentId: ref('User'),
    requestedBy: ref('User'),
    statement: { type: String, default: '' },
    status: { type: String, enum: PROMOTION_STATUSES, required: true, default: 'pending' },
    // References to the real attendance / feedback records the reviewer saw
    // at decision time. Evidence is never copied or synthesised.
    evidence: { assignmentIds: [ref('Assignment')] },
    reviewedBy: ref('User', false),
    reviewReason: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewHistory: { type: [reviewEntrySchema], default: [] },
  },
  { timestamps: true },
);
// At most one open request per student; this is what makes duplicate
// submissions (double clicks, retries, races) safe.
promotionRequestSchema.index(
  { studentId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: OPEN_PROMOTION_STATUSES } }, name: 'one_open_request_per_student' },
);
promotionRequestSchema.index({ status: 1, createdAt: -1 });
export type PromotionRequestDoc = HydratedDocument<InferSchemaType<typeof promotionRequestSchema>>;
export const PromotionRequest = mongoose.model('PromotionRequest', promotionRequestSchema);

// --------------------------------------------------------- roleAuditLogs
const roleAuditLogSchema = new Schema(
  {
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    userId: ref('User'),
    previousRole: { type: String, enum: [...ROLES, null], default: null },
    newRole: { type: String, enum: ROLES, required: true },
    actorId: ref('User', false),
    // Role the actor held when acting.
    actorRole: { type: String, enum: ROLES, required: true },
    reason: { type: String, required: true },
    promotionRequestId: ref('PromotionRequest', false),
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
roleAuditLogSchema.index({ userId: 1, createdAt: -1 });
export const RoleAuditLog = mongoose.model('RoleAuditLog', roleAuditLogSchema);

// --------------------------------------------------------- notifications
const notificationSchema = new Schema(
  {
    userId: ref('User'),
    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    relatedPromotionRequestId: ref('PromotionRequest', false),
    relatedEmergencyInvitationId: ref('EmergencyInvitation', false),
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ userId: 1, createdAt: -1 });
export const Notification = mongoose.model('Notification', notificationSchema);

// ------------------------------------------------------------- direct chat
const chatThreadSchema = new Schema(
  {
    participants: { type: [ref('User')], required: true, validate: [(v: unknown[]) => v.length === 2, 'Chat threads must have exactly two participants'] },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
chatThreadSchema.index({ participants: 1, updatedAt: -1 });
chatThreadSchema.index({ lastMessageAt: -1 });
export const ChatThread = mongoose.model('ChatThread', chatThreadSchema);

const chatMessageSchema = new Schema(
  {
    threadId: ref('ChatThread'),
    senderId: ref('User'),
    content: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
chatMessageSchema.index({ threadId: 1, createdAt: -1 });
chatMessageSchema.index({ senderId: 1, createdAt: -1 });
export const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

// ---------------------------------------------- temporary volunteer location
const volunteerLocationSchema = new Schema(
  {
    volunteerId: ref('User'),
    eventId: { ...ref('Event', false), default: null },
    sessionId: { type: String, required: true, unique: true },
    scope: { type: String, enum: ['event', 'emergency'], required: true },
    location: {
      type: new Schema(
        {
          type: { type: String, enum: ['Point'], required: true },
          coordinates: { type: [Number], required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    accuracyMeters: { type: Number, default: null, min: 0 },
    locationCapturedAt: { type: Date, default: null },
    sharingEnabled: { type: Boolean, required: true, default: true },
    updatedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    stoppedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
volunteerLocationSchema.index({ location: '2dsphere' });
volunteerLocationSchema.index({ eventId: 1, sharingEnabled: 1, updatedAt: -1 });
volunteerLocationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
volunteerLocationSchema.index(
  { volunteerId: 1 },
  { unique: true, partialFilterExpression: { sharingEnabled: true }, name: 'one_active_location_session_per_volunteer' },
);
export const VolunteerLocation = mongoose.model('VolunteerLocation', volunteerLocationSchema);

// ------------------------------------------------------- emergency discovery
const emergencyRequestSchema = new Schema(
  {
    eventId: ref('Event'),
    activityId: ref('Activity'),
    sourceActivityId: ref('Activity'),
    createdBy: ref('User'),
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    locationLabel: { type: String, required: true, trim: true, maxlength: 300 },
    location: {
      type: new Schema({ type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } }, { _id: false }),
      required: true,
    },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    requiredCount: { type: Number, required: true, min: 1, max: 500 },
    radiusMeters: { type: Number, required: true, min: 250, max: 50_000 },
    urgency: { type: String, enum: ['normal', 'high', 'critical'], required: true },
    instructions: { type: String, default: '', trim: true, maxlength: 1000 },
    specialistSkills: { type: [String], default: [] },
    status: { type: String, enum: ['open', 'filled', 'cancelled', 'expired'], default: 'open', required: true },
  },
  { timestamps: true },
);
emergencyRequestSchema.index({ location: '2dsphere' });
emergencyRequestSchema.index({ eventId: 1, status: 1, startAt: 1 });
emergencyRequestSchema.index({ createdBy: 1, createdAt: -1 });
export type EmergencyRequestDoc = HydratedDocument<InferSchemaType<typeof emergencyRequestSchema>>;
export const EmergencyRequest = mongoose.model('EmergencyRequest', emergencyRequestSchema);

const emergencyInvitationSchema = new Schema(
  {
    requestId: ref('EmergencyRequest'),
    studentId: ref('User'),
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired', 'cancelled'], required: true, default: 'pending' },
    distanceMeters: { type: Number, required: true, min: 0 },
    notifiedAt: { type: Date, required: true, default: Date.now },
    respondedAt: { type: Date, default: null },
    assignmentId: ref('Assignment', false),
  },
  { timestamps: true },
);
emergencyInvitationSchema.index({ requestId: 1, studentId: 1 }, { unique: true, name: 'one_emergency_invite_per_student' });
emergencyInvitationSchema.index({ studentId: 1, status: 1, createdAt: -1 });
emergencyInvitationSchema.index({ requestId: 1, status: 1 });
export const EmergencyInvitation = mongoose.model('EmergencyInvitation', emergencyInvitationSchema);

const emergencyAuditSchema = new Schema(
  {
    requestId: ref('EmergencyRequest'),
    invitationId: ref('EmergencyInvitation', false),
    actorId: ref('User'),
    action: { type: String, enum: ['created', 'invited', 'accepted', 'declined', 'filled', 'cancelled', 'expired', 'opted_out', 'radius_expanded'], required: true },
    details: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
emergencyAuditSchema.index({ requestId: 1, createdAt: -1 });
export const EmergencyAudit = mongoose.model('EmergencyAudit', emergencyAuditSchema);

// -------------------------------------------------------------- sessions
const sessionSchema = new Schema(
  {
    // SHA-256 of the opaque cookie token; the raw token is never stored.
    tokenHash: { type: String, required: true, unique: true },
    userId: ref('User'),
    // Role the user was authorized for at login. If the account's role later
    // changes, the session stops being valid and the user must sign in again.
    role: { type: String, enum: ROLES, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1 });
export const Session = mongoose.model('Session', sessionSchema);

// ----------------------------------------------------------- credentials
// bcrypt password hashes, kept apart from the user documents.
const credentialSchema = new Schema({ passwordHash: { type: String, required: true } }, { timestamps: true });
export const Credential = mongoose.model('Credential', credentialSchema);

// ---------------------------------------------------------------- events
const eventSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    startDate: { type: String, required: true }, // YYYY-MM-DD, institution local
    endDate: { type: String, required: true },
    venue: { type: String, required: true, trim: true },
    // Optional detail beyond the venue name (building, room, street address).
    venueAddress: { type: String, default: '' },
    // GeoJSON Point: coordinates are [longitude, latitude], per the GeoJSON spec.
    venueLocation: {
      type: new Schema({ type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } }, { _id: false }),
      default: null,
    },
    locationUpdatedAt: { type: Date, default: null },
    locationUpdatedBy: ref('User', false),
    status: { type: String, enum: EVENT_STATUSES, required: true, default: 'draft' },
    createdBy: ref('User'),
    // Result of the most recent allocation run, kept so it can be re-read.
    lastAllocation: { type: Schema.Types.Mixed, default: null },
    // Only ever set by the development seed.
    isSampleData: { type: Boolean, default: false },
  },
  { timestamps: true },
);
eventSchema.index({ status: 1, startDate: 1 });
eventSchema.index({ createdBy: 1 });
eventSchema.index({ venueLocation: '2dsphere' });
export type EventDoc = HydratedDocument<InferSchemaType<typeof eventSchema>>;
export const Event = mongoose.model('Event', eventSchema);

// ------------------------------------------------------------ activities
const activitySchema = new Schema(
  {
    eventId: ref('Event'),
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    activityType: { type: String, default: null },
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    // The same interval as real instants; all overlap checks use these.
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    location: { type: String, required: true, trim: true },
    requiredSkills: { type: [String], default: [] },
    requiredSkillKeys: { type: [String], default: [] },
    preferredSkills: { type: [String], default: [] },
    preferredSkillKeys: { type: [String], default: [] },
    requiredCount: { type: Number, required: true, min: 1 },
    minPriorEvents: { type: Number, default: 0, min: 0 },
    // When true, only volunteers who passed this category's mock test may be assigned.
    requireTestPass: { type: Boolean, default: false },
    instructions: { type: String, default: '' },
    status: { type: String, enum: ACTIVITY_STATUSES, required: true, default: 'open' },
    // Bumped whenever a seat is taken, to serialise concurrent capacity checks.
    seatVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);
activitySchema.index({ eventId: 1, startAt: 1 });
export type ActivityDoc = HydratedDocument<InferSchemaType<typeof activitySchema>>;
export const Activity = mongoose.model('Activity', activitySchema);

// ----------------------------------------------------------- assignments
const assignmentSchema = new Schema(
  {
    eventId: ref('Event'),
    activityId: ref('Activity'),
    studentId: ref('User'),
    status: { type: String, enum: ASSIGNMENT_STATUSES, required: true, default: 'pending' },
    source: { type: String, enum: ['auto', 'manual'], required: true },
    score: { type: Number, default: null },
    explanation: { type: [String], default: [] },
    createdBy: ref('User'),
    decidedBy: ref('User', false),
    decidedAt: { type: Date, default: null },
    statusReason: { type: String, default: null },
    emergencyRequestId: ref('EmergencyRequest', false),
    // Recorded by the organizer after the activity; null = not recorded.
    attendance: { type: String, enum: ['attended', 'absent', null], default: null },
  },
  { timestamps: true },
);
// A student holds at most one live (pending or confirmed) seat per activity.
assignmentSchema.index(
  { activityId: 1, studentId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_ASSIGNMENT_STATUSES } }, name: 'one_live_assignment_per_activity' },
);
assignmentSchema.index({ studentId: 1, status: 1 });
assignmentSchema.index({ eventId: 1, status: 1 });
export type AssignmentDoc = HydratedDocument<InferSchemaType<typeof assignmentSchema>>;
export const Assignment = mongoose.model('Assignment', assignmentSchema);

// ---------------------------------------------------------------- photos
const photoSchema = new Schema(
  { key: { type: String, required: true, unique: true }, data: { type: Buffer, required: true }, contentType: { type: String, required: true } },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const Photo = mongoose.model('Photo', photoSchema);

// ------------------------------------------------------------- questions
// The answer key (correctIndex) never leaves the server before submission.
const questionSchema = new Schema(
  {
    category: { type: String, required: true, index: true },
    text: { type: String, required: true, trim: true },
    topic: { type: String, required: true, trim: true },
    difficulty: { type: String, enum: DIFFICULTIES, required: true },
    options: { type: [String], required: true },
    correctIndex: { type: Number, required: true, min: 0 },
    explanation: { type: String, default: '' },
    marks: { type: Number, required: true, min: 1, max: 10, default: 1 },
    active: { type: Boolean, required: true, default: true },
    // Set on the built-in questions so re-running the loader never duplicates them.
    seedKey: { type: String, default: undefined },
    updatedBy: ref('User', false),
  },
  { timestamps: true },
);
questionSchema.index({ seedKey: 1 }, { unique: true, sparse: true });
export type QuestionDoc = HydratedDocument<InferSchemaType<typeof questionSchema>>;
export const Question = mongoose.model('Question', questionSchema);

// ----------------------------------------------------------- testConfigs
// One optional override document per category; defaults live in services/tests.ts.
const testConfigSchema = new Schema(
  {
    category: { type: String, required: true, unique: true },
    durationMinutes: { type: Number, required: true, min: 1, max: 180 },
    questionCount: { type: Number, required: true, min: 1, max: 100 },
    passingPercent: { type: Number, required: true, min: 0, max: 100 },
    maxAttempts: { type: Number, required: true, min: 1, max: 20 },
    qualifyingAttempt: { type: String, enum: ['best', 'latest'], required: true },
    showAnswers: { type: String, enum: ['never', 'after_final_attempt', 'always'], required: true },
    active: { type: Boolean, required: true, default: true },
    updatedBy: ref('User', false),
  },
  { timestamps: true },
);
export const TestConfig = mongoose.model('TestConfig', testConfigSchema);

// ---------------------------------------------------------- testAttempts
const attemptQuestionSchema = new Schema(
  {
    questionId: ref('Question'),
    // A copy taken when the attempt starts, so later edits to the bank
    // cannot change what was asked or how it is marked.
    text: { type: String, required: true },
    topic: { type: String, required: true },
    difficulty: { type: String, required: true },
    options: { type: [String], required: true },
    correctIndex: { type: Number, required: true },
    explanation: { type: String, default: '' },
    marks: { type: Number, required: true },
    selectedIndex: { type: Number, default: null },
    markedForReview: { type: Boolean, default: false },
  },
  { _id: false },
);

const testAttemptSchema = new Schema(
  {
    studentId: ref('User'),
    category: { type: String, required: true },
    // Set when this attempt was unlocked from a specific activity's eligibility
    // check (as opposed to the general preference-based practice flow). Used to
    // re-validate eligibility at submission time.
    activityId: ref('Activity', false),
    attemptNumber: { type: Number, required: true },
    status: { type: String, enum: ATTEMPT_STATUSES, required: true, default: 'in_progress' },
    startedAt: { type: Date, required: true },
    // Decided by the server when the attempt starts; the browser clock is never trusted.
    deadlineAt: { type: Date, required: true },
    submittedAt: { type: Date, default: null },
    // True when the time ran out and the server closed the attempt itself.
    autoSubmitted: { type: Boolean, default: false },
    passingPercent: { type: Number, required: true },
    questions: { type: [attemptQuestionSchema], required: true },
    result: {
      type: new Schema(
        {
          totalMarks: Number,
          marksObtained: Number,
          percent: Number,
          correct: Number,
          incorrect: Number,
          unanswered: Number,
          passed: Boolean,
          topics: [new Schema({ topic: String, totalMarks: Number, marksObtained: Number, questions: Number, correct: Number }, { _id: false })],
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);
// Attempt numbers are unique per student and category, so two simultaneous
// "start" requests cannot both create an attempt (or exceed the limit).
testAttemptSchema.index({ studentId: 1, category: 1, attemptNumber: 1 }, { unique: true });
testAttemptSchema.index(
  { studentId: 1, category: 1 },
  { unique: true, partialFilterExpression: { status: 'in_progress' }, name: 'one_open_attempt_per_category' },
);
testAttemptSchema.index({ category: 1, status: 1 });
export type TestAttemptDoc = HydratedDocument<InferSchemaType<typeof testAttemptSchema>>;
export const TestAttempt = mongoose.model('TestAttempt', testAttemptSchema);

// ------------------------------------------------ performanceEvaluations
const criteriaShape = Object.fromEntries(EVALUATION_CRITERIA.map((c) => [c, { type: Number, required: true, min: 1, max: 5 }]));

const performanceEvaluationSchema = new Schema(
  {
    assignmentId: ref('Assignment'),
    studentId: ref('User'),
    eventId: ref('Event'),
    activityId: ref('Activity'),
    reviewerId: ref('User'),
    criteria: { type: new Schema(criteriaShape, { _id: false }), required: true },
    overall: { type: Number, required: true, min: 1, max: 5 },
    feedback: { type: String, default: '' },
    status: { type: String, enum: ['submitted', 'corrected'], required: true, default: 'submitted' },
  },
  { timestamps: true },
);
// One evaluation per reviewer per assignment; changes go through the correction route.
performanceEvaluationSchema.index({ assignmentId: 1, reviewerId: 1 }, { unique: true });
performanceEvaluationSchema.index({ studentId: 1 });
performanceEvaluationSchema.index({ eventId: 1 });
export type PerformanceEvaluationDoc = HydratedDocument<InferSchemaType<typeof performanceEvaluationSchema>>;
export const PerformanceEvaluation = mongoose.model('PerformanceEvaluation', performanceEvaluationSchema);

// ----------------------------------------------------------- ratingAudits
const ratingAuditSchema = new Schema(
  {
    evaluationId: ref('PerformanceEvaluation'),
    action: { type: String, enum: ['created', 'corrected'], required: true },
    actorId: ref('User'),
    reason: { type: String, default: '' },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ratingAuditSchema.index({ evaluationId: 1, createdAt: 1 });
export const RatingAudit = mongoose.model('RatingAudit', ratingAuditSchema);
