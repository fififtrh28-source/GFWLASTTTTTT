import { createFileRoute } from "@tanstack/react-router";
import { searchVessels } from "@/lib/gfw.server";
import { errorMessage, problemResponse } from "@/lib/problem";

export const Route = createFileRoute("/api/gfw/vessels/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const query = url.searchParams.get("query") || "";
        const limit = Math.min(50, Number(url.searchParams.get("limit") || "20"));
        if (!query.trim()) {
          return Response.json({ entries: [] });
        }
        try {
          const vessels = await searchVessels(query, limit);
          return Response.json({ entries: vessels });
        } catch (e) {
          console.error("[gfw-search] gagal:", e);
          return problemResponse(500, errorMessage(e, "search failed"), { entries: [] });
        }
      },
    },
  },
});
