// Relay AIS live: satu koneksi ke AISStream yang dibagikan ke semua pengunjung dashboard
// lewat Server-Sent Events. API key hanya dibaca dari environment (AISSTREAM_API_KEY),
// tidak pernah dikirim ke browser.
//
// Dipakai oleh server/index.mjs (produksi) dan vite.config.ts (npm run dev).
//   GET /api/ais/stream    -> event "status", "snapshot", lalu "ships" tiap ada perubahan
//   GET /api/ais/snapshot  -> semua kapal saat ini (JSON)
//   GET /api/ais/status    -> status koneksi relay + ringkasan riwayat AIS (JSON)
import * as history from "./ais-history.mjs";

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
// Perairan Indonesia, sama dengan polygon di api/gfw/events.js. Format AISStream: [[lat, lon], [lat, lon]].
const BOUNDING_BOX = [[-11, 95], [6, 141]];
const MESSAGE_TYPES = [
  "PositionReport",
  "StandardClassBPositionReport",
  "ExtendedClassBPositionReport",
  "ShipStaticData",
  "StaticDataReport",
];
const POSITION_TYPES = new Set(["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"]);
const CLASS_B_TYPES = new Set(["StandardClassBPositionReport", "ExtendedClassBPositionReport", "StaticDataReport"]);

const SHIP_TTL_MS = 10 * 60_000; // sama dengan auto-prune di dashboard
const TRAIL_MAX = 120; // sama dengan AIS_TRAIL_MAX di dashboard
const BROADCAST_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const PRUNE_INTERVAL_MS = 60_000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

const ships = new Map();
const changed = new Set();
const clients = new Set();
const decoder = new TextDecoder();
const status = { state: "idle", error: null, lastMessageAt: null, messages: 0 };

let started = false;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let timers = [];

function apiKey() {
  return String(process.env.AISSTREAM_API_KEY || "").trim().replace(/^["']|["']$/g, "");
}

// AIS memakai '@' sebagai karakter pengisi pada teks.
function cleanText(value) {
  return String(value ?? "").replace(/@/g, " ").replace(/\s+/g, " ").trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Nilai "tidak tersedia" menurut standar AIS: SOG 102.3, COG 360, heading 511.
function speedOrNull(value) {
  const n = numberOrNull(value);
  return n === null || n < 0 || n >= 102.3 ? null : n;
}

function angleOrNull(value) {
  const n = numberOrNull(value);
  return n === null || n < 0 || n >= 360 ? null : n;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function validPosition(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

function getShip(key, mmsi, now) {
  let ship = ships.get(key);
  if (!ship) {
    ship = {
      source: "ais",
      key,
      mmsi,
      name: "",
      lat: null,
      lon: null,
      waktu: null,
      speed: null,
      course: null,
      heading: null,
      navStatus: null,
      destination: null,
      shipType: null,
      classB: false,
      createdAt: now,
      lastSeenAt: 0,
      trail: [],
    };
    ships.set(key, ship);
  }
  return ship;
}

function handleMessage(msg, receivedAt) {
  const type = msg?.MessageType;
  if (!type) return;
  status.messages++;
  status.lastMessageAt = receivedAt;

  const meta = msg.MetaData || {};
  const body = msg.Message?.[type] || {};
  const mmsi = Number(meta.MMSI);
  if (!Number.isFinite(mmsi) || mmsi <= 0) return;
  const key = String(mmsi);
  const ship = getShip(key, mmsi, receivedAt);

  const name = cleanText(meta.ShipName) || cleanText(body.Name) || (body.ReportA?.Valid ? cleanText(body.ReportA.Name) : "");
  if (name) ship.name = name;
  if (CLASS_B_TYPES.has(type)) ship.classB = true;

  // Data statis hanya mengisi identitas; kecepatan dan arah tidak ikut tertimpa.
  if (type === "ShipStaticData") {
    const destination = cleanText(body.Destination);
    if (destination) ship.destination = destination;
    if (Number(body.Type) > 0) ship.shipType = Number(body.Type);
  } else if (type === "StaticDataReport") {
    if (body.ReportB?.Valid && Number(body.ReportB.ShipType) > 0) ship.shipType = Number(body.ReportB.ShipType);
  } else if (type === "ExtendedClassBPositionReport") {
    if (Number(body.Type) > 0) ship.shipType = Number(body.Type);
  }
  if (type === "ShipStaticData" || type === "StaticDataReport") history.recordVessel(ship);

  if (POSITION_TYPES.has(type)) {
    const lat = Number(meta.latitude);
    const lon = Number(meta.longitude);
    if (validPosition(lat, lon)) {
      ship.lat = round6(lat);
      ship.lon = round6(lon);
      ship.speed = speedOrNull(body.Sog);
      ship.course = angleOrNull(body.Cog);
      ship.heading = angleOrNull(body.TrueHeading);
      if (type === "PositionReport") ship.navStatus = numberOrNull(body.NavigationalStatus);
      ship.waktu = meta.time_utc || ship.waktu;
      ship.lastSeenAt = receivedAt;
      const last = ship.trail[ship.trail.length - 1];
      if (!last || last[0] !== ship.lat || last[1] !== ship.lon) {
        ship.trail.push([ship.lat, ship.lon, receivedAt]);
        if (ship.trail.length > TRAIL_MAX) ship.trail.shift();
      }
      history.recordPosition(ship, receivedAt);
    }
  }

  if (ship.lat !== null) changed.add(key);
}

function toClient(ship, forSnapshot = false, now = Date.now()) {
  const { trail, createdAt, lastSeenAt, ...data } = ship;
  if (!forSnapshot) return data;
  return { ...data, ageMs: Math.max(0, now - lastSeenAt), trail };
}

function visibleShips(forSnapshot = false) {
  const now = Date.now();
  const list = [];
  for (const ship of ships.values()) {
    if (ship.lat !== null) list.push(toClient(ship, forSnapshot, now));
  }
  return list;
}

function publicStatus() {
  let visible = 0;
  for (const ship of ships.values()) if (ship.lat !== null) visible++;
  return {
    state: status.state,
    error: status.error,
    ships: visible,
    messages: status.messages,
    lastMessageAt: status.lastMessageAt ? new Date(status.lastMessageAt).toISOString() : null,
  };
}

function sendToClients(chunk) {
  for (const res of clients) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}

function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function setStatus(state, error = null) {
  if (status.state === state && status.error === error) return;
  status.state = state;
  status.error = error;
  sendToClients(sseEvent("status", publicStatus()));
}

function broadcastChanges() {
  if (!changed.size) return;
  if (!clients.size) {
    changed.clear();
    return;
  }
  const list = [];
  for (const key of changed) {
    const ship = ships.get(key);
    if (ship && ship.lat !== null) list.push(toClient(ship));
  }
  changed.clear();
  if (list.length) sendToClients(sseEvent("ships", list));
}

function pruneShips(now = Date.now()) {
  for (const [key, ship] of ships) {
    if (now - (ship.lastSeenAt || ship.createdAt) > SHIP_TTL_MS) {
      ships.delete(key);
      changed.delete(key);
    }
  }
}

function scheduleReconnect(reason) {
  if (!started) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  setStatus(status.state === "error" ? "error" : "reconnecting", reason);
  console.warn(`[ais-relay] ${reason}; sambung ulang dalam ${Math.round(delay / 1000)} detik`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  clearTimeout(reconnectTimer);
  if (!started) return;

  const key = apiKey();
  if (!key) {
    setStatus("no-key", "AISSTREAM_API_KEY belum diatur di .env.local");
    console.warn("[ais-relay] AISSTREAM_API_KEY belum diatur; relay AIS tidak tersambung.");
    return;
  }
  if (typeof WebSocket !== "function") {
    setStatus("error", "Butuh Node.js 22 atau lebih baru");
    console.error("[ais-relay] WebSocket bawaan tidak tersedia; pakai Node.js 22 atau lebih baru.");
    return;
  }

  setStatus(status.state === "idle" ? "connecting" : "reconnecting");
  const ws = new WebSocket(AISSTREAM_URL);
  ws.binaryType = "arraybuffer";
  socket = ws;
  let receiving = false;

  ws.addEventListener("open", () => {
    // AISStream mewajibkan pesan langganan dikirim dalam 3 detik setelah tersambung.
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [BOUNDING_BOX], FilterMessageTypes: MESSAGE_TYPES }));
  });

  ws.addEventListener("message", (event) => {
    const receivedAt = Date.now();
    let msg;
    try {
      // AISStream mengirim pesan dalam bentuk biner, jadi harus didekode dulu.
      msg = JSON.parse(typeof event.data === "string" ? event.data : decoder.decode(event.data));
    } catch {
      return;
    }
    if (msg?.error) {
      setStatus("error", String(msg.error));
      return;
    }
    if (!receiving) {
      receiving = true;
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus("online");
      console.log("[ais-relay] terhubung ke AISStream, menerima data kapal.");
    }
    handleMessage(msg, receivedAt);
  });

  ws.addEventListener("close", (event) => {
    if (socket !== ws) return; // ditutup sengaja oleh stop()
    socket = null;
    scheduleReconnect(status.state === "error" && status.error ? status.error : `koneksi AISStream terputus (kode ${event.code})`);
  });

  ws.addEventListener("error", () => {
    // Event "close" selalu menyusul; penyambungan ulang diatur di sana.
  });
}

export function start() {
  if (started) return;
  started = true;
  timers = [
    setInterval(broadcastChanges, BROADCAST_INTERVAL_MS),
    setInterval(() => pruneShips(), PRUNE_INTERVAL_MS),
    setInterval(() => sendToClients(": ping\n\n"), HEARTBEAT_INTERVAL_MS),
  ];
  for (const timer of timers) timer.unref?.();
  history.open();
  connect();
}

export function stop() {
  started = false;
  clearTimeout(reconnectTimer);
  for (const timer of timers) clearInterval(timer);
  timers = [];
  history.close();
  const ws = socket;
  socket = null;
  try {
    ws?.close();
  } catch {}
  for (const res of clients) {
    try {
      res.end();
    } catch {}
  }
  clients.clear();
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function openStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  res.write(sseEvent("status", publicStatus()));
  res.write(sseEvent("snapshot", { ships: visibleShips(true) }));
  clients.add(res);
  const remove = () => clients.delete(res);
  req.on("close", remove);
  res.on("error", remove);
}

// Mengembalikan true jika permintaan sudah dilayani relay.
export async function handle(req, res) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "");
  if (!pathname.startsWith("/api/ais/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  start();
  if (pathname === "/api/ais/stream") {
    openStream(req, res);
    return true;
  }
  if (pathname === "/api/ais/snapshot") {
    sendJson(res, 200, { status: publicStatus(), ships: visibleShips(false) });
    return true;
  }
  if (pathname === "/api/ais/status") {
    sendJson(res, 200, { ...publicStatus(), history: history.stats() });
    return true;
  }
  return false;
}
