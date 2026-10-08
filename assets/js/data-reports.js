(function () {
  const dataStore = window.OceanNexusData;
  if (!dataStore) return;

  const state = {
    records: [],
    filtered: [],
    selectedIds: new Set(),
    reportRecords: [],
    page: 1,
    perPage: 5,
    filters: {
      start: "",
      end: "",
      type: "",
      status: "",
      flag: "",
      search: "",
    },
  };

  const elements = {};

  function $(selector) {
    return document.querySelector(selector);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function statusClass(status) {
    return `onx-status onx-status-${String(status).toLowerCase()}`;
  }

  function statusBadge(status) {
    return `<span class="${statusClass(status)}">${escapeHtml(status)}</span>`;
  }

  function uniqueValues(key) {
    return [...new Set(state.records.map((record) => record[key]).filter(Boolean))].sort();
  }

  function populateSelect(select, placeholder, values) {
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join("");
  }

  function readFilters() {
    state.filters = {
      start: elements.startDate.value,
      end: elements.endDate.value,
      type: elements.typeFilter.value,
      status: elements.statusFilter.value,
      flag: elements.flagFilter.value,
      search: elements.searchInput.value.trim().toLowerCase(),
    };
  }

  function applyFilters() {
    const filters = state.filters;
    state.filtered = state.records.filter((record) => {
      const day = record.dateISO.slice(0, 10);
      const matchesStart = !filters.start || day >= filters.start;
      const matchesEnd = !filters.end || day <= filters.end;
      const matchesType = !filters.type || record.anomalyType === filters.type;
      const matchesStatus = !filters.status || record.status === filters.status;
      const matchesFlag = !filters.flag || record.flag === filters.flag;
      const haystack = `${record.vesselName} ${record.mmsi} ${record.imo}`.toLowerCase();
      const matchesSearch = !filters.search || haystack.includes(filters.search);
      return matchesStart && matchesEnd && matchesType && matchesStatus && matchesFlag && matchesSearch;
    });

    const maxPage = Math.max(1, Math.ceil(state.filtered.length / state.perPage));
    state.page = Math.min(state.page, maxPage);
  }

  function getCurrentPageRecords() {
    const start = (state.page - 1) * state.perPage;
    return state.filtered.slice(start, start + state.perPage);
  }

  function getSelectedRecords() {
    return state.records.filter((record) => state.selectedIds.has(record.id));
  }

  function getReportRecords() {
    const selected = getSelectedRecords();
    return selected.length ? selected : state.filtered;
  }

  function renderSummary() {
    const summary = dataStore.getSummary(state.filtered);
    elements.totalCount.textContent = summary.total;
    elements.newCount.textContent = summary.newCount;
    elements.reviewedCount.textContent = summary.reviewed;
    elements.sentCount.textContent = summary.sent;
  }

  function renderTable() {
    const rows = getCurrentPageRecords();
    const maxPage = Math.max(1, Math.ceil(state.filtered.length / state.perPage));
    const startNumber = (state.page - 1) * state.perPage;

    if (!rows.length) {
      elements.tableBody.innerHTML = '<tr><td class="onx-empty" colspan="8">No detection records match the current filters.</td></tr>';
    } else {
      elements.tableBody.innerHTML = rows.map((record, index) => `
        <tr data-id="${escapeHtml(record.id)}">
          <td><input class="onx-record-checkbox" type="checkbox" data-id="${escapeHtml(record.id)}" ${state.selectedIds.has(record.id) ? "checked" : ""} aria-label="Select ${escapeHtml(record.vesselName)}"></td>
          <td>${startNumber + index + 1}</td>
          <td>
            <span class="onx-vessel-name">
              <strong>${escapeHtml(record.vesselName)}</strong>
              <span>IMO: ${escapeHtml(record.imo)}</span>
            </span>
          </td>
          <td>${escapeHtml(record.mmsi)}</td>
          <td>${escapeHtml(record.anomalyType)}</td>
          <td>${escapeHtml(record.dateLabel)}</td>
          <td>${escapeHtml(record.basis)}</td>
          <td>${statusBadge(record.status)}</td>
        </tr>
      `).join("");
    }

    elements.pageInfo.textContent = `Page ${state.page} of ${maxPage}`;
    elements.prevPage.disabled = state.page <= 1;
    elements.nextPage.disabled = state.page >= maxPage;

    const visible = rows.map((record) => record.id);
    const checkedCount = visible.filter((id) => state.selectedIds.has(id)).length;
    elements.selectVisible.checked = visible.length > 0 && checkedCount === visible.length;
    elements.selectVisible.indeterminate = checkedCount > 0 && checkedCount < visible.length;
    elements.selectionLabel.textContent = `${state.selectedIds.size} selected`;
  }

  function renderPreview() {
    const records = state.reportRecords.length ? state.reportRecords : getReportRecords();
    const summary = dataStore.getSummary(records);
    const period = getPeriod(records);
    const first = records[0];

    elements.preview.innerHTML = `
      <div class="onx-report-title">
        <h3>OCEAN NEXUS 2026<br>VESSEL ANOMALY REPORT</h3>
      </div>

      <div class="onx-report-section">
        <h4>Report Information</h4>
        <p>Date Generated: ${escapeHtml(dataStore.formatNowWib())}</p>
        <p>Period: ${escapeHtml(period)}</p>
        <p>Institution: Institut Teknologi Sepuluh Nopember</p>
        <p>Partner: PT LEN Industri</p>
      </div>

      <div class="onx-report-section">
        <h4>Summary</h4>
        <ul>
          <li>Total Anomalies: ${summary.total}</li>
          <li>New: ${summary.newCount}</li>
          <li>Reviewed: ${summary.reviewed}</li>
          <li>Sent: ${summary.sent}</li>
        </ul>
      </div>

      <div class="onx-report-section">
        <h4>Vessel Information</h4>
        ${first ? `
          <p>Primary Vessel: ${escapeHtml(first.vesselName)} | MMSI ${escapeHtml(first.mmsi)} | IMO ${escapeHtml(first.imo)} | ${escapeHtml(first.flag)}</p>
        ` : "<p>No records selected.</p>"}
      </div>

      <div class="onx-report-section">
        <h4>Detection Records</h4>
        <table class="onx-report-table">
          <thead>
            <tr>
              <th>Vessel</th>
              <th>MMSI</th>
              <th>Anomaly</th>
              <th>Basis</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${records.slice(0, 6).map((record) => `
              <tr>
                <td>${escapeHtml(record.vesselName)}</td>
                <td>${escapeHtml(record.mmsi)}</td>
                <td>${escapeHtml(record.anomalyType)}</td>
                <td>${escapeHtml(record.basis)}</td>
                <td>${escapeHtml(record.status)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        ${records.length > 6 ? `<p>${records.length - 6} additional records will be included in the downloaded report summary.</p>` : ""}
      </div>
    `;
  }

  function renderAll() {
    applyFilters();
    renderSummary();
    renderTable();
    renderPreview();
  }

  function applyFilterInputs() {
    readFilters();
    state.page = 1;
    state.reportRecords = [];
    elements.downloadPdf.disabled = true;
    renderAll();
  }

  function resetFilters() {
    [elements.startDate, elements.endDate, elements.typeFilter, elements.statusFilter, elements.flagFilter, elements.searchInput].forEach((input) => {
      input.value = "";
    });
    applyFilterInputs();
  }

  function toggleRecord(id, checked) {
    if (checked) {
      state.selectedIds.add(id);
    } else {
      state.selectedIds.delete(id);
    }
    state.reportRecords = [];
    elements.downloadPdf.disabled = true;
    renderAll();
  }

  function exportCsv() {
    const records = state.filtered;
    const headers = ["Vessel Name", "MMSI", "IMO", "Flag", "Vessel Type", "Anomaly Type", "Date & Time (WIB)", "Location (satellite)", "AIS Position", "Basis", "Evidence", "Rule", "Status", "Satellite Scene"];
    const rows = records.map((record) => [
      record.vesselName,
      record.mmsi,
      record.imo,
      record.flag,
      record.shipType,
      record.anomalyType,
      record.detectionTime,
      record.location,
      record.aisLocation,
      record.basis,
      record.evidence,
      record.rule,
      record.status,
      record.scene,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "ocean-nexus-filtered-data.csv");
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function generateReport() {
    state.reportRecords = getReportRecords();
    elements.downloadPdf.disabled = state.reportRecords.length === 0;
    renderPreview();
  }

  async function downloadReportPdf() {
    const records = state.reportRecords.length ? state.reportRecords : getReportRecords();
    if (!records.length) return;
    const blob = await createPdfBlob(records);
    downloadBlob(blob, "ocean-nexus-vessel-anomaly-report.pdf");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function getPeriod(records) {
    if (!records.length) return "No records";
    const sorted = [...records].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    const first = sorted[0].dateLabel.replace(/\s\d{2}:\d{2}$/, "");
    const last = sorted[sorted.length - 1].dateLabel.replace(/\s\d{2}:\d{2}$/, "");
    return first === last ? first : `${first} - ${last}`;
  }

  function bindEvents() {
    elements.applyFilter.addEventListener("click", applyFilterInputs);
    elements.resetFilter.addEventListener("click", resetFilters);
    elements.exportCsv.addEventListener("click", exportCsv);
    elements.generatePdf.addEventListener("click", generateReport);
    elements.downloadPdf.addEventListener("click", downloadReportPdf);

    elements.prevPage.addEventListener("click", () => {
      state.page = Math.max(1, state.page - 1);
      renderAll();
    });

    elements.nextPage.addEventListener("click", () => {
      const maxPage = Math.max(1, Math.ceil(state.filtered.length / state.perPage));
      state.page = Math.min(maxPage, state.page + 1);
      renderAll();
    });

    elements.selectVisible.addEventListener("change", () => {
      getCurrentPageRecords().forEach((record) => {
        if (elements.selectVisible.checked) {
          state.selectedIds.add(record.id);
        } else {
          state.selectedIds.delete(record.id);
        }
      });
      state.reportRecords = [];
      elements.downloadPdf.disabled = true;
      renderAll();
    });

    elements.tableBody.addEventListener("click", (event) => {
      const checkbox = event.target.closest(".onx-record-checkbox");
      if (checkbox) {
        toggleRecord(checkbox.dataset.id, checkbox.checked);
        return;
      }
      const row = event.target.closest("tr[data-id]");
      if (!row) return;
      toggleRecord(row.dataset.id, !state.selectedIds.has(row.dataset.id));
    });
  }

  function collectElements() {
    elements.totalCount = $("#total-count");
    elements.newCount = $("#new-count");
    elements.reviewedCount = $("#reviewed-count");
    elements.sentCount = $("#sent-count");
    elements.startDate = $("#filter-start");
    elements.endDate = $("#filter-end");
    elements.typeFilter = $("#filter-type");
    elements.statusFilter = $("#filter-status");
    elements.flagFilter = $("#filter-flag");
    elements.searchInput = $("#filter-search");
    elements.applyFilter = $("#apply-filter");
    elements.resetFilter = $("#reset-filter");
    elements.exportCsv = $("#export-csv");
    elements.generatePdf = $("#generate-pdf");
    elements.downloadPdf = $("#download-pdf");
    elements.selectVisible = $("#select-visible-records");
    elements.selectionLabel = $("#selection-label");
    elements.tableBody = $("#records-table-body");
    elements.prevPage = $("#prev-page");
    elements.nextPage = $("#next-page");
    elements.pageInfo = $("#page-info");
    elements.preview = $("#report-preview");
  }

  function init() {
    state.records = dataStore.getAnomalies();
    populateSelect(elements.typeFilter, "Anomaly Type", uniqueValues("anomalyType"));
    populateSelect(elements.flagFilter, "Flag", uniqueValues("flag").filter((flag) => flag !== "-"));
    const note = $("#data-source-note");
    if (note) note.textContent = dataStore.getSourceNote();
    bindEvents();
    readFilters();
    renderAll();
  }

  // Data dibaca dari file yang sama dengan dashboard peta, jadi halaman menunggu sampai file itu selesai dimuat.
  document.addEventListener("DOMContentLoaded", () => {
    collectElements();
    elements.tableBody.innerHTML = '<tr><td class="onx-empty" colspan="8">Loading data from the map dashboard...</td></tr>';
    dataStore.ready.then(init);
  });

  function cleanPdfText(value) {
    return String(value ?? "")
      .replace(/\u00b0/g, " deg")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  function asciiBytes(text) {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index) & 0xff;
    }
    return bytes;
  }

  function concatBytes(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    chunks.forEach((chunk) => {
      result.set(chunk, offset);
      offset += chunk.length;
    });
    return result;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function loadLogoAsJpeg(src, maxWidth, maxHeight) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        try {
          const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
          const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
          resolve({
            width,
            height,
            bytes: base64ToBytes(dataUrl.split(",")[1]),
          });
        } catch (error) {
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = src;
    });
  }

  async function createPdfBlob(records) {
    const [lenLogo, itsLogo] = await Promise.all([
      loadLogoAsJpeg("assets/logos/pt-len.png", 120, 46),
      loadLogoAsJpeg("assets/logos/its.png", 150, 52),
    ]);

    const logos = [
      lenLogo ? { name: "Im1", image: lenLogo, x: 452, y: 756, w: 54, h: 20 } : null,
      itsLogo ? { name: lenLogo ? "Im2" : "Im1", image: itsLogo, x: 518, y: 752, w: 56, h: 26 } : null,
    ].filter(Boolean);

    const content = [];
    const op = (line) => content.push(`${line}\n`);
    const text = (value, x, y, size = 10, bold = false) => {
      op(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${cleanPdfText(value)}) Tj ET`);
    };
    const rect = (x, y, width, height, fill) => {
      if (fill) op(`${fill} rg ${x} ${y} ${width} ${height} re f`);
      else op(`${x} ${y} ${width} ${height} re S`);
    };
    const line = (x1, y1, x2, y2) => op(`${x1} ${y1} m ${x2} ${y2} l S`);

    const summary = dataStore.getSummary(records);
    const first = records[0];
    const generated = dataStore.formatNowWib();

    rect(0, 742, 612, 50, "0.02 0.12 0.20");
    logos.forEach((logo) => {
      op(`q ${logo.w} 0 0 ${logo.h} ${logo.x} ${logo.y} cm /${logo.name} Do Q`);
    });
    op("1 1 1 rg");
    text("OCEAN NEXUS 2026", 42, 766, 16, true);
    text("VESSEL ANOMALY REPORT", 42, 750, 11, false);

    op("0.03 0.16 0.25 rg");
    text("Report Information", 42, 712, 12, true);
    op("0.05 0.14 0.20 rg");
    text(`Date Generated: ${generated}`, 42, 694);
    text(`Period: ${getPeriod(records)}`, 42, 678);
    text("Institution: Institut Teknologi Sepuluh Nopember", 318, 694);
    text("Partner: PT LEN Industri", 318, 678);

    op("0.03 0.16 0.25 rg");
    text("1. Summary", 42, 628, 12, true);
    op("0.05 0.14 0.20 rg");
    text(`Total Anomalies: ${summary.total}`, 42, 610);
    text(`New: ${summary.newCount}`, 190, 610);
    text(`Reviewed: ${summary.reviewed}`, 280, 610);
    text(`Sent: ${summary.sent}`, 402, 610);

    op("0.03 0.16 0.25 rg");
    text("2. Vessel Information", 42, 560, 12, true);
    op("0.05 0.14 0.20 rg");
    if (first) {
      text(`Vessel Name: ${first.vesselName}`, 42, 542);
      text(`MMSI: ${first.mmsi}`, 42, 526);
      text(`IMO: ${first.imo}`, 218, 526);
      text(`Flag: ${first.flag}`, 362, 526);
    } else {
      text("No records selected.", 42, 542);
    }

    op("0.03 0.16 0.25 rg");
    text("3. Anomaly Details", 42, 492, 12, true);
    op("0.05 0.14 0.20 rg");
    if (first) {
      text(`Anomaly Type: ${first.anomalyType}`, 42, 474);
      text(`Detection Time: ${first.detectionTime}`, 42, 458);
      text(`Location: ${first.location}`, 42, 442);
      text(`Basis: ${first.basis}`, 318, 474);
      text(`Status: ${first.status}`, 318, 458);
      text(`Remarks: ${first.remarks}`, 318, 442);
      wrapText(`Evidence: ${first.evidence}`, 86).forEach((lineText, index) => {
        text(lineText, 42, 420 - (index * 14));
      });
    }

    const tableTop = 354;
    op("0.03 0.16 0.25 rg");
    text("4. Detection Records", 42, 378, 12, true);
    op("0.84 0.93 0.97 rg");
    rect(42, tableTop - 18, 528, 20, "0.84 0.93 0.97");
    op("0.03 0.16 0.25 rg");
    text("Vessel", 50, tableTop - 12, 8, true);
    text("MMSI", 170, tableTop - 12, 8, true);
    text("Anomaly", 242, tableTop - 12, 8, true);
    text("Time", 306, tableTop - 12, 8, true);
    text("Basis", 384, tableTop - 12, 8, true);
    text("Status", 520, tableTop - 12, 8, true);
    op("0.45 0.60 0.70 RG");
    rect(42, tableTop - 18, 528, 20);

    const maxRows = 10;
    records.slice(0, maxRows).forEach((record, index) => {
      const y = tableTop - 40 - (index * 22);
      op("0.80 0.88 0.92 RG");
      rect(42, y - 4, 528, 22);
      op("0.05 0.14 0.20 rg");
      text(record.vesselName, 50, y + 3, 7);
      text(record.mmsi, 170, y + 3, 7);
      text(record.anomalyType, 242, y + 3, 7);
      text(record.dateLabel, 306, y + 3, 7);
      text(record.basis, 384, y + 3, 7);
      text(record.status, 520, y + 3, 7);
    });

    if (records.length > maxRows) {
      text(`${records.length - maxRows} additional records omitted from table view.`, 42, 78, 9);
    }

    op("0.45 0.60 0.70 RG");
    line(42, 54, 570, 54);
    op("0.35 0.45 0.52 rg");
    text("Ocean Nexus 2026 - AI-Driven Maritime Surveillance", 42, 38, 8);

    return assemblePdf(content.join(""), logos);
  }

  function wrapText(text, maxLength) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let current = "";
    words.forEach((word) => {
      if (`${current} ${word}`.trim().length > maxLength) {
        lines.push(current);
        current = word;
      } else {
        current = `${current} ${word}`.trim();
      }
    });
    if (current) lines.push(current);
    return lines.slice(0, 3);
  }

  function assemblePdf(content, logos) {
    const objects = [];

    function addObject(chunks) {
      objects.push(Array.isArray(chunks) ? chunks : [asciiBytes(chunks)]);
      return objects.length;
    }

    function addStream(bytes, dictionary = "") {
      return addObject([
        asciiBytes(`<< ${dictionary}/Length ${bytes.length} >>\nstream\n`),
        bytes,
        asciiBytes("\nendstream"),
      ]);
    }

    function addImage(image) {
      return addObject([
        asciiBytes(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`),
        image.bytes,
        asciiBytes("\nendstream"),
      ]);
    }

    const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
    const imageIds = logos.map((logo) => ({ name: logo.name, id: addImage(logo.image) }));
    const contentId = addStream(asciiBytes(content));
    const pageId = objects.length + 1;
    const pagesId = pageId + 1;
    const catalogId = pageId + 2;
    const xObjects = imageIds.length
      ? `/XObject << ${imageIds.map((image) => `/${image.name} ${image.id} 0 R`).join(" ")} >>`
      : "";

    addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R >> ${xObjects} >> /Contents ${contentId} 0 R >>`);
    addObject(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
    addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    const chunks = [asciiBytes("%PDF-1.4\n")];
    const offsets = [0];
    let length = chunks[0].length;

    objects.forEach((objectChunks, index) => {
      offsets[index + 1] = length;
      const start = asciiBytes(`${index + 1} 0 obj\n`);
      const end = asciiBytes("\nendobj\n");
      chunks.push(start, ...objectChunks, end);
      length += start.length + objectChunks.reduce((sum, chunk) => sum + chunk.length, 0) + end.length;
    });

    const xrefOffset = length;
    const xrefLines = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
    for (let index = 1; index <= objects.length; index += 1) {
      xrefLines.push(`${String(offsets[index]).padStart(10, "0")} 00000 n `);
    }
    const trailer = `${xrefLines.join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    chunks.push(asciiBytes(trailer));

    return new Blob([concatBytes(chunks)], { type: "application/pdf" });
  }
})();
