(() => {
  "use strict";

  const searchInput = document.getElementById("directory-search");
  const status = document.getElementById("result-status");
  const language = document.getElementById("language-select");
  const directoryList = document.getElementById("directory-list");
  const markerByRecordId = new Map();
  let essentialsMap = null;
  let selectedRecordId = null;

  function safeStorageGet(key) {
    try {
      return window.localStorage?.getItem(key) || null;
    } catch (error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage?.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  if (!directoryList) return;

  const categoryGroups = Array.from(directoryList.querySelectorAll(".category-group"));
  const recordRows = Array.from(directoryList.querySelectorAll("[data-record-id]"));

  function countText(n) {
    return `${n} place${n === 1 ? "" : "s"} and service${n === 1 ? "" : "s"} shown.`;
  }

  function applySearch() {
    const query = (searchInput?.value || "").trim().toLocaleLowerCase();
    let visibleCount = 0;

    categoryGroups.forEach((catGroup) => {
      let catHasMatch = false;
      const panel = catGroup.querySelector(":scope > .category-panel");
      if (!panel) return;

      const directRows = Array.from(panel.querySelectorAll(":scope > .provider-row:not(.provider-row--group)"));
      directRows.forEach((row) => {
        const match = !query || row.textContent.toLocaleLowerCase().includes(query);
        row.hidden = !match;
        if (match) {
          catHasMatch = true;
          visibleCount += 1;
        }
      });

      const groups = Array.from(panel.querySelectorAll(":scope > .provider-row--group"));
      groups.forEach((group) => {
        const providerNameMatches =
          !query || (group.querySelector(".provider-name")?.textContent || "").toLocaleLowerCase().includes(query);
        const branchRows = Array.from(group.querySelectorAll(".branch-row"));
        let groupHasMatch = false;
        branchRows.forEach((branch) => {
          const match = !query || providerNameMatches || branch.textContent.toLocaleLowerCase().includes(query);
          branch.hidden = !match;
          if (match) {
            groupHasMatch = true;
            visibleCount += 1;
          }
        });
        group.hidden = !groupHasMatch;
        if (groupHasMatch && query) group.open = true;
        if (groupHasMatch) catHasMatch = true;
      });

      catGroup.hidden = !catHasMatch;
      if (catHasMatch && query) catGroup.open = true;
    });

    if (status) status.textContent = countText(visibleCount);
  }

  searchInput?.addEventListener("input", applySearch);
  applySearch();

  if (language) {
    const stored = safeStorageGet("aprasa-language");
    if (stored && Array.from(language.options).some((option) => option.value === stored)) language.value = stored;
    else language.value = "en";
    language.addEventListener("change", () => safeStorageSet("aprasa-language", language.value));
  }

  function markSelectedRow(recordId) {
    recordRows.forEach((row) => {
      if (row.dataset.recordId === recordId) row.setAttribute("data-map-selected", "true");
      else row.removeAttribute("data-map-selected");
    });
  }

  function highlightMarker(recordId) {
    markerByRecordId.forEach((marker, id) => {
      const el = marker.getElement?.();
      if (!el) return;
      el.classList.toggle("is-selected", id === recordId);
    });
  }

  function syncMapForRecord(recordId) {
    const marker = markerByRecordId.get(recordId);
    highlightMarker(recordId);
    if (marker) {
      essentialsMap?.panTo(marker.getLatLng());
      marker.openPopup();
    }
  }

  function onRowToggle(row) {
    const recordId = row.dataset.recordId;
    if (row.open) {
      selectedRecordId = recordId;
      markSelectedRow(recordId);
      syncMapForRecord(recordId);
    } else if (selectedRecordId === recordId) {
      selectedRecordId = null;
      markSelectedRow(null);
      highlightMarker(null);
    }
  }

  recordRows.forEach((row) => {
    row.addEventListener("toggle", () => onRowToggle(row));
  });

  if (window.matchMedia("(hover: hover)").matches) {
    recordRows.forEach((row) => {
      const recordId = row.dataset.recordId;
      row.addEventListener("mouseenter", () => {
        if (markerByRecordId.has(recordId)) highlightMarker(recordId);
      });
      row.addEventListener("mouseleave", () => {
        highlightMarker(selectedRecordId);
      });
    });
  }

  function openRowFromMap(recordId) {
    const row = document.getElementById(`record-${recordId}`);
    if (!row) return;
    if (searchInput && searchInput.value) {
      searchInput.value = "";
      applySearch();
    }
    const group = row.closest(".provider-row--group");
    const cat = row.closest(".category-group");
    if (cat) cat.open = true;
    if (group) group.open = true;
    const wasOpen = row.open;
    row.open = true;
    if (wasOpen) onRowToggle(row);
    row.scrollIntoView({behavior: "smooth", block: "center"});
    row.querySelector("summary")?.focus({preventScroll: true});
  }

  function enhanceMapGuidance(mapNode) {
    const caption = mapNode.closest(".map-pane")?.querySelector(".map-caption");
    if (!caption) return;
    caption.textContent =
      "Map tiles are a visual aid. Drag the map or use the arrow keys to move; use +/− to zoom. On touch devices, pinch with two fingers to zoom. Trackpad or mouse-wheel zoom is intentionally disabled so normal page scrolling is not trapped by the map.";
    caption.id = caption.id || "map-guidance";
    mapNode.setAttribute("aria-describedby", caption.id);
  }

  async function enhanceMap() {
    const mapNode = document.getElementById("essentials-map");
    if (!mapNode || typeof window.L === "undefined") return;
    if (window.matchMedia("(max-width: 43.99rem)").matches) return;

    try {
      const response = await fetch("data/mindelo-essentials.geojson", {cache: "no-store"});
      if (!response.ok) throw new Error(`GeoJSON HTTP ${response.status}`);
      const geojson = await response.json();
      if (!geojson.features?.length) return;

      essentialsMap = L.map(mapNode, {scrollWheelZoom: false});
      const tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        keepBuffer: 4,
        updateWhenIdle: false,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(essentialsMap);

      tileLayer.on("tileerror", () => {
        mapNode.classList.add("has-tile-error");
      });
      tileLayer.on("load", () => {
        mapNode.classList.remove("has-tile-error");
      });

      const layer = L.geoJSON(geojson, {
        pointToLayer: (feature, latlng) => {
          const props = feature.properties || {};
          return L.marker(latlng, {
            keyboard: true,
            title: props.name || "Mindelo Essentials location",
            icon: L.divIcon({
              className: "essentials-marker",
              html: '<span class="essentials-marker-dot" aria-hidden="true"></span>',
              iconSize: [28, 28],
              iconAnchor: [14, 14],
              popupAnchor: [0, -13]
            })
          });
        },
        onEachFeature: (feature, marker) => {
          const props = feature.properties || {};
          if (!props.id) return;
          markerByRecordId.set(props.id, marker);
          marker.bindPopup(`<strong>${escapeHtml(props.name || "")}</strong><br>${escapeHtml(props.location || "")}`);
          marker.on("click", () => openRowFromMap(props.id));
        }
      }).addTo(essentialsMap);

      layer.eachLayer((marker) => {
        const feature = marker.feature || {};
        const props = feature.properties || {};
        const markerElement = marker.getElement?.();
        if (markerElement) {
          markerElement.setAttribute("aria-label", `Map marker: ${props.name || "Mindelo Essentials location"}. Activate to view the directory record.`);
        }
      });

      essentialsMap.fitBounds(layer.getBounds().pad(0.18), {maxZoom: 15});
      essentialsMap.whenReady(() => essentialsMap.invalidateSize({pan: false}));
      enhanceMapGuidance(mapNode);
      mapNode.classList.add("is-enhanced");

      if (selectedRecordId && markerByRecordId.has(selectedRecordId)) {
        syncMapForRecord(selectedRecordId);
      }
    } catch (error) {
      console.warn("Mindelo Essentials map enhancement unavailable; directory fallback remains active.", error);
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[char]));
  }

  enhanceMap();
})();
