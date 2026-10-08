import { SEA_LABELS, CITY_LABELS } from "./onx-map-labels.js";
import { PAGE_SIZE, renderPagination } from "./onx-pagination.js";

(function () {
  const dataStore = window.OceanNexusData;
  if (!dataStore) return;

  const state = {
    records: [],
    filtered: [],
    activeTab: "All",
    selectedId: null,
    page: 1,
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

  function getSelectedRecord() {
    return state.records.find((record) => record.id === state.selectedId) || null;
  }

  // Peta kecil di panel detail: tampilan yang sama dengan dashboard peta (peta dasar Esri Ocean Base, nama laut dan
  // kota Indonesia, titik belah ketupat berwarna sesuai jenis temuan).
  const TYPE_COLOR = { "Spoofing": "#f85149", "Go Dark": "#e3901a", "Transshipment": "#a371f7" };
  let miniMap = null;

  function removeMiniMap() {
    if (!miniMap) return;
    try { miniMap.remove(); } catch { /* wadahnya sudah diganti */ }
    miniMap = null;
  }

  function renderMiniMap(record) {
    removeMiniMap();
    const box = document.getElementById("detail-map");
    const L = window.L;
    const lat = Number(record.lat);
    const lon = Number(record.lon);
    if (!box || !L || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const map = L.map(box, { zoomControl: false, attributionControl: false, scrollWheelZoom: false, minZoom: 4, maxZoom: 12 }).setView([lat, lon], 8);
    miniMap = map;
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.attribution({ position: "topleft", prefix: false }).addTo(map);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, GEBCO, NOAA',
      maxZoom: 12,
    }).addTo(map);

    map.createPane("placeLabels");
    map.getPane("placeLabels").style.zIndex = 450;
    map.getPane("placeLabels").style.pointerEvents = "none";
    const label = (name, la, lo, cls) => L.marker([la, lo], {
      pane: "placeLabels", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="onx-map-label ${cls}">${escapeHtml(name)}</div>` }),
    });
    const labels = [
      ...SEA_LABELS.map(([name, la, lo, minZoom]) => ({ minZoom, maxZoom: 10, marker: label(name, la, lo, "is-sea") })),
      ...CITY_LABELS.map(([name, la, lo, minZoom]) => ({ minZoom, maxZoom: 19, marker: label(name, la, lo, `is-city ${minZoom <= 5 ? "is-major" : minZoom === 6 ? "is-mid" : ""}`) })),
    ];
    const updateLabels = () => {
      const z = map.getZoom();
      for (const l of labels) {
        const show = z >= l.minZoom && z <= l.maxZoom;
        if (show && !map.hasLayer(l.marker)) l.marker.addTo(map);
        else if (!show && map.hasLayer(l.marker)) map.removeLayer(l.marker);
      }
    };
    map.on("zoomend", updateLabels);
    updateLabels();

    L.marker([lat, lon], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="onx-map-diamond" style="--c:${TYPE_COLOR[record.anomalyType] || "#8b949e"}"></div>` }),
    }).addTo(map);
  }

  // Tombol "View on Interactive Map": membuka dashboard peta kita di tab AI Inference, langsung pada temuan ini
  // (id temuan di halaman ini sama dengan kunci temuan di dashboard).
  function mapFullUrl(record) {
    return `dashboard.html#temuan=${encodeURIComponent(record.id)}`;
  }

  function syncRecords() {
    state.records = dataStore.getAnomalies();
  }

  function uniqueValues(key) {
    return [...new Set(state.records.map((record) => record[key]).filter(Boolean))].sort();
  }

  function populateTypeFilter() {
    const types = uniqueValues("anomalyType");
    elements.typeFilter.innerHTML = '<option value="">All Anomaly Types</option>' + types
      .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)
      .join("");
  }

  function getFilters() {
    return {
      start: elements.startDate.value,
      end: elements.endDate.value,
      type: elements.typeFilter.value,
      status: elements.statusFilter.value,
      search: elements.searchInput.value.trim().toLowerCase(),
    };
  }

  function applyFilters() {
    const filters = getFilters();

    state.filtered = state.records.filter((record) => {
      const day = record.dateISO.slice(0, 10);
      const matchesTab = state.activeTab === "All" || record.status === state.activeTab;
      const matchesStart = !filters.start || day >= filters.start;
      const matchesEnd = !filters.end || day <= filters.end;
      const matchesType = !filters.type || record.anomalyType === filters.type;
      const matchesStatus = !filters.status || record.status === filters.status;
      const haystack = `${record.vesselName} ${record.mmsi} ${record.imo}`.toLowerCase();
      const matchesSearch = !filters.search || haystack.includes(filters.search);
      return matchesTab && matchesStart && matchesEnd && matchesType && matchesStatus && matchesSearch;
    });

    const maxPage = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, maxPage);

    // Kalau kapal yang dipilih tidak ada lagi di daftar, pilih baris pertama di halaman yang sedang dibuka
    if (!state.filtered.some((record) => record.id === state.selectedId)) {
      state.selectedId = getCurrentPageRecords()[0]?.id || null;
    }
  }

  function getCurrentPageRecords() {
    const start = (state.page - 1) * PAGE_SIZE;
    return state.filtered.slice(start, start + PAGE_SIZE);
  }

  // Filter atau tab berubah: daftar mulai lagi dari halaman pertama
  function filtersChanged() {
    state.page = 1;
    renderAll();
  }

  function renderSummary() {
    const summary = dataStore.getSummary(state.records);
    elements.totalCount.textContent = summary.total;
    elements.newCount.textContent = summary.newCount;
    elements.reviewedCount.textContent = summary.reviewed;
    elements.sentCount.textContent = summary.sent;
  }

  function renderTabs() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === state.activeTab);
    });
  }

  function renderTable() {
    renderPagination(elements.pagination, {
      page: state.page,
      total: state.filtered.length,
      onPage: (page) => {
        state.page = page;
        renderTable();
      },
    });

    if (!state.filtered.length) {
      elements.tableBody.innerHTML = '<tr><td class="onx-empty" colspan="7">No anomaly records match the current filters.</td></tr>';
      return;
    }

    const startNumber = (state.page - 1) * PAGE_SIZE;
    elements.tableBody.innerHTML = getCurrentPageRecords().map((record, index) => `
      <tr data-id="${escapeHtml(record.id)}" tabindex="0" class="${record.id === state.selectedId ? "is-selected" : ""}">
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

  function renderDetail() {
    const record = getSelectedRecord();
    removeMiniMap();
    if (!record) {
      elements.detailBody.innerHTML = `
        <div class="onx-detail-title">
          <div>
            <h2>No anomaly selected</h2>
            <p>Adjust the filters or select a vessel from the table.</p>
          </div>
        </div>
      `;
      return;
    }

    elements.detailBody.innerHTML = `
      <div class="onx-detail-title">
        <div>
          <h2>${escapeHtml(record.vesselName)}</h2>
          <p>${escapeHtml(record.anomalyType)}</p>
        </div>
        ${statusBadge(record.status)}
      </div>

      <div class="onx-key-grid">
        <div class="onx-key">
          <span>MMSI</span>
          <strong>${escapeHtml(record.mmsi)}</strong>
        </div>
        <div class="onx-key">
          <span>IMO</span>
          <strong>${escapeHtml(record.imo)}</strong>
        </div>
        <div class="onx-key">
          <span>Flag</span>
          <strong>${escapeHtml(record.flag)}</strong>
        </div>
      </div>

      <div class="onx-section-label">Overview</div>
      <dl class="onx-detail-list">
        <div>
          <dt>Anomaly Type</dt>
          <dd>${escapeHtml(record.anomalyType)}</dd>
        </div>
        <div>
          <dt>Detection Time</dt>
          <dd>${escapeHtml(record.detectionTime)}</dd>
        </div>
        <div>
          <dt>Location (satellite)</dt>
          <dd>${escapeHtml(record.location)}</dd>
        </div>
        <div>
          <dt>AIS Position</dt>
          <dd>${escapeHtml(record.aisLocation)}</dd>
        </div>
        <div>
          <dt>Vessel Type</dt>
          <dd>${escapeHtml(record.shipType)}</dd>
        </div>
        <div>
          <dt>Basis of Finding</dt>
          <dd>${escapeHtml(record.evidence)}</dd>
        </div>
        <div>
          <dt>Rule</dt>
          <dd>${escapeHtml(record.rule)}</dd>
        </div>
        <div>
          <dt>Remarks</dt>
          <dd>${escapeHtml(record.remarks)}</dd>
        </div>
      </dl>

      <div class="onx-mini-map" aria-label="Interactive map for selected vessel">
        <div class="onx-map-frame" id="detail-map"></div>
        <div class="onx-map-toolbar">
          <span>${escapeHtml(record.location)}</span>
          <a href="${escapeHtml(mapFullUrl(record))}" target="_blank" rel="noopener">View on Interactive Map</a>
        </div>
      </div>

      <div class="onx-detail-actions">
        <button class="onx-button" type="button" id="mark-reviewed" ${record.status !== "New" ? "disabled" : ""}>Mark as Reviewed</button>
        <button class="onx-button is-primary" type="button" id="open-alert-preview">Send Alert to Telegram</button>
      </div>
    `;

    $("#mark-reviewed")?.addEventListener("click", markSelectedReviewed);
    $("#open-alert-preview")?.addEventListener("click", openAlertPreview);
    renderMiniMap(record);
  }

  function renderHistory() {
    const history = dataStore.getAlertHistory().slice(0, 5);
    if (!history.length) {
      elements.historyBody.innerHTML = '<tr><td class="onx-empty" colspan="5">No alerts have been sent yet.</td></tr>';
      return;
    }

    elements.historyBody.innerHTML = history.map((item) => `
      <tr>
        <td>${escapeHtml(item.sentAt)}</td>
        <td>${escapeHtml(item.vesselName)}</td>
        <td>${escapeHtml(item.mmsi)}</td>
        <td>${escapeHtml(item.anomalyType)}</td>
        <td>${escapeHtml(item.sentTo)}</td>
      </tr>
    `).join("");
  }

  function renderAll() {
    applyFilters();
    renderSummary();
    renderTabs();
    renderTable();
    renderDetail();
    renderHistory();
  }

  function selectRecord(id) {
    state.selectedId = id;
    renderTable();
    renderDetail();
  }

  function updateSelectedStatus(status) {
    const record = getSelectedRecord();
    if (!record) return null;
    const updated = dataStore.updateAnomaly(record.id, { status });
    syncRecords();
    state.selectedId = updated.id;
    renderAll();
    return updated;
  }

  function markSelectedReviewed() {
    const updated = updateSelectedStatus("Reviewed");
    if (updated) {
      showToast(`${updated.vesselName} marked as Reviewed.`);
    }
  }

  function buildAlertText(record) {
    return [
      "OCEAN NEXUS ALERT",
      "Potential vessel anomaly detected",
      "",
      `Vessel Name : ${record.vesselName}`,
      `MMSI        : ${record.mmsi}`,
      `Anomaly Type: ${record.anomalyType}`,
      `Location    : ${record.location}`,
      `Detection Time: ${record.detectionTime}`,
      `Basis       : ${record.basis}`,
      "",
      "Rule-based candidate. Please verify before taking action.",
    ].join("\n");
  }

  function openAlertPreview() {
    const record = getSelectedRecord();
    if (!record) return;
    elements.alertPreview.textContent = buildAlertText(record);
    elements.modal.classList.add("is-open");
    elements.modal.setAttribute("aria-hidden", "false");
  }

  function closeAlertPreview() {
    elements.modal.classList.remove("is-open");
    elements.modal.setAttribute("aria-hidden", "true");
  }

  function sendAlertSimulation() {
    const record = getSelectedRecord();
    if (!record) return;

    // Telegram belum disambungkan: yang terjadi hanya perubahan status di browser ini, tidak ada pesan yang terkirim.
    const updated = dataStore.updateAnomaly(record.id, { status: "Sent", remarks: "Marked as sent (simulation; Telegram is not connected yet)" });
    dataStore.addAlertHistory({
      id: `hist-${Date.now()}`,
      sentAt: dataStore.formatNowWib(),
      vesselName: updated.vesselName,
      mmsi: updated.mmsi,
      anomalyType: updated.anomalyType,
      sentTo: "Telegram (simulation)",
    });

    closeAlertPreview();
    syncRecords();
    state.selectedId = updated.id;
    renderAll();
    showToast("Simulation only: Telegram is not connected yet, so no message was sent. Status updated to Sent.");
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 3200);
  }

  function bindEvents() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.tab;
        filtersChanged();
      });
    });

    [elements.startDate, elements.endDate, elements.typeFilter, elements.statusFilter, elements.searchInput].forEach((input) => {
      input.addEventListener("input", filtersChanged);
      input.addEventListener("change", filtersChanged);
    });

    elements.tableBody.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-id]");
      if (row) selectRecord(row.dataset.id);
    });

    elements.tableBody.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("tr[data-id]");
      if (!row) return;
      event.preventDefault();
      selectRecord(row.dataset.id);
    });

    elements.closeModal.addEventListener("click", closeAlertPreview);
    elements.cancelAlert.addEventListener("click", closeAlertPreview);
    elements.sendAlert.addEventListener("click", sendAlertSimulation);

    elements.modal.addEventListener("click", (event) => {
      if (event.target === elements.modal) closeAlertPreview();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAlertPreview();
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
    elements.searchInput = $("#filter-search");
    elements.tableBody = $("#anomaly-table-body");
    elements.pagination = $("#anomaly-pagination");
    elements.detailBody = $("#anomaly-detail-body");
    elements.historyBody = $("#alert-history-body");
    elements.modal = $("#telegram-modal");
    elements.alertPreview = $("#telegram-preview");
    elements.closeModal = $("#close-telegram-modal");
    elements.cancelAlert = $("#cancel-telegram-alert");
    elements.sendAlert = $("#send-telegram-alert");
    elements.toast = $("#onx-toast");
  }

  function init() {
    syncRecords();
    populateTypeFilter();
    state.selectedId = state.records[0]?.id || null;
    const note = $("#data-source-note");
    if (note) note.textContent = dataStore.getSourceNote();
    bindEvents();
    renderAll();
  }

  // Data dibaca dari file yang sama dengan dashboard peta, jadi halaman menunggu sampai file itu selesai dimuat.
  document.addEventListener("DOMContentLoaded", () => {
    collectElements();
    elements.tableBody.innerHTML = '<tr><td class="onx-empty" colspan="7">Loading data from the map dashboard...</td></tr>';
    dataStore.ready.then(init);
  });
})();
