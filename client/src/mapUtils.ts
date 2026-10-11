import { useEffect, useState } from 'react';

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface MapMarker extends LatLng {
  id: string;
  label: string;
  color?: string;
  popupHtml?: string;
}

export function distanceMetres(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export function externalNavigationUrl(dest: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${dest.latitude},${dest.longitude}`;
}

export type GeoStatus = 'idle' | 'locating' | 'granted' | 'denied' | 'unavailable' | 'stale';

export function useCurrentPosition(enabled: boolean) {
  const [status, setStatus] = useState<GeoStatus>('idle');
  const [position, setPosition] = useState<(LatLng & { accuracyMetres: number | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!('geolocation' in navigator)) {
      setStatus('unavailable');
      setError('This browser cannot report your location.');
      return;
    }
    setStatus('locating');
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus('granted');
        setPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyMetres: pos.coords.accuracy ?? null });
        setError(null);
      },
      (err) => {
        setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
        setError(err.message || 'Could not get your location.');
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return { status, position, error };
}
