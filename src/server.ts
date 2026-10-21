import "./lib/error-capture";

import { consumeCapturedError, runWithRequestId } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

// T-6 (laporan audit, B.12): sesuai "Rekomendasi Perbaikan" PDF. Bila impor modul gagal (misalnya gangguan jaringan
// sesaat saat cold start), Promise dikosongkan lagi supaya permintaan berikutnya mencoba ulang, tidak gagal selamanya.
async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry")
      .then((m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)))
      .catch((err) => {
        serverEntryPromise = undefined; // Reset state agar request berikutnya mencoba kembali
        throw err;
      });
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response, requestId: string): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(`[ssr] request ${requestId}:`, consumeCapturedError(requestId) ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // M-2 (laporan audit): setiap permintaan punya ID sendiri, supaya galat yang tertangkap tidak tertukar
    // dengan galat permintaan lain yang berjalan bersamaan.
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    return runWithRequestId(requestId, async () => {
      try {
        const handler = await getServerEntry();
        const response = await handler.fetch(request, env, ctx);
        return await normalizeCatastrophicSsrResponse(response, requestId);
      } catch (error) {
        console.error(`[ssr] request ${requestId}:`, error);
        return brandedErrorResponse();
      }
    });
  },
};
