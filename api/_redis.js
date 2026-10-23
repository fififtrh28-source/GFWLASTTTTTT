const REST_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  "";

const REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  "";

// X-5 (Ringkasan Eksekutif laporan audit, tingkat Rendah: "memory leaks pada local cache"): penyimpanan sementara di
// memori (dipakai bila Redis tidak diatur atau gagal) dulu bertambah tanpa batas di server yang berjalan lama.
// Kini dibatasi jumlah isi dan perkiraan ukurannya; bila penuh, isi yang paling lama tidak dipakai dibuang lebih dulu
// (LRU), dan isi yang sudah kedaluwarsa disapu paling cepat tiap 60 detik.
const LOCAL_MAX_ENTRIES = 1000;
const LOCAL_MAX_BYTES = 64 * 1024 * 1024;
const LOCAL_SWEEP_INTERVAL_MS = 60 * 1000;

const localStore = new Map();
let localBytes = 0;
let lastSweep = 0;

function now() {
  return Date.now();
}

// Perkiraan ukuran di memori: panjang JSON × 2 byte per karakter.
function estimateBytes(value) {
  const json = JSON.stringify(value);
  return typeof json === "string" ? json.length * 2 : 16;
}

function removeLocal(key) {
  const entry = localStore.get(key);
  if (!entry) return;
  localBytes -= entry.bytes;
  localStore.delete(key);
}

function sweepExpired(t) {
  if (t - lastSweep < LOCAL_SWEEP_INTERVAL_MS) return;
  lastSweep = t;
  for (const [key, entry] of localStore) {
    if (entry.expiresAt && entry.expiresAt <= t) removeLocal(key);
  }
}

function getLocal(key) {
  const entry = localStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= now()) {
    removeLocal(key);
    return null;
  }
  // Baru dipakai: pindah ke urutan paling akhir, supaya tidak ikut dibuang lebih dulu.
  localStore.delete(key);
  localStore.set(key, entry);
  return entry.value;
}

function setLocal(key, value, ttlSeconds, bytes = estimateBytes(value)) {
  const t = now();
  sweepExpired(t);
  removeLocal(key);
  if (bytes > LOCAL_MAX_BYTES) return; // satu isi lebih besar dari seluruh batas: tidak disimpan di memori
  localStore.set(key, {
    value,
    bytes,
    expiresAt: ttlSeconds > 0 ? t + ttlSeconds * 1000 : 0,
  });
  localBytes += bytes;
  while (localStore.size > LOCAL_MAX_ENTRIES || localBytes > LOCAL_MAX_BYTES) {
    const oldest = localStore.keys().next().value;
    if (oldest === undefined) break;
    removeLocal(oldest);
  }
}

// Jumlah isi dan perkiraan ukuran penyimpanan sementara di memori (untuk pemantauan dan tes).
export function localCacheStats() {
  return { entries: localStore.size, bytes: localBytes, maxEntries: LOCAL_MAX_ENTRIES, maxBytes: LOCAL_MAX_BYTES };
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
  try {
    const serialized = JSON.stringify(value);
    setLocal(key, value, ttlSeconds, serialized.length * 2); // X-5: ukuran dari JSON yang sama, tidak dihitung dua kali
    // K-6 (laporan audit, B.6): sama persis dengan "Rekomendasi Perbaikan" di PDF.
    // Lewatkan klausul EX jika TTL <= 0 (Redis menolak "EX 0").
    const cmd = ["SET", key, serialized];
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      cmd.push("EX", String(Math.floor(ttlSeconds)));
    }
    const { configured } = await pipeline([cmd]);
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
