import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

// Nama ZEE untuk kode wilayah di event GFW (regions.eez berisi id angka, mis. 8492 = Indonesia).
// GET  →  { eez: { [id]: { iso3, territory, label } } }

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const CACHE_KEY = "gfw:regions:eez:v1";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "gfw-regions",
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const cached = await cacheGet(CACHE_KEY);
  if (cached?.payload) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800");
    return res.json(cached.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ eez: {}, error: "GFW_TOKEN not configured" });

  try {
    const gfwRes = await fetch(`${GFW_BASE}/datasets/public-eez-areas/context-layers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!gfwRes.ok) throw new Error(`GFW eez list ${gfwRes.status}`);
    const list = await gfwRes.json();

    const eez = {};
    for (const e of Array.isArray(list) ? list : []) {
      if (e?.id == null) continue;
      eez[String(e.id)] = { iso3: e.iso3 || null, territory: e.territory1 || null, label: e.label || null };
    }

    const payload = { eez };
    await cacheSet(CACHE_KEY, { payload, fetchedAt: Date.now() }, CACHE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800");
    res.json(payload);
  } catch (e) {
    console.error("[gfw regions]", e?.message);
    res.status(500).json({ eez: {}, error: e?.message || "regions failed" });
  }
}
