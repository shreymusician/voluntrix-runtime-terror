import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import type { AppContext } from './context.js';
import type { Role } from './domain.js';
import { HttpError, badRequest, forbidden, unauthorized } from './errors.js';
import type { UserDoc } from './models.js';
import { isVerifiedFaculty, resolveSession } from './services/accounts.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserDoc;
    sessionToken?: string;
  }
}

/** The authenticated user; only call inside routes guarded by requireAuth. */
export function currentUser(req: Request): UserDoc {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function createMiddleware(ctx: AppContext) {
  /**
   * Loads the user from the session cookie on every request. Role and account
   * status always come from the database, never from the client.
   */
  const requireAuth: RequestHandler = async (req, _res, next) => {
    const token = req.cookies?.[ctx.config.cookieName];
    const user = typeof token === 'string' && token ? await resolveSession(token) : null;
    if (!user) throw unauthorized('Your session is missing or has expired. Please sign in again.');
    req.user = user;
    req.sessionToken = token;
    next();
  };

  const requireRole =
    (...roles: Role[]): RequestHandler =>
    (req, _res, next) => {
      if (!roles.includes(currentUser(req).role as Role)) throw forbidden();
      next();
    };

  /** Faculty role alone is not enough: the faculty profile must be in good standing. */
  const requireVerifiedFaculty: RequestHandler = async (req, _res, next) => {
    if (!(await isVerifiedFaculty(currentUser(req)))) throw forbidden();
    next();
  };

  /**
   * CSRF defence in addition to the SameSite cookie: browsers always send
   * Origin on cross-site state-changing requests, so reject unknown origins.
   */
  const checkOrigin: RequestHandler = (req, _res, next) => {
    const origin = req.get('origin');
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!safe && origin) {
      const sameHost = origin === `${req.protocol}://${req.get('host')}`;
      if (!sameHost && !ctx.config.clientOrigins.includes(origin.toLowerCase())) throw forbidden('Cross-site request blocked');
    }
    next();
  };

  const limiter = (max: number): RequestHandler =>
    ctx.rateLimits.enabled
      ? rateLimit({
          windowMs: 15 * 60_000,
          limit: max,
          standardHeaders: 'draft-7',
          legacyHeaders: false,
          handler: (_req, res) =>
            res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.', code: 'RATE_LIMITED' }),
        })
      : (_req, _res, next) => next();

  const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ctx.config.maxPhotoBytes, files: 1, fields: 20, fieldSize: 10_000 },
  }).single('photo');

  return {
    requireAuth,
    requireRole,
    requireVerifiedFaculty,
    checkOrigin,
    authLimiter: limiter(ctx.rateLimits.authMax),
    sensitiveLimiter: limiter(ctx.rateLimits.sensitiveMax),
    photoUpload,
  };
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next: NextFunction) => {
  let error: HttpError;
  if (err instanceof HttpError) {
    error = err;
  } else if (err instanceof multer.MulterError) {
    error =
      err.code === 'LIMIT_FILE_SIZE'
        ? badRequest('Profile photo is too large', { photo: 'Photo is too large' })
        : badRequest('Invalid upload', { photo: 'Upload a single image in the "photo" field' });
  } else if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    error = badRequest('Request body could not be read');
  } else {
    // Unknown failures are logged server-side and never echoed to the client.
    console.error(err);
    error = new HttpError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }
  res.status(error.status).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
};
