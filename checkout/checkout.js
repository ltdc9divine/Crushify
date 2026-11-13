const notice = document.querySelector("#notice");
const checkoutPanel = document.querySelector("#checkout-panel");
const checkoutForm = document.querySelector("#checkout-form");
const durationTypeSelect = document.querySelector("#duration-type");
const hostingMonthsInput = document.querySelector("#hosting-months");
const durationNote = document.querySelector("#duration-note");
const orderPanel = document.querySelector("#order-panel");
const qrPanel = document.querySelector("#qr-panel");
const qrImage = document.querySelector("#payment-qr");
const qrError = document.querySelector("#qr-error");
const mockNote = document.querySelector("#mock-note");
const copyFeedback = document.querySelector("#copy-feedback");
const params = new URLSearchParams(location.search);
const designId = params.get("design_id");
const initialOrderId = params.get("order_id");
const orderStorageKey = designId ? `crushify-order:${designId}` : "";
let csrfToken = "";
let currentOrder;
let pollTimer;
let expiryTimer;
let design;
let catalog;

const statusLabels = {
  AWAITING_PAYMENT: "Đang chờ xác nhận thanh toán",
  MANUAL_REVIEW: "Thanh toán đang được kiểm tra",
  PAID: "Đã xác nhận thanh toán",
  FULFILLING: "Đang xử lý món quà",
  FULFILLED: "Đã hoàn tất",
  FAILED: "Cần hỗ trợ",
  EXPIRED: "Đơn hàng đã hết hạn",
  CANCELLED: "Đơn hàng đã hủy",
  REFUNDED: "Đã hoàn tiền",
  REFUND_PENDING: "Đang xử lý hoàn tiền",
};

function showNotice(message, state = "info") {
  notice.textContent = message;
  notice.dataset.state = state;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (csrfToken && options.method && options.method !== "GET") {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers,
  });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) throw new Error(body?.error?.message || "Không thể hoàn tất yêu cầu.");
  return body;
}

function formatAmount(amount, currency = "VND") {
  if (!Number.isSafeInteger(amount) || amount < 0) return "Chưa có giá";
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency }).format(amount);
}

function addConsentOptions(data) {
  const fieldset = document.querySelector("#asset-consents");
  const assets = new Set();
  const visit = (value, key = "") => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry));
      return;
    }
    if (!value || typeof value !== "object") {
      if ((key === "asset_id" || key === "coverImage") &&
          typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        assets.add(value);
      }
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(data);
  fieldset.hidden = assets.size === 0;
  for (const [index, assetId] of [...assets].entries()) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.assetId = assetId;
    const text = document.createElement("span");
    text.textContent = `Cho phép hiển thị ảnh ${index + 1} trên website quà tặng công khai.`;
    label.append(input, text);
    fieldset.append(label);
  }
}

function selectedConsents() {
  return [...document.querySelectorAll("#asset-consents input:checked")].map((input) => ({
    asset_id: input.dataset.assetId,
    consent_version: "public-image-v1",
  }));
}

function updatePrice() {
  const policy = catalog?.pricing_policy;
  const product = catalog?.products.find((item) => item.id === design.template_id);
  const monthly = durationTypeSelect.value === "monthly";
  const months = Number(hostingMonthsInput.value);
  const validMonths = Number.isSafeInteger(months) && months >= 1;
  hostingMonthsInput.disabled = !monthly;
  hostingMonthsInput.required = monthly;
  document.querySelector("#lifetime-policy-note").hidden = monthly;
  document.querySelector("#hosting-charge-label").textContent = monthly
    ? "Hosting phát sinh"
    : "Giá gói trọn đời";

  const basePrice = policy?.template_base_price_minor ?? product?.base_price_minor;
  const includedMonths = policy?.included_hosting_months;
  const monthlyRate = policy?.additional_month_price_minor;
  const additionalMonths = monthly && validMonths && Number.isSafeInteger(includedMonths)
    ? Math.max(0, months - includedMonths)
    : null;
  const hostingCharge = monthly && additionalMonths !== null && Number.isSafeInteger(monthlyRate)
    ? additionalMonths * monthlyRate
    : null;
  const total = monthly && hostingCharge !== null && Number.isSafeInteger(basePrice)
    ? basePrice + hostingCharge
    : !monthly
      ? policy?.lifetime_price_minor
      : null;
  const estimateValid = Number.isSafeInteger(total) && total > 0;
  const checkoutEnabled = Boolean(policy?.catalog_enabled && catalog?.checkout_enabled && estimateValid);
  document.querySelector("#duration-price").textContent = monthly
    ? hostingCharge === null ? "—" : formatAmount(hostingCharge)
    : Number.isSafeInteger(policy?.lifetime_price_minor)
      ? formatAmount(policy.lifetime_price_minor)
      : "—";
  document.querySelector("#included-months").textContent = monthly
    ? Number.isSafeInteger(includedMonths) ? `${includedMonths} tháng` : "—"
    : "Không giới hạn theo thời gian";
  document.querySelector("#additional-months").textContent = monthly
    ? additionalMonths === null ? "—" : String(additionalMonths)
    : "Không áp dụng";
  document.querySelector("#additional-month-rate").textContent = monthly
    ? Number.isSafeInteger(monthlyRate) ? formatAmount(monthlyRate) : "—"
    : "Không áp dụng";
  document.querySelector("#order-total-preview").textContent = estimateValid
    ? formatAmount(total)
    : "Chưa thể tính";
  const confirmed = document.querySelector("#terms-confirm").checked;
  document.querySelector("#submit-order").disabled = !checkoutEnabled || !confirmed;
  if (!estimateValid) {
    durationNote.textContent = monthly
      ? "Nhập số tháng hosting là số nguyên dương để xem giá."
      : "Giá gói trọn đời hiện chưa được cấu hình.";
    durationNote.dataset.state = "error";
  } else if (!policy?.catalog_enabled) {
    durationNote.textContent = "Chưa thể xác nhận giá cho lựa chọn này.";
    durationNote.dataset.state = "error";
  } else if (!catalog?.checkout_enabled) {
    durationNote.textContent = "Giá đã được duyệt; tính năng tạo đơn và thanh toán hiện chưa được bật.";
    durationNote.dataset.state = "error";
  } else {
    durationNote.textContent = "Tổng tiền sẽ được máy chủ tính lại khi tạo đơn.";
    durationNote.dataset.state = "info";
  }
}

function showCatalog(catalogData) {
  catalog = catalogData;
  const product = catalog.products.find((item) => item.id === design.template_id && item.available);
  if (!product) throw new Error("Mẫu này hiện không được mở bán.");
  document.querySelector("#design-template").textContent = product.title;
  document.querySelector("#base-price").textContent =
    `${formatAmount(product.base_price_minor)} · gồm tháng đầu tiên`;
  document.querySelector("#design-summary").textContent =
    `Bản xem trước sử dụng phiên bản nội dung ${design.revision} đã lưu. Có thể quay lại trình chỉnh sửa trước khi tạo đơn.`;
  addConsentOptions(design.data);
  checkoutPanel.hidden = false;
  updatePrice();
}

async function loadPublicationUrl(order) {
  if (order.status !== "FULFILLED" || !order.design_id) return;
  try {
    const result = await api("/publications");
    const website = result.websites?.find((item) =>
      item.design_id === order.design_id && item.publication_status === "PUBLISHED" && item.public_url);
    if (website) {
      const link = document.querySelector("#publication-link");
      link.href = website.public_url;
      link.textContent = "Mở website quà tặng";
      link.hidden = false;
    }
  } catch {
    document.querySelector("#tracking-help").textContent =
      "Đơn đã hoàn tất. Hãy xem mục Website của tôi hoặc liên hệ hỗ trợ để lấy đường dẫn.";
    document.querySelector("#tracking-help").hidden = false;
  }
}

function showOrder(order) {
  currentOrder = order;
  checkoutPanel.hidden = true;
  orderPanel.hidden = false;
  document.querySelector("#order-reference").textContent = order.order_reference || "—";
  document.querySelector("#order-total").textContent = formatAmount(order.total_minor, order.currency);
  document.querySelector("#order-status").textContent = statusLabels[order.status] || "Đang cập nhật";
  document.querySelector("#fulfillment-status").textContent =
    statusLabels[order.fulfillment_status] || order.fulfillment_status || "Chưa xử lý";
  const expiryLabel = document.querySelector("#order-expiry");
  expiryLabel.title = order.expires_at ? new Date(order.expires_at).toLocaleString("vi-VN") : "";
  expiryLabel.textContent = order.expires_at ? new Date(order.expires_at).toLocaleString("vi-VN") : "—";

  const instructions = order.payment?.instructions;
  const qrUrl = instructions?.qr_url || order.payment?.qr_url;
  let trustedQrUrl = null;
  if (typeof qrUrl === "string") {
    try {
      const parsed = new URL(qrUrl);
      if (parsed.protocol === "https:" && parsed.origin === "https://vietqr.app") trustedQrUrl = parsed.href;
    } catch {
      trustedQrUrl = null;
    }
  }
  qrPanel.hidden = !trustedQrUrl || !instructions;
  if (trustedQrUrl && instructions) {
    qrError.hidden = true;
    qrImage.referrerPolicy = "no-referrer";
    qrImage.src = trustedQrUrl;
    document.querySelector("#payment-bank").textContent = instructions.bank_code;
    document.querySelector("#payment-account").textContent = instructions.bank_account;
    document.querySelector("#payment-account-name").textContent = instructions.account_name || "—";
    document.querySelector("#payment-amount").textContent = formatAmount(instructions.amount_minor, order.currency);
    document.querySelector("#payment-reference").textContent = instructions.reference;
    document.querySelector("#copy-amount").dataset.copyValue = String(instructions.amount_minor);
  } else {
    qrImage.removeAttribute("src");
    qrError.hidden = true;
  }
  mockNote.hidden = order.payment?.mock_mode !== true || order.status !== "AWAITING_PAYMENT";

  const help = document.querySelector("#tracking-help");
  const messages = {
    AWAITING_PAYMENT: "Chỉ giao dịch được máy chủ xác minh mới cập nhật trạng thái. Không chuyển tiền thật trên bản thử nghiệm.",
    MANUAL_REVIEW: "Có điểm cần kiểm tra. Không gửi thêm khoản thanh toán; liên hệ hỗ trợ nếu cần.",
    PAID: "Thanh toán đã được xác minh. Món quà đang chờ xử lý.",
    FULFILLING: "Thanh toán đã xác minh nhưng xuất bản đang chậm. Bạn không cần tạo đơn khác; liên hệ hỗ trợ nếu tình trạng kéo dài.",
    FAILED: "Đơn cần được hỗ trợ. Không tạo thanh toán mới cho cùng đơn này.",
    EXPIRED: "Đơn đã hết hạn. Không gửi thêm thanh toán cho đơn này.",
    CANCELLED: "Đơn đã hủy.",
    REFUNDED: "Đơn đã được hoàn tiền.",
    REFUND_PENDING: "Yêu cầu hoàn tiền đang được xử lý.",
  };
  help.textContent = messages[order.status] || "";
  help.hidden = !help.textContent;
  void loadPublicationUrl(order);

  if (order.status === "FULFILLED" || order.status === "EXPIRED" ||
      order.status === "CANCELLED" || order.status === "REFUNDED" ||
      order.status === "FAILED" || order.status === "MANUAL_REVIEW") {
    stopPolling();
    showNotice(statusLabels[order.status] || "Đơn hàng đã được cập nhật.", "success");
  } else {
    showNotice(statusLabels[order.status] || "Đang cập nhật trạng thái đơn hàng.");
  }
  updateCountdown();
}

qrImage.addEventListener("error", () => {
  qrError.hidden = false;
});

qrImage.addEventListener("load", () => {
  qrError.hidden = true;
});

document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("button.copy-button")
    : null;
  if (!button) return;
  const targetId = button.dataset.copyTarget;
  const value = button.dataset.copyValue ||
    (targetId ? document.getElementById(targetId)?.textContent?.trim() : null);
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copyFeedback.textContent = "Đã sao chép.";
  } catch {
    copyFeedback.textContent = "Không thể sao chép tự động. Hãy chọn và sao chép nội dung.";
  }
});

function updateCountdown() {
  if (!currentOrder?.expires_at || currentOrder.status !== "AWAITING_PAYMENT") return;
  const remaining = Date.parse(currentOrder.expires_at) - Date.now();
  if (remaining <= 0) {
    document.querySelector("#order-expiry").textContent = "Đã hết hạn";
    return;
  }
  const seconds = Math.floor(remaining / 1000);
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  document.querySelector("#order-expiry").textContent = `${minutes}:${remainder}`;
}

function stopPolling() {
  window.clearInterval(pollTimer);
  window.clearInterval(expiryTimer);
}

async function pollOrder(orderId) {
  const order = await api(`/orders/${encodeURIComponent(orderId)}/status`);
  showOrder(order);
}

async function startTracking(orderId) {
  await pollOrder(orderId);
  pollTimer = window.setInterval(() => {
    pollOrder(orderId).catch((error) => showNotice(error.message, "error"));
  }, 3000);
  expiryTimer = window.setInterval(updateCountdown, 1000);
}

async function createOrder(event) {
  event.preventDefault();
  const submit = document.querySelector("#submit-order");
  const policy = catalog?.pricing_policy;
  const monthly = durationTypeSelect.value === "monthly";
  const months = Number(hostingMonthsInput.value);
  if (!design || !policy?.catalog_enabled || !catalog?.checkout_enabled ||
      (monthly && (!Number.isSafeInteger(months) || months < 1))) {
    showNotice("Checkout chưa được kích hoạt hoặc thời hạn hosting không hợp lệ. Chưa tạo đơn.", "error");
    return;
  }
  if (!document.querySelector("#terms-confirm").checked) return;
  submit.disabled = true;
  submit.textContent = "Đang tạo đơn…";
  try {
    const idempotencyKey = `checkout-${crypto.randomUUID()}`;
    const order = await api("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        design_id: designId,
        duration_type: monthly ? "monthly" : "lifetime",
        hosting_months: monthly ? months : null,
        asset_consents: selectedConsents(),
      }),
    });
    if (orderStorageKey) sessionStorage.setItem(orderStorageKey, order.order_id);
    showOrder(order);
    pollTimer = window.setInterval(() => {
      pollOrder(order.order_id).catch((error) => showNotice(error.message, "error"));
    }, 3000);
    expiryTimer = window.setInterval(updateCountdown, 1000);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể tạo đơn hàng.", "error");
    submit.disabled = false;
  } finally {
    submit.textContent = "Tạo đơn hàng";
  }
}

async function startCheckout() {
  if (!designId && !initialOrderId) {
    showNotice("Thiếu mã thiết kế hoặc đơn hàng. Không có đơn nào được tạo.", "error");
    return;
  }
  try {
    const account = await api("/customers/me");
    csrfToken = account.csrf_token || "";
    if (!csrfToken) throw new Error("Phiên đăng nhập chưa sẵn sàng.");
    if (initialOrderId) {
      await startTracking(initialOrderId);
      return;
    }
    const savedOrderId = sessionStorage.getItem(orderStorageKey);
    if (savedOrderId) {
      try {
        await startTracking(savedOrderId);
        return;
      } catch {
        sessionStorage.removeItem(orderStorageKey);
      }
    }
    const [savedDesign, products] = await Promise.all([
      api(`/designs/${encodeURIComponent(designId)}`),
      api("/catalog"),
    ]);
    design = savedDesign;
    catalog = products;
    showCatalog(products);
    checkoutForm.addEventListener("submit", createOrder);
    durationTypeSelect.addEventListener("change", updatePrice);
    hostingMonthsInput.addEventListener("input", updatePrice);
    document.querySelector("#terms-confirm").addEventListener("change", updatePrice);
    showNotice("Bản nháp đã được lưu. Xem lại giá và lựa chọn hosting trước khi tiếp tục.");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể tải thông tin đặt hàng.", "error");
  }
}

startCheckout();
