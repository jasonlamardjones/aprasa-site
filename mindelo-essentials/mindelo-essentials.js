(() => {
  "use strict";

  const cards = Array.from(document.querySelectorAll(".directory-card"));
  const search = document.getElementById("directory-search");
  const filters = Array.from(document.querySelectorAll(".filter-chip"));
  const status = document.getElementById("result-status");
  const language = document.getElementById("language-select");
  const markerByRecordId = new Map();
  let activeFilter = "all";
  let essentialsMap = null;

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

  function applyDirectoryFilter() {
    const query = (search?.value || "").trim().toLocaleLowerCase();
    let visible = 0;
    cards.forEach((card) => {
      const categoryMatches = activeFilter === "all" || card.dataset.category === activeFilter;
      const queryMatches = !query || card.textContent.toLocaleLowerCase().includes(query);
      const show = categoryMatches && queryMatches;
      card.hidden = !show;
      if (show) visible += 1;
    });
    if (status) status.textContent = `${visible} place${visible === 1 ? "" : "s"} and service${visible === 1 ? "" : "s"} shown.`;
  }

  function setAllFilterState() {
    activeFilter = "all";
    filters.forEach((item) => {
      const active = item.dataset.filter === "all";
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });
  }

  function clearMapSelection() {
    cards.forEach((card) => {
      card.removeAttribute("data-map-selected");
      card.removeAttribute("aria-current");
    });
  }

  function surfaceDirectoryRecord(recordId) {
    const card = document.getElementById(`record-${recordId}`);
    if (!card) return;

    if (search) search.value = "";
    setAllFilterState();
    applyDirectoryFilter();
    clearMapSelection();

    card.setAttribute("data-map-selected", "true");
    card.setAttribute("aria-current", "location");
    card.setAttribute("tabindex", "-1");
    card.scrollIntoView({behavior: "smooth", block: "center"});
    card.focus({preventScroll: true});
  }

  function addDirectoryMapAction(recordId, marker, mapNode) {
    const card = document.getElementById(`record-${recordId}`);
    if (!card || card.querySelector("[data-show-on-map]")) return;

    let actions = card.querySelector(".record-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "record-actions";
      card.append(actions);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "show-on-map";
    button.dataset.showOnMap = recordId;
    button.textContent = "Show on map";
    button.setAttribute("aria-label", `Show ${card.querySelector("h3")?.textContent || "this location"} on the map`);
    button.addEventListener("click", () => {
      clearMapSelection();
      card.setAttribute("data-map-selected", "true");
      card.setAttribute("aria-current", "location");
      mapNode.scrollIntoView({behavior: "smooth", block: "center"});
      essentialsMap?.panTo(marker.getLatLng());
      marker.openPopup();
      const markerElement = marker.getElement?.();
      if (markerElement) markerElement.focus({preventScroll: true});
      else mapNode.focus({preventScroll: true});
    });
    actions.append(button);
  }

  function enhanceMapGuidance(mapNode) {
    const caption = mapNode.closest(".map-layout")?.querySelector(".map-caption");
    if (!caption) return;
    caption.textContent = "Map tiles are a visual aid. Drag the map or use the arrow keys to move; use +/− to zoom. On touch devices, pinch with two fingers to zoom. Trackpad or mouse-wheel zoom is intentionally disabled so normal page scrolling is not trapped by the map.";
    caption.id = caption.id || "map-guidance";
    mapNode.setAttribute("aria-describedby", caption.id);
  }

  search?.addEventListener("input", applyDirectoryFilter);
  filters.forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter || "all";
      filters.forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      applyDirectoryFilter();
    });
  });

  if (language) {
    const stored = safeStorageGet("aprasa-language");
    if (stored && Array.from(language.options).some((option) => option.value === stored)) language.value = stored;
    else language.value = "en";
    language.addEventListener("change", () => safeStorageSet("aprasa-language", language.value));
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
          marker.on("click", () => surfaceDirectoryRecord(props.id));
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

      markerByRecordId.forEach((marker, recordId) => addDirectoryMapAction(recordId, marker, mapNode));
      essentialsMap.fitBounds(layer.getBounds().pad(0.18), {maxZoom: 15});
      essentialsMap.whenReady(() => essentialsMap.invalidateSize({pan: false}));
      enhanceMapGuidance(mapNode);
      mapNode.classList.add("is-enhanced");
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
