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

(() => {
  "use strict";

  const GOVERNED_WHATSAPP_URL = "https://wa.me/message/GC3C5Q4MSF37I1";

  // Solid WhatsApp mark (PR #88 treatment), knocked out via fill-rule="evenodd".
  const MINDELO_WHATSAPP_MARK = "M12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413A11.815 11.815 0 0 0 12.05 0Z M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.53-.011c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347Z";

  function normalizeUrl(value) {
    try {
      return new URL(value, window.location.href).href;
    } catch {
      return null;
    }
  }

  function resolveGovernedWhatsAppSource() {
    const whatsappAnchors = Array.from(document.querySelectorAll('a[href*="wa.me/"]'));
    if (!whatsappAnchors.length) return null;

    const destinations = new Set(whatsappAnchors.map((anchor) => normalizeUrl(anchor.getAttribute("href"))).filter(Boolean));
    if (destinations.size !== 1 || !destinations.has(GOVERNED_WHATSAPP_URL)) {
      console.warn("A PRASA floating WhatsApp control not initialized: incumbent WhatsApp destination is missing or conflicts with the governed destination.");
      return null;
    }

    const exactAnchors = whatsappAnchors.filter((anchor) => normalizeUrl(anchor.getAttribute("href")) === GOVERNED_WHATSAPP_URL);
    return exactAnchors.find((anchor) => anchor.closest(".source-section") && /whatsapp/i.test(anchor.textContent || ""))
      || exactAnchors.find((anchor) => /whatsapp/i.test(anchor.textContent || ""))
      || null;
  }

  // Governed launcher-panel copy, read from the same #i18n-strings island
  // scripts/build-mindelo-pt.mjs writes for this page's own locale. The
  // English fallbacks are the governed English values; this file never
  // carries a translation.
  const PANEL_STRINGS = (() => {
    const fallback = {
      launcherHeader: "Message A PRASA",
      launcherIntro: "How can we help?",
      launcherQuickActionShare: "Share an event or opportunity",
      launcherQuickActionCorrection: "Report a correction or issue",
      launcherQuickActionQuestion: "Ask a question",
      launcherQuickActionSubmissions: "Learn how submissions work",
      launcherPrimaryAction: "Open WhatsApp",
      launcherSecondaryAction: "Close",
    };
    try {
      const node = document.getElementById("i18n-strings");
      if (!node) return fallback;
      const supplied = JSON.parse(node.textContent || "{}");
      const resolved = {...fallback};
      for (const key of Object.keys(fallback)) {
        if (typeof supplied?.[key] === "string" && supplied[key].length > 0) resolved[key] = supplied[key];
      }
      return resolved;
    } catch {
      return fallback;
    }
  })();

  const PANEL_ID = "prasa-launcher-panel";
  const PANEL_TITLE_ID = "prasa-launcher-panel-title";
  const QUICK_ACTION_KEYS = [
    "launcherQuickActionShare",
    "launcherQuickActionCorrection",
    "launcherQuickActionQuestion",
    "launcherQuickActionSubmissions",
  ];

  function initFloatingWhatsApp() {
    if (document.querySelector("[data-floating-utilities]")) return;

    const sourceAnchor = resolveGovernedWhatsAppSource();
    if (!sourceAnchor || normalizeUrl(sourceAnchor.href) !== GOVERNED_WHATSAPP_URL) return;

    const label = (sourceAnchor.textContent || "").trim();
    if (!label) return;

    const cluster = document.createElement("div");
    cluster.className = "floating-utilities";
    cluster.dataset.floatingUtilities = "";
    cluster.setAttribute("role", "group");
    cluster.setAttribute("aria-label", "A PRASA");

    // Toggle, not an outbound link: the first activation opens the on-site
    // panel. The panel's governed "Open WhatsApp" action is the single
    // outbound navigation point. Kept in step with the shared implementation
    // in prasa-launch.js so the experience matches every other surface.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "floating-utility floating-utility-whatsapp";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", PANEL_ID);

    const SVG_NS = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("class", "floating-utility-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const mark = document.createElementNS(SVG_NS, "path");
    mark.setAttribute("d", MINDELO_WHATSAPP_MARK);
    mark.setAttribute("fill", "currentColor");
    mark.setAttribute("fill-rule", "evenodd");
    icon.append(mark);
    button.append(icon);

    const panel = document.createElement("div");
    panel.className = "launcher-panel";
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", PANEL_TITLE_ID);

    const title = document.createElement("p");
    title.className = "launcher-panel-title";
    title.id = PANEL_TITLE_ID;
    title.textContent = PANEL_STRINGS.launcherHeader;

    const intro = document.createElement("p");
    intro.className = "launcher-panel-intro";
    intro.textContent = PANEL_STRINGS.launcherIntro;

    const actions = document.createElement("div");
    actions.className = "launcher-panel-actions";
    const quickActions = QUICK_ACTION_KEYS.map((key) => {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "launcher-quick-action";
      action.setAttribute("aria-pressed", "false");
      action.textContent = PANEL_STRINGS[key];
      return action;
    });
    for (const action of quickActions) {
      action.addEventListener("click", () => {
        const selected = action.getAttribute("aria-pressed") === "true";
        // Single-select local panel state. Nothing is transmitted to WhatsApp.
        for (const other of quickActions) other.setAttribute("aria-pressed", "false");
        action.setAttribute("aria-pressed", selected ? "false" : "true");
      });
      actions.append(action);
    }

    const cta = document.createElement("a");
    cta.className = "launcher-panel-cta";
    cta.href = sourceAnchor.href;
    if (sourceAnchor.target) cta.target = sourceAnchor.target;
    if (sourceAnchor.rel) cta.rel = sourceAnchor.rel;
    cta.textContent = PANEL_STRINGS.launcherPrimaryAction;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "launcher-panel-close";
    close.textContent = PANEL_STRINGS.launcherSecondaryAction;

    panel.append(title, intro, actions, cta, close);

    const isOpen = () => !panel.hidden;
    function openPanel() {
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      panel.focus();
    }
    function closePanel(returnFocus) {
      if (!isOpen()) return;
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (returnFocus) button.focus();
    }
    button.addEventListener("click", () => {
      if (isOpen()) closePanel(true);
      else openPanel();
    });
    close.addEventListener("click", () => closePanel(true));
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !isOpen()) return;
      closePanel(true);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!isOpen()) return;
      if (panel.contains(event.target) || button.contains(event.target)) return;
      closePanel(false);
    });

    cluster.append(panel, button);
    document.body.append(cluster);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFloatingWhatsApp, {once: true});
  } else {
    initFloatingWhatsApp();
  }
})();
