import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, type AssignmentBase, type AvailableActivity, type StudentDashboardData } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Empty, Notifications, Spinner, StatusBadge, formatDate, useLoad } from '../../components';
import { Chips, PageHeader, StatTile, formatDay, useFeedback } from '../../ui';

const PROMOTION_COPY: Record<string, string> = {
  pending: 'Your request is waiting for a faculty reviewer.',
  needs_review: 'A faculty reviewer has asked for further review before deciding.',
  approved: 'Your promotion was approved.',
  rejected: 'This request was not approved. You may request again later.',
};

function AssignmentCard({ a, onCancel }: { a: AssignmentBase; onCancel?: (a: AssignmentBase) => void }) {
  return (
    <li className="duty">
      <div className="duty-when">
        <strong>{formatDay(a.activity.date)}</strong>
        <span>
          {a.activity.startTime}–{a.activity.endTime} · {a.hours} h
        </span>
      </div>
      <div className="duty-what">
        <strong>{a.activity.name}</strong>
        <span className="muted">
          {a.event.name} · {a.activity.location}
        </span>
        {a.activity.instructions && <p className="duty-note">Instructions: {a.activity.instructions}</p>}
        {a.statusReason && (a.status === 'rejected' || a.status === 'cancelled') && <p className="muted">Reason: {a.statusReason}</p>}
        {a.ended && a.status === 'confirmed' && (
          <p className="muted">
            Attendance: {a.attendance === 'attended' ? 'Attended' : a.attendance === 'absent' ? 'Absent' : 'Not recorded yet'}
            {a.rating !== null && ` · Rated ${a.rating}/5`}
          </p>
        )}
      </div>
      <div className="duty-side">
        <StatusBadge status={a.status} />
        {onCancel && !a.started && (a.status === 'pending' || a.status === 'confirmed') && (
          <button className="btn btn-ghost btn-sm" onClick={() => onCancel(a)}>
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

function ActivityCard({ a }: { a: AvailableActivity }) {
  return (
    <li className="activity-card">
      <div className="activity-head">
        <div>
          <strong>{a.name}</strong>
          <span className="muted"> · {a.event.name}</span>
        </div>
        {a.myStatus ? <StatusBadge status={a.myStatus} /> : <span className={`badge ${a.eligible ? 'badge-approved' : ''}`}>{a.eligible ? 'You qualify' : 'Not eligible'}</span>}
      </div>
      <p className="muted">
        {formatDay(a.date)} · {a.startTime}–{a.endTime} · {a.location} · {a.vacancies} of {a.requiredCount} positions open
      </p>
      {a.description && <p>{a.description}</p>}
      <p>
        <span className="muted">Skills needed: </span>
        <Chips items={a.requiredSkills} empty="None" />
      </p>
      {!a.eligible && !a.myStatus && (
        <ul className="reasons">
          {a.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function PromotionCard() {
  const { me, refresh } = useAuth();
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const latest = me.promotionRequests[0];
  const hasOpen = latest && (latest.status === 'pending' || latest.status === 'needs_review');

  const requestPromotion = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/promotion-requests', { body: { statement } });
      setStatement('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Organizer promotion</h2>
      <p className="muted">
        Organizers are students promoted by a faculty member, based on their volunteering record. Requesting does not change your role — a faculty member decides.
      </p>
      {latest ? (
        <div className="status-panel">
          <div className="status-head">
            <StatusBadge status={latest.status} />
            <span className="muted">Requested {formatDate(latest.createdAt)}</span>
          </div>
          <p>{PROMOTION_COPY[latest.status]}</p>
          {latest.reviewReason && (
            <p className="quote">
              <span className="muted">Reviewer’s note ({formatDate(latest.reviewedAt)}):</span> {latest.reviewReason}
            </p>
          )}
        </div>
      ) : (
        <div className="status-panel">
          <p>You have not requested a promotion yet.</p>
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      {!hasOpen && (
        <div className="stack">
          <div className="field">
            <label htmlFor="statement">Why would you like to organize? (optional)</label>
            <textarea id="statement" rows={2} maxLength={1000} value={statement} onChange={(e) => setStatement(e.target.value)} />
          </div>
          <button className="btn btn-secondary" onClick={requestPromotion} disabled={busy}>
            {busy ? 'Sending…' : 'Request organizer promotion'}
          </button>
        </div>
      )}
    </section>
  );
}

export function StudentDashboard() {
  const { me } = useAuth();
  const { data, error, loading } = useLoad(() => api<StudentDashboardData>('/student/dashboard'), []);
  if (!me) return null;

  return (
    <div className="page page-wide">
      <PageHeader title={`Welcome, ${me.user.fullName.split(' ')[0]}`} subtitle="Your volunteering at a glance." eyebrow="Student dashboard" />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <dl className="stat-grid">
            <StatTile label="Profile" value={`${data.profile.completion.percent}%`} note={data.profile.complete ? 'Complete' : 'Incomplete'} tone={data.profile.complete ? 'good' : 'warn'} />
            <StatTile label="Pending proposals" value={data.pendingAssignments.length} note="Awaiting organizer confirmation" tone="info" />
            <StatTile label="Confirmed duties" value={data.confirmedAssignments.length} note={`${data.totals.upcomingHours} h upcoming`} tone="good" />
            <StatTile label="Volunteer hours" value={data.totals.completedHours} note={`${data.totals.completedActivities} activities completed`} tone="violet" />
          </dl>

          <section className="next-actions" aria-labelledby="student-next-actions">
            <div className="next-actions-heading">
              <span className="next-actions-kicker">Your next steps</span>
              <h2 id="student-next-actions">Keep your volunteering moving</h2>
            </div>
            <div className="next-action-links">
              <Link className="next-action" to="/student/activities">
                <span><strong>Explore activities</strong><small>{data.availableActivities.length} open opportunities to review</small></span>
                <span className="next-action-arrow" aria-hidden="true">→</span>
              </Link>
              <Link className={`next-action${data.pendingAssignments.length ? ' next-action-attention' : ''}`} to="/student/assignments">
                <span><strong>Track assignments</strong><small>{data.pendingAssignments.length ? `${data.pendingAssignments.length} awaiting organizer confirmation` : 'No proposals awaiting confirmation'}</small></span>
                <span className="next-action-arrow" aria-hidden="true">→</span>
              </Link>
              <Link className="next-action" to="/student/assignments">
                <span><strong>View my assignments</strong><small>{data.confirmedAssignments.length} confirmed duties</small></span>
                <span className="next-action-arrow" aria-hidden="true">→</span>
              </Link>
            </div>
          </section>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Upcoming duties</h2>
              </div>
              {data.schedule.length === 0 ? (
                <Empty title="No confirmed duties yet">Confirmed assignments appear here.</Empty>
              ) : (
                <ul className="duty-list">{data.schedule.slice(0, 4).map((a) => <AssignmentCard key={a.id} a={a} />)}</ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Pending assignment requests</h2>
                <Link to="/student/assignments">All assignments</Link>
              </div>
              {data.pendingAssignments.length === 0 ? (
                <Empty title="Nothing pending">When you are proposed for an activity it shows up here until an organizer confirms it.</Empty>
              ) : (
                <ul className="duty-list">{data.pendingAssignments.slice(0, 4).map((a) => <AssignmentCard key={a.id} a={a} />)}</ul>
              )}
            </section>
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Upcoming events</h2>
              </div>
              {data.upcomingEvents.length === 0 ? (
                <p className="muted">No upcoming events have been published yet.</p>
              ) : (
                <ul className="plain-list">
                  {data.upcomingEvents.map((e) => (
                    <li key={e.id}>
                      <strong>{e.name}</strong>
                      <span className="muted">
                        {' '}· {formatDay(e.startDate)}
                        {e.endDate !== e.startDate && ` to ${formatDay(e.endDate)}`} · {e.venue}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Available activities</h2>
                <Link to="/student/activities">See all</Link>
              </div>
              {data.availableActivities.length === 0 ? (
                <Empty title="No open activities">Activities appear here once an event is published.</Empty>
              ) : (
                <ul className="activity-list">{data.availableActivities.slice(0, 3).map((a) => <ActivityCard key={a.id} a={a} />)}</ul>
              )}
            </section>
          </div>

          <PromotionCard />
        </>
      )}
    </div>
  );
}

export function ActivitiesPage() {
  const { data, error, loading } = useLoad(() => api<{ activities: AvailableActivity[] }>('/student/activities'), []);
  const [onlyEligible, setOnlyEligible] = useState(false);
  const [query, setQuery] = useState('');
  const shown = (data?.activities ?? [])
    .filter((a) => !onlyEligible || a.eligible)
    .filter((a) => !query.trim() || `${a.name} ${a.event.name} ${a.requiredSkills.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="page">
      <PageHeader title="Available activities" subtitle="Open volunteer positions in published events. Organizers assign volunteers who qualify; you will be notified if you are proposed." eyebrow="Student opportunities" />
      <div className="filters">
        <input aria-label="Search activities" placeholder="Search by activity, event or skill" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlyEligible} onChange={(e) => setOnlyEligible(e.target.checked)} /> Only ones I qualify for
        </label>
      </div>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && shown.length === 0 && <Empty title="No activities to show">{data.activities.length ? 'Nothing matches your filters.' : 'No open activities have been published yet.'}</Empty>}
      <ul className="activity-list">{shown.map((a) => <ActivityCard key={a.id} a={a} />)}</ul>
    </div>
  );
}

const STATUS_FILTERS = ['all', 'pending', 'confirmed', 'rejected', 'cancelled'] as const;

export function AssignmentsPage() {
  const { notify, confirm } = useFeedback();
  const { data, error, loading, reload } = useLoad(() => api<{ assignments: AssignmentBase[] }>('/student/assignments'), []);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const shown = (data?.assignments ?? []).filter((a) => filter === 'all' || a.status === filter);

  const cancel = async (a: AssignmentBase) => {
    const answer = await confirm({
      title: 'Cancel this assignment?',
      message: `You will be removed from "${a.activity.name}" on ${formatDay(a.activity.date)}. The organizer is notified and may give the position to someone else.`,
      confirmLabel: 'Cancel assignment',
      danger: true,
      reasonLabel: 'Reason (optional)',
    });
    if (!answer.ok) return;
    try {
      await api(`/student/assignments/${a.id}/cancel`, { body: { reason: answer.reason } });
      notify('success', 'Assignment cancelled.');
      await reload();
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };

  return (
    <div className="page">
      <PageHeader title="My assignments" subtitle="Every assignment proposed to you, with its current status." eyebrow="My activity status" />
      <div className="tabs tabs-wrap" role="tablist" aria-label="Status">
        {STATUS_FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? ' tab-active' : ''}`} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && shown.length === 0 && <Empty title="No assignments here">{filter === 'all' ? 'You have not been assigned to any activity yet.' : `You have no ${filter} assignments.`}</Empty>}
      <ul className="duty-list">{shown.map((a) => <AssignmentCard key={a.id} a={a} onCancel={cancel} />)}</ul>
    </div>
  );
}

export function NotificationsPage() {
  return (
    <div className="page">
      <PageHeader title="Notifications" eyebrow="Updates" />
      <Notifications />
    </div>
  );
}
