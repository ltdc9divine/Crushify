(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const guestPreview = params.get("guest") === "1";
  window.CRUSHIFY_GUEST_PREVIEW = guestPreview;
  if (!guestPreview) return;

  if (params.toString() !== "guest=1" || location.hash) {
    history.replaceState(null, "", `${location.pathname}?guest=1`);
  }

  document.body.classList.add("crushify-guest-mode");
  const templateId = location.pathname.split("/")[2];
  if (templateId) document.body.classList.add(`crushify-guest-template-${templateId}`);

  const notice = document.createElement("aside");
  notice.className = "crushify-guest-notice";
  notice.setAttribute("aria-label", "Chế độ xem thử khách");

  const status = document.createElement("p");
  status.className = "crushify-guest-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Xem thử khách (Guest Preview) · Thay đổi chỉ ở tab này, không được lưu. Cần đặt hàng để nhận website được xuất bản khi dịch vụ mở.";

  const controls = document.createElement("nav");
  controls.className = "crushify-guest-controls";
  controls.setAttribute("aria-label", "Điều hướng chế độ xem thử");

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Đặt lại mẫu";
  reset.addEventListener("click", () => location.replace(`${location.pathname}?guest=1`));

  const selection = document.createElement("a");
  selection.href = "../../index.html#templates";
  selection.textContent = "Chọn mẫu khác";

  controls.append(reset, selection);
  notice.append(status, controls);
  document.body.append(notice);
  const updateLayoutOffset = () => {
    const offset = Math.ceil(notice.getBoundingClientRect().bottom + 8);
    document.documentElement.style.setProperty("--crushify-guest-offset", `${offset}px`);
  };
  updateLayoutOffset();
  if ("ResizeObserver" in window) new ResizeObserver(updateLayoutOffset).observe(notice);
  window.addEventListener("resize", updateLayoutOffset);

  [
    "#b-copy",
    "#copyLink",
    "#save",
    "#order-continue",
    "#design-delete",
    "#auth-send",
    "#auth-signout",
    "#account-actions",
    "#auth-box",
  ].forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => {
      element.hidden = true;
    });
  });
})();
