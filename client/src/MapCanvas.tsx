import { lazy, Suspense, type ComponentProps } from 'react';

const LeafletMap = lazy(() => import('./map').then((module) => ({ default: module.LocationMap })));

type Props = ComponentProps<typeof LeafletMap>;

export function LocationMap(props: Props) {
  return (
    <Suspense fallback={<div className={`location-map location-map-loading ${props.className ?? ''}`} style={{ height: props.height ?? 320 }} role="status">Loading map…</div>}>
      <LeafletMap {...props} />
    </Suspense>
  );
}
