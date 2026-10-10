import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Analytics, type AssignmentStatus, type EventDetail, type EventSummary, type ManagedAssignment, type VolunteerRow } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Empty, Spinner, useLoad } from '../../components';
import { Chips, PageHeader, StatTile, formatDay, useMeta } from '../../ui';
import { AssignmentTable } from './shared';

// ---------------------------------------------------------------- charts

/** One horizontal bar per row, with the value printed beside it. */
function BarList({ rows, unit, emptyText }: { rows: { label: string; value: number; note?: string }[]; unit: string; emptyText: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="muted">{emptyText}</p>;
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${r.value} ${unit}`}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bar-value">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Confirmed and pending seats against the number required, per activity. */
function AllocationBars({ rows }: { rows: Analytics['activityAllocation'] }) {
  if (!rows.length) return <p className="muted">No activities yet.</p>;
  const max = Math.max(...rows.map((r) => Math.max(r.required, r.confirmed + r.pending)));
  const pct = (n: number) => `${(n / max) * 100}%`;
  return (
    <>
      <ul className="legend" aria-label="Legend">
        <li><span className="swatch swatch-confirmed" /> Confirmed</li>
        <li><span className="swatch swatch-pending" /> Pending approval</li>
        <li><span className="swatch swatch-vacant" /> Vacant</li>
      </ul>
      <ul className="bars bars-stacked">
        {rows.map((r) => (
          <li key={r.activityId} title={`${r.name}: ${r.confirmed} confirmed, ${r.pending} pending, ${r.vacancies} vacant of ${r.required} required`}>
            <span className="bar-label">
              {r.name}
              <small>{r.eventName}</small>
            </span>
            <span className="bar-track bar-track-clear">
              {r.confirmed > 0 && <span className="bar-seg seg-confirmed" style={{ width: pct(r.confirmed) }} />}
              {r.pending > 0 && <span className="bar-seg seg-pending" style={{ width: pct(r.pending) }} />}
              {r.vacancies > 0 && <span className="bar-seg seg-vacant" style={{ width: pct(r.vacancies) }} />}
            </span>
            <span className="bar-value">
              {r.confirmed + r.pending}/{r.required}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// -------------------------------------------------------------- dashboard

export function ManagerDashboard() {
  const { me } = useAuth();
  const [eventId, setEventId] = useState('');
  const { data, error, loading } = useLoad(() => api<Analytics>(`/manage/analytics${eventId ? `?eventId=${eventId}` : ''}`), [eventId]);
  const events = useLoad(() => api<{ events: EventSummary[] }>('/manage/events'), []);
  const t = data?.totals;

  return (
    <div className="page page-wide">
      <PageHeader title="Dashboard" subtitle={me?.user.role === 'organizer' ? 'Staffing for the events you manage.' : 'Staffing across all events.'} eyebrow="Operations overview">
        <select aria-label="Event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">All events</option>
          {events.data?.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </PageHeader>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {t && data && (
        <>
          <dl className="stat-grid">
            <StatTile label="Registered volunteers" value={t.volunteers} note={`${t.volunteersWithCompleteProfile} with a complete profile`} tone="info" />
            <StatTile label="Events" value={t.events} note={`${t.activities} activities`} tone="violet" />
            <StatTile label="Positions required" value={t.positionsRequired} note="In upcoming activities" tone="brand" />
            <StatTile label="Positions assigned" value={t.positionsAssigned} note={`${t.positionsConfirmed} confirmed`} tone="good" />
            <StatTile label="Pending approvals" value={t.pendingApprovals} tone={t.pendingApprovals ? 'warn' : 'info'} />
            <StatTile label="Remaining vacancies" value={t.vacancies} tone={t.vacancies ? 'warn' : 'good'} />
            <StatTile label="Conflicts" value={t.conflicts} tone={t.conflicts ? 'bad' : 'good'} note={t.conflicts ? 'See Assignments' : 'None detected'} />
          </dl>

          <section className={`next-actions manager-actions${t.pendingApprovals || t.vacancies || t.conflicts ? ' manager-actions-alert' : ''}`} aria-labelledby="manager-next-actions">
            <div className="next-actions-heading">
              <span className="next-actions-kicker">Operations queue</span>
              <h2 id="manager-next-actions">{t.pendingApprovals || t.vacancies || t.conflicts ? 'Items need your attention' : 'Staffing is on track'}</h2>
              <p className="muted">
                {t.pendingApprovals || t.vacancies || t.conflicts
                  ? 'Review live assignment and vacancy data before making changes.'
                  : 'No pending approvals, open vacancies, or assignment conflicts in this view.'}
              </p>
            </div>
            <div className="next-action-links">
              {t.pendingApprovals > 0 && (
                <Link className="next-action next-action-attention" to="/manage/assignments">
                  <span><strong>Review proposals</strong><small>{t.pendingApprovals} awaiting approval</small></span>
                  <span className="next-action-arrow" aria-hidden="true">→</span>
                </Link>
              )}
              {t.vacancies > 0 && (
                <Link className="next-action next-action-attention" to="/manage/events">
                  <span><strong>Review staffing</strong><small>{t.vacancies} positions remain vacant</small></span>
                  <span className="next-action-arrow" aria-hidden="true">→</span>
                </Link>
              )}
              {t.conflicts > 0 && (
                <Link className="next-action next-action-attention" to="/manage/assignments">
                  <span><strong>Resolve conflicts</strong><small>{t.conflicts} assignments flagged</small></span>
                  <span className="next-action-arrow" aria-hidden="true">→</span>
                </Link>
              )}
              {!t.pendingApprovals && !t.vacancies && !t.conflicts && (
                <Link className="next-action" to="/manage/events">
                  <span><strong>Manage events</strong><small>Review event plans and volunteer roles</small></span>
                  <span className="next-action-arrow" aria-hidden="true">→</span>
                </Link>
              )}
            </div>
          </section>

          {data.understaffed.length > 0 && (
            <section className="card">
              <h2>Understaffed activities</h2>
              <ul className="plain-list">
                {data.understaffed.map((a) => (
                  <li key={a.activityId}>
                    <strong>{a.name}</strong>
                    <span className="muted"> · {a.eventName} · {formatDay(a.date)} · </span>
                    <span className="issue-text">{a.vacancies} of {a.required} positions vacant</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <h2>Allocation by activity</h2>
            <AllocationBars rows={data.activityAllocation} />
          </section>

          <div className="grid-2">
            <section className="card">
              <h2>Volunteer skills</h2>
              <p className="muted">Number of volunteers listing each skill.</p>
              <BarList rows={data.skillDistribution.slice(0, 12).map((s) => ({ label: s.skill, value: s.volunteers }))} unit="volunteers" emptyText="No volunteer has added skills yet." />
            </section>
            <section className="card">
              <h2>Volunteer workload</h2>
              <p className="muted">Volunteers by hours currently assigned (pending and confirmed).</p>
              <BarList rows={data.workloadDistribution.map((w) => ({ label: w.label, value: w.volunteers }))} unit="volunteers" emptyText="No volunteers yet." />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ assignments

const STATUSES: (AssignmentStatus | '')[] = ['', 'pending', 'confirmed', 'rejected', 'cancelled'];

export function ManageAssignmentsPage() {
  const [filters, setFilters] = useState({ eventId: '', activityId: '', status: '', date: '', q: '' });
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const events = useLoad(() => api<{ events: EventSummary[] }>('/manage/events'), []);
  const eventDetail = useLoad(
    () => (filters.eventId ? api<{ event: EventDetail }>(`/manage/events/${filters.eventId}`) : Promise.resolve(null)),
    [filters.eventId],
  );
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { data, error, loading, reload } = useLoad(() => api<{ assignments: ManagedAssignment[] }>(`/manage/assignments${query ? `?${query}` : ''}`), [query]);
  const set = (key: keyof typeof filters, value: string) => setFilters((f) => ({ ...f, [key]: value, ...(key === 'eventId' ? { activityId: '' } : {}) }));

  const all = data?.assignments ?? [];
  const shown = onlyConflicts ? all.filter((a) => a.issues.length) : all;
  const conflicts = all.filter((a) => a.issues.length).length;

  // Hours of live assignments per volunteer, for the workload summary.
  const workload = new Map<string, { name: string; hours: number; count: number }>();
  for (const a of all) {
    if (a.status !== 'pending' && a.status !== 'confirmed') continue;
    const entry = workload.get(a.student.id) ?? { name: a.student.fullName, hours: 0, count: 0 };
    entry.hours += a.hours;
    entry.count += 1;
    workload.set(a.student.id, entry);
  }
  const busiest = [...workload.values()].sort((a, b) => b.hours - a.hours).slice(0, 6);

  return (
    <div className="page page-wide">
      <PageHeader title="Assignments" subtitle="Approve, change and track volunteer assignments." />
      <div className="filters">
        <select aria-label="Event" value={filters.eventId} onChange={(e) => set('eventId', e.target.value)}>
          <option value="">All events</option>
          {events.data?.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select aria-label="Activity" value={filters.activityId} onChange={(e) => set('activityId', e.target.value)} disabled={!filters.eventId}>
          <option value="">{filters.eventId ? 'All activities' : 'Choose an event first'}</option>
          {eventDetail.data?.event.activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select aria-label="Status" value={filters.status} onChange={(e) => set('status', e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s ? s[0].toUpperCase() + s.slice(1) : 'Any status'}</option>)}
        </select>
        <input aria-label="Date" type="date" value={filters.date} onChange={(e) => set('date', e.target.value)} />
        <input aria-label="Search volunteer" placeholder="Volunteer name or USN" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlyConflicts} onChange={(e) => setOnlyConflicts(e.target.checked)} /> Conflicts only ({conflicts})
        </label>
      </div>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && <AssignmentTable assignments={shown} onChanged={reload} showEvent />}
      {busiest.length > 0 && (
        <section className="card">
          <h2>Volunteer workload</h2>
          <p className="muted">Live assignments in the current view, heaviest first.</p>
          <ul className="plain-list">
            {busiest.map((w) => (
              <li key={w.name}>
                <strong>{w.name}</strong> <span className="muted">· {Math.round(w.hours * 100) / 100} h across {w.count} assignment{w.count === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// -------------------------------------------------------------- volunteers

export function VolunteersPage() {
  const meta = useMeta();
  const [q, setQ] = useState('');
  const [skill, setSkill] = useState('');
  const [sort, setSort] = useState<'name' | 'hours' | 'experience'>('name');
  const query = new URLSearchParams(Object.entries({ q, skill }).filter(([, v]) => v)).toString();
  const { data, error, loading } = useLoad(() => api<{ volunteers: VolunteerRow[] }>(`/manage/volunteers${query ? `?${query}` : ''}`), [query]);
  const rows = [...(data?.volunteers ?? [])].sort((a, b) =>
    sort === 'hours' ? b.assignedHours - a.assignedHours : sort === 'experience' ? b.attendedCount - a.attendedCount : a.fullName.localeCompare(b.fullName),
  );

  return (
    <div className="page page-wide">
      <PageHeader title="Volunteers" subtitle="Registered students, their skills and when they are available." />
      <div className="filters">
        <input aria-label="Search volunteers" placeholder="Name or USN" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Skill" value={skill} onChange={(e) => setSkill(e.target.value)}>
          <option value="">Any skill</option>
          {meta?.suggestedSkills.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="name">Sort by name</option>
          <option value="hours">Sort by assigned hours</option>
          <option value="experience">Sort by experience</option>
        </select>
      </div>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && rows.length === 0 && <Empty title="No volunteers found">{q || skill ? 'Nothing matches your filters.' : 'No students have registered yet.'}</Empty>}
      <ul className="volunteer-list">
        {rows.map((v) => (
          <li className="activity-card" key={v.id}>
            <div className="activity-head">
              <div>
                <strong>{v.fullName}</strong>
                <span className="muted"> · {v.usn}{v.department ? ` · ${v.department}` : ''}{v.semester ? ` · Sem ${v.semester}` : ''}</span>
              </div>
              <span className={`badge ${v.profileComplete ? 'badge-approved' : 'badge-needs_review'}`}>{v.profileComplete ? 'Profile complete' : 'Profile incomplete'}</span>
            </div>
            <p className="muted">
              {v.email} · {v.phone} · {v.attendedCount} attended · {v.assignedHours} h currently assigned ({v.liveAssignments}) · max {v.maxHoursPerDay ?? '—'} h/day
            </p>
            <p><span className="muted">Skills: </span><Chips items={v.skills} empty="None listed" /></p>
            {v.preferences.length > 0 && <p><span className="muted">Prefers: </span><Chips items={v.preferences} /></p>}
            <details>
              <summary>Availability ({v.availability.length} slot{v.availability.length === 1 ? '' : 's'})</summary>
              {v.availability.length === 0 ? (
                <p className="muted">No availability given.</p>
              ) : (
                <ul className="plain-list">
                  {v.availability.map((s) => <li key={`${s.date}${s.startTime}`}>{formatDay(s.date)} · {s.startTime}–{s.endTime}</li>)}
                </ul>
              )}
            </details>
          </li>
        ))}
      </ul>
      <p className="muted">
        Need to staff an activity? Open it from <Link to="/manage/events">Events</Link> and use “Assign volunteer” to see who qualifies.
      </p>
    </div>
  );
}
