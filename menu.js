(function () {
  const btn = document.getElementById("btnMenu");
  const pop = document.getElementById("menuPopover");
  const modalOverlay = document.getElementById("modalOverlay");
  const modal = modalOverlay;
  const modalClose = document.getElementById("modalClose");
  const modalTitle = document.getElementById("modalTitle");
  const sections = modal ? Array.from(modal.querySelectorAll("[data-section]")) : [];
  const triggers = Array.from(document.querySelectorAll("[data-open-section]"));
  const year = document.getElementById("yr");

  if (year) {
    year.textContent = new Date().getFullYear();
  }

  function openMenu() {
    if (!pop || !btn) return;
    pop.dataset.open = "true";
    btn.setAttribute("aria-expanded", "true");
    const first = pop.querySelector("button");
    if (first) first.focus();
  }

  function closeMenu() {
    if (!pop || !btn) return;
    pop.dataset.open = "false";
    btn.setAttribute("aria-expanded", "false");
  }

  function isOpen() {
    return pop?.dataset.open === "true";
  }

  function setSection(sectionId) {
    sections.forEach((section) => {
      const active = section.dataset.section === sectionId;
      section.dataset.active = active ? "true" : "false";
    });
    const activeSection = sections.find((section) => section.dataset.section === sectionId);
    if (activeSection && modalTitle) {
      modalTitle.textContent = activeSection.dataset.title || "T&C";
    }
  }

  function openModal(sectionId) {
    if (!modal) return;
    setSection(sectionId);
    modal.dataset.open = "true";
    modal.setAttribute("aria-hidden", "false");
    const focusTarget = modal.querySelector("[data-active='true'] a, [data-active='true'] button, [data-active='true'] input, [data-active='true'] select, [data-active='true'] textarea") || modalClose;
    if (focusTarget) {
      focusTarget.focus();
    }
  }

  function closeModal() {
    if (!modal) return;
    modal.dataset.open = "false";
    modal.setAttribute("aria-hidden", "true");
  }

  if (btn && pop) {
    btn.addEventListener("click", () => {
      if (isOpen()) closeMenu();
      else openMenu();
    });
  }

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      const target = trigger.dataset.openSection;
      if (target) {
        openModal(target);
      }
      closeMenu();
    });
  });

  if (modalClose) {
    modalClose.addEventListener("click", () => {
      closeModal();
    });
  }

  if (modalOverlay) {
    modalOverlay.addEventListener("click", (event) => {
      if (event.target === modalOverlay) {
        closeModal();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (isOpen()) {
        closeMenu();
        btn?.focus();
      }
      if (modal?.dataset.open === "true") {
        closeModal();
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (!isOpen()) return;
    const target = event.target;
    const clickedInside = pop?.contains(target) || btn?.contains(target);
    if (!clickedInside) closeMenu();
  });

  const hash = window.location.hash.replace("#", "");
  if (hash && modal && sections.some((section) => section.dataset.section === hash)) {
    openModal(hash);
  } else if (modal) {
    closeModal();
  }

  window.openMail = function () {
    const name = document.getElementById("name")?.value.trim() || "";
    const email = document.getElementById("email")?.value.trim() || "";
    const topic = document.getElementById("topic")?.value || "";
    const msg = document.getElementById("msg")?.value.trim() || "";

    const subject = encodeURIComponent(`[Contact] ${topic}`);
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\nTopic: ${topic}\n\nMessage:\n${msg}\n`
    );

    window.location.href = `mailto:support@yourcompany.com?subject=${subject}&body=${body}`;
  };

  window.openSupportMail = function () {
    const name = document.getElementById("sname")?.value.trim() || "";
    const email = document.getElementById("semail")?.value.trim() || "";
    const priority = document.getElementById("priority")?.value || "";
    const category = document.getElementById("category")?.value || "";
    const details = document.getElementById("details")?.value.trim() || "";

    const subject = encodeURIComponent(`[Support] ${priority} • ${category}`);
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\nPriority: ${priority}\nCategory: ${category}\n\nDetails:\n${details}\n`
    );

    window.location.href = `mailto:support@yourcompany.com?subject=${subject}&body=${body}`;
  };
})();
