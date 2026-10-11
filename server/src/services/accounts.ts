import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import type { AppContext } from '../context.js';
import type { Role } from '../domain.js';
import { HttpError, conflict, forbidden } from '../errors.js';
import { FacultyProfile, Session, StudentProfile, User, type UserDoc } from '../models.js';
import { inspectPhoto } from '../storage/photoStorage.js';

export function publicUser(user: UserDoc) {
  return {
    id: user.id as string,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role as Role,
    accountStatus: user.accountStatus,
    hasPhoto: Boolean(user.photoKey),
    createdAt: user.createdAt,
  };
}

const DUPLICATE_MESSAGES: Record<string, string> = {
  username: 'This username is already taken',
  email: 'This email is already registered',
  usn: 'This USN is already registered',
  facultyId: 'This faculty ID is already registered',
};

function duplicateError(field: string) {
  return conflict('An account with these details already exists', 'DUPLICATE', {
    [field]: DUPLICATE_MESSAGES[field] ?? 'Already in use',
  });
}

/** Maps a MongoDB duplicate-key error (lost race on a unique index) to a 409. */
function rethrowDuplicate(err: unknown): never {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e?.code === 11000) throw duplicateError(Object.keys(e.keyPattern ?? {})[0] ?? 'username');
  throw err;
}

interface AccountInput {
  fullName: string;
  email: string;
  phone: string;
  username: string;
  password: string;
}

type RegistrationInput =
  | (AccountInput & { kind: 'student'; usn: string })
  | (AccountInput & { kind: 'faculty'; facultyId: string });

/**
 * Creates the auth identity, the user and the role-specific profile. Mongo
 * writes are transactional; the auth identity and stored photo are removed
 * again if anything fails, so a failed registration leaves nothing behind.
 *
 * There is no approval step: a faculty account is active as soon as its
 * faculty ID and institutional email pass validation (see validation.ts),
 * so that validation is the only gate on faculty privileges.
 */
export async function registerAccount(ctx: AppContext, input: RegistrationInput, photo?: Buffer) {
  // Friendly pre-checks; the unique indexes remain the real guarantee.
  if (await User.exists({ username: input.username })) throw duplicateError('username');
  if (await User.exists({ email: input.email })) throw duplicateError('email');
  if (input.kind === 'student' && (await StudentProfile.exists({ usn: input.usn }))) throw duplicateError('usn');
  if (input.kind === 'faculty' && (await FacultyProfile.exists({ facultyId: input.facultyId }))) throw duplicateError('facultyId');

  const photoMeta = photo ? inspectPhoto(photo, ctx.config.maxPhotoBytes) : null;

  let authId: string | null = null;
  let photoStored = false;
  try {
    authId = await ctx.auth.createIdentity(input.email, input.password);
    if (photo && photoMeta) {
      await ctx.storage.put(photoMeta.key, photo, photoMeta.contentType);
      photoStored = true;
    }

    return await mongoose.connection.transaction(async (session) => {
      const [user] = await User.create(
        [
          {
            fullName: input.fullName,
            username: input.username,
            email: input.email,
            phone: input.phone,
            // Never taken from the request: decided solely by the endpoint used.
            role: input.kind,
            accountStatus: 'active',
            authProvider: ctx.auth.name,
            authId,
            photoKey: photoMeta?.key ?? null,
            photoContentType: photoMeta?.contentType ?? null,
          },
        ],
        { session },
      );
      if (input.kind === 'student') {
        await StudentProfile.create([{ userId: user._id, usn: input.usn }], { session });
      } else {
        await FacultyProfile.create(
          [
            {
              userId: user._id,
              facultyId: input.facultyId,
              verificationStatus: 'approved',
              verifiedAt: new Date(),
              verificationReason: 'Institutional credentials validated at registration',
            },
          ],
          { session },
        );
      }
      return user;
    });
  } catch (err) {
    if (authId) await ctx.auth.deleteIdentity(authId).catch(() => undefined);
    if (photoStored && photoMeta) await ctx.storage.remove(photoMeta.key).catch(() => undefined);
    rethrowDuplicate(err);
  }
}

// ------------------------------------------------------------------ sessions

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function login(ctx: AppContext, input: { username: string; password: string; role: Role }) {
  const user = await User.findOne({ username: input.username });
  const ok = await ctx.auth.verifyPassword(user ? { authId: user.authId, email: user.email } : null, input.password);
  // Same response for an unknown username and a wrong password.
  if (!user || !ok) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');

  // The role chosen on the login page is only a requested mode. It must match
  // the role stored for the account; we do not reveal which role that is.
  if (user.role !== input.role) {
    throw forbidden('This account is not authorized to sign in with the selected role', 'ROLE_MISMATCH');
  }

  if (user.accountStatus !== 'active') throw forbidden('This account is not active', 'ACCOUNT_INACTIVE');
  if (user.role === 'faculty' && !(await isVerifiedFaculty(user))) {
    throw forbidden('This account is not active', 'ACCOUNT_INACTIVE');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ctx.config.sessionTtlHours * 3600_000);
  await Session.create({ tokenHash: hashToken(token), userId: user._id, role: user.role, expiresAt });
  return { user, token, expiresAt };
}

/** Resolves a session cookie to its user, or null if it is not valid any more. */
export async function resolveSession(token: string): Promise<UserDoc | null> {
  const session = await Session.findOne({ tokenHash: hashToken(token) });
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  const user = await User.findById(session.userId);
  if (!user || user.accountStatus !== 'active') return null;
  // A role change (promotion, revocation) invalidates sessions opened under
  // the old role; the user signs in again through the matching login option.
  if (user.role !== session.role) return null;
  return user;
}

export async function logout(token: string) {
  await Session.updateOne({ tokenHash: hashToken(token), revokedAt: null }, { revokedAt: new Date() });
}

// ------------------------------------------------------------ authorization

export async function isVerifiedFaculty(user: UserDoc): Promise<boolean> {
  if (user.role !== 'faculty' || user.accountStatus !== 'active') return false;
  return Boolean(await FacultyProfile.exists({ userId: user._id, verificationStatus: 'approved' }));
}

