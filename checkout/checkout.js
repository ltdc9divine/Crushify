const notice = document.querySelector("#notice");
const orderPanel = document.querySelector("#order-panel");
const qrPanel = document.querySelector("#qr-panel");
const qrImage = document.querySelector("#payment-qr");
const qrError = document.querySelector("#qr-error");
const mockNote = document.querySelector("#mock-note");
const copyFeedback = document.querySelector("#copy-feedback");
const params = new URLSearchParams(location.search);
const designId = params.get("design_id");
const initialOrderId = params.get("order_id");
let pollTimer;
let expiryTimer;
let currentOrder;

const statusLabels = {
  AWAITING_PAYMENT: "Đang chờ thanh toán",
  PAID: "Đã xác nhận",
  EXPIRED: "Đã hết hạn",
  CANCELLED: "Đã hủy",
  MANUAL_REVIEW: "Đang được kiểm tra",
};

function showNotice(message, state = "info") {
  notice.textContent = message;
  notice.dataset.state = state;
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
  });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    throw new Error(body?.error?.message || "Không thể hoàn tất yêu cầu.");
  }
  return body;
}

function formatAmount(amount, currency) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency }).format(amount);
}

function showOrder(order) {
  currentOrder = order;
  orderPanel.hidden = false;
  document.querySelector("#order-reference").textContent = order.order_reference;
  document.querySelector("#order-total").textContent = formatAmount(order.total_minor, order.currency);
  document.querySelector("#order-status").textContent = statusLabels[order.status] || order.status;
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

  if (order.status === "PAID") {
    showNotice("Webhook hợp lệ đã xác nhận khoản thanh toán thử nghiệm.", "success");
    stopPolling();
  } else if (order.status === "MANUAL_REVIEW") {
    showNotice("Giao dịch có điểm chưa khớp và đã được lưu để kiểm tra thủ công.", "error");
    stopPolling();
  } else if (order.status === "EXPIRED" || order.status === "CANCELLED") {
    showNotice("Đơn hàng đã hết hiệu lực. Không gửi thêm giao dịch cho đơn này.", "error");
    stopPolling();
  } else {
    showNotice("Đang chờ webhook xác minh. Mã QR, nếu có, chỉ dùng trong SePay Test mode.");
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
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  document.querySelector("#order-expiry").textContent = `${hours}:${minutes}:${remainder}`;
}

function stopPolling() {
  window.clearInterval(pollTimer);
  window.clearInterval(expiryTimer);
}

async function pollOrder(orderId) {
  const order = await api(`/orders/${encodeURIComponent(orderId)}/status`);
  showOrder(order);
}

async function startCheckout() {
  if (!designId && !initialOrderId) {
    showNotice("Thiếu design_id hoặc order_id. Không có đơn hàng nào được tạo.", "error");
    return;
  }

  try {
    const account = await api("/customers/me");
    if (!account.csrf_token) throw new Error("Phiên đăng nhập chưa sẵn sàng.");

    let orderId = initialOrderId;
    if (!orderId) {
      const storageKey = `crushify-order-key:${designId}`;
      let idempotencyKey = localStorage.getItem(storageKey);
      if (!idempotencyKey) {
        idempotencyKey = `checkout-${crypto.randomUUID()}`;
        localStorage.setItem(storageKey, idempotencyKey);
      }
      const order = await api("/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": account.csrf_token,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ design_id: designId }),
      });
      orderId = order.order_id;
      showOrder(order);
    } else {
      await pollOrder(orderId);
    }

    pollTimer = window.setInterval(() => {
      pollOrder(orderId).catch((error) => showNotice(error.message, "error"));
    }, 3000);
    expiryTimer = window.setInterval(updateCountdown, 1000);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể tải thông tin thanh toán.", "error");
  }
}

startCheckout();
