import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { buildContext } from './buildContext.js';
import type { AppContext } from './context.js';
import { connectDatabase } from './db.js';
import { errorHandler, notFoundHandler } from './middleware.js';
import { createRoutes } from './routes.js';
import { ensureQuestionBank } from './services/questionBank.js';

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  // Needed for correct client IPs (rate limiting) and secure cookies behind a proxy.
  if (ctx.config.isProduction || process.env.VERCEL === '1') app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  app.use('/api', createRoutes(ctx));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const vercelApp = express();
let apiAppPromise: Promise<Express> | undefined;

function getApiApp() {
  if (!apiAppPromise) {
    apiAppPromise = (async () => {
      const ctx = buildContext();
      if (!ctx.config.mongoUri) throw new Error('MONGODB_URI is not set');
      await connectDatabase(ctx.config.mongoUri);
      await ensureQuestionBank();
      return createApp(ctx);
    })().catch((error: unknown) => {
      apiAppPromise = undefined;
      throw error;
    });
  }
  return apiAppPromise;
}

vercelApp.use((req, res, next) => {
  void getApiApp()
    .then((apiApp) => apiApp(req, res, next))
    .catch((error: unknown) => {
      console.error('[voluntrix] API initialization failed', error);
      if (res.headersSent) {
        next(error);
        return;
      }
      res.status(503).json({ error: 'API temporarily unavailable', code: 'SERVICE_UNAVAILABLE' });
    });
});

export default vercelApp;
