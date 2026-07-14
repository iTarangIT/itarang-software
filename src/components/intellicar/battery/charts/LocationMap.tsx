'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, Home, Moon, PlugZap, Route, Clock, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import 'leaflet/dist/leaflet.css';
import type { BatteryGeoData, DwellCluster } from '../types';

type Mode = 'distance' | 'dwell';

/**
 * The four numbered places, in the order the pins are numbered. Every role a cell plays
 * is rendered on ONE pin ("1·2"), never as stacked pins — for an e-rickshaw, home,
 * parking and charging are very often the same 100 m cell.
 */
interface PlaceRole {
    n: number;
    title: string;
    color: string;
    cluster: DwellCluster;
    evidence: string;
}

function placeRoles(data: BatteryGeoData): PlaceRole[] {
    const roles: PlaceRole[] = [];
    if (data.home) {
        roles.push({
            n: 1,
            title: 'Home',
            color: '#4a3aa7',
            cluster: data.home,
            evidence: `${data.home.nightHours.toFixed(1)} h overnight across ${data.home.nights} nights`,
        });
    }
    if (data.parking) {
        roles.push({
            n: 2,
            title: 'Parking',
            color: '#d03b3b',
            cluster: data.parking,
            evidence: `${data.parking.hours.toFixed(1)} h stationary · ${data.parking.visits} visits`,
        });
    }
    if (data.charging) {
        roles.push({
            n: 3,
            title: 'Charging',
            color: '#1baf7a',
            cluster: data.charging,
            evidence: `${data.charging.chargeHours.toFixed(1)} h charging across ${data.charging.chargeSessions} sessions`,
        });
    }
    if (data.overnightSecondary) {
        roles.push({
            n: 4,
            title: 'Overnight (secondary)',
            color: '#d97706',
            cluster: data.overnightSecondary,
            evidence: `${data.overnightSecondary.nightHours.toFixed(1)} h across ${data.overnightSecondary.nights} nights`,
        });
    }
    return roles;
}

const cellKey = (c: { lat: number; lon: number }) => `${c.lat},${c.lon}`;

/**
 * Where the battery drives, and where it sits.
 *
 * Plain Leaflet, driven from an effect — not react-leaflet. The map is an imperative object with
 * its own lifecycle, and wrapping it in a component tree buys nothing here while adding a
 * dependency that has to track React's major versions. Markers are `circleMarker`/`divIcon`
 * rather than Leaflet's default pin, which sidesteps the broken-icon-path problem bundlers
 * famously have with leaflet's image assets.
 *
 * ## The two heat maps are different questions
 *
 * **Kilometre heat** is weighted by *distance travelled* through each cell, not by the number of
 * GPS fixes in it. A fix-density map lights up brightest wherever the vehicle sat longest —
 * which is exactly where it travelled least — and a reader takes that bright blob for "the busy
 * route" when it means "the car park". Weighting by distance makes the roads glow and the car
 * park go dark, which is what a *kilometre* heat map is supposed to say.
 *
 * **Dwell heat** is the opposite question — where it spends its time — and gets its own layer.
 */
export function LocationMap({ data }: { data: BatteryGeoData | undefined }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<import('leaflet').Map | null>(null);
    const heatRef = useRef<{ remove: () => void } | null>(null);
    const markersRef = useRef<Array<{ remove: () => void }>>([]);
    const [mode, setMode] = useState<Mode>('distance');
    const [ready, setReady] = useState(false);

    // Leaflet touches `window` at import time, so it can only be loaded in the browser.
    useEffect(() => {
        let cancelled = false;

        (async () => {
            const L = (await import('leaflet')).default;
            await import('leaflet.heat');
            if (cancelled || !containerRef.current || mapRef.current) return;

            const map = L.map(containerRef.current, {
                scrollWheelZoom: false, // a map inside a scrolling page must not hijack the wheel
                attributionControl: true,
            });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors',
            }).addTo(map);

            // Click-to-enable wheel zoom: the guard above is right for scrolling past the map,
            // but wrong once the reader is actually using it.
            map.on('click', () => map.scrollWheelZoom.enable());
            map.on('mouseout', () => map.scrollWheelZoom.disable());

            mapRef.current = map;
            setReady(true);
        })();

        return () => {
            cancelled = true;
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, []);

    // Redraw whenever the data or the selected layer changes.
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map || !data) return;

        let cancelled = false;

        (async () => {
            const L = (await import('leaflet')).default;
            if (cancelled || !mapRef.current) return;

            heatRef.current?.remove();
            heatRef.current = null;
            markersRef.current.forEach((m) => m.remove());
            markersRef.current = [];

            // leaflet.heat's `max` is the weight at which a cell saturates. Feeding raw km with a
            // fixed max would leave a quiet battery's map entirely blue and a busy one entirely
            // red, so intensity is normalised against this battery's own busiest cell — the map
            // answers "where does THIS battery go", not "how does it rank against the fleet".
            const points: Array<[number, number, number]> =
                mode === 'distance'
                    ? data.heat.map((h) => [h.lat, h.lon, h.km])
                    : data.dwell.map((d) => [d.lat, d.lon, d.hours]);

            if (points.length > 0) {
                const peak = Math.max(...points.map((p) => p[2]));
                const norm = points.map(
                    ([lat, lon, w]) => [lat, lon, peak > 0 ? w / peak : 0] as [number, number, number],
                );
                heatRef.current = L.heatLayer(norm, {
                    radius: mode === 'distance' ? 14 : 26,
                    blur: mode === 'distance' ? 18 : 30,
                    max: 1,
                    minOpacity: 0.25,
                    gradient:
                        mode === 'distance'
                            ? { 0.2: '#2a78d6', 0.5: '#1baf7a', 0.75: '#eda100', 1.0: '#d03b3b' }
                            : { 0.2: '#4a3aa7', 0.5: '#7c3aed', 0.8: '#eb6834', 1.0: '#d03b3b' },
                }).addTo(map);
            }

            // One pin per CELL, carrying every role that lands there ("1·2"), never two
            // stacked pins fighting for the same 100 m square.
            const roles = placeRoles(data);
            const byCell = new Map<string, PlaceRole[]>();
            for (const r of roles) {
                const key = cellKey(r.cluster);
                byCell.set(key, [...(byCell.get(key) ?? []), r]);
            }

            // Other dwell spots first, so the numbered pins sit on top of them.
            for (const d of data.dwell.slice(0, 12)) {
                if (byCell.has(cellKey(d))) continue;
                const c = L.circleMarker([d.lat, d.lon], {
                    radius: 5,
                    color: '#fff',
                    weight: 1.5,
                    fillColor: '#52514e',
                    fillOpacity: 0.85,
                })
                    .addTo(map)
                    .bindPopup(
                        `<strong>Dwell spot</strong><br/>${d.hours.toFixed(1)} h · ${d.visits} visits`,
                    );
                markersRef.current.push(c);
            }

            for (const group of byCell.values()) {
                const first = group[0];
                const label = group.map((g) => g.n).join('·');
                const w = 22 + label.length * 5; // "1·2·3" needs a wider teardrop than "1"
                const icon = L.divIcon({
                    className: '',
                    html: `<div style="
                        background:${first.color};color:#fff;font:600 11px/1 system-ui;
                        width:${w}px;height:26px;border-radius:50% 50% 50% 0;
                        transform:rotate(-45deg);display:flex;align-items:center;
                        justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.4);
                        border:2px solid #fff;
                      "><span style="transform:rotate(45deg)">${label}</span></div>`,
                    iconSize: [w, 26],
                    iconAnchor: [Math.round(w / 2), 26],
                });
                const title = group.map((g) => g.title).join(' + ');
                const m = L.marker([first.cluster.lat, first.cluster.lon], { icon, title })
                    .addTo(map)
                    .bindPopup(
                        group
                            .map((g) => `<strong>${g.n} · ${g.title}</strong><br/>${g.evidence}`)
                            .join('<br/>') +
                            `<br/><span style="color:#64748b">${first.cluster.lat.toFixed(5)}, ${first.cluster.lon.toFixed(5)}</span>`,
                    );
                markersRef.current.push(m);
            }

            if (data.bbox) {
                map.fitBounds(
                    [
                        [data.bbox.minLat, data.bbox.minLon],
                        [data.bbox.maxLat, data.bbox.maxLon],
                    ],
                    { padding: [28, 28] },
                );
            }
            // A map created inside a hidden tab measures itself as 0×0. Nudge it once it is up.
            setTimeout(() => mapRef.current?.invalidateSize(), 0);
        })();

        return () => {
            cancelled = true;
        };
    }, [ready, data, mode]);

    const s = data?.summary;
    const samePlace =
        data?.parking && data?.home &&
        data.parking.lat === data.home.lat &&
        data.parking.lon === data.home.lon;

    // Every dwell spot with real overnight presence. The "home" pin picks the top one, but the
    // evidence is often close — showing the runner-up stops a ranked guess from reading as a fact.
    const overnight = (data?.dwell ?? []).filter((d) => d.nights >= 3).slice(0, 3);

    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-4 p-6 pb-3">
                <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900">
                        {mode === 'distance' ? 'Kilometre Heat Map' : 'Time-Spent Heat Map'}
                    </h3>
                    <p className="text-xs text-gray-500 mt-1 max-w-xl">
                        {mode === 'distance'
                            ? 'Where this battery travels, weighted by distance covered — so the roads glow, not the car park.'
                            : 'Where this battery sits still, weighted by hours spent. The inverse of the route map.'}
                    </p>
                </div>
                <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg shrink-0">
                    {(
                        [
                            ['distance', 'Kilometres', Route],
                            ['dwell', 'Time spent', Clock],
                        ] as const
                    ).map(([m, label, Icon]) => (
                        <button
                            key={m}
                            type="button"
                            onClick={() => setMode(m)}
                            className={cn(
                                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                                mode === m ? 'bg-white text-brand-700 shadow-sm' : 'text-gray-500 hover:text-gray-700',
                            )}
                        >
                            <Icon className="w-3.5 h-3.5" />
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="px-2">
                <div
                    ref={containerRef}
                    className="w-full rounded-xl overflow-hidden border border-gray-100"
                    style={{ height: 460, background: '#f8fafc' }}
                />
            </div>

            {(data?.heat.length ?? 0) === 0 && ready && (
                <p className="px-6 pt-3 text-sm text-gray-400">No GPS fixes for this battery in this period.</p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6 pt-4">
                <PlaceCard
                    icon={Home}
                    tone="violet"
                    title={samePlace ? '1 · Home (same cell as parking)' : '1 · Home'}
                    cluster={data?.home ?? null}
                    detail={(c) =>
                        `${c.nightHours.toFixed(0)} hours between ${data?.gates.nightStartHour}:00 and ${data?.gates.nightEndHour}:00, across ${c.nights} nights${c.lastNight ? ` — last on ${c.lastNight}` : ''}.`
                    }
                    emptyText="No overnight pattern in this period."
                />
                <PlaceCard
                    icon={MapPin}
                    tone="critical"
                    title="2 · Parking"
                    cluster={data?.parking ?? null}
                    detail={(c) =>
                        `${c.hours.toFixed(0)} hours stationary across ${c.visits} separate visits — more than anywhere else.`
                    }
                    emptyText="Not enough stationary time to identify one."
                />
                <PlaceCard
                    icon={PlugZap}
                    tone="green"
                    title="3 · Charging"
                    cluster={data?.charging ?? null}
                    detail={() =>
                        data?.charging
                            ? `${data.charging.chargeHours.toFixed(0)} hours stationary inside charge cycles, across ${data.charging.chargeSessions} separate sessions.`
                            : ''
                    }
                    emptyText={`No repeated charging spot — needs at least ${data?.gates.chargingSpotMinSessions ?? 2} charge sessions at one place.`}
                />
                <PlaceCard
                    icon={Moon}
                    tone="amber"
                    title="4 · Overnight (secondary)"
                    cluster={data?.overnightSecondary ?? null}
                    detail={(c) =>
                        `${c.nightHours.toFixed(0)} hours across ${c.nights} nights — a second place it sleeps, distinct from home.`
                    }
                    emptyText="No second overnight place — it sleeps in one spot."
                />
            </div>

            {overnight.length > 1 && (
                <div className="px-6 pb-4">
                    <p className="text-xs font-medium text-gray-500 mb-2">
                        Other places it sleeps — the overnight pick is a ranking, not a certainty
                    </p>
                    <div className="space-y-1">
                        {overnight.map((d, i) => (
                            <div
                                key={`${d.lat}-${d.lon}`}
                                className="flex items-center justify-between gap-3 text-xs px-3 py-1.5 rounded-lg bg-gray-50"
                            >
                                <span className="inline-flex items-center gap-2 text-gray-600">
                                    <span className="w-4 text-gray-400 tabular-nums">#{i + 1}</span>
                                    <span className="font-mono">
                                        {d.lat.toFixed(5)}, {d.lon.toFixed(5)}
                                    </span>
                                </span>
                                <span className="text-gray-500 tabular-nums shrink-0">
                                    {d.nightHours.toFixed(0)} h over {d.nights} nights
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="mx-6 mb-6 flex gap-2.5 p-3.5 rounded-xl bg-amber-50 border border-amber-100">
                <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900 space-y-1.5">
                    <p>
                        <strong>These places are inferences, not addresses.</strong> Home is where this
                        vehicle sits between {data?.gates.nightStartHour}:00 and {data?.gates.nightEndHour}
                        :00 across many nights — which in practice is usually where the driver lives, but the
                        data says &ldquo;it parks here at night&rdquo; and nothing more. Nothing here is
                        reverse-geocoded to a street address, and none of it should be treated as one.
                    </p>
                    <p>
                        <strong>The charging spot is inferred from rising-SOC cycles</strong>, because this
                        feed never reports a charging flag — so a place the pack only ever fast-charges
                        between two polls can be missed entirely.
                    </p>
                    {s && s.inferredDwellPct > 0 && (
                        <p>
                            <strong>{s.inferredDwellPct}% of the dwell time is inferred</strong>, not observed:
                            the tracker went quiet and came back to the same place, so the vehicle very
                            probably stayed — but nobody watched. Hours are an upper bound on certainty, not a
                            measurement.
                        </p>
                    )}
                    <p>
                        Parking and dwell are found by <strong>position, not speed</strong>. This tracker
                        almost never reports zero speed (61 of 8,765 fixes on the reference battery), so a
                        speed-based test would find no parking at all. Two fixes within{' '}
                        {data?.gates.dwellRadiusM} m of each other mean the vehicle did not go anywhere.
                    </p>
                </div>
            </div>
        </div>
    );
}

const TONE_COLOR = {
    critical: 'text-red-600',
    violet: 'text-violet-700',
    green: 'text-emerald-600',
    amber: 'text-amber-600',
} as const;

function PlaceCard({
    icon: Icon,
    tone,
    title,
    cluster,
    detail,
    emptyText,
}: {
    icon: React.ElementType;
    tone: keyof typeof TONE_COLOR;
    title: string;
    cluster: DwellCluster | null;
    detail: (c: DwellCluster) => string;
    emptyText?: string;
}) {
    const color = TONE_COLOR[tone];
    return (
        <div className="p-4 rounded-xl border border-gray-100 bg-gray-50/60">
            <div className="flex items-center gap-2 mb-1.5">
                <Icon className={cn('w-4 h-4', color)} />
                <span className="text-xs font-medium text-gray-500">{title}</span>
            </div>
            {cluster ? (
                <>
                    <p className="text-sm font-semibold text-gray-900 font-mono">
                        {cluster.lat.toFixed(5)}, {cluster.lon.toFixed(5)}
                    </p>
                    <p className="text-xs text-gray-500 mt-1 leading-snug">{detail(cluster)}</p>
                    <a
                        href={`https://www.openstreetmap.org/?mlat=${cluster.lat}&mlon=${cluster.lon}#map=17/${cluster.lat}/${cluster.lon}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block mt-2 text-xs font-medium text-brand-600 hover:underline"
                    >
                        Open in OpenStreetMap →
                    </a>
                </>
            ) : (
                <p className="text-sm text-gray-400">
                    {emptyText ?? 'Not enough stationary time to identify one.'}
                </p>
            )}
        </div>
    );
}
