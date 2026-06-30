# LAMPIRAN LISTING PROGRAM SIAP TEMPEL

Draf ini disusun berdasarkan Bab 4 Perancangan dan Implementasi Sistem Integrasi AIS-SAR. Setiap listing berisi judul, sumber file, dan potongan kode inti yang dapat ditempel ke bagian lampiran laporan. File `.env.lokal` tidak dicantumkan karena berisi token rahasia.

# LAMPIRAN A
# LISTING PROGRAM PEMERIKSAAN DAN PENYIAPAN DATA AIS-SAR

### Listing Program A.1 Kode Pelengkapan Nilai SOG dan COG pada Data AIS
Sumber file: `scripts/complete-new-dataset-sog-cog.mjs`
````js
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_completed${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_completed_report.txt`);
const lookupPath = join(parsed.dir, `${parsed.base}_still_missing_sog_cog.csv`);

const csv = readFileSync(inputPath, "utf8");
const { headers, rows } = parseCsv(csv);

const addedColumns = [
  "sog_cog_completion_status",
  "sog_cog_completion_source",
  "sog_cog_completion_note",
  "sog_cog_completion_scene_timestamp_utc",
  "sog_cog_completion_track_window_days",
  "sog_cog_completion_nearest_track_time",
  "sog_cog_completion_nearest_track_minutes",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const missingBefore = rows.filter(hasMissingSogOrCog).length;
let alreadyComplete = 0;
let filledFromGfwObserved = 0;
let filledFromGfwComputedPair = 0;
let filledStationaryCogPlaceholder = 0;
let stillMissing = 0;
let gfwNoTrack = 0;
let gfwErrors = 0;

const trackCache = new Map();
const windows = [1, 3, 7, 14];

for (let i = 0; i < rows.length; i += 1) {
  const row = rows[i];
  row.sog_cog_completion_scene_timestamp_utc = sceneTimestamp(row);
  row.sog_cog_completion_track_window_days = "";
  row.sog_cog_completion_nearest_track_time = "";
  row.sog_cog_completion_nearest_track_minutes = "";

  if (!hasMissingSogOrCog(row)) {
    alreadyComplete += 1;
    row.sog_cog_completion_status = "already_complete";
    row.sog_cog_completion_source = "existing_dataset_columns";
    row.sog_cog_completion_note = "";
    continue;
  }

  const sceneTime = parseDate(row.sog_cog_completion_scene_timestamp_utc);
  const vesselId = value(row.gfw_vessel_id);

  if (sceneTime && vesselId) {
    const gfw = await lookupGfwTrack(vesselId, sceneTime);
    if (gfw.error) gfwErrors += 1;
    if (gfw.noTrack) gfwNoTrack += 1;
    if (gfw.fill) {
      if (isBlank(row.Sog) && Number.isFinite(gfw.fill.sog)) row.Sog = formatNumber(gfw.fill.sog, 6);
      if (isBlank(row.Cog) && Number.isFinite(gfw.fill.cog)) row.Cog = formatNumber(gfw.fill.cog, 6);
      row.sog_cog_completion_status = gfw.fill.kind;
      row.sog_cog_completion_source = `Global Fishing Watch track via local /api/gfw/track`;
      row.sog_cog_completion_note = gfw.fill.note;
      row.sog_cog_completion_track_window_days = String(gfw.fill.windowDays);
      row.sog_cog_completion_nearest_track_time = gfw.fill.nearestTime ?? "";
      row.sog_cog_completion_nearest_track_minutes = gfw.fill.nearestMinutes != null ? formatNumber(gfw.fill.nearestMinutes, 3) : "";

      if (gfw.fill.kind === "filled_from_gfw_track_observed_speed_course") filledFromGfwObserved += 1;
      if (gfw.fill.kind === "filled_from_gfw_track_computed_neighbor_pair") filledFromGfwComputedPair += 1;
    }
  }

  if (hasMissingSogOrCog(row) && isBlank(row.Cog) && !isBlank(row.Sog) && number(row.Sog) === 0) {
    row.Cog = "0";
    row.sog_cog_completion_status = "filled_stationary_cog_placeholder";
    row.sog_cog_completion_source = "computational_placeholder";
    row.sog_cog_completion_note = "COG is not physically meaningful when SOG is 0; filled with 0 so Kalman velocity remains zero.";
    filledStationaryCogPlaceholder += 1;
  }

  if (hasMissingSogOrCog(row)) {
    stillMissing += 1;
    if (!row.sog_cog_completion_status) {
      row.sog_cog_completion_status = "still_missing_no_valid_source";
      row.sog_cog_completion_source = "not_filled";
      row.sog_cog_completion_note = "No observed SOG/COG in dataset and no usable GFW track point/pair was found.";
    }
  }
}

writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");
writeFileSync(lookupPath, stringifyCsv(outputHeaders, rows.filter(hasMissingSogOrCog)), "utf8");

const missingAfter = rows.filter(hasMissingSogOrCog).length;
const report = [
  "SOG/COG completion report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, outputPath)}`,
  `Still missing list: ${relative(repoRoot, lookupPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Missing SOG or COG before: ${missingBefore}`,
  `Already complete: ${alreadyComplete}`,
````

### Listing Program A.2 Kode Penyiapan Data AIS untuk Proses Kalman Filter
Sumber file: `scripts/create-kalman-ready-sog-cog.mjs`
````js
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_completed.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_kalman_ready${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_kalman_ready_report.txt`);

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));

const addedColumns = [
  "Sog_for_kalman",
  "Cog_for_kalman",
  "kalman_velocity_status",
  "Sog_for_kalman_source",
  "Cog_for_kalman_source",
  "kalman_velocity_note",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const sogMedianByCategory = groupedMedian(rows, "category", "Sog");
const cogMeanByCategory = groupedCircularMean(rows, "category", "Cog");
const overallSogMedian = median(rows.map((row) => number(row.Sog)).filter(Number.isFinite));
const overallCogMean = circularMean(rows.map((row) => number(row.Cog)).filter(Number.isFinite));

let rawComplete = 0;
let rawSogUsed = 0;
let rawCogUsed = 0;
let sogCategoryMedianImputed = 0;
let sogOverallMedianImputed = 0;
let cogGfwSarBearingUsed = 0;
let cogCategoryMeanImputed = 0;
let cogOverallMeanImputed = 0;

for (const row of rows) {
  const rawSog = number(row.Sog);
  const rawCog = number(row.Cog);
  const category = text(row.category) || "UNKNOWN";

  if (Number.isFinite(rawSog)) {
    row.Sog_for_kalman = formatNumber(rawSog, 6);
    row.Sog_for_kalman_source = "raw_or_enriched_Sog";
    rawSogUsed += 1;
  } else {
    const categoryMedian = sogMedianByCategory.get(category);
    if (Number.isFinite(categoryMedian)) {
      row.Sog_for_kalman = formatNumber(categoryMedian, 6);
      row.Sog_for_kalman_source = `category_median_sog:${category}`;
      sogCategoryMedianImputed += 1;
    } else {
      row.Sog_for_kalman = formatNumber(overallSogMedian, 6);
      row.Sog_for_kalman_source = "overall_median_sog";
      sogOverallMedianImputed += 1;
    }
  }

  if (Number.isFinite(rawCog)) {
    row.Cog_for_kalman = formatAngle(rawCog);
    row.Cog_for_kalman_source = "raw_or_enriched_Cog";
    rawCogUsed += 1;
  } else {
    const gfwSarBearing = number(row.gfw_sar_bearing);
    if (Number.isFinite(gfwSarBearing)) {
      row.Cog_for_kalman = formatAngle(gfwSarBearing);
      row.Cog_for_kalman_source = "gfw_sar_bearing";
      cogGfwSarBearingUsed += 1;
    } else {
      const categoryMean = cogMeanByCategory.get(category);
      if (Number.isFinite(categoryMean)) {
        row.Cog_for_kalman = formatAngle(categoryMean);
        row.Cog_for_kalman_source = `category_circular_mean_cog:${category}`;
        cogCategoryMeanImputed += 1;
      } else {
        row.Cog_for_kalman = formatAngle(overallCogMean);
        row.Cog_for_kalman_source = "overall_circular_mean_cog";
        cogOverallMeanImputed += 1;
      }
    }
  }

  if (Number.isFinite(rawSog) && Number.isFinite(rawCog)) {
    rawComplete += 1;
    row.kalman_velocity_status = "raw_complete";
    row.kalman_velocity_note = "SOG and COG came from existing/enriched dataset columns.";
  } else {
    const missing = [
      Number.isFinite(rawSog) ? "" : "SOG",
      Number.isFinite(rawCog) ? "" : "COG",
    ].filter(Boolean).join("+");
    row.kalman_velocity_status = `kalman_imputed_${missing.toLowerCase()}`;
    row.kalman_velocity_note = "For Kalman only: raw AIS SOG/COG was not available, so a clearly marked modeling value was used. Do not cite this as observed AIS.";
  }
}

writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");

const report = [
  "Kalman-ready SOG/COG report",
  "",
````

### Listing Program A.3 Kode Pengambilan Data Event Kapal dari Global Fishing Watch
Sumber file: `api/gfw/events.js`
````js
import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];
const INDONESIA_POLY = {
  type: "Polygon",
  coordinates: [[[95.0, -11.0], [141.0, -11.0], [141.0, 6.0], [95.0, 6.0], [95.0, -11.0]]],
};

const FRESH_TTL_SECONDS = 10 * 60;
const STALE_TTL_SECONDS = 6 * 60 * 60;
const MAX_EVENTS = 200;

function toIsoDate(date) {
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function cacheKey(start, end) {
  return `gfw:events:idn:v2:${start}:${end}:fishing-encounter-loitering`;
}

function cacheEnvelope(payload) {
  return {
    payload,
    fetchedAt: Date.now(),
  };
}

function isFresh(entry) {
  return entry?.payload && Date.now() - Number(entry.fetchedAt || 0) < FRESH_TTL_SECONDS * 1000;
}

export default async function handler(req, res) {
  const start = req.query.start_date || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const end = req.query.end_date || new Date().toISOString().slice(0, 10);

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-events",
    limit: 20,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const key = cacheKey(start, end);
  const cached = await cacheGet(key);
  if (isFresh(cached)) {
    const payload = {
      ...cached.payload,
      events: (cached.payload.events || []).slice(0, MAX_EVENTS),
    };
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ events: [], error: "GFW_TOKEN not configured" });

  try {
    const url = new URL(`${GFW_BASE}/events`);
    url.searchParams.set("limit", "200");
    url.searchParams.set("offset", "0");
    url.searchParams.set("sort", "-start");

    console.log(`[gfw] fetching ${start} -> ${end} ...`);
    const t0 = Date.now();

    const gfwRes = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets: GFW_EVENT_DATASETS,
        startDate: toIsoDate(start),
        endDate: toIsoDate(end),
        geometry: INDONESIA_POLY,
        vesselTypes: ["FISHING"],
      }),
    });

    if (!gfwRes.ok) {
      const text = await gfwRes.text().catch(() => "");
      console.error(`[gfw] error ${gfwRes.status}: ${text.slice(0, 200)}`);
      throw new Error(`GFW ${gfwRes.status}: ${text.slice(0, 200)}`);
    }

    const json = await gfwRes.json();
    const data = (json?.entries ?? []).slice(0, MAX_EVENTS);
    console.log(`[gfw] OK - ${data.length} events (${Date.now() - t0}ms)`);

    const payload = { events: data };
    await cacheSet(key, cacheEnvelope(payload), STALE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    res.json(payload);
  } catch (e) {
    console.error("[gfw] catch:", e?.message);
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=600");
      res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
      return res.json({
        ...cached.payload,
        events: (cached.payload.events || []).slice(0, MAX_EVENTS),
        warning: "Serving stale GFW data because live fetch failed",
      });
    }
    res.status(500).json({ events: [], error: e?.message || "events failed" });
  }
}
````

### Listing Program A.4 Kode Pengambilan Data Track Kapal dari Global Fishing Watch
Sumber file: `api/gfw/track.js`
````js
import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_TRACK_DATASET = "public-global-vessel-track:latest";
const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];

function toIsoDate(date) {
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function computeBounds(track) {
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

function cacheKey(vesselId, startDate, endDate) {
  return `gfw:track:v2:${encodeURIComponent(vesselId)}:${startDate}:${endDate}`;
}

export default async function handler(req, res) {
  const vesselId = req.query.vessel_id || "";
  const startDate = req.query.start_date || "";
  const endDate = req.query.end_date || "";

  if (!vesselId || !startDate || !endDate) {
    return res.status(400).json({ error: "vessel_id, start_date, end_date required" });
  }

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-track",
    limit: 60,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const key = cacheKey(vesselId, startDate, endDate);
  const cached = await cacheGet(key);
  if (cached?.payload) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=3600");
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(cached.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ error: "GFW_TOKEN not configured" });

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let track = [];
  let source = "tracks";

  try {
    const url = new URL(`${GFW_BASE}/vessels/${encodeURIComponent(vesselId)}/tracks`);
    url.searchParams.set("datasets[0]", GFW_TRACK_DATASET);
    url.searchParams.set("start-date", startDate);
    url.searchParams.set("end-date", endDate);

    const gfwRes = await fetch(url.toString(), { headers });

    if (gfwRes.ok) {
      const json = await gfwRes.json();
      const coords = json?.geometry?.coordinates ?? json?.features ?? json?.entries ?? [];
      const coordProps = json?.properties?.coordinateProperties ?? {};
      const times = coordProps?.times ?? coordProps?.time ?? [];
      const speeds = coordProps?.speed ?? coordProps?.speeds ?? [];
      const courses = coordProps?.course ?? coordProps?.courses ?? [];

      if (Array.isArray(coords) && coords.length && Array.isArray(coords[0])) {
        track = coords.map((c, i) => ({
          lon: c[0],
          lat: c[1],
          timestamp: times[i]
            ? new Date(typeof times[i] === "number" ? times[i] * (times[i] > 10_000_000_000 ? 1 : 1000) : times[i]).toISOString()
            : undefined,
          speed: speeds[i],
          course: courses[i],
        })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      } else {
        const entries = Array.isArray(json) ? json : (json?.entries ?? []);
        track = entries.map((e) => ({
          lat: Number(e?.lat ?? e?.latitude ?? e?.geometry?.coordinates?.[1]),
          lon: Number(e?.lon ?? e?.longitude ?? e?.geometry?.coordinates?.[0]),
          timestamp: e?.timestamp ?? e?.properties?.timestamp,
          speed: e?.speed ?? e?.properties?.speed,
          course: e?.course ?? e?.properties?.course,
        })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      }
    } else if (gfwRes.status === 404) {
      source = "events";
      const evUrl = new URL(`${GFW_BASE}/events`);
      evUrl.searchParams.set("limit", "200");
      evUrl.searchParams.set("offset", "0");
      evUrl.searchParams.set("sort", "+start");

      const evRes = await fetch(evUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          datasets: GFW_EVENT_DATASETS,
          startDate: toIsoDate(startDate),
          endDate: toIsoDate(endDate),
          vessels: [vesselId],
        }),
      });

      if (evRes.ok) {
        const j = await evRes.json();
        const entries = j?.entries ?? [];
        track = entries.map((e) => ({
          lat: Number(e?.position?.lat),
          lon: Number(e?.position?.lon),
          timestamp: e?.start,
          speed: undefined,
          course: undefined,
        })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      }
    } else {
      throw new Error(`GFW track failed: ${gfwRes.status}`);
    }

    const payload = {
      vessel_id: vesselId,
      start_date: startDate,
      end_date: endDate,
      source,
      count: track.length,
      bounds: computeBounds(track),
      track,
    };
    await cacheSet(key, { payload, fetchedAt: Date.now() }, 6 * 60 * 60);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=3600");
    res.json(payload);
  } catch (e) {
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=3600");
      return res.json({
        ...cached.payload,
        warning: "Serving stale GFW track because live fetch failed",
      });
    }
    res.status(500).json({ error: e?.message || "track failed" });
  }
}
````

### Listing Program A.5 Kode Pencarian Identitas Kapal Berdasarkan MMSI atau Vessel ID
Sumber file: `api/gfw/vessels/search.js`
````js
import { cacheGet, cacheSet } from "../../_redis.js";
import { applyRateLimit } from "../../_rate-limit.js";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";

function cacheKey(query, limit) {
  return `gfw:vessels:search:v1:${encodeURIComponent(query.toLowerCase())}:${limit}`;
}

export default async function handler(req, res) {
  const query = (req.query.query || "").trim();
  const limit = Math.min(50, Number(req.query.limit || "20"));

  if (!query) return res.json({ entries: [] });

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-vessel-search",
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const key = cacheKey(query, limit);
  const cached = await cacheGet(key);
  if (cached?.payload) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=600, stale-while-revalidate=86400");
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(cached.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ entries: [], error: "GFW_TOKEN not configured" });

  try {
    const url = new URL(`${GFW_BASE}/vessels/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
    url.searchParams.set("includes[0]", "MATCH_CRITERIA");
    url.searchParams.set("includes[1]", "OWNERSHIP");

    const gfwRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    if (!gfwRes.ok) throw new Error(`GFW search failed: ${gfwRes.status}`);

    const json = await gfwRes.json();
    const raw = json?.entries ?? json?.data ?? [];

    const entries = raw.slice(0, limit).map((e) => {
      const sd = e?.selfReportedInfo?.[0] ?? e?.registryInfo?.[0] ?? e ?? {};
      return {
        vessel_id: e?.selfReportedInfo?.[0]?.id || e?.id || e?.vesselId || "",
        ship_name: sd?.shipname || sd?.shipName || e?.shipname || e?.name,
        mmsi: sd?.ssvid || e?.ssvid || e?.mmsi,
        imo: sd?.imo || e?.imo,
        flag: sd?.flag || e?.flag,
        callsign: sd?.callsign || e?.callsign,
      };
    }).filter((v) => v.vessel_id);

    const payload = { entries };
    await cacheSet(key, { payload, fetchedAt: Date.now() }, 24 * 60 * 60);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (e) {
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=86400");
      return res.json({
        ...cached.payload,
        warning: "Serving stale GFW vessel search because live fetch failed",
      });
    }
    res.status(500).json({ entries: [], error: e?.message || "search failed" });
  }
}
````

# LAMPIRAN B
# LISTING PROGRAM ESTIMASI POSISI DAN TRAJECTORY AIS-KALMAN

### Listing Program B.1 Kode Implementasi Kalman Filter untuk Estimasi Posisi Kapal
Sumber file: `scripts/run-kalman-on-ais-sar.mjs`
````js
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_ais_latlon_formula_filled.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_kalman_estimated${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_kalman_report.txt`);

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));

const addedColumns = [
  "kalman_status",
  "kalman_note",
  "kalman_scene_timestamp_utc",
  "kalman_mmsi_observation_count",
  "kalman_sequence_index",
  "kalman_dt_hours",
  "kalman_position_measurement_source",
  "kalman_velocity_measurement_used",
  "kalman_velocity_measurement_source",
  "kalman_pred_lat",
  "kalman_pred_lon",
  "kalman_est_lat",
  "kalman_est_lon",
  "kalman_est_sog",
  "kalman_est_cog",
  "kalman_pred_residual_m",
  "kalman_est_position_sigma_m",
  "kalman_est_velocity_sigma_mps",
  "kalman_model",
  "kalman_process_acceleration_sigma_mps2",
  "kalman_position_measurement_sigma_m",
  "kalman_velocity_measurement_sigma_mps",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const processAccelerationSigma = 0.02;
const positionMeasurementSigma = 250;

const validRows = rows
  .map((row, index) => ({ row, index, time: sceneTimestamp(row), lat: number(row.AIS_Latitude), lon: number(row.AIS_Longitude) }))
  .filter((item) => value(item.row.MMSI) && item.time && finiteLatLon(item.lat, item.lon));

const groups = new Map();
for (const item of validRows) {
  const mmsi = value(item.row.MMSI);
  if (!groups.has(mmsi)) groups.set(mmsi, []);
  groups.get(mmsi).push(item);
}

for (const group of groups.values()) {
  group.sort((a, b) => a.time - b.time || a.index - b.index);
}

let rowsWithPosition = 0;
let rowsWithVelocity = 0;
let rowsWithoutVelocity = 0;
let initialized = 0;
let predictedAndUpdated = 0;
let positionOnly = 0;
let skipped = 0;
const residuals = [];

for (const row of rows) {
  row.kalman_status = "skipped_missing_required_position_or_time";
  row.kalman_note = "Missing MMSI, scene timestamp, AIS_Latitude, or AIS_Longitude.";
  row.kalman_scene_timestamp_utc = "";
  row.kalman_mmsi_observation_count = "";
  row.kalman_sequence_index = "";
  row.kalman_dt_hours = "";
  row.kalman_position_measurement_source = "";
  row.kalman_velocity_measurement_used = "false";
  row.kalman_velocity_measurement_source = "";
  row.kalman_pred_lat = "";
  row.kalman_pred_lon = "";
  row.kalman_est_lat = "";
  row.kalman_est_lon = "";
  row.kalman_est_sog = "";
  row.kalman_est_cog = "";
  row.kalman_pred_residual_m = "";
  row.kalman_est_position_sigma_m = "";
  row.kalman_est_velocity_sigma_mps = "";
  row.kalman_model = "constant_velocity_xy";
  row.kalman_process_acceleration_sigma_mps2 = formatNumber(processAccelerationSigma, 6);
  row.kalman_position_measurement_sigma_m = formatNumber(positionMeasurementSigma, 3);
  row.kalman_velocity_measurement_sigma_mps = "";
}

for (const [mmsi, group] of groups) {
  const refLat = group[0].lat;
  const refLon = group[0].lon;
  let state = null;
  let covariance = null;
  let previousTime = null;

  for (let i = 0; i < group.length; i += 1) {
    const item = group[i];
    const row = item.row;
    rowsWithPosition += 1;

    const position = projectToMeters(item.lat, item.lon, refLat, refLon);
    const velocity = velocityMeasurement(row);
    if (velocity) rowsWithVelocity += 1;
    else rowsWithoutVelocity += 1;

    row.kalman_scene_timestamp_utc = item.time.toISOString();
    row.kalman_mmsi_observation_count = String(group.length);
    row.kalman_sequence_index = String(i + 1);
    row.kalman_position_measurement_source = "AIS_Latitude|AIS_Longitude";
    row.kalman_velocity_measurement_used = velocity ? "true" : "false";
    row.kalman_velocity_measurement_source = velocity?.source ?? "not_used_missing_Sog_or_Cog";

    if (!state) {
      state = [
````

### Listing Program B.2 Kode Konversi SOG dan COG Menjadi Komponen Kecepatan
Sumber file: `scripts/run-kalman-on-ais-sar.mjs`
````js
function velocityMeasurement(row) {
  const sog = number(row.Sog);
  const cog = number(row.Cog);
  if (!Number.isFinite(sog) || !Number.isFinite(cog) || sog < 0) return null;
  const speed = sog * 0.514444;
  const rad = toRad(((cog % 360) + 360) % 360);
  const source = velocitySource(row);
  return {
    vx: speed * Math.sin(rad),
    vy: speed * Math.cos(rad),
    sigma: velocitySigma(source, sog),
    source,
  };
}

function velocitySource(row) {
  const formulaStatus = value(row.ais_latlon_formula_status);
  if (formulaStatus === "filled_from_same_mmsi_ais_latlon_inter_scene") return "same_mmsi_ais_latlon_inter_scene_formula";
  if (formulaStatus === "filled_stationary_cog_placeholder") return "existing_Sog_0_stationary_Cog_placeholder";
  if (formulaStatus === "already_complete") return value(row.sog_cog_source) || "existing_or_enriched_Sog_Cog";
  if (value(row.sog_cog_completion_status) === "filled_from_gfw_track_observed_speed_course") return "GFW_track_observed_speed_course";
  return value(row.sog_cog_source) || value(row.sog_cog_completion_source) || "existing_or_enriched_Sog_Cog";
}

function velocitySigma(source, sog) {
  if (source === "same_mmsi_ais_latlon_inter_scene_formula") return 2.5;
  if (source === "existing_Sog_0_stationary_Cog_placeholder" || sog === 0) return 1.0;
  return 0.75;
}
````

### Listing Program B.3 Kode Prediksi dan Pembaruan Posisi pada Kalman Filter
Sumber file: `scripts/run-kalman-on-ais-sar.mjs`
````js
function predict(state, covariance, dtSeconds) {
  const f = [
    [1, 0, dtSeconds, 0],
    [0, 1, 0, dtSeconds],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const q = processNoise(dtSeconds, processAccelerationSigma);
  return {
    state: matVecMul(f, state),
    covariance: matAdd(matMul(matMul(f, covariance), transpose(f)), q),
  };
}

function updatePosition(state, covariance, x, y) {
  const h = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ];
  const r = diag([positionMeasurementSigma ** 2, positionMeasurementSigma ** 2]);
  return kalmanUpdate(state, covariance, [x, y], h, r);
}

function updateVelocity(state, covariance, vx, vy, sigma) {
  const h = [
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const r = diag([sigma ** 2, sigma ** 2]);
  return kalmanUpdate(state, covariance, [vx, vy], h, r);
}

function kalmanUpdate(state, covariance, measurement, h, r) {
  const ht = transpose(h);
  const innovation = vecSub(measurement, matVecMul(h, state));
  const s = matAdd(matMul(matMul(h, covariance), ht), r);
  const invS = inverse2(s);
  const k = matMul(matMul(covariance, ht), invS);
  const updatedState = vecAdd(state, matVecMul(k, innovation));
  const kh = matMul(k, h);
  const iMinusKh = matSub(identity(4), kh);
  const updatedCovariance = matMul(iMinusKh, covariance);
  return { state: updatedState, covariance: symmetrize(updatedCovariance) };
}

function writeEstimate(row, latLon, state, covariance) {
  row.kalman_est_lat = formatNumber(latLon.lat, 8);
  row.kalman_est_lon = formatNumber(latLon.lon, 8);
  const speedMps = Math.hypot(state[2], state[3]);
  row.kalman_est_sog = formatNumber(speedMps / 0.514444, 6);
  row.kalman_est_cog = speedMps > 1e-9 ? formatAngle(toDeg(Math.atan2(state[2], state[3]))) : "0";
  row.kalman_est_position_sigma_m = formatNumber(Math.sqrt(Math.max(0, (covariance[0][0] + covariance[1][1]) / 2)), 3);
  row.kalman_est_velocity_sigma_mps = formatNumber(Math.sqrt(Math.max(0, (covariance[2][2] + covariance[3][3]) / 2)), 6);
  row.kalman_velocity_measurement_sigma_mps = row.kalman_velocity_measurement_used === "true"
    ? formatNumber(velocitySigma(row.kalman_velocity_measurement_source, number(row.Sog)), 6)
    : "";
}

````

### Listing Program B.4 Kode Penyusunan Titik Lintasan AIS Mentah dan Kalman
Sumber file: `scripts/create-ais-trajectories.mjs`
````js
const pointsPath = join(outputDir, "ais_trajectory_points_raw_vs_kalman.csv");
const rawLinesPath = join(outputDir, "ais_trajectories_raw.geojson");
const kalmanLinesPath = join(outputDir, "ais_trajectories_kalman.geojson");
const comparisonLinesPath = join(outputDir, "ais_trajectories_raw_vs_kalman.geojson");
const plotDir = join(outputDir, "trajectory_plots_svg");
const reportPath = join(outputDir, "ais_trajectories_kalman_report.txt");

const { rows } = parseCsv(readFileSync(inputPath, "utf8"));

const pointHeaders = [
  "MMSI",
  "Name",
  "category",
  "scene",
  "timestamp_utc",
  "sequence_index",
  "observation_count",
  "ais_lat",
  "ais_lon",
  "kalman_lat",
  "kalman_lon",
  "sog",
  "cog",
  "kalman_est_sog",
  "kalman_est_cog",
  "trajectory_point_source",
];

const points = [];
for (const row of rows) {
  const mmsi = value(row.MMSI);
  const time = parseDateish(row.kalman_scene_timestamp_utc) ?? sceneTimestamp(row);
  const kalmanLat = number(row.kalman_est_lat);
  const kalmanLon = number(row.kalman_est_lon);
  const aisLat = number(row.AIS_Latitude);
  const aisLon = number(row.AIS_Longitude);

  if (!mmsi || !time || !finiteLatLon(kalmanLat, kalmanLon)) continue;

  points.push({
    MMSI: mmsi,
    Name: value(row.Name),
    category: value(row.category),
    scene: value(row.scene),
    timestamp_utc: time.toISOString(),
    sequence_index: value(row.kalman_sequence_index),
    observation_count: value(row.kalman_mmsi_observation_count),
    ais_lat: Number.isFinite(aisLat) ? formatNumber(aisLat, 8) : "",
    ais_lon: Number.isFinite(aisLon) ? formatNumber(aisLon, 8) : "",
    kalman_lat: formatNumber(kalmanLat, 8),
    kalman_lon: formatNumber(kalmanLon, 8),
    sog: value(row.Sog),
    cog: value(row.Cog),
    kalman_est_sog: value(row.kalman_est_sog),
    kalman_est_cog: value(row.kalman_est_cog),
    trajectory_point_source: "kalman_est_lat_lon_from_AIS_position_updates",
  });
}

points.sort((a, b) => a.MMSI.localeCompare(b.MMSI) || new Date(a.timestamp_utc) - new Date(b.timestamp_utc));

const groups = new Map();
for (const point of points) {
  if (!groups.has(point.MMSI)) groups.set(point.MMSI, []);
  groups.get(point.MMSI).push(point);
}
````

### Listing Program B.5 Kode Penyusunan File GeoJSON Lintasan AIS dan Kalman
Sumber file: `scripts/create-ais-trajectories.mjs`
````js
const rawFeatures = [];
const kalmanFeatures = [];
for (const [mmsi, group] of groups) {
  if (group.length < 2) continue;
  const commonProperties = {
    MMSI: mmsi,
    Name: firstNonBlank(group.map((p) => p.Name)),
    category: firstNonBlank(group.map((p) => p.category)),
    point_count: group.length,
    start_time_utc: group[0].timestamp_utc,
    end_time_utc: group[group.length - 1].timestamp_utc,
  };

  const rawCoordinates = group
    .filter((p) => Number.isFinite(Number(p.ais_lon)) && Number.isFinite(Number(p.ais_lat)))
    .map((p) => [Number(p.ais_lon), Number(p.ais_lat)]);
  if (rawCoordinates.length >= 2) {
    rawFeatures.push({
      type: "Feature",
      properties: {
        ...commonProperties,
        trajectory_type: "raw_ais_before_kalman",
        source: "AIS_Latitude_AIS_Longitude_before_Kalman",
      },
      geometry: {
        type: "LineString",
        coordinates: rawCoordinates,
      },
    });
  }

  kalmanFeatures.push({
    type: "Feature",
    properties: {
      ...commonProperties,
      trajectory_type: "kalman_after_filter",
      source: "kalman_estimated_AIS_trajectory",
    },
    geometry: {
      type: "LineString",
      coordinates: group.map((p) => [Number(p.kalman_lon), Number(p.kalman_lat)]),
    },
  });
}

mkdirSync(plotDir, { recursive: true });
let plotsWritten = 0;
for (const [mmsi, group] of groups) {
  if (group.length < 2) continue;
  const svg = renderTrajectoryComparisonSvg(mmsi, group);
  if (!svg) continue;
  writeFileSync(join(plotDir, `trajectory_${safeFileName(mmsi)}.svg`), svg, "utf8");
  plotsWritten += 1;
}

writeFileSync(pointsPath, stringifyCsv(pointHeaders, points), "utf8");
writeFileSync(rawLinesPath, JSON.stringify({ type: "FeatureCollection", features: rawFeatures }, null, 2), "utf8");
writeFileSync(kalmanLinesPath, JSON.stringify({ type: "FeatureCollection", features: kalmanFeatures }, null, 2), "utf8");
writeFileSync(comparisonLinesPath, JSON.stringify({ type: "FeatureCollection", features: [...rawFeatures, ...kalmanFeatures] }, null, 2), "utf8");

````

### Listing Program B.6 Kode Pembuatan Visualisasi Trajectory AIS-Kalman 25 Sequence
Sumber file: `scripts/build-reference-style-25seq-per-mmsi.mjs`
````js
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const args = parseArgs(process.argv.slice(2));

const inputDir = resolve(args["input-dir"] ?? join(repoRoot, "Dataset_Test_Enriched"));
const outputDir = resolve(
  args["output-dir"] ??
  join(inputDir, "trajectory_outputs_25seq_per_mmsi_reference_style"),
);
const sourceRenderer = resolve(
  args["source-renderer"] ??
  "D:/FILE FIFI/GFW/GFWAISSAR-ai-test/scripts/build-ais-kalman-patches.mjs",
);
const sequenceLength = 25;
const windowStride = positiveInteger(args["window-stride"], 0);
const multipleWindowsPerMmsi = windowStride > 0;
const stagingDir = `${outputDir}.staging`;

if (!existsSync(inputDir)) throw new Error(`Input directory does not exist: ${inputDir}`);
if (!existsSync(sourceRenderer)) throw new Error(`Reference renderer does not exist: ${sourceRenderer}`);
if (existsSync(outputDir) || existsSync(stagingDir)) {
  throw new Error(
    `Output or staging directory already exists.\nOutput: ${outputDir}\nStaging: ${stagingDir}`,
  );
}

let stagingCreated = false;
try {
  const stagingArgs = [
    "--input-dir", inputDir,
    "--output-dir", stagingDir,
    "--sequence-scope", "mmsi",
    "--best-per-label", "3",
  ];
  if (!multipleWindowsPerMmsi) {
    stagingArgs.push(
      "--sequence-limit-per-track", String(sequenceLength),
      "--sequence-selection", "residual-window",
    );
  }
  runNode(join(repoRoot, "scripts", "create-labeled-ais-trajectories.mjs"), stagingArgs);
  stagingCreated = true;

  const stagingCsv = join(stagingDir, "trajectory_points_raw_vs_kalman.csv");
  const { rows } = parseCsv(readFileSync(stagingCsv, "utf8"));
  const rowsByMmsi = groupBy(rows, (row) => String(row.mmsi ?? "").trim());
  const invalidGroups = [...rowsByMmsi.entries()]
    .filter(([mmsi, group]) =>
      !mmsi ||
      (multipleWindowsPerMmsi ? group.length < sequenceLength : group.length !== sequenceLength))
    .map(([mmsi, group]) => `${mmsi || "(blank)"}=${group.length}`);
  if (invalidGroups.length) {
    throw new Error(
      multipleWindowsPerMmsi
        ? `Every MMSI must contain at least ${sequenceLength} points: ${invalidGroups.join(", ")}`
        : `Every MMSI must contain exactly ${sequenceLength} points: ${invalidGroups.join(", ")}`,
    );
  }

  const orderedRows = [...rowsByMmsi.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .flatMap(([, group]) =>
      group.toSorted((a, b) => Number(a.sequence_index) - Number(b.sequence_index)));

  const rendererHeaders = [
    "mmsi",
    "timestamp",
    "time_iso",
    "kalman_lat",
    "kalman_lon",
    "raw_lat",
    "raw_lon",
    "kalman_speed_kn",
    "kalman_course_deg",
    "raw_speed_kn",
    "raw_course_deg",
    "kalman_correction_m",
    "kalman_uncertainty_m",
    "kalman_reset",
    "kalman_reset_reason",
    "source",
    "gear",
    "gear_label",
    "dataset_file",
  ];
  const rendererRows = orderedRows.map((row) => {
    const rawLat = finiteNumber(row.lat);
    const rawLon = finiteNumber(row.lon);
    const kalmanLat = finiteNumber(row.kalman_est_lat);
    const kalmanLon = finiteNumber(row.kalman_est_lon);
    const date = new Date(row.timestamp);
    if (
      !Number.isFinite(rawLat) ||
      !Number.isFinite(rawLon) ||
      !Number.isFinite(kalmanLat) ||
      !Number.isFinite(kalmanLon) ||
      Number.isNaN(date.getTime())
    ) {
      throw new Error(`Invalid trajectory row for MMSI ${row.mmsi}, sequence ${row.sequence_index}`);
    }
    const iso = date.toISOString().replace(".000Z", "Z");
    return {
      mmsi: row.mmsi,
      timestamp: Math.round(date.getTime() / 1000),
      time_iso: iso,
      kalman_lat: formatNumber(kalmanLat, 10),
      kalman_lon: formatNumber(kalmanLon, 10),
      raw_lat: formatNumber(rawLat, 10),
      raw_lon: formatNumber(rawLon, 10),
      kalman_speed_kn: row.kalman_est_speed_knots,
      kalman_course_deg: row.kalman_est_course_deg,
      raw_speed_kn: row.speed,
      raw_course_deg: row.course,
      kalman_correction_m: formatNumber(
        haversineM(rawLat, rawLon, kalmanLat, kalmanLon),
        3,
      ),
      kalman_uncertainty_m: row.kalman_position_sigma_m,
      kalman_reset: "0",
      kalman_reset_reason: "",
      source: row.source,
      gear: row.gear_label,
      gear_label: row.gear_label,
      dataset_file: row.input_file,
    };
  });

  mkdirSync(outputDir, { recursive: false });
  const rendererInput = join(outputDir, "ais_kalman_25seq_per_mmsi.csv");
  writeFileSync(rendererInput, stringifyCsv(rendererHeaders, rendererRows), "utf8");
  copyFileSync(stagingCsv, join(outputDir, "trajectory_points_raw_vs_kalman.csv"));
  copyFileSync(
````

# LAMPIRAN C
# LISTING PROGRAM MATCHING AIS-SAR DAN PEMBENTUKAN KANDIDAT AKTIVITAS KAPAL

### Listing Program C.1 Kode Perhitungan Jarak SAR-AIS dan SAR-Kalman
Sumber file: `scripts/find-scene-candidates.py`
````python
    lat2 = to_num(lat2)
    lon2 = to_num(lon2)

    r = 6371.0088
    p1 = lat1.map(math.radians)
    p2 = lat2.map(math.radians)
    dlat = (lat2 - lat1).map(math.radians)
    dlon = (lon2 - lon1).map(math.radians)
    a = (dlat / 2).map(math.sin) ** 2 + p1.map(math.cos) * p2.map(math.cos) * (dlon / 2).map(math.sin) ** 2
    return 2 * r * a.map(lambda x: math.atan2(math.sqrt(x), math.sqrt(1 - x)) if pd.notna(x) else math.nan)


def scene_time(scene: object) -> str:
    match = re.search(r"_(\d{8}T\d{6})_", str(scene))
    if not match:
        return ""
    raw = match.group(1)
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}T{raw[9:11]}:{raw[11:13]}:{raw[13:15]}Z"


def ship_text(row: pd.Series) -> str:
    parts = []
    for col in ("Ship_Type", "gfw_shiptype", "category", "Name", "gfw_name"):
        value = row.get(col)
        if pd.notna(value) and str(value).strip():
            parts.append(str(value).upper())
    return " ".join(parts)


def score_gap(hours: float, threshold: float) -> float:
    if pd.isna(hours):
        return 0.0
    return min(1.0, 0.55 + (float(hours) - threshold) / max(1.0, threshold * 4))


def add_common(row: pd.Series, source_file: Path) -> dict:
    keep = {
        "scene": row.get("scene", ""),
        "scene_time_utc": row.get("scene_time_utc", ""),
        "MMSI": row.get("MMSI", ""),
        "Name": row.get("Name", row.get("gfw_name", "")),
        "Ship_Type": row.get("Ship_Type", ""),
        "gfw_shiptype": row.get("gfw_shiptype", ""),
        "Center_latitude": row.get("Center_latitude", ""),
        "Center_longitude": row.get("Center_longitude", ""),
        "Sog": row.get("Sog", ""),
        "Cog": row.get("Cog", ""),
        "AIS_Latitude": row.get("AIS_Latitude", ""),
        "AIS_Longitude": row.get("AIS_Longitude", ""),
        "sar_ais_distance_km": row.get("sar_ais_distance_km", ""),
        "sar_projected_distance_km": row.get("sar_projected_distance_km", ""),
        "sar_kalman_est_distance_km": row.get("sar_kalman_est_distance_km", ""),
        "AIS_update_time_gap_hours": row.get("AIS_update_time_gap_hours", ""),
        "ais_position_time_gap_hours": row.get("ais_position_time_gap_hours", ""),
        "kalman_dt_hours": row.get("kalman_dt_hours", ""),
        "kalman_pred_residual_m": row.get("kalman_pred_residual_m", ""),
        "kalman_mmsi_observation_count": row.get("kalman_mmsi_observation_count", ""),
        "patch_rgb_vv_actual_file": row.get("patch_rgb_vv_actual_file", ""),
        "patch_rgb_vh_actual_file": row.get("patch_rgb_vh_actual_file", ""),
        "source_file": str(source_file),
    }
    return keep

````

### Listing Program C.2 Kode Penyusunan Fitur Integrasi AIS-SAR
Sumber file: `scripts/find-scene-candidates.py`
````python
def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "scene" not in df.columns:
        raise ValueError("Input must contain a 'scene' column.")
    if "MMSI" not in df.columns:
        raise ValueError("Input must contain an 'MMSI' column.")

    df["scene_time_utc"] = df["scene"].map(scene_time)

    if {"Center_latitude", "Center_longitude", "AIS_Latitude", "AIS_Longitude"}.issubset(df.columns):
        df["sar_ais_distance_km"] = haversine_km(df["Center_latitude"], df["Center_longitude"], df["AIS_Latitude"], df["AIS_Longitude"])
    else:
        df["sar_ais_distance_km"] = math.nan

    if {"Center_latitude", "Center_longitude", "Projected_Latitude", "Projected_Longitude"}.issubset(df.columns):
        df["sar_projected_distance_km"] = haversine_km(df["Center_latitude"], df["Center_longitude"], df["Projected_Latitude"], df["Projected_Longitude"])
    else:
        df["sar_projected_distance_km"] = math.nan

    if {"Center_latitude", "Center_longitude", "kalman_est_lat", "kalman_est_lon"}.issubset(df.columns):
        df["sar_kalman_est_distance_km"] = haversine_km(df["Center_latitude"], df["Center_longitude"], df["kalman_est_lat"], df["kalman_est_lon"])
    else:
        df["sar_kalman_est_distance_km"] = math.nan

    for col in [
        "Sog",
        "AIS_update_time_gap_hours",
        "ais_position_time_gap_hours",
        "kalman_dt_hours",
        "kalman_pred_residual_m",
        "kalman_mmsi_observation_count",
    ]:
        if col in df.columns:
            df[col] = to_num(df[col])
    return df

````

### Listing Program C.3 Kode Pembentukan Kandidat Go Dark
Sumber file: `scripts/find-scene-candidates.py`
````python
def find_godark(df: pd.DataFrame, source_file: Path, gap_hours: float) -> list[dict]:
    out = []
    if "AIS_update_time_gap_hours" not in df.columns:
        return out
    for _, row in df[df["AIS_update_time_gap_hours"] >= gap_hours].iterrows():
        item = add_common(row, source_file)
        gap = row.get("AIS_update_time_gap_hours")
        item.update(
            {
                "candidate_type": "godark",
                "score": round(score_gap(gap, gap_hours), 4),
                "rule": f"AIS_update_time_gap_hours >= {gap_hours:g}",
                "evidence": f"SAR scene has MMSI but nearest AIS update is {gap:.2f} hours from scene time.",
                "neighbor_mmsi": "",
                "neighbor_distance_km": "",
                "neighbor_sog": "",
            }
        )
        out.append(item)
    return out

````

### Listing Program C.4 Kode Pembentukan Kandidat Spoofing
Sumber file: `scripts/find-scene-candidates.py`
````python
def find_spoofing(df: pd.DataFrame, source_file: Path, args: argparse.Namespace) -> list[dict]:
    out = []
    for _, row in df.iterrows():
        ais_gap = row.get("AIS_update_time_gap_hours")
        pos_gap = row.get("ais_position_time_gap_hours")
        time_gap = min([x for x in [ais_gap, pos_gap] if pd.notna(x)], default=math.nan)
        dist = row.get("sar_ais_distance_km")
        residual = row.get("kalman_pred_residual_m")
        kalman_dt = row.get("kalman_dt_hours")

        reasons = []
        scores = []
        if pd.notna(time_gap) and pd.notna(dist) and time_gap <= args.spoof_close_hours and dist >= args.spoof_distance_km:
            reasons.append(f"SAR-AIS distance {dist:.2f} km with time gap {time_gap:.2f} h")
            scores.append(min(1.0, 0.55 + (dist - args.spoof_distance_km) / 30))
        if pd.notna(time_gap) and pd.notna(dist) and time_gap <= args.spoof_wide_hours and dist >= args.spoof_wide_distance_km:
            reasons.append(f"wide SAR-AIS distance {dist:.2f} km with time gap {time_gap:.2f} h")
            scores.append(min(1.0, 0.7 + (dist - args.spoof_wide_distance_km) / 50))
        if pd.notna(kalman_dt) and pd.notna(residual) and kalman_dt <= args.spoof_wide_hours and residual >= args.kalman_residual_m:
            reasons.append(f"Kalman residual {residual:.0f} m after {kalman_dt:.2f} h")
            scores.append(min(1.0, 0.6 + (residual - args.kalman_residual_m) / 100_000))

        if not reasons:
            continue

        item = add_common(row, source_file)
        item.update(
            {
                "candidate_type": "spoofing",
                "score": round(max(scores), 4),
                "rule": "close-time SAR/AIS mismatch or Kalman residual",
                "evidence": "; ".join(reasons),
                "neighbor_mmsi": "",
                "neighbor_distance_km": "",
                "neighbor_sog": "",
            }
        )
        out.append(item)
    return out

````

### Listing Program C.5 Kode Pembentukan Kandidat Transshipment
Sumber file: `scripts/find-scene-candidates.py`
````python
def find_transshipment(df: pd.DataFrame, source_file: Path, max_distance_km: float, slow_knots: float) -> list[dict]:
    out = []
    required = {"scene", "MMSI", "Center_latitude", "Center_longitude"}
    if not required.issubset(df.columns):
        return out

    for scene, group in df.groupby("scene", dropna=True):
        group = group.dropna(subset=["MMSI", "Center_latitude", "Center_longitude"]).copy()
        if group["MMSI"].nunique() < 2:
            continue

        records = list(group.iterrows())
        for idx, row in records:
            best = None
            lat1 = pd.to_numeric(pd.Series([row["Center_latitude"]]), errors="coerce")
            lon1 = pd.to_numeric(pd.Series([row["Center_longitude"]]), errors="coerce")
            for jdx, other in records:
                if idx == jdx or str(row["MMSI"]) == str(other["MMSI"]):
                    continue
                dist = haversine_km(
                    lat1,
                    lon1,
                    pd.Series([other["Center_latitude"]]),
                    pd.Series([other["Center_longitude"]]),
                ).iloc[0]
                if pd.isna(dist):
                    continue
                if best is None or dist < best["dist"]:
                    best = {"row": other, "dist": float(dist)}

            if not best or best["dist"] > max_distance_km:
                continue

            other = best["row"]
            sog1 = row.get("Sog")
            sog2 = other.get("Sog")
            slow_pair = pd.notna(sog1) and pd.notna(sog2) and float(sog1) <= slow_knots and float(sog2) <= slow_knots
            cargo_fishing_pair = ("CARGO" in ship_text(row) and "FISHING" in ship_text(other)) or (
                "FISHING" in ship_text(row) and "CARGO" in ship_text(other)
            )

            score = 0.55 + max(0.0, (max_distance_km - best["dist"]) / max_distance_km) * 0.25
            reasons = [f"nearest MMSI {other.get('MMSI')} at {best['dist']:.3f} km in same SAR scene"]
            if slow_pair:
                score += 0.15
                reasons.append(f"both vessels slow (SOG {float(sog1):.2f} and {float(sog2):.2f} kn)")
            if cargo_fishing_pair:
                score += 0.1
                reasons.append("cargo/fishing pair")

            item = add_common(row, source_file)
            item.update(
                {
                    "candidate_type": "transshipment",
                    "score": round(min(score, 1.0), 4),
                    "rule": f"same-scene nearest-vessel distance <= {max_distance_km:g} km",
                    "evidence": "; ".join(reasons),
                    "neighbor_mmsi": other.get("MMSI", ""),
                    "neighbor_distance_km": round(best["dist"], 6),
                    "neighbor_sog": other.get("Sog", ""),
                }
            )
            out.append(item)
    return out

````

### Listing Program C.6 Kode Rekapitulasi Kandidat Alert Aktivitas Kapal
Sumber file: `scripts/summarize-scene-candidates.py`
````python
#!/usr/bin/env python3
"""Summarize scene candidate counts from the candidate CSV.

This script is intentionally read-only for the candidate file. It creates a
separate summary CSV so report numbers can be refreshed without hardcoding.
"""

from __future__ import annotations

import argparse
import csv
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_INPUT = Path("KAPAL YG TERDETEKSI/scene_candidates_godark_spoofing_transshipment.csv")
DEFAULT_OUTPUT = Path("KAPAL YG TERDETEKSI/scene_candidates_summary.csv")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Candidate CSV generated by find-scene-candidates.py.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Summary CSV path.")
    parser.add_argument("--candidate-column", default="candidate_type", help="Column containing candidate labels.")
    return parser.parse_args()


def read_candidate_counts(path: Path, candidate_column: str) -> tuple[Counter[str], int]:
    if not path.exists():
        raise FileNotFoundError(f"Candidate CSV not found: {path}")

    counts: Counter[str] = Counter()
    total = 0
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError(f"Candidate CSV has no header: {path}")
        if candidate_column not in reader.fieldnames:
            columns = ", ".join(reader.fieldnames)
            raise ValueError(f"Column '{candidate_column}' not found in {path}. Available columns: {columns}")

        for row in reader:
            label = str(row.get(candidate_column, "")).strip()
            if not label:
                label = "(blank)"
            counts[label] += 1
            total += 1
    return counts, total


def write_summary(path: Path, counts: Counter[str], total: int, source: Path, candidate_column: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for label, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        percentage = (count / total * 100.0) if total else 0.0
        rows.append(
            {
                "candidate_type": label,
                "count": str(count),
                "percentage": f"{percentage:.2f}",
                "total_candidates": str(total),
                "candidate_column": candidate_column,
                "source_file": str(source),
                "generated_at_utc": generated_at,
            }
        )

    if not rows:
        rows.append(
            {
                "candidate_type": "(none)",
                "count": "0",
                "percentage": "0.00",
                "total_candidates": "0",
                "candidate_column": candidate_column,
                "source_file": str(source),
                "generated_at_utc": generated_at,
            }
        )

    fieldnames = [
        "candidate_type",
        "count",
        "percentage",
        "total_candidates",
        "candidate_column",
        "source_file",
        "generated_at_utc",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def print_summary(counts: Counter[str], total: int, output: Path) -> None:
    print(f"Total candidates: {total}")
    if not counts:
        print("No candidates found.")
    else:
        for label, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
            percentage = (count / total * 100.0) if total else 0.0
            print(f"{label}: {count} ({percentage:.2f}%)")
    print(f"Summary CSV: {output}")


def main() -> None:
    args = parse_args()
    counts, total = read_candidate_counts(args.input, args.candidate_column)
    write_summary(args.output, counts, total, args.input, args.candidate_column)
    print_summary(counts, total, args.output)


if __name__ == "__main__":
    main()
````

# LAMPIRAN D
# LISTING PROGRAM VISUALISASI DASHBOARD INTEGRASI AIS-SAR

### Listing Program D.1 Kode Inisialisasi Peta dan Layer Dashboard
Sumber file: `index.html`
````html
const map = L.map('map', { zoomControl:false }).setView([-2.5, 117.0], 5);
L.control.zoom({ position:'bottomright' }).addTo(map);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', {
  attribution:'&copy; <a href="https://www.esri.com">Esri</a>, GEBCO, NOAA',
  maxZoom:19,
}).addTo(map);

// â”€â”€ STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ships          = {};
let   gfwEvents      = [];
let   gfwRangeLabel  = 'â€”';
const trajLayer        = L.layerGroup().addTo(map);
const sidebarTrajLayer = L.layerGroup().addTo(map);
const historyLayer     = L.layerGroup().addTo(map);
const localKalmanLayer = L.layerGroup().addTo(map);
````

### Listing Program D.2 Kode Pembacaan Data Integrasi AIS-SAR pada Dashboard
Sumber file: `index.html`
````html
const INTEGRATION_DATA_FILES = {
  finalModel: 'KAPAL YG TERDETEKSI/FINAL_4_PIPELINE_MODELS.h5',
  godarkH5: 'KAPAL YG TERDETEKSI/godark_h5_predictions_by_scene.csv',
  candidates: 'KAPAL YG TERDETEKSI/scene_candidates_godark_spoofing_transshipment.csv',
  summary: 'KAPAL YG TERDETEKSI/scene_candidates_summary.csv',
  sarManifest: 'KAPAL YG TERDETEKSI/SAR_SCENE_GALLERY_ALL/manifest.csv',
  localKalman: 'data/local_kalman_trajectories.json',
  trajectory: 'new/metadata/ais_trajectory_points_raw_vs_kalman.csv',
  enrichedTrajectory: 'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/trajectory_outputs_25seq_windows_reference_style/trajectory_points_raw_vs_kalman.csv',
  example25: 'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/trajectory_outputs_25seq_windows_reference_style/ais_kalman_25seq_per_mmsi.csv',
  extraTrajectoryCsvs: [
    'new/metadata/ais_trajectory_points_kalman.csv',
    'KAPAL YG TERDETEKSI/SENTINEL1_SCENE_MAPS/S1A_IW_GRDH_1SDV_20260215T104128_20260215T104157_063228_07F03A_350C_vv_scene_trajectories.csv',
    'KAPAL YG TERDETEKSI/SENTINEL1_SCENE_MAPS/S1A_IW_GRDH_1SDV_20260307T111544_20260307T111609_063520_07FB52_A93E_vv_scene_trajectories.csv',
    'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/drifting_longlines.csv',
    'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/fixed_gear.csv',
    'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/purse_seines.csv',
    'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/trawlers.csv',
  ],
  trajectoryGeojsons: [
    'new/metadata/ais_trajectories_raw.geojson',
    'new/metadata/ais_trajectories_kalman.geojson',
    'new/metadata/ais_trajectories_raw_vs_kalman.geojson',
  ],
  trajectoryGalleries: [
    'DATASET_TEST_ENRICHED/Dataset_Test_Enriched_EEZ_Indonesia/trajectory_outputs_25seq_windows_reference_style/trajectory_gallery.html',
    'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/trajectory_outputs_25seq_windows_reference_style/trajectory_gallery.html',
  ],
  example25Png: 'Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/trajectory_outputs_25seq_windows_reference_style/images/residual_drifting_longlines_mmsi-416006701_start-1771344621_end-1771438528_idx-35.png',
  example25Mmsi: '416006701',
  example25Start: 1771344621,
  example25End: 1771438528,
  kalman: [
    'new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv',
    'new/metadata/metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_ais_latlon_formula_filled_kalman_estimated.csv',
  ],
};

// â”€â”€ COLORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function ensureIntegrationRows() {
  if (integrationRowsLoaded) return;
  if (!integrationLoadPromise) {
    integrationLoadPromise = (async () => {
      const candidatePromise = loadCsvRows(INTEGRATION_DATA_FILES.candidates);
      const godarkH5Promise = loadCsvRows(INTEGRATION_DATA_FILES.godarkH5);
      const summaryPromise = loadCsvRows(INTEGRATION_DATA_FILES.summary);
      const sarManifestPromise = loadCsvRows(INTEGRATION_DATA_FILES.sarManifest);
      const localKalmanPromise = loadJsonData(INTEGRATION_DATA_FILES.localKalman);
      const trajectoryPromise = loadCsvRows(INTEGRATION_DATA_FILES.trajectory);
      const enrichedTrajectoryPromise = loadCsvRows(INTEGRATION_DATA_FILES.enrichedTrajectory);
      const examplePromise = loadCsvRows(INTEGRATION_DATA_FILES.example25);
      const extraTrajectoryPromise = Promise.all(
        INTEGRATION_DATA_FILES.extraTrajectoryCsvs.map(path => loadCsvRows(path))
      );
      const trajectoryGeojsonPromise = Promise.all(
        INTEGRATION_DATA_FILES.trajectoryGeojsons.map(path => loadJsonData(path))
      );
      const trajectoryImagesPromise = Promise.all(
        INTEGRATION_DATA_FILES.trajectoryGalleries.map(path => loadTrajectoryImageRows(path))
      );
      const kalmanPromises = INTEGRATION_DATA_FILES.kalman.map(path => loadCsvRows(path));
      const [candidates, godarkH5Rows, summaryRows, sarManifestRows, localKalmanJson, trajectoryRows, enrichedRows, exampleRows, extraTrajectoryRows, trajectoryGeojsons, trajectoryImages, ...kalmanSets] =
        await Promise.all([candidatePromise, godarkH5Promise, summaryPromise, sarManifestPromise, localKalmanPromise, trajectoryPromise, enrichedTrajectoryPromise, examplePromise, extraTrajectoryPromise, trajectoryGeojsonPromise, trajectoryImagesPromise, ...kalmanPromises]);
      integrationRuleCandidates = candidates || [];
      integrationGodarkH5Rows = godarkH5Rows || [];
      if (localKalmanJson) localKalmanData = localKalmanJson;
      integrationExistingVesselRows = flattenExistingVesselRows(localKalmanData);
      integrationCandidates = buildMatchedFinalDetectionRows(integrationRuleCandidates, integrationGodarkH5Rows, integrationExistingVesselRows);
      aiResults = integrationCandidates.map(candidateToAiResult);
      aiInferenceMessage = `${aiResults.length} kapal hasil matching MMSI+scene dari output final lokal.`;
      integrationSummaryRows = summaryRows || [];
      integrationSarManifestRows = sarManifestRows || [];
      integrationTrajectoryRows = trajectoryRows || [];
      integrationExample25Rows = exampleRows || [];
      integrationExtraTrajectoryRows = (extraTrajectoryRows || []).flat();
      integrationTrajectoryGeojsons = (trajectoryGeojsons || []).filter(Boolean);
      integrationExampleRows = (enrichedRows && enrichedRows.length) ? enrichedRows : (exampleRows || []);
      integrationTrajectoryImages = dedupeTrajectoryImages((trajectoryImages || []).flat());
      integrationKalmanRows = kalmanSets.flat();
      logExampleDatasetColumns();
      integrationRowsLoaded = true;
    })();
````

### Listing Program D.3 Kode Pembentukan Marker Kandidat Aktivitas Kapal pada Peta
Sumber file: `index.html`
````html
function renderIntegrationCandidateMarkers() {
  const bounds = [];
  if (mode === 'ai') return bounds;
  if (!SHOW_DETECTION_POINTS) return bounds;
  if (!integrationRowsLoaded || !integrationCandidates.length) return bounds;
  const seen = new Set();
  for (const row of integrationCandidates) {
    const lat = Number(row.Center_latitude);
    const lon = Number(row.Center_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${row.scene}|${row.MMSI}|${row.candidate_type}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = candidateColor(row.candidate_type);
    bounds.push([lat, lon]);
    const vessel = {
      mmsi: row.MMSI,
      name: row.Name,
      category: row.Ship_Type || row.gfw_shiptype,
      sar: { lat, lon },
      ais: { lat: row.AIS_Latitude, lon: row.AIS_Longitude },
      detection: row.candidate_type,
      rawRow: row,
    };
    const icon = L.divIcon({
      className: '',
      html: `<div class="detection-marker"><div class="detection-marker-dot" style="background:${c}"></div></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    L.marker([lat, lon], { icon })
      .on('click', () => openIntegratedSarDetail(row.scene, vessel))
      .addTo(localKalmanLayer);
  }
  return bounds;
}

async function openIntegratedSarDetail(sceneName, vessel = {}) {
  closeToolPanel();
  sidebarKey = null;
  trajActive = false;
  sidebarTrajLayer.clearLayers();
  historyLayer.clearLayers();
  clearSidebarTelegramAlert('Memuat data kapal...');
````

### Listing Program D.4 Kode Panel Detail Kapal pada Dashboard
Sumber file: `index.html`
````html
function renderIntegrationPanel(sceneName, vessel, candidate, kalman) {
  const mmsi = pick(candidate, ['MMSI'], pick(kalman, ['MMSI'], vessel?.mmsi || ''));
  const title = pick(candidate, ['Name', 'gfw_name'], pick(kalman, ['Name', 'gfw_name'], vessel?.name || `MMSI: ${mmsi || '-'}`));
  const shipType = pick(candidate, ['Ship_Type', 'gfw_shiptype'], pick(kalman, ['Ship_Type', 'gfw_shiptype'], vessel?.category || vessel?.gear || ''));
  const sceneTime = pick(candidate, ['scene_time_utc'], pick(kalman, ['kalman_scene_timestamp_utc', 'sog_cog_scene_timestamp_utc', 'AIS_update_datetime'], ''));
  const candidateType = pick(candidate, ['candidate_type'], '');
  const candidateLabel = detectionTypesLabel(candidate) || candidateType;
  const detectedTypes = detectionTypesFor(candidate);
  const scoreText = detectionTypesFor(candidate)
    .map(type => `${displayCandidateType(type)} ${Math.round(candidateTypeScore(candidate, type) * 100)}%`)
    .join(' | ') || pick(candidate, ['score'], '');
  const scoreNumbers = detectedTypes.map(type => candidateTypeScore(candidate, type)).filter(Number.isFinite);
  const alertScore = scoreNumbers.length ? Math.max(...scoreNumbers) : detectionScore(candidate);
  const badge = candidateLabel || 'integrasi';
  const modelSource = pick(candidate, ['model_source'], INTEGRATION_DATA_FILES.finalModel);

  const aisLat = pickCoord(candidate, ['AIS_Latitude'], pickCoord(kalman, ['AIS_Latitude'], vessel?.ais?.lat));
  const aisLon = pickCoord(candidate, ['AIS_Longitude'], pickCoord(kalman, ['AIS_Longitude'], vessel?.ais?.lon));
  const sarLat = pickCoord(candidate, ['Center_latitude'], pickCoord(kalman, ['Center_latitude'], vessel?.sar?.lat));
  const sarLon = pickCoord(candidate, ['Center_longitude'], pickCoord(kalman, ['Center_longitude'], vessel?.sar?.lon));
  const kalLat = pickCoord(kalman, ['kalman_est_lat'], pickCoord(candidate, ['kalman_est_lat'], vessel?.kalman?.lat));
  const kalLon = pickCoord(kalman, ['kalman_est_lon'], pickCoord(candidate, ['kalman_est_lon'], vessel?.kalman?.lon));
  const focusLat = Number(sarLat || kalLat || aisLat);
  const focusLon = Number(sarLon || kalLon || aisLon);
  sidebarFocusLatLng = Number.isFinite(focusLat) && Number.isFinite(focusLon) ? [focusLat, focusLon] : null;

  document.getElementById('sidebar-title').textContent = title || 'Detail Kapal';
  document.getElementById('sidebar-sub').textContent = sceneName ? `Scene: ${sceneName}` : 'Integrasi AIS-SAR';

  // Panel ini menampilkan hasil integrasi AIS-SAR, status kandidat, dan trajectory yang cocok.
  document.getElementById('sidebar-body').innerHTML = `
    <div class="sb-section">
      <div class="sb-section-title">
        INTEGRASI AIS-SAR
        <span class="sb-section-badge" style="background:#4493f822;color:#4493f8;border:1px solid #4493f844">${esc(badge)}</span>
      </div>
      ${rowHtml('MMSI', displayValue(mmsi), true)}
      ${rowHtml('Jenis kapal', displayValue(shipType))}
      ${rowHtml('Sumber model', displayValue(modelSource))}
      ${rowHtml('Waktu pengamatan', displayValue(sceneTime))}
    </div>
    <div class="sb-section">
      <div class="sb-section-title">POSISI AIS DAN SAR</div>
      ${rowHtml('Latitude AIS', displayValue(aisLat), true)}
      ${rowHtml('Longitude AIS', displayValue(aisLon), true)}
      ${rowHtml('Latitude SAR', displayValue(sarLat), true)}
      ${rowHtml('Longitude SAR', displayValue(sarLon), true)}
      ${rowHtml('Latitude Kalman', displayValue(kalLat), true)}
      ${rowHtml('Longitude Kalman', displayValue(kalLon), true)}
    </div>
    <div class="sb-section">
      <div class="sb-section-title">GERAK DAN MATCHING</div>
      ${rowHtml('SOG', displayValue(pick(candidate, ['Sog'], pick(kalman, ['Sog', 'kalman_est_sog'], '')), 'kn'))}
      ${rowHtml('COG', displayValue(pick(candidate, ['Cog'], pick(kalman, ['Cog', 'kalman_est_cog'], '')), 'deg'))}
      ${rowHtml('Jarak SAR-AIS', displayValue(pick(candidate, ['sar_ais_distance_km'], ''), 'km'))}
      ${rowHtml('Jarak target SAR ke estimasi Kalman', displayValue(pick(candidate, ['sar_kalman_est_distance_km'], ''), 'km'))}
      ${rowHtml('Selisih waktu AIS-SAR', displayValue(pick(candidate, ['AIS_update_time_gap_hours', 'ais_position_time_gap_hours'], pick(kalman, ['AIS_update_time_gap_hours', 'ais_position_time_gap_hours'], '')), 'jam'))}
      ${rowHtml('Residual Kalman', displayValue(pick(candidate, ['kalman_pred_residual_m'], pick(kalman, ['kalman_pred_residual_m'], '')), 'm'))}
    </div>
    <div class="sb-section">
      <div class="sb-section-title">KANDIDAT AKTIVITAS</div>
      ${rowHtml('Deteksi', displayValue(candidateLabel))}
      ${rowHtml('Score', displayValue(scoreText))}
      ${rowHtml('rule', displayValue(pick(candidate, ['rule'], '')))}
      ${rowHtml('evidence', displayValue(pick(candidate, ['evidence'], '')))}
    </div>
    <div class="sb-section">
      <div class="sb-section-title">REKAP KANDIDAT</div>
      ${summaryForCandidate(candidate)}
    </div>
    <div class="sb-section">
      <div class="sb-section-title">Patch VV / VH</div>
      ${renderVvVhPatchItems(candidate, sceneName)}
    </div>
    <div class="sb-section">
      <div class="sb-section-title">Trajectory AIS (25 Sequence)</div>
      ${enrichedTrajectoryHtml(mmsi, candidate)}
    </div>`;

  configureSidebarTelegramAlert({
    alertType: candidateLabel,
    mmsi,
    vesselName: title,
    score: alertScore,
    scoreText,
    scene: sceneName,
    lat: focusLat,
    lon: focusLon,
    time: sceneTime,
  });
}
````

### Listing Program D.5 Kode Penampilan Patch VV/VH pada Panel Kanan
Sumber file: `index.html`
````html
function vvVhPatchItems(candidate, sceneName) {
  const items = [];
  const seen = new Set();
  const add = (label, src) => {
    if (!src) return;
    const clean = String(src).trim().replace(/\\/g, '/');
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    items.push({ label, src: clean });
  };
  const localPatchPath = (field, value) => {
    if (!value) return '';
    const clean = String(value).trim();
    if (clean.includes('/') || clean.includes('\\')) return clean;
    return field.includes('uint8') ? `new/Patch_Uint8/${clean}` : `new/Patch_RGB/${clean}`;
  };

  const manifest = findSarManifestRow(candidate, sceneName);
  if (manifest) {
    add('Patch VV', manifest.vv_patch_path);
    add('Patch VH', manifest.vh_patch_path);
  }
  add('Patch VV', localPatchPath('patch_rgb_vv_actual_file', candidate?.patch_rgb_vv_actual_file));
  add('Patch VH', localPatchPath('patch_rgb_vh_actual_file', candidate?.patch_rgb_vh_actual_file));
  add('Patch VV', localPatchPath('patch_uint8_vv_actual_file', candidate?.patch_uint8_vv_actual_file));
  add('Patch VH', localPatchPath('patch_uint8_vh_actual_file', candidate?.patch_uint8_vh_actual_file));
  return items.slice(0, 2);
}

function renderVvVhPatchItems(candidate, sceneName) {
  const items = vvVhPatchItems(candidate, sceneName);
  if (!items.length) return '<div class="sb-note">Patch VV/VH belum tersedia untuk kapal ini.</div>';
  return renderImageItems(items);
}

function renderImageItems(items) {
  if (!items.length) return '<div class="sb-note">Patch SAR atau gambar scene tidak tersedia.</div>';
  return items.map(item => `
````

### Listing Program D.6 Kode Penampilan Trajectory AIS 25 Sequence pada Panel Kanan
Sumber file: `index.html`
````html
function enrichedTrajectoryHtml(mmsi, candidate) {
  const image = selectedTrajectoryImage(mmsi, candidate);
  const enriched = selectedEnrichedTrajectoryRows(mmsi, candidate, PANEL_TRAJECTORY_SEQUENCE_LIMIT);
  const allRows = allTrajectoryRowsForMmsi(mmsi, candidate?.scene || '', candidate);
  const rows = allRows.slice(0, PANEL_TRAJECTORY_SEQUENCE_LIMIT);
  const { raw, kalman } = rows.length ? trajectoryRowsStats(rows) : { raw: [], kalman: [] };
  if (!image && !raw.length && !kalman.length) return trajectoryDatasetImageHtml(null, mmsi);

  const startTime = rows.length ? pick(rows[0], ['time_iso', 'timestamp'], '') : '';
  const endTime = rows.length ? pick(rows[rows.length - 1], ['time_iso', 'timestamp'], '') : '';
  const windowText = rows.length ? `${rows.length} dari ${allRows.length} titik gabungan` : '';
  const anchorIso = Number.isFinite(enriched.anchorSeconds)
    ? new Date(enriched.anchorSeconds * 1000).toISOString().replace('.000Z', 'Z')
    : '';
  const visual = image
    ? trajectoryDatasetImageHtml(image, mmsi)
    : trajectoryStatsHasLine({ raw, kalman })
      ? `${miniTrajectoryChart(rows)}<div class="sb-note">Visual dibuat dari semua data trajectory yang cocok dengan MMSI kapal ini.</div>`
      : `<div class="sb-note">trajectory tidak tersedia karena data hanya satu titik.</div>`;
  const source = 'gabungan CSV/JSON/GeoJSON trajectory';

  return `
    ${visual}
    ${rowHtml('MMSI trajectory', displayValue(mmsi), true)}
    ${rowHtml('Sumber data', displayValue(source))}
    ${image ? rowHtml('File gambar', displayValue(image.fileName)) : ''}
    ${windowText ? rowHtml('Window titik', displayValue(windowText)) : ''}
    ${rows.length ? rowHtml('Titik AIS raw', displayValue(raw.length)) : ''}
    ${rows.length ? rowHtml('Titik Kalman', displayValue(kalman.length)) : ''}
    ${startTime ? rowHtml('Waktu awal', displayValue(startTime)) : ''}
    ${endTime ? rowHtml('Waktu akhir', displayValue(endTime)) : ''}
    ${anchorIso ? rowHtml('Waktu scene', displayValue(anchorIso)) : ''}
    <div class="sb-note">Trajectory dipilih berdasarkan MMSI kapal yang diklik. Tidak ada fallback ke kapal lain.</div>`;
}

function exampleComparisonHtml() {
  const { mmsi, rows, imageSrc } = exampleRowsForPanel();
  if (!rows.length) {
    return '<div class="sb-note">Contoh 25 titik dari Dataset_Test_Enriched tidak tersedia atau file belum dapat dibaca.</div>';
  }
  const corrections = rows.map(row => Number(row.kalman_correction_m)).filter(Number.isFinite);
````

### Listing Program D.7 Kode Penampilan Trajectory AIS Mentah dan Kalman pada Peta
Sumber file: `index.html`
````html
function plotIntegratedTrajectory(sceneName, mmsi, fit = true, contextRow = null) {
  sidebarTrajLayer.clearLayers();
  const info = document.getElementById('sb-traj-info');
  const context = contextRow || bestCandidateForMmsi(mmsi);

  const trajectory = selectedMapTrajectoryStats(sceneName, mmsi, context);
  const rows = trajectory.rows;
  const raw = trajectory.raw;
  const kalman = trajectory.kalman;
  const all = [...raw, ...kalman];
  console.info('[trajectory lookup]', {
    mmsi: normId(mmsi),
    source: trajectory.source,
    rows: rows.length,
    raw_points: raw.length,
    kalman_points: kalman.length,
  });
  if (!rows.length || !all.length) {
    if (info) info.textContent = 'Trajectory belum tersedia untuk kapal ini.';
    return false;
  }

  if (raw.length >= 2) L.polyline(raw, { color:'#ff2d2d', weight:2.6, opacity:.9, dashArray:'7 6' }).addTo(sidebarTrajLayer);
  if (kalman.length >= 2) L.polyline(kalman, { color:'#0b63d8', weight:3.4, opacity:.95 }).addTo(sidebarTrajLayer);

  const addEnds = (points, color, label) => {
    if (points.length < 2) return;
    L.circleMarker(points[0], { radius:4, color, fillColor:color, fillOpacity:1 }).bindPopup(`${label} start`).addTo(sidebarTrajLayer);
    L.circleMarker(points[points.length - 1], { radius:4, color, fillColor:color, fillOpacity:1 }).bindPopup(`${label} end`).addTo(sidebarTrajLayer);
  };
  addEnds(raw, '#ff2d2d', 'AIS raw');
  addEnds(kalman, '#0b63d8', 'Kalman');

  if (raw.length < 2 && kalman.length < 2) {
    const rawPoint = raw[0];
    const kalmanPoint = kalman[0];
    if (rawPoint) L.circleMarker(rawPoint, { radius:6, color:'#ff2d2d', fillColor:'#ff2d2d', fillOpacity:.9 }).bindPopup('AIS raw: satu titik').addTo(sidebarTrajLayer);
    if (kalmanPoint) L.circleMarker(kalmanPoint, { radius:6, color:'#0b63d8', fillColor:'#0b63d8', fillOpacity:.9 }).bindPopup('Kalman: satu titik').addTo(sidebarTrajLayer);
    if (info) info.textContent = `trajectory tidak tersedia karena data hanya satu titik. Ditemukan AIS raw ${raw.length} titik | Kalman ${kalman.length} titik.`;
    if (fit && all.length) map.setView(all[0], Math.max(map.getZoom(), 11), { animate: true });
    return true;
  }
  if (info) info.textContent = `Trajectory (${trajectory.source}): AIS raw ${raw.length} titik | Kalman ${kalman.length} titik`;
  if (fit && all.length) map.fitBounds(L.latLngBounds(all), { padding:[60, 60], maxZoom:12 });
  return true;
}

function candidateColor(type) {
  switch (primaryDetectionType(type)) {
    case 'godark': return '#e3901a';
    case 'spoofing': return '#f85149';
    case 'transshipment': return '#a371f7';
    default: return '#8b949e';
  }
}

function bestCandidateForMmsi(mmsi) {
  const id = normId(mmsi);
  if (!id) return null;
  return integrationCandidates
    .filter(row => normId(row.MMSI || row.mmsi) === id)
    .sort((a, b) => rowScore(b) - rowScore(a))[0] || null;
}

function renderEnriched121SeqTrajectories() {
  return [];
````

### Listing Program D.8 Kode Legend dan Keterangan Simbol Dashboard
Sumber file: `index.html`
````html
function updateLegend(m) {
  const el = document.getElementById('legend-content');
  if (!el) return;
  if (m === 'ai') {
    el.innerHTML = `
      <span class="leg-title">Gear Type (AI)</span>
      <div class="leg-row"><span class="leg-dot" style="background:#4493f8"></span><span class="leg-label">Drifting Longline</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#d29922"></span><span class="leg-label">Set Longline</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#a371f7"></span><span class="leg-label">Gillnet</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#e3901a"></span><span class="leg-label">Trawler</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#3fb950"></span><span class="leg-label">Troller / Fishing</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#f85149;border:2px solid #f85149"></span><span class="leg-label">âš  Spoofing / Go Dark</span></div>`;
  } else if (m === 'ais') {
    el.innerHTML = `
      <span class="leg-title">Kecepatan</span>
      <div class="leg-row"><span class="leg-dot" style="background:#f85149"></span><span class="leg-label">Berhenti &lt;1 kn</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#e3901a"></span><span class="leg-label">Lambat 1â€“5 kn</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#4493f8"></span><span class="leg-label">Normal 5â€“12 kn</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:#3fb950"></span><span class="leg-label">Cepat &gt;12 kn</span></div>`;
  } else {
    el.innerHTML = `
      <span class="leg-title">Tipe Event</span>
      <div class="leg-row"><span class="leg-dot" style="background:var(--green)"></span><span class="leg-label">Fishing</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:var(--orange)"></span><span class="leg-label">Encounter</span></div>
      <div class="leg-row"><span class="leg-dot" style="background:var(--yellow)"></span><span class="leg-label">Loitering</span></div>`;
  }
  appendLocalKalmanLegend();
}

function appendLocalKalmanLegend() {
  const el = document.getElementById('legend-content');
  if (!el || !localKalmanVisible) return;
  const detectionLegend = SHOW_DETECTION_POINTS ? `
    <div class="leg-row"><span class="leg-dot" style="background:#e3901a;border:2px solid #f85149"></span><span class="leg-label">Go dark candidate</span></div>
    <div class="leg-row"><span class="leg-dot" style="background:#f85149;border:2px solid #f85149"></span><span class="leg-label">Spoofing candidate</span></div>` : '';
  const sarTargetLegend = SHOW_SAR_TARGET_POINTS ? `
    <div class="leg-row"><span class="leg-dot" style="background:transparent;border:2px solid #ff2d2d"></span><span class="leg-label">SAR target</span></div>` : '';
  el.insertAdjacentHTML('beforeend', `
    <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px"></div>
    <span class="leg-title">Final Model + 121-Seq Trajectory</span>
    ${detectionLegend}
    ${sarTargetLegend}
    <div class="leg-row"><span style="width:26px;border-top:3px dashed #ff2d2d;display:inline-block"></span><span class="leg-label">AIS raw</span></div>
    <div class="leg-row"><span style="width:26px;border-top:3px solid #0b63d8;display:inline-block"></span><span class="leg-label">Kalman</span></div>`);
}

function toggleLegend(force) {
  const legend = document.getElementById('legend');
  if (!legend) return;
  if (typeof force === 'boolean') legend.classList.toggle('open', force);
  else legend.classList.toggle('open');
````

# LAMPIRAN E
# LISTING PROGRAM PENGIRIMAN ALERT TELEGRAM

### Listing Program E.1 Kode Konfigurasi Token dan Chat ID Telegram
Sumber file: `api/telegram/_client.js`
````js
import fs from "node:fs";
import path from "node:path";

const ENV_FILES = [".env", ".env.local", ".env.lokal"];

function loadLocalEnv() {
  for (const fileName of ENV_FILES) {
    const filePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = value;
    }
  }
}

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

export function telegramConfig() {
  loadLocalEnv();
  const token = firstEnv([
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_TOKEN",
    "BOT_TOKEN",
    "TG_BOT_TOKEN",
  ]);
  const chatId = firstEnv([
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_CHATID",
    "TG_CHAT_ID",
    "CHAT_ID",
  ]);
  return {
    token,
    chatId,
    missing: [
      token ? "" : "TELEGRAM_BOT_TOKEN",
      chatId ? "" : "TELEGRAM_CHAT_ID",
    ].filter(Boolean),
  };
}

export async function sendTelegramMessage(text) {
  const config = telegramConfig();
  if (config.missing.length) {
    const readable = config.missing.join(", ");
    throw new Error(`Telegram env belum lengkap: ${readable}`);
  }

  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram sendMessage failed: HTTP ${response.status}`);
  }
  return payload.result;
}
````

### Listing Program E.2 Kode Pengujian Koneksi Bot Telegram
Sumber file: `api/telegram/test.js`
````js
import { applyRateLimit } from "../_rate-limit.js";
import { sendTelegramMessage, telegramConfig } from "./_client.js";

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "telegram-test",
    limit: 10,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  if (!["GET", "POST"].includes(req.method || "GET")) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const config = telegramConfig();
  if (config.missing.length) {
    return res.status(500).json({
      ok: false,
      error: "Telegram env belum lengkap",
      missing: config.missing,
      expected: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
    });
  }

  try {
    const result = await sendTelegramMessage([
      "TEST ALERT Ocean Nexus",
      "Bot Telegram berhasil tersambung ke dashboard.",
      `Waktu: ${new Date().toISOString()}`,
    ].join("\n"));

    return res.json({
      ok: true,
      message: "Pesan test Telegram berhasil dikirim.",
      telegram_message_id: result?.message_id,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err?.message || "Gagal mengirim Telegram test.",
    });
  }
}
````

### Listing Program E.3 Kode Pengiriman Pesan Alert ke Telegram
Sumber file: `api/telegram/alert.js`
````js
export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "telegram-alert",
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  if ((req.method || "GET") !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const config = telegramConfig();
  if (config.missing.length) {
    return res.status(500).json({
      ok: false,
      error: "Telegram env belum lengkap",
      missing: config.missing,
      expected: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
    });
  }

  try {
    const result = await sendTelegramMessage(formatAlert(req.body || {}));
    return res.json({
      ok: true,
      message: "Alert Telegram berhasil dikirim.",
      telegram_message_id: result?.message_id,
    });
````

### Listing Program E.4 Kode Format Pesan Alert Telegram
Sumber file: `api/telegram/alert.js`
````js
import { applyRateLimit } from "../_rate-limit.js";
import { sendTelegramMessage, telegramConfig } from "./_client.js";

function clean(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function formatScore(body = {}) {
  const scoreText = clean(body.scoreText || body.score_text, "");
  if (scoreText) return scoreText;
  const raw = body.score;
  if (raw == null || raw === "") return "-";
  const text = String(raw).trim();
  if (!text) return "-";
  if (text.includes("%") || Number.isNaN(Number(text))) return text;
  const number = Number(text);
  const percent = number <= 1 ? number * 100 : number;
  return `${Math.round(percent)}%`;
}

function formatAlertTime(value) {
  const raw = clean(value, new Date().toISOString());
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (isoMatch) {
    const [, year, month, day, hour, minute, second = "00"] = isoMatch;
    return `${Number(day)}/${Number(month)}/${year}, ${hour.padStart(2, "0")}:${minute}:${second.padStart(2, "0")}`;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatAlert(body = {}) {
  const alertType = clean(body.alertType || body.alert_type || body.type, "ALERT");
  const mmsi = clean(body.mmsi || body.MMSI);
  const vesselName = clean(body.vesselName || body.name || body.Name, "Unknown vessel");
  const score = formatScore(body);
  const lat = clean(body.lat || body.latitude || body.Center_latitude);
  const lon = clean(body.lon || body.longitude || body.Center_longitude);
  const time = formatAlertTime(body.time || body.timestamp || body.scene_time_utc);

  return [
    `ALERT ${alertType}`,
    `MMSI: ${mmsi}`,
    `Nama kapal: ${vesselName}`,
    `Score: ${score}`,
    `Koordinat: ${lat}, ${lon}`,
    `Waktu: ${time}`,
  ].join("\n");
}
````

### Listing Program E.5 Kode Tombol Kirim Alert pada Panel Kanan Dashboard
Sumber file: `index.html`
````html
  <div id="sb-telegram-info"></div>
  <div id="sidebar-footer">
    <button class="sb-btn" id="sb-traj-btn" onclick="toggleTraj()">Tampilkan Trajectory</button>
    <button class="sb-btn telegram" id="sb-telegram-btn" onclick="sendSidebarTelegramAlert()" disabled>Kirim Alert</button>
    <button class="sb-btn" onclick="zoomTo()">Zoom ke Posisi</button>

function configureSidebarTelegramAlert(payload, unavailableMessage = 'Alert Telegram hanya aktif untuk kapal deteksi AI/SAR.') {
  const alertType = cleanAlertText(payload?.alertType || payload?.type);
  const mmsi = cleanAlertText(payload?.mmsi || payload?.MMSI);
  if (!alertType || !mmsi) {
    clearSidebarTelegramAlert(unavailableMessage);
    return;
  }

  sidebarTelegramPayload = {
    alertType,
    mmsi,
    vesselName: cleanAlertText(payload.vesselName || payload.name, 'Unknown vessel'),
    score: normalizedAlertScore(payload.score),
    scoreText: cleanAlertText(payload.scoreText),
    scene: cleanAlertText(payload.scene),
    lat: cleanAlertText(payload.lat),
    lon: cleanAlertText(payload.lon),
    time: cleanAlertText(payload.time, new Date().toISOString()),
  };
  setTelegramButton(true, 'Kirim Alert', 'ready');
  setTelegramInfo(`Siap kirim alert Telegram: ${alertType}.`);
}

async function sendSidebarTelegramAlert() {
  if (!sidebarTelegramPayload || sidebarTelegramSending) return;
  sidebarTelegramSending = true;
  setTelegramButton(false, 'Mengirim...', 'loading');
  setTelegramInfo('Mengirim alert ke Telegram...');

  try {
    const response = await fetch(apiUrl('/api/telegram/alert'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sidebarTelegramPayload),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || payload.detail || `HTTP ${response.status}`);
    }
    sidebarTelegramSending = false;
    setTelegramInfo(`Alert Telegram terkirim${payload.telegram_message_id ? ` (ID ${payload.telegram_message_id})` : ''}.`, 'ok');
    setTelegramButton(true, 'Kirim Lagi', 'sent');
  } catch (err) {
    sidebarTelegramSending = false;
    setTelegramInfo(`Gagal kirim Telegram: ${err.message || err}`, 'err');
    setTelegramButton(true, 'Coba Lagi', 'err');
````

# LAMPIRAN F
# LISTING PROGRAM KONFIGURASI APLIKASI DAN API DASHBOARD

### Listing Program F.1 Kode Konfigurasi Aplikasi Vite dan Middleware API Lokal
Sumber file: `vite.config.ts`
````ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  for (const fileName of [".env", ".env.local", ".env.lokal"]) {
    const envFile = path.join(__dirname, fileName);
    if (!fs.existsSync(envFile)) continue;
    for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

function resolveHandler(urlPath: string): string | null {
  const clean = urlPath.split("?")[0].replace(/\/$/, "");
  const candidates = [
    path.join(__dirname, clean + ".js"),
    path.join(__dirname, clean, "index.js"),
  ];
  return candidates.find(fs.existsSync) ?? null;
}

function vercelApiPlugin() {
  return {
    name: "local-vercel-api",
    configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
      loadDotEnv();

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith("/api/")) return next();

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

        const handlerPath = resolveHandler(req.url);
        if (!handlerPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "API route not found: " + req.url }));
        }

        const urlObj = new URL(req.url, "http://localhost");
        const query: Record<string, string> = {};
        urlObj.searchParams.forEach((v, k) => { query[k] = v; });

        let bodyText = "";
        if (req.method === "POST") {
          bodyText = await new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          });
        }

        const mockReq = {
          method: req.method,
          query,
          headers: req.headers,
          body: bodyText ? (() => { try { return JSON.parse(bodyText); } catch { return bodyText; } })() : {},
        };

        const mockRes = {
          _status: 200,
          status(code: number) { this._status = code; return this; },
          setHeader(name: string, value: string) { res.setHeader(name, value); return this; },
          json(data: unknown) {
            res.setHeader("Content-Type", "application/json");
            res.statusCode = this._status;
            res.end(JSON.stringify(data));
          },
          end(body = "") { res.statusCode = this._status; res.end(body); },
        };

        try {
          const handlerUrl = pathToFileURL(handlerPath);
          handlerUrl.search = `?v=${fs.statSync(handlerPath).mtimeMs}`;
          const mod = await import(handlerUrl.href);
          await (mod.default ?? mod)(mockReq, mockRes);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: msg }));
          }
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), tsConfigPaths(), vercelApiPlugin()],
});
````

### Listing Program F.2 Kode Konfigurasi Script Project Dashboard
Sumber file: `package.json`
````json
{
  "name": "samudra-aya-data",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tailwindcss/vite": "^4.2.1",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "tailwindcss": "^4.2.1",
    "vite-tsconfig-paths": "^6.0.2"
  },
  "devDependencies": {
    "@types/node": "^22.16.5",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.0.4",
    "typescript": "^5.8.3",
    "vite": "^7.3.1"
  }
}
````

### Listing Program F.3 Kode Konfigurasi Deployment Vercel
Sumber file: `vercel.json`
````json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
````

### Listing Program F.4 Kode Konfigurasi Cloudflare Worker
Sumber file: `wrangler.jsonc`
````jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "samudra-aya",
  "compatibility_date": "2025-09-24",
  "compatibility_flags": ["nodejs_compat"],
  "main": "src/server.ts",

  // â”€â”€ Secrets (set via: npx wrangler secret put GFW_TOKEN) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // GFW_TOKEN  â†’  Global Fishing Watch API token

  // â”€â”€ Preview environment (npx wrangler deploy --env preview) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  "env": {
    "preview": {
      "name": "samudra-aya-preview"
    }
  }
}
````

### Listing Program F.5 Kode Rate Limit API Dashboard
Sumber file: `api/_rate-limit.js`
````js
import { incrementWithTtl } from "./_redis.js";

function getHeader(req, name) {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function getClientIp(req) {
  const forwarded = getHeader(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    getHeader(req, "x-real-ip") ||
    getHeader(req, "cf-connecting-ip") ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function sanitizePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 120);
}

export async function applyRateLimit(req, res, { name, limit, windowSeconds }) {
  const ip = sanitizePart(getClientIp(req));
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rl:${sanitizePart(name)}:${ip}:${bucket}`;
  const count = await incrementWithTtl(key, windowSeconds + 5);
  const remaining = Math.max(0, limit - count);

  res.setHeader("x-ratelimit-limit", String(limit));
  res.setHeader("x-ratelimit-remaining", String(remaining));
  res.setHeader("x-ratelimit-window", String(windowSeconds));

  if (count <= limit) return true;

  res.setHeader("retry-after", String(windowSeconds));
  res.status(429).json({
    error: "Too many requests",
    retry_after_seconds: windowSeconds,
  });
  return false;
}
````

### Listing Program F.6 Kode Penyimpanan Cache API Menggunakan Redis atau Memori Lokal
Sumber file: `api/_redis.js`
````js
const REST_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  "";

const REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  "";

const localStore = new Map();

function now() {
  return Date.now();
}

function getLocal(key) {
  const entry = localStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= now()) {
    localStore.delete(key);
    return null;
  }
  return entry.value;
}

function setLocal(key, value, ttlSeconds) {
  localStore.set(key, {
    value,
    expiresAt: ttlSeconds > 0 ? now() + ttlSeconds * 1000 : 0,
  });
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

async function getCommand(commandName, ...args) {
  if (!REST_URL || !REST_TOKEN) return { configured: false, result: null };
  const encoded = [commandName, ...args].map((part) => encodeURIComponent(String(part))).join("/");

  const res = await fetch(`${normalizeUrl(REST_URL)}/${encoded}`, {
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
    },
    signal: AbortSignal.timeout(3000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Redis ${commandName} failed: ${res.status} ${text.slice(0, 160)}`);
  }

  const json = await res.json();
  return { configured: true, result: json?.result ?? null };
}

async function pipeline(commands) {
  if (!REST_URL || !REST_TOKEN) return { configured: false, result: null };

  const res = await fetch(`${normalizeUrl(REST_URL)}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(3000),
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Redis pipeline failed: ${res.status} ${text.slice(0, 160)}`);
  }

  const json = await res.json();
  return { configured: true, result: json?.result ?? null };
}

export function redisConfigured() {
  return Boolean(REST_URL && REST_TOKEN);
}

export async function cacheGet(key) {
  try {
    const { configured, result } = await getCommand("get", key);
    if (!configured) return getLocal(key);
    if (!result) return null;
    return JSON.parse(result);
  } catch (err) {
    console.warn(`[cache] Redis GET failed for ${key}:`, err?.message || err);
    return getLocal(key);
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  setLocal(key, value, ttlSeconds);
  try {
    const serialized = JSON.stringify(value);
    const { configured } = await pipeline([["SET", key, serialized, "EX", String(ttlSeconds)]]);
    return configured;
  } catch (err) {
    console.warn(`[cache] Redis SET failed for ${key}:`, err?.message || err);
    return false;
  }
}

export async function incrementWithTtl(key, ttlSeconds) {
  const local = getLocal(key);
  const nextLocal = Number(local || 0) + 1;
  setLocal(key, nextLocal, ttlSeconds);

  try {
    const incr = await getCommand("incr", key);
    if (!incr.configured) return nextLocal;
    const count = Number(incr.result || 0);
    if (count === 1) await getCommand("expire", key, String(ttlSeconds));
    return count;
  } catch (err) {
    console.warn(`[rate-limit] Redis INCR failed for ${key}:`, err?.message || err);
    return nextLocal;
  }
}
````

### Listing Program F.7 Kode Struktur Variabel Lingkungan
Sumber file: `.env.example`
````env
# Salin ke .env.local untuk local development
# cp .env.example .env.local
#
# Untuk production, set di Vercel Dashboard:
# Settings â†’ Environment Variables â†’ Add GFW_TOKEN

# Global Fishing Watch API token
# Dapatkan di: https://globalfishingwatch.org/our-apis/
GFW_TOKEN=your_gfw_token_here

# URL Inference Server (Hugging Face Spaces)
VITE_INFERENCE_URL=https://ngenss12-inferencegfw.hf.space

# Redis/KV cache + rate limit store.
# Supports Upstash Redis REST or Vercel KV-compatible REST variables.
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
````

