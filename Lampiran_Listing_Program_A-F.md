# Draf Lampiran Listing Program

Bagian ini disusun berdasarkan Bab 4 Perancangan dan Implementasi Sistem Integrasi AIS-SAR. Lampiran hanya memuat listing program, sedangkan gambar, tabel Excel, dan hasil visual dapat dipisahkan pada lampiran lain.

## LAMPIRAN A
## LISTING PROGRAM PEMERIKSAAN DAN PENYIAPAN DATA AIS-SAR

Listing Program A.1 Kode Pelengkapan Nilai SOG dan COG pada Data AIS  
Sumber file: `scripts/complete-new-dataset-sog-cog.mjs`

Listing Program A.2 Kode Penyiapan Data AIS untuk Proses Kalman Filter  
Sumber file: `scripts/create-kalman-ready-sog-cog.mjs`

Listing Program A.3 Kode Pengambilan Data Event Kapal dari Global Fishing Watch  
Sumber file: `api/gfw/events.js`

Listing Program A.4 Kode Pengambilan Data Track Kapal dari Global Fishing Watch  
Sumber file: `api/gfw/track.js`

Listing Program A.5 Kode Pencarian Identitas Kapal Berdasarkan MMSI atau Vessel ID  
Sumber file: `api/gfw/vessels/search.js`

## LAMPIRAN B
## LISTING PROGRAM ESTIMASI POSISI DAN TRAJECTORY AIS-KALMAN

Listing Program B.1 Kode Implementasi Kalman Filter untuk Estimasi Posisi Kapal  
Sumber file: `scripts/run-kalman-on-ais-sar.mjs`

Listing Program B.2 Kode Konversi SOG dan COG Menjadi Komponen Kecepatan  
Sumber file: `scripts/run-kalman-on-ais-sar.mjs`

Listing Program B.3 Kode Prediksi dan Pembaruan Posisi pada Kalman Filter  
Sumber file: `scripts/run-kalman-on-ais-sar.mjs`

Listing Program B.4 Kode Penyusunan Titik Lintasan AIS Mentah dan Kalman  
Sumber file: `scripts/create-ais-trajectories.mjs`

Listing Program B.5 Kode Penyusunan File GeoJSON Lintasan AIS dan Kalman  
Sumber file: `scripts/create-ais-trajectories.mjs`

Listing Program B.6 Kode Pembuatan Visualisasi Trajectory AIS-Kalman 25 Sequence  
Sumber file: `scripts/build-reference-style-25seq-per-mmsi.mjs`

## LAMPIRAN C
## LISTING PROGRAM MATCHING AIS-SAR DAN PEMBENTUKAN KANDIDAT AKTIVITAS KAPAL

Listing Program C.1 Kode Perhitungan Jarak SAR-AIS dan SAR-Kalman  
Sumber file: `scripts/find-scene-candidates.py`

Listing Program C.2 Kode Penyusunan Fitur Integrasi AIS-SAR  
Sumber file: `scripts/find-scene-candidates.py`

Listing Program C.3 Kode Pembentukan Kandidat Go Dark  
Sumber file: `scripts/find-scene-candidates.py`

Listing Program C.4 Kode Pembentukan Kandidat Spoofing  
Sumber file: `scripts/find-scene-candidates.py`

Listing Program C.5 Kode Pembentukan Kandidat Transshipment  
Sumber file: `scripts/find-scene-candidates.py`

Listing Program C.6 Kode Rekapitulasi Kandidat Alert Aktivitas Kapal  
Sumber file: `scripts/summarize-scene-candidates.py`

## LAMPIRAN D
## LISTING PROGRAM VISUALISASI DASHBOARD INTEGRASI AIS-SAR

Listing Program D.1 Kode Inisialisasi Peta dan Layer Dashboard  
Sumber file: `index.html`

Listing Program D.2 Kode Pembacaan Data Integrasi AIS-SAR pada Dashboard  
Sumber file: `index.html`

Listing Program D.3 Kode Pembentukan Marker Kandidat Aktivitas Kapal pada Peta  
Sumber file: `index.html`

Listing Program D.4 Kode Panel Detail Kapal pada Dashboard  
Sumber file: `index.html`

Listing Program D.5 Kode Penampilan Patch VV/VH pada Panel Kanan  
Sumber file: `index.html`

Listing Program D.6 Kode Penampilan Trajectory AIS 25 Sequence pada Panel Kanan  
Sumber file: `index.html`

Listing Program D.7 Kode Penampilan Trajectory AIS Mentah dan Kalman pada Peta  
Sumber file: `index.html`

Listing Program D.8 Kode Legend dan Keterangan Simbol Dashboard  
Sumber file: `index.html`

## LAMPIRAN E
## LISTING PROGRAM PENGIRIMAN ALERT TELEGRAM

Listing Program E.1 Kode Konfigurasi Token dan Chat ID Telegram  
Sumber file: `api/telegram/_client.js`

Listing Program E.2 Kode Pengujian Koneksi Bot Telegram  
Sumber file: `api/telegram/test.js`

Listing Program E.3 Kode Pengiriman Pesan Alert ke Telegram  
Sumber file: `api/telegram/alert.js`

Listing Program E.4 Kode Format Pesan Alert Telegram  
Sumber file: `api/telegram/alert.js`

Listing Program E.5 Kode Tombol Kirim Alert pada Panel Kanan Dashboard  
Sumber file: `index.html`

## LAMPIRAN F
## LISTING PROGRAM KONFIGURASI APLIKASI DAN API DASHBOARD

Listing Program F.1 Kode Konfigurasi Aplikasi Vite dan Middleware API Lokal  
Sumber file: `vite.config.ts`

Listing Program F.2 Kode Konfigurasi Script Project Dashboard  
Sumber file: `package.json`

Listing Program F.3 Kode Konfigurasi Deployment Vercel  
Sumber file: `vercel.json`

Listing Program F.4 Kode Konfigurasi Cloudflare Worker  
Sumber file: `wrangler.jsonc`

Listing Program F.5 Kode Rate Limit API Dashboard  
Sumber file: `api/_rate-limit.js`

Listing Program F.6 Kode Penyimpanan Cache API Menggunakan Redis atau Memori Lokal  
Sumber file: `api/_redis.js`

Listing Program F.7 Kode Struktur Variabel Lingkungan  
Sumber file: `.env.example`

Catatan: file `.env.lokal` tidak perlu dimasukkan ke lampiran karena berisi token rahasia. Untuk laporan, cukup tampilkan struktur variabel pada `.env.example` atau tulis nama variabel tanpa nilai token.
