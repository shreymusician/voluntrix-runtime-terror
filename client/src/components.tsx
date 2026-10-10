import { useCallback, useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { api, errorMessage, type Notice, type PromotionStatus } from './api';

function BrandMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="voluntrix-mark" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#17b6e6" />
          <stop offset="45%" stopColor="#3f6bff" />
          <stop offset="100%" stopColor="#9b5cf6" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="#070b17" />
      <path d="M19 39V19h10.5c7 0 11.5 4 11.5 10.5S36.5 39 29.5 39H19Zm9.5-7.5h1.5c3.1 0 5-1.9 5-5.2 0-3.3-1.9-5.1-5-5.1h-1.5v10.3Z" fill="url(#voluntrix-mark)"/>
      <path d="M36 44l10-24h4l-10 24h-4Z" fill="#8deafc" opacity="0.95"/>
    </svg>
  );
}

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  if (size === 'lg') return <img className="logo-full" src="/logo-full.png" alt="Voluntrix — People, Purpose, Progress" />;
  return (
    <span className="logo" aria-label="Voluntrix">
      <span className="logo-mark"><BrandMark /></span>
      <span aria-hidden="true">
        Volun<span className="logo-accent">trix</span>
      </span>
    </span>
  );
}

export function Icon({ name, className = '' }: { name: 'dashboard' | 'profile' | 'skills' | 'calendar' | 'tests' | 'leaderboard' | 'activity' | 'assignment' | 'feedback' | 'bell' | 'logout' | 'users' | 'events' | 'shield' | 'chat'; className?: string }) {
  const common = { className, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24', 'aria-hidden': true };
  const paths: Record<string, JSX.Element> = {
    dashboard: <svg {...common}><path d="M4 12.5 12 4l8 8.5" /><path d="M5 10.5V19h14v-8.5" /><path d="M9 19v-6h6v6" /></svg>,
    profile: <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 19c1.8-3 4.1-4.5 7-4.5s5.2 1.5 7 4.5" /></svg>,
    skills: <svg {...common}><path d="M7 16V8.5A2.5 2.5 0 0 1 9.5 6H14a2.5 2.5 0 0 1 2.5 2.5V16" /><path d="M7 12h10" /><path d="M10 16l1.5 2 3-4" /></svg>,
    calendar: <svg {...common}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17" /></svg>,
    tests: <svg {...common}><path d="M7 5.5h10a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2Z" /><path d="M8.5 9.5h7M8.5 13h7M8.5 16.5h4" /></svg>,
    leaderboard: <svg {...common}><path d="M6 18V9m6 9V5m6 13v-7" /><path d="M3 18h18" /></svg>,
    activity: <svg {...common}><path d="M5 14.5 9 10l3 3 7-8" /><path d="M18 5h3v3" /><path d="M5 19h14" /></svg>,
    assignment: <svg {...common}><path d="M8 4.5h8l3 3V18a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" /><path d="M16 4.5v3h3" /><path d="M8 12h8M8 16h6" /></svg>,
    feedback: <svg {...common}><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7A2.5 2.5 0 0 1 16.5 16H10l-5 4v-3.5A2.5 2.5 0 0 1 5 13.5v-7Z" /><path d="M8 9.5h8M8 12.5h6" /></svg>,
    bell: <svg {...common}><path d="M15 17h-6l1.5-1.5V11a3.5 3.5 0 1 1 7 0v4.5L15 17Z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>,
    logout: <svg {...common}><path d="M9 7V5.5A2.5 2.5 0 0 1 11.5 3h6A2.5 2.5 0 0 1 20 5.5v13A2.5 2.5 0 0 1 17.5 21h-6A2.5 2.5 0 0 1 9 18.5V17" /><path d="M14 12h-8" /><path d="m8 8-4 4 4 4" /></svg>,
    users: <svg {...common}><path d="M14 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" /><path d="M18.5 18a6.5 6.5 0 0 0-13 0" /><path d="M7.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" /></svg>,
    events: <svg {...common}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" /></svg>,
    shield: <svg {...common}><path d="M12 3.5 18.5 6v5.5c0 4.2-2.7 7.7-6.5 9.5-3.8-1.8-6.5-5.3-6.5-9.5V6L12 3.5Z" /><path d="m9.5 12 1.6 1.6 3.4-4" /></svg>,
    chat: <svg {...common}><path d="M6 18.5V7.5A2.5 2.5 0 0 1 8.5 5h7A2.5 2.5 0 0 1 18 7.5v6A2.5 2.5 0 0 1 15.5 16H9l-3 2.5Z" /><path d="M8.5 9.5h7M8.5 12.5h5" /></svg>
  };
  return paths[name] ?? paths.dashboard;
}

export const TAGLINE = 'The right people. The right event. The right time.';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export function Field({ label, error, hint, id, ...input }: FieldProps) {
  const fieldId = id ?? `f-${input.name}`;
  const isPassword = input.type === 'password';
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={fieldId}>{label}</label>
      {isPassword ? (
        <div className="password-field">
          <input
            id={fieldId}
            aria-invalid={Boolean(error)}
            aria-describedby={error || hint ? `${fieldId}-msg` : undefined}
            {...input}
            type={showPassword ? 'text' : 'password'}
          />
          <button
            type="button"
            className="password-toggle"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => setShowPassword((current) => !current)}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      ) : (
        <input id={fieldId} aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${fieldId}-msg` : undefined} {...input} />
      )}
      {(error || hint) && (
        <p id={`${fieldId}-msg`} className={error ? 'field-error' : 'field-hint'}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'info' | 'warn'; children: ReactNode }) {
  const iconByKind: Record<typeof kind, 'shield' | 'activity' | 'bell' | 'feedback'> = {
    error: 'shield',
    success: 'activity',
    info: 'bell',
    warn: 'feedback',
  };

  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="alert-icon" aria-hidden="true"><Icon name={iconByKind[kind]} /></span>
      <div className="alert-content">{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  needs_review: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  active: 'Active',
  suspended: 'Suspended',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  draft: 'Draft',
  published: 'Published',
  completed: 'Completed',
  open: 'Open',
  closed: 'Closed',
};

export function StatusBadge({ status }: { status: PromotionStatus | string }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Avatar({ user }: { user: { id: string; fullName: string; hasPhoto: boolean } }) {
  const [broken, setBroken] = useState(false);
  if (user.hasPhoto && !broken) {
    return <img className="avatar" src={`/api/users/${user.id}/photo`} alt="" onError={() => setBroken(true)} />;
  }
  const initials = user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span className="avatar avatar-initials" aria-hidden="true">
      {initials}
    </span>
  );
}

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** Loads data for a view and exposes loading / error / reload state. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await load());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

export function Notifications() {
  const { data, error, loading, reload } = useLoad(() => api<{ notifications: Notice[] }>('/notifications'), []);

  const markRead = async (id: string) => {
    await api(`/notifications/${id}/read`, { method: 'POST' }).catch(() => undefined);
    await reload();
  };

  return (
    <section className="card">
      <h2>Notifications</h2>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && data.notifications.length === 0 && <Empty title="No notifications yet">Updates about your account appear here.</Empty>}
      <ul className="notice-list">
        {data?.notifications.map((n) => (
          <li key={n.id} className={n.readAt ? 'notice' : 'notice notice-unread'}>
            <div>
              <strong>{n.title}</strong>
              <p>{n.message}</p>
              <time>{formatDate(n.createdAt)}</time>
            </div>
            {!n.readAt && (
              <button className="btn btn-ghost btn-sm" onClick={() => markRead(n.id)}>
                Mark read
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
