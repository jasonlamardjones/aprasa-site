(() => {
  "use strict";

  const cards = Array.from(document.querySelectorAll(".directory-card"));
  const search = document.getElementById("directory-search");
  const filters = Array.from(document.querySelectorAll(".filter-chip"));
  const status = document.getElementById("result-status");
  let activeFilter = "all";

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
    if (status) status.textContent = `${visible} Release 1 record${visible === 1 ? "" : "s"} shown.`;
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

  const language = document.getElementById("language-select");
  if (language) {
    const stored = localStorage.getItem("aprasa-language");
    if (stored && Array.from(language.options).some((option) => option.value === stored)) language.value = stored;
    language.addEventListener("change", () => localStorage.setItem("aprasa-language", language.value));
  }

  async function enhanceMap() {
    const mapNode = document.getElementById("essentials-map");
    if (!mapNode || typeof window.L === "undefined") return;

    try {
      const response = await fetch("data/mindelo-essentials.geojson", {cache: "no-store"});
      if (!response.ok) throw new Error(`GeoJSON HTTP ${response.status}`);
      const geojson = await response.json();
      if (!geojson.features?.length) return;

      const map = L.map(mapNode, {scrollWheelZoom: false});
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);

      const layer = L.geoJSON(geojson, {
        pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
          radius: 8, weight: 2, color: "#1E3D2E", fillColor: "#F6F0E2", fillOpacity: 1
        }),
        onEachFeature: (feature, marker) => {
          const props = feature.properties || {};
          marker.bindPopup(`<strong>${escapeHtml(props.name || "")}</strong><br>${escapeHtml(props.location || "")}`);
          marker.on("click", () => {
            const card = document.getElementById(`record-${props.id}`);
            if (card) card.setAttribute("data-map-selected", "true");
          });
        }
      }).addTo(map);

      map.fitBounds(layer.getBounds().pad(0.18), {maxZoom: 15});
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
