import fs from "node:fs";
import path from "node:path";

const ENV_FILES = [".env", ".env.local", ".env.lokal"];

function loadLocalEnv() {
  for (const fileName of ENV_FILES) {
    const filePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = value;
    }
  }
}

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

export function telegramConfig() {
  loadLocalEnv();
  const token = firstEnv([
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_TOKEN",
    "BOT_TOKEN",
    "TG_BOT_TOKEN",
  ]);
  const chatId = firstEnv([
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_CHATID",
    "TG_CHAT_ID",
    "CHAT_ID",
  ]);
  return {
    token,
    chatId,
    missing: [
      token ? "" : "TELEGRAM_BOT_TOKEN",
      chatId ? "" : "TELEGRAM_CHAT_ID",
    ].filter(Boolean),
  };
}

export async function sendTelegramMessage(text) {
  const config = telegramConfig();
  if (config.missing.length) {
    const readable = config.missing.join(", ");
    throw new Error(`Telegram env belum lengkap: ${readable}`);
  }

  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram sendMessage failed: HTTP ${response.status}`);
  }
  return payload.result;
}
