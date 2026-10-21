import { createFileRoute } from "@tanstack/react-router";
import { getTrack } from "@/lib/gfw.server";
import { errorMessage, problemResponse } from "@/lib/problem";

export const Route = createFileRoute("/api/gfw/track")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const vesselId = url.searchParams.get("vessel_id") || "";
        const startDate = url.searchParams.get("start_date") || "";
        const endDate = url.searchParams.get("end_date") || "";
        if (!vesselId || !startDate || !endDate) {
          return problemResponse(400, "vessel_id, start_date, end_date required");
        }
        try {
          const data = await getTrack(vesselId, startDate, endDate);
          return Response.json(data);
        } catch (e) {
          console.error("[gfw-track] gagal:", e);
          return problemResponse(500, errorMessage(e, "track failed"));
        }
      },
    },
  },
});
