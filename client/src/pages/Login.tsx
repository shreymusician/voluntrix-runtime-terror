import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, errorMessage, type Role } from '../api';
import { homeFor, useAuth } from '../auth';
import { Alert, Field, Logo, TAGLINE } from '../components';

const ROLE_OPTIONS: { role: Role; label: string; blurb: string }[] = [
  { role: 'student', label: 'Student', blurb: 'Volunteer and track your participation' },
  { role: 'faculty', label: 'Faculty', blurb: 'Review and promote student organizers' },
  { role: 'organizer', label: 'Organizer', blurb: 'For students promoted by faculty' },
];

const HINTS: Record<string, string> = {
  ROLE_MISMATCH: 'Check that you picked the right option above. Students promoted to organizer sign in with Organizer.',
};

export function LoginPage() {
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;

  const [role, setRole] = useState<Role>('student');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  if (me) return <Navigate to={homeFor(me.user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError({ message: 'Enter your username and password.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password, role);
      navigate(homeFor(role), { replace: true });
    } catch (err) {
      setError({ message: errorMessage(err), hint: err instanceof ApiError ? HINTS[err.code] : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-layout">
      <aside className="auth-brand">
        <Logo size="lg" />
        <p className="auth-tagline">{TAGLINE}</p>
        <ul className="auth-points">
          <li>One account for your whole volunteering journey</li>
          <li>Organizer access is earned and approved by faculty</li>
          <li>Every role change is recorded and explainable</li>
        </ul>
      </aside>

      <main className="auth-panel">
        <div className="auth-form-shell">
          <form className="auth-form" onSubmit={submit} noValidate>
            <div className="auth-form-header">
              <h1>Sign in</h1>
              <p className="muted">Choose how you are signing in.</p>
            </div>

            {notice && <Alert kind="success">{notice}</Alert>}

            <div className="role-picker" role="radiogroup" aria-label="Sign in as">
              {ROLE_OPTIONS.map((option) => (
                <label key={option.role} className={`role-option${role === option.role ? ' role-option-active' : ''}`}>
                  <input
                    type="radio"
                    name="role"
                    value={option.role}
                    checked={role === option.role}
                    onChange={() => {
                      setRole(option.role);
                      setError(null);
                    }}
                  />
                  <span className="role-label">{option.label}</span>
                  <span className="role-blurb">{option.blurb}</span>
                </label>
              ))}
            </div>

            <Field label="Username" name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && (
              <Alert kind="error">
                <strong>{error.message}</strong>
                {error.hint && <p>{error.hint}</p>}
              </Alert>
            )}

            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Signing in…' : `Sign in as ${ROLE_OPTIONS.find((o) => o.role === role)?.label}`}
            </button>

            <p className="auth-switch">
              New to VOLUNTRIX? <Link to="/register">Create an account</Link>
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
