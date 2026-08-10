(() => {
  "use strict";

  const dialog = document.getElementById("details-dialog");
  const dialogContent = document.getElementById("details-dialog-content");
  const closeButton = dialog?.querySelector("[data-dialog-close]");
  let dialogTrigger = null;
  let scrollPosition = 0;

  function closeDetails() {
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function restorePageAfterDialog() {
    document.body.classList.remove("dialog-open");
    window.scrollTo({top: scrollPosition, behavior: "instant"});
    if (dialogTrigger && document.contains(dialogTrigger)) dialogTrigger.focus({preventScroll: true});
    dialogTrigger = null;
  }

  document.querySelectorAll("[data-details]").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest(".resource-card");
      const template = card?.querySelector(".details-template");
      if (!dialog || !dialogContent || !template) return;

      dialogTrigger = button;
      scrollPosition = window.scrollY;
      dialogContent.replaceChildren(template.content.cloneNode(true));
      const heading = dialogContent.querySelector("h2");
      if (heading) heading.id = "details-dialog-title";
      document.body.classList.add("dialog-open");

      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      closeButton?.focus({preventScroll: true});
    });
  });

  closeButton?.addEventListener("click", closeDetails);
  dialog?.addEventListener("close", restorePageAfterDialog);
  dialog?.addEventListener("cancel", () => {
    // Native dialog Escape handling closes the dialog; the close event restores focus/scroll.
  });
  dialog?.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const withinDialog = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!withinDialog) closeDetails();
  });

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[char]));
  }

  async function enhanceHomeMap() {
    const mapNode = document.getElementById("home-map");
    if (!mapNode || typeof window.L === "undefined") return;
    if (window.matchMedia("(max-width: 43.99rem)").matches) return;

    try {
      const response = await fetch("mindelo-essentials/data/mindelo-essentials.geojson", {cache: "no-store"});
      if (!response.ok) throw new Error(`GeoJSON HTTP ${response.status}`);
      const geojson = await response.json();
      if (!geojson.features?.length) return;

      const map = L.map(mapNode, {scrollWheelZoom: false, dragging: true, keyboard: true, zoomControl: true});
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);

      const layer = L.geoJSON(geojson, {
        pointToLayer: (feature, latlng) => L.marker(latlng, {
          keyboard: true,
          title: feature.properties?.name || "Mindelo Essentials location",
          icon: L.divIcon({
            className: "essentials-marker",
            html: '<span class="essentials-marker-dot" aria-hidden="true"></span>',
            iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -11]
          })
        }),
        onEachFeature: (feature, marker) => {
          const props = feature.properties || {};
          marker.bindPopup(`<strong>${escapeHtml(props.name || "")}</strong><br>${escapeHtml(props.location || "")}`);
        }
      }).addTo(map);

      map.fitBounds(layer.getBounds().pad(0.2), {maxZoom: 14});
      mapNode.classList.add("is-enhanced");
    } catch (error) {
      console.warn("Home map enhancement unavailable; compact directory fallback remains active.", error);
    }
  }

  enhanceHomeMap();
})();
