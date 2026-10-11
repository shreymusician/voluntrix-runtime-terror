import { useState } from 'react';
import { api, errorMessage } from '../../api';
import { Alert, Empty, Spinner, useLoad } from '../../components';
import { externalNavigationUrl, formatDistance } from '../../mapUtils';
import { useFeedback } from '../../ui';

type EmergencyInvitation = {
  id: string;
  status: 'pending';
  distanceMeters: number;
  request: {
    id: string;
    title: string;
    description: string;
    instructions: string;
    urgency: 'normal' | 'high' | 'critical';
    requiredCount: number;
    startAt: string;
    endAt: string;
    specialistSkills: string[];
  };
  event: {
    id: string;
    name: string;
    venue: string;
    venueAddress: string | null;
    venueLocation: { latitude: number; longitude: number } | null;
  };
};

export function EmergencyInbox() {
  const { notify } = useFeedback();
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => api<{ invitations: EmergencyInvitation[] }>('/student/emergency-invitations'), []);

  const respond = async (invitation: EmergencyInvitation, response: 'accept' | 'decline') => {
    setBusyId(invitation.id);
    try {
      const result = await api<{ status: string; requestStatus?: string }>(`/student/emergency-invitations/${invitation.id}/respond`, { method: 'POST', body: { response } });
      notify('success', response === 'accept'
        ? `You are confirmed to help with "${invitation.request.title}".`
        : 'You declined the emergency request.');
      if (result.requestStatus === 'filled') notify('success', 'The required volunteer positions are now filled.');
      await reload();
    } catch (err) {
      notify('error', errorMessage(err));
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !data) return <section className="card"><Spinner label="Checking emergency requests…" /></section>;
  if (error && !data) return <section className="card"><h2>Emergency opportunities</h2><Alert kind="error">{error}</Alert></section>;

  return (
    <section className="card emergency-inbox">
      <div className="card-head">
        <div>
          <h2>Emergency opportunities</h2>
          <p className="muted">You decide whether to help. Accepting rechecks your schedule and confirms an assignment.</p>
        </div>
        {data && <span className="badge">{data.invitations.length} pending</span>}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {data?.invitations.length === 0 && <Empty title="No emergency requests">Nearby urgent requests appear here only when you opt in and start emergency location sharing.</Empty>}
      <ul className="emergency-invitation-list">
        {data?.invitations.map((invitation) => (
          <li className="emergency-invitation" key={invitation.id}>
            <div className="emergency-invitation-heading">
              <div>
                <span className={`badge urgency-${invitation.request.urgency}`}>{invitation.request.urgency} urgency</span>
                <h3>{invitation.request.title}</h3>
                <p className="muted">{invitation.event.name} · {invitation.event.venue}{invitation.event.venueAddress ? ` · ${invitation.event.venueAddress}` : ''}</p>
              </div>
              <span className="badge badge-pending">Availability requested</span>
            </div>
            <p>{invitation.request.description}</p>
            <dl className="emergency-invitation-facts">
              <div><dt>Starts</dt><dd>{new Date(invitation.request.startAt).toLocaleString()}</dd></div>
              <div><dt>Expected end</dt><dd>{new Date(invitation.request.endAt).toLocaleString()}</dd></div>
              <div><dt>Approx. distance</dt><dd>{formatDistance(invitation.distanceMeters)}</dd></div>
              {invitation.request.specialistSkills.length > 0 && <div><dt>Required qualifications</dt><dd>{invitation.request.specialistSkills.join(', ')}</dd></div>}
            </dl>
            {invitation.request.instructions && <p className="muted">Meeting instructions: {invitation.request.instructions}</p>}
            <div className="emergency-invitation-actions">
              {invitation.event.venueLocation && <a className="btn btn-secondary btn-sm" href={externalNavigationUrl(invitation.event.venueLocation)} target="_blank" rel="noreferrer">Open directions</a>}
              <span className="spacer" />
              <button className="btn btn-ghost btn-sm" disabled={busyId !== null} onClick={() => void respond(invitation, 'decline')}>{busyId === invitation.id ? 'Sending…' : 'Decline'}</button>
              <button className="btn btn-primary btn-sm" disabled={busyId !== null} onClick={() => void respond(invitation, 'accept')}>{busyId === invitation.id ? 'Confirming…' : 'Accept and confirm availability'}</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
