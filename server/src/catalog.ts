/** Fixed option lists and the normalisation rules shared by profiles, activities and allocation. */

export const SUGGESTED_SKILLS = [
  'Communication',
  'Leadership',
  'Teamwork',
  'Event Management',
  'Technical Support',
  'Programming',
  'Web Development',
  'Networking',
  'Registration Management',
  'Crowd Management',
  'Hospitality',
  'Public Relations',
  'Photography',
  'Graphic Design',
  'First Aid',
  'Logistics',
  'Stage Management',
  'Social Media Management',
] as const;

/** Activity categories. Preferences, activities, mock tests and rankings all use these. */
export const ACTIVITY_TYPES = [
  'Technical Support',
  'Registration Management',
  'Crowd Management',
  'Hospitality',
  'Stage Management',
  'Event Management',
  'Logistics',
  'Public Relations',
  'Photography and Media',
  'Social Media Management',
  'First Aid',
] as const;
export type ActivityCategory = (typeof ACTIVITY_TYPES)[number];

/** Earlier names of categories, mapped to their current ones (see scripts/migrate.ts). */
export const RENAMED_ACTIVITY_TYPES: Record<string, ActivityCategory> = {
  Registration: 'Registration Management',
  Photography: 'Photography and Media',
};

export function normalizeActivityType(value: unknown): ActivityCategory | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = skillKey(trimmed);
  const direct = ACTIVITY_TYPES.find((category) => skillKey(category) === key);
  if (direct) return direct;
  const legacy = Object.entries(RENAMED_ACTIVITY_TYPES).find(([name]) => skillKey(name) === key);
  return legacy ? legacy[1] : null;
}

/**
 * Profile skills that count as relevant to each category. Used for the
 * skill-match part of a category ranking when no specific activity (with its
 * own required skills) has been chosen.
 */
export const CATEGORY_SKILLS: Record<ActivityCategory, string[]> = {
  'Technical Support': ['Technical Support', 'Programming', 'Networking', 'Web Development'],
  'Registration Management': ['Registration Management', 'Communication', 'Teamwork'],
  'Crowd Management': ['Crowd Management', 'Communication', 'Leadership', 'First Aid'],
  Hospitality: ['Hospitality', 'Communication', 'Public Relations'],
  'Stage Management': ['Stage Management', 'Event Management', 'Teamwork', 'Technical Support'],
  'Event Management': ['Event Management', 'Leadership', 'Logistics', 'Communication'],
  Logistics: ['Logistics', 'Teamwork', 'Event Management'],
  'Public Relations': ['Public Relations', 'Communication', 'Social Media Management'],
  'Photography and Media': ['Photography', 'Graphic Design', 'Social Media Management'],
  'Social Media Management': ['Social Media Management', 'Graphic Design', 'Photography', 'Public Relations'],
  'First Aid': ['First Aid', 'Communication', 'Crowd Management'],
};

export const DEPARTMENTS = [
  'Computer Science & Engineering',
  'Information Science & Engineering',
  'Artificial Intelligence & Machine Learning',
  'Electronics & Communication Engineering',
  'Electrical & Electronics Engineering',
  'Mechanical Engineering',
  'Civil Engineering',
  'MBA',
  'MCA',
  'Other',
] as const;

export const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const MAX_SKILL_LENGTH = 40;
export const MAX_AVAILABILITY_SLOTS = 60;

/** The form a skill is compared in: case and spacing never make two skills different. */
export const skillKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const SUGGESTED_BY_KEY = new Map<string, string>(SUGGESTED_SKILLS.map((s) => [skillKey(s), s]));

export interface SkillListResult {
  skills: string[];
  error?: string;
}

/**
 * Trims, collapses whitespace, de-duplicates case-insensitively and applies
 * the length and count limits. Known skills get their canonical spelling so
 * "leadership" and "Leadership " are stored identically.
 */
export function normalizeSkills(input: unknown, maxCount: number): SkillListResult {
  if (!Array.isArray(input)) return { skills: [], error: 'Skills must be a list' };
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { skills: [], error: 'Each skill must be text' };
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) return { skills: [], error: 'Skill names cannot be empty' };
    if (name.length > MAX_SKILL_LENGTH) return { skills: [], error: `Skill names can be at most ${MAX_SKILL_LENGTH} characters` };
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .+#&/'-]*$/u.test(name)) return { skills: [], error: `"${name}" contains characters that are not allowed` };
    const key = skillKey(name);
    if (seen.has(key)) continue; // duplicates (any capitalisation) collapse into one
    seen.add(key);
    skills.push(SUGGESTED_BY_KEY.get(key) ?? name);
  }
  if (skills.length > maxCount) return { skills: [], error: `You can list at most ${maxCount} skills` };
  return { skills };
}

// ---------------------------------------------------------------- date/time
// Dates and times are entered as local wall-clock values for the institution
// and converted with one fixed UTC offset, so every comparison in the system
// is between real instants rather than strings.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const isValidTime = (value: unknown): value is string => typeof value === 'string' && TIME_RE.test(value);

export const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function toInstant(date: string, time: string, utcOffsetMinutes: number): Date {
  return new Date(Date.parse(`${date}T${time}:00Z`) - utcOffsetMinutes * 60_000);
}

/** Today's calendar date at the institution. */
export function localToday(utcOffsetMinutes: number, now = Date.now()): string {
  return new Date(now + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export const hoursBetween = (start: Date, end: Date) => (end.getTime() - start.getTime()) / 3_600_000;
