// F3-S (laporan audit B.4 dan Fase 3): sesi login dengan cookie HttpOnly yang diperiksa server sebelum halaman atau
// data dikirim. Dipakai middleware.js (Vercel), vite.config.ts (npm run dev), server/index.mjs (npm run start),
// dan api/auth/login.js / logout.js.
//
// Isi cookie: "v1.<data>.<tanda tangan>". Data (JSON, base64url) berisi sid (ID sesi acak 128 bit), sub (nama
// pengguna), iat (waktu login), act (aktivitas terakhir), dan exp (batas mutlak), dalam detik. Tanda tangannya
// HMAC-SHA256 dengan SESSION_SECRET, jadi isi cookie tidak bisa dipalsukan atau diubah tanpa kunci itu.
//
// Batas waktu mengikuti OWASP Session Management Cheat Sheet: batas mutlak 8 jam (contoh OWASP untuk aplikasi yang
// dipakai seharian kerja: 4–8 jam) dan batas diam 30 menit (OWASP: 15–30 menit untuk aplikasi berisiko rendah).
// Cookie: HttpOnly, SameSite=Lax, dan Secure bila lewat HTTPS (OWASP: Strict atau Lax).

export const SESSION_COOKIE = "onx_session";
export const SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60;
export const SESSION_IDLE_SECONDS = 30 * 60;
// Selama pengguna aktif, cookie diperbarui (waktu aktivitas terakhir dimajukan) paling sering tiap 5 menit.
const RENEW_AFTER_SECONDS = 5 * 60;
const MIN_SECRET_LENGTH = 32;
const REVOKED_PREFIX = "onx:session:revoked:";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map();

function b64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("bukan base64url");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// Kunci penanda tangan dari pengaturan server SESSION_SECRET (minimal 32 karakter). Kosong = sesi belum diatur.
export function sessionSecret() {
  const secret = String(process.env.SESSION_SECRET || "");
  return secret.length >= MIN_SECRET_LENGTH ? secret : "";
}

async function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }
  return keyCache.get(secret);
}

async function sign(payload, secret) {
  const data = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`v1.${data}`)));
  return `v1.${data}.${b64urlEncode(signature)}`;
}

const seconds = (ms) => Math.floor(ms / 1000);

export async function createSession(sub, now = Date.now()) {
  const secret = sessionSecret();
  if (!secret) throw new Error("SESSION_SECRET belum diatur (minimal 32 karakter).");
  const t = seconds(now);
  const payload = { sid: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))), sub: String(sub), iat: t, act: t, exp: t + SESSION_ABSOLUTE_SECONDS };
  return { token: await sign(payload, secret), payload };
}

// Mengembalikan isi sesi bila tanda tangan benar dan belum lewat batas mutlak maupun batas diam; selain itu null.
export async function verifySessionToken(token, now = Date.now()) {
  const secret = sessionSecret();
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  let payload;
  try {
    const signature = b64urlDecode(parts[2]);
    // Hanya bentuk baku: tulisan lain yang kebetulan bermakna sama (bit sisa base64 diubah) ditolak.
    if (b64urlEncode(signature) !== parts[2]) return null;
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, encoder.encode(`v1.${parts[1]}`));
    if (!valid) return null;
    payload = JSON.parse(decoder.decode(b64urlDecode(parts[1])));
  } catch {
    return null; // cookie rusak atau bukan buatan server ini
  }
  const t = seconds(now);
  if (!payload || typeof payload.sid !== "string" || ![payload.iat, payload.act, payload.exp].every(Number.isFinite)) return null;
  if (t >= payload.exp) return null; // lewat batas mutlak
  if (t - payload.act >= SESSION_IDLE_SECONDS) return null; // terlalu lama tidak aktif
  if (payload.act > t + 60) return null; // waktu aktivitas dari masa depan: tidak wajar
  return payload;
}

async function renewIfNeeded(payload, now) {
  const t = seconds(now);
  if (t - payload.act < RENEW_AFTER_SECONDS) return null;
  const renewed = { ...payload, act: t };
  return { token: await sign(renewed, sessionSecret()), payload: renewed };
}

export function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

export function sessionCookie(token, payload, { secure, now = Date.now() } = {}) {
  const maxAge = Math.max(0, payload.exp - seconds(now));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie({ secure } = {}) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}

// Logout: ID sesi dicatat sebagai dicabut sampai batas mutlaknya. Pencatatan lintas server membutuhkan Redis
// (UPSTASH_REDIS_REST_URL/TOKEN); tanpa Redis hanya berlaku di proses yang sama. Cookie di browser tetap dihapus.
export async function revokeSession(payload, now = Date.now()) {
  const { cacheSet } = await import("./_redis.js");
  const ttl = Math.max(1, payload.exp - seconds(now));
  await cacheSet(`${REVOKED_PREFIX}${payload.sid}`, true, ttl);
}

async function isRevoked(sid) {
  const { cacheGet } = await import("./_redis.js");
  return Boolean(await cacheGet(`${REVOKED_PREFIX}${sid}`));
}

// Alamat yang boleh dibuka tanpa login: halaman login, berkas tampilan di /assets/ (CSS, JavaScript, gambar; tidak
// berisi data penelitian), serta alamat login dan logout. Semua alamat lain (halaman, data, dan API) butuh sesi.
export function isPublicPath(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (path.includes("\\") || path.split("/").some((segment) => segment === ".." || segment === ".")) return false;
  if (path === "/" || path === "/index.html" || path === "/favicon.ico") return true;
  if (path === "/api/auth/login" || path === "/api/auth/logout") return true;
  return path.startsWith("/assets/");
}

// Halaman (bukan data/API): tanpa sesi diarahkan ke halaman login, bukan dibalas 401.
function isPageRequest(pathname) {
  if (pathname.startsWith("/api/")) return false;
  const last = pathname.split("/").pop() || "";
  return last === "" || last.endsWith(".html") || !last.includes(".");
}

// Keputusan untuk satu permintaan:
//   { action: "allow", setCookie? }   lanjutkan (setCookie = cookie yang diperbarui, bila ada)
//   { action: "redirect", location }  halaman tanpa sesi: ke halaman login, lalu kembali ke halaman ini
//   { action: "deny" }                data/API tanpa sesi: 401
export async function decideAccess({ method = "GET", url, cookieHeader, secure = false, now = Date.now() }) {
  const { pathname, search } = new URL(url, "http://localhost");
  if (method === "OPTIONS" || isPublicPath(pathname)) return { action: "allow" };
  const payload = await verifySessionToken(readCookie(cookieHeader, SESSION_COOKIE), now);
  if (payload && !(await isRevoked(payload.sid))) {
    const renewed = await renewIfNeeded(payload, now);
    return { action: "allow", setCookie: renewed ? sessionCookie(renewed.token, renewed.payload, { secure, now }) : undefined };
  }
  if (isPageRequest(pathname)) return { action: "redirect", location: `/index.html?next=${encodeURIComponent(pathname + search)}` };
  return { action: "deny" };
}

// Balasan 401 dalam format RFC 7807, sama dengan api/_problem.js.
export const UNAUTHORIZED_BODY = JSON.stringify({
  type: "about:blank",
  title: "Unauthorized",
  status: 401,
  detail: "Sesi login tidak ada atau sudah berakhir. Silakan login lagi.",
  error: "Sesi login tidak ada atau sudah berakhir. Silakan login lagi.",
});
