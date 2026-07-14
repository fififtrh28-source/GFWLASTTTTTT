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

function hasModelValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return text.toLowerCase() !== "not_available";
}

function hasValidAiEvidence(body = {}) {
  return [
    body.ai_gear_label,
    body.ai_godark_probability,
    body.ai_spoofing_probability,
    body.ai_transshipment_probability,
    body.yolo_class,
  ].some(hasModelValue);
}

function prettyGearLabel(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.replace(/_/g, " ").replace(/\s+/g, " ");
}

function numberOrNaN(value) {
  if (value == null || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function isModelLabel(value, expected) {
  return String(value ?? "").trim().toLowerCase() === expected;
}

function joinReadable(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} dan ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, dan ${items[items.length - 1]}`;
}

function buildUnavailableIndication(body = {}) {
  return "Model AI belum dapat memverifikasi kandidat ini karena data trajectory AIS belum mencukupi.";
}

function buildModelIndication(body = {}) {
  const explicit = String(body.model_indication_text || body.model_indication || "").trim();
  const genericUnavailable = "Model AI belum dapat memverifikasi kandidat ini karena data trajectory AIS belum mencukupi.";
  if (hasModelValue(explicit)) return explicit;

  const h5Items = [];
  const gearLabel = prettyGearLabel(body.ai_gear_label || body.gear_label);
  const yoloClass = String(body.yolo_class ?? "").trim();

  if (hasModelValue(body.ai_godark_probability || body.godark_probability) && isModelLabel(body.godark_label || body.ai_godark_label, "go_dark")) {
    h5Items.push({
      clause: "trajectory AIS menyerupai aktivitas go dark",
      sentence: "Pola trajectory AIS menyerupai aktivitas go dark.",
    });
  }
  if (hasModelValue(body.ai_spoofing_probability || body.spoofing_probability) && isModelLabel(body.spoofing_label || body.ai_spoofing_label, "spoofing")) {
    h5Items.push({
      clause: "trajectory AIS menyerupai aktivitas spoofing",
      sentence: "Pola trajectory AIS menyerupai aktivitas spoofing.",
    });
  }
  if (hasModelValue(body.ai_transshipment_probability || body.transshipment_probability) && isModelLabel(body.transshipment_label || body.ai_transshipment_label, "potential_transshipment")) {
    h5Items.push({
      clause: "pergerakan pasangan kapal menyerupai aktivitas transshipment",
      sentence: "Pola pergerakan pasangan kapal menyerupai aktivitas transshipment.",
    });
  }
  if (hasModelValue(gearLabel)) {
    h5Items.push({
      clause: `trajectory AIS menyerupai karakteristik alat tangkap ${gearLabel}`,
      sentence: `Pola trajectory AIS menyerupai karakteristik alat tangkap ${gearLabel}.`,
    });
  }

  const sentences = [];
  if (h5Items.length === 1) {
    sentences.push(h5Items[0].sentence);
  } else if (h5Items.length > 1) {
    sentences.push(`Model H5 mengindikasikan ${joinReadable(h5Items.map((item) => item.clause))}.`);
  }
  if (hasModelValue(yoloClass)) {
    sentences.push(`Deteksi SAR mengindikasikan kapal kelas ${yoloClass}.`);
  }
  if (!sentences.length && hasValidAiEvidence(body)) {
    sentences.push("Hasil model AI tersedia, tetapi belum menunjukkan indikasi aktivitas anomali pada kandidat ini.");
  }

  if (!sentences.length) {
    const unavailable = buildUnavailableIndication(body);
    return unavailable || genericUnavailable;
  }
  return sentences.join(" ");
}

function formatAlert(body = {}) {
  const alertType = clean(body.alertType || body.alert_type || body.type, "ALERT");
  const mmsi = clean(body.mmsi || body.MMSI);
  const vesselName = clean(body.vesselName || body.name || body.Name, "Unknown vessel");
  const score = formatScore(body);
  const lat = clean(body.lat || body.latitude || body.Center_latitude);
  const lon = clean(body.lon || body.longitude || body.Center_longitude);
  const time = formatAlertTime(body.time || body.timestamp || body.scene_time_utc);
  const modelIndication = buildModelIndication(body);
  const modelLines = hasValidAiEvidence(body)
    ? [``, `INDIKASI MODEL`, modelIndication]
    : [``, modelIndication];

  return [
    `ALERT ${alertType}`,
    `MMSI: ${mmsi}`,
    `Nama kapal: ${vesselName}`,
    `Score: ${score}`,
    `Koordinat: ${lat}, ${lon}`,
    `Waktu: ${time}`,
    ...modelLines,
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
