import { sendProblem } from "./_problem.js";
import { incrementWithTtl } from "./_redis.js";

function getHeader(req, name) {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

// Alamat IP pengunjung. Header x-forwarded-for / x-real-ip hanya dipercaya di Vercel (diisi Vercel sendiri) atau bila
// TRUST_PROXY=1 (server sendiri di belakang proxy). Selain itu dipakai alamat koneksi langsung, supaya pengunjung
// tidak bisa memalsukan IP lewat header untuk menghindari batas permintaan.
function getClientIp(req) {
  const trustHeaders = Boolean(process.env.VERCEL) || process.env.TRUST_PROXY === "1";
  if (trustHeaders) {
    const forwarded = getHeader(req, "x-vercel-forwarded-for") || getHeader(req, "x-real-ip") || getHeader(req, "x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
  }
  return (
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
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
  let count;
  try {
    count = await incrementWithTtl(key, windowSeconds + 5);
  } catch (err) {
    // Bila penghitung gagal, permintaan tetap dilayani (fail-open) dan kejadiannya dicatat.
    console.warn(`[rate-limit] penghitung gagal untuk ${name}, permintaan diloloskan:`, err?.message || err);
    return true;
  }
  const remaining = Math.max(0, limit - count);

  res.setHeader("x-ratelimit-limit", String(limit));
  res.setHeader("x-ratelimit-remaining", String(remaining));
  res.setHeader("x-ratelimit-window", String(windowSeconds));

  if (count <= limit) return true;

  res.setHeader("retry-after", String(windowSeconds));
  sendProblem(res, 429, "Too many requests", { retry_after_seconds: windowSeconds });
  return false;
}
