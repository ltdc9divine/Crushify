const notice = document.querySelector("#notice");
const loginForm = document.querySelector("#login-form");
const customerPanel = document.querySelector("#customer-panel");
const requestForm = document.querySelector("#request-form");
const requestList = document.querySelector("#request-list");
let csrfToken = "";
let pendingIdempotencyKey = "";
const pendingCustomerReplies = new Map();

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
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    const error = new Error(body?.error?.message || "Không thể hoàn tất yêu cầu.");
    error.status = response.status;
    error.code = body?.error?.code;
    throw error;
  }
  return body;
}

function templateName(id) {
  return {
    "not_sure": "Chưa xác định",
    custom: "Thiết kế hoặc tính năng mới",
    "our-universe": "Our Universe",
    "love-letter": "Love Letter",
    "our-memories": "Our Memories",
    "say-yes": "Say Yes",
    "distance-means-nothing": "Distance Means Nothing",
  }[id] || "Yêu cầu thiết kế riêng";
}

function renderRequests(requests) {
  requestList.replaceChildren();
  if (requests.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Chưa có yêu cầu nào.";
    requestList.append(empty);
    return;
  }
  for (const request of requests) {
    const card = document.createElement("article");
    card.className = "request-card";
    const heading = document.createElement("h4");
    heading.textContent = `${templateName(request.preferred_template)} · ${request.status === "QUOTE_PENDING" ? "Đang chờ xem xét và báo giá" : request.status}`;
    const date = document.createElement("p");
    date.textContent = `Gửi lúc ${new Date(request.created_at).toLocaleString("vi-VN")}`;
    const brief = document.createElement("p");
    brief.textContent = request.brief;
    const communication = document.createElement("p");
    communication.textContent = request.communication_status === "AWAITING_REVIEW"
      ? "Chưa có phản hồi. Báo giá chỉ được gửi sau khi xem xét."
      : `Trạng thái trao đổi: ${request.communication_status}`;
    card.append(heading, date, brief, communication);
    if (request.customer_message) {
      const reply = document.createElement("p");
      reply.className = "request-reply";
      reply.textContent = `Phản hồi từ Crushify: ${request.customer_message}`;
      card.append(reply);
    }
    if (request.customer_reply) {
      const customerReply = document.createElement("p");
      customerReply.className = "request-reply";
      customerReply.textContent = `Phản hồi của bạn: ${request.customer_reply}`;
      card.append(customerReply);
    }
    if (request.status === "CUSTOMER_ACTION_REQUIRED") {
      const form = document.createElement("form");
      form.className = "customer-reply-form";
      form.dataset.requestId = request.request_id;
      const input = document.createElement("textarea");
      input.maxLength = 2000;
      input.required = true;
      input.placeholder = "Phản hồi yêu cầu bổ sung (tối đa 2.000 ký tự)";
      input.setAttribute("aria-label", `Phản hồi yêu cầu thiết kế ${request.request_id}`);
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "Gửi phản hồi";
      form.append(input, submit);
      card.append(form);
    }
    requestList.append(card);
  }
}

async function loadRequests() {
  const result = await api("/custom-design/requests");
  renderRequests(result.requests);
}

async function startCustomerSession() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get("magic_token") || new URLSearchParams(location.search).get("magic_token");
  if (token) {
    await api("/customers/session/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    history.replaceState(null, "", location.pathname);
  }
  const customer = await api("/customers/me");
  csrfToken = customer.csrf_token || "";
  if (!csrfToken) throw new Error("Phiên đăng nhập chưa sẵn sàng.");
  loginForm.hidden = true;
  customerPanel.hidden = false;
  document.querySelector("#account-email").textContent = `Đã đăng nhập: ${customer.email}`;
  await loadRequests();
  showNotice("Bạn có thể gửi yêu cầu; việc gửi chưa tạo đơn hàng hoặc thanh toán.");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    await api("/customers/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: String(new FormData(loginForm).get("email") || "").trim(),
        return_to: "/custom-design/",
      }),
    });
    showNotice("Nếu địa chỉ có thể dùng, liên kết đăng nhập an toàn sẽ được gửi.");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không gửi được liên kết.", "error");
  } finally {
    button.disabled = false;
  }
});

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requestForm.reportValidity()) return;
  const button = document.querySelector("#submit-request");
  button.disabled = true;
  pendingIdempotencyKey ||= crypto.randomUUID();
  const form = new FormData(requestForm);
  try {
    const result = await api("/custom-design/requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": pendingIdempotencyKey,
      },
      body: JSON.stringify({
        preferred_template: String(form.get("preferred_template") || ""),
        brief: String(form.get("brief") || ""),
        requirements: String(form.get("requirements") || ""),
        requested_delivery_date: String(form.get("requested_delivery_date") || ""),
        reference_urls: String(form.get("reference_urls") || "")
          .split(/\r?\n/)
          .map((url) => url.trim())
          .filter(Boolean),
        assets_rights_confirmed: document.querySelector("#rights-confirmed").checked,
      }),
    });
    pendingIdempotencyKey = "";
    showNotice("Đã nhận yêu cầu. Trạng thái hiện tại: chờ xem xét và báo giá; chưa có cam kết về giá hoặc thời gian.", "success");
    renderRequests([result, ...(await api("/custom-design/requests")).requests
      .filter((request) => request.request_id !== result.request_id)]);
    requestForm.reset();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không gửi được yêu cầu.", "error");
  } finally {
    button.disabled = false;
  }
});

requestList.addEventListener("submit", async (event) => {
  const form = event.target instanceof Element
    ? event.target.closest("form.customer-reply-form")
    : null;
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const requestId = form.dataset.requestId;
  const input = form.querySelector("textarea");
  const button = form.querySelector("button");
  const message = input.value.trim();
  let pending = pendingCustomerReplies.get(requestId);
  if (!pending || pending.message !== message) {
    pending = { key: crypto.randomUUID(), message };
    pendingCustomerReplies.set(requestId, pending);
  }
  button.disabled = true;
  try {
    await api(`/custom-design/requests/${encodeURIComponent(requestId)}/replies`, {
      method: "POST",
      headers: { "Idempotency-Key": pending.key },
      body: JSON.stringify({ message }),
    });
    pendingCustomerReplies.delete(requestId);
    await loadRequests();
    showNotice("Đã gửi phản hồi. Yêu cầu sẽ tiếp tục được xem xét.", "success");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không gửi được phản hồi.", "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#signout").addEventListener("click", async () => {
  const button = document.querySelector("#signout");
  button.disabled = true;
  try {
    await api("/customers/session", { method: "DELETE" });
    location.replace(location.pathname);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Không thể đăng xuất.", "error");
  } finally {
    button.disabled = false;
  }
});

void startCustomerSession().catch((error) => {
  loginForm.hidden = false;
  customerPanel.hidden = true;
  if (error?.status === 401) {
    showNotice("Đăng nhập để gửi yêu cầu và xem trạng thái.");
  } else {
    showNotice(error instanceof Error ? error.message : "Không thể tải tài khoản.", "error");
  }
});
