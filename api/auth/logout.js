import { sendProblem } from "../_problem.js";
import { clearSessionCookie, readCookie, revokeSession, SESSION_COOKIE, verifySessionToken } from "../_session.js";

// F3-S: keluar (logout). POST → cookie sesi dihapus dari browser dan ID sesinya dicatat sebagai dicabut
// (lihat revokeSession di api/_session.js). Selalu 200 { ok: true }, juga bila sesinya sudah tidak berlaku.

function isSecure(req) {
  return String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || Boolean(process.env.VERCEL);
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if ((req.method || "GET") !== "POST") {
    return sendProblem(res, 405, "Gunakan POST.", { ok: false });
  }
  const payload = await verifySessionToken(readCookie(req.headers?.cookie, SESSION_COOKIE));
  if (payload) {
    try {
      await revokeSession(payload);
    } catch (err) {
      console.warn("[logout] sesi tidak bisa dicatat sebagai dicabut:", err?.message || err);
    }
  }
  res.setHeader("Set-Cookie", clearSessionCookie({ secure: isSecure(req) }));
  return res.json({ ok: true });
}
