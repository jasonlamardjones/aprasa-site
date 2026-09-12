(() => {
  "use strict";

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
    const node = document.getElementById("i18n-strings");
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

  const GOVERNED_WHATSAPP_URL = "https://wa.me/message/GC3C5Q4MSF37I1";

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

  // WhatsApp mark, drawn as a solid white glyph on the deep-green launcher.
  const WHATSAPP_MARK = "M19.11 17.2c-.28-.14-1.65-.81-1.9-.9-.26-.1-.44-.14-.63.14-.18.28-.72.9-.88 1.09-.16.18-.32.2-.6.07-.28-.14-1.18-.44-2.25-1.39-.83-.74-1.39-1.65-1.55-1.93-.16-.28-.02-.43.12-.57.13-.13.28-.33.42-.49.14-.17.19-.28.28-.47.09-.18.05-.35-.02-.49-.07-.14-.63-1.51-.86-2.07-.22-.54-.45-.47-.63-.48l-.53-.01c-.19 0-.49.07-.74.35-.26.28-.98.95-.98 2.32s1 2.69 1.14 2.88c.14.18 1.97 3 4.77 4.21.67.29 1.19.46 1.59.59.67.21 1.28.18 1.76.11.54-.08 1.65-.67 1.88-1.32.23-.66.23-1.22.16-1.33-.07-.12-.25-.19-.53-.33Z M23.02 8.98A11.44 11.44 0 0 0 5.36 22.88L3.7 28.95l6.21-1.63a11.44 11.44 0 0 0 13.11-18.34Zm-1.62 15.4a9.52 9.52 0 0 1-11.13 1.42l-.4-.21-3.68.97.98-3.59-.26-.41a9.53 9.53 0 1 1 14.49 1.82Z";

  // Chevrons: light, secondary controls in place of the previous arrow glyphs.
  const CHEVRON_UP = "M6 14.5 12 8.5l6 6";
  const CHEVRON_DOWN = "M6 9.5l6 6 6-6";

  function createWhatsAppIcon() {
    return createIcon("1.9 4.4 24.6 24.6", (svg) => {
      appendPath(svg, WHATSAPP_MARK, {fill: "currentColor"});
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

  function createWhatsAppControl(sourceAnchor) {
    const label = (sourceAnchor.textContent || "").trim();
    if (!label) return null;

    const link = document.createElement("a");
    link.className = "floating-utility floating-utility-whatsapp";
    link.href = sourceAnchor.href;
    if (sourceAnchor.target) link.target = sourceAnchor.target;
    if (sourceAnchor.rel) link.rel = sourceAnchor.rel;
    link.setAttribute("aria-label", label);
    link.title = label;
    link.append(createWhatsAppIcon());
    return link;
  }

  function createHomeNavigationControls(cluster) {
    const nav = document.querySelector(".home-page-nav");
    if (!nav) return;

    const targets = Array.from(nav.querySelectorAll('a[href^="#"]'))
      .map((anchor) => {
        const id = anchor.getAttribute("href")?.slice(1);
        const target = id ? document.getElementById(id) : null;
        const label = (anchor.textContent || "").trim();
        return target && label ? {target, label} : null;
      })
      .filter(Boolean);
    if (!targets.length) return;

    const backTop = document.querySelector("a.back-top[href^=\"#\"]");
    const upLabel = (backTop?.textContent || "").trim();
    if (!upLabel) return;

    const navGroup = document.createElement("div");
    navGroup.className = "floating-nav-controls";

    const up = document.createElement("button");
    up.type = "button";
    up.className = "floating-utility floating-utility-nav";
    up.setAttribute("aria-label", upLabel);
    up.title = upLabel;
    up.append(createChevronIcon(CHEVRON_UP));

    const down = document.createElement("button");
    down.type = "button";
    down.className = "floating-utility floating-utility-nav";
    down.append(createChevronIcon(CHEVRON_DOWN));

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const behavior = () => reducedMotion.matches ? "auto" : "smooth";

    function nextTarget() {
      return targets.find(({target}) => target.getBoundingClientRect().top > 1) || null;
    }

    function update() {
      up.hidden = window.scrollY <= 0;
      const next = nextTarget();
      down.hidden = !next;
      if (next) {
        down.setAttribute("aria-label", next.label);
        down.title = next.label;
      } else {
        down.removeAttribute("aria-label");
        down.removeAttribute("title");
      }
    }

    up.addEventListener("click", () => {
      window.scrollTo({top: 0, behavior: behavior()});
    });
    down.addEventListener("click", () => {
      nextTarget()?.target.scrollIntoView({behavior: behavior(), block: "start"});
    });

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

    const cluster = document.createElement("div");
    cluster.className = "floating-utilities";
    cluster.dataset.floatingUtilities = "";
    cluster.setAttribute("role", "group");
    cluster.setAttribute("aria-label", "A PRASA");
    cluster.append(whatsApp);
    createHomeNavigationControls(cluster);
    document.body.append(cluster);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFloatingUtilities, {once: true});
  } else {
    initFloatingUtilities();
  }
})();
