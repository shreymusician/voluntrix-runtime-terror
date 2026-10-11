export const ROLES = ['student', 'faculty', 'organizer'] as const;
export type Role = (typeof ROLES)[number];

export const ACCOUNT_STATUSES = ['active', 'suspended'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const VERIFICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const PROMOTION_STATUSES = ['pending', 'needs_review', 'approved', 'rejected'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** Statuses in which a promotion request is still awaiting a final decision. */
export const OPEN_PROMOTION_STATUSES: PromotionStatus[] = ['pending', 'needs_review'];

export const PROMOTION_DECISIONS = ['approve', 'reject', 'needs_review'] as const;
export type PromotionDecision = (typeof PROMOTION_DECISIONS)[number];

/** Allowed promotion-request transitions. approved / rejected are terminal. */
const PROMOTION_TRANSITIONS: Record<PromotionStatus, PromotionStatus[]> = {
  pending: ['approved', 'rejected', 'needs_review'],
  needs_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export function canTransitionPromotion(from: PromotionStatus, to: PromotionStatus): boolean {
  return PROMOTION_TRANSITIONS[from].includes(to);
}

export const DECISION_TO_STATUS: Record<PromotionDecision, PromotionStatus> = {
  approve: 'approved',
  reject: 'rejected',
  needs_review: 'needs_review',
};

/**
 * Every role change in the system must match one of these entries. `via` is
 * the only code path allowed to perform it, so e.g. student -> organizer can
 * only ever happen through an approved faculty promotion.
 */
export type RoleChangeChannel = 'faculty_promotion';

const ROLE_TRANSITIONS: { from: Role; to: Role; via: RoleChangeChannel }[] = [
  { from: 'student', to: 'organizer', via: 'faculty_promotion' },
];

export function isRoleTransitionAllowed(from: Role, to: Role, via: RoleChangeChannel): boolean {
  return ROLE_TRANSITIONS.some((t) => t.from === from && t.to === to && t.via === via);
}

export const AUDIT_ACTIONS = ['organizer_promotion'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const EVENT_STATUSES = ['draft', 'published', 'completed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const ACTIVITY_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const ASSIGNMENT_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** Statuses in which an assignment occupies a seat and the volunteer's time. */
export const ACTIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = ['pending', 'confirmed'];

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const ATTEMPT_STATUSES = ['in_progress', 'submitted'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** The six criteria of a post-event performance evaluation, each rated 1-5. */
export const EVALUATION_CRITERIA = ['taskCompletion', 'punctuality', 'communication', 'teamwork', 'responsibility', 'problemSolving'] as const;
export type EvaluationCriterion = (typeof EVALUATION_CRITERIA)[number];
