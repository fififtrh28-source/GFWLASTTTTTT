import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";
const GFW_TRACK_DATASET = "public-global-vessel-track:latest";

const DEFAULT_CANDIDATES = join(repoRoot, "KAPAL YG TERDETEKSI", "scene_candidates_godark_spoofing_transshipment.csv");
const DEFAULT_OUT_DIR = join(repoRoot, "KAPAL YG TERDETEKSI", "gfw_historical_tracks");

const TRACK_HEADERS = [
  "MMSI",
  "vessel_id",
  "timestamp",
  "latitude",
  "longitude",
  "speed",
  "course",
  "source",
  "fetch_status",
  "track_index",
  "raw_attributes_json",
];

const REPORT_HEADERS = [
  "MMSI",
  "vessel_id",
  "search_status",
  "track_status",
  "point_count",
  "first_track_time",
  "last_track_time",
  "error_message",
  "start_date",
  "end_date",
  "fetched_at_utc",
];

function parseArgs(argv) {
  const args = {
    candidates: DEFAULT_CANDIDATES,
    outDir: DEFAULT_OUT_DIR,
    startDate: "2026-02-01",
    endDate: "2026-03-14",
    limit: 0,
    mmsi: "",
    delayMs: 1000,
    timeoutMs: 60000,
    maxRetries: 4,
    searchLimit: 10,
    resume: true,
    retryFailed: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--help" || key === "-h") {
      printHelp();
      process.exit(0);
    }
    if (key === "--no-resume") {
      args.resume = false;
      continue;
    }
    if (key === "--retry-failed") {
      args.retryFailed = true;
      continue;
    }
    if (!key.startsWith("--")) throw new Error(`Unknown positional argument: ${key}`);
    if (next == null || next.startsWith("--")) throw new Error(`Missing value for ${key}`);
    i += 1;
    if (key === "--candidates") args.candidates = resolvePath(next);
    else if (key === "--out-dir") args.outDir = resolvePath(next);
    else if (key === "--start-date") args.startDate = next;
    else if (key === "--end-date") args.endDate = next;
    else if (key === "--limit") args.limit = Number(next);
    else if (key === "--mmsi") args.mmsi = next;
    else if (key === "--delay-ms") args.delayMs = Number(next);
    else if (key === "--timeout-ms") args.timeoutMs = Number(next);
    else if (key === "--max-retries") args.maxRetries = Number(next);
    else if (key === "--search-limit") args.searchLimit = Number(next);
    else throw new Error(`Unknown option: ${key}`);
  }

  for (const numeric of ["limit", "delayMs", "timeoutMs", "maxRetries", "searchLimit"]) {
    if (!Number.isFinite(args[numeric]) || args[numeric] < 0) {
      throw new Error(`Invalid numeric option ${numeric}: ${args[numeric]}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/fetch-gfw-historical-tracks.mjs [options]

Options:
  --candidates <path>   Candidate CSV source.
  --out-dir <path>      Output directory for new GFW historical track files.
  --start-date <date>   Track start date, default 2026-02-01.
  --end-date <date>     Track end date, default 2026-03-14.
  --limit <n>           Process only first n MMSI after de-duplication.
  --mmsi <list>         Comma-separated MMSI override for targeted tests.
  --delay-ms <n>        Delay between GFW requests, default 1000.
  --timeout-ms <n>      Per-request timeout, default 60000.
  --max-retries <n>     Retry count for 429/5xx/timeout, default 4.
  --search-limit <n>    GFW vessel search result limit, default 10.
  --no-resume           Ignore existing progress file.
  --retry-failed        Re-run failed terminal statuses from progress.
`);
}

function resolvePath(input) {
  return resolve(process.cwd(), input);
}

function loadEnvIfNeeded() {
  if (process.env.GFW_TOKEN) return;
  for (const name of [".env.lokal", ".env.local", ".env"]) {
    const envPath = join(repoRoot, name);
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const key = match[1];
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    if (process.env.GFW_TOKEN) return;
  }
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = "";
  let quote = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quote = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows.shift().map((h) => h.replace(/^\uFEFF/, "").trim());
  return {
    headers,
    rows: rows
      .filter((r) => r.some((v) => String(v || "").trim() !== ""))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
  };
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(headers, row) {
  return headers.map((h) => csvEscape(row[h])).join(",") + "\n";
}

function ensureCsv(path, headers) {
  if (!existsSync(path)) {
    writeFileSync(path, headers.join(",") + "\n", "utf8");
  }
}

function appendCsv(path, headers, rows) {
  if (!rows.length) return;
  ensureCsv(path, headers);
  appendFileSync(path, rows.map((row) => csvLine(headers, row)).join(""), "utf8");
}

function normalizeMmsi(value) {
  return String(value ?? "").trim().replace(/\.0$/, "");
}

function uniqueCandidateMmsi(path) {
  if (!existsSync(path)) throw new Error(`Candidate CSV not found: ${path}`);
  const parsed = parseCsv(readFileSync(path, "utf8"));
  if (!parsed.headers.includes("MMSI")) throw new Error(`Candidate CSV has no MMSI column: ${path}`);
  const seen = new Set();
  const out = [];
  for (const row of parsed.rows) {
    const mmsi = normalizeMmsi(row.MMSI);
    if (!mmsi || seen.has(mmsi)) continue;
    seen.add(mmsi);
    out.push(mmsi);
  }
  return out;
}

function progressPath(args) {
  return join(args.outDir, `gfw_historical_track_progress_${args.startDate}_${args.endDate}.json`);
}

function outputPaths(args) {
  return {
    tracks: join(args.outDir, `gfw_historical_tracks_${args.startDate}_${args.endDate}.csv`),
    report: join(args.outDir, `gfw_historical_track_report_${args.startDate}_${args.endDate}.csv`),
    progress: progressPath(args),
    summary: join(args.outDir, `gfw_historical_track_summary_${args.startDate}_${args.endDate}.json`),
  };
}

function loadProgress(args) {
  const path = progressPath(args);
  if (!args.resume || !existsSync(path)) {
    return {
      started_at_utc: new Date().toISOString(),
      start_date: args.startDate,
      end_date: args.endDate,
      mmsi: {},
    };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed.mmsi || typeof parsed.mmsi !== "object") parsed.mmsi = {};
  return parsed;
}

function saveProgress(path, progress) {
  progress.updated_at_utc = new Date().toISOString();
  writeFileSync(path, JSON.stringify(progress, null, 2) + "\n", "utf8");
}

function terminalDone(report, retryFailed) {
  if (!report || !report.done) return false;
  if (!retryFailed) return true;
  return report.track_status === "track_success";
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function retryDelayMs(attempt, response) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  const base = Math.min(60000, 2000 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

async function requestJson(url, token, options) {
  let lastError = "";
  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
    try {
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (response.ok) {
        return { ok: true, status: response.status, json: await response.json() };
      }

      const body = await response.text().catch(() => "");
      lastError = `http_${response.status}${body ? `:${body.slice(0, 180)}` : ""}`;

      if ([401, 403, 404].includes(response.status)) {
        return { ok: false, status: response.status, error: lastError };
      }

      if ((response.status === 429 || response.status >= 500) && attempt <= options.maxRetries) {
        await sleep(retryDelayMs(attempt, response));
        continue;
      }

      return { ok: false, status: response.status, error: lastError };
    } catch (error) {
      lastError = error?.name === "TimeoutError" ? "timeout" : (error?.message || "request_failed");
      if (attempt <= options.maxRetries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return { ok: false, status: 0, error: lastError };
    }
  }
  return { ok: false, status: 0, error: lastError || "request_failed" };
}

function vesselCandidates(entry) {
  const out = [];
  const arrays = ["selfReportedInfo", "registryInfo"];
  for (const key of arrays) {
    const values = Array.isArray(entry?.[key]) ? entry[key] : [];
    for (const item of values) {
      out.push({
        vessel_id: item?.id || entry?.id || entry?.vesselId || "",
        mmsi: normalizeMmsi(item?.ssvid || item?.mmsi || item?.ssvids),
        raw: item,
      });
    }
  }
  out.push({
    vessel_id: entry?.id || entry?.vesselId || entry?.vessel_id || "",
    mmsi: normalizeMmsi(entry?.ssvid || entry?.mmsi),
    raw: entry,
  });
  return out.filter((item) => item.vessel_id || item.mmsi);
}

async function searchVesselId(mmsi, token, args) {
  const url = new URL(`${GFW_BASE}/vessels/search`);
  url.searchParams.set("query", mmsi);
  url.searchParams.set("limit", String(args.searchLimit));
  url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
  url.searchParams.set("includes[0]", "MATCH_CRITERIA");
  url.searchParams.set("includes[1]", "OWNERSHIP");

  const result = await requestJson(url, token, args);
  if (!result.ok) {
    return {
      vessel_id: "",
      search_status: `search_${result.error || `http_${result.status}`}`,
      error_message: result.error || "",
    };
  }

  const entries = result.json?.entries ?? result.json?.data ?? [];
  const exact = [];
  for (const entry of entries) {
    for (const item of vesselCandidates(entry)) {
      if (normalizeMmsi(item.mmsi) === mmsi && item.vessel_id) exact.push(item);
    }
  }

  if (!exact.length) {
    return {
      vessel_id: "",
      search_status: entries.length ? "vessel_not_found_exact_mmsi" : "vessel_not_found",
      error_message: entries.length ? "GFW search returned entries but no exact MMSI match." : "",
    };
  }

  return {
    vessel_id: exact[0].vessel_id,
    search_status: exact.length > 1 ? "resolved_exact_multiple" : "resolved_exact",
    error_message: "",
  };
}

async function fetchTrack(vesselId, token, args) {
  const url = new URL(`${GFW_BASE}/vessels/${encodeURIComponent(vesselId)}/tracks`);
  url.searchParams.set("datasets[0]", GFW_TRACK_DATASET);
  url.searchParams.set("start-date", args.startDate);
  url.searchParams.set("end-date", args.endDate);

  const result = await requestJson(url, token, args);
  if (!result.ok) {
    return {
      track_status: result.status === 404 ? "track_not_found" : `track_${result.error || `http_${result.status}`}`,
      points: [],
      error_message: result.error || "",
    };
  }

  const points = parseTrackPoints(result.json);
  return {
    track_status: points.length ? "track_success" : "track_empty",
    points,
    error_message: "",
  };
}

function parseTrackPoints(json) {
  const points = [];
  const coords = json?.geometry?.coordinates;
  const coordProps = json?.properties?.coordinateProperties ?? {};
  const times = coordProps?.times ?? coordProps?.time ?? [];
  const speeds = coordProps?.speed ?? coordProps?.speeds ?? [];
  const courses = coordProps?.course ?? coordProps?.courses ?? [];

  if (Array.isArray(coords) && coords.length && Array.isArray(coords[0])) {
    coords.forEach((coord, index) => {
      const lon = Number(coord?.[0]);
      const lat = Number(coord?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const attrs = {};
      for (const [key, values] of Object.entries(coordProps)) {
        if (Array.isArray(values)) attrs[key] = values[index];
      }
      points.push({
        timestamp: normalizeTimestamp(times[index] ?? attrs.timestamp ?? attrs.timestamps),
        latitude: lat,
        longitude: lon,
        speed: numericOrBlank(speeds[index] ?? attrs.speed),
        course: numericOrBlank(courses[index] ?? attrs.course),
        raw_attributes_json: JSON.stringify(attrs),
      });
    });
    return points;
  }

  const features = Array.isArray(json?.features) ? json.features : [];
  if (features.length) {
    features.forEach((feature) => {
      const coord = feature?.geometry?.coordinates ?? [];
      const props = feature?.properties ?? {};
      const lon = Number(coord?.[0]);
      const lat = Number(coord?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      points.push({
        timestamp: normalizeTimestamp(props.timestamp ?? props.time ?? props.date),
        latitude: lat,
        longitude: lon,
        speed: numericOrBlank(props.speed ?? props.sog),
        course: numericOrBlank(props.course ?? props.cog),
        raw_attributes_json: JSON.stringify(props),
      });
    });
    return points;
  }

  const entries = Array.isArray(json) ? json : (json?.entries ?? []);
  entries.forEach((entry) => {
    const coord = entry?.geometry?.coordinates ?? [];
    const lon = Number(entry?.lon ?? entry?.longitude ?? coord?.[0]);
    const lat = Number(entry?.lat ?? entry?.latitude ?? coord?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    points.push({
      timestamp: normalizeTimestamp(entry?.timestamp ?? entry?.time ?? entry?.properties?.timestamp),
      latitude: lat,
      longitude: lon,
      speed: numericOrBlank(entry?.speed ?? entry?.sog ?? entry?.properties?.speed),
      course: numericOrBlank(entry?.course ?? entry?.cog ?? entry?.properties?.course),
      raw_attributes_json: JSON.stringify(entry?.properties ?? entry),
    });
  });
  return points;
}

function normalizeTimestamp(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number") return new Date(value * (value > 10_000_000_000 ? 1 : 1000)).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function numericOrBlank(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function pointTimeRange(points) {
  const timestamps = points.map((p) => p.timestamp).filter(Boolean).sort();
  return {
    first: timestamps[0] || "",
    last: timestamps[timestamps.length - 1] || "",
  };
}

async function processMmsi(mmsi, token, args) {
  const search = await searchVesselId(mmsi, token, args);
  await sleep(args.delayMs);

  if (!search.vessel_id) {
    const report = {
      MMSI: mmsi,
      vessel_id: "",
      search_status: search.search_status,
      track_status: "not_requested",
      point_count: 0,
      first_track_time: "",
      last_track_time: "",
      error_message: search.error_message,
      start_date: args.startDate,
      end_date: args.endDate,
      fetched_at_utc: new Date().toISOString(),
      done: true,
    };
    return { report, trackRows: [] };
  }

  const track = await fetchTrack(search.vessel_id, token, args);
  await sleep(args.delayMs);
  const range = pointTimeRange(track.points);
  const trackRows = track.points.map((point, index) => ({
    MMSI: mmsi,
    vessel_id: search.vessel_id,
    timestamp: point.timestamp,
    latitude: point.latitude,
    longitude: point.longitude,
    speed: point.speed,
    course: point.course,
    source: GFW_TRACK_DATASET,
    fetch_status: track.track_status,
    track_index: index + 1,
    raw_attributes_json: point.raw_attributes_json,
  }));
  const report = {
    MMSI: mmsi,
    vessel_id: search.vessel_id,
    search_status: search.search_status,
    track_status: track.track_status,
    point_count: trackRows.length,
    first_track_time: range.first,
    last_track_time: range.last,
    error_message: track.error_message,
    start_date: args.startDate,
    end_date: args.endDate,
    fetched_at_utc: new Date().toISOString(),
    done: true,
  };
  return { report, trackRows };
}

function buildSummary(progress, allMmsi, selectedMmsi) {
  const records = selectedMmsi.map((mmsi) => progress.mmsi[mmsi]).filter(Boolean);
  const statusCounts = {};
  for (const record of records) {
    const key = `${record.search_status || "unknown"}|${record.track_status || "unknown"}`;
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  return {
    generated_at_utc: new Date().toISOString(),
    candidate_mmsi_total: allMmsi.length,
    selected_mmsi_count: selectedMmsi.length,
    processed_mmsi_count: records.length,
    resolved_vessel_id_count: records.filter((r) => String(r.vessel_id || "").trim()).length,
    mmsi_with_track: records.filter((r) => Number(r.point_count) > 0).length,
    mmsi_with_min_120_points: records.filter((r) => Number(r.point_count) >= 120).length,
    mmsi_with_less_than_120_points: records.filter((r) => Number(r.point_count) > 0 && Number(r.point_count) < 120).length,
    mmsi_without_track_data: records.filter((r) => Number(r.point_count) === 0).length,
    status_counts: statusCounts,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvIfNeeded();
  const token = process.env.GFW_TOKEN;
  if (!token) throw new Error("GFW_TOKEN tidak ditemukan di environment, .env.lokal, .env.local, atau .env");

  mkdirSync(args.outDir, { recursive: true });
  const paths = outputPaths(args);
  ensureCsv(paths.tracks, TRACK_HEADERS);
  ensureCsv(paths.report, REPORT_HEADERS);

  const allMmsi = uniqueCandidateMmsi(args.candidates);
  let selectedMmsi = args.mmsi
    ? args.mmsi.split(",").map(normalizeMmsi).filter(Boolean)
    : allMmsi.slice();
  const allowed = new Set(allMmsi);
  selectedMmsi = selectedMmsi.filter((mmsi) => allowed.has(mmsi));
  if (args.limit > 0) selectedMmsi = selectedMmsi.slice(0, args.limit);

  const progress = loadProgress(args);
  progress.candidates_path = args.candidates;
  progress.track_dataset = GFW_TRACK_DATASET;
  progress.identity_dataset = GFW_IDENTITY_DATASET;
  progress.no_event_fallback_for_track = true;
  saveProgress(paths.progress, progress);

  console.log(`Candidate MMSI total: ${allMmsi.length}`);
  console.log(`Selected MMSI this run: ${selectedMmsi.length}`);
  console.log(`Output directory: ${args.outDir}`);
  console.log(`Track range: ${args.startDate} -> ${args.endDate}`);

  for (let index = 0; index < selectedMmsi.length; index += 1) {
    const mmsi = selectedMmsi[index];
    const existing = progress.mmsi[mmsi];
    if (terminalDone(existing, args.retryFailed)) {
      console.log(`[${index + 1}/${selectedMmsi.length}] MMSI ${mmsi} skipped (progress: ${existing.track_status})`);
      continue;
    }

    console.log(`[${index + 1}/${selectedMmsi.length}] MMSI ${mmsi} fetching...`);
    const { report, trackRows } = await processMmsi(mmsi, token, args);
    progress.mmsi[mmsi] = report;
    saveProgress(paths.progress, progress);
    appendCsv(paths.tracks, TRACK_HEADERS, trackRows);
    appendCsv(paths.report, REPORT_HEADERS, [report]);
    console.log(
      `[${index + 1}/${selectedMmsi.length}] MMSI ${mmsi} search=${report.search_status} track=${report.track_status} points=${report.point_count}`
    );
  }

  const summary = buildSummary(progress, allMmsi, selectedMmsi);
  writeFileSync(paths.summary, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log("");
  console.log("Summary:");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`Tracks: ${paths.tracks}`);
  console.log(`Report: ${paths.report}`);
  console.log(`Progress: ${paths.progress}`);
  console.log(`Summary file: ${paths.summary}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error?.message || error}`);
  process.exitCode = 1;
});
