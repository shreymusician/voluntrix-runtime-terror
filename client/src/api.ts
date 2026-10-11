export type Role = 'student' | 'faculty' | 'organizer';
export type PromotionStatus = 'pending' | 'needs_review' | 'approved' | 'rejected';
export type Decision = 'approve' | 'reject' | 'needs_review';

export interface User {
  id: string;
  fullName: string;
  username: string;
  email: string;
  phone: string;
  role: Role;
  accountStatus: string;
  hasPhoto: boolean;
  createdAt: string;
}

export interface PromotionSummary {
  id: string;
  status: PromotionStatus;
  statement: string;
  createdAt: string;
  reviewReason: string | null;
  reviewedAt: string | null;
}

export interface Me {
  user: User;
  studentProfile: { usn: string; profileComplete: boolean } | null;
  facultyProfile: { facultyId: string; verificationStatus: string } | null;
  promotionRequests: PromotionSummary[];
}

export interface StudentSummary {
  id: string;
  fullName: string;
  username: string;
  email: string;
  usn: string | null;
  role: Role;
  accountStatus: string;
  hasPhoto: boolean;
  memberSince: string;
}

export interface EvidenceRecord {
  id: string;
  eventTitle: string;
  roleTitle: string;
  eventDate: string;
  status: 'attended' | 'absent' | 'not_recorded';
  isTestData: boolean;
  feedback: { id: string; rating: number; comments: string; isTestData: boolean } | null;
}

export interface PromotionListItem extends PromotionSummary {
  student: StudentSummary;
}

export interface PromotionDetail extends PromotionListItem {
  evidence: {
    records: EvidenceRecord[];
    summary: {
      recordedEvents: number;
      attendedEvents: number;
      attendanceRate: number | null;
      feedbackCount: number;
      attendedEventsMissingFeedback: number;
      averageRating: number | null;
      containsTestData: boolean;
    };
  };
  eligibility: { eligible: boolean; checks: { id: string; label: string; passed: boolean; detail: string }[] };
  policy: { enforceOnApproval: boolean };
  allowedDecisions: Decision[];
  reviewHistory: { status: PromotionStatus; reason: string; at: string; reviewedBy: string }[];
  auditHistory: {
    id: string;
    action: string;
    previousRole: Role | null;
    newRole: Role;
    actor: string;
    actorRole: string;
    reason: string;
    at: string;
  }[];
}

export interface Notice {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
    /** The raw details object, e.g. suggested alternatives on a refused confirmation. */
    public details: unknown = undefined,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? (options.body !== undefined || options.form ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fields = data.details && typeof data.details === 'object' && !Array.isArray(data.details) ? data.details : {};
    throw new ApiError(res.status, data.code ?? 'ERROR', data.error ?? 'Something went wrong. Please try again.', fields, data.details);
  }
  return data as T;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Please try again.');

// ------------------------------------------------------------ phase 2 types

export interface Meta {
  suggestedSkills: string[];
  activityTypes: string[];
  departments: string[];
  semesters: number[];
  limits: { maxSkills: number; maxSkillLength: number; maxHoursPerDay: number; maxAvailabilitySlots: number };
}

export interface AvailabilitySlot {
  date: string;
  startTime: string;
  endTime: string;
}

export interface VolunteerProfile {
  fullName: string;
  email: string;
  phone: string;
  usn: string;
  department: string | null;
  semester: number | null;
  skills: string[];
  preferences: string[];
  availability: AvailabilitySlot[];
  maxHoursPerDay: number | null;
  complete: boolean;
  completion: { percent: number; missing: string[] };
}

export type EventStatus = 'draft' | 'published' | 'completed' | 'cancelled';
export type ActivityStatus = 'open' | 'closed' | 'cancelled';
export type AssignmentStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled';

/** The minimal event identity + map data embedded wherever an event is summarised. */
export interface EventMapInfo {
  id: string;
  name: string;
  venue: string;
  venueAddress: string | null;
  venueLocation: { latitude: number; longitude: number } | null;
  locationUpdatedAt: string | null;
}

export interface StudentEventMap extends EventMapInfo {
  description: string;
  startDate: string;
  endDate: string;
}

export interface EventSummary {
  id: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  venue: string;
  status: EventStatus;
  isSampleData: boolean;
  activityCount?: number;
  positionsRequired?: number;
  positionsFilled?: number;
  venueAddress: string | null;
  venueLocation: { latitude: number; longitude: number } | null;
  locationUpdatedAt: string | null;
}

export interface Activity {
  id: string;
  eventId: string;
  name: string;
  description: string;
  activityType: string | null;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  requiredSkills: string[];
  preferredSkills: string[];
  requiredCount: number;
  minPriorEvents: number;
  requireTestPass: boolean;
  instructions: string;
  status: ActivityStatus;
}

export interface ManagedActivity extends Activity {
  pending: number;
  confirmed: number;
  vacancies: number;
}

export interface AllocationReport {
  generatedAt: string;
  generatedBy: string;
  totalVolunteers: number;
  clearedPending: number;
  activities: {
    activityId: string;
    name: string;
    date: string;
    startTime: string;
    endTime: string;
    required: number;
    alreadyAssigned: number;
    newlyAssigned: { studentId: string; fullName: string; usn: string; score: number; explanation: string[] }[];
    assigned: number;
    vacancies: number;
    status: 'filled' | 'shortage' | 'skipped';
    shortageReason: string | null;
    warnings: string[];
  }[];
}

export interface EventDetail extends EventSummary {
  lastAllocation: AllocationReport | null;
  activities: ManagedActivity[];
}

export interface AssignmentBase {
  id: string;
  status: AssignmentStatus;
  source: 'auto' | 'manual';
  statusReason: string | null;
  attendance: 'attended' | 'absent' | null;
  /** Average overall rating from post-event evaluations, if any. */
  rating: number | null;
  hours: number;
  ended: boolean;
  started: boolean;
  activity: { id: string; name: string; date: string; startTime: string; endTime: string; location: string; instructions: string; requiredCount: number };
  event: EventMapInfo;
}

export interface ManagedAssignment extends AssignmentBase {
  score: number | null;
  explanation: string[];
  issues: string[];
  student: { id: string; fullName: string; usn: string };
}

export interface AvailableActivity extends Activity {
  event: EventMapInfo;
  vacancies: number;
  myStatus: 'pending' | 'confirmed' | null;
  eligible: boolean;
  canRequest: boolean;
  reasons: string[];
  testRequired: boolean;
  testCategory: string | null;
  /** 'locked' = still has other unmet requirements; 'available' = otherwise eligible, test not yet taken. */
  testStatus: 'not_required' | 'locked' | 'available' | 'in_progress' | 'passed' | 'failed';
  testLockedReasons: string[];
  testAttemptId: string | null;
  testResultPercent: number | null;
}

/** A vacant position offered by the discovery popup. A vacancy is never eligibility. */
export interface VacantOpportunity extends Activity {
  event: EventMapInfo;
  confirmedCount: number;
  pendingCount: number;
  vacancies: number;
  myStatus: 'pending' | 'confirmed' | null;
  eligible: boolean;
  canRequest: boolean;
  kind: 'eligible' | 'explore';
  reasons: string[];
  matchesPreference: boolean;
  suggestionReason: string;
  eligibilityRequirements: {
    requiredSkills: string[];
    preferredSkills: string[];
    minPriorEvents: number;
    requiresTestPass: boolean;
    testCategory: string | null;
    schedule: { date: string; startTime: string; endTime: string; location: string };
  };
}

export interface VacancyDiscovery {
  eligibleForAnyActivity: boolean;
  opportunities: VacantOpportunity[];
  totalVacancies: number;
}

export interface StudentDashboardData {
  profile: { complete: boolean; completion: { percent: number; missing: string[] }; skills: string[] };
  upcomingEvents: EventSummary[];
  availableActivities: AvailableActivity[];
  pendingAssignments: AssignmentBase[];
  confirmedAssignments: AssignmentBase[];
  schedule: AssignmentBase[];
  totals: { completedHours: number; upcomingHours: number; completedActivities: number };
}

export interface Candidate {
  id: string;
  fullName: string;
  usn: string;
  department: string | null;
  skills: string[];
}

export interface Candidates {
  eligible: (Candidate & { score: number; explanation: string[] })[];
  ineligible: (Candidate & { reasons: string[] })[];
}

export interface VolunteerRow {
  id: string;
  fullName: string;
  usn: string;
  email: string;
  phone: string;
  department: string | null;
  semester: number | null;
  skills: string[];
  preferences: string[];
  availability: AvailabilitySlot[];
  maxHoursPerDay: number | null;
  profileComplete: boolean;
  attendedCount: number;
  assignedHours: number;
  liveAssignments: number;
}

export interface Analytics {
  totals: {
    volunteers: number;
    volunteersWithCompleteProfile: number;
    events: number;
    activities: number;
    positionsRequired: number;
    positionsAssigned: number;
    positionsConfirmed: number;
    pendingApprovals: number;
    vacancies: number;
    conflicts: number;
  };
  activityAllocation: { activityId: string; name: string; eventName: string; date: string; required: number; confirmed: number; pending: number; vacancies: number; upcoming: boolean }[];
  understaffed: { activityId: string; name: string; eventName: string; date: string; required: number; vacancies: number }[];
  skillDistribution: { skill: string; volunteers: number }[];
  workloadDistribution: { label: string; volunteers: number }[];
  events: EventSummary[];
}

// ------------------------------------------------------------ phase 3 types

export interface AttemptSummary {
  id: string;
  category: string;
  attemptNumber: number;
  status: 'in_progress' | 'submitted';
  startedAt: string;
  submittedAt: string | null;
  autoSubmitted: boolean;
  result: { totalMarks: number; marksObtained: number; percent: number; correct: number; incorrect: number; unanswered: number; passed: boolean } | null;
}

export interface TestCard {
  category: string;
  durationMinutes: number;
  questionCount: number;
  passingPercent: number;
  maxAttempts: number;
  qualifyingAttempt: 'best' | 'latest';
  preferred: boolean;
  allowed: boolean;
  blockedReason: string | null;
  attemptsUsed: number;
  attemptsLeft: number;
  canStart: boolean;
  inProgressAttemptId: string | null;
  latest: AttemptSummary | null;
  qualifying: { attemptId: string; percent: number; passed: boolean } | null;
}

export interface MyRank {
  category: string;
  rank: number | null;
  total: number;
  testPercent: number;
  passed: boolean;
}

export interface RunningQuestion {
  questionId: string;
  text: string;
  topic: string;
  options: string[];
  marks: number;
  selectedIndex: number | null;
  markedForReview: boolean;
}

export interface RunningAttempt extends AttemptSummary {
  deadlineAt: string;
  remainingSeconds: number;
  passingPercent: number;
  questions: RunningQuestion[];
}

export interface AttemptResult extends AttemptSummary {
  durationSeconds: number | null;
  passingPercent: number;
  attemptsLeft: number;
  topics: { topic: string; totalMarks: number; marksObtained: number; questions: number; correct: number; percent: number }[];
  suggestions: string[];
  answersRevealed: boolean;
  review: { text: string; topic: string; marks: number; options: string[]; selectedIndex: number | null; correct: boolean; correctIndex?: number; explanation?: string }[];
}

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  isMe: boolean;
  category: string;
  testPercent: number;
  skillMatch: number;
  history: { label: string; score: number; provisional: boolean };
  overall: number;
  eligible: boolean;
  eligibility: string;
  // Organizer-only fields
  studentId?: string;
  usn?: string;
  department?: string | null;
  reasons?: string[];
  historyCount?: number;
  attemptsUsed?: number;
  skills?: string[];
}

export interface Leaderboard {
  category: string;
  activity: { id: string; name: string; eventName: string } | null;
  weights: { test: number; skills: number; history: number };
  historyPolicy: { neutralBaseline: number; priorWeight: number; provisionalBelow: number };
  relevantSkills: string[];
  total: number;
  myRank: number | null;
  entries: LeaderboardEntry[];
  generatedAt: string;
}

export type CriterionKey = 'taskCompletion' | 'punctuality' | 'communication' | 'teamwork' | 'responsibility' | 'problemSolving';

export interface Evaluation {
  id: string;
  assignmentId: string;
  criteria: Record<CriterionKey, number>;
  overall: number;
  feedback: string;
  status: 'submitted' | 'corrected';
  submittedAt: string;
  updatedAt: string;
  activity: { id: string; name: string; date: string; activityType: string | null } | null;
  event: { id: string; name: string };
  reviewer: { name: string; role: string };
  student?: { id: string; fullName: string; usn: string };
}

export interface AwaitingEvaluation {
  assignmentId: string;
  attendance: 'attended' | 'absent' | null;
  student: { id: string; fullName: string; usn: string };
  activity: { id: string; name: string; date: string; activityType: string | null };
  event: { id: string; name: string };
}

export interface BankQuestion {
  id: string;
  category: string;
  text: string;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  options: string[];
  correctIndex: number;
  explanation: string;
  marks: number;
  active: boolean;
  builtIn: boolean;
}

export interface TestSettings {
  category: string;
  durationMinutes: number;
  questionCount: number;
  passingPercent: number;
  maxAttempts: number;
  qualifyingAttempt: 'best' | 'latest';
  showAnswers: 'never' | 'after_final_attempt' | 'always';
  active: boolean;
}

export interface PerformanceSummary {
  participation: { students: number; studentsTested: number; attempts: number; awaitingEvaluation: number; completedEvaluations: number };
  byCategory: { category: string; participants: number; attempts: number; averagePercent: number | null; passRate: number | null }[];
  recentResults: { id: string; student: { id: string; fullName: string; usn: string }; category: string; attemptNumber: number; percent: number; passed: boolean; autoSubmitted: boolean; submittedAt: string }[];
  students: {
    id: string;
    fullName: string;
    usn: string;
    department: string | null;
    profileComplete: boolean;
    testsTaken: number;
    results: { category: string; percent: number; passed: boolean }[];
    history: { label: string; score: number; provisional: boolean; count: number; average: number | null };
    attendedCount: number;
    promotion: { mayBeReady: boolean; openRequest: boolean; notes: string[] };
  }[];
}
