import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, errorMessage, type AvailabilitySlot, type VolunteerProfile } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Spinner, useLoad } from '../../components';
import { Chips, PageHeader, SkillPicker, formatDay, todayLocal, useFeedback, useMeta } from '../../ui';

type Section = 'personal' | 'skills' | 'availability' | 'preferences';
type Errors = Partial<Record<keyof FormState | 'email', string>>;

interface FormState {
  fullName: string;
  phone: string;
  department: string;
  semester: string;
  skills: string[];
  preferences: string[];
  availability: AvailabilitySlot[];
  maxHoursPerDay: string;
}

const toForm = (p: VolunteerProfile): FormState => ({
  fullName: p.fullName,
  phone: p.phone,
  department: p.department ?? '',
  semester: p.semester ? String(p.semester) : '',
  skills: p.skills,
  preferences: p.preferences,
  availability: p.availability,
  maxHoursPerDay: p.maxHoursPerDay ? String(p.maxHoursPerDay) : '',
});

const MISSING_LABELS: Record<string, string> = {
  fullName: 'full name',
  phone: 'phone number',
  department: 'department',
  semester: 'semester',
  skills: 'at least one skill',
  availability: 'at least one availability slot',
  maxHoursPerDay: 'maximum hours per day',
};

/** Immediate feedback only; the server validates everything again. */
function validate(form: FormState, maxHours: number): Errors {
  const errors: Errors = {};
  if (form.fullName.trim().length < 2) errors.fullName = 'Enter your full name';
  const phone = form.phone.replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{10,15}$/.test(phone)) errors.phone = 'Enter a valid phone number';
  else if ((phone.startsWith('+91') || phone.length === 10) && !/^(\+91)?[6-9]\d{9}$/.test(phone)) {
    errors.phone = 'Enter a valid Indian mobile number (10 digits starting with 6–9)';
  }
  for (const [i, slot] of form.availability.entries()) {
    if (!slot.date || !slot.startTime || !slot.endTime) errors.availability = `Slot ${i + 1}: fill in the date and both times`;
    else if (slot.startTime >= slot.endTime) errors.availability = `Slot ${i + 1}: the start time must be earlier than the end time`;
    if (errors.availability) break;
  }
  if (!errors.availability) {
    const sorted = [...form.availability].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].date === sorted[i - 1].date && sorted[i].startTime < sorted[i - 1].endTime) {
        errors.availability = `Two slots overlap on ${formatDay(sorted[i].date)}`;
        break;
      }
    }
  }
  if (form.maxHoursPerDay !== '') {
    const hours = Number(form.maxHoursPerDay);
    if (!Number.isFinite(hours) || hours <= 0) errors.maxHoursPerDay = 'Enter a number of hours greater than zero';
    else if (hours > maxHours) errors.maxHoursPerDay = `The maximum allowed is ${maxHours} hours per day`;
  }
  return errors;
}

export function ProfilePage({ focus }: { focus?: Section }) {
  const { refresh } = useAuth();
  const { notify } = useFeedback();
  const navigate = useNavigate();
  const meta = useMeta();
  const loaded = useLoad(() => api<{ profile: VolunteerProfile }>('/volunteer-profile'), []);

  const [profile, setProfile] = useState<VolunteerProfile | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState<'draft' | 'final' | null>(null);
  const sections = useRef<Partial<Record<Section, HTMLElement | null>>>({});

  useEffect(() => {
    if (!loaded.data) return;
    setProfile(loaded.data.profile);
    setForm(toForm(loaded.data.profile));
    // A new student goes straight into the form; a completed profile opens read-only.
    setEditing(!loaded.data.profile.complete || Boolean(focus));
  }, [loaded.data, focus]);

  useEffect(() => {
    if (focus && form) sections.current[focus]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Only when the requested section changes or the form first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, Boolean(form)]);

  if (loaded.loading && !form) return <div className="page"><Spinner label="Loading your profile…" /></div>;
  if (loaded.error && !form) return <div className="page"><Alert kind="error">{loaded.error}</Alert></div>;
  if (!form || !profile || !meta) return <div className="page"><Spinner /></div>;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setFormError(null);
  };

  const setSlot = (index: number, patch: Partial<AvailabilitySlot>) =>
    set('availability', form.availability.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const save = async (finalize: boolean) => {
    const found = validate(form, meta.limits.maxHoursPerDay);
    setErrors(found);
    if (Object.keys(found).length) {
      setFormError('Fix the highlighted fields and try again.');
      return;
    }
    setSaving(finalize ? 'final' : 'draft');
    setFormError(null);
    try {
      const body = {
        fullName: form.fullName,
        phone: form.phone,
        email: profile.email,
        skills: form.skills,
        preferences: form.preferences,
        availability: form.availability,
        ...(form.department ? { department: form.department } : {}),
        ...(form.semester ? { semester: Number(form.semester) } : {}),
        ...(form.maxHoursPerDay !== '' ? { maxHoursPerDay: Number(form.maxHoursPerDay) } : {}),
        finalize,
      };
      const res = await api<{ profile: VolunteerProfile }>('/volunteer-profile', { method: 'PUT', body });
      const wasComplete = profile.complete;
      setProfile(res.profile);
      setForm(toForm(res.profile));
      await refresh();
      if (res.profile.complete) {
        notify('success', wasComplete ? 'Profile updated.' : 'Profile complete. Welcome aboard!');
        setEditing(false);
        if (!wasComplete) navigate('/student/activities', { replace: true });
      } else {
        notify('success', 'Progress saved. Finish the remaining fields to complete your profile.');
      }
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields as Errors);
      setFormError(errorMessage(err));
      notify('error', errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(true);
  };

  const progress = (
    <div className="progress-card card">
      <div className="progress-head">
        <strong>{profile.complete ? 'Profile complete' : 'Profile completion'}</strong>
        <span>{profile.completion.percent}%</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={profile.completion.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Profile completion">
        <span style={{ width: `${profile.completion.percent}%` }} />
      </div>
      {!profile.complete && profile.completion.missing.length > 0 && (
        <p className="muted">Still needed: {profile.completion.missing.map((m) => MISSING_LABELS[m] ?? m).join(', ')}.</p>
      )}
    </div>
  );

  if (!editing) {
    return (
      <div className="page">
        <PageHeader title="My profile" subtitle="Used to match you with volunteer activities." eyebrow="Volunteer profile">
          <button className="btn btn-primary" onClick={() => setEditing(true)}>
            Edit profile
          </button>
        </PageHeader>
        {progress}
        <section className="card">
          <h2>Personal information</h2>
          <dl className="detail-grid">
            <div><dt>Full name</dt><dd>{profile.fullName}</dd></div>
            <div><dt>USN</dt><dd>{profile.usn}</dd></div>
            <div><dt>Email</dt><dd>{profile.email}</dd></div>
            <div><dt>Phone</dt><dd>{profile.phone}</dd></div>
            <div><dt>Department</dt><dd>{profile.department ?? '—'}</dd></div>
            <div><dt>Semester</dt><dd>{profile.semester ?? '—'}</dd></div>
          </dl>
        </section>
        <section className="card">
          <h2>Skills</h2>
          <Chips items={profile.skills} empty="No skills added yet" />
        </section>
        <section className="card">
          <h2>Availability</h2>
          {profile.availability.length === 0 ? (
            <p className="muted">No availability added yet.</p>
          ) : (
            <ul className="plain-list">
              {profile.availability.map((s) => (
                <li key={`${s.date}${s.startTime}`}>
                  <strong>{formatDay(s.date)}</strong> · {s.startTime}–{s.endTime}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">Maximum hours per day: {profile.maxHoursPerDay ?? '—'}</p>
        </section>
        <section className="card">
          <h2>Activity preferences</h2>
          <Chips items={profile.preferences} empty="No preferences selected" />
        </section>
      </div>
    );
  }

  const togglePreference = (type: string) =>
    set('preferences', form.preferences.includes(type) ? form.preferences.filter((p) => p !== type) : [...form.preferences, type]);

  return (
    <form className="page" onSubmit={submit} noValidate>
      <PageHeader
        title={profile.complete ? 'Edit profile' : 'Set up your volunteer profile'}
        subtitle={profile.complete ? 'Changes apply to future allocations.' : 'Tell us what you can do and when, so we can match you with the right activities.'}
        eyebrow="Volunteer profile"
      />
      {progress}

      <section className="card" ref={(el) => { sections.current.personal = el; }}>
        <h2>Personal information</h2>
        <div className="field-row">
          <div className={`field${errors.fullName ? ' field-invalid' : ''}`}>
            <label htmlFor="p-name">Full name</label>
            <input id="p-name" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} autoComplete="name" />
            {errors.fullName && <p className="field-error">{errors.fullName}</p>}
          </div>
          <div className={`field${errors.phone ? ' field-invalid' : ''}`}>
            <label htmlFor="p-phone">Phone number</label>
            <input id="p-phone" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" />
            {errors.phone && <p className="field-error">{errors.phone}</p>}
          </div>
        </div>
        <div className={`field${errors.email ? ' field-invalid' : ''}`}>
          <label htmlFor="p-email">Email address</label>
          <input id="p-email" value={profile.email} readOnly aria-describedby="p-email-hint" />
          <p id="p-email-hint" className={errors.email ? 'field-error' : 'field-hint'}>{errors.email ?? 'From your account; it cannot be changed here.'}</p>
        </div>
        <div className="field-row">
          <div className={`field${errors.department ? ' field-invalid' : ''}`}>
            <label htmlFor="p-dept">Department</label>
            <select id="p-dept" value={form.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">Choose…</option>
              {meta.departments.map((d) => <option key={d}>{d}</option>)}
            </select>
            {errors.department && <p className="field-error">{errors.department}</p>}
          </div>
          <div className={`field${errors.semester ? ' field-invalid' : ''}`}>
            <label htmlFor="p-sem">Semester</label>
            <select id="p-sem" value={form.semester} onChange={(e) => set('semester', e.target.value)}>
              <option value="">Choose…</option>
              {meta.semesters.map((s) => <option key={s} value={s}>Semester {s}</option>)}
            </select>
            {errors.semester && <p className="field-error">{errors.semester}</p>}
          </div>
        </div>
      </section>

      <section className="card" ref={(el) => { sections.current.skills = el; }}>
        <h2>Skills</h2>
        <SkillPicker
          idPrefix="profile-skills"
          label="Select your skills"
          hint="Activities list the skills they need; you are only matched with ones you qualify for."
          value={form.skills}
          onChange={(skills) => set('skills', skills)}
          suggestions={meta.suggestedSkills}
          max={meta.limits.maxSkills}
          maxLength={meta.limits.maxSkillLength}
          error={errors.skills}
        />
      </section>

      <section className="card" ref={(el) => { sections.current.availability = el; }}>
        <h2>Availability</h2>
        <p className="muted">Add each period you are free to volunteer. You are only assigned to activities that fit entirely inside a slot.</p>
        {form.availability.length === 0 && <p className="muted">No slots yet.</p>}
        <div className="slots">
          {form.availability.map((slot, i) => (
            <div className="slot" key={i}>
              <div className="field">
                <label htmlFor={`slot-date-${i}`}>Date</label>
                <input id={`slot-date-${i}`} type="date" min={todayLocal()} value={slot.date} onChange={(e) => setSlot(i, { date: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`slot-start-${i}`}>From</label>
                <input id={`slot-start-${i}`} type="time" value={slot.startTime} onChange={(e) => setSlot(i, { startTime: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`slot-end-${i}`}>To</label>
                <input id={`slot-end-${i}`} type="time" value={slot.endTime} onChange={(e) => setSlot(i, { endTime: e.target.value })} />
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('availability', form.availability.filter((_, j) => j !== i))} aria-label={`Remove slot ${i + 1}`}>
                Remove
              </button>
            </div>
          ))}
        </div>
        {errors.availability && <p className="field-error" role="alert">{errors.availability}</p>}
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={form.availability.length >= meta.limits.maxAvailabilitySlots}
            onClick={() => set('availability', [...form.availability, { date: '', startTime: '09:00', endTime: '17:00' }])}
          >
            Add slot
          </button>
        </div>
        <div className={`field field-narrow${errors.maxHoursPerDay ? ' field-invalid' : ''}`}>
          <label htmlFor="p-hours">Maximum hours per day</label>
          <input id="p-hours" type="number" min={0.5} max={meta.limits.maxHoursPerDay} step={0.5} value={form.maxHoursPerDay} onChange={(e) => set('maxHoursPerDay', e.target.value)} />
          <p className={errors.maxHoursPerDay ? 'field-error' : 'field-hint'}>
            {errors.maxHoursPerDay ?? `You will never be assigned more than this in one day (up to ${meta.limits.maxHoursPerDay}).`}
          </p>
        </div>
      </section>

      <section className="card" ref={(el) => { sections.current.preferences = el; }}>
        <h2>Activity preferences <span className="muted">(optional)</span></h2>
        <p className="muted">These preferences help prioritize relevant activities when several volunteers qualify. They never override required skills or availability.</p>
        <div className="chips">
          {meta.activityTypes.map((type) => (
            <button key={type} type="button" className={`chip${form.preferences.includes(type) ? ' chip-on' : ''}`} aria-pressed={form.preferences.includes(type)} onClick={() => togglePreference(type)}>
              {type}
            </button>
          ))}
        </div>
        {errors.preferences && <p className="field-error">{errors.preferences}</p>}
      </section>

      {formError && <Alert kind="error">{formError}</Alert>}
      <div className="form-actions">
        {profile.complete ? (
          <>
            <button type="button" className="btn btn-secondary" disabled={saving !== null} onClick={() => { setForm(toForm(profile)); setErrors({}); setFormError(null); setEditing(false); }}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={saving !== null}>{saving ? 'Saving…' : 'Save profile'}</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" disabled={saving !== null} onClick={() => save(false)}>
              {saving === 'draft' ? 'Saving…' : 'Save profile'}
            </button>
            <button className="btn btn-primary" disabled={saving !== null}>{saving === 'final' ? 'Saving…' : 'Save and continue'}</button>
          </>
        )}
      </div>
    </form>
  );
}
