import { createAuthProvider } from './auth/provider.js';
import { createVerificationChannel } from './auth/verification.js';
import { loadConfig } from './config/env.js';
import { loadPromotionPolicy } from './config/promotionPolicy.js';
import type { AppContext } from './context.js';
import { createPhotoStorage } from './storage/photoStorage.js';

export function buildContext(): AppContext {
  const config = loadConfig();
  return {
    config,
    auth: createAuthProvider(),
    verification: createVerificationChannel(),
    storage: createPhotoStorage(),
    policy: loadPromotionPolicy(),
    rateLimits: { enabled: true, authMax: 30, sensitiveMax: 120 },
  };
}