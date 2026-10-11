import { Router, type Request, type Response } from 'express';
import type { AppContext } from './context.js';
import type { PromotionStatus } from './domain.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { createMiddleware, currentUser } from './middleware.js';
import { ChatMessage, ChatThread, FacultyProfile, Notification, RoleAuditLog, StudentProfile, User } from './models.js';
import * as accounts from './services/accounts.js';
import * as promotion from './services/promotion.js';
import { inspectPhoto } from './storage/photoStorage.js';
import { buildSchemas, objectId, parse } from './validation.js';
import { createTestRoutes } from './testRoutes.js';
import { createVolunteerRoutes } from './volunteerRoutes.js';

export function createRoutes(ctx: AppContext) {
  const router = Router();
  const schemas = buildSchemas(ctx.config);
  const mw = createMiddleware(ctx);
  const { requireAuth, requireRole, requireVerifiedFaculty } = mw;

  const setSessionCookie = (res: Response, token: string, expiresAt: Date) =>
    res.cookie(ctx.config.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.isProduction,
      path: '/',
      expires: expiresAt,
    });

  const idParam = (req: Request) => parse(objectId, req.params.id);

  router.use(mw.checkOrigin);
  // Resolve the session once, then refuse anything a general (USN) sign-in is
  // not allowed to reach. Both run before every route below.
  router.use(mw.loadSession, mw.enforceSessionScope);
  router.get('/health', (_req, res) => res.json({ ok: true }));

  // ------------------------------------------------------------------ auth
  // There is intentionally no organizer registration endpoint.
  router.post('/auth/register/student', mw.authLimiter, mw.photoUpload, async (req, res) => {
    const input = parse(schemas.studentRegistration, req.body);
    const user = await accounts.registerAccount(ctx, { ...input, kind: 'student' }, req.file?.buffer);
    res.status(201).json({ user: accounts.publicUser(user), message: 'Account created. You can now sign in as a student.' });
  });

  router.post('/auth/register/faculty', mw.authLimiter, mw.photoUpload, async (req, res) => {
    const input = parse(schemas.facultyRegistration, req.body);
    const user = await accounts.registerAccount(ctx, { ...input, kind: 'faculty' }, req.file?.buffer);
    res.status(201).json({
      user: accounts.publicUser(user),
      message: 'Faculty account created. You can now sign in as faculty.',
    });
  });

  router.post('/auth/login', mw.authLimiter, async (req, res) => {
    const input = parse(schemas.login, req.body);
    const { user, token, expiresAt } = await accounts.login(ctx, input);
    setSessionCookie(res, token, expiresAt);
    res.json({ user: accounts.publicUser(user) });
  });

  router.post('/auth/logout', async (req, res) => {
    const token = req.cookies?.[ctx.config.cookieName];
    if (typeof token === 'string' && token) await accounts.logout(token);
    res.clearCookie(ctx.config.cookieName, { path: '/' });
    res.json({ ok: true });
  });

  // ------------------------------------------------------- own account (me)
  router.get('/me', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const [student, faculty, promotionRequests] = await Promise.all([
      StudentProfile.findOne({ userId: user._id }),
      FacultyProfile.findOne({ userId: user._id }),
      promotion.listOwnRequests(user._id),
    ]);
    res.json({
      user: accounts.publicUser(user),
      // Kept after promotion: an organizer still has their student profile.
      studentProfile: student ? { usn: student.usn, profileComplete: Boolean(student.profileCompletedAt) } : null,
      facultyProfile: faculty ? { facultyId: faculty.facultyId, verificationStatus: faculty.verificationStatus } : null,
      promotionRequests,
    });
  });

  router.patch('/me', requireAuth, async (req, res) => {
    const updates = parse(schemas.profileUpdate, req.body);
    const user = currentUser(req);
    user.set(updates);
    await user.save();
    res.json({ user: accounts.publicUser(user) });
  });

  router.put('/me/photo', requireAuth, mw.sensitiveLimiter, mw.photoUpload, async (req, res) => {
    const user = currentUser(req);
    const meta = inspectPhoto(req.file?.buffer ?? Buffer.alloc(0), ctx.config.maxPhotoBytes);
    await ctx.storage.put(meta.key, req.file!.buffer, meta.contentType);
    const previous = user.photoKey;
    user.set({ photoKey: meta.key, photoContentType: meta.contentType });
    await user.save();
    if (previous) await ctx.storage.remove(previous).catch(() => undefined);
    res.json({ user: accounts.publicUser(user) });
  });

  router.get('/users/:id/photo', requireAuth, async (req, res) => {
    const viewer = currentUser(req);
    const owner = viewer.id === idParam(req) ? viewer : await User.findById(idParam(req));
    if (!owner) throw notFound();
    const allowed =
      owner.id === viewer.id || (await promotion.canFacultyReview(viewer, owner));
    if (!allowed) throw forbidden();
    const data = owner.photoKey ? await ctx.storage.get(owner.photoKey) : null;
    if (!data) throw notFound();
    res.set({ 'Content-Type': owner.photoContentType ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=300' });
    res.send(data);
  });

  router.get('/notifications', requireAuth, async (req, res) => {
    const items = await Notification.find({ userId: currentUser(req)._id }).sort({ createdAt: -1 }).limit(50);
    res.json({
      notifications: items.map((n) => ({
        id: n.id as string,
        type: n.type,
        title: n.title,
        message: n.message,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    });
  });

  const serializeThread = async (thread: any, currentUserId: string) => {
    const otherId = thread.participants.find((id: unknown) => id?.toString() !== currentUserId);
    const otherUser = otherId ? await User.findById(otherId).select('fullName username role email phone photoKey accountStatus') : null;
    const lastMessage = await ChatMessage.findOne({ threadId: thread._id }).sort({ createdAt: -1 }).lean();
    return {
      id: thread._id.toString(),
      participants: thread.participants.map((id: { toString: () => string }) => id.toString()),
      participant: otherUser ? accounts.publicUser(otherUser) : null,
      lastMessage: lastMessage ? { id: lastMessage._id.toString(), senderId: lastMessage.senderId.toString(), content: lastMessage.content, createdAt: lastMessage.createdAt } : null,
      updatedAt: thread.updatedAt,
    };
  };

  router.get('/chat/contacts', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const users = await User.find({ _id: { $ne: user._id }, accountStatus: 'active' }).sort({ fullName: 1 }).select('fullName username email phone role photoKey accountStatus createdAt');
    res.json({
      contacts: users.map((u) => ({
        ...accounts.publicUser(u),
      })),
    });
  });

  router.get('/chats', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const threads = await ChatThread.find({ participants: user._id }).sort({ lastMessageAt: -1, updatedAt: -1 });
    res.json({
      threads: await Promise.all(threads.map((thread) => serializeThread(thread, user._id.toString()))),
    });
  });

  router.post('/chats', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const { participantId } = parse(schemas.chatStart, req.body);
    if (participantId === user.id) throw badRequest('Choose another person to start a chat', { participantId: 'Choose another person to start a chat' });
    const otherUser = await User.findById(participantId);
    if (!otherUser) throw notFound('User not found');

    let thread = await ChatThread.findOne({ participants: { $all: [user._id, otherUser._id], $size: 2 } });
    let created = false;
    if (!thread) {
      thread = await ChatThread.create({ participants: [user._id, otherUser._id], lastMessageAt: new Date() });
      created = true;
    }

    res.status(created ? 201 : 200).json({ thread: await serializeThread(thread, user._id.toString()) });
  });

  router.get('/chats/:id/messages', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const thread = await ChatThread.findById(idParam(req));
    if (!thread) throw notFound();
    if (!thread.participants.some((id) => id.equals(user._id))) throw forbidden('This chat does not belong to your account');

    const messages = await ChatMessage.find({ threadId: thread._id }).sort({ createdAt: 1 }).lean();
    const senders = await User.find({ _id: { $in: messages.map((m) => m.senderId) } }).select('fullName username role');
    const senderMap = new Map(senders.map((s) => [s._id.toString(), { id: s._id.toString(), fullName: s.fullName, username: s.username, role: s.role }]));

    res.json({
      threadId: thread._id.toString(),
      messages: messages.map((message) => ({
        id: message._id.toString(),
        senderId: message.senderId.toString(),
        sender: senderMap.get(message.senderId.toString()) ?? null,
        content: message.content,
        createdAt: message.createdAt,
      })),
    });
  });

  router.post('/chats/:id/messages', requireAuth, mw.sensitiveLimiter, async (req, res) => {
    const user = currentUser(req);
    const thread = await ChatThread.findById(idParam(req));
    if (!thread) throw notFound();
    if (!thread.participants.some((id) => id.equals(user._id))) throw forbidden('This chat does not belong to your account');
    const { content } = parse(schemas.chatMessage, req.body);

    const message = await ChatMessage.create({ threadId: thread._id, senderId: user._id, content });
    thread.lastMessageAt = new Date();
    await thread.save();

    res.status(201).json({
      message: {
        id: message._id.toString(),
        senderId: user._id.toString(),
        content: message.content,
        createdAt: message.createdAt,
      },
    });
  });

  router.post('/notifications/:id/read', requireAuth, async (req, res) => {
    // Scoped by userId so nobody can touch another user's notifications.
    const result = await Notification.updateOne(
      { _id: idParam(req), userId: currentUser(req)._id, readAt: null },
      { readAt: new Date() },
    );
    if (!result.matchedCount && !(await Notification.exists({ _id: idParam(req), userId: currentUser(req)._id }))) {
      throw notFound();
    }
    res.json({ ok: true });
  });

  // ------------------------------------------------------ promotion requests
  // Students ask for themselves; verified faculty nominate by USN. Organizers
  // are rejected inside the service.
  router.post('/promotion-requests', requireAuth, mw.sensitiveLimiter, async (req, res) => {
    const input = parse(schemas.promotionRequestCreate, req.body);
    res.status(201).json({ request: await promotion.createPromotionRequest(ctx, currentUser(req), input) });
  });

  const faculty = Router();
  faculty.use(requireAuth, requireRole('faculty'), requireVerifiedFaculty);

  faculty.get('/promotion-requests', async (req, res) => {
    const { status } = parse(schemas.promotionListQuery, req.query);
    res.json({ requests: await promotion.listRequestsForFaculty(currentUser(req), status as PromotionStatus | undefined) });
  });

  faculty.get('/promotion-requests/:id', async (req, res) => {
    res.json({ request: await promotion.getRequestDetail(ctx, currentUser(req), idParam(req)) });
  });

  faculty.post('/promotion-requests/:id/decision', mw.sensitiveLimiter, async (req, res) => {
    const { decision, reason } = parse(schemas.promotionDecision, req.body);
    res.json({ request: await promotion.decidePromotion(ctx, currentUser(req), idParam(req), decision, reason) });
  });
  router.use('/faculty', faculty);

  // --------------------------------------------------------------- organizer
  router.get('/organizer/overview', requireAuth, requireRole('organizer'), async (req, res) => {
    const user = currentUser(req);
    const promotedBy = await RoleAuditLog.findOne({ userId: user._id, action: 'organizer_promotion' }).sort({ createdAt: -1 });
    res.json({
      message: 'Organizer workspace. Event management arrives in the next phase.',
      organizerSince: promotedBy?.createdAt ?? null,
    });
  });

  router.use(createVolunteerRoutes(ctx, mw));
  router.use(createTestRoutes(ctx, mw));

  return router;
}
