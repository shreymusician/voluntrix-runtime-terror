import { z } from 'zod';
import type { AppConfig } from './config/env.js';
import { PROMOTION_DECISIONS, PROMOTION_STATUSES, ROLES } from './domain.js';
import { badRequest } from './errors.js';

const fullName = z.string().trim().min(2, 'Enter your full name').max(100);
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const phone = z
  .string()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+?[0-9]{10,15}$/, 'Enter a valid phone number (10–15 digits)'));
const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{3,30}$/, 'Username must be 3–30 characters: letters, numbers, dots or underscores');
// 72 is bcrypt's input limit; longer passwords would be silently truncated.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');
const reason = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(1000);
export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const accountFields = { fullName, email, phone, username, password, confirmPassword: z.string() };
const passwordsMatch = (v: { password: string; confirmPassword: string }) => v.password === v.confirmPassword;
const mismatch = { path: ['confirmPassword'], message: 'Passwords do not match' };

export function buildSchemas(config: AppConfig) {
  const usn = z
    .string()
    .trim()
    .toUpperCase()
    .regex(config.usnPattern, 'Enter a valid USN (for example 1RV21CS001)');

  return {
    studentRegistration: z.object({ ...accountFields, usn }).strict().refine(passwordsMatch, mismatch),

    facultyRegistration: z
      .object({
        ...accountFields,
        facultyId: z
          .string()
          .trim()
          .toUpperCase()
          .regex(config.facultyIdPattern, 'Enter a valid faculty ID')
          // With no approval step, the institution's ID list is what stops
          // an outsider from registering as faculty.
          .refine(
            (v) => !config.facultyIdAllowlist.length || config.facultyIdAllowlist.includes(v.toLowerCase()),
            'This faculty ID is not on the institution faculty list',
          ),
        email: email.refine(
          (v) => config.facultyEmailDomains.includes(v.split('@')[1] ?? ''),
          config.facultyEmailDomains.length
            ? `Use your institutional email (${config.facultyEmailDomains.map((d) => '@' + d).join(', ')})`
            : 'Faculty registration is not available: no institutional email domain is configured',
        ),
      })
      .strict()
      .refine(passwordsMatch, mismatch),

    login: z.object({ username: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(200), role: z.enum(ROLES) }).strict(),

    // The only profile fields a user may change themselves. `.strict()` makes
    // a payload containing role / accountStatus / usn etc. a 400, not a no-op.
    profileUpdate: z
      .object({ fullName: fullName.optional(), phone: phone.optional() })
      .strict()
      .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),

    promotionRequestCreate: z.object({ statement: z.string().trim().max(1000).default(''), usn: usn.optional() }).strict(),
    promotionListQuery: z.object({ status: z.enum(PROMOTION_STATUSES).optional() }),
    promotionDecision: z.object({ decision: z.enum(PROMOTION_DECISIONS), reason }).strict(),
    chatStart: z.object({ participantId: objectId }).strict(),
    chatMessage: z.object({ content: z.string().trim().min(1).max(2000) }).strict(),

  };
}

export type Schemas = ReturnType<typeof buildSchemas>;

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.code === 'unrecognized_keys' ? issue.keys[0] : issue.path.join('.') || '_';
    fields[key] ??= issue.code === 'unrecognized_keys' ? 'This field cannot be set' : issue.message;
  }
  throw badRequest('Some fields are invalid', fields);
}
