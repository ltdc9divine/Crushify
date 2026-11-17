(() => {
  "use strict";

  const notice = document.querySelector("#notice");
  const dashboard = document.querySelector("#dashboard");
  let csrfToken = "";

  function showNotice(message, state = "info") {
    notice.textContent = message;
    notice.dataset.state = state;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.method && options.method !== "GET") {
      headers.set("Content-Type", "application/json");
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

  function addText(parent, tag, value, className = "") {
    const element = document.createElement(tag);
    element.textContent = value == null ? "—" : String(value);
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  function renderTable(target, rows, columns) {
    target.replaceChildren();
    if (!rows.length) {
      addText(target, "p", "Không có dữ liệu.", "empty");
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrap";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    const heading = target.closest(".panel")?.querySelector("h2");
    wrapper.setAttribute("aria-label", `${heading?.textContent || "Dữ liệu"} · bảng có thể cuộn`);
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.className = "visually-hidden";
    caption.textContent = heading?.textContent || "Dữ liệu vận hành";
    table.append(caption);
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const column of columns) {
      const header = addText(headerRow, "th", column.title);
      header.scope = "col";
    }
    head.append(headerRow);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const line = document.createElement("tr");
      for (const column of columns) {
        const cell = document.createElement("td");
        const value = column.value ? column.value(row) : row[column.key];
        cell.textContent = value == null || value === "" ? "—" : String(value);
        line.append(cell);
      }
      body.append(line);
    }
    table.append(head, body);
    wrapper.append(table);
    target.append(wrapper);
  }

  function templateTitle(templateId) {
    return ({
      "our-universe": "Our Universe",
      "love-letter": "Love Letter",
      "our-memories": "Our Memories",
      "say-yes": "Say Yes",
      "distance-means-nothing": "Distance Means Nothing",
      custom: "Thiết kế riêng",
    })[templateId] || "—";
  }

  function renderManualPayments(rows) {
    const target = document.querySelector("#manual-payments");
    target.replaceChildren();
    if (!rows.length) {
      addText(target, "p", "Không có đơn chuyển khoản nào đang chờ xác nhận.", "empty");
      return;
    }
    for (const row of rows) {
      const card = document.createElement("article");
      card.className = "manual-payment-card";
      const heading = addText(card, "h3", `${row.order_reference} · ${row.email}`);
      heading.id = `manual-order-${row.id}`;
      addText(card, "p", `Mẫu: ${templateTitle(row.template_id)} · Số tiền: ${
        new Intl.NumberFormat("vi-VN", {
          style: "currency",
          currency: row.currency,
        }).format(row.total_minor)
      }`);
      addText(card, "p", `Hết hạn: ${row.expires_at ? new Date(row.expires_at).toLocaleString("vi-VN") : "—"}`);
      const form = document.createElement("form");
      form.className = "manual-payment-form";
      form.dataset.orderId = row.id;
      form.dataset.amountMinor = String(row.total_minor);
      form.setAttribute("aria-labelledby", heading.id);

      const referenceLabel = document.createElement("label");
      const referenceId = `manual-reference-${row.id}`;
      referenceLabel.htmlFor = referenceId;
      referenceLabel.textContent = "Mã giao dịch ngân hàng (nếu có)";
      const reference = document.createElement("input");
      reference.id = referenceId;
      reference.name = "transaction_reference";
      reference.type = "text";
      reference.maxLength = 128;
      reference.autocomplete = "off";
      reference.autocapitalize = "characters";
      reference.spellcheck = false;
      reference.autocorrect = "off";
      form.append(referenceLabel, reference);

      const attestation = document.createElement("label");
      attestation.className = "manual-payment-attestation";
      const verified = document.createElement("input");
      verified.type = "checkbox";
      verified.name = "verified_received";
      verified.required = true;
      const attestationText = document.createElement("span");
      attestationText.textContent = "Tôi đã kiểm tra tiền vào tài khoản ngân hàng và số tiền khớp với đơn.";
      attestation.append(verified, attestationText);
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "Xác nhận đã nhận tiền";
      form.append(attestation, submit);
      card.append(form);
      target.append(card);
    }
  }

  function renderCustomRequests(rows) {
    const target = document.querySelector("#custom-requests");
    target.replaceChildren();
    if (!rows.length) {
      addText(target, "p", "Chưa có yêu cầu thiết kế riêng.", "empty");
      return;
    }
    for (const request of rows) {
      const card = document.createElement("article");
      card.className = "request-card";
      addText(card, "h3", `${templateTitle(request.preferred_template)} · ${request.status}`);
      addText(card, "p", `Khách hàng: ${request.email}`);
      addText(card, "p", `Gửi lúc: ${new Date(request.created_at).toLocaleString("vi-VN")}`);
      addText(card, "p", `Trạng thái trao đổi: ${request.communication_status}`);
      addText(card, "p", `Ý tưởng: ${request.brief}`);
      if (request.requirements) addText(card, "p", `Yêu cầu: ${request.requirements}`);
      if (request.requested_delivery_date) {
        addText(card, "p", `Ngày khách mong muốn: ${request.requested_delivery_date} · chưa phải cam kết`);
      }
      for (const url of request.reference_urls || []) addText(card, "p", `Tham khảo: ${url}`);
      if (request.customer_message) {
        addText(card, "p", `Tin nhắn khách đang thấy: ${request.customer_message}`);
      }
      if (request.customer_reply) {
        addText(card, "p", `Phản hồi từ khách hàng: ${request.customer_reply}`);
      }
      const actions = document.createElement("div");
      actions.className = "request-actions";
      if (request.status === "QUOTE_PENDING") {
        const start = document.createElement("button");
        start.type = "button";
        start.textContent = "Bắt đầu xem xét";
        start.dataset.requestId = request.id;
        start.dataset.reviewAction = "start_review";
        actions.append(start);
      }
      if (request.status === "QUOTE_PENDING" || request.status === "IN_REVIEW") {
        const message = document.createElement("textarea");
        message.maxLength = 2000;
        message.placeholder = "Thông tin cần khách bổ sung (tối đa 2.000 ký tự)";
        message.setAttribute("aria-label", `Yêu cầu bổ sung cho ${request.email}`);
        message.dataset.customerMessage = "true";
        const ask = document.createElement("button");
        ask.type = "button";
        ask.textContent = "Yêu cầu khách bổ sung";
        ask.dataset.requestId = request.id;
        ask.dataset.reviewAction = "request_information";
        actions.append(message, ask);
      } else if (request.status === "CUSTOMER_ACTION_REQUIRED") {
        const message = document.createElement("textarea");
        message.maxLength = 2000;
        message.placeholder = "Phản hồi cho khách hàng (tối đa 2.000 ký tự)";
        message.setAttribute("aria-label", `Phản hồi cho ${request.email}`);
        message.dataset.customerMessage = "true";
        const reply = document.createElement("button");
        reply.type = "button";
        reply.textContent = "Gửi phản hồi trong tài khoản";
        reply.dataset.requestId = request.id;
        reply.dataset.reviewAction = "reply";
        actions.append(message, reply);
      }
      card.append(actions);
      target.append(card);
    }
  }

  function renderOperations(data) {
    renderCustomRequests(data.custom_design_requests);
    renderManualPayments(data.pending_manual_payments);
    renderTable(document.querySelector("#orders"), data.orders, [
      { key: "order_reference", title: "Mã đơn" },
      { key: "email", title: "Khách hàng" },
      { key: "template_id", title: "Mẫu" },
      { key: "order_type", title: "Loại" },
      { key: "status", title: "Trạng thái" },
      { key: "total_minor", title: "Tổng (minor)" },
      { key: "payment_review_required", title: "Cần rà soát" },
      { key: "renewal_publication_id", title: "Publication gia hạn" },
      { key: "expires_at", title: "Hết hạn thanh toán" },
    ]);
    renderTable(document.querySelector("#payments"), data.payments, [
      { key: "order_reference", title: "Mã đơn" },
      { key: "email", title: "Khách hàng" },
      { key: "provider", title: "Provider" },
      { key: "provider_payment_id", title: "Mã giao dịch provider" },
      { key: "status", title: "Trạng thái" },
      { key: "amount_minor", title: "Số tiền (minor)" },
      { key: "review_required", title: "Cần rà soát" },
    ]);
    renderTable(document.querySelector("#settlement-evidence"), data.settlement_evidence, [
      { key: "order_reference", title: "Mã đơn" },
      { key: "evidence_source", title: "Nguồn bằng chứng" },
      { key: "source_transaction_id", title: "Mã giao dịch" },
      { key: "amount_minor", title: "Số tiền (minor)" },
      { key: "currency", title: "Tiền tệ" },
      { key: "status", title: "Trạng thái" },
      { key: "verified_at", title: "Thời điểm xác minh" },
    ]);
    renderTable(document.querySelector("#manual-payment-history"), data.manual_payment_confirmations, [
      { key: "order_reference", title: "Mã đơn" },
      { key: "actor_email", title: "Quản trị viên" },
      {
        key: "amount_minor",
        title: "Số tiền",
        value: (row) => new Intl.NumberFormat("vi-VN", {
          style: "currency",
          currency: row.currency,
        }).format(row.amount_minor),
      },
      { key: "transaction_reference", title: "Mã giao dịch" },
      { key: "confirmed_at", title: "Thời điểm xác nhận" },
    ]);
    renderTable(document.querySelector("#webhook-reviews"), data.webhook_reviews, [
      { key: "event_id", title: "Webhook event" },
      { key: "order_reference", title: "Mã đơn" },
      { key: "outcome", title: "Kết quả" },
      { key: "review_reason", title: "Lý do" },
      { key: "expected_amount_minor", title: "Dự kiến (minor)" },
      { key: "actual_amount_minor", title: "Thực tế (minor)" },
      { key: "received_at", title: "Nhận lúc" },
    ]);
    renderTable(document.querySelector("#fulfillment-jobs"), data.fulfillment_jobs, [
      { key: "order_reference", title: "Mã đơn" },
      { key: "email", title: "Khách hàng" },
      { key: "status", title: "Trạng thái" },
      { key: "attempts", title: "Lần thử" },
      { key: "last_error_code", title: "Mã lỗi" },
      { key: "next_attempt_at", title: "Thử lại sau" },
      { key: "lease_expires_at", title: "Lease hết hạn" },
    ]);
    renderTable(document.querySelector("#publications"), data.publications, [
      { key: "order_reference", title: "Mã đơn" },
      { key: "email", title: "Khách hàng" },
      { key: "template_id", title: "Mẫu" },
      { key: "status", title: "Website" },
      { key: "entitlement_status", title: "Gói hosting" },
      { key: "expires_at", title: "Website hết hạn" },
      { key: "entitlement_expires_at", title: "Entitlement hết hạn" },
      { key: "retention_delete_after_at", title: "Giữ đến" },
    ]);
    renderTable(document.querySelector("#derivative-operations"), data.derivative_operations, [
      { key: "publication_id", title: "Publication" },
      { key: "status", title: "Trạng thái" },
      { key: "cleanup_attempts", title: "Lần dọn" },
      { key: "last_cleanup_error_code", title: "Mã lỗi" },
      { key: "next_cleanup_at", title: "Đủ điều kiện lúc" },
      { key: "cleanup_lease_expires_at", title: "Lease hết hạn" },
    ]);
    renderTable(document.querySelector("#admin-activity"), data.admin_activity_events, [
      { key: "actor_email", title: "Tài khoản quản trị" },
      { key: "action", title: "Thao tác" },
      { key: "outcome", title: "Kết quả" },
      { key: "target_type", title: "Đối tượng" },
      { key: "target_id", title: "Mã đối tượng" },
      { key: "request_id", title: "Mã yêu cầu" },
      { key: "created_at", title: "Thời điểm" },
    ]);
  }

  async function loadOperations() {
    const data = await api("/admin/operations");
    renderOperations(data);
    dashboard.hidden = false;
    document.querySelector("#signout").hidden = false;
    showNotice(`Đã tải ${data.orders.length} đơn và ${data.custom_design_requests.length} yêu cầu thiết kế.`, "success");
  }

  async function start() {
    try {
      const customer = await api("/customers/me");
      csrfToken = customer.csrf_token || "";
      if (!csrfToken) throw new Error("Phiên đăng nhập chưa sẵn sàng.");
      await loadOperations();
    } catch (error) {
      dashboard.hidden = true;
      if (error?.status === 401) {
        showNotice("Đăng nhập bằng tài khoản quản trị được cho phép để tiếp tục.", "error");
      } else if (error?.status === 403 || error?.code === "ADMIN_DISABLED") {
        showNotice("Tài khoản này không được phép truy cập khu vực quản trị.", "error");
      } else {
        showNotice(error instanceof Error ? error.message : "Không thể tải dữ liệu quản trị.", "error");
      }
    }
  }

  async function reviewRequest(button) {
    const card = button.closest(".request-card");
    const action = button.dataset.reviewAction;
    const message = card.querySelector("[data-customer-message]")?.value.trim();
    if ((action === "request_information" || action === "reply") && !message) {
      showNotice("Hãy nhập nội dung gửi cho khách hàng.", "error");
      return;
    }
    button.disabled = true;
    try {
      await api(`/admin/custom-design/requests/${encodeURIComponent(button.dataset.requestId)}`, {
        method: "PATCH",
        body: JSON.stringify(action === "start_review"
          ? { action }
          : { action, customer_message: message }),
      });
      showNotice("Đã cập nhật trạng thái xem xét.", "success");
      await loadOperations();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Không thể cập nhật yêu cầu.", "error");
      button.disabled = false;
    }
  }

  async function confirmManualPayment(form) {
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    const reference = form.elements.namedItem("transaction_reference").value.trim();
    button.disabled = true;
    try {
      const result = await api(
        `/admin/orders/${encodeURIComponent(form.dataset.orderId)}/manual-payment-confirmation`,
        {
          method: "POST",
          body: JSON.stringify({
            amount_minor: Number(form.dataset.amountMinor),
            transaction_reference: reference || null,
          }),
        },
      );
      await loadOperations();
      showNotice(result.fulfillment?.completed
        ? "Đã xác nhận chuyển khoản và hoàn tất website."
        : "Đã xác nhận chuyển khoản; website đang chờ xử lý hoặc có thể cần thử lại.", "success");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Không thể xác nhận chuyển khoản.", "error");
      button.disabled = false;
    }
  }

  async function runOperation(path, button) {
    button.disabled = true;
    try {
      const result = await api(path, { method: "POST", body: "{}" });
      showNotice(JSON.stringify(result.result), "success");
      await loadOperations();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Không thể chạy tác vụ.", "error");
    } finally {
      button.disabled = false;
    }
  }

  document.querySelector("#custom-requests").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-review-action]");
    if (button) void reviewRequest(button);
  });
  document.querySelector("#manual-payments").addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-order-id]");
    if (!form) return;
    event.preventDefault();
    void confirmManualPayment(form);
  });
  document.querySelector("#recover-fulfillments").addEventListener("click", (event) => {
    void runOperation("/admin/fulfillments/recover", event.currentTarget);
  });
  document.querySelector("#reconcile-derivatives").addEventListener("click", (event) => {
    void runOperation("/admin/publication-derivatives/reconcile", event.currentTarget);
  });
  document.querySelector("#refresh").addEventListener("click", () => void loadOperations());
  document.querySelector("#signout").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/customers/session", { method: "DELETE", body: "{}" });
      location.replace("/");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Không thể đăng xuất.", "error");
      button.disabled = false;
    }
  });

  void start();
})();
