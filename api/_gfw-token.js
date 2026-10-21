// B.17 (laporan audit, tabel variabel lingkungan): nama token GFW di PDF adalah GFW_API_TOKEN.
// GFW_TOKEN (nama lama) tetap dibaca sebagai cadangan, supaya data GFW di website tidak hilang
// sebelum nama baru ditambahkan di pengaturan Vercel.
export function gfwToken() {
  return process.env.GFW_API_TOKEN || process.env.GFW_TOKEN || "";
}
