import { applyRateLimit } from "../_rate-limit.js";
import { sendTelegramMessage, telegramConfig } from "./_client.js";

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "telegram-test",
    limit: 10,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  if (!["GET", "POST"].includes(req.method || "GET")) {
    return res.status(405).json({ error: "Method not allowed" });
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
    const result = await sendTelegramMessage([
      "TEST ALERT Ocean Nexus",
      "Bot Telegram berhasil tersambung ke dashboard.",
      `Waktu: ${new Date().toISOString()}`,
    ].join("\n"));

    return res.json({
      ok: true,
      message: "Pesan test Telegram berhasil dikirim.",
      telegram_message_id: result?.message_id,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err?.message || "Gagal mengirim Telegram test.",
    });
  }
}
