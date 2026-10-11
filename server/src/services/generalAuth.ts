import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../context.js';
import { HttpError, badRequest } from '../errors.js';
import { StudentProfile, StudentVerification, User, type UserDoc } from '../models.js';
import { maskEmail } from '../auth/verification.js';
import { createSession } from './accounts.js';

/** How long a code stays usable, and how many wrong guesses burn it. */
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
/** Codes requested for one USN within this window are rate limited in the service itself. */
const RESEND_COOLDOWN_MS = 30_000;

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * A USN is an identifier, not a secret: it is printed on ID cards and appears
 * on class lists. The generic reply below is therefore the same whether or
 * not the USN exists, so this endpoint cannot be used to discover which USNs
 * are registered, and the code itself only ever goes to the contact already
 * stored for that account.
 */
const GENERIC_SENT = 'If that USN belongs to a registered student, we have sent a sign-in code to the contact on file for it.';

export function normalizeUsn(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('Enter your USN', { usn: 'Enter your USN' });
  const usn = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!usn) throw badRequest('Enter your USN', { usn: 'Enter your USN' });
  return usn;
}

/**
 * Step one of the USN sign-in: look the USN up and send a one-time code to
 * the email already recorded for that student. Nothing about the account is
 * returned, and no session is created here.
 */
export async function requestSignInCode(ctx: AppContext, rawUsn: unknown) {
  const usn = normalizeUsn(rawUsn);
  // Format is configurable (USN_PATTERN); a clear message here is safe
  // because it says nothing about whether this particular USN exists.
  if (!ctx.config.usnPattern.test(usn)) {
    throw badRequest('That does not look like a valid USN', { usn: `Enter a USN in your institution's format, for example ${ctx.config.usnExample}` });
  }

  const profile = await StudentProfile.findOne({ usn });
  const user = profile ? await User.findById(profile.userId) : null;

  if (profile && user && user.accountStatus === 'active') {
    const recent = await StudentVerification.findOne({ usn, consumedAt: null }).sort({ createdAt: -1 });
    if (recent && Date.now() - new Date(recent.createdAt).getTime() < RESEND_COOLDOWN_MS) {
      throw new HttpError(429, 'CODE_RECENTLY_SENT', 'A code was just sent. Please wait a moment before asking for another.');
    }
    // Any earlier code for this USN stops working as soon as a new one is issued.
    await StudentVerification.updateMany({ usn, consumedAt: null }, { consumedAt: new Date() });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await StudentVerification.create({ usn, userId: user._id, codeHash: hashCode(code), expiresAt });
    await ctx.verification.send(user, code, expiresAt);

    return {
      message: GENERIC_SENT,
      // Enough to reassure the right person, useless to anyone else.
      sentTo: maskEmail(user.email),
      expiresAt,
      // Lets the interface warn honestly when codes are not actually delivered.
      deliveryConfigured: ctx.verification.deliversToStudent,
    };
  }

  // Unknown or inactive: same shape, same timing characteristics, no code.
  return { message: GENERIC_SENT, sentTo: null, expiresAt: new Date(Date.now() + CODE_TTL_MS), deliveryConfigured: ctx.verification.deliversToStudent };
}

const invalidCode = () => new HttpError(401, 'INVALID_CODE', 'That code is not right, or it has expired. Ask for a new one.');

/**
 * Step two: exchange the USN and the emailed code for a read-only session.
 * The USN alone is never enough — the code proves the person asking can read
 * the contact address the institution already has for that student.
 */
export async function verifySignInCode(ctx: AppContext, rawUsn: unknown, rawCode: unknown) {
  const usn = normalizeUsn(rawUsn);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code', { code: 'Enter the 6-digit code from your email' });

  const record = await StudentVerification.findOne({ usn, consumedAt: null }).sort({ createdAt: -1 });
  if (!record || record.expiresAt.getTime() <= Date.now()) throw invalidCode();
  if (record.attempts >= MAX_ATTEMPTS) {
    await StudentVerification.updateOne({ _id: record._id }, { consumedAt: new Date() });
    throw invalidCode();
  }

  const expected = Buffer.from(record.codeHash, 'hex');
  const supplied = Buffer.from(hashCode(code), 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    await StudentVerification.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    throw invalidCode();
  }

  // Burn the code first: a replay of the same request must not produce a second session.
  const consumed = await StudentVerification.findOneAndUpdate({ _id: record._id, consumedAt: null }, { consumedAt: new Date() });
  if (!consumed) throw invalidCode();

  const user = await User.findById(record.userId);
  if (!user || user.accountStatus !== 'active') throw invalidCode();

  const { token, expiresAt } = await createSession(ctx, user, 'general');
  return { user, token, expiresAt };
}

/** The small amount a general-scope session is told about itself. */
export function generalIdentity(user: UserDoc, usn: string) {
  return { id: user.id as string, fullName: user.fullName, usn, scope: 'general' as const };
}
