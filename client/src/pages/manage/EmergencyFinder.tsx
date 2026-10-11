import { useEffect, useState } from 'react';
import { api, errorMessage, type EventDetail, type ManagedActivity } from '../../api';
import { Alert, Empty, Spinner, useLoad } from '../../components';
import { LocationMap } from '../../MapCanvas';
import type { MapMarker } from '../../mapUtils';
import { formatDistance } from '../../mapUtils';
import { useFeedback } from '../../ui';

type EmergencyRequestSummary = {
  id: string;
  activityId: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  requiredCount: number;
  radiusMeters: number;
  urgency: 'normal' | 'high' | 'critical';
  specialistSkills: string[];
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  pendingCount: number;
  acceptedCount: number;
};

type NearbyCandidate = {
  studentId: string;
  displayName: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  accuracyMeters: number | null;
  locationUpdatedAt: string;
  availabilityStatus: 'AWAITING_CONFIRMATION';
};

type EmergencyInvitationStatus = {
  id: string;
  displayName: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  distanceMeters: number;
  notifiedAt: string;
  respondedAt: string | null;
};

export function EmergencyFinder({ event }: { event: EventDetail }) {
  const { notify, confirm } = useFeedback();
  const [activityId, setActivityId] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [requiredCount, setRequiredCount] = useState('1');
  const [radiusKm, setRadiusKm] = useState('3');
  const [urgency, setUrgency] = useState<'normal' | 'high' | 'critical'>('high');
  const [specialist, setSpecialist] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<NearbyCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [invitations, setInvitations] = useState<EmergencyInvitationStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, loading, reload } = useLoad(() => api<{ requests: EmergencyRequestSummary[] }>(`/manage/events/${event.id}/emergency-requests`), [event.id]);

  const emergencyActivityIds = new Set(data?.requests.map((request) => request.activityId) ?? []);
  const availableActivities = event.activities.filter((activity) => activity.status !== 'cancelled' && !emergencyActivityIds.has(activity.id));
  const selectedActivity = availableActivities.find((activity) => activity.id === activityId) ?? availableActivities[0];
  const selectedRequest = data?.requests.find((request) => request.id === selectedRequestId) ?? null;
  const markers: MapMarker[] = candidates.map((candidate) => ({
    id: candidate.studentId,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    label: candidate.displayName,
    color: '#e8ad67',
  }));
  if (event.venueLocation) markers.unshift({ id: 'emergency-venue', ...event.venueLocation, label: `${event.venue} · request location` });

  useEffect(() => {
    if (!availableActivities.length) return;
    if (!activityId || !availableActivities.some((activity) => activity.id === activityId)) setActivityId(availableActivities[0].id);
  }, [event.id, availableActivities, activityId]);

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!selectedRequestId) return;
    let active = true;
    const refreshResponses = async () => {
      try {
        const result = await api<{ invitations: EmergencyInvitationStatus[] }>(`/manage/emergency-requests/${selectedRequestId}/invitations`);
        if (active) setInvitations(result.invitations);
      } catch {
        if (active) setInvitations([]);
      }
    };
    void refreshResponses();
    const timer = window.setInterval(() => void refreshResponses(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedRequestId]);

  const createRequest = async () => {
    if (!selectedActivity) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api<{ request: EmergencyRequestSummary }>(`/manage/events/${event.id}/emergency-requests`, {
        method: 'POST',
        body: {
          activityId: selectedActivity.id,
          description,
          instructions,
          requiredCount: Number(requiredCount),
          radiusKm: Number(radiusKm),
          urgency,
          specialistSkills: specialist ? selectedActivity.requiredSkills : [],
        },
      });
      notify('success', 'Emergency request created. Nearby candidate availability is not assumed.');
      setSelectedRequestId(result.request.id);
      setCandidates([]);
      setSelectedIds([]);
      await reload();
      await loadCandidates(result.request.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const loadCandidates = async (requestId: string) => {
    setSelectedRequestId(requestId);
    setLoadingCandidates(true);
    setError(null);
    try {
      const [candidateData, invitationData] = await Promise.all([
        api<{ candidates: NearbyCandidate[] }>(`/manage/emergency-requests/${requestId}/candidates`),
        api<{ invitations: EmergencyInvitationStatus[] }>(`/manage/emergency-requests/${requestId}/invitations`),
      ]);
      setCandidates(candidateData.candidates);
      setInvitations(invitationData.invitations);
      setSelectedIds([]);
    } catch (err) {
      setCandidates([]);
      setInvitations([]);
      setError(errorMessage(err));
    } finally {
      setLoadingCandidates(false);
    }
  };

  const sendSelected = async () => {
    if (!selectedRequestId || !selectedIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ sent: number }>(`/manage/emergency-requests/${selectedRequestId}/invitations`, { method: 'POST', body: { studentIds: selectedIds } });
      notify('success', `${result.sent} emergency request${result.sent === 1 ? '' : 's'} sent. Students must confirm availability.`);
      await loadCandidates(selectedRequestId);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const expandRadius = async () => {
    if (!selectedRequest || !selectedRequestId) return;
    const nextRadius = Math.min(50, Math.max(selectedRequest.radiusMeters / 1000 + 1, selectedRequest.radiusMeters / 1000 * 1.5));
    setBusy(true);
    try {
      await api(`/manage/emergency-requests/${selectedRequestId}/radius`, { method: 'PATCH', body: { radiusKm: nextRadius } });
      notify('success', `Search radius expanded to ${nextRadius} km.`);
      await loadCandidates(selectedRequestId);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelRequest = async (requestId: string) => {
    const answer = await confirm({
      title: 'Cancel this emergency request?',
      message: 'Pending invitations will be cancelled and notified. Volunteers assigned through this request will be released.',
      confirmLabel: 'Cancel request',
      danger: true,
    });
    if (!answer.ok) return;
    setBusy(true);
    try {
      const result = await api<{ affected: number }>(`/manage/emergency-requests/${requestId}`, { method: 'DELETE' });
      notify('success', `Emergency request cancelled. ${result.affected} invitation(s) were closed and notified.`);
      setSelectedRequestId(null);
      setCandidates([]);
      setInvitations([]);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card emergency-finder">
      <div className="card-head">
        <div>
          <h2>Emergency volunteer finder</h2>
          <p className="muted">A separate opt-in workflow for urgent staffing. It does not change normal eligibility or allocation.</p>
        </div>
      </div>

      {!event.venueLocation && <Alert kind="warn">Set this event’s map location before starting nearby discovery.</Alert>}
      {event.status !== 'published' && <Alert kind="info">Publish this event before inviting nearby volunteers. Draft events aren’t discoverable by students.</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      <div className="emergency-create-form">
        <h3>Start an urgent request</h3>
        {availableActivities.length === 0 ? (
          <Empty title="Add an event position first">Emergency discovery uses an existing event position and its scheduled time.</Empty>
        ) : (
          <>
            <div className="field-row emergency-form-grid">
              <div className="field">
                <label htmlFor="emergency-position">Position and schedule</label>
                <select id="emergency-position" value={selectedActivity?.id ?? ''} onChange={(e) => setActivityId(e.target.value)}>
                  {availableActivities.map((activity) => <option key={activity.id} value={activity.id}>{activity.name} · {activity.date} · {activity.startTime}–{activity.endTime}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="emergency-count">Volunteers needed</label>
                <input id="emergency-count" type="number" min={1} max={100} value={requiredCount} onChange={(e) => setRequiredCount(e.target.value)} />
              </div>
            </div>
            <div className="field-row emergency-form-grid">
              <div className="field">
                <label htmlFor="emergency-radius">Search radius</label>
                <select id="emergency-radius" value={radiusKm} onChange={(e) => setRadiusKm(e.target.value)}>
                  <option value="1">1 km</option><option value="3">3 km</option><option value="5">5 km</option><option value="10">10 km</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="emergency-urgency">Urgency</label>
                <select id="emergency-urgency" value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
                  <option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="emergency-description">Task description</label>
              <textarea id="emergency-description" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the urgent task and what help is needed." />
            </div>
            <div className="field">
              <label htmlFor="emergency-instructions">Meeting instructions</label>
              <textarea id="emergency-instructions" rows={2} maxLength={1000} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Where should volunteers meet?" />
            </div>
            <label className="check emergency-specialist-check">
              <input type="checkbox" checked={specialist} onChange={(e) => setSpecialist(e.target.checked)} />
              <span><strong>Require this position’s listed skills</strong><small className="muted">Only select this for specialist work. General support does not apply normal skill or preference matching.</small></span>
            </label>
            {specialist && <p className="muted">Required skills: {selectedActivity?.requiredSkills.join(', ') || 'No skills are listed on this position.'}</p>}
              <button className="btn btn-primary" onClick={() => void createRequest()} disabled={creating || !description.trim() || !event.venueLocation || event.status !== 'published' || (specialist && !selectedActivity?.requiredSkills.length)}>
              {creating ? 'Creating request…' : 'Confirm and find nearby volunteers'}
            </button>
            <p className="field-hint">Search uses the event’s saved venue coordinates. Applicants are not required; only opted-in volunteers with fresh locations are considered.</p>
          </>
        )}
      </div>

      <div className="emergency-request-section">
        <div className="card-head"><h3>Requests for this event</h3></div>
        {loading && !data && <Spinner />}
        {data?.requests.length === 0 && <Empty title="No emergency requests">Requests you create will be tracked here.</Empty>}
        <ul className="emergency-request-list">
          {data?.requests.map((request) => (
            <li key={request.id} className={`emergency-request-row${request.id === selectedRequestId ? ' emergency-request-active' : ''}`}>
              <div className="emergency-request-summary">
                <strong>{request.title}</strong>
                <span className="muted">{request.requiredCount} needed · {request.acceptedCount} accepted · {request.pendingCount} pending · within {(request.radiusMeters / 1000).toFixed(1)} km</span>
                <span className="muted">{new Date(request.startAt).toLocaleString()} · {request.urgency} urgency</span>
              </div>
              <div className="row-actions">
                <span className={`badge badge-${request.status === 'open' ? 'pending' : request.status === 'filled' ? 'confirmed' : 'cancelled'}`}>{request.status}</span>
                {request.status === 'open' && <button className="btn btn-secondary btn-sm" onClick={() => void loadCandidates(request.id)}>Find candidates</button>}
                {request.status === 'open' && <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void cancelRequest(request.id)}>Cancel request</button>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {selectedRequest && selectedRequest.status === 'open' && (
        <div className="emergency-candidate-workspace">
          <div className="card-head">
            <div><h3>Nearby volunteers</h3><p className="muted">Location is approximate. Every selected volunteer must confirm availability after receiving a request.</p></div>
            <button className="btn btn-secondary btn-sm" disabled={busy || selectedRequest.radiusMeters >= 50_000} onClick={() => void expandRadius()}>Expand radius</button>
          </div>
          {loadingCandidates && <Spinner label="Searching opted-in volunteers…" />}
          {!loadingCandidates && candidates.length === 0 && (
            <Empty title="No eligible nearby candidates">No opted-in volunteers with fresh location and no known schedule conflict were found in this radius. Expand the radius and search again.</Empty>
          )}
          {candidates.length > 0 && event.venueLocation && (
            <LocationMap center={event.venueLocation} markers={[{ id: 'venue', ...event.venueLocation, label: event.venue }, ...markers.filter((marker) => marker.id !== 'emergency-venue')]} height={330} fitMarkers />
          )}
          {candidates.length > 0 && (
            <>
              <ul className="emergency-candidate-list">
                {candidates.map((candidate) => (
                  <li key={candidate.studentId}>
                    <label className="check">
                      <input type="checkbox" checked={selectedIds.includes(candidate.studentId)} onChange={(e) => setSelectedIds((ids) => e.target.checked ? [...ids, candidate.studentId] : ids.filter((id) => id !== candidate.studentId))} />
                      <span><strong>{candidate.displayName}</strong><small className="muted">{formatDistance(candidate.distanceMeters)} approximate · GPS ±{Math.round(candidate.accuracyMeters ?? 0)} m · updated {new Date(candidate.locationUpdatedAt).toLocaleTimeString()}</small></span>
                    </label>
                    <span className="badge badge-pending">Availability unconfirmed</span>
                  </li>
                ))}
              </ul>
              <button className="btn btn-primary" disabled={busy || selectedIds.length === 0} onClick={() => void sendSelected()}>
                {busy ? 'Sending…' : `Send request to ${selectedIds.length} selected`}
              </button>
            </>
          )}
          {invitations.length > 0 && (
            <div className="emergency-response-list">
              <h4>Request responses</h4>
              <ul className="plain-list">
                {invitations.map((invitation) => <li key={invitation.id}><strong>{invitation.displayName}</strong> · {formatDistance(invitation.distanceMeters)} · <span className={`badge badge-${invitation.status === 'accepted' ? 'confirmed' : invitation.status === 'pending' ? 'pending' : 'cancelled'}`}>{invitation.status}</span>{invitation.respondedAt && <span className="muted"> · responded {new Date(invitation.respondedAt).toLocaleTimeString()}</span>}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
