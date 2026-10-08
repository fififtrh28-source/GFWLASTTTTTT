// Untuk versi online di Vercel (tanpa server relay): memberi API key AISStream ke browser supaya
// dashboard bisa tersambung langsung ke AISStream. Pada mode ini key memang terlihat publik.
// Di server sendiri (npm run dev / npm run start) relay AIS yang dipakai, jadi endpoint ini menolak.
export default function handler(req, res) {
  const key = String(process.env.AISSTREAM_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!process.env.VERCEL || !key) return res.status(404).json({ error: "AIS direct mode not available" });
  res.setHeader("cache-control", "no-store");
  res.json({ key });
}
