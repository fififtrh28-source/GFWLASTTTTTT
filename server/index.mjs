// Server Ocean Nexus: website, handler di folder api/, dan relay AIS dalam satu proses.
// Jalankan dari folder proyek: npm run start   (butuh Node.js 22+)
// Pengaturan lewat .env.local / environment: PORT (default 3000), HOST (default 127.0.0.1),
// GFW_TOKEN, AISSTREAM_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as aisRelay from "./ais-relay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const ASSETS_DIR = path.join(ROOT, "assets");
const API_DIR = path.join(ROOT, "api");
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
};

// Sama dengan loadDotEnv di vite.config.ts: nilai yang sudah ada di environment tidak ditimpa.
function loadDotEnv() {
  for (const fileName of [".env", ".env.local", ".env.lokal"]) {
    const file = path.join(ROOT, fileName);
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      if (key && !(key in process.env)) process.env[key] = value;
    }
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isInside(baseDir, target) {
  const rel = path.relative(baseDir, target);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

// Hanya isi public/ (disajikan di root, seperti Vite), halaman *.html di root proyek,
// dan folder assets/ yang boleh diakses. File lain (.env.local, server/, scripts/, dll.) tidak.
function resolveStaticFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const segments = decoded.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length) segments.push("index.html");
  if (segments.some((segment) => segment.startsWith("."))) return null;

  const fromPublic = path.join(PUBLIC_DIR, ...segments);
  if (isInside(PUBLIC_DIR, fromPublic) && isFile(fromPublic)) return fromPublic;

  if (segments.length === 1 && segments[0].endsWith(".html")) {
    const page = path.join(ROOT, segments[0]);
    if (isFile(page)) return page;
  }

  if (segments[0] === "assets") {
    const asset = path.join(ROOT, ...segments);
    if (isInside(ASSETS_DIR, asset) && isFile(asset)) return asset;
  }
  return null;
}

function serveFile(req, res, file) {
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=3600");
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body terlalu besar"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// Adapter gaya Vercel untuk handler di api/, sama seperti vercelApiPlugin di vite.config.ts.
async function handleApi(req, res, url) {
  const segments = url.pathname.split("/").filter(Boolean).slice(1);
  // File berawalan "_" (misalnya _redis.js) adalah helper internal, bukan endpoint.
  if (!segments.length || segments.some((segment) => segment.startsWith("_") || segment.startsWith("."))) {
    return sendJson(res, 404, { error: `API route not found: ${url.pathname}` });
  }
  const base = path.join(API_DIR, ...segments);
  const handlerPath = [`${base}.js`, path.join(base, "index.js")].find((file) => isInside(API_DIR, file) && isFile(file));
  if (!handlerPath) return sendJson(res, 404, { error: `API route not found: ${url.pathname}` });

  let bodyText = "";
  if (req.method === "POST") {
    try {
      bodyText = await readBody(req);
    } catch (err) {
      return sendJson(res, 413, { error: err.message });
    }
  }

  const mockReq = {
    method: req.method,
    url: req.url,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    socket: req.socket,
    body: bodyText
      ? (() => {
          try {
            return JSON.parse(bodyText);
          } catch {
            return bodyText;
          }
        })()
      : {},
  };

  const mockRes = {
    _status: 200,
    status(code) {
      this._status = code;
      return this;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
      return this;
    },
    json(data) {
      res.statusCode = this._status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    },
    end(body = "") {
      res.statusCode = this._status;
      res.end(body);
    },
  };

  try {
    const mod = await import(pathToFileURL(handlerPath).href);
    await (mod.default ?? mod)(mockReq, mockRes);
  } catch (err) {
    console.error(`[api] ${url.pathname}:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/ais/")) {
      if (await aisRelay.handle(req, res)) return;
      return sendJson(res, 404, { error: `API route not found: ${url.pathname}` });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed");
    const file = resolveStaticFile(url.pathname);
    if (!file) return sendText(res, 404, "Halaman atau file tidak ditemukan");
    serveFile(req, res, file);
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) sendText(res, 500, "Terjadi kesalahan di server");
  }
});

loadDotEnv();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

aisRelay.start();
server.listen(PORT, HOST, () => {
  console.log(`[server] Ocean Nexus berjalan di http://${HOST}:${PORT}`);
});

function shutdown() {
  aisRelay.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
