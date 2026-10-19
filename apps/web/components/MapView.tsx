'use client';
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CATEGORY_LABELS, type IncidentDTOType } from '@crimelens/shared';
import { toneOf, TONE_HEX } from '../lib/tone';
import type { Bbox } from '../lib/api';

const STYLE: maplibregl.StyleSpecification | string = process.env.NEXT_PUBLIC_MAP_STYLE_URL || {
  version: 8,
  sources: { base: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' } },
  layers: [{ id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': 0.8, 'raster-brightness-min': 0.05, 'raster-contrast': 0.25, 'raster-saturation': -0.6 } }],
};
const toneColor: maplibregl.ExpressionSpecification = ['match', ['get', 'tone'],
  'official', TONE_HEX.official, 'news', TONE_HEX.news, 'corroborated', TONE_HEX.corroborated, TONE_HEX.disputed];
const notCluster: maplibregl.ExpressionSpecification = ['!', ['has', 'point_count']];

function toGeoJSON(items: IncidentDTOType[]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: items.filter((i) => i.location).map((i) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [i.location!.lng, i.location!.lat] },
    properties: { id: i.id, tone: toneOf(i), approx: i.location!.precision !== 'street' },
  })) };
}

export default function MapView({ items, selectedId, onSelect, center, onBounds }: {
  items: IncidentDTOType[]; selectedId: string | null; onSelect: (id: string) => void; center: [number, number]; onBounds?: (b: Bbox) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const itemsRef = useRef(items); itemsRef.current = items;
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const onBoundsRef = useRef(onBounds); onBoundsRef.current = onBounds;

  useEffect(() => {
    const map = new maplibregl.Map({ container: box.current!, style: STYLE, center, zoom: 11, maxZoom: 18 });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-right');
    const emit = () => { const b = map.getBounds(); onBoundsRef.current?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => Math.round(n * 1e4) / 1e4) as Bbox); };
    map.on('moveend', emit);
    map.on('load', () => {
      emit();
      map.addSource('incidents', { type: 'geojson', data: toGeoJSON(itemsRef.current), cluster: true, clusterRadius: 45, clusterMaxZoom: 14 });
      map.addLayer({ id: 'clusters', type: 'circle', source: 'incidents', filter: ['has', 'point_count'],
        paint: { 'circle-color': '#3a4350', 'circle-stroke-color': '#e6e8ec', 'circle-stroke-width': 1, 'circle-radius': ['step', ['get', 'point_count'], 12, 10, 16, 50, 22] } });
      map.addLayer({ id: 'halo', type: 'circle', source: 'incidents', filter: ['all', notCluster, ['==', ['get', 'approx'], true]],
        paint: { 'circle-color': toneColor, 'circle-opacity': 0.15, 'circle-radius': 20, 'circle-stroke-color': toneColor, 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.6 } });
      map.addLayer({ id: 'points', type: 'circle', source: 'incidents', filter: notCluster,
        paint: { 'circle-color': toneColor, 'circle-radius': 6, 'circle-stroke-color': '#14171c', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'selected', type: 'circle', source: 'incidents', filter: ['==', ['get', 'id'], ''],
        paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 11, 'circle-stroke-color': '#e6e8ec', 'circle-stroke-width': 2 } });
      ready.current = true;
    });
    map.on('click', 'clusters', async (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
      const zoom = await (map.getSource('incidents') as maplibregl.GeoJSONSource).getClusterExpansionZoom(f.properties!.cluster_id);
      map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
    });
    map.on('click', 'points', (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return;
      onSelectRef.current(item.id);
      const el = document.createElement('div');
      const h = document.createElement('strong'); h.textContent = item.headline;
      const c = document.createElement('div'); c.textContent = CATEGORY_LABELS[item.categoryCode];
      c.style.color = 'var(--text-dim)'; el.append(h, c);
      new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: '260px' }).setLngLat([item.location!.lng, item.location!.lat]).setDOMContent(el).addTo(map);
    });
    for (const layer of ['clusters', 'points']) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }
    const ro = new ResizeObserver(() => map.resize()); ro.observe(box.current!);   // keeps the map correct when the side panel collapses
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; ready.current = false; };
  }, [center]);

  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const apply = () => (map.getSource('incidents') as maplibregl.GeoJSONSource | undefined)?.setData(toGeoJSON(items));
    if (ready.current) apply(); else map.once('load', apply);
  }, [items]);

  useEffect(() => {
    const map = mapRef.current; if (!map || !ready.current) return;
    map.setFilter('selected', ['==', ['get', 'id'], selectedId ?? '']);
    const loc = items.find((i) => i.id === selectedId)?.location;
    if (loc) map.easeTo({ center: [loc.lng, loc.lat], zoom: Math.max(map.getZoom(), 13) });
  }, [selectedId, items]);

  return <div ref={box} className="h-full w-full" aria-label="Incident map" />;
}
