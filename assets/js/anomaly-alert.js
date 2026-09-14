(function () {
  const dataStore = window.OceanNexusData;
  if (!dataStore) return;

  const state = {
    records: [],
    filtered: [],
    activeTab: "All",
    selectedId: null,
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

  function mapEmbedUrl(record) {
    const lat = Number(record.lat);
    const lon = Number(record.lon);
    const span = 0.06;
    const bbox = [
      (lon - span).toFixed(5),
      (lat - span).toFixed(5),
      (lon + span).toFixed(5),
      (lat + span).toFixed(5),
    ].join(",");
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  function mapFullUrl(record) {
    const lat = Number(record.lat);
    const lon = Number(record.lon);
    return `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=13/${lat.toFixed(5)}/${lon.toFixed(5)}`;
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

    if (!state.filtered.some((record) => record.id === state.selectedId)) {
      state.selectedId = state.filtered[0]?.id || null;
    }
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
    if (!state.filtered.length) {
      elements.tableBody.innerHTML = '<tr><td class="onx-empty" colspan="7">No anomaly records match the current filters.</td></tr>';
      return;
    }

    elements.tableBody.innerHTML = state.filtered.map((record, index) => `
      <tr data-id="${escapeHtml(record.id)}" tabindex="0" class="${record.id === state.selectedId ? "is-selected" : ""}">
        <td>${index + 1}</td>
        <td>
          <span class="onx-vessel-name">
            <strong>${escapeHtml(record.vesselName)}</strong>
            <span>IMO: ${escapeHtml(record.imo)}</span>
          </span>
        </td>
        <td>${escapeHtml(record.mmsi)}</td>
        <td>${escapeHtml(record.anomalyType)}</td>
        <td>${escapeHtml(record.dateLabel)}</td>
        <td>${escapeHtml(record.confidence)}%</td>
        <td>${statusBadge(record.status)}</td>
      </tr>
    `).join("");
  }

  function renderDetail() {
    const record = getSelectedRecord();
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
          <dt>Location</dt>
          <dd>${escapeHtml(record.location)}</dd>
        </div>
        <div>
          <dt>Confidence Score</dt>
          <dd>${escapeHtml(record.confidence)}%</dd>
        </div>
        <div>
          <dt>Last Known Port</dt>
          <dd>${escapeHtml(record.lastKnownPort)}</dd>
        </div>
        <div>
          <dt>Behavior</dt>
          <dd>${escapeHtml(record.behavior)}</dd>
        </div>
        <div>
          <dt>Remarks</dt>
          <dd>${escapeHtml(record.remarks)}</dd>
        </div>
      </dl>

      <div class="onx-mini-map" aria-label="Interactive map for selected vessel">
        <iframe
          class="onx-map-frame"
          title="Interactive map centered on ${escapeHtml(record.vesselName)}"
          src="${escapeHtml(mapEmbedUrl(record))}"
          loading="lazy">
        </iframe>
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
      `Confidence  : ${record.confidence}%`,
      "",
      "Please verify and take necessary action.",
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

    const updated = dataStore.updateAnomaly(record.id, { status: "Sent", remarks: "Telegram alert sent" });
    dataStore.addAlertHistory({
      id: `hist-${Date.now()}`,
      sentAt: dataStore.formatNowWib(),
      vesselName: updated.vesselName,
      mmsi: updated.mmsi,
      anomalyType: updated.anomalyType,
      sentTo: "Telegram",
    });

    closeAlertPreview();
    syncRecords();
    state.selectedId = updated.id;
    renderAll();
    showToast("Alert sent to Ocean Nexus Alert Group. Status updated to Sent.");
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
        renderAll();
      });
    });

    [elements.startDate, elements.endDate, elements.typeFilter, elements.statusFilter, elements.searchInput].forEach((input) => {
      input.addEventListener("input", renderAll);
      input.addEventListener("change", renderAll);
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
    collectElements();
    syncRecords();
    populateTypeFilter();
    state.selectedId = state.records[0]?.id || null;
    bindEvents();
    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
