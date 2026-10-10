import express, { type Express } from 'express';
import { createApp } from './app.js';
import { buildContext } from './buildContext.js';
import { connectDatabase } from './db.js';
import { ensureQuestionBank } from './services/questionBank.js';

const app = express();
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

app.use((req, res, next) => {
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

export default app;