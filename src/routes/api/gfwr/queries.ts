import { createFileRoute } from "@tanstack/react-router";
import { GFWR_QUERIES } from "@/lib/gfw-queries";

export const Route = createFileRoute("/api/gfwr/queries")({
  server: {
    handlers: {
      // R-5 (laporan audit): tidak ada operasi await di dalamnya, jadi kata kunci async dihapus.
      GET: () => Response.json({ queries: GFWR_QUERIES }),
    },
  },
});
