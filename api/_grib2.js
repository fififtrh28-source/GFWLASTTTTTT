// Pembaca GRIB2 minimal untuk angin GFS (NOAA): grid lintang-bujur (template 3.0) dengan data
// "simple packing" (5.0), "complex packing" (5.2) atau "complex packing + spatial differencing" (5.3),
// tanpa bitmap dan tanpa nilai kosong. Mengikuti urutan baca pustaka resmi NCEP g2c (comunpack).
//
// decodeGrib2(Uint8Array) → [{ category, number, refTime, forecastHours, nx, ny, la1, lo1, la2, lo2, dx, dy,
//                              scanMode, values: Float32Array }]

function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32(b, o) { return b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
// GRIB memakai tanda-dan-besaran (bit pertama = tanda), bukan komplemen dua.
function s16(b, o) { const v = u16(b, o); return v & 0x8000 ? -(v & 0x7fff) : v; }
function s32(b, o) { const v = u32(b, o); return v >= 2147483648 ? -(v - 2147483648) : v; }
function f32(b, o) { return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false); }

function bitReader(bytes, byteStart) {
  let pos = byteStart * 8;
  return {
    read(n) {
      let v = 0;
      for (let i = 0; i < n; i++) {
        v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
        pos++;
      }
      return v;
    },
    readSigned(n) {
      const sign = this.read(1);
      const v = this.read(n - 1);
      return sign ? -v : v;
    },
    align() { pos = (pos + 7) & ~7; },
  };
}

function unpack(bytes, dataStart, drs, n) {
  const ref = f32(drs.b, drs.o + 11);
  const bscale = Math.pow(2, s16(drs.b, drs.o + 15));
  const dscale = Math.pow(10, -s16(drs.b, drs.o + 17));
  const nbits = drs.b[drs.o + 19];
  const out = new Float32Array(n);
  const r = bitReader(bytes, dataStart);

  if (drs.template === 0) {
    for (let i = 0; i < n; i++) out[i] = ((nbits ? r.read(nbits) : 0) * bscale + ref) * dscale;
    return out;
  }
  if (drs.template !== 2 && drs.template !== 3) throw new Error(`GRIB2: template data 5.${drs.template} tidak didukung`);
  if (drs.b[drs.o + 22] !== 0) throw new Error("GRIB2: data dengan nilai kosong tidak didukung");

  const ngroups = u32(drs.b, drs.o + 31);
  const refWidth = drs.b[drs.o + 35];
  const bitsWidth = drs.b[drs.o + 36];
  const refLength = u32(drs.b, drs.o + 37);
  const lengthInc = drs.b[drs.o + 41];
  const lastLength = u32(drs.b, drs.o + 42);
  const bitsLength = drs.b[drs.o + 46];
  const order = drs.template === 3 ? drs.b[drs.o + 47] : 0;
  const extraBits = drs.template === 3 ? drs.b[drs.o + 48] * 8 : 0;
  if (ngroups === 0) return out.fill(ref * dscale);

  let ival1 = 0, ival2 = 0, minsd = 0;
  if (order && extraBits) {
    ival1 = r.readSigned(extraBits);
    if (order === 2) ival2 = r.readSigned(extraBits);
    minsd = r.readSigned(extraBits);
  }
  const gref = new Float64Array(ngroups);
  const gwidth = new Int32Array(ngroups);
  const glen = new Int32Array(ngroups);
  if (nbits) { for (let j = 0; j < ngroups; j++) gref[j] = r.read(nbits); r.align(); }
  if (bitsWidth) { for (let j = 0; j < ngroups; j++) gwidth[j] = r.read(bitsWidth); r.align(); }
  for (let j = 0; j < ngroups; j++) gwidth[j] += refWidth;
  if (bitsLength) { for (let j = 0; j < ngroups; j++) glen[j] = r.read(bitsLength); r.align(); }
  for (let j = 0; j < ngroups; j++) glen[j] = glen[j] * lengthInc + refLength;
  glen[ngroups - 1] = lastLength;

  const x = new Float64Array(n);
  let k = 0;
  for (let j = 0; j < ngroups; j++) {
    for (let i = 0; i < glen[j] && k < n; i++, k++) x[k] = gref[j] + (gwidth[j] ? r.read(gwidth[j]) : 0);
  }
  if (k !== n) throw new Error(`GRIB2: jumlah nilai ${k} tidak sama dengan ${n}`);

  if (order === 1) {
    x[0] = ival1;
    for (let i = 1; i < n; i++) x[i] = x[i] + minsd + x[i - 1];
  } else if (order === 2) {
    x[0] = ival1;
    x[1] = ival2;
    for (let i = 2; i < n; i++) x[i] = x[i] + minsd + 2 * x[i - 1] - x[i - 2];
  }
  for (let i = 0; i < n; i++) out[i] = (x[i] * bscale + ref) * dscale;
  return out;
}

export function decodeGrib2(bytes) {
  const messages = [];
  let p = 0;
  while (p + 16 <= bytes.length) {
    if (!(bytes[p] === 71 && bytes[p + 1] === 82 && bytes[p + 2] === 73 && bytes[p + 3] === 66)) { p++; continue; } // "GRIB"
    if (bytes[p + 7] !== 2) throw new Error("GRIB: bukan edisi 2");
    const end = p + u32(bytes, p + 8) * 4294967296 + u32(bytes, p + 12);
    const m = {};
    let drs = null;
    let q = p + 16;
    while (q + 5 <= end - 4) {
      const len = u32(bytes, q);
      const sec = bytes[q + 4];
      if (sec === 1) {
        m.refTime = new Date(Date.UTC(u16(bytes, q + 12), bytes[q + 14] - 1, bytes[q + 15], bytes[q + 16], bytes[q + 17], bytes[q + 18])).toISOString();
      } else if (sec === 3) {
        if (u16(bytes, q + 12) !== 0) throw new Error("GRIB2: grid bukan lintang-bujur biasa");
        m.nx = u32(bytes, q + 30);
        m.ny = u32(bytes, q + 34);
        m.la1 = s32(bytes, q + 46) / 1e6;
        m.lo1 = s32(bytes, q + 50) / 1e6;
        m.la2 = s32(bytes, q + 55) / 1e6;
        m.lo2 = s32(bytes, q + 59) / 1e6;
        m.dx = u32(bytes, q + 63) / 1e6;
        m.dy = u32(bytes, q + 67) / 1e6;
        m.scanMode = bytes[q + 71];
      } else if (sec === 4) {
        m.category = bytes[q + 9];
        m.number = bytes[q + 10];
        m.forecastHours = bytes[q + 17] === 1 ? u32(bytes, q + 18) : null; // satuan 1 = jam
      } else if (sec === 5) {
        drs = { b: bytes, o: q, points: u32(bytes, q + 5), template: u16(bytes, q + 9) };
      } else if (sec === 6) {
        if (bytes[q + 5] !== 255) throw new Error("GRIB2: data ber-bitmap tidak didukung");
      } else if (sec === 7) {
        if (!drs) throw new Error("GRIB2: bagian 5 tidak ditemukan");
        m.values = unpack(bytes, q + 5, drs, drs.points);
      }
      q += len;
    }
    if (m.values) messages.push(m);
    p = end;
  }
  return messages;
}
