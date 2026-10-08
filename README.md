# Ocean Nexus 2026

Dashboard pemantauan maritim untuk perairan Indonesia: posisi kapal dari AIS, kejadian kapal ikan dari Global
Fishing Watch (GFW), dan hasil analisis citra satelit (SAR) yang digabung dengan AIS.

Situs yang berjalan: https://ocean-nexus-dashboard.vercel.app/

Dokumen ini ditujukan untuk tim yang akan menjalankan, memeriksa, atau melanjutkan proyek ini.

## Isi singkat

| Halaman | File | Isi |
|---|---|---|
| Halaman depan, login, menu | `index.html` | Pintu masuk ke halaman lain |
| Dashboard peta | `dashboard.html` | Tiga tab: GFW Events, AIS Live, AI Inference |
| Anomaly Alert Center | `anomaly-alert.html` | Daftar anomali dan pratinjau alert |
| Data & Reports | `data-reports.html` | Tabel data, ekspor CSV, laporan PDF |

Tiga tab di dashboard peta menjawab tiga pertanyaan berbeda:

| Tab | Pertanyaan | Sumber | Waktu data |
|---|---|---|---|
| AIS Live | Sekarang ada kapal apa, di mana? | AISStream | Langsung |
| GFW Events | Beberapa hari terakhir, kapal ikan melakukan apa? | GFW Events API | Telat sekitar 3 hari |
| AI Inference | Kapal mana yang perlu diperiksa? | Analisis citra satelit + AIS + Kalman | Tetap: 2 Feb – 15 Mar 2026 |

## Yang perlu diketahui sebelum memakai

Bagian ini sengaja ditaruh di depan. Beberapa hal di proyek ini belum selesai, dan tampilannya bisa memberi kesan
sebaliknya.

1. **Login belum mengamankan apa pun.** Username dan password 
username : OceanNexus
pw : 12345678
2. **Anomaly Alert Center dan Data & Reports memakai temuan yang sama dengan tab AI Inference.** Datanya dibaca
   `assets/js/anomaly-data.js` dari file kandidat yang juga dipakai dashboard peta (365 temuan), jadi isinya
   mengikuti butir 3 di bawah. Status tiap temuan (New, Reviewed, Sent) hanya tersimpan di browser masing-masing
   dan tidak terlihat pengguna lain. Tombol "Send Alert to Telegram" masih simulasi dan tidak mengirim apa pun.
3. **Temuan di tab AI Inference berasal dari aturan, bukan model.** Kandidat spoofing, go dark, dan transshipment
   dihasilkan `scripts/find-scene-candidates.py` dengan angka batas yang belum punya rujukan jurnal atau peraturan.
   Hasilnya adalah kandidat untuk diperiksa, bukan kesimpulan.
4. **Hasil model H5 yang tampil adalah hasil uji, bukan data langsung.** Tab AI Inference menampilkan prediksi
   alat tangkap untuk 21 kapal uji pembuat model (lihat bagian Model H5). Model belum dijalankan pada AIS langsung.
5. **Data GFW hanya untuk pemakaian non-komersial.** Dokumentasi API GFW menyatakan API-nya hanya tersedia untuk
   keperluan non-komersial. Pemakaian komersial memerlukan izin dari GFW.
6. **AIS Live tidak mencakup seluruh Indonesia.** Datanya berasal dari penerima AIS di darat milik jaringan
   AISStream, sehingga yang terlihat terutama wilayah barat sampai tengah.

## Menjalankan di komputer sendiri

Yang dibutuhkan: Node.js 22 atau lebih baru.

```bash
npm install
cp .env.example .env.local    # lalu isi kuncinya, lihat tabel di bawah
npm run dev
```

Buka http://127.0.0.1:5174/. Perintah `npm run dev` menjalankan tiga hal sekaligus: halaman web, fungsi di folder
`api/`, dan relay AIS yang juga merekam posisi kapal ke `.local-dev/ais-history.sqlite`.

Catatan: fungsi di `api/` dimuat sekali per proses. Setelah mengubah file di `api/`, hentikan lalu jalankan lagi
`npm run dev`.

Untuk menjalankan sebagai satu server tanpa Vite (halaman, `api/`, dan relay AIS dalam satu proses):

```bash
npm run start      # PORT bawaan 3000, HOST bawaan 127.0.0.1
```

Server ini menyajikan halaman langsung dari folder proyek, jadi tidak perlu `npm run build` lebih dulu.

### Kunci dan pengaturan

Semua kunci dibaca dari `.env.local` (lokal) atau Environment Variables (Vercel). File `.env.local` tidak ikut
ke repositori.

| Nama | Wajib | Untuk apa |
|---|---|---|
| `GFW_TOKEN` | Ya | Semua data GFW. Daftar di https://globalfishingwatch.org/our-apis/ |
| `AISSTREAM_API_KEY` | Ya, untuk AIS Live | Posisi kapal langsung. Daftar di https://aisstream.io |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Tidak | Cache dan pembatas permintaan. Tanpa ini tetap jalan |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Tidak | Dipakai `api/telegram/`, yang belum dipanggil halaman mana pun |
| `AIS_HISTORY_DB`, `AIS_HISTORY_DAYS` | Tidak | Lokasi dan lama simpan rekaman AIS |
| `H5_PATH`, `H5_INTERVAL_MIN`, `AIS_LOOKBACK_DAYS` | Tidak | Pengaturan worker model H5 |

Tiap pihak sebaiknya memakai token GFW dan kunci AISStream miliknya sendiri.

## Menayangkan ke Vercel

```bash
vercel deploy --prod
```

File dan folder yang tidak ikut tayang diatur di `.vercelignore`. Isi kunci di Vercel lewat Settings →
Environment Variables.

Di Vercel, relay AIS tidak berjalan (Vercel tidak menjalankan proses yang terus hidup). Karena itu tab AIS Live
di situs yang tayang menyambung ke AISStream langsung dari browser, dan kunci AISStream ikut terkirim ke browser.
Rekaman riwayat AIS hanya ada bila proyek dijalankan sebagai server sendiri.

## Susunan folder

| Folder / file | Isi |
|---|---|
| `index.html`, `dashboard.html`, `anomaly-alert.html`, `data-reports.html` | Halaman |
| `assets/` | CSS, JavaScript, dan logo untuk halaman |
| `api/` | Fungsi server: `gfw/events`, `gfw/track`, `gfw/gear`, `gfw/regions`, `gfw/vessels/search`, `ais/config`, `wind`, `telegram/*` |
| `server/ais-relay.mjs`, `server/ais-history.mjs` | Relay AIS dan perekaman ke SQLite |
| `server/index.mjs` | Server mandiri (`npm run start`) |
| `server/h5-worker.py`, `server/h5-check.py` | Menjalankan dan memeriksa model H5 |
| `scripts/` | Skrip penelitian: Kalman, pencarian kandidat, pengolahan citra satelit |
| `public/` | Data penelitian yang ditampilkan tab AI Inference |
| `docs/` | Catatan alur lama (sebagian sudah tidak sesuai) |

## Sumber data

| Data | Sumber | Catatan |
|---|---|---|
| Kejadian kapal ikan (fishing, encounter, loitering) | GFW Events API | Dibatasi ke ZEE Indonesia. GFW hanya menerapkan batas wilayah bila satu permintaan berisi satu dataset, jadi tiap dataset diminta sendiri-sendiri (`api/gfw/events.js`) |
| Posisi kapal langsung | AISStream | Penerima di darat, cakupan terbatas |
| Angin | NOAA GFS 1° lewat `api/wind.js` | Hanya di tab AIS Live |
| Peta dasar | Esri World Ocean Base | |
| Temuan AI Inference | File di `public/` | Data penelitian, tidak bertambah |
| Pencocokan AIS–SAR (tombol "AIS–SAR" di tab AI Inference) | Deteksi kapal dari radar Sentinel-1 milik GFW, lewat `api/gfw/sar-ais.js` | Titik hijau = cocok dengan AIS, titik merah muda = tidak terlacak AIS. Metode: Paolo dkk. (2024), *Nature* 625:85–91. Posisi per kotak ±1 km; "tidak cocok" belum tentu melanggar |
| Lintasan kapal per jam | Posisi AIS per jam dari GFW, disimpan di `public/ais-sar-tracks/` (256 file, kapal ada di file nomor MMSI mod 256) | Ketelitian ±1 km, bukan AIS mentah. Kalman dihitung di browser dan pada data ini berhimpit dengan garis AIS |

## Model H5

File model `FINAL_4_PIPELINE_MODELS.h5` (324 MB) **tidak ikut di repositori** karena melebihi batas ukuran GitHub.
File itu harus diminta terpisah dan ditaruh di folder utama proyek. Model dan kode pelatihannya dibuat pihak lain;
pemakaiannya perlu izin pembuatnya.

Yang dibutuhkan: Python 3.13 dengan `torch`, `h5py`, `numpy`, `pandas`, `scipy`, `scikit-learn`, `rasterio`.

```bash
python server/h5-worker.py --once     # satu kali putaran pada rekaman AIS
python server/h5-worker.py --report   # ringkasan perbandingan alat tangkap H5 dengan GFW
python server/h5-check.py             # memastikan hasil worker sama dengan hasil pembuat model
```

`h5-check.py` memerlukan folder kode pembuat model, yang juga tidak ikut di repositori.

Hasil pemeriksaan sampai saat ini:

| Model | Yang sudah diperiksa | Hasil |
|---|---|---|
| Alat tangkap | Dibandingkan dengan hasil pembuat model pada 21 kapal uji | Keluaran sama untuk 21 dari 21 kapal. Tebakannya benar untuk 18 dari 21 kapal |
| Spoofing | Dibandingkan dengan hasil pembuat model pada 522 skenario buatan | Keluaran sama untuk 522 dari 522. Belum diuji pada data spoofing sungguhan |
| Go dark | Belum diperiksa | |
| Transshipment | Belum diperiksa | |

Model membutuhkan riwayat AIS yang cukup panjang per kapal (sekitar 120 titik setelah dijarangkan per 10 menit),
sehingga hasil baru muncul setelah rekaman AIS berjalan beberapa hari.

## Pekerjaan yang masih terbuka

- Akun pengguna dan pembagian peran (yang boleh mengubah dan yang hanya melihat).
- Menyimpan status temuan dan riwayat alert di server, supaya sama untuk semua pengguna.
- Menyambungkan pengiriman alert ke Telegram (`api/telegram/alert.js` sudah ada, belum dipanggil).
- Mengganti aturan pencarian kandidat dengan metode yang punya rujukan.
- Menjalankan model H5 pada AIS langsung dan menampilkan hasilnya.
- Tampilan di layar ponsel.
- Laporan PDF di Data & Reports belum memuat logo.
