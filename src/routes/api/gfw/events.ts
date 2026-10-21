import { createFileRoute } from "@tanstack/react-router";
import { getIndonesianEvents, type GfwRawEvent } from "@/lib/gfw.server";
import { errorMessage, problemResponse } from "@/lib/problem";
import type { GfwEvent } from "@/lib/types";

const SERVER_CACHE_TTL = 10 * 60 * 1000;
// T-4 (laporan audit, B.10): Map cache dengan kunci komposit rentang tanggal, sesuai "Rekomendasi Perbaikan" di PDF,
// supaya permintaan dengan rentang tanggal berbeda tidak menerima data rentang lain. Jumlah kunci dibatasi
// supaya memori tidak terus bertambah (kunci paling lama dibuang lebih dulu).
const SERVER_CACHE_MAX_KEYS = 50;
const cacheMap = new Map<string, { payload: { events: GfwEvent[] }; time: number }>();

function toGfwEvent(e: GfwRawEvent): GfwEvent {
  const startT = e?.start ? new Date(e.start).getTime() : 0;
  const endT   = e?.end   ? new Date(e.end).getTime()   : 0;
  const dur    = startT && endT ? (endT - startT) / 3600000 : undefined;
  return {
    id:            e?.id || `${e?.vessel?.id}-${e?.start}`,
    type:          (e?.type || "").toUpperCase(),
    start:         e?.start ?? "",
    end:           e?.end ?? "",
    durationHours: dur,
    lat:           Number(e?.position?.lat),
    lon:           Number(e?.position?.lon),
    vesselId:      e?.vessel?.id,
    mmsi:          e?.vessel?.ssvid,
    flag:          e?.vessel?.flag,
    shipName:      e?.vessel?.name,
  };
}

export const Route = createFileRoute("/api/gfw/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const startDate = url.searchParams.get("start_date") || "2012-01-01";
        const endDate = url.searchParams.get("end_date") || new Date().toISOString().slice(0, 10);

        // Rute ini tidak memakai parameter limit (GFW selalu diminta 200 kejadian), jadi kuncinya rentang tanggal saja.
        const cacheKey = `${startDate}_${endDate}`;
        const cached = cacheMap.get(cacheKey);
        if (cached && Date.now() - cached.time < SERVER_CACHE_TTL) {
          return Response.json(cached.payload, {
            headers: { "x-cache": "HIT", "cache-control": "public, max-age=600" },
          });
        }

        try {
          const raw = await getIndonesianEvents(startDate, endDate);
          const events: GfwEvent[] = raw.map(toGfwEvent).filter((ev) => Number.isFinite(ev.lat) && Number.isFinite(ev.lon));

          const payload = { events };
          cacheMap.delete(cacheKey);
          cacheMap.set(cacheKey, { payload, time: Date.now() });
          while (cacheMap.size > SERVER_CACHE_MAX_KEYS) {
            const oldest = cacheMap.keys().next().value;
            if (oldest === undefined) break;
            cacheMap.delete(oldest);
          }

          return Response.json(payload, {
            headers: { "x-cache": "MISS", "cache-control": "public, max-age=600" },
          });
        } catch (e) {
          console.error("[gfw-events] gagal:", e);
          return problemResponse(500, errorMessage(e, "events failed"), { events: [] });
        }
      },
    },
  },
});
