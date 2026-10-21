// C.3 (laporan audit): balasan galat API dalam format RFC 7807 (Problem Details), sama dengan api/_problem.js.
// Kolom "error" tetap disertakan supaya pemanggil yang sudah membaca "error" tetap berjalan, dan kolom tambahan
// (misalnya events: [] atau entries: []) tetap dikirim seperti sebelumnya.

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export function problemResponse(status: number, detail: string, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      ...extra,
      type: "about:blank",
      title: TITLES[status] ?? "Error",
      status,
      detail,
      error: detail,
    },
    { status, headers: { "content-type": "application/problem+json; charset=utf-8" } },
  );
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
