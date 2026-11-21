(() => {
  "use strict";

  const productIds = [
    "our-universe",
    "love-letter",
    "our-memories",
    "say-yes",
    "distance-means-nothing",
  ];
  const publicCatalog = Object.freeze({
    currency: "VND",
    pricing_policy: Object.freeze({
      version: "standard-v1",
      catalog_enabled: true,
      template_base_price_minor: 59000,
      included_hosting_months: 1,
      additional_month_price_minor: 10000,
      lifetime_price_minor: 199000,
      currency: "VND",
    }),
    products: Object.freeze([
      ["our-universe", "Our Universe", 1],
      ["love-letter", "Love Letter", 2],
      ["our-memories", "Our Memories", 1],
      ["say-yes", "Say Yes", 1],
      ["distance-means-nothing", "Distance Means Nothing", 1],
    ].map(([id, title, schemaVersion]) => Object.freeze({
      id,
      title,
      schema_version: schemaVersion,
      base_price_minor: 59000,
      currency: "VND",
      available: true,
    }))),
    checkout_enabled: false,
  });

  function renderCatalogPricing(catalog, fallback = false) {
    const policy = catalog?.pricing_policy;
    const products = productIds.map((id) => catalog?.products?.find((product) => product.id === id));
    const validAmount = (amount) => Number.isSafeInteger(amount) && amount >= 0;
    if (catalog?.currency !== "VND" || policy?.currency !== "VND" ||
        policy.catalog_enabled !== true || typeof catalog.checkout_enabled !== "boolean" ||
        !Number.isSafeInteger(policy.included_hosting_months) || policy.included_hosting_months < 1 ||
        !validAmount(policy.additional_month_price_minor) ||
        !Number.isSafeInteger(policy.lifetime_price_minor) || policy.lifetime_price_minor < 1 ||
        products.some((product) => !product || typeof product.available !== "boolean" ||
          (product.available && (product.currency !== "VND" ||
            !Number.isSafeInteger(product.base_price_minor) || product.base_price_minor < 1)))) {
      throw new Error("Catalog response is incomplete");
    }

    const formatVnd = (amount) => `${new Intl.NumberFormat("vi-VN").format(amount)} đ`;
    const includedMonths = policy.included_hosting_months;
    const availableProducts = products.filter((product) => product.available);
    if (!availableProducts.length) throw new Error("No available products");
    const lowestPrice = Math.min(...availableProducts.map((product) => product.base_price_minor));

    document.querySelectorAll("[data-template-price]").forEach((node) => {
      const product = products.find((item) => item.id === node.dataset.templatePrice);
      node.textContent = product?.available
        ? `${formatVnd(product.base_price_minor)} · gồm ${includedMonths} tháng hosting`
        : "Hiện chưa mở bán";
    });
    document.getElementById("startingPrice").textContent = formatVnd(lowestPrice);
    document.getElementById("startingPriceNote").textContent =
      `từ · đã gồm ${includedMonths} tháng hosting`;
    document.getElementById("includedHostingPrice").textContent =
      `Đã gồm ${includedMonths} tháng hosting trong giá mẫu`;
    document.getElementById("additionalHostingPrice").textContent =
      `Mỗi tháng hosting thêm: ${formatVnd(policy.additional_month_price_minor)}`;
    document.getElementById("lifetimePrice").textContent =
      `Gói trọn đời: ${formatVnd(policy.lifetime_price_minor)}`;
    document.getElementById("pricingFormula").textContent =
      `Tổng theo tháng = giá mẫu + max(0, số tháng − ${includedMonths}) × ` +
      `${formatVnd(policy.additional_month_price_minor)}. Không có tự động gia hạn.`;
    const status = document.getElementById("pricingAvailability");
    status.textContent = fallback
      ? "Giá hiển thị từ danh mục công khai trong ứng dụng. Tạo đơn chưa mở; chưa gửi yêu cầu đặt hàng."
      : catalog.checkout_enabled
        ? "Giá đã tải từ catalog. Test mode chỉ dùng trên Preview đã được cấu hình; Production chưa bật."
        : "Giá đã tải từ catalog. Tạo đơn hiện chưa mở ở môi trường này; Production chưa bật.";
    status.dataset.state = fallback || !catalog.checkout_enabled ? "locked" : "info";
  }

  function markUnavailable() {
    document.querySelectorAll("[data-template-price]").forEach((node) => {
      node.textContent = "Giá hiện chưa khả dụng";
    });
    document.getElementById("startingPrice").textContent = "Giá chưa khả dụng";
    document.getElementById("startingPriceNote").textContent = "Không tạo đơn khi chưa có giá";
    document.getElementById("includedHostingPrice").textContent = "Chưa có thông tin thời hạn hosting.";
    document.getElementById("additionalHostingPrice").textContent = "Chưa có thông tin giá hosting.";
    document.getElementById("lifetimePrice").textContent = "Chưa có thông tin gói trọn đời.";
    document.getElementById("pricingFormula").textContent =
      "Không thể xác nhận giá hiện tại. Vui lòng tải lại trang trước khi tiếp tục.";
    const status = document.getElementById("pricingAvailability");
    status.textContent = "Không tải được danh mục giá hiện tại. Chưa thể xác nhận giá hoặc tạo đơn.";
    status.dataset.state = "error";
  }

  async function loadCrushifyCatalogPricing(fetcher = window.fetch.bind(window)) {
    try {
      const response = await fetcher("/api/v1/catalog", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Catalog request failed");
      renderCatalogPricing(await response.json());
      return "api";
    } catch (error) {
      try {
        renderCatalogPricing(publicCatalog, true);
        console.warn("Không thể tải catalog API; chỉ hiển thị danh mục giá công khai trong ứng dụng.", error);
        return "fallback";
      } catch (fallbackError) {
        markUnavailable();
        console.error("Không thể tải hoặc hiển thị danh mục giá Crushify.", fallbackError);
        return "unavailable";
      }
    }
  }

  window.CRUSHIFY_PUBLIC_CATALOG = publicCatalog;
  window.renderCrushifyCatalogPricing = renderCatalogPricing;
  window.loadCrushifyCatalogPricing = loadCrushifyCatalogPricing;
})();
