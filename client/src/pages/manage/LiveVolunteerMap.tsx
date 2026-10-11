import { useEffect, useState } from 'react';
import { api, errorMessage, type EventMapInfo } from '../../api';
import { Alert, Empty, Spinner } from '../../components';
import { LocationMap } from '../../MapCanvas';
import type { MapMarker } from '../../mapUtils';

interface LiveLocation {
  volunteerId: string;
  displayName: string;
  position: string;
  positionLocation: string;
  assignmentStatus: 'confirmed';
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  updatedAt: string;
  expiresAt: string;
}

export function LiveVolunteerMap({ event }: { event: EventMapInfo }) {
  const [locations, setLocations] = useState<LiveLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await api<{ locations: LiveLocation[] }>(`/manage/events/${event.id}/live-locations`);
        if (!active) return;
        setLocations(data.locations);
        setError(null);
      } catch (err) {
        if (!active) return;
        setLocations([]);
        setError(errorMessage(err));
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [event.id]);

  const center = event.venueLocation ?? (locations[0] ? { latitude: locations[0].latitude, longitude: locations[0].longitude } : null);
  const markers: MapMarker[] = locations.map((location) => ({
    id: location.volunteerId,
    latitude: location.latitude,
    longitude: location.longitude,
    label: location.displayName,
    color: '#69d8c2',
  }));

  return (
    <section className="card live-volunteer-map">
      <div className="card-head">
        <div>
          <h2>Live volunteer map</h2>
          <p className="muted">Only confirmed volunteers actively sharing for this event are shown. Stale locations are removed automatically.</p>
        </div>
        <span className="live-note"><span className="live-dot" />Refreshes every 15 seconds</span>
      </div>
      {loading && <Spinner label="Checking for active location shares…" />}
      {error && <Alert kind="error">{error}</Alert>}
      {!loading && !error && locations.length === 0 && (
        <Empty title="No fresh shared locations">Volunteers appear here only after they explicitly start sharing for this event.</Empty>
      )}
      {center && locations.length > 0 && <LocationMap center={center} markers={markers} height={360} fitMarkers />}
      {locations.length > 0 && (
        <ul className="live-volunteer-list">
          {locations.map((location) => (
            <li key={location.volunteerId}>
              <div>
                <strong>{location.displayName}</strong>
                <span className="muted">{location.position} · {location.positionLocation}</span>
              </div>
              <div className="live-volunteer-meta">
                <span className="badge badge-confirmed">Confirmed</span>
                <span className="muted">GPS ±{Math.round(location.accuracyMeters ?? 0)} m</span>
                <time dateTime={location.updatedAt}>Updated {new Date(location.updatedAt).toLocaleTimeString()}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
