import { createApp } from './app.js';
import { buildContext } from './buildContext.js';
export { buildContext } from './buildContext.js';
import type { AppContext } from './context.js';
import { connectDatabase } from './db.js';
import { ensureQuestionBank } from './services/questionBank.js';

export async function start(ctx: AppContext) {
  if (!ctx.config.mongoUri) throw new Error('MONGODB_URI is not set. See server/.env.example.');
  await connectDatabase(ctx.config.mongoUri);
  // Adds any built-in mock-test questions that are not in the database yet.
  await ensureQuestionBank();
  const app = createApp(ctx);
  // Express 5 reports listen failures (e.g. port already in use) through this
  // callback; without the check an old process could keep serving unnoticed.
  app.listen(ctx.config.port, (err?: Error) => {
    if (err) {
      console.error(`[voluntrix] Could not start on port ${ctx.config.port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`[voluntrix] API on http://localhost:${ctx.config.port}`);
  });
}

// Run directly (npm run dev / start), but not when imported by scripts.
if (process.argv[1] && /index\.[tj]s$/.test(process.argv[1])) {
  start(buildContext()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
