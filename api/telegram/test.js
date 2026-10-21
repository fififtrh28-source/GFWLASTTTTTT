import { sendProblem } from "../_problem.js";
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
    return sendProblem(res, 405, "Method not allowed");
  }

  const config = telegramConfig();
  if (config.missing.length) {
    return sendProblem(res, 500, "Telegram env belum lengkap", {
      ok: false,
      missing: config.missing,
      expected: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_DEFAULT_CHAT_ID"],
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
    // T-1 (laporan audit, B.7): pesan dan status 502 sama dengan PDF, dikirim dalam format RFC 7807 (C.3).
    // Detail galat hanya dicatat di log server, supaya isi galat (alamat, keterangan Telegram) tidak sampai ke browser.
    console.error("[telegram-test] Internal error:", err); // Log lengkap hanya di server
    return sendProblem(res, 502, "Gagal menghubungi layanan Telegram. Silakan periksa koneksi atau konfigurasi server.", { ok: false });
  }
}
