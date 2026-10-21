import { sendProblem } from "../_problem.js";
import crypto from "node:crypto";
import { applyRateLimit } from "../_rate-limit.js";
import { createSession, sessionCookie, sessionSecret } from "../_session.js";

// Login Ocean Nexus diperiksa di server. Nama pengguna dan kata sandi dibaca dari pengaturan server
// (LOGIN_USERNAME dan LOGIN_PASSWORD di .env.local atau Vercel), tidak lagi tertulis di kode halaman.
// POST { username, password }  →  200 { ok: true } | 401 { ok: false } | 429 (terlalu sering) | 503 (belum diatur)
// F3-S (laporan audit B.4 dan Fase 3): login yang benar mendapat cookie sesi HttpOnly (api/_session.js); halaman,
// data, dan API lain hanya dikirim server bila cookie itu sah (middleware.js di Vercel).

function isSecure(req) {
  return String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || Boolean(process.env.VERCEL);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

// Perbandingan dengan waktu tetap, supaya lama jawaban tidak membocorkan berapa huruf yang sudah benar.
function sameText(given, expected) {
  const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
  const b = crypto.createHash("sha256").update(String(expected ?? "")).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if ((req.method || "GET") !== "POST") {
    return sendProblem(res, 405, "Gunakan POST.", { ok: false });
  }

  const allowed = await applyRateLimit(req, res, { name: "login", limit: 10, windowSeconds: 10 * 60 });
  if (!allowed) return;

  const expectedUser = String(process.env.LOGIN_USERNAME || "").trim();
  const expectedPassword = String(process.env.LOGIN_PASSWORD || "");
  if (!expectedUser || !expectedPassword || !sessionSecret()) {
    console.warn("[login] LOGIN_USERNAME / LOGIN_PASSWORD / SESSION_SECRET (minimal 32 karakter) belum diatur di server.");
    return sendProblem(res, 503, "Login belum diatur di server.", { ok: false });
  }

  const { username, password } = readBody(req);
  const userOk = sameText(String(username ?? "").trim(), expectedUser);
  const passwordOk = sameText(password, expectedPassword);
  if (!(userOk && passwordOk)) {
    return sendProblem(res, 401, "Nama pengguna atau kata sandi salah.", { ok: false });
  }
  const { token, payload } = await createSession(expectedUser);
  res.setHeader("Set-Cookie", sessionCookie(token, payload, { secure: isSecure(req) }));
  return res.json({ ok: true });
}
