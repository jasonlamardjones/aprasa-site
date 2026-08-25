(() => {
  "use strict";

  const searchInput = document.getElementById("directory-search");
  const status = document.getElementById("result-status");
  const language = document.getElementById("language-select");
  const directoryList = document.getElementById("directory-list");
  const markerByRecordId = new Map();
  let essentialsMap = null;
  let selectedRecordId = null;

  // Runtime EN/PT strings for this page, embedded by
  // scripts/build-mindelo-pt.mjs as a JSON island (#i18n-strings) so this
  // one shared script renders correct text on both the EN and PT page
  // without hardcoding English. Falls back to the pre-localization English
  // defaults if the island is absent (e.g. a page not yet rebuilt).
  const I18N = (() => {
    const fallback = {
      searchCountOne: "1 place and service shown.",
      searchCountManyTemplate: "{count} places and services shown.",
      mapEnhancedGuidance:
        "Map tiles are a visual aid. Drag the map or use the arrow keys to move; use +/− to zoom. On touch devices, pinch with two fingers to zoom. Trackpad or mouse-wheel zoom is intentionally disabled so normal page scrolling is not trapped by the map.",
      mapDefaultMarkerTitle: "Mindelo Essentials location",
      markerOrientationAccessibleNameTemplate: "Map marker: {name}. Activate to view orientation details.",
      markerDirectoryAccessibleNameTemplate: "Map marker: {name}. Activate to view the directory record.",
      markerOrientationDefaultName: "Orientation landmark",
      markerDirectoryDefaultName: "Mindelo Essentials location",
    };
    try {
      const node = document.getElementById("i18n-strings");
      return node ? {...fallback, ...JSON.parse(node.textContent)} : fallback;
    } catch (error) {
      return fallback;
    }
  })();

  // mindelo-essentials.js is one shared file loaded from both
  // mindelo-essentials/index.html (src="mindelo-essentials.js") and
  // pt/mindelo-essentials/index.html (src="../mindelo-essentials.js").
  // fetch() below resolves relative to the *page* URL, not this script's
  // own location, so a plain "data/..." path would 404 from the PT page
  // (pt/mindelo-essentials/data/... doesn't exist — the canonical data
  // directory is never duplicated per-locale). Resolve against this
  // script's own src instead so the same relative fetch works from either
  // page.
  const scriptBase = document.currentScript ? new URL(".", document.currentScript.src) : new URL(".", location.href);

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

  // Locale-independent search index: for each record, a deterministic,
  // normalized token blob combining canonical identity (name/location/
  // provider) with both the EN and PT category/type presentation — built
  // by scripts/build-mindelo-pt.mjs (mirrors its normalizeToken exactly).
  // This lets an EN-page visitor find a record via its approved Portuguese
  // category term and vice versa, without any translation-guessing at
  // runtime. Falls back to plain DOM textContent search (pre-existing
  // behavior) if the index is missing.
  const searchIndex = (() => {
    try {
      const node = document.getElementById("search-index");
      return node ? JSON.parse(node.textContent) : null;
    } catch (error) {
      return null;
    }
  })();

  function normalizeToken(s) {
    return (s || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function rowMatches(row, normalizedQuery) {
    if (!normalizedQuery) return true;
    if (searchIndex) {
      const recordId = row.dataset.recordId;
      const blob = recordId ? searchIndex[recordId] : null;
      if (blob != null) return blob.includes(normalizedQuery);
    }
    return row.textContent.toLocaleLowerCase().includes(normalizedQuery);
  }

  function countText(n) {
    if (n === 1) return I18N.searchCountOne;
    return I18N.searchCountManyTemplate.replace("{count}", n);
  }

  function applySearch() {
    const query = normalizeToken(searchInput?.value || "");
    let visibleCount = 0;

    categoryGroups.forEach((catGroup) => {
      let catHasMatch = false;
      const panel = catGroup.querySelector(":scope > .category-panel");
      if (!panel) return;

      const directRows = Array.from(panel.querySelectorAll(":scope > .provider-row:not(.provider-row--group)"));
      directRows.forEach((row) => {
        const match = rowMatches(row, query);
        row.hidden = !match;
        if (match) {
          catHasMatch = true;
          visibleCount += 1;
        }
      });

      const groups = Array.from(panel.querySelectorAll(":scope > .provider-row--group"));
      groups.forEach((group) => {
        // The group header (e.g. "Medicentro") isn't itself a canonical
        // record with a search-index entry, so it stays a plain normalized
        // substring check rather than an index lookup.
        const providerNameMatches = !query || normalizeToken(group.querySelector(".provider-name")?.textContent).includes(query);
        const branchRows = Array.from(group.querySelectorAll(".branch-row"));
        let groupHasMatch = false;
        branchRows.forEach((branch) => {
          const match = providerNameMatches || rowMatches(branch, query);
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
    caption.textContent = I18N.mapEnhancedGuidance;
    caption.id = caption.id || "map-guidance";
    mapNode.setAttribute("aria-describedby", caption.id);
  }

  async function enhanceMap() {
    const mapNode = document.getElementById("essentials-map");
    if (!mapNode || typeof window.L === "undefined") return;

    try {
      const response = await fetch(new URL("data/mindelo-essentials.geojson", scriptBase), {cache: "no-store"});
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
            title: props.name || I18N.mapDefaultMarkerTitle,
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
          if (props.feature_kind === "orientation-landmark") {
            marker.bindPopup(`<strong>${escapeHtml(props.name || "")}</strong><br>${escapeHtml(props.location || "")}${props.description ? `<br>${escapeHtml(props.description)}` : ""}`);
            return;
          }
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
          const isOrientation = props.feature_kind === "orientation-landmark";
          const template = isOrientation
            ? I18N.markerOrientationAccessibleNameTemplate
            : I18N.markerDirectoryAccessibleNameTemplate;
          const defaultName = isOrientation ? I18N.markerOrientationDefaultName : I18N.markerDirectoryDefaultName;
          const label = template.replace("{name}", props.name || defaultName);
          markerElement.setAttribute("aria-label", label);
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
