import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { LatLng, MapMarker } from './mapUtils';

// Leaflet's default marker images are bundled asset paths that Vite does not
// resolve automatically; point them at the package's own files explicitly.
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

function dotIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

/**
 * A plain Leaflet map (no react-leaflet) over OpenStreetMap tiles — the only
 * provider this project uses, so no API key is ever required. Imperative by
 * design: markers are diffed by id on every render rather than re-mounting
 * the map, which is what keeps panning/zooming stable while live data polls.
 */
export function LocationMap({
  center,
  zoom = 16,
  markers,
  onPick,
  height = 320,
  className = '',
  fitMarkers = false,
}: {
  center: LatLng;
  zoom?: number;
  markers: MapMarker[];
  /** If set, clicking the map reports a point — used by the organizer's venue picker. */
  onPick?: (point: LatLng) => void;
  height?: number;
  className?: string;
  fitMarkers?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { attributionControl: true }).setView([center.latitude, center.longitude], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => onPickRef.current?.({ latitude: e.latlng.lat, longitude: e.latlng.lng }));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Mount once; center/zoom changes afterwards are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setView([center.latitude, center.longitude], mapRef.current.getZoom());
  }, [center.latitude, center.longitude]);

  useEffect(() => {
    const layer = markerLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const m of markers) {
      const marker = L.marker([m.latitude, m.longitude], m.color ? { icon: dotIcon(m.color) } : undefined);
      marker.bindTooltip(m.label, { permanent: false, direction: 'top' });
      if (m.popupHtml) marker.bindPopup(m.popupHtml);
      marker.addTo(layer);
    }
    if (fitMarkers && markers.length > 1) {
      mapRef.current?.fitBounds(markers.map((marker) => [marker.latitude, marker.longitude]), { padding: [28, 28], maxZoom: 16 });
    }
  }, [fitMarkers, markers]);

  return <div ref={containerRef} className={`location-map ${className}`} style={{ height }} />;
}

export type { LatLng, MapMarker } from './mapUtils';
