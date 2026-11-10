(() => {
  "use strict";

  function showError(message) {
    const page = document.createElement("main");
    page.className = "crushify-publication-error";
    const brand = document.createElement("a");
    brand.href = "/";
    brand.textContent = "Crushify";
    const heading = document.createElement("h1");
    heading.textContent = "Không thể mở món quà";
    const detail = document.createElement("p");
    detail.textContent = message;
    page.append(brand, heading, detail);
    document.body.replaceChildren(page);
  }

  async function loadPublication(templateId) {
    const params = new URLSearchParams(location.search);
    if (params.has("preview") && templateId !== "our-universe") {
      const token = location.hash.slice(1);
      if (!token || token.length > 100) {
        showError("Bản xem trước không hợp lệ hoặc đã hết hạn.");
        return false;
      }
      let response;
      try {
        response = await fetch("/api/v1/previews", {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
      } catch {
        showError("Không thể kết nối để xác minh bản xem trước.");
        return false;
      }
      if (!response.ok) {
        showError("Bản xem trước không khả dụng hoặc đã hết hạn.");
        return false;
      }
      const preview = await response.json();
      if (preview.template_id !== templateId ||
          (preview.schema_version !== 1 &&
           !(templateId === "love-letter" && preview.schema_version === 2)) ||
          !preview.data || typeof preview.data !== "object" || Array.isArray(preview.data)) {
        showError("Dữ liệu xem trước không hợp lệ.");
        return false;
      }
      const resolve = async (value) => {
        if (Array.isArray(value)) return Promise.all(value.map(resolve));
        if (!value || typeof value !== "object") return value;
        const result = {};
        for (const [key, item] of Object.entries(value)) {
          if (key === "url" && typeof item === "string" && item.startsWith("/api/v1/previews/assets/")) {
            const image = await fetch(item, {
              credentials: "same-origin",
              cache: "no-store",
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!image.ok) throw new Error("Preview asset unavailable");
            result[key] = URL.createObjectURL(await image.blob());
          } else {
            result[key] = await resolve(item);
          }
        }
        return result;
      };
      try {
        window.CRUSHIFY_CUSTOMER_PREVIEW = true;
        window.CRUSHIFY_PREVIEW_TOKEN = token;
        const data = await resolve(preview.data);
        if (templateId === "our-memories" &&
            typeof preview.data.coverImage === "string" &&
            preview.data.coverImage.startsWith("/api/v1/previews/assets/")) {
          const cover = await resolve({ url: preview.data.coverImage });
          data.coverImage = cover.url;
        }
        window.CRUSHIFY_PUBLICATION_DATA = data;
        if (templateId === "our-memories") window.MEMORIES_DATA = window.CRUSHIFY_PUBLICATION_DATA;
        if (templateId === "say-yes") window.SAYYES_DATA = window.CRUSHIFY_PUBLICATION_DATA;
        return window.CRUSHIFY_PUBLICATION_DATA;
      } catch {
        showError("Không thể tải ảnh xem trước.");
        return false;
      }
    }

    const slug = new URLSearchParams(location.search).get("publication");
    if (!slug) return null;
    if (!/^g[A-Za-z0-9_-]{20,40}$/.test(slug)) {
      showError("Liên kết này không hợp lệ hoặc đã hết hạn.");
      return false;
    }

    let response;
    try {
      response = await fetch(`/api/v1/publications/${encodeURIComponent(slug)}`, {
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
    } catch {
      showError("Không thể kết nối để xác minh liên kết. Hãy tải lại trang.");
      return false;
    }
    if (!response.ok) {
      showError(response.status === 404
        ? "Không tìm thấy món quà này."
        : "Món quà đã hết hạn hoặc không còn được chia sẻ.");
      return false;
    }

    let publication;
    try {
      publication = await response.json();
    } catch {
      showError("Dữ liệu món quà không hợp lệ.");
      return false;
    }
    if (publication.template_id !== templateId ||
        (publication.schema_version !== 1 &&
         !(templateId === "love-letter" && publication.schema_version === 2)) ||
        typeof publication.renderer_version !== "string" ||
        typeof publication.data !== "object" || publication.data === null ||
        Array.isArray(publication.data)) {
      showError("Phiên bản hoặc nội dung món quà không được hỗ trợ.");
      return false;
    }

    window.CRUSHIFY_PUBLICATION_DATA = publication.data;
    if (templateId === "our-memories") window.MEMORIES_DATA = publication.data;
    if (templateId === "say-yes") window.SAYYES_DATA = publication.data;
    return publication.data;
  }

  window.loadCrushifyPublication = loadPublication;

  const script = document.currentScript;
  const templateId = script?.dataset.template;
  const appPath = script?.dataset.app;
  if (templateId && appPath) {
    void loadPublication(templateId).then((data) => {
      if (data === false) return;
      const app = document.createElement("script");
      app.src = appPath;
      if (script.dataset.module === "true") app.type = "module";
      app.onerror = () => showError("Không thể tải nội dung tương tác của món quà.");
      document.body.append(app);
    }).catch(() => showError("Không thể mở món quà. Hãy tải lại trang."));
  }
})();
