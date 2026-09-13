(() => {
  "use strict";
  // Resolve a governed JSON island the strict way. getElementById is NOT
  // constrained by tag name, so an earlier <div id="contact-config"> holding
  // JSON is what it returns even when every <script> on the page is correct -
  // and the page would then hand this runtime an ungoverned destination. So:
  // exactly one element may carry the id, and it must BE a JSON script.
  // Anything else is refused and the caller falls back to governed defaults.
  function governedIslandNode(id) {
    const matches = document.querySelectorAll('[id="' + id + '"]');
    if (matches.length !== 1) {
      if (matches.length > 1) console.warn("A PRASA governed island ignored: " + matches.length + " elements carry id " + id + ".");
      return null;
    }
    const node = matches[0];
    if (node.tagName !== "SCRIPT" || (node.getAttribute("type") || "").toLowerCase() !== "application/json") {
      console.warn("A PRASA governed island ignored: id " + id + " belongs to <" + node.tagName.toLowerCase() + ">, not a JSON script.");
      return null;
    }
    return node;
  }

  const dialog = document.getElementById("details-dialog");
  const dialogContent = document.getElementById("details-dialog-content");
  const closeButton = dialog?.querySelector("[data-dialog-close]");
  let dialogTrigger = null;
  let scrollPosition = 0;

  // prasa-launch.js is one shared file loaded from every page at whatever
  // depth that page lives at (src="prasa-launch.js" from the root pages,
  // src="../prasa-launch.js" from about/, src="../../prasa-launch.js" from
  // pt/things-to-do/<slug>/, etc). The runtime-injected asset paths below
  // are root-relative ("assets/..."), so resolve them against this
  // script's own location (like mindelo-essentials.js already does for its
  // GeoJSON fetch) instead of leaving them to resolve against whichever
  // page happens to load the script — otherwise every page except the true
  // root 404s on these images.
  const assetBase = document.currentScript ? new URL(".", document.currentScript.src) : new URL(".", location.href);
  function assetUrl(relativePath) {
    return new URL(relativePath, assetBase).pathname;
  }

  // Governed runtime strings.
  //
  // A live audit found the runtime-injected editorial fallback labels below
  // rendering in English on the Portuguese Home surface. They are injected by
  // this script rather than baked into the page, so the static-page localizer
  // never sees them.
  //
  // The fix follows the incumbent pattern Mindelo Essentials already uses for
  // runtime copy: the builder writes the governed values for the page's own
  // locale into a <script type="application/json" id="i18n-strings"> block,
  // and this script reads them from there. Every value falls back to the exact
  // English string this file used before, so any page without the block --
  // every EN page included -- behaves byte-for-byte as it did.
  //
  // This module never translates. A key absent from the block is a key with no
  // approved Portuguese value yet, and it deliberately keeps its English
  // default rather than acquiring an invented one.
  const RUNTIME_STRINGS_DEFAULTS = {
    mediaFallbackLabel: "Things to Do",
    mediaFallbackNote: "A PRASA editorial thumbnail — not an image of this specific activity.",
    trainingsSectionLabel: "Trainings, Tools & Opportunities",
    organizationsSectionLabel: "Organizations & Ways to Help",
    sectionThumbnailNote: "A PRASA section thumbnail — not provider-specific imagery.",
  };

  function readRuntimeStrings() {
    const node = governedIslandNode("i18n-strings");
    if (!node) return { ...RUNTIME_STRINGS_DEFAULTS };
    let supplied = null;
    try {
      supplied = JSON.parse(node.textContent || "{}");
    } catch {
      return { ...RUNTIME_STRINGS_DEFAULTS };
    }
    const resolved = { ...RUNTIME_STRINGS_DEFAULTS };
    for (const key of Object.keys(RUNTIME_STRINGS_DEFAULTS)) {
      const value = supplied?.[key];
      if (typeof value === "string" && value.length > 0) resolved[key] = value;
    }
    return resolved;
  }

  const STRINGS = readRuntimeStrings();

  function applyMultilingualSequenceMetadata() {
    const sequences = document.querySelectorAll(".lang-forms");
    if (!sequences.length) return;

    const forms = [
      ["prasa", "kea"],
      ["praça", "pt"],
      ["plaza", "es"],
      ["piazza", "it"],
      ["plein", "nl"],
      ["Platz", "de"],
      ["площа", "uk"]
    ];

    sequences.forEach((sequence) => {
      const fragment = document.createDocumentFragment();
      forms.forEach(([label, lang], index) => {
        const span = document.createElement("span");
        span.lang = lang;
        span.textContent = label;
        fragment.append(span);
        if (index < forms.length - 1) fragment.append(document.createTextNode(" · "));
      });
      sequence.replaceChildren(fragment);
    });
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
        max-width: 28ch;
        font-size: .72rem;
        line-height: 1.35;
      }
      .dialog-media.media-fallback {
        min-height: 12rem;
      }
      .spotlight-label {
        display: inline-flex;
        width: fit-content;
        margin: 0 0 .15rem;
        padding: .28rem .55rem;
        border: 1px solid currentColor;
        border-radius: 999px;
        font-size: .72rem;
        font-weight: 700;
        letter-spacing: .04em;
        line-height: 1.2;
        text-transform: uppercase;
      }
      .spotlight-disclosure {
        margin: .15rem 0 .65rem;
        font-size: .78rem;
        line-height: 1.45;
      }
    `;
    document.head.append(style);
  }

  function createEditorialFallback(className, label = STRINGS.mediaFallbackLabel, note = STRINGS.mediaFallbackNote) {
    const media = document.createElement("div");
    media.className = `${className} media-fallback`;
    media.setAttribute("aria-hidden", "true");

    const inner = document.createElement("div");
    inner.className = "media-fallback-inner";

    const symbol = document.createElement("img");
    symbol.src = assetUrl("assets/brand/A_PRASA_Symbol_v2_Primary_Green.svg");
    symbol.alt = "";
    symbol.width = 725;
    symbol.height = 725;

    const fallbackLabel = document.createElement("span");
    fallbackLabel.className = "media-fallback-label";
    fallbackLabel.textContent = label;

    const fallbackNote = document.createElement("span");
    fallbackNote.className = "media-fallback-note";
    fallbackNote.textContent = note;

    inner.append(symbol, fallbackLabel, fallbackNote);
    media.append(inner);
    return media;
  }

  const providerMedia = new Map([
    ["Green Line Tours — São Vicente Guided Tours", {
      src: "assets/card-media/things-to-do/green-line-tours-sao-vicente.jpg",
      alt: "View across Mindelo toward Porto Grande and Monte Cara.",
      width: 1024,
      height: 683
    }],
    ["Sinergia da Matéria: Entre o Bruto e o Traço", {
      src: "assets/card-media/things-to-do/sinergia-da-materia-editorial-fallback.webp",
      alt: "",
      width: 1200,
      height: 900
    }],
    ["Myrtle Atividades Educativas", {
      src: "assets/card-media/trainings-tools/myrtle-learning-programs.webp",
      alt: "An educator and student work together with learning materials beside a periodic table.",
      width: 960,
      height: 720
    }],
    ["HP LIFE", {
      src: "assets/card-media/trainings-tools/hp-life-online-learning.webp",
      alt: "A learner works on a laptop during an HP LIFE study session.",
      width: 472,
      height: 354
    }],
    ["OpenLearn: free courses from The Open University", {
      src: "assets/card-media/trainings-tools/openlearn-free-courses.webp",
      alt: "OpenLearn free-courses banner with learners and a colorful connected-dot pattern.",
      width: 464,
      height: 348
    }],
    ["IEFP PEPE: employment and professional-internship portal", {
      src: "assets/card-media/trainings-tools/iefp-pepe-professional-internship.webp",
      alt: "A professional-internship participant works at a computer in Cabo Verde.",
      width: 480,
      height: 360
    }],
    ["IEFP — Training in São Vicente", {
      src: "assets/card-media/trainings-tools/iefp-sao-vicente-training.webp",
      alt: "A trainee works on an electrical installation panel.",
      width: 484,
      height: 363
    }],
    ["IBM SkillsBuild", {
      src: "assets/card-media/trainings-tools/ibm-skillsbuild-learning.webp",
      alt: "Three learners collaborate around a laptop during a technology project.",
      width: 800,
      height: 600
    }],
    ["Microsoft Learn", {
      src: "assets/card-media/trainings-tools/microsoft-learn-students.webp",
      alt: "Students collaborate around laptops and a tablet.",
      width: 400,
      height: 300
    }],
    ["Cruz Vermelha de Cabo Verde", {
      src: "assets/card-media/organizations-help/cruz-vermelha-voluntariado.webp",
      alt: "Hands clasp in front of a red cross and the word Voluntariado.",
      width: 456,
      height: 342
    }],
    ["Biosfera", {
      src: "assets/card-media/organizations-help/biosfera-conservation-volunteers.webp",
      alt: "Biosfera volunteers survey wildlife with binoculars in a dry island landscape.",
      width: 960,
      height: 720
    }],
    ["Nô Bai Associação", {
      src: "assets/card-media/organizations-help/no-bai-voluntariado.webp",
      alt: "A circle of volunteers stack their hands together.",
      width: 960,
      height: 720
    }],
    ["Associação Espaço Jovem", {
      src: "assets/card-media/organizations-help/espaco-jovem-youth-support.webp",
      alt: "Espaço Jovem volunteers and children gather around a youth art activity.",
      width: 624,
      height: 468
    }],
    ["Aldeias Infantis SOS Cabo Verde", {
      src: "assets/card-media/organizations-help/aldeias-sos-cabo-verde-family.webp",
      alt: "A smiling family embraces outdoors in Cabo Verde.",
      width: 500,
      height: 375
    }],
    ["SabMais", {
      src: "assets/card-media/organizations-help/sabmais-study-volunteering.webp",
      alt: "A SabMais volunteer and student study together in a Mindelo classroom.",
      width: 960,
      height: 720
    }]
  ]);

  function createProviderMedia(className, media) {
    const wrapper = document.createElement("div");
    wrapper.className = className;
    const image = document.createElement("img");
    image.src = assetUrl(media.src);
    image.alt = media.alt;
    image.width = media.width;
    image.height = media.height;
    image.loading = "lazy";
    image.decoding = "async";
    wrapper.append(image);
    return wrapper;
  }

  function applyProviderMedia() {
    providerMedia.forEach((media, title) => {
      const card = ["things-to-do", "trainings-tools", "organizations-help"]
        .map((sectionId) => getCardByTitle(sectionId, title))
        .find(Boolean);
      if (!card) return;

      card.querySelector(":scope > .card-media")?.remove();
      card.prepend(createProviderMedia("card-media", media));

      const record = card.querySelector(".details-template")?.content.querySelector(".dialog-record");
      if (!record) return;
      record.querySelector(":scope > .dialog-media")?.remove();
      record.prepend(createProviderMedia("dialog-media", media));
    });
  }

  function ensureSectionMediaSlots(sectionId, label, note) {
    const section = document.getElementById(sectionId);
    if (!section) return;

    addMediaFoundationStyles();

    section.querySelectorAll(".resource-card").forEach((card) => {
      if (!card.querySelector(":scope > .card-media")) {
        card.prepend(createEditorialFallback("card-media", label, note));
      }

      const template = card.querySelector(".details-template");
      const record = template?.content.querySelector(".dialog-record");
      if (record && !record.querySelector(":scope > .dialog-media")) {
        record.prepend(createEditorialFallback("dialog-media", label, note));
      }
    });
  }

  function getCardByTitle(sectionId, title) {
    const section = document.getElementById(sectionId);
    if (!section) return null;
    return Array.from(section.querySelectorAll(".resource-card")).find((card) => card.querySelector("h3")?.textContent.trim() === title) || null;
  }

  function removeRecurringDanceRecord() {
    getCardByTitle("things-to-do", "Learn Cape Verdean Dance in Mindelo")?.remove();
  }

  function updateMonPikeninFreshness() {
    const card = getCardByTitle("things-to-do", "Mon Pikenin");
    if (!card) return;

    const status = card.querySelector(":scope > .card-status");
    if (status) status.textContent = "29 August 2026 · 10:00–12:00";

    const cardChecked = card.querySelector(":scope > .checked");
    if (cardChecked) cardChecked.textContent = "Checked 17 August 2026";

    const record = card.querySelector(".details-template")?.content.querySelector(".dialog-record");
    if (!record) return;

    record.querySelectorAll(".detail-list > div").forEach((row) => {
      if (row.querySelector("dt")?.textContent.trim() === "Dates") {
        const value = row.querySelector("dd");
        if (value) value.textContent = "29 August 2026 · 10:00–12:00";
      }
    });

    const detailHeading = Array.from(record.querySelectorAll("h3")).find((heading) => heading.textContent.trim() === "Details");
    const detailCopy = detailHeading?.nextElementSibling;
    if (detailCopy?.tagName === "P") {
      detailCopy.textContent = "A children’s session hosted by Alternativa Galeria; the poster does not specify further activity details beyond age and time.";
    }

    const recordChecked = record.querySelector(".checked");
    if (recordChecked) recordChecked.textContent = "Checked 17 August 2026 against the organizer’s published event poster.";
  }

  function applyLocalSpotlight() {
    const card = getCardByTitle("things-to-do", "Green Line Tours — São Vicente Guided Tours");
    if (!card || card.dataset.localSpotlight === "true") return;
    card.dataset.localSpotlight = "true";

    const badge = document.createElement("p");
    badge.className = "spotlight-label";
    badge.textContent = "Local Spotlight";

    const media = card.querySelector(":scope > .card-media");
    if (media) media.insertAdjacentElement("afterend", badge);
    else card.prepend(badge);

    const disclosure = document.createElement("p");
    disclosure.className = "spotlight-disclosure";
    disclosure.textContent = "Local Spotlight is a rotating editorial feature. Businesses do not pay to be selected, and selection does not imply sponsorship or endorsement.";
    const checked = card.querySelector(":scope > .checked");
    if (checked) checked.insertAdjacentElement("afterend", disclosure);
    else card.append(disclosure);

    const record = card.querySelector(".details-template")?.content.querySelector(".dialog-record");
    if (!record) return;

    const dialogBadge = badge.cloneNode(true);
    record.prepend(dialogBadge);

    const dialogDisclosure = disclosure.cloneNode(true);
    const recordChecked = record.querySelector(".checked");
    if (recordChecked) recordChecked.insertAdjacentElement("afterend", dialogDisclosure);
    else record.append(dialogDisclosure);
  }

  function addLearningSpotlight() {
    const section = document.getElementById("trainings-tools");
    const grid = section?.querySelector(".resource-grid");
    if (!grid || grid.querySelector('[data-learning-spotlight="myrtle"]')) return;

    const card = document.createElement("article");
    card.className = "resource-card";
    card.dataset.learningSpotlight = "myrtle";
    card.innerHTML = `
      <p class="spotlight-label">Learning Spotlight</p>
      <p class="card-status">Mindelo · Learning programs</p>
      <h3>Myrtle Atividades Educativas</h3>
      <p class="card-meta">Language, computer, workplace-English and other learning programs</p>
      <p class="provider">Myrtle Atividades Educativas</p>
      <p>Explore language, computer, workplace-English and other learning programs from Myrtle Atividades Educativas in Mindelo.</p>
      <p class="checked">Checked 17 August 2026 against the provider’s current first-party site.</p>
      <div class="card-actions">
        <button class="details-button" type="button" data-details>Details</button>
        <a class="resource-link" href="https://myrtleducativas.com/" target="_blank" rel="noopener noreferrer">Explore Myrtle programs <span aria-hidden="true">↗</span></a>
      </div>
      <template class="details-template">
        <div class="dialog-record">
          <p class="spotlight-label">Learning Spotlight</p>
          <p class="provider">Myrtle Atividades Educativas</p>
          <h2>Myrtle Atividades Educativas</h2>
          <h3>Details</h3>
          <p>Explore language, computer, workplace-English and other learning programs from Myrtle Atividades Educativas in Mindelo.</p>
          <h3>Good to know</h3>
          <p>Programs, schedules, prices and enrollment availability can change. Check current information directly with Myrtle before acting.</p>
          <p class="checked">Checked 17 August 2026 against the provider’s current first-party site.</p>
          <a class="dialog-link" href="https://myrtleducativas.com/" target="_blank" rel="noopener noreferrer">Explore Myrtle programs <span aria-hidden="true">↗</span></a>
        </div>
      </template>
    `;

    grid.prepend(card);
  }

  function prepareHomeEditorialState() {
    removeRecurringDanceRecord();
    updateMonPikeninFreshness();
    addLearningSpotlight();
    applyProviderMedia();

    ensureSectionMediaSlots(
      "things-to-do",
      STRINGS.mediaFallbackLabel,
      STRINGS.mediaFallbackNote
    );
    ensureSectionMediaSlots(
      "trainings-tools",
      STRINGS.trainingsSectionLabel,
      STRINGS.sectionThumbnailNote
    );
    ensureSectionMediaSlots(
      "organizations-help",
      STRINGS.organizationsSectionLabel,
      STRINGS.sectionThumbnailNote
    );

    applyLocalSpotlight();
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
  prepareHomeEditorialState();

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

(() => {
  "use strict";
  // Resolve a governed JSON island the strict way. getElementById is NOT
  // constrained by tag name, so an earlier <div id="contact-config"> holding
  // JSON is what it returns even when every <script> on the page is correct -
  // and the page would then hand this runtime an ungoverned destination. So:
  // exactly one element may carry the id, and it must BE a JSON script.
  // Anything else is refused and the caller falls back to governed defaults.
  function governedIslandNode(id) {
    const matches = document.querySelectorAll('[id="' + id + '"]');
    if (matches.length !== 1) {
      if (matches.length > 1) console.warn("A PRASA governed island ignored: " + matches.length + " elements carry id " + id + ".");
      return null;
    }
    const node = matches[0];
    if (node.tagName !== "SCRIPT" || (node.getAttribute("type") || "").toLowerCase() !== "application/json") {
      console.warn("A PRASA governed island ignored: id " + id + " belongs to <" + node.tagName.toLowerCase() + ">, not a JSON script.");
      return null;
    }
    return node;
  }

  const GOVERNED_WHATSAPP_URL = "https://wa.me/message/GC3C5Q4MSF37I1";

  // Derived WhatsApp destinations, written by the builder from the single
  // governed source in data/contact-channels.json. The canonical number is
  // never a literal in this file: if the island is absent or inconsistent,
  // prefill is simply unavailable and every route falls back to the incumbent
  // short link. That is the fail-closed direction.
  const CONTACT = (() => {
    const inert = {shortLink: GOVERNED_WHATSAPP_URL, numberBaseUrl: null};
    let node = null;
    try {
      node = governedIslandNode("contact-config");
      if (!node) return inert;
      const supplied = JSON.parse(node.textContent || "{}");
      // The short link the builder derived must be the one this file pins.
      // Disagreement means the config and the runtime describe different
      // accounts, which is exactly when not to guess.
      if (supplied.shortLink !== GOVERNED_WHATSAPP_URL) {
        console.warn("A PRASA WhatsApp prefill disabled: configured short link does not match the governed destination.");
        return inert;
      }
      const base = typeof supplied.numberBaseUrl === "string" ? supplied.numberBaseUrl : "";
      if (!/^https:\/\/wa\.me\/[0-9]{8,15}$/.test(base)) {
        if (base) console.warn("A PRASA WhatsApp prefill disabled: configured number destination is not a wa.me number URL.");
        return inert;
      }
      return {shortLink: GOVERNED_WHATSAPP_URL, numberBaseUrl: base};
    } catch {
      return inert;
    }
  })();

  // Governed launcher-panel copy. This IIFE is a separate scope from the
  // dialog module above, so it reads the same governed
  // <script type="application/json" id="i18n-strings"> island itself rather
  // than sharing that module's STRINGS.
  //
  // The defaults below are the governed ENGLISH values and are the fallback
  // for any surface without the block. This file never carries a translation:
  // a Portuguese value reaches it only through the island, which
  // scripts/build-static-pages.mjs, scripts/generate-things-to-do.mjs and
  // scripts/build-mindelo-pt.mjs write for the page's own locale.
  const RUNTIME_STRINGS_DEFAULTS = {
    launcherHeader: "Message A PRASA",
    launcherIntro: "How can we help?",
    launcherQuickActionShare: "Share an event or opportunity",
    launcherQuickActionCorrection: "Report a correction or issue",
    launcherQuickActionQuestion: "Ask a question",
    launcherQuickActionSubmissions: "Learn how submissions work",
    launcherPrimaryAction: "Open WhatsApp",
    launcherSecondaryAction: "Close",
    navBackToTop: "Back to top",
    navScrollDown: "Scroll down",
    prefillShare: "Hi, I found A PRASA through aprasa.org and I’d like to share an event or opportunity.",
    prefillCorrection: "Hi, I came from aprasa.org and I’d like to report a correction or issue I noticed on the website.",
    prefillQuestion: "Hi, I came from aprasa.org and I have a question about something I found on the website.",
    prefillSubmissions: "Hi, I came from aprasa.org and I’d like to learn how submissions to A PRASA work.",
  };

  const STRINGS = (() => {
    const resolved = {...RUNTIME_STRINGS_DEFAULTS};
    let supplied = null;
    try {
      const node = governedIslandNode("i18n-strings");
      if (!node) return resolved;
      supplied = JSON.parse(node.textContent || "{}");
    } catch {
      return resolved;
    }
    for (const key of Object.keys(RUNTIME_STRINGS_DEFAULTS)) {
      const value = supplied?.[key];
      if (typeof value === "string" && value.length > 0) resolved[key] = value;
    }
    return resolved;
  })();

  function normalizeUrl(value) {
    try {
      return new URL(value, window.location.href).href;
    } catch {
      return null;
    }
  }

  function resolveGovernedWhatsAppSource() {
    // Anchors this script created (the panel CTA) are excluded: they are our
    // own governed output, not incumbent page markup, and the CTA legitimately
    // carries the number-based form once an intent is selected.
    const whatsappAnchors = Array.from(document.querySelectorAll('a[href*="wa.me/"]'))
      .filter((anchor) => !anchor.closest("[data-floating-utilities]"));
    if (!whatsappAnchors.length) return null;

    const destinations = new Set(whatsappAnchors.map((anchor) => normalizeUrl(anchor.getAttribute("href"))).filter(Boolean));
    if (destinations.size !== 1 || !destinations.has(GOVERNED_WHATSAPP_URL)) {
      console.warn("A PRASA floating WhatsApp control not initialized: incumbent WhatsApp destination is missing or conflicts with the governed destination.");
      return null;
    }

    const exactAnchors = whatsappAnchors.filter((anchor) => normalizeUrl(anchor.getAttribute("href")) === GOVERNED_WHATSAPP_URL);
    return exactAnchors.find((anchor) => anchor.closest(".footer-contact, .site-footer") && /whatsapp/i.test(anchor.textContent || ""))
      || exactAnchors.find((anchor) => /whatsapp/i.test(anchor.textContent || ""))
      || exactAnchors[0]
      || null;
  }

  // Decorative inline SVG marks. They carry no text, so the control's
  // accessible name keeps coming from the incumbent anchor label (WhatsApp)
  // or the incumbent in-page navigation label (Up/Down) exactly as before —
  // this file still contributes no copy of its own.
  const SVG_NS = "http://www.w3.org/2000/svg";

  function createIcon(viewBox, build) {
    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("class", "floating-utility-icon");
    icon.setAttribute("viewBox", viewBox);
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    build(icon);
    return icon;
  }

  function appendPath(svg, d, attributes) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    for (const [name, value] of Object.entries(attributes || {})) path.setAttribute(name, value);
    svg.append(path);
    return path;
  }

  // WhatsApp mark. Solid silhouette with the handset knocked out through
  // fill-rule="evenodd", rather than the previous hairline outline: at the
  // ~30px the launcher renders it at, thin strokes read as spindly and the
  // tail detaches. The 0 0 24 24 box frames the mark with no manual
  // recentering, so it sits true in the disc.
  const WHATSAPP_MARK = "M12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413A11.815 11.815 0 0 0 12.05 0Z M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.53-.011c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347Z";

  // Chevrons: light, secondary controls in place of the previous arrow glyphs.
  const CHEVRON_UP = "M6 14.5 12 8.5l6 6";
  const CHEVRON_DOWN = "M6 9.5l6 6 6-6";

  function createWhatsAppIcon() {
    return createIcon("0 0 24 24", (svg) => {
      appendPath(svg, WHATSAPP_MARK, {fill: "currentColor", "fill-rule": "evenodd"});
    });
  }

  function createChevronIcon(d) {
    return createIcon("0 0 24 24", (svg) => {
      appendPath(svg, d, {
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.25",
        "stroke-linecap": "round",
        "stroke-linejoin": "round"
      });
    });
  }

  // The launcher is a toggle, not an outbound link: activating it opens the
  // on-site panel below. The single outbound navigation point is the panel's
  // governed "Open WhatsApp" action, which carries the governed destination
  // resolved and asserted above. Nothing here transmits anything to WhatsApp,
  // and a selected quick action is local panel state only.
  const PANEL_ID = "prasa-launcher-panel";
  const PANEL_TITLE_ID = "prasa-launcher-panel-title";

  // Quick action -> its governed prefill string. One entry per action; there is
  // deliberately no generic fallback, so selecting nothing keeps the short link.
  const QUICK_ACTIONS = [
    {labelKey: "launcherQuickActionShare", prefillKey: "prefillShare"},
    {labelKey: "launcherQuickActionCorrection", prefillKey: "prefillCorrection"},
    {labelKey: "launcherQuickActionQuestion", prefillKey: "prefillQuestion"},
    {labelKey: "launcherQuickActionSubmissions", prefillKey: "prefillSubmissions"},
  ];

  const PREFILL_KEYS = QUICK_ACTIONS.map((action) => action.prefillKey);

  /** The governed prefill values actually delivered to this page, as a set. */
  function governedPrefillValues() {
    return new Set(PREFILL_KEYS.map((key) => STRINGS[key]).filter((value) => typeof value === "string" && value.length > 0));
  }

  // Build the number-based destination for one governed prefill. Encoding is
  // done by URLSearchParams, never by hand: the governed strings contain commas,
  // apostrophes and accented characters, and the locale data stores them
  // unencoded exactly as Project 09 approved them.
  function prefillDestination(message) {
    if (!CONTACT.numberBaseUrl || !message) return null;
    const url = new URL(CONTACT.numberBaseUrl);
    url.searchParams.set("text", message);
    return url.href;
  }

  // The complete set of destinations this launcher may navigate to: the
  // governed short link, plus one number-form URL per governed prefill actually
  // delivered to this page. Nothing else is ever produced, so nothing else is
  // ever authorized.
  function authorizedDestinations() {
    const destinations = new Set([GOVERNED_WHATSAPP_URL]);
    for (const message of governedPrefillValues()) {
      const href = prefillDestination(message);
      if (href) destinations.add(href);
    }
    return destinations;
  }

  // Authorization is exact equality against that set, not a component-by-
  // component inspection. Enumerating components means keeping the enumeration
  // exhaustive forever, and the parts a check forgets to look at are exactly
  // where something rides along: userinfo, a fragment, an explicit port, a
  // second parameter, a reordered query. Comparing whole serializations has no
  // such list to keep complete.
  //
  // A spelling the URL parser normalizes onto a member of the set - an
  // upper-case host, an explicit :443 - is authorized, and correctly so: it
  // serializes to the same string, so it IS the same destination, not a second
  // form of one. Anything that does not serialize identically is refused.
  //
  // That includes a different-but-equivalent encoding of the same governed
  // message: URLSearchParams spells a space as a plus sign, and a percent-
  // encoded spelling of the identical text is refused rather than decoded and
  // compared. This is deliberate. Only prefillDestination ever writes this
  // href, so the launcher can never produce the refused spelling, and decoding
  // before comparing would put us back to inspecting parts. A refusal costs
  // nothing anyway: the fallback is the governed short link.
  function isAuthorizedDestination(href) {
    if (typeof href !== "string" || !href) return false;
    let normalized;
    try {
      normalized = new URL(href).href;
    } catch {
      return false;
    }
    return authorizedDestinations().has(normalized);
  }

  function createWhatsAppControl(sourceAnchor) {
    const label = (sourceAnchor.textContent || "").trim();
    if (!label) return null;

    // The incumbent anchor label is governed and already localized per page,
    // so it stays the launcher's accessible name exactly as before.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "floating-utility floating-utility-whatsapp";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", PANEL_ID);
    button.append(createWhatsAppIcon());
    return button;
  }

  function createQuickAction(label) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "launcher-quick-action";
    action.setAttribute("aria-pressed", "false");
    action.textContent = label;
    return action;
  }

  function createPanel(sourceAnchor) {
    const panel = document.createElement("div");
    panel.className = "launcher-panel";
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", PANEL_TITLE_ID);

    // A paragraph rather than a heading: the panel is appended to the end of
    // the document, and a real heading there would land in the page outline
    // after the footer. aria-labelledby gives it the accessible name instead.
    const title = document.createElement("p");
    title.className = "launcher-panel-title";
    title.id = PANEL_TITLE_ID;
    title.textContent = STRINGS.launcherHeader;

    const intro = document.createElement("p");
    intro.className = "launcher-panel-intro";
    intro.textContent = STRINGS.launcherIntro;

    const actions = document.createElement("div");
    actions.className = "launcher-panel-actions";
    const quickActions = QUICK_ACTIONS.map(({labelKey, prefillKey}) => {
      const button = createQuickAction(STRINGS[labelKey]);
      button.dataset.prefillKey = prefillKey;
      return button;
    });

    const cta = document.createElement("a");
    cta.className = "launcher-panel-cta";
    cta.href = sourceAnchor.href;
    if (sourceAnchor.target) cta.target = sourceAnchor.target;
    if (sourceAnchor.rel) cta.rel = sourceAnchor.rel;
    // The accessible name stays the governed "Open WhatsApp": the starter
    // message is what gets sent, not what the control is called.
    cta.textContent = STRINGS.launcherPrimaryAction;

    // Selecting an intent only rewrites where this one link points. Nothing is
    // sent, and no navigation happens, until the visitor activates it.
    function selectedPrefillKey() {
      return quickActions.find((button) => button.getAttribute("aria-pressed") === "true")?.dataset.prefillKey || null;
    }

    function syncDestination() {
      const key = selectedPrefillKey();
      const candidate = key ? prefillDestination(STRINGS[key]) : null;
      // No selection, no governed message, or no usable config: the incumbent
      // short link, unchanged.
      cta.href = candidate && isAuthorizedDestination(candidate) ? candidate : GOVERNED_WHATSAPP_URL;
    }

    for (const action of quickActions) {
      action.addEventListener("click", () => {
        const selected = action.getAttribute("aria-pressed") === "true";
        // Single-select: the panel records one intent at a time.
        for (const other of quickActions) other.setAttribute("aria-pressed", "false");
        action.setAttribute("aria-pressed", selected ? "false" : "true");
        syncDestination();
      });
      actions.append(action);
    }

    // Repair, then block - and across every activation path, not click alone.
    // A middle click dispatches auxclick, and the context menu's "open in new
    // tab" follows the anchor's href directly without dispatching any
    // cancellable activation event at all, so a click-only recheck leaves both
    // of those open. The href is therefore REPAIRED on every event that can
    // precede an activation (pointerdown and mousedown before a middle click,
    // contextmenu before the menu is drawn and reads the href, focus and
    // keydown before Enter, dragstart before a link drag), in the capture
    // phase so it runs before anything else on the element; and it is
    // additionally CANCELLED on the two activation events that are
    // cancellable. By the time any path reads the href, it is already one of
    // the governed destinations.
    function enforceAuthorizedDestination() {
      if (isAuthorizedDestination(cta.href)) return true;
      cta.href = GOVERNED_WHATSAPP_URL;
      console.warn("A PRASA WhatsApp navigation blocked: destination is not one of the two governed forms.");
      return false;
    }

    for (const type of ["pointerdown", "mousedown", "touchstart", "contextmenu", "focus", "keydown", "dragstart"]) {
      cta.addEventListener(type, enforceAuthorizedDestination, true);
    }
    for (const type of ["click", "auxclick"]) {
      cta.addEventListener(type, (event) => {
        if (!enforceAuthorizedDestination()) event.preventDefault();
      });
    }

    syncDestination();

    const close = document.createElement("button");
    close.type = "button";
    close.className = "launcher-panel-close";
    close.textContent = STRINGS.launcherSecondaryAction;

    panel.append(title, intro, actions, cta, close);
    return {panel, close};
  }

  function wireLauncher(button, panel, close) {
    const isOpen = () => !panel.hidden;

    function openPanel() {
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      // Move focus into the panel so its name is announced, without trapping
      // it: Tab continues through the panel and back out to the page.
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

    // Dismiss on an outside pointer press. Focus is not returned here: the
    // visitor's attention has already moved elsewhere on the page.
    document.addEventListener("pointerdown", (event) => {
      if (!isOpen()) return;
      if (panel.contains(event.target) || button.contains(event.target)) return;
      closePanel(false);
    });
  }

  // Floating navigation controls.
  //
  // Reach: Up is available on every surface. Its label is the governed
  // ui.back_to_top value delivered through the runtime-strings block, rather
  // than the in-page "Back to top" anchor the Home-only version borrowed from
  // — Mindelo Essentials carries no such anchor, so borrowing would have left
  // that surface without the control.
  //
  // Down targeting is per-surface, and deliberately not a landmark model:
  //   - Home has a governed in-page nav (.home-page-nav) whose anchors name
  //     real sections, so Down steps through those, exactly as before.
  //   - No other surface has one. Their DOM does not support a reliable
  //     landmark mapping either: the Things-to-Do hub's only regions are
  //     individual event cards, a detail page has exactly one region, and on
  //     About and Mindelo the section headings sit at varying depths behind
  //     wrappers. Mapping any of that would mean targeting on editorial copy,
  //     which is brittle by construction. Those surfaces page the viewport
  //     instead, named by the governed ui.scroll_down string — a model that
  //     reads no page content at all and so cannot be broken by an edit.
  const VIEWPORT_PAGE_OVERLAP = 0.12;

  function homeNavTargets() {
    const nav = document.querySelector(".home-page-nav");
    if (!nav) return [];
    return Array.from(nav.querySelectorAll('a[href^="#"]'))
      .map((anchor) => {
        const id = anchor.getAttribute("href")?.slice(1);
        const target = id ? document.getElementById(id) : null;
        const label = (anchor.textContent || "").trim();
        return target && label ? {target, label} : null;
      })
      .filter(Boolean);
  }

  function atDocumentBottom() {
    const scrollBottom = window.scrollY + window.innerHeight;
    return scrollBottom >= document.documentElement.scrollHeight - 2;
  }

  function createNavigationControls(cluster) {
    const upLabel = STRINGS.navBackToTop;
    if (!upLabel) return;

    const targets = homeNavTargets();

    const navGroup = document.createElement("div");
    navGroup.className = "floating-nav-controls";

    const up = document.createElement("button");
    up.type = "button";
    up.className = "floating-utility floating-utility-nav";
    up.setAttribute("aria-label", upLabel);
    up.title = upLabel;
    up.append(createChevronIcon(CHEVRON_UP));

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const behavior = () => reducedMotion.matches ? "auto" : "smooth";

    up.addEventListener("click", () => {
      window.scrollTo({top: 0, behavior: behavior()});
    });

    // Down is section-aware where a governed in-page nav supplies both the
    // targets and their names, and pages the viewport everywhere else. Both
    // forms exist on every surface now; only the targeting and the name differ.
    const sectionAware = targets.length > 0;
    const down = document.createElement("button");
    down.type = "button";
    down.className = "floating-utility floating-utility-nav";
    down.append(createChevronIcon(CHEVRON_DOWN));
    if (!sectionAware) {
      down.setAttribute("aria-label", STRINGS.navScrollDown);
      down.title = STRINGS.navScrollDown;
    }
    down.addEventListener("click", () => {
      if (sectionAware) {
        nextTarget()?.target.scrollIntoView({behavior: behavior(), block: "start"});
        return;
      }
      // One viewport per press, with a small overlap so the line you were
      // reading stays on screen. Clamped to the document bottom.
      const step = window.innerHeight * (1 - VIEWPORT_PAGE_OVERLAP);
      const limit = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({top: Math.min(window.scrollY + step, limit), behavior: behavior()});
    });

    function nextTarget() {
      return targets.find(({target}) => target.getBoundingClientRect().top > 1) || null;
    }

    // Hiding the control a keyboard user just activated would drop focus to the
    // document, stranding them at the top of the tab order away from the
    // position they just scrolled to. If the button losing visibility is the
    // focused one, hand focus to the nearest surviving control first.
    function keepFocusOnStack(hiding, wasFocused) {
      // wasFocused is sampled BEFORE the element is hidden: by the time it is
      // hidden the browser has already reset activeElement to <body>, so
      // re-reading it here would always miss.
      if (!hiding.hidden || wasFocused !== hiding) return;
      const launcher = cluster.querySelector(".floating-utility-whatsapp");
      const next = [hiding === up ? down : up, launcher].find((el) => el && !el.hidden);
      next?.focus();
    }

    function update() {
      const wasFocused = document.activeElement;
      up.hidden = window.scrollY <= 0;
      if (wasFocused === up) keepFocusOnStack(up, wasFocused);

      if (!sectionAware) {
        // Nothing left to scroll: the only reason to hide the paging Down.
        down.hidden = atDocumentBottom();
        if (wasFocused === down) keepFocusOnStack(down, wasFocused);
        return;
      }

      const next = nextTarget();
      // Hidden once there is no further section AND once the document itself
      // has no more to scroll: a final section taller than the viewport used
      // to leave Down showing with nowhere left to go.
      const hide = !next || atDocumentBottom();
      down.hidden = hide;
      if (wasFocused === down) keepFocusOnStack(down, wasFocused);
      if (!hide) {
        down.setAttribute("aria-label", next.label);
        down.title = next.label;
      } else {
        down.removeAttribute("aria-label");
        down.removeAttribute("title");
      }
    }

    let scheduled = false;
    const scheduleUpdate = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        update();
      });
    };
    window.addEventListener("scroll", scheduleUpdate, {passive: true});
    window.addEventListener("resize", scheduleUpdate);

    navGroup.append(up, down);
    cluster.append(navGroup);
    update();
  }

  function initFloatingUtilities() {
    if (document.querySelector("[data-floating-utilities]")) return;

    const sourceAnchor = resolveGovernedWhatsAppSource();
    if (!sourceAnchor || normalizeUrl(sourceAnchor.href) !== GOVERNED_WHATSAPP_URL) return;

    const whatsApp = createWhatsAppControl(sourceAnchor);
    if (!whatsApp) return;

    const {panel, close} = createPanel(sourceAnchor);
    wireLauncher(whatsApp, panel, close);

    const cluster = document.createElement("div");
    cluster.className = "floating-utilities";
    cluster.dataset.floatingUtilities = "";
    cluster.setAttribute("role", "group");
    cluster.setAttribute("aria-label", "A PRASA");
    // Panel first: the cluster is a bottom-anchored column, so this places the
    // panel above the launcher that opens it.
    cluster.append(panel, whatsApp);
    createNavigationControls(cluster);
    document.body.append(cluster);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFloatingUtilities, {once: true});
  } else {
    initFloatingUtilities();
  }
})();
