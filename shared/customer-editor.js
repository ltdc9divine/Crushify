(() => {
  "use strict";

  const API = "/api/v1";
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const style = document.createElement("style");
  style.textContent = `
    .crushify-customer-tools{margin:12px 0;padding:14px;border:1px solid rgba(233,74,156,.35);
      border-radius:14px;background:rgba(233,74,156,.08);font:14px/1.45 system-ui,sans-serif}
    .crushify-customer-tools h3{margin:0 0 8px;font-size:15px}
    .crushify-customer-tools input{box-sizing:border-box;width:100%;margin:0 0 8px;padding:9px 10px;
      border:1px solid rgba(150,90,120,.5);border-radius:8px;font:inherit}
    .crushify-customer-tools button,.crushify-customer-tools a{display:inline-block;margin:3px 4px 3px 0;
      padding:8px 11px;border:1px solid rgba(220,100,160,.5);border-radius:999px;background:transparent;
      color:inherit;font:inherit;text-decoration:none;cursor:pointer}
    .crushify-customer-tools button:disabled{opacity:.55;cursor:wait}
    .crushify-customer-status{min-height:1.4em;margin:8px 0 0;font-size:13px}
    .crushify-customer-status[data-state=error]{color:#e44}
    .crushify-customer-status[data-state=saved]{color:#3a8}
  `;
  document.head.append(style);

  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  async function api(path, options = {}, csrf = "") {
    const headers = new Headers(options.headers || {});
    if (csrf) headers.set("X-CSRF-Token", csrf);
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = response.status === 204 ? null :
      response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
    if (!response.ok) throw new Error(data?.error?.message || "Không thể hoàn tất yêu cầu.");
    return data;
  }

  function showRecipientUnavailable() {
    return Boolean(window.CRUSHIFY_PUBLICATION_DATA || window.CRUSHIFY_CUSTOMER_PREVIEW ||
      new URLSearchParams(location.search).has("publication") ||
      new URLSearchParams(location.search).get("mode") === "recipient");
  }

  async function loadAsset(reference, previewToken) {
    if (!reference) return "";
    if (reference.startsWith("/api/v1/previews/assets/") && previewToken) {
      const response = await fetch(reference, {
        headers: { Authorization: `Bearer ${previewToken}` },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Không tải được ảnh xem trước.");
      return URL.createObjectURL(await response.blob());
    }
    return ID.test(reference) ? `${API}/assets/${encodeURIComponent(reference)}` : reference;
  }

  async function uploadAsset(designId, source, csrf) {
    const response = await fetch(source, { credentials: "same-origin" });
    if (!response.ok) throw new Error("Không đọc được ảnh trong trình chỉnh sửa.");
    const blob = await response.blob();
    const mediaType = blob.type.toLowerCase();
    if (!["image/jpeg", "image/png"].includes(mediaType) || blob.size < 1) {
      throw new Error("Ảnh phải là PNG hoặc JPEG hợp lệ.");
    }
    const grant = await api("/assets/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ design_id: designId, media_type: mediaType, size: blob.size }),
    }, csrf);
    const uploaded = await fetch(grant.upload_url, {
      method: grant.method,
      headers: {
        Authorization: `Bearer ${grant.upload_token}`,
        "Content-Type": mediaType,
      },
      body: blob,
      credentials: "same-origin",
    });
    if (!uploaded.ok) throw new Error("Tải ảnh lên máy chủ thất bại.");
    await api(`/assets/${encodeURIComponent(grant.asset_id)}/complete`, {
      method: "POST",
    }, csrf);
    return grant.asset_id;
  }

  function createTools(adapter) {
    const host = document.querySelector("#editor, #panel");
    if (!host) throw new Error(`Editor panel not found for ${adapter.templateId}`);
    const box = document.createElement("section");
    box.className = "crushify-customer-tools";
    box.innerHTML = `
      <h3>Crushify · Lưu thiết kế riêng</h3>
      <form class="crushify-customer-login">
        <label>Email nhận liên kết đăng nhập
          <input type="email" name="email" autocomplete="email" maxlength="254" required>
        </label>
        <button type="submit">Gửi liên kết an toàn</button>
      </form>
      <div class="crushify-customer-actions" hidden>
        <button type="button" data-action="save">Lưu ngay</button>
        <button type="button" data-action="preview">Xem trước riêng tư</button>
        <a href="/account/websites/">Website của tôi</a>
        <button type="button" data-action="signout">Đăng xuất</button>
      </div>
      <p class="crushify-customer-status" role="status" aria-live="polite">Đăng nhập để lưu trên máy chủ.</p>
    `;
    host.prepend(box);
    const form = box.querySelector("form");
    const actions = box.querySelector(".crushify-customer-actions");
    const status = box.querySelector(".crushify-customer-status");
    const setStatus = (message, state = "info") => {
      status.textContent = message;
      status.dataset.state = state;
    };

    let csrf = "";
    let designId = new URLSearchParams(location.search).get("design") || "";
    let revision = 0;
    let hydrating = false;
    let timer = 0;
    let saving = false;
    let saveAgain = false;
    let token = new URLSearchParams(location.hash.slice(1)).get("magic_token") ||
      new URLSearchParams(location.search).get("magic_token");
    const previewToken = new URLSearchParams(location.hash.slice(1)).get("preview_token") ||
      (new URLSearchParams(location.search).has("preview") ? location.hash.slice(1) : "");

    async function signIn() {
      if (token) {
        await api("/customers/session/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        token = "";
        history.replaceState(null, "", location.pathname + (designId ? `?design=${encodeURIComponent(designId)}` : ""));
      }
      const account = await api("/customers/me");
      csrf = account.csrf_token || "";
      if (!csrf) throw new Error("Phiên đăng nhập chưa sẵn sàng.");
      form.hidden = true;
      actions.hidden = false;

      if (designId) {
        if (!ID.test(designId)) throw new Error("Mã thiết kế không hợp lệ.");
        const design = await api(`/designs/${encodeURIComponent(designId)}`);
        if (design.template_id !== adapter.templateId ||
            !(adapter.supportedSchemaVersions || [adapter.schemaVersion]).includes(design.schema_version)) {
          throw new Error("Thiết kế không khớp template hoặc phiên bản hiện tại.");
        }
        adapter.setSchemaVersion?.(design.schema_version);
        hydrating = true;
        await adapter.hydrate(design.data, (value) => loadAsset(value, previewToken));
        revision = design.revision;
        hydrating = false;
        setStatus("Đã tải bản thiết kế đã lưu.", "saved");
      } else {
        const design = await api("/designs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template_id: adapter.templateId,
            schema_version: adapter.schemaVersion,
          }),
        }, csrf);
        designId = design.design_id;
        revision = design.revision;
        history.replaceState(null, "", `${location.pathname}?design=${encodeURIComponent(designId)}`);
        setStatus("Đã tạo bản nháp riêng. Đang lưu nội dung…");
        await save();
      }
    }

    async function save() {
      if (hydrating || !designId || !csrf) return false;
      if (saving) {
        saveAgain = true;
        return false;
      }
      saving = true;
      let success = true;
      try {
        do {
          saveAgain = false;
          setStatus("Đang lưu…");
          const data = await adapter.serialize((source) => uploadAsset(designId, source, csrf));
          const result = await api(`/designs/${encodeURIComponent(designId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              schema_version: adapter.schemaVersion,
              expected_revision: revision,
              data,
            }),
          }, csrf);
          revision = result.revision;
          setStatus("Đã lưu trên máy chủ.", "saved");
        } while (saveAgain);
      } catch (error) {
        success = false;
        setStatus(`Lưu thất bại: ${error instanceof Error ? error.message : "Lỗi không xác định"}`, "error");
      } finally {
        saving = false;
      }
      return success;
    }

    function scheduleSave() {
      if (hydrating || !designId || !csrf) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => void save(), 600);
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = new FormData(form).get("email");
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await api("/customers/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: String(email || "").trim(),
            return_to: `/templates/${adapter.templateId}/` +
              (ID.test(designId) ? `?design=${encodeURIComponent(designId)}` : ""),
          }),
        });
        setStatus("Nếu địa chỉ có thể dùng, sẽ được gửi liên kết đăng nhập.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Không gửi được liên kết.", "error");
      } finally {
        button.disabled = false;
      }
    });

    box.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      if (!button) return;
      button.disabled = true;
      try {
        if (button.dataset.action === "save") await save();
        else if (button.dataset.action === "preview") {
          if (!await save()) return;
          const preview = await api(`/designs/${encodeURIComponent(designId)}/preview`, {
            method: "POST",
          }, csrf);
          location.href = preview.url;
        } else if (button.dataset.action === "signout") {
          await api("/customers/session", { method: "DELETE" }, csrf);
          location.replace(location.pathname);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Không thể hoàn tất yêu cầu.", "error");
      } finally {
        button.disabled = false;
      }
    });

    window.addEventListener("crushify:changed", scheduleSave);
    void signIn().catch((error) => {
      hydrating = false;
      if (error instanceof Error && error.message === "Sign-in required") {
        setStatus("Đăng nhập để tạo và lưu thiết kế riêng.");
        form.hidden = false;
        actions.hidden = true;
      } else {
        setStatus(`Không thể tải bản thiết kế: ${error instanceof Error ? error.message : "Lỗi không xác định"}`, "error");
        form.hidden = !error?.message?.includes("Sign-in required");
        actions.hidden = true;
      }
    });
  }

  window.registerCrushifyCustomerEditor = (adapter) => {
    if (!record(adapter) || typeof adapter.templateId !== "string" ||
        !Number.isSafeInteger(adapter.schemaVersion) ||
        (adapter.supportedSchemaVersions !== undefined &&
          (!Array.isArray(adapter.supportedSchemaVersions) ||
           !adapter.supportedSchemaVersions.every(Number.isSafeInteger))) ||
        typeof adapter.serialize !== "function" || typeof adapter.hydrate !== "function") {
      throw new TypeError("Invalid customer editor adapter");
    }
    if (showRecipientUnavailable()) return;
    createTools(adapter);
  };
})();
