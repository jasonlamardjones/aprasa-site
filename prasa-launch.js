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

})();
