import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, type AssignmentBase } from '../../api';
import { Alert } from '../../components';

interface SharingSession {
  sessionId: string;
  eventId: string | null;
  scope: 'event' | 'emergency';
  updatedAt?: string;
  expiresAt: string;
}

export function LocationSharing({ assignments }: { assignments: AssignmentBase[] }) {
  const [session, setSession] = useState<SharingSession | null>(null);
  const [emergencyOptIn, setEmergencyOptIn] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [scope, setScope] = useState<'event' | 'emergency'>('event');
  const [tracking, setTracking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFixAt, setLastFixAt] = useState<string | null>(null);
  const sendPending = useRef(false);

  const events = [...new Map(
    assignments
      .filter((assignment) => assignment.status === 'confirmed' && !assignment.ended)
      .map((assignment) => [assignment.event.id, { id: assignment.event.id, name: assignment.event.name }]),
  ).values()];

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<{ session: SharingSession | null }>('/student/location-sharing'),
      api<{ emergencyDiscoveryEnabled: boolean }>('/student/location-preferences'),
    ]).then(([sharing, preferences]) => {
      if (!active) return;
      setSession(sharing.session);
      setEmergencyOptIn(preferences.emergencyDiscoveryEnabled);
      if (sharing.session?.eventId) setSelectedEventId(sharing.session.eventId);
    }).catch((err) => {
      if (active) setError(errorMessage(err));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!tracking || !session) return;
    if (!navigator.geolocation) {
      setError('This browser does not provide GPS location. Sharing has not received an update.');
      setTracking(false);
      return;
    }

    let active = true;
    const requestFix = () => {
      if (sendPending.current || !active) return;
      sendPending.current = true;
      navigator.geolocation.getCurrentPosition(async (position) => {
        if (!active) {
          sendPending.current = false;
          return;
        }
        try {
          await api(`/student/location-sharing/${session.sessionId}`, {
            method: 'PATCH',
            body: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracyMeters: position.coords.accuracy,
              capturedAt: Math.round(position.timestamp),
            },
          });
          setLastFixAt(new Date(position.timestamp).toISOString());
          setError(null);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            setSession(null);
            setTracking(false);
            setError('The location-sharing session expired. Start sharing again if you still want to be visible.');
          } else {
            setError(errorMessage(err));
          }
        } finally {
          sendPending.current = false;
        }
      }, (geoError) => {
        if (active) {
          setError(geoError.code === geoError.PERMISSION_DENIED
            ? 'Location permission was denied. Stop sharing or allow location access in your browser.'
            : geoError.message || 'GPS is unavailable. The last location will expire automatically.');
        }
        sendPending.current = false;
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
    };

    requestFix();
    const timer = window.setInterval(requestFix, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [tracking, session]);

  const saveEmergencyPreference = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api('/student/location-preferences', { method: 'PUT', body: { emergencyDiscoveryEnabled: enabled } });
      setEmergencyOptIn(enabled);
      if (!enabled && session?.scope === 'emergency') {
        setSession(null);
        setTracking(false);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startSharing = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body = scope === 'event' ? { eventId: selectedEventId } : {};
      const result = await api<{ session: SharingSession }>('/student/location-sharing/start', { method: 'POST', body });
      setSession(result.session);
      setTracking(true);
      setMessage('Sharing started. Your location is visible only to authorized organizers for the selected event or opted-in emergency requests.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const stopSharing = async () => {
    if (!session) return;
    setBusy(true);
    setTracking(false);
    setError(null);
    try {
      await api(`/student/location-sharing/${session.sessionId}`, { method: 'DELETE' });
      setSession(null);
      setLastFixAt(null);
      setMessage('Location sharing stopped and the current location was removed.');
    } catch (err) {
      setError(`${errorMessage(err)} The session will expire automatically if it cannot be stopped now.`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  return (
    <section className="card location-sharing-card">
      <div className="card-head">
        <div>
          <h2>Location sharing</h2>
          <p className="muted">Optional and temporary. Your location is never shared in the background after this session expires.</p>
        </div>
        {session && <span className={`badge ${tracking ? 'badge-confirmed' : 'badge-pending'}`}>{tracking ? 'Sharing active' : 'Paused on this device'}</span>}
      </div>

      <label className="check location-opt-in">
        <input type="checkbox" checked={emergencyOptIn} disabled={busy} onChange={(event) => void saveEmergencyPreference(event.target.checked)} />
        <span><strong>Allow emergency opportunity requests</strong><small className="muted">Off by default. Organizers can discover you for nearby urgent requests only while you also have an active emergency-scoped location session.</small></span>
      </label>

      {session ? (
        <div className="location-session-state">
          <p className="muted">
            Scope: {session.scope === 'event' ? events.find((event) => event.id === session.eventId)?.name ?? 'Assigned event' : 'Emergency requests'}.
            {' '}This browser must remain open; background GPS is not guaranteed.
          </p>
          {lastFixAt && <p className="muted">Last GPS fix: {new Date(lastFixAt).toLocaleTimeString()}.</p>}
          <div className="row-actions">
            {!tracking && <button className="btn btn-secondary" onClick={() => { setError(null); setTracking(true); }}>Resume updates</button>}
            <button className="btn btn-danger" onClick={() => void stopSharing()} disabled={busy}>{busy ? 'Stopping…' : 'Stop sharing now'}</button>
          </div>
        </div>
      ) : (
        <div className="location-start-controls">
          <div className="field">
            <label htmlFor="location-scope">Sharing scope</label>
            <select id="location-scope" value={scope} onChange={(event) => setScope(event.target.value as 'event' | 'emergency')}>
              <option value="event">My assigned event</option>
              <option value="emergency" disabled={!emergencyOptIn}>Nearby emergency requests</option>
            </select>
          </div>
          {scope === 'event' && (
            <div className="field">
              <label htmlFor="location-event">Confirmed event</label>
              <select id="location-event" value={selectedEventId} onChange={(event) => setSelectedEventId(event.target.value)}>
                <option value="">Choose an event</option>
                {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
              </select>
            </div>
          )}
          {scope === 'emergency' && <p className="muted">Your location is visible only to authorized organizers handling emergency requests. Availability is always confirmed separately.</p>}
          <button className="btn btn-primary" onClick={() => void startSharing()} disabled={busy || (scope === 'event' && !selectedEventId) || (scope === 'emergency' && !emergencyOptIn)}>
            {busy ? 'Starting…' : 'Start location sharing'}
          </button>
        </div>
      )}

      {message && <Alert kind="success">{message}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
    </section>
  );
}
