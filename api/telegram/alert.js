import { applyRateLimit } from "../_rate-limit.js";
import { sendTelegramMessage, telegramConfig } from "./_client.js";

function clean(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function formatScore(body = {}) {
  const scoreText = clean(body.scoreText || body.score_text, "");
  if (scoreText) return scoreText;
  const raw = body.score;
  if (raw == null || raw === "") return "-";
  const text = String(raw).trim();
  if (!text) return "-";
  if (text.includes("%") || Number.isNaN(Number(text))) return text;
  const number = Number(text);
  const percent = number <= 1 ? number * 100 : number;
  return `${Math.round(percent)}%`;
}

function formatAlertTime(value) {
  const raw = clean(value, new Date().toISOString());
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (isoMatch) {
    const [, year, month, day, hour, minute, second = "00"] = isoMatch;
    return `${Number(day)}/${Number(month)}/${year}, ${hour.padStart(2, "0")}:${minute}:${second.padStart(2, "0")}`;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatAlert(body = {}) {
  const alertType = clean(body.alertType || body.alert_type || body.type, "ALERT");
  const mmsi = clean(body.mmsi || body.MMSI);
  const vesselName = clean(body.vesselName || body.name || body.Name, "Unknown vessel");
  const score = formatScore(body);
  const lat = clean(body.lat || body.latitude || body.Center_latitude);
  const lon = clean(body.lon || body.longitude || body.Center_longitude);
  const time = formatAlertTime(body.time || body.timestamp || body.scene_time_utc);

  return [
    `ALERT ${alertType}`,
    `MMSI: ${mmsi}`,
    `Nama kapal: ${vesselName}`,
    `Score: ${score}`,
    `Koordinat: ${lat}, ${lon}`,
    `Waktu: ${time}`,
  ].join("\n");
}

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "telegram-alert",
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  if ((req.method || "GET") !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const config = telegramConfig();
  if (config.missing.length) {
    return res.status(500).json({
      ok: false,
      error: "Telegram env belum lengkap",
      missing: config.missing,
      expected: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
    });
  }

  try {
    const result = await sendTelegramMessage(formatAlert(req.body || {}));
    return res.json({
      ok: true,
      message: "Alert Telegram berhasil dikirim.",
      telegram_message_id: result?.message_id,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err?.message || "Gagal mengirim alert Telegram.",
    });
  }
}
