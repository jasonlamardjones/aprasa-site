(() => {
  "use strict";

  const dialog = document.getElementById("details-dialog");
  const dialogContent = document.getElementById("details-dialog-content");
  const closeButton = dialog?.querySelector("[data-dialog-close]");
  let dialogTrigger = null;
  let scrollPosition = 0;

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

  function createEditorialFallback(className, label = "Things to Do", note = "A PRASA editorial thumbnail — not an image of this specific activity.") {
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
    image.src = media.src;
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
      "Things to Do",
      "A PRASA editorial thumbnail — not an image of this specific activity."
    );
    ensureSectionMediaSlots(
      "trainings-tools",
      "Trainings, Tools & Opportunities",
      "A PRASA section thumbnail — not provider-specific imagery."
    );
    ensureSectionMediaSlots(
      "organizations-help",
      "Organizations & Ways to Help",
      "A PRASA section thumbnail — not provider-specific imagery."
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
