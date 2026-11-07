(() => {
  "use strict";

  const title = document.querySelector("#title");
  const message = document.querySelector("#message");
  const home = document.querySelector("#home");
  const slug = location.pathname.split("/").filter(Boolean)[1] || "";
  const renderers = new Set([
    "our-universe",
    "love-letter",
    "our-memories",
    "say-yes",
    "distance-means-nothing",
  ]);

  function showUnavailable(isMissing) {
    title.textContent = isMissing ? "Không tìm thấy món quà" : "Đường dẫn này không còn hiệu lực";
    message.textContent = isMissing
      ? "Kiểm tra lại liên kết hoặc liên hệ người đã gửi món quà cho bạn."
      : "Món quà có thể đã hết hạn hoặc được chủ sở hữu thu hồi.";
    home.hidden = false;
  }

  async function openPublication() {
    if (!/^g[A-Za-z0-9_-]{20,40}$/.test(slug)) {
      showUnavailable(true);
      return;
    }
    try {
      const response = await fetch(`/api/v1/publications/${encodeURIComponent(slug)}`, {
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        showUnavailable(response.status === 404);
        return;
      }
      const publication = await response.json();
      if (!renderers.has(publication.template_id) ||
          !Number.isSafeInteger(publication.schema_version) ||
          (publication.schema_version !== 1 &&
           !(publication.template_id === "love-letter" && publication.schema_version === 2)) ||
          typeof publication.renderer_version !== "string" ||
          typeof publication.data !== "object" || publication.data === null) {
        title.textContent = "Chưa thể mở món quà";
        message.textContent = "Phiên bản này hiện không được hỗ trợ. Hãy liên hệ người gửi.";
        home.hidden = false;
        return;
      }
      location.replace(`/templates/${publication.template_id}/index.html?mode=recipient&publication=${encodeURIComponent(slug)}`);
    } catch {
      title.textContent = "Không thể tải món quà";
      message.textContent = "Hãy kiểm tra kết nối rồi tải lại trang.";
      home.hidden = false;
    }
  }

  void openPublication();
})();
