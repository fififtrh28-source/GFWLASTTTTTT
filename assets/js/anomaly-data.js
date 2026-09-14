(function () {
  const STORAGE_KEY = "ocean-nexus-anomalies-v1";
  const HISTORY_KEY = "ocean-nexus-alert-history-v1";

  const baselineAnomalies = [
    {
      id: "hy9",
      vesselName: "HAI YANG 9",
      mmsi: "412345678",
      imo: "9876543",
      flag: "China",
      anomalyType: "Dark Vessel",
      dateISO: "2026-03-12T08:14:00+07:00",
      dateLabel: "12 Mar 2026 08:14",
      detectionTime: "12 Mar 2026, 08:14 WIB",
      location: "5.21\u00b0 S, 112.43\u00b0 E",
      lat: -5.21,
      lon: 112.43,
      confidence: 92,
      status: "New",
      region: "Java Sea",
      lastKnownPort: "Unknown",
      behavior: "No AIS signal for extended period, but SAR detection indicates active vessel.",
      remarks: "Potential IUU Fishing",
    },
    {
      id: "fyy886",
      vesselName: "FU YUAN YU 886",
      mmsi: "413987654",
      imo: "9764211",
      flag: "China",
      anomalyType: "AIS-SAR Mismatch",
      dateISO: "2026-03-12T07:56:00+07:00",
      dateLabel: "12 Mar 2026 07:56",
      detectionTime: "12 Mar 2026, 07:56 WIB",
      location: "4.98\u00b0 S, 111.86\u00b0 E",
      lat: -4.98,
      lon: 111.86,
      confidence: 88,
      status: "New",
      region: "Java Sea",
      lastKnownPort: "Ningbo",
      behavior: "AIS broadcast position differs from SAR vessel detection by more than expected tolerance.",
      remarks: "Requires operator verification",
    },
    {
      id: "zt6",
      vesselName: "ZHONG TAI 6",
      mmsi: "412780114",
      imo: "9643025",
      flag: "China",
      anomalyType: "Unauthorized Area",
      dateISO: "2026-03-12T07:34:00+07:00",
      dateLabel: "12 Mar 2026 07:34",
      detectionTime: "12 Mar 2026, 07:34 WIB",
      location: "6.14\u00b0 S, 113.02\u00b0 E",
      lat: -6.14,
      lon: 113.02,
      confidence: 85,
      status: "New",
      region: "Java Sea",
      lastKnownPort: "Unknown",
      behavior: "Vessel movement enters restricted monitoring polygon without prior clearance metadata.",
      remarks: "Potential unauthorized fishing activity",
    },
    {
      id: "th12",
      vesselName: "TAI HONG 12",
      mmsi: "413550902",
      imo: "9821104",
      flag: "China",
      anomalyType: "Fishing Behavior",
      dateISO: "2026-03-11T22:40:00+07:00",
      dateLabel: "11 Mar 2026 22:40",
      detectionTime: "11 Mar 2026, 22:40 WIB",
      location: "5.74\u00b0 S, 110.65\u00b0 E",
      lat: -5.74,
      lon: 110.65,
      confidence: 81,
      status: "Reviewed",
      region: "Karimata Strait",
      lastKnownPort: "Unknown",
      behavior: "Low-speed repeated turns are consistent with fishing activity inside monitoring area.",
      remarks: "Reviewed by operator",
    },
    {
      id: "lx3",
      vesselName: "LONG XING 3",
      mmsi: "412909771",
      imo: "9712308",
      flag: "China",
      anomalyType: "AIS Gap",
      dateISO: "2026-03-11T19:18:00+07:00",
      dateLabel: "11 Mar 2026 19:18",
      detectionTime: "11 Mar 2026, 19:18 WIB",
      location: "3.86\u00b0 S, 108.72\u00b0 E",
      lat: -3.86,
      lon: 108.72,
      confidence: 79,
      status: "Reviewed",
      region: "Karimata Strait",
      lastKnownPort: "Singapore",
      behavior: "AIS transmission gap detected near high-risk fishing corridor.",
      remarks: "Monitor for repeated gaps",
    },
    {
      id: "sd8",
      vesselName: "SHUN DA 8",
      mmsi: "413771005",
      imo: "9638707",
      flag: "China",
      anomalyType: "Dark Vessel",
      dateISO: "2026-03-10T16:25:00+07:00",
      dateLabel: "10 Mar 2026 16:25",
      detectionTime: "10 Mar 2026, 16:25 WIB",
      location: "6.48\u00b0 S, 112.08\u00b0 E",
      lat: -6.48,
      lon: 112.08,
      confidence: 93,
      status: "Sent",
      region: "Java Sea",
      lastKnownPort: "Unknown",
      behavior: "SAR detection confirms vessel-like object while AIS is inactive.",
      remarks: "Telegram alert sent",
    },
    {
      id: "nl77",
      vesselName: "NAN LING 77",
      mmsi: "412660431",
      imo: "9786650",
      flag: "China",
      anomalyType: "Unauthorized Area",
      dateISO: "2026-03-10T13:08:00+07:00",
      dateLabel: "10 Mar 2026 13:08",
      detectionTime: "10 Mar 2026, 13:08 WIB",
      location: "2.92\u00b0 S, 109.30\u00b0 E",
      lat: -2.92,
      lon: 109.30,
      confidence: 84,
      status: "New",
      region: "Natuna Sea",
      lastKnownPort: "Unknown",
      behavior: "Vessel crossed operational boundary and remained inside the monitored area.",
      remarks: "Potential compliance issue",
    },
    {
      id: "by15",
      vesselName: "BEI YUAN 15",
      mmsi: "412440872",
      imo: "9728046",
      flag: "China",
      anomalyType: "AIS-SAR Mismatch",
      dateISO: "2026-03-09T21:46:00+07:00",
      dateLabel: "09 Mar 2026 21:46",
      detectionTime: "09 Mar 2026, 21:46 WIB",
      location: "7.02\u00b0 S, 114.15\u00b0 E",
      lat: -7.02,
      lon: 114.15,
      confidence: 86,
      status: "Sent",
      region: "Bali Sea",
      lastKnownPort: "Unknown",
      behavior: "AIS broadcast suggests transit path while SAR detection indicates a different vessel position.",
      remarks: "Alert delivered for follow-up",
    },
  ];

  const defaultHistory = [
    {
      id: "hist-sd8",
      sentAt: "10 Mar 2026 16:42 WIB",
      vesselName: "SHUN DA 8",
      mmsi: "413771005",
      anomalyType: "Dark Vessel",
      sentTo: "Telegram",
    },
    {
      id: "hist-by15",
      sentAt: "09 Mar 2026 22:02 WIB",
      vesselName: "BEI YUAN 15",
      mmsi: "412440872",
      anomalyType: "AIS-SAR Mismatch",
      sentTo: "Telegram",
    },
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : clone(fallback);
    } catch (error) {
      return clone(fallback);
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // localStorage can be unavailable in strict browser modes; the UI still works in memory.
    }
  }

  function mergeWithBaseline(savedRecords) {
    const savedById = new Map((Array.isArray(savedRecords) ? savedRecords : []).map((record) => [record.id, record]));
    return baselineAnomalies.map((record) => ({ ...record, ...(savedById.get(record.id) || {}) }));
  }

  function getAnomalies() {
    return clone(mergeWithBaseline(read(STORAGE_KEY, baselineAnomalies)));
  }

  function saveAnomalies(records) {
    write(STORAGE_KEY, records);
  }

  function updateAnomaly(id, patch) {
    const records = getAnomalies();
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return null;
    records[index] = { ...records[index], ...patch };
    saveAnomalies(records);
    return clone(records[index]);
  }

  function getAlertHistory() {
    const history = read(HISTORY_KEY, defaultHistory);
    return clone(Array.isArray(history) ? history : defaultHistory);
  }

  function addAlertHistory(entry) {
    const history = [entry, ...getAlertHistory()].slice(0, 20);
    write(HISTORY_KEY, history);
    return clone(history);
  }

  function formatNowWib() {
    const date = new Date();
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Jakarta",
    }).format(date).replace(",", "") + " WIB";
  }

  function getSummary(records) {
    const source = Array.isArray(records) ? records : getAnomalies();
    const total = source.length;
    const newCount = source.filter((record) => record.status === "New").length;
    const reviewed = source.filter((record) => record.status === "Reviewed").length;
    const sent = source.filter((record) => record.status === "Sent").length;
    const average = total
      ? Math.round(source.reduce((sum, record) => sum + Number(record.confidence || 0), 0) / total)
      : 0;
    return { total, newCount, reviewed, sent, average };
  }

  window.OceanNexusData = {
    getAnomalies,
    saveAnomalies,
    updateAnomaly,
    getAlertHistory,
    addAlertHistory,
    formatNowWib,
    getSummary,
    baselineAnomalies: clone(baselineAnomalies),
  };
})();
