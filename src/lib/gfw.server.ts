import type { TrackPoint, TrackResponse, VesselSearchResult } from "./types";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
// Fase 2 laporan audit: setiap panggilan ke API luar diberi batas waktu (10–15 detik).
const GFW_TIMEOUT_MS = 15_000;

const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];

const GFW_TRACK_DATASET = "public-global-vessel-track:latest";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";

const INDONESIA_POLY = {
  type: "Polygon",
  coordinates: [[[95.0, -11.0], [141.0, -11.0], [141.0, 6.0], [95.0, 6.0], [95.0, -11.0]]],
};

// C.4 (laporan audit): bentuk respons GFW API v3 ditulis sebagai tipe, bukan any. Semua kolom opsional karena
// GFW tidak selalu mengirim semuanya; perubahan nama kolom di GFW kini terlihat saat pemeriksaan TypeScript.
type GfwIdentityInfo = {
  id?: string;
  shipname?: string;
  shipName?: string;
  ssvid?: string;
  imo?: string;
  flag?: string;
  callsign?: string;
};

type GfwVesselEntry = GfwIdentityInfo & {
  vesselId?: string;
  mmsi?: string;
  name?: string;
  selfReportedInfo?: GfwIdentityInfo[];
  registryInfo?: GfwIdentityInfo[];
};

type GfwSearchResponse = {
  entries?: GfwVesselEntry[];
  data?: GfwVesselEntry[];
};

type GfwTrackTime = number | string;

type GfwTrackPointEntry = {
  lat?: number;
  latitude?: number;
  lon?: number;
  longitude?: number;
  timestamp?: string;
  speed?: number;
  course?: number;
  geometry?: { coordinates?: number[] };
  properties?: { timestamp?: string; speed?: number; course?: number };
};

type GfwTrackResponse = {
  geometry?: { coordinates?: number[][] };
  features?: unknown[];
  entries?: unknown[];
  properties?: {
    coordinateProperties?: {
      times?: GfwTrackTime[];
      time?: GfwTrackTime[];
      speed?: number[];
      speeds?: number[];
      course?: number[];
      courses?: number[];
    };
  };
};

export type GfwRawEvent = {
  id?: string;
  type?: string;
  start?: string;
  end?: string;
  position?: { lat?: number; lon?: number };
  vessel?: { id?: string; ssvid?: string; flag?: string; name?: string };
};

type GfwEventsResponse = {
  entries?: GfwRawEvent[];
};

function authHeaders() {
  // B.17 (laporan audit): nama token di PDF GFW_API_TOKEN; GFW_TOKEN (nama lama) tetap dibaca sebagai cadangan.
  const token = process.env.GFW_API_TOKEN || process.env.GFW_TOKEN;
  if (!token) throw new Error("GFW_API_TOKEN is not configured");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function toIsoDate(date: string): string {
  // "2012-01-01" → "2012-01-01T00:00:00Z"
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function isCoordinateList(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length > 0 && Array.isArray(value[0]);
}

function trackTimeToIso(time: GfwTrackTime | undefined): string | undefined {
  if (!time) return undefined;
  if (typeof time === "number") return new Date(time * (time > 10_000_000_000 ? 1 : 1000)).toISOString();
  return new Date(time).toISOString();
}

export async function searchVessels(query: string, limit = 20): Promise<VesselSearchResult[]> {
  const url = new URL(`${GFW_BASE}/vessels/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
  url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
  url.searchParams.set("includes[0]", "MATCH_CRITERIA");
  url.searchParams.set("includes[1]", "OWNERSHIP");
  const res = await fetch(url.toString(), { headers: authHeaders(), signal: AbortSignal.timeout(GFW_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GFW search failed: ${res.status}`);
  const json: GfwSearchResponse = await res.json();
  const entries: GfwVesselEntry[] = json?.entries ?? json?.data ?? [];
  return entries.slice(0, limit).map((e): VesselSearchResult => {
    const sd: GfwIdentityInfo = e?.selfReportedInfo?.[0] ?? e?.registryInfo?.[0] ?? e ?? {};
    return {
      vessel_id: e?.selfReportedInfo?.[0]?.id || e?.id || e?.vesselId || "",
      ship_name: sd?.shipname || sd?.shipName || e?.shipname || e?.name,
      mmsi: sd?.ssvid || e?.ssvid || e?.mmsi,
      imo: sd?.imo || e?.imo,
      flag: sd?.flag || e?.flag,
      callsign: sd?.callsign || e?.callsign,
    };
  }).filter(v => v.vessel_id);
}

function computeBounds(track: TrackPoint[]): TrackResponse["bounds"] {
  if (!track.length) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of track) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [[minLat, minLon], [maxLat, maxLon]];
}

export async function getTrack(vesselId: string, startDate: string, endDate: string): Promise<TrackResponse> {
  const url = new URL(`${GFW_BASE}/vessels/${encodeURIComponent(vesselId)}/tracks`);
  url.searchParams.set("datasets[0]", GFW_TRACK_DATASET);
  url.searchParams.set("start-date", startDate);
  url.searchParams.set("end-date", endDate);

  let track: TrackPoint[] = [];
  let source = "tracks";
  const res = await fetch(url.toString(), { headers: authHeaders(), signal: AbortSignal.timeout(GFW_TIMEOUT_MS) });

  if (res.ok) {
    const json: GfwTrackResponse | GfwTrackPointEntry[] = await res.json();
    const body: GfwTrackResponse = Array.isArray(json) ? {} : json;
    // GFW track response is GeoJSON LineString with coordinateProperties
    const coords: unknown = body.geometry?.coordinates ?? body.features ?? body.entries ?? [];
    const coordProps = body.properties?.coordinateProperties ?? {};
    const times: GfwTrackTime[] = coordProps.times ?? coordProps.time ?? [];
    const speeds: number[] = coordProps.speed ?? coordProps.speeds ?? [];
    const courses: number[] = coordProps.course ?? coordProps.courses ?? [];

    if (isCoordinateList(coords)) {
      track = coords.map((c, i): TrackPoint => ({
        lon: c[0],
        lat: c[1],
        timestamp: trackTimeToIso(times[i]),
        speed: speeds[i],
        course: courses[i],
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    } else {
      // fallback: array of point objects
      const entries = (Array.isArray(json) ? json : (body.entries ?? [])) as GfwTrackPointEntry[];
      track = entries.map((e): TrackPoint => ({
        lat: Number(e?.lat ?? e?.latitude ?? e?.geometry?.coordinates?.[1]),
        lon: Number(e?.lon ?? e?.longitude ?? e?.geometry?.coordinates?.[0]),
        timestamp: e?.timestamp ?? e?.properties?.timestamp,
        speed: e?.speed ?? e?.properties?.speed,
        course: e?.course ?? e?.properties?.course,
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
  } else if (res.status === 404) {
    // Fallback: use event positions as track points
    source = "events";
    const evUrl = new URL(`${GFW_BASE}/events`);
    evUrl.searchParams.set("limit", "200");
    evUrl.searchParams.set("offset", "0");
    evUrl.searchParams.set("sort", "+start");
    const evRes = await fetch(evUrl.toString(), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        datasets: GFW_EVENT_DATASETS,
        startDate: toIsoDate(startDate),
        endDate: toIsoDate(endDate),
        vessels: [vesselId],
      }),
      signal: AbortSignal.timeout(GFW_TIMEOUT_MS),
    });
    if (evRes.ok) {
      const j: GfwEventsResponse = await evRes.json();
      const entries: GfwRawEvent[] = j?.entries ?? [];
      track = entries.map((e): TrackPoint => ({
        lat: Number(e?.position?.lat),
        lon: Number(e?.position?.lon),
        timestamp: e?.start,
        speed: undefined,
        course: undefined,
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
  } else {
    throw new Error(`GFW track failed: ${res.status}`);
  }

  return {
    vessel_id: vesselId,
    start_date: startDate,
    end_date: endDate,
    source,
    count: track.length,
    bounds: computeBounds(track),
    track,
  };
}

// Fetch fishing/encounter/loitering events for Indonesian waters
// Matches server.py gfw_fetch() approach: one POST, all datasets, camelCase dates
export async function getIndonesianEvents(startDate: string, endDate: string): Promise<GfwRawEvent[]> {
  const url = new URL(`${GFW_BASE}/events`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", "-start");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      datasets: GFW_EVENT_DATASETS,
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
      geometry: INDONESIA_POLY,
    }),
    signal: AbortSignal.timeout(GFW_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch((err: unknown) => {
      console.warn("[gfw-events] isi balasan galat GFW tidak bisa dibaca:", err);
      return "";
    });
    throw new Error(`GFW events failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const json: GfwEventsResponse = await res.json();
  return json?.entries ?? [];
}
