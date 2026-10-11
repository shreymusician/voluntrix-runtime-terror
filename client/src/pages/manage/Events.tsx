import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  api,
  errorMessage,
  type Activity,
  type AllocationReport,
  type EventDetail,
  type EventStatus,
  type EventSummary,
  type ManagedActivity,
  type ManagedAssignment,
} from '../../api';
import { Alert, Empty, Spinner, StatusBadge, useLoad } from '../../components';
import { LocationMap } from '../../MapCanvas';
import { useCurrentPosition, type LatLng } from '../../mapUtils';
import { Chips, Modal, PageHeader, SkillPicker, StatTile, formatDay, todayLocal, useFeedback, useMeta } from '../../ui';
import { AssignmentTable, CandidatePicker } from './shared';
import { LiveVolunteerMap } from './LiveVolunteerMap';
import { EmergencyFinder } from './EmergencyFinder';

type Errors = Record<string, string | undefined>;

// ------------------------------------------------------------- event form

const EVENT_STATUSES: { value: EventStatus; label: string; hint: string }[] = [
  { value: 'draft', label: 'Draft', hint: 'Only organizers can see it' },
  { value: 'published', label: 'Published', hint: 'Students can see it and its activities' },
  { value: 'completed', label: 'Completed', hint: 'Finished; no new assignments' },
  { value: 'cancelled', label: 'Cancelled', hint: 'All assignments are released' },
];

function EventForm({ event, onSaved, onClose }: { event?: EventSummary; onSaved: (e: EventSummary) => void; onClose: () => void }) {
  const { notify, confirm } = useFeedback();
  const [form, setForm] = useState({
    name: event?.name ?? '',
    description: event?.description ?? '',
    startDate: event?.startDate ?? '',
    endDate: event?.endDate ?? '',
    venue: event?.venue ?? '',
    status: event?.status ?? ('draft' as EventStatus),
  });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    if (!form.name.trim()) found.name = 'Event name is required';
    if (!form.venue.trim()) found.venue = 'Venue is required';
    if (!form.startDate) found.startDate = 'Choose a start date';
    if (!form.endDate) found.endDate = 'Choose an end date';
    else if (form.startDate && form.endDate < form.startDate) found.endDate = 'The end date cannot be before the start date';
    setErrors(found);
    if (Object.keys(found).length) return;

    if (form.status === 'cancelled' && event?.status !== 'cancelled') {
      const answer = await confirm({ title: 'Cancel this event?', message: 'Every pending and confirmed assignment for this event will be released and the volunteers notified. This cannot be undone.', confirmLabel: 'Cancel event', danger: true });
      if (!answer.ok) return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await api<{ event: EventSummary }>(event ? `/manage/events/${event.id}` : '/manage/events', { method: event ? 'PUT' : 'POST', body: form });
      notify('success', event ? 'Event updated.' : 'Event created.');
      onSaved(res.event);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: 'name' | 'venue' | 'startDate' | 'endDate', label: string, type = 'text') => (
    <div className={`field${errors[key] ? ' field-invalid' : ''}`}>
      <label htmlFor={`ev-${key}`}>{label}</label>
      <input id={`ev-${key}`} type={type} value={form[key]} min={type === 'date' && !event ? todayLocal() : undefined} onChange={(e) => set(key, e.target.value)} />
      {errors[key] && <p className="field-error">{errors[key]}</p>}
    </div>
  );

  return (
    <Modal title={event ? 'Edit event' : 'Create event'} onClose={onClose}>
      <form className="stack-form" onSubmit={submit} noValidate>
        {field('name', 'Event name')}
        <div className="field">
          <label htmlFor="ev-description">Description</label>
          <textarea id="ev-description" rows={3} maxLength={2000} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="field-row">
          {field('startDate', 'Start date', 'date')}
          {field('endDate', 'End date', 'date')}
        </div>
        {field('venue', 'Venue')}
        <div className="field">
          <label htmlFor="ev-status">Status</label>
          <select id="ev-status" value={form.status} onChange={(e) => set('status', e.target.value)}>
            {EVENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>)}
          </select>
        </div>
        {formError && <Alert kind="error">{formError}</Alert>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : event ? 'Save changes' : 'Create event'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------- event location

function EventLocationModal({ event, onClose, onSaved }: { event: EventSummary; onClose: () => void; onSaved: (e: EventSummary) => void }) {
  const { notify, confirm } = useFeedback();
  const [selectedPoint, setSelectedPoint] = useState<LatLng | null>(event.venueLocation);
  const [latitude, setLatitude] = useState(event.venueLocation?.latitude.toString() ?? '');
  const [longitude, setLongitude] = useState(event.venueLocation?.longitude.toString() ?? '');
  const [venueAddress, setVenueAddress] = useState(event.venueAddress ?? '');
  const [usingGps, setUsingGps] = useState(false);
  const [busy, setBusy] = useState(false);
  const gps = useCurrentPosition(usingGps);
  const manualLatitude = latitude.trim() ? Number(latitude) : NaN;
  const manualLongitude = longitude.trim() ? Number(longitude) : NaN;
  const point = selectedPoint ?? (Number.isFinite(manualLatitude) && Math.abs(manualLatitude) <= 90 && Number.isFinite(manualLongitude) && Math.abs(manualLongitude) <= 180
    ? { latitude: manualLatitude, longitude: manualLongitude }
    : null);
  const setPoint = (next: LatLng | null) => {
    setSelectedPoint(next);
    if (next) {
      setLatitude(next.latitude.toString());
      setLongitude(next.longitude.toString());
    } else {
      setLatitude('');
      setLongitude('');
    }
  };

  const useMyLocation = () => setUsingGps(true);
  useEffect(() => {
    // One-shot suggestion: take the first fix, then let the organizer fine-tune by clicking the map.
    if (usingGps && gps.status === 'granted' && gps.position) {
      setUsingGps(false);
      setPoint({ latitude: gps.position.latitude, longitude: gps.position.longitude });
    }
  }, [usingGps, gps.status, gps.position]);

  const save = async () => {
    if (!point) return;
    setBusy(true);
    try {
      const res = await api<{ event: EventSummary }>(`/manage/events/${event.id}/location`, { method: 'PUT', body: { venueAddress, latitude: point.latitude, longitude: point.longitude } });
      notify('success', 'Venue location saved.');
      onSaved(res.event);
      onClose();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    const answer = await confirm({ title: 'Remove the venue location?', message: 'Volunteers will no longer be able to find this event on the map until a new location is set.', confirmLabel: 'Remove' });
    if (!answer.ok) return;
    setBusy(true);
    try {
      const res = await api<{ event: EventSummary }>(`/manage/events/${event.id}/location`, { method: 'DELETE' });
      notify('success', 'Venue location removed.');
      onSaved(res.event);
      setPoint(null);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Set location — ${event.name}`} onClose={onClose} wide>
      <div className="stack-form">
        <p className="muted">Use your current location or enter known coordinates to open the map, then click to fine-tune the venue marker.</p>
        <div className="field">
          <label htmlFor="ev-venue-address">Address or building detail (optional)</label>
          <input id="ev-venue-address" value={venueAddress} maxLength={300} onChange={(e) => setVenueAddress(e.target.value)} placeholder="e.g. Block C, 2nd floor" />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="ev-latitude">Latitude</label>
            <input id="ev-latitude" type="number" min={-90} max={90} step="any" value={latitude} onChange={(e) => { setLatitude(e.target.value); setSelectedPoint(null); }} placeholder="Use GPS or enter coordinates" />
          </div>
          <div className="field">
            <label htmlFor="ev-longitude">Longitude</label>
            <input id="ev-longitude" type="number" min={-180} max={180} step="any" value={longitude} onChange={(e) => { setLongitude(e.target.value); setSelectedPoint(null); }} placeholder="Longitude" />
          </div>
        </div>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={useMyLocation} disabled={usingGps}>
            {usingGps && gps.status === 'locating' ? 'Finding you…' : 'Use my current location'}
          </button>
          {usingGps && (gps.status === 'denied' || gps.status === 'unavailable') && <span className="muted">{gps.error ?? 'Could not get your location.'}</span>}
          {point && (
            <span className="muted">
              Marker at {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
            </span>
          )}
        </div>
        {point ? (
          <LocationMap
            center={point}
            zoom={17}
            markers={[{ id: 'venue', ...point, label: event.name, color: '#2563eb' }]}
            onPick={setPoint}
            height={360}
          />
        ) : (
          <Empty title="Choose a starting point">Use your current position or enter valid coordinates to place the venue marker on the map.</Empty>
        )}
        <div className="dialog-actions">
          {event.venueLocation && (
            <button type="button" className="btn btn-ghost" onClick={clear} disabled={busy}>
              Remove location
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !point}>
            {busy ? 'Saving…' : 'Save location'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------- activity form

function ActivityForm({ event, activity, onSaved, onClose }: { event: EventDetail; activity?: Activity; onSaved: () => void; onClose: () => void }) {
  const { notify, confirm } = useFeedback();
  const meta = useMeta();
  const [form, setForm] = useState({
    name: activity?.name ?? '',
    description: activity?.description ?? '',
    activityType: activity?.activityType ?? '',
    date: activity?.date ?? event.startDate,
    startTime: activity?.startTime ?? '09:00',
    endTime: activity?.endTime ?? '11:00',
    location: activity?.location ?? event.venue,
    requiredCount: String(activity?.requiredCount ?? 2),
    minPriorEvents: String(activity?.minPriorEvents ?? 0),
    instructions: activity?.instructions ?? '',
    status: activity?.status ?? 'open',
  });
  const [requireTestPass, setRequireTestPass] = useState(activity?.requireTestPass ?? false);
  const [requiredSkills, setRequiredSkills] = useState(activity?.requiredSkills ?? []);
  const [preferredSkills, setPreferredSkills] = useState(activity?.preferredSkills ?? []);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    const count = Number(form.requiredCount);
    if (!form.name.trim()) found.name = 'Activity name is required';
    if (!form.location.trim()) found.location = 'Location is required';
    if (!form.date) found.date = 'Choose a date';
    else if (form.date < event.startDate || form.date > event.endDate) found.date = `The date must fall within the event (${formatDay(event.startDate)} to ${formatDay(event.endDate)})`;
    if (!form.startTime) found.startTime = 'Choose a start time';
    if (!form.endTime) found.endTime = 'Choose an end time';
    else if (form.startTime && form.endTime <= form.startTime) found.endTime = 'The end time must be later than the start time';
    if (!Number.isInteger(count) || count < 1) found.requiredCount = 'Enter a whole number of at least 1';
    if (!Number.isInteger(Number(form.minPriorEvents)) || Number(form.minPriorEvents) < 0) found.minPriorEvents = 'Enter 0 or a whole number';
    setErrors(found);
    if (Object.keys(found).length) return;

    if (form.status === 'cancelled' && activity?.status !== 'cancelled') {
      const answer = await confirm({ title: 'Cancel this activity?', message: 'Its pending and confirmed assignments will be released and the volunteers notified.', confirmLabel: 'Cancel activity', danger: true });
      if (!answer.ok) return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const body = {
        ...form,
        activityType: form.activityType || null,
        requiredCount: count,
        minPriorEvents: Number(form.minPriorEvents),
        requiredSkills,
        preferredSkills,
        requireTestPass: requireTestPass && Boolean(form.activityType),
      };
      const res = await api<{ affectedAssignments?: { student: { fullName: string }; issues: string[] }[] }>(
        activity ? `/manage/activities/${activity.id}` : `/manage/events/${event.id}/activities`,
        { method: activity ? 'PUT' : 'POST', body },
      );
      const affected = res.affectedAssignments ?? [];
      if (affected.length) {
        notify('error', `Saved, but ${affected.length} existing assignment${affected.length === 1 ? ' no longer fits' : 's no longer fit'} this activity (${affected.map((a) => a.student.fullName).join(', ')}). They are flagged as conflicts below.`);
      } else notify('success', activity ? 'Activity updated. Existing assignments were re-checked.' : 'Activity added.');
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const input = (key: keyof typeof form, label: string, type = 'text', extra: Record<string, unknown> = {}) => (
    <div className={`field${errors[key] ? ' field-invalid' : ''}`}>
      <label htmlFor={`ac-${key}`}>{label}</label>
      <input id={`ac-${key}`} type={type} value={form[key]} onChange={(e) => set(key, e.target.value)} {...extra} />
      {errors[key] && <p className="field-error">{errors[key]}</p>}
    </div>
  );

  return (
    <Modal title={activity ? 'Edit activity' : 'Add activity'} onClose={onClose} wide>
      {!meta ? (
        <Spinner />
      ) : (
        <form className="stack-form" onSubmit={submit} noValidate>
          <div className="field-row">
            {input('name', 'Activity name')}
            <div className="field">
              <label htmlFor="ac-type">Activity type</label>
              <select id="ac-type" value={form.activityType} onChange={(e) => set('activityType', e.target.value)}>
                <option value="">Not specified</option>
                {meta.activityTypes.map((t) => <option key={t}>{t}</option>)}
              </select>
              <p className="field-hint">Decides which mock-test results count when ranking volunteers.</p>
              <label className="check">
                <input type="checkbox" checked={requireTestPass && Boolean(form.activityType)} disabled={!form.activityType} onChange={(e) => setRequireTestPass(e.target.checked)} /> Require a passed mock test
              </label>
              {errors.requireTestPass && <p className="field-error">{errors.requireTestPass}</p>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="ac-description">Description</label>
            <textarea id="ac-description" rows={2} maxLength={2000} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </div>
          <div className="field-row field-row-3">
            {input('date', 'Date', 'date', { min: event.startDate, max: event.endDate })}
            {input('startTime', 'Start time', 'time')}
            {input('endTime', 'End time', 'time')}
          </div>
          <div className="field-row field-row-3">
            {input('location', 'Location')}
            {input('requiredCount', 'Volunteers required', 'number', { min: 1, step: 1 })}
            {input('minPriorEvents', 'Prior activities required', 'number', { min: 0, step: 1 })}
          </div>
          <SkillPicker idPrefix="ac-required" label="Required skills" hint="Mandatory: a volunteer must have every one of these to be assigned." value={requiredSkills} onChange={setRequiredSkills} suggestions={meta.suggestedSkills} max={10} maxLength={meta.limits.maxSkillLength} error={errors.requiredSkills} />
          <SkillPicker idPrefix="ac-preferred" label="Nice-to-have skills" hint="Optional: improves a volunteer’s ranking but never excludes anyone." value={preferredSkills} onChange={setPreferredSkills} suggestions={meta.suggestedSkills} max={10} maxLength={meta.limits.maxSkillLength} error={errors.preferredSkills} />
          <div className="field">
            <label htmlFor="ac-instructions">Instructions for volunteers</label>
            <textarea id="ac-instructions" rows={2} maxLength={2000} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} />
          </div>
          <div className="field field-narrow">
            <label htmlFor="ac-status">Status</label>
            <select id="ac-status" value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="open">Open — can be staffed</option>
              <option value="closed">Closed — no new assignments</option>
              <option value="cancelled">Cancelled — releases assignments</option>
            </select>
          </div>
          {formError && <Alert kind="error">{formError}</Alert>}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : activity ? 'Save changes' : 'Add activity'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------- events list

export function EventsPage() {
  const navigate = useNavigate();
  const { data, error, loading } = useLoad(() => api<{ events: EventSummary[] }>('/manage/events'), []);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const shown = (data?.events ?? []).filter((e) => !query.trim() || `${e.name} ${e.venue}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="page page-wide">
      <PageHeader title="Events" subtitle="Create events, add activities and staff them." eyebrow="Event management">
        <button className="btn btn-primary" onClick={() => setCreating(true)}>Create event</button>
      </PageHeader>
      <div className="filters">
        <input aria-label="Search events" placeholder="Search events" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && shown.length === 0 && <Empty title={data.events.length ? 'No events match your search' : 'No events yet'}>{!data.events.length && 'Create your first event to start adding activities.'}</Empty>}
      <ul className="event-grid">
        {shown.map((e) => (
          <li key={e.id}>
            <Link className="event-card" to={`/manage/events/${e.id}`}>
              <div className="event-card-top">
                <div>
                  <strong>{e.name}</strong>
                  {e.isSampleData && <span className="tag tag-inline">sample</span>}
                </div>
                <StatusBadge status={e.status} />
              </div>
              <div className="event-card-meta">
                <span>{formatDay(e.startDate)}{e.endDate !== e.startDate && ` – ${formatDay(e.endDate)}`}</span>
                <span>{e.venue}</span>
              </div>
              <div className="event-card-metrics">
                <span>{e.activityCount} activit{e.activityCount === 1 ? 'y' : 'ies'}</span>
                <span>{e.positionsFilled} / {e.positionsRequired} filled</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {creating && <EventForm onClose={() => setCreating(false)} onSaved={(e) => navigate(`/manage/events/${e.id}`)} />}
    </div>
  );
}

// ------------------------------------------------------------ event detail

function AllocationResult({ report }: { report: AllocationReport }) {
  const added = report.activities.reduce((sum, a) => sum + a.newlyAssigned.length, 0);
  const short = report.activities.filter((a) => a.status === 'shortage');
  return (
    <section className="card">
      <div className="card-head">
        <h2>Latest allocation result</h2>
        <span className="muted">
          {new Date(report.generatedAt).toLocaleString()} · by {report.generatedBy}
        </span>
      </div>
      <Alert kind={short.length ? 'warn' : 'success'}>
        {added} new assignment{added === 1 ? '' : 's'} proposed from {report.totalVolunteers} registered volunteer{report.totalVolunteers === 1 ? '' : 's'}.
        {short.length > 0 && ` ${short.length} activit${short.length === 1 ? 'y is' : 'ies are'} short of volunteers.`}
        {report.clearedPending > 0 && ` ${report.clearedPending} earlier unconfirmed proposal${report.clearedPending === 1 ? ' was' : 's were'} replaced.`}
      </Alert>
      <ul className="report-list">
        {report.activities.map((a) => (
          <li key={a.activityId} className={`report-item report-${a.status}`}>
            <div className="activity-head">
              <strong>{a.name}</strong>
              <span className={`badge ${a.status === 'filled' ? 'badge-approved' : a.status === 'shortage' ? 'badge-needs_review' : ''}`}>
                {a.status === 'filled' ? 'Fully staffed' : a.status === 'shortage' ? `${a.vacancies} vacant` : 'Skipped'}
              </span>
            </div>
            <p className="muted">
              Required {a.required} · Assigned {a.assigned} ({a.alreadyAssigned} existing, {a.newlyAssigned.length} new) · Vacancies {a.vacancies}
            </p>
            {a.newlyAssigned.length > 0 && (
              <ul className="candidate-list">
                {a.newlyAssigned.map((n) => (
                  <li key={n.studentId}>
                    <div>
                      <strong>{n.fullName}</strong> <span className="muted">· {n.usn}</span>
                      <div className="muted">{n.explanation.join(' · ')}</div>
                    </div>
                    <span className="score" title="Suitability score out of 100">{n.score}</span>
                  </li>
                ))}
              </ul>
            )}
            {a.shortageReason && <p className="issue-text">Shortage: {a.shortageReason}</p>}
            {a.warnings.map((w) => <p key={w} className="issue-text">{w}</p>)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StaffingProgress({ activity }: { activity: ManagedActivity }) {
  const confirmed = Math.min(100, (activity.confirmed / activity.requiredCount) * 100);
  const pending = Math.min(100 - confirmed, (activity.pending / activity.requiredCount) * 100);

  return (
    <div
      className="staffing-progress"
      role="group"
      aria-label={`${activity.name}: ${activity.confirmed} confirmed, ${activity.pending} awaiting confirmation, ${activity.vacancies} vacant of ${activity.requiredCount} positions`}
    >
      <div className="staffing-progress-track" aria-hidden="true">
        <span className="staffing-progress-confirmed" style={{ width: `${confirmed}%` }} />
        <span className="staffing-progress-pending" style={{ width: `${pending}%` }} />
      </div>
      <div className="staffing-progress-legend">
        <span><i className="staffing-key staffing-key-confirmed" />{activity.confirmed} confirmed</span>
        <span><i className="staffing-key staffing-key-pending" />{activity.pending} pending</span>
        <span><i className="staffing-key staffing-key-vacant" />{activity.vacancies} vacant</span>
      </div>
    </div>
  );
}

export function EventDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { notify, confirm } = useFeedback();
  const detail = useLoad(() => api<{ event: EventDetail }>(`/manage/events/${id}`), [id]);
  const assignments = useLoad(() => api<{ assignments: ManagedAssignment[] }>(`/manage/assignments?eventId=${id}`), [id]);
  const [editingEvent, setEditingEvent] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [activityForm, setActivityForm] = useState<{ activity?: ManagedActivity } | null>(null);
  const [assigning, setAssigning] = useState<ManagedActivity | null>(null);
  const [busy, setBusy] = useState<'allocate' | 'confirm' | null>(null);

  const reload = () => {
    void detail.reload();
    void assignments.reload();
  };

  if (detail.loading && !detail.data) return <div className="page"><Spinner label="Loading event…" /></div>;
  if (detail.error && !detail.data) return <div className="page"><Alert kind="error">{detail.error}</Alert><Link to="/manage/events">Back to events</Link></div>;
  if (!detail.data) return null;
  const event = detail.data.event;
  const list = assignments.data?.assignments ?? [];
  const live = list.filter((a) => a.status === 'pending' || a.status === 'confirmed');
  const pending = list.filter((a) => a.status === 'pending');
  const conflicts = list.filter((a) => a.issues.length);
  const open = event.activities.filter((a) => a.status !== 'cancelled');
  const required = open.reduce((sum, a) => sum + a.requiredCount, 0);
  const vacancies = open.reduce((sum, a) => sum + a.vacancies, 0);
  const locked = event.status === 'cancelled' || event.status === 'completed';

  const allocate = async () => {
    let clearPending = false;
    if (pending.some((a) => a.source === 'auto')) {
      const answer = await confirm({
        title: 'Regenerate the allocation?',
        message: 'Unconfirmed automatic proposals will be recalculated from scratch. Confirmed assignments and manual assignments are kept exactly as they are.',
        confirmLabel: 'Regenerate',
      });
      if (!answer.ok) return;
      clearPending = true;
    }
    setBusy('allocate');
    try {
      await api(`/manage/events/${event.id}/allocate`, { body: { clearPending } });
      notify('success', 'Allocation generated. Review the proposals below and confirm them.');
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const confirmAll = async () => {
    setBusy('confirm');
    try {
      const res = await api<{ confirmed: number; failed: { error: string }[] }>(`/manage/events/${event.id}/assignments/confirm-all`, { method: 'POST' });
      if (res.failed.length) notify('error', `${res.confirmed} confirmed. ${res.failed.length} could not be confirmed: ${res.failed[0].error}`);
      else notify('success', `${res.confirmed} assignment${res.confirmed === 1 ? '' : 's'} confirmed.`);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const removeActivity = async (activity: ManagedActivity) => {
    const answer = await confirm({ title: 'Delete this activity?', message: `"${activity.name}" will be removed permanently.`, confirmLabel: 'Delete', danger: true });
    if (!answer.ok) return;
    try {
      await api(`/manage/activities/${activity.id}`, { method: 'DELETE' });
      notify('success', 'Activity deleted.');
    } catch (err) {
      notify('error', errorMessage(err));
    }
    reload();
  };

  const removeEvent = async () => {
    const answer = await confirm({ title: 'Delete this event?', message: `"${event.name}" and its activities will be removed permanently.`, confirmLabel: 'Delete event', danger: true });
    if (!answer.ok) return;
    try {
      await api(`/manage/events/${event.id}`, { method: 'DELETE' });
      notify('success', 'Event deleted.');
      navigate('/manage/events');
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };

  return (
    <div className="page page-wide">
      <Link to="/manage/events" className="back-link">← All events</Link>
      <PageHeader title={event.name} subtitle={`${formatDay(event.startDate)}${event.endDate !== event.startDate ? ` – ${formatDay(event.endDate)}` : ''} · ${event.venue}`} eyebrow="Event detail">
        <StatusBadge status={event.status} />
        <button className="btn btn-secondary" onClick={() => setEditingEvent(true)}>Edit event</button>
        <button className="btn btn-secondary" onClick={() => setEditingLocation(true)}>{event.venueLocation ? 'Edit location' : 'Set location on map'}</button>
        <button className="btn btn-ghost" onClick={removeEvent}>Delete</button>
      </PageHeader>
      {event.description && <p>{event.description}</p>}
      {event.status === 'draft' && <Alert kind="info">This event is a draft. Students cannot see it or its activities until you publish it (Edit event → Status).</Alert>}
      {!event.venueLocation && (
        <Alert kind="info">
          No map location is set for this venue yet. Volunteers can still see the venue name and address, but cannot navigate to it.{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => setEditingLocation(true)}>Set it now</button>
        </Alert>
      )}

      <dl className="stat-grid">
        <StatTile label="Positions required" value={required} />
        <StatTile label="Assigned" value={live.length} note={`${live.length - pending.length} confirmed · ${pending.length} pending`} />
        <StatTile label="Vacancies" value={vacancies} tone={vacancies ? 'warn' : undefined} />
        <StatTile label="Conflicts" value={conflicts.length} tone={conflicts.length ? 'bad' : undefined} />
      </dl>

      <section className="card">
        <div className="card-head">
          <h2>Activities</h2>
          <div className="page-actions">
            <button className="btn btn-secondary" disabled={locked} onClick={() => setActivityForm({})}>Add activity</button>
            <button className="btn btn-primary" disabled={locked || busy !== null || open.length === 0} onClick={allocate}>
              {busy === 'allocate' ? 'Generating…' : 'Generate allocation'}
            </button>
          </div>
        </div>
        {event.activities.length === 0 ? (
          <Empty title="No activities yet">Add the activities that need volunteers, then generate an allocation.</Empty>
        ) : (
          <ul className="activity-list">
            {event.activities.map((a) => (
              <li className="activity-card" key={a.id}>
                <div className="activity-head">
                  <div>
                    <strong>{a.name}</strong>
                    {a.activityType && <span className="muted"> · {a.activityType}</span>}
                  </div>
                  <div className="row-actions">
                    {a.status !== 'open' && <StatusBadge status={a.status} />}
                    <span className={`badge ${a.vacancies === 0 ? 'badge-approved' : 'badge-needs_review'}`}>
                      {a.confirmed + a.pending} / {a.requiredCount} filled
                    </span>
                  </div>
                </div>
                <p className="muted">
                  {formatDay(a.date)} · {a.startTime}–{a.endTime} · {a.location} · {a.confirmed} confirmed, {a.pending} pending, {a.vacancies} vacant
                  {a.minPriorEvents > 0 && ` · needs ${a.minPriorEvents} prior activit${a.minPriorEvents === 1 ? 'y' : 'ies'}`}
                  {a.requireTestPass && ' · requires a passed mock test'}
                </p>
                <StaffingProgress activity={a} />
                <p>
                  <span className="muted">Required: </span><Chips items={a.requiredSkills} empty="No specific skills" />
                  {a.preferredSkills.length > 0 && <><span className="muted"> Nice to have: </span><Chips items={a.preferredSkills} /></>}
                </p>
                <div className="row-actions">
                  <button className="btn btn-secondary btn-sm" disabled={locked || a.status !== 'open' || a.vacancies === 0} onClick={() => setAssigning(a)}>Assign volunteer</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setActivityForm({ activity: a })}>Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeActivity(a)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <LiveVolunteerMap event={event} />
      <EmergencyFinder event={event} />

      {event.lastAllocation && <AllocationResult report={event.lastAllocation} />}

      <section className="card">
        <div className="card-head">
          <h2>Assignments</h2>
          <button className="btn btn-primary" disabled={busy !== null || pending.length === 0} onClick={confirmAll}>
            {busy === 'confirm' ? 'Confirming…' : `Confirm all pending (${pending.length})`}
          </button>
        </div>
        {assignments.loading && !assignments.data && <Spinner />}
        {assignments.error && <Alert kind="error">{assignments.error}</Alert>}
        {assignments.data && (list.length === 0 ? <Empty title="No assignments yet">Generate an allocation or assign volunteers to an activity.</Empty> : <AssignmentTable assignments={list} onChanged={reload} />)}
      </section>

      {editingEvent && <EventForm event={event} onClose={() => setEditingEvent(false)} onSaved={reload} />}
      {editingLocation && <EventLocationModal event={event} onClose={() => setEditingLocation(false)} onSaved={reload} />}
      {activityForm && <ActivityForm event={event} activity={activityForm.activity} onClose={() => setActivityForm(null)} onSaved={reload} />}
      {assigning && (
        <CandidatePicker
          activityId={assigning.id}
          activityName={assigning.name}
          actionLabel="Assign"
          onClose={() => setAssigning(null)}
          onPick={async (studentId) => {
            await api(`/manage/activities/${assigning.id}/assignments`, { body: { studentId } });
            notify('success', 'Volunteer assigned. The assignment is pending confirmation.');
            reload();
          }}
        />
      )}
    </div>
  );
}
