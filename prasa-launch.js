(() => {
  "use strict";

  const dialog = document.getElementById("details-dialog");
  const dialogContent = document.getElementById("details-dialog-content");
  const closeButton = dialog?.querySelector("[data-dialog-close]");
  let dialogTrigger = null;
  let scrollPosition = 0;

  function applyMultilingualSequenceMetadata() {
    const sequence = document.querySelector(".lang-forms");
    if (!sequence) return;

    const forms = [
      ["prasa", "kea"],
      ["praça", "pt"],
      ["plaza", "es"],
      ["piazza", "it"],
      ["plein", "nl"],
      ["Platz", "de"],
      ["площа", "uk"]
    ];

    const fragment = document.createDocumentFragment();
    forms.forEach(([label, lang], index) => {
      const span = document.createElement("span");
      span.lang = lang;
      span.textContent = label;
      fragment.append(span);
      if (index < forms.length - 1) fragment.append(document.createTextNode(" · "));
    });

    sequence.replaceChildren(fragment);
  }

  function addMediaFoundationStyles() {
    if (document.querySelector("style[data-things-media-foundation]")) return;

    const style = document.createElement("style");
    style.dataset.thingsMediaFoundation = "";
    style.textContent = `
      .media-fallback {
        display: grid;
        place-items: center;
        min-height: 9rem;
        padding: 1rem;
        background: var(--cream);
        color: var(--green);
        text-align: center;
      }
      .media-fallback-inner {
        display: grid;
        justify-items: center;
        gap: .55rem;
      }
      .media-fallback img {
        width: 3rem;
        height: auto;
        object-fit: contain;
      }
      .media-fallback-label {
        font-family: var(--serif);
        font-size: 1rem;
        line-height: 1.2;
      }
      .media-fallback-note {
        max-width: 24ch;
        font-size: .72rem;
        line-height: 1.35;
      }
      .dialog-media.media-fallback {
        min-height: 12rem;
      }
    `;
    document.head.append(style);
  }

  function createEditorialFallback(className) {
    const media = document.createElement("div");
    media.className = `${className} media-fallback`;
    media.setAttribute("aria-hidden", "true");

    const inner = document.createElement("div");
    inner.className = "media-fallback-inner";

    const symbol = document.createElement("img");
    symbol.src = "assets/brand/A_PRASA_Symbol_v2_Primary_Green.svg";
    symbol.alt = "";
    symbol.width = 725;
    symbol.height = 725;

    const label = document.createElement("span");
    label.className = "media-fallback-label";
    label.textContent = "Things to Do";

    const note = document.createElement("span");
    note.className = "media-fallback-note";
    note.textContent = "A PRASA editorial thumbnail — not an image of this specific activity.";

    inner.append(symbol, label, note);
    media.append(inner);
    return media;
  }

  function ensureThingsToDoMediaSlots() {
    const section = document.getElementById("things-to-do");
    if (!section) return;

    addMediaFoundationStyles();

    section.querySelectorAll(".resource-card").forEach((card) => {
      if (!card.querySelector(":scope > .card-media")) {
        card.prepend(createEditorialFallback("card-media"));
      }

      const template = card.querySelector(".details-template");
      const record = template?.content.querySelector(".dialog-record");
      if (record && !record.querySelector(":scope > .dialog-media")) {
        record.prepend(createEditorialFallback("dialog-media"));
      }
    });
  }

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

  applyMultilingualSequenceMetadata();
  ensureThingsToDoMediaSlots();

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

})();
