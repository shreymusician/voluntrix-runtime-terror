import type { AuthProvider } from './auth/provider.js';
import type { AppConfig } from './config/env.js';
import type { PromotionPolicy } from './config/promotionPolicy.js';
import type { PhotoStorage } from './storage/photoStorage.js';

export interface AppContext {
  config: AppConfig;
  auth: AuthProvider;
  storage: PhotoStorage;
  policy: PromotionPolicy;
  /** Rate limiting can be switched off for tests that are not about it. */
  rateLimits: { enabled: boolean; authMax: number; sensitiveMax: number };
  /** Overrides for the suitability and allocation scoring (defaults in services/scoring.ts). */
  scoring?: Partial<import('./services/scoring.js').ScoringConfig>;
}
