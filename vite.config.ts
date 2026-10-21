import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  for (const fileName of [".env", ".env.local"]) {
    const envFile = path.join(__dirname, fileName);
    if (!fs.existsSync(envFile)) continue;
    for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

const API_DIR = path.join(__dirname, "api");

function isInside(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Alamat /api/... hanya boleh menunjuk handler di dalam folder api/ (sama seperti server/index.mjs).
// Alamat berisi ../ atau file berawalan "_" / "." ditolak, supaya tidak ada file lain yang ikut dijalankan.
function resolveHandler(urlPath: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(urlPath, "http://localhost").pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith("/api/")) return null;
  const segments = pathname.split("/").filter(Boolean).slice(1);
  if (!segments.length || segments.some((segment) => segment.startsWith("_") || segment.startsWith(".") || segment.includes("\\"))) {
    return null;
  }
  const base = path.join(API_DIR, ...segments);
  return [`${base}.js`, path.join(base, "index.js")].find((file) => isInside(API_DIR, file) && fs.existsSync(file)) ?? null;
}

type AisRelay = { handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>; start: () => void };

// Relay AIS live (server/ais-relay.mjs) ikut berjalan di dalam `npm run dev`.
async function loadAisRelay(): Promise<AisRelay> {
  return import(pathToFileURL(path.join(__dirname, "server", "ais-relay.mjs")).href);
}

function vercelApiPlugin() {
  return {
    name: "local-vercel-api",
    configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
      loadDotEnv();
      // Relay langsung jalan saat server mulai, supaya riwayat AIS terkumpul walau dashboard belum dibuka.
      loadAisRelay().then((relay) => relay.start()).catch((err) => console.error("[ais-relay] gagal dimulai:", err));

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith("/api/")) return next();

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

        if (req.url.startsWith("/api/ais/")) {
          const relay = await loadAisRelay();
          if (await relay.handle(req, res)) return;
        }

        const handlerPath = resolveHandler(req.url);
        if (!handlerPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "API route not found: " + req.url }));
        }

        const urlObj = new URL(req.url, "http://localhost");
        const query: Record<string, string> = {};
        urlObj.searchParams.forEach((v, k) => { query[k] = v; });

        let bodyText = "";
        if (req.method === "POST") {
          // Kiriman lebih dari 1 MB ditolak (sama seperti server/index.mjs), supaya memori server lokal tidak habis.
          const MAX_BODY_BYTES = 1024 * 1024;
          const tooLarge = await new Promise<boolean>((resolve) => {
            const chunks: Buffer[] = [];
            let size = 0;
            req.on("data", (c: Buffer) => {
              size += c.length;
              if (size > MAX_BODY_BYTES * 16) { req.destroy(); resolve(true); return; } // kiriman sangat besar: putus
              if (size > MAX_BODY_BYTES) return; // lewat 1 MB: sisa kiriman dibuang, tidak disimpan
              chunks.push(c);
            });
            req.on("end", () => {
              if (size > MAX_BODY_BYTES) return resolve(true);
              bodyText = Buffer.concat(chunks).toString("utf-8");
              resolve(false);
            });
          });
          if (tooLarge) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ error: "Request body terlalu besar (maksimal 1 MB)" }));
          }
        }

        const mockReq = {
          method: req.method,
          query,
          headers: req.headers,
          body: bodyText ? (() => { try { return JSON.parse(bodyText); } catch { return bodyText; } })() : {},
        };

        const mockRes = {
          _status: 200,
          status(code: number) { this._status = code; return this; },
          setHeader(name: string, value: string) { res.setHeader(name, value); return this; },
          json(data: unknown) {
            res.setHeader("Content-Type", "application/json");
            res.statusCode = this._status;
            res.end(JSON.stringify(data));
          },
          end(body = "") { res.statusCode = this._status; res.end(body); },
        };

        try {
          const mod = await import(pathToFileURL(handlerPath).href);
          await (mod.default ?? mod)(mockReq, mockRes);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: msg }));
          }
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [vercelApiPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        dashboard: path.resolve(__dirname, "dashboard.html"),
        anomalyAlert: path.resolve(__dirname, "anomaly-alert.html"),
        dataReports: path.resolve(__dirname, "data-reports.html"),
        mapBackground: path.resolve(__dirname, "map-background-preview.html"),
        sceneViewer: path.resolve(__dirname, "lihat_scene_kapal.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    watch: {
      ignored: ["**/.local-dev/**"],
    },
  },
});
