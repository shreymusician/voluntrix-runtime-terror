import type { UserDoc } from '../models.js';

/**
 * Where a one-time sign-in code is delivered.
 *
 * The project has no mail or SMS provider configured, so the default
 * implementation writes the code to the server log. That is enough for local
 * development and keeps the code off the network, but it is NOT a delivery
 * channel for real users: before this is used outside development, implement
 * `send` against the institution's mail or SMS gateway (or replace the whole
 * USN flow with the college identity provider) and wire it up in
 * `createVerificationChannel`.
 */
export interface VerificationChannel {
  readonly name: string;
  /** True when codes actually reach the student rather than only the log. */
  readonly deliversToStudent: boolean;
  send(user: UserDoc, code: string, expiresAt: Date): Promise<void>;
}

/** Masks a contact so the login screen can say where the code went without revealing it. */
export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  const head = name.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(1, name.length - head.length))}@${domain}`;
}

export class ConsoleVerificationChannel implements VerificationChannel {
  readonly name = 'console';
  readonly deliversToStudent = false;

  async send(user: UserDoc, code: string, expiresAt: Date) {
    console.log(
      `[voluntrix] Sign-in code for ${user.email} (USN login): ${code} — valid until ${expiresAt.toISOString()}.\n` +
        '           No mail/SMS provider is configured, so this code was only written to this log.',
    );
  }
}

export function createVerificationChannel(): VerificationChannel {
  return new ConsoleVerificationChannel();
}
