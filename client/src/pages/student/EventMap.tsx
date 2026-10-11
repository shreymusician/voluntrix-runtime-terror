import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage, type StudentEventMap } from '../../api';
import { Alert, Spinner, formatDate, useLoad } from '../../components';
import { LocationMap } from '../../MapCanvas';
import { distanceMetres, externalNavigationUrl, formatDistance, useCurrentPosition } from '../../mapUtils';
import { PageHeader, formatDay } from '../../ui';

export function EventMapPage() {
  const { id = '' } = useParams();
  const [locateMe, setLocateMe] = useState(false);
  const { data, error, loading } = useLoad(() => api<{ event: StudentEventMap }>(`/student/events/${id}/map`), [id]);
  const gps = useCurrentPosition(locateMe);

  if (loading && !data) return <div className="page"><Spinner label="Loading event location…" /></div>;
  if (error && !data) return <div className="page"><Alert kind="error">{error}</Alert><Link to="/student/activities">Back to activities</Link></div>;
  if (!data) return null;

  const event = data.event;
  const destination = event.venueLocation;
  const distance = destination && gps.position ? distanceMetres(gps.position, destination) : null;
  const markers = [
    ...(destination ? [{ id: 'event', ...destination, label: event.venue }] : []),
    ...(gps.position ? [{ id: 'you', latitude: gps.position.latitude, longitude: gps.position.longitude, label: 'Your current location', color: '#2478d0' }] : []),
  ];

  return (
    <div className="page page-wide">
      <Link to="/student/activities" className="back-link">← Back to activities</Link>
      <PageHeader title={event.name} subtitle={`${formatDay(event.startDate)}${event.endDate !== event.startDate ? ` – ${formatDay(event.endDate)}` : ''}`} eyebrow="Find event on map" />
      <section className="card event-map-card">
        <div className="event-map-details">
          <div>
            <span className="event-map-label">Venue</span>
            <strong>{event.venue}</strong>
            {event.venueAddress && <span>{event.venueAddress}</span>}
          </div>
          <div>
            <span className="event-map-label">Location updated</span>
            <span>{event.locationUpdatedAt ? formatDate(event.locationUpdatedAt) : 'Not recorded'}</span>
          </div>
          {distance !== null && (
            <div>
              <span className="event-map-label">Approximate straight-line distance</span>
              <strong>{formatDistance(distance)}</strong>
            </div>
          )}
        </div>

        {!destination ? (
          <Alert kind="info">The organizer has not set map coordinates for this venue yet. You can still use the venue details above.</Alert>
        ) : (
          <LocationMap
            center={destination}
            zoom={gps.position ? 14 : 16}
            markers={markers}
            height={420}
            className="event-map"
            fitMarkers={Boolean(gps.position)}
          />
        )}

        <div className="event-map-actions">
          <div>
            {!locateMe ? (
              <button className="btn btn-secondary" onClick={() => setLocateMe(true)} disabled={!destination}>
                Show my location and distance
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => setLocateMe(false)}>Stop showing my location</button>
            )}
            {locateMe && gps.status !== 'granted' && <span className="muted">{gps.status === 'locating' ? 'Requesting location permission…' : gps.error ?? 'Your location is unavailable.'}</span>}
            {locateMe && gps.position?.accuracyMetres !== null && gps.position?.accuracyMetres !== undefined && (
              <span className="muted">GPS accuracy: about {Math.round(gps.position.accuracyMetres)} m</span>
            )}
          </div>
          {destination && (
            <a className="btn btn-primary" href={externalNavigationUrl(destination)} target="_blank" rel="noreferrer">
              Open directions
            </a>
          )}
        </div>
      </section>
    </div>
  );
}