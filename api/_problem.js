// Balasan galat API dalam format RFC 7807 (Problem Details): type, title, status, detail.
// Kolom "error" tetap disertakan supaya halaman yang sudah membaca "error" tetap berjalan, dan kolom tambahan
// (misalnya events: [] atau ok: false) tetap dikirim seperti sebelumnya.

const TITLES = {
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

export function sendProblem(res, status, detail, extra = {}) {
  res.setHeader("Content-Type", "application/problem+json; charset=utf-8");
  return res.status(status).json({
    ...extra,
    type: "about:blank",
    title: TITLES[status] || "Error",
    status,
    detail,
    error: detail,
  });
}
