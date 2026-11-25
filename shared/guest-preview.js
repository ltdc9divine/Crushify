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
  status.textContent = "Xem thử khách · Tùy chỉnh hiện chỉ ở tab này. Chọn “Đặt mẫu này” để lưu tạm trên thiết bị trong tối đa 60 phút; mở liên kết đăng nhập trên cùng thiết bị/trình duyệt.";

  const controls = document.createElement("nav");
  controls.className = "crushify-guest-controls";
  controls.setAttribute("aria-label", "Điều hướng chế độ xem thử");

  const order = document.createElement("button");
  order.type = "button";
  order.className = "crushify-guest-order";
  order.textContent = "Đặt mẫu này";
  order.disabled = true;
  order.addEventListener("click", async () => {
    const editor = window.CRUSHIFY_GUEST_EDITOR;
    if (!editor || typeof editor.serializeGuest !== "function") {
      status.textContent = "Trình chỉnh sửa chưa sẵn sàng. Hãy đợi nội dung tải xong rồi thử lại.";
      return;
    }
    order.disabled = true;
    try {
      const data = await editor.serializeGuest();
      const draft = await window.CrushifyGuestDraft.createStore().save({
        templateId: editor.templateId,
        schemaVersion: editor.schemaVersion,
        data,
      });
      status.textContent = "Đã lưu tạm tùy chỉnh trên thiết bị. Đang chuyển tới đăng nhập; bản nháp sẽ hết hạn sau 60 phút.";
      location.assign(`/templates/${encodeURIComponent(editor.templateId)}/?guest_draft=${encodeURIComponent(draft.draftId)}`);
    } catch (error) {
      status.textContent = error instanceof Error
        ? `Chưa thể tiếp tục: ${error.message}`
        : "Chưa thể lưu tạm bản nháp. Nội dung hiện tại vẫn còn trên trang này.";
      order.disabled = false;
    }
  });

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Đặt lại mẫu";
  reset.addEventListener("click", () => {
    const resetEvent = new Event("crushify:guest-reset", { cancelable: true });
    if (window.dispatchEvent(resetEvent)) {
      location.reload();
    }
  });

  const selection = document.createElement("a");
  selection.href = "../../index.html#templates";
  selection.textContent = "Chọn mẫu khác";

  controls.append(order, reset, selection);
  notice.append(status, controls);
  document.body.append(notice);
  window.addEventListener("crushify:guest-editor-ready", () => {
    order.disabled = false;
  });
  const guestDraftStore = window.CrushifyGuestDraft?.createStore();
  if (guestDraftStore) {
    void guestDraftStore.cleanupExpired().catch((error) => {
      console.error("Could not clean up expired guest drafts", error);
    });
  }
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
