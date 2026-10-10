import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, errorMessage } from '../api';
import { Alert, Field, Logo, TAGLINE } from '../components';

type Kind = 'student' | 'faculty';
type Values = Record<'fullName' | 'idNumber' | 'email' | 'phone' | 'username' | 'password' | 'confirmPassword', string>;
type Errors = Partial<Record<keyof Values | 'photo', string>>;

const EMPTY: Values = { fullName: '', idNumber: '', email: '', phone: '', username: '', password: '', confirmPassword: '' };
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Quick feedback only — the server validates everything again and is the authority. */
function validate(values: Values, kind: Kind): Errors {
  const errors: Errors = {};
  if (values.fullName.trim().length < 2) errors.fullName = 'Enter your full name';
  if (!values.idNumber.trim()) errors.idNumber = kind === 'student' ? 'Enter your USN' : 'Enter your faculty ID';
  if (!/^\S+@\S+\.\S+$/.test(values.email.trim())) errors.email = 'Enter a valid email address';
  if (!/^\+?[0-9]{10,15}$/.test(values.phone.replace(/[\s()-]/g, ''))) errors.phone = 'Enter a valid phone number (10–15 digits)';
  if (!/^[a-zA-Z0-9._]{3,30}$/.test(values.username.trim())) errors.username = '3–30 characters: letters, numbers, dots or underscores';
  if (values.password.length < 8 || !/[A-Za-z]/.test(values.password) || !/[0-9]/.test(values.password)) {
    errors.password = 'At least 8 characters, with a letter and a number';
  }
  if (values.confirmPassword !== values.password) errors.confirmPassword = 'Passwords do not match';
  return errors;
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>('student');
  const [values, setValues] = useState<Values>(EMPTY);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!photo) return setPreview(null);
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const bind = (name: keyof Values) => ({
    name,
    value: values[name],
    error: errors[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setValues((v) => ({ ...v, [name]: e.target.value }));
      setErrors((er) => ({ ...er, [name]: undefined }));
    },
  });

  const pickPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    let error: string | undefined;
    if (file && !PHOTO_TYPES.includes(file.type)) error = 'Photo must be a JPEG, PNG or WebP image';
    else if (file && file.size > MAX_PHOTO_BYTES) error = 'Photo must be 2 MB or smaller';
    setErrors((er) => ({ ...er, photo: error }));
    setPhoto(error ? null : file);
    if (error) e.target.value = '';
  };

  const switchKind = (next: Kind) => {
    setKind(next);
    setErrors({});
    setFormError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate(values, kind);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;

    const form = new FormData();
    const { idNumber, ...rest } = values;
    Object.entries(rest).forEach(([key, value]) => form.append(key, value));
    form.append(kind === 'student' ? 'usn' : 'facultyId', idNumber);
    if (photo) form.append('photo', photo);

    setBusy(true);
    try {
      await api(`/auth/register/${kind}`, { form });
      navigate('/login', { state: { notice: `Account created. Sign in as ${kind === 'student' ? 'a student' : 'faculty'} to continue.` } });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        const { usn, facultyId, ...other } = err.fields;
        setErrors({ ...other, idNumber: usn ?? facultyId });
      }
      setFormError(errorMessage(err));
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
          <li>Students join instantly with their USN</li>
          <li>Faculty register with their faculty ID and institutional email</li>
          <li>Organizers are students promoted by faculty — there is no organizer sign-up</li>
        </ul>
      </aside>

      <main className="auth-panel">
        <div className="auth-form-shell">
          <form className="auth-form" onSubmit={submit} noValidate>
            <div className="auth-form-header">
              <h1>Create your account</h1>
            </div>

            <div className="tabs" role="tablist" aria-label="Account type">
              {(['student', 'faculty'] as Kind[]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={kind === k} className={`tab${kind === k ? ' tab-active' : ''}`} onClick={() => switchKind(k)}>
                  Register as {k === 'student' ? 'Student' : 'Faculty'}
                </button>
              ))}
            </div>

            {kind === 'faculty' && <Alert kind="info">Use your faculty ID and official institutional email. Both are checked before the account is created.</Alert>}

            <Field label="Full name" autoComplete="name" {...bind('fullName')} />
            <div className="field-row">
              {kind === 'student' ? (
                <Field label="USN" hint="University Seat Number, e.g. 1RV21CS001" autoCapitalize="characters" {...bind('idNumber')} />
              ) : (
                <Field label="Faculty ID" autoCapitalize="characters" {...bind('idNumber')} />
              )}
              <Field label="Phone number" type="tel" autoComplete="tel" {...bind('phone')} />
            </div>
            <Field
              label={kind === 'student' ? 'Email' : 'Institutional email'}
              type="email"
              autoComplete="email"
              hint={kind === 'faculty' ? 'Must be your official institution address' : undefined}
              {...bind('email')}
            />

            <div className={`field${errors.photo ? ' field-invalid' : ''}`}>
              <label htmlFor="f-photo">
                Profile photo <span className="muted">(optional)</span>
              </label>
              <div className="photo-picker">
                {preview ? <img className="avatar avatar-lg" src={preview} alt="Selected profile photo preview" /> : <span className="avatar avatar-lg avatar-initials" aria-hidden="true" />}
                <input id="f-photo" type="file" accept={PHOTO_TYPES.join(',')} onChange={pickPhoto} />
              </div>
              <p className={errors.photo ? 'field-error' : 'field-hint'}>{errors.photo ?? 'JPEG, PNG or WebP, up to 2 MB'}</p>
            </div>

            <Field label="Username" autoComplete="username" hint="You will sign in with this" {...bind('username')} />
            <div className="field-row">
              <Field label="Password" type="password" autoComplete="new-password" {...bind('password')} />
              <Field label="Confirm password" type="password" autoComplete="new-password" {...bind('confirmPassword')} />
            </div>

            {formError && <Alert kind="error">{formError}</Alert>}

            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Creating account…' : `Create ${kind} account`}
            </button>
            <p className="auth-switch">
              Already registered? <Link to="/login">Sign in</Link>
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
