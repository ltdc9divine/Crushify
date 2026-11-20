import {
  createCheckoutIntentStore,
  prepareCheckoutOrderRequest,
} from "./checkout-intent.js";

const notice = document.querySelector("#notice");
const checkoutPanel = document.querySelector("#checkout-panel");
const checkoutForm = document.querySelector("#checkout-form");
const durationTypeSelect = document.querySelector("#duration-type");
const hostingMonthsInput = document.querySelector("#hosting-months");
const durationNote = document.querySelector("#duration-note");
const orderPanel = document.querySelector("#order-panel");
const qrPanel = document.querySelector("#qr-panel");
const qrImage = document.querySelector("#payment-qr");
const qrContainer = document.querySelector("#payment-qr-container");
const qrError = document.querySelector("#qr-error");
const mockNote = document.querySelector("#mock-note");
const copyFeedback = document.querySelector("#copy-feedback");
const params = new URLSearchParams(location.search);
const designId = params.get("design_id");
const initialOrderId = params.get("order_id");
const newIntentRoute = params.get("new_order") === "1";
let csrfToken = "";
let currentOrder;
let pollTimer;
let expiryTimer;
let design;
let catalog;
let currentDesignId = designId;
let checkoutIntentStore;
let checkoutFormInitialized = false;
let checkoutFieldsChanged = false;
let orderSubmissionInProgress = false;
let disabledCheckoutControls = null;
let checkoutAccountKey = "";
let activeCheckoutIntentId = null;
let checkoutLoadGeneration = 0;
let intentCreationInProgress = false;

function orderStorageKeyFor(id) {
  return `crushify-order:${id}`;
}

async function deriveAccountKey(email) {
  if (typeof email !== "string" || email.length === 0) {
    throw new Error("Không thể xác minh tài khoản đặt hàng.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function updateCheckoutUrl({ designId: targetDesignId, orderId, newOrder = false }) {
  const url = new URL(location.href);
  url.searchParams.delete("design_id");
  url.searchParams.delete("order_id");
  url.searchParams.delete("new_order");
  if (orderId) {
    url.searchParams.set("order_id", orderId);
  } else if (targetDesignId) {
    url.searchParams.set("design_id", targetDesignId);
    if (newOrder) url.searchParams.set("new_order", "1");
  }
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

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
  fieldset.querySelectorAll("label").forEach((label) => label.remove());
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
  document.querySelector("#submit-order").disabled =
    orderSubmissionInProgress || !checkoutEnabled || !confirmed;
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

function setCheckoutFormBusy(busy) {
  if (busy) {
    disabledCheckoutControls = [...checkoutForm.querySelectorAll("input, select, button")]
      .map((control) => ({ control, disabled: control.disabled }));
    for (const { control } of disabledCheckoutControls) control.disabled = true;
    checkoutForm.setAttribute("aria-busy", "true");
    return;
  }
  for (const { control, disabled } of disabledCheckoutControls || []) {
    control.disabled = disabled;
  }
  disabledCheckoutControls = null;
  checkoutForm.removeAttribute("aria-busy");
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
  const editDesignLink = document.querySelector("#edit-design-link");
  const editUrl = new URL(
    `/templates/${encodeURIComponent(product.id)}/index.html`,
    location.origin,
  );
  editUrl.searchParams.set("design", design.design_id);
  editDesignLink.href = `${editUrl.pathname}${editUrl.search}`;
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
  currentDesignId = order.design_id || currentDesignId;
  checkoutPanel.hidden = true;
  orderPanel.hidden = false;
  document.querySelector("#new-order").hidden = !currentDesignId;
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
  qrPanel.hidden = !instructions;
  qrContainer.hidden = !trustedQrUrl || !instructions;
  qrError.hidden = true;
  const manualTransfer = order.payment?.provider === "MANUAL_BANK_TRANSFER";
  document.querySelector("#payment-method").textContent = manualTransfer
    ? "Chuyển khoản ngân hàng · xác nhận thủ công"
    : "Thông tin thanh toán";
  document.querySelector("#transfer-safety-note").textContent = manualTransfer
    ? "Chỉ chuyển đúng số tiền và nội dung. Quản trị viên xác nhận sau khi đối chiếu giao dịch thực nhận; ảnh chụp giao dịch không thay thế khoản tiền đã nhận."
    : "Chỉ dùng tài khoản Test mode của SePay. Không quét mã này bằng tài khoản ngân hàng thật.";
  if (instructions) {
    if (trustedQrUrl) {
      qrImage.referrerPolicy = "no-referrer";
      qrImage.src = trustedQrUrl;
    } else {
      qrImage.removeAttribute("src");
    }
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
    AWAITING_PAYMENT: manualTransfer
      ? "Đơn đang chờ quản trị viên đối chiếu giao dịch ngân hàng. Không gửi ảnh chụp thay cho giao dịch và không tạo đơn khác."
      : "Chỉ giao dịch được máy chủ xác minh mới cập nhật trạng thái. Không chuyển tiền thật trong SePay Test mode.",
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
    if (checkoutIntentStore && checkoutIntentStore.archive) {
      void checkoutIntentStore.list().then((intents) => {
        const matching = intents.find((intent) => intent.serverOrderId === order.order_id);
        if (matching) void checkoutIntentStore.archive(matching.intentId);
      }).catch(() => {});
    }
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
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  document.querySelector("#order-expiry").textContent = hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
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
  window.clearInterval(pollTimer);
  window.clearInterval(expiryTimer);
  pollTimer = window.setInterval(() => {
    pollOrder(orderId).catch((error) => showNotice(error.message, "error"));
  }, currentOrder?.payment?.provider === "MANUAL_BANK_TRANSFER" ? 30_000 : 3000);
  expiryTimer = window.setInterval(updateCountdown, 1000);
}

async function createOrder(event) {
  event.preventDefault();
  if (orderSubmissionInProgress) return;
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
  orderSubmissionInProgress = true;
  setCheckoutFormBusy(true);
  submit.disabled = true;
  submit.textContent = "Đang tạo đơn…";
  try {
    const prepared = await prepareCheckoutOrderRequest(
      checkoutIntentStore,
      {
        design_id: currentDesignId,
        duration_type: monthly ? "monthly" : "lifetime",
        hosting_months: monthly ? months : null,
        asset_consents: selectedConsents(),
      },
      design,
      {
        allowPayloadChange: checkoutFieldsChanged,
        activeIntentId: activeCheckoutIntentId,
      },
    );
    checkoutFieldsChanged = false;
    const order = await api("/orders", prepared.requestOptions);
    let remembered = true;
    try {
      await checkoutIntentStore.associate(prepared.intentId, order.order_id);
      sessionStorage.setItem(orderStorageKeyFor(order.design_id || currentDesignId), order.order_id);
    } catch {
      remembered = false;
    }
    updateCheckoutUrl({ orderId: order.order_id });
    showOrder(order);
    if (!remembered) {
      showNotice(
        "Đơn đã được tạo nhưng trình duyệt không lưu được mã theo dõi. Hãy giữ lại mã đơn đang hiển thị.",
        "error",
      );
    }
    window.clearInterval(pollTimer);
    window.clearInterval(expiryTimer);
    pollTimer = window.setInterval(() => {
      pollOrder(order.order_id).catch((error) => showNotice(error.message, "error"));
    }, order.payment?.provider === "MANUAL_BANK_TRANSFER" ? 30_000 : 3000);
    expiryTimer = window.setInterval(updateCountdown, 1000);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể tạo đơn hàng.", "error");
  } finally {
    orderSubmissionInProgress = false;
    submit.textContent = "Tạo đơn hàng";
    setCheckoutFormBusy(false);
    if (!checkoutPanel.hidden) updatePrice();
  }
}

function bindCheckoutForm() {
  if (checkoutFormInitialized) return;
  checkoutForm.addEventListener("submit", createOrder);
  const markOrderFieldsChanged = () => {
    checkoutFieldsChanged = true;
    updatePrice();
  };
  durationTypeSelect.addEventListener("change", markOrderFieldsChanged);
  hostingMonthsInput.addEventListener("input", markOrderFieldsChanged);
  document.querySelector("#asset-consents").addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") {
      checkoutFieldsChanged = true;
    }
  });
  document.querySelector("#terms-confirm").addEventListener("change", updatePrice);
  document.querySelector("#new-order-intent").addEventListener("click", startNewIntent);
  checkoutFormInitialized = true;
}

function checkoutPayload() {
  const monthly = durationTypeSelect.value === "monthly";
  const months = Number(hostingMonthsInput.value);
  return {
    design_id: currentDesignId,
    duration_type: monthly ? "monthly" : "lifetime",
    hosting_months: monthly ? months : null,
    asset_consents: selectedConsents(),
  };
}

function createIntentStoreForDesign(id) {
  return createCheckoutIntentStore({
    storageKey: `crushify-checkout-intent:v1:${checkoutAccountKey}:${id}`,
    accountKey: checkoutAccountKey,
    designId: id,
  });
}

async function recoverServerOrders(targetDesignId) {
  const unresolvedStatuses = new Set(["AWAITING_PAYMENT", "MANUAL_REVIEW"]);
  const matching = [];
  let cursor = null;
  let pageNumber = 0;
  for (; pageNumber < 100; pageNumber++) {
    const path = cursor
      ? `/orders?limit=50&cursor=${encodeURIComponent(cursor)}`
      : "/orders?limit=50";
    let result;
    try {
      result = await api(path);
    } catch (error) {
      return { incomplete: true, reason: "PAGE_REQUEST_FAILED", error };
    }
    matching.push(...(result.orders || []).filter((order) =>
      order.design_id === targetDesignId &&
      unresolvedStatuses.has(order.status)));
    if (!result.next_cursor) break;
    if (result.next_cursor === cursor) {
      return { incomplete: true, reason: "INVALID_CURSOR_PROGRESS" };
    }
    cursor = result.next_cursor;
    if (pageNumber === 99) {
      return { incomplete: true, reason: "SAFETY_CAP_REACHED" };
    }
  }
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];
  return matching;
}

function showRecoveryOptions(orders) {
  const panel = document.querySelector("#recovery-panel");
  const list = document.querySelector("#recovery-options");
  panel.hidden = false;
  list.replaceChildren();
  for (const order of orders) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-action";
    button.dataset.orderId = order.order_id;
    button.textContent = `${order.order_reference || "Đơn hàng"} · ${statusLabels[order.status] || order.status}`;
    button.addEventListener("click", () => {
      panel.hidden = true;
      updateCheckoutUrl({ orderId: order.order_id });
      void startTracking(order.order_id);
    });
    list.append(button);
  }
  const separate = document.querySelector("#recovery-new-order");
  separate.onclick = () => {
    panel.hidden = true;
    void loadCheckoutForDesign(designId, { forceNewIntent: true });
  };
  showNotice("Tìm thấy đơn chưa hoàn tất trên tài khoản. Hãy chọn đơn cần theo dõi hoặc bắt đầu đơn riêng có chủ đích.");
}

async function loadCheckoutForDesign(targetDesignId, { forceNewIntent = false } = {}) {
  const loadGeneration = ++checkoutLoadGeneration;
  activeCheckoutIntentId = null;
  const [savedDesign, products] = await Promise.all([
    api(`/designs/${encodeURIComponent(targetDesignId)}`),
    api("/catalog"),
  ]);
  if (loadGeneration !== checkoutLoadGeneration) return;
  if (savedDesign.design_id !== targetDesignId) {
    throw new Error("Không thể xác minh thiết kế cho đơn hàng mới.");
  }
  design = savedDesign;
  catalog = products;
  currentDesignId = targetDesignId;
  checkoutIntentStore = createIntentStoreForDesign(targetDesignId);
  showCatalog(products);
  bindCheckoutForm();
  checkoutPanel.hidden = false;
  orderPanel.hidden = true;

  if (forceNewIntent) {
    const activeIntent = await checkoutIntentStore.prepare(
      checkoutPayload(),
      design,
      { forceNew: true },
    );
    if (loadGeneration !== checkoutLoadGeneration) return;
    activeCheckoutIntentId = activeIntent.intentId;
    checkoutFieldsChanged = false;
    updateCheckoutUrl({ designId: targetDesignId, newOrder: true });
    showNotice(
      "Đã bắt đầu một đơn riêng. Đơn trước không bị hủy; hãy tiếp tục chỉ khi bạn thực sự muốn tạo thêm đơn.",
    );
    document.querySelector("#summary-title").focus();
  } else {
    showNotice("Bản nháp đã được lưu. Xem lại giá và lựa chọn hosting trước khi tiếp tục.");
  }
}

async function startNewIntent() {
  if (!checkoutIntentStore || orderSubmissionInProgress || intentCreationInProgress) return;
  intentCreationInProgress = true;
  try {
    const activeIntent = await checkoutIntentStore.prepare(
      checkoutPayload(),
      design,
      { forceNew: true },
    );
    activeCheckoutIntentId = activeIntent.intentId;
    checkoutFieldsChanged = false;
    updateCheckoutUrl({ designId: currentDesignId, newOrder: true });
    showNotice(
      "Đã bắt đầu một đơn riêng. Nếu lần gửi trước có thể đã tạo đơn, hãy kiểm tra đơn cũ trước khi tiếp tục.",
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể bắt đầu đơn mới.", "error");
  } finally {
    intentCreationInProgress = false;
  }
}

async function startNewOrder() {
  const button = document.querySelector("#new-order");
  const targetDesignId = currentOrder?.design_id;
  if (!targetDesignId || orderSubmissionInProgress) return;
  button.disabled = true;
  try {
    await loadCheckoutForDesign(targetDesignId, { forceNewIntent: true });
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể tải thiết kế.", "error");
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#new-order").addEventListener("click", startNewOrder);

async function startCheckout() {
  if (!designId && !initialOrderId) {
    showNotice("Thiếu mã thiết kế hoặc đơn hàng. Không có đơn nào được tạo.", "error");
    return;
  }
  try {
    const account = await api("/customers/me");
    csrfToken = account.csrf_token || "";
    if (!csrfToken) throw new Error("Phiên đăng nhập chưa sẵn sàng.");
    const nextAccountKey = await deriveAccountKey(account.email);
    if (nextAccountKey !== checkoutAccountKey) {
      checkoutLoadGeneration++;
      activeCheckoutIntentId = null;
      checkoutIntentStore = null;
    }
    checkoutAccountKey = nextAccountKey;
    if (initialOrderId) {
      await startTracking(initialOrderId);
      return;
    }
    const savedOrderId = newIntentRoute ? null : sessionStorage.getItem(orderStorageKeyFor(designId));
    if (savedOrderId) {
      try {
        await startTracking(savedOrderId);
        return;
      } catch (error) {
        updateCheckoutUrl({ designId, newOrder: true });
        await loadCheckoutForDesign(designId);
        showNotice(
          `Không thể xác nhận đơn đã lưu; mã theo dõi vẫn được giữ lại. Hãy thử lại với lựa chọn cũ hoặc bắt đầu đơn riêng. ${error instanceof Error ? error.message : ""}`,
          "error",
        );
        return;
      }
    }
    const recovered = newIntentRoute ? null : await recoverServerOrders(designId);
    if (recovered) {
      if (recovered.incomplete) {
        const button = document.querySelector("#submit-order");
        if (button) button.disabled = true;
        checkoutPanel.hidden = true;
        orderPanel.hidden = true;
        const panel = document.querySelector("#recovery-panel");
        const list = document.querySelector("#recovery-options");
        const retryButton = document.querySelector("#recovery-new-order");
        panel.hidden = false;
        list.replaceChildren();
        if (retryButton) {
          retryButton.hidden = false;
          retryButton.textContent = "Thử khôi phục lại";
          retryButton.onclick = () => {
            void startCheckout();
          };
        }
        showNotice(
          "Không thể xác minh toàn bộ đơn hàng chưa hoàn tất. Không tạo đơn mới cho đến khi có thể thử lại.",
          "error",
        );
        return;
      }
      if (Array.isArray(recovered)) {
        showRecoveryOptions(recovered);
      } else {
        updateCheckoutUrl({ orderId: recovered.order_id });
        await startTracking(recovered.order_id);
      }
      return;
    }
    await loadCheckoutForDesign(designId);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể tải thông tin đặt hàng.", "error");
  }
}

startCheckout();
