import 'dotenv/config';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function pattern(name: string, fallback: string): RegExp {
  return new RegExp(process.env[name] || fallback);
}

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  mongoUri: string;
  clientOrigins: string[];
  sessionTtlHours: number;
  cookieName: string;
  maxPhotoBytes: number;
  usnPattern: RegExp;
  facultyIdPattern: RegExp;
  facultyEmailDomains: string[];
  /** When non-empty, only these faculty IDs may register (lower-cased). */
  facultyIdAllowlist: string[];
  /** Offset of the institution's wall clock from UTC (India: +330). */
  utcOffsetMinutes: number;
  /** Upper bound a student may set for their own daily volunteering hours. */
  maxHoursPerDayLimit: number;
  maxSkills: number;
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: int('PORT', 4000),
    mongoUri: process.env.MONGODB_URI ?? '',
    clientOrigins: list('CLIENT_ORIGINS').length ? list('CLIENT_ORIGINS') : ['http://localhost:5173'],
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    cookieName: 'vtx_session',
    maxPhotoBytes: int('MAX_PHOTO_BYTES', 2 * 1024 * 1024),
    // VTU-style USN by default (e.g. 1RV21CS001); override for other institutions.
    usnPattern: pattern('USN_PATTERN', '^[1-4][A-Z]{2}\\d{2}[A-Z]{2,3}\\d{3}$'),
    facultyIdPattern: pattern('FACULTY_ID_PATTERN', '^[A-Z0-9][A-Z0-9-]{2,19}$'),
    facultyEmailDomains: list('FACULTY_EMAIL_DOMAINS'),
    facultyIdAllowlist: list('FACULTY_ID_ALLOWLIST'),
    utcOffsetMinutes: int('APP_UTC_OFFSET_MINUTES', 330),
    maxHoursPerDayLimit: int('MAX_VOLUNTEER_HOURS_PER_DAY', 12),
    maxSkills: int('MAX_SKILLS_PER_PROFILE', 15),
  };
}
