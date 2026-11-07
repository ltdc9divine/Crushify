(() => {
  "use strict";

  const notice = document.querySelector("#notice");
  const list = document.querySelector("#websites");
  let csrfToken = "";
  let rows = [];
  let storagePlans = [];

  function setNotice(text, state = "info") {
    notice.textContent = text;
    notice.dataset.state = state;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.method && options.method !== "GET") {
      headers.set("Content-Type", "application/json");
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

  function selectedAssets(card) {
    return [...card.querySelectorAll("input[data-asset]:checked")].map((input) => ({
      asset_id: input.dataset.asset,
      consent_version: "public-image-v1",
    }));
  }

  function addText(parent, tag, value, className = "") {
    const element = document.createElement(tag);
    element.textContent = value || "";
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  function makeCard(row) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.designId = row.design_id;
    addText(card, "h2", row.template_title);
    const details = document.createElement("div");
    details.className = "meta";
    const detail = (label, value) => {
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      p.append(strong, document.createTextNode(value || "—"));
      details.append(p);
    };
    detail("Đơn hàng", row.order_reference || "Chưa có đơn");
    detail("Thanh toán", row.payment_status || row.order_status || "Chưa thanh toán");
    detail("Website", row.publication_status || "Chưa tạo");
    detail("Phiên bản thiết kế", String(row.revision));
    if (row.storage_plan) {
      detail("Gói lưu trữ", `${row.storage_plan.title} (${row.storage_plan.status || "đang cập nhật"})`);
      if (row.storage_plan.activated_at) {
        detail("Kích hoạt lúc", new Date(row.storage_plan.activated_at).toLocaleString("vi-VN"));
      }
      if (row.storage_plan.expires_at) {
        const remaining = Math.ceil((Date.parse(row.storage_plan.expires_at) - Date.now()) / 86_400_000);
        const status = remaining <= 0 ? "Đã hết hạn" : remaining <= 7 ? "Sắp hết hạn" : "Đang hoạt động";
        detail("Trạng thái lưu trữ", status);
        detail("Hết hạn", `${new Date(row.storage_plan.expires_at).toLocaleString("vi-VN")} · ${Math.max(0, remaining)} ngày còn lại`);
      } else {
        detail("Trạng thái lưu trữ", "Trọn đời");
        detail("Thời hạn", "Trọn đời");
      }
    }
    if (row.fulfillment_status && row.fulfillment_status !== "COMPLETED") {
      detail("Xử lý đơn", row.fulfillment_status === "FAILED"
        ? "Đang chờ xử lý lại"
        : "Đang hoàn tất đơn hàng");
    }
    if (row.published_at) detail("Xuất bản lúc", new Date(row.published_at).toLocaleString("vi-VN"));
    if (row.renewal_history?.length) {
      const history = document.createElement("details");
      history.className = "renewal-history";
      const summary = document.createElement("summary");
      summary.textContent = `Lịch sử gói (${row.renewal_history.length})`;
      history.append(summary);
      for (const entry of row.renewal_history) {
        const line = document.createElement("p");
        const period = entry.expires_at
          ? `hết hạn ${new Date(entry.expires_at).toLocaleDateString("vi-VN")}`
          : "trọn đời";
        line.textContent = `${entry.storage_plan_title} · ${entry.status} · kích hoạt ${new Date(entry.activated_at).toLocaleDateString("vi-VN")} · ${period}`;
        history.append(line);
      }
      card.append(history);
    }
    card.append(details);

    if (row.photo_asset_ids?.length) {
      const consentBox = document.createElement("fieldset");
      consentBox.className = "consents";
      const legend = document.createElement("legend");
      legend.textContent = "Chọn ảnh được phép công khai";
      consentBox.append(legend);
      for (const [index, assetId] of row.photo_asset_ids.entries()) {
        const option = document.createElement("div");
        option.className = "asset-option";
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.asset = assetId;
        input.checked = row.consented_asset_ids?.includes(assetId) || false;
        const image = document.createElement("img");
        image.src = `/api/v1/assets/${encodeURIComponent(assetId)}`;
        image.alt = `Ảnh tải lên ${index + 1}`;
        image.loading = "lazy";
        const text = document.createElement("span");
        text.textContent = `Ảnh ${index + 1} — đồng ý hiển thị ảnh này trên website quà tặng.`;
        label.append(input, image, text);
        option.append(label);
        if (row.publication_id && row.publication_status !== "REVOKED" &&
            row.consented_asset_ids?.includes(assetId)) {
          const revokeConsent = document.createElement("button");
          revokeConsent.type = "button";
          revokeConsent.textContent = "Thu hồi";
          revokeConsent.dataset.action = "revoke-consent";
          revokeConsent.dataset.asset = assetId;
          option.append(revokeConsent);
        }
        consentBox.append(option);
      }
      card.append(consentBox);
    }

    if (row.public_url && row.publication_status === "PUBLISHED") {
      const link = document.createElement("a");
      link.className = "public-link";
      link.href = row.public_url;
      link.textContent = row.public_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const edit = document.createElement("a");
    edit.className = "button";
    edit.href = `/templates/${encodeURIComponent(row.template_id)}/index.html?design=${encodeURIComponent(row.design_id)}`;
    edit.textContent = "Mở trình chỉnh sửa / xem trước";
    actions.append(edit);
    if (row.payment_status === "SUCCEEDED" && !row.publication_id) {
      const create = document.createElement("button");
      create.className = "primary";
      create.textContent = "Tạo website";
      create.dataset.action = "create";
      actions.append(create);
    }
    if (row.publication_id && row.publication_status === "UNPUBLISHED") {
      const publish = document.createElement("button");
      publish.className = "primary";
      publish.textContent = row.published_at ? "Xuất bản lại" : "Xuất bản";
      publish.dataset.action = "publish";
      actions.append(publish);
    }
    if (row.publication_id && row.publication_status === "PUBLISHED") {
      const unpublish = document.createElement("button");
      unpublish.textContent = "Gỡ website";
      unpublish.dataset.action = "unpublish";
      actions.append(unpublish);
    }
    if (row.publication_id && row.publication_status !== "REVOKED") {
      const revoke = document.createElement("button");
      revoke.className = "danger";
      revoke.textContent = "Thu hồi liên kết";
      revoke.dataset.action = "revoke";
      actions.append(revoke);
    }
    if (row.publication_id && row.publication_status !== "REVOKED" &&
        row.revision > row.published_revision) {
      const update = document.createElement("button");
      update.textContent = "Chuẩn bị bản sửa";
      update.dataset.action = "update";
      actions.append(update);
    }
    if (row.publication_id && row.publication_status === "PUBLISHED") {
      const copy = document.createElement("button");
      copy.textContent = "Sao chép liên kết";
      copy.dataset.action = "copy";
      actions.append(copy);
    }
    if (row.publication_id && row.entitlement_status !== "LIFETIME" &&
        row.publication_status !== "REVOKED" && row.publication_status !== "DELETION_PENDING") {
      const select = document.createElement("select");
      select.dataset.plan = "";
      select.setAttribute("aria-label", "Chọn gói gia hạn");
      const prompt = document.createElement("option");
      prompt.value = "";
      prompt.textContent = "Chọn gói gia hạn";
      select.append(prompt);
      for (const plan of storagePlans) {
        const option = document.createElement("option");
        option.value = plan.id;
        option.textContent = plan.available && plan.amount_minor !== null
          ? `${plan.title} · ${plan.amount_minor.toLocaleString("vi-VN")} ${plan.currency}`
          : `${plan.title} · chưa được cấu hình`;
        option.disabled = !plan.available;
        select.append(option);
      }
      const renew = document.createElement("button");
      renew.textContent = "Tạo đơn gia hạn";
      renew.dataset.action = "renew";
      renew.disabled = !storagePlans.some((plan) => plan.available);
      actions.append(select, renew);
    }
    card.append(actions);
    return card;
  }

  function render() {
    list.replaceChildren();
    if (!rows.length) {
      addText(list, "p", "Chưa có thiết kế nào trong tài khoản.", "empty");
      return;
    }
    rows.forEach((row) => list.append(makeCard(row)));
  }

  async function refresh() {
    const response = await api("/publications");
    rows = response.websites || [];
    render();
    setNotice(`${rows.length} thiết kế trong tài khoản.`);
  }

  async function loadStoragePlans() {
    const response = await api("/storage-plans");
    storagePlans = response.plans || [];
  }

  async function createRenewalOrder(row, card) {
    const storagePlanId = card.querySelector("select[data-plan]")?.value;
    if (!storagePlanId) throw new Error("Hãy chọn gói lưu trữ cần gia hạn.");
    const order = await api("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        design_id: row.design_id,
        renewal_publication_id: row.publication_id,
        storage_plan_id: storagePlanId,
        asset_consents: [],
      }),
    });
    const amount = order.total_minor.toLocaleString("vi-VN");
    setNotice(`Đã tạo đơn ${order.order_reference} (${amount} ${order.currency}), trạng thái ${order.status}. Website chỉ được gia hạn sau khi thanh toán được xác minh.`);
    const instructions = order.payment?.instructions;
    if (instructions) {
      const box = document.createElement("section");
      box.className = "renewal-checkout";
      addText(box, "h3", "Thanh toán gia hạn");
      addText(box, "p", `Ngân hàng: ${instructions.bank_code || "—"} · Tài khoản: ${instructions.bank_account || "—"}`);
      addText(box, "p", `Số tiền: ${instructions.amount_minor.toLocaleString("vi-VN")} ${order.currency}`);
      addText(box, "p", `Nội dung chuyển khoản: ${instructions.reference}`);
      if (typeof instructions.qr_url === "string") {
        try {
          const qrUrl = new URL(instructions.qr_url, location.origin);
          if (qrUrl.protocol === "https:") {
            const link = document.createElement("a");
            link.href = qrUrl.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "Mở mã QR thanh toán";
            box.append(link);
          }
        } catch {
          addText(box, "p", "Máy chủ trả về liên kết mã QR không hợp lệ. Không tạo đơn khác; hãy dùng mã tham chiếu ở trên.");
        }
      }
      card.append(box);
    } else {
      setNotice(`Đơn gia hạn ${order.order_reference} đang chờ thanh toán. Cổng thanh toán hiện chưa được bật trong môi trường này.`);
    }
    return order;
  }

  async function createPublication(row, card) {
    if (!row.order_id) throw new Error("Thiết kế chưa có đơn hàng.");
    const created = await api("/publications", {
      method: "POST",
      body: JSON.stringify({
        order_id: row.order_id,
        expected_revision: row.revision,
        asset_consents: selectedAssets(card),
      }),
    });
    setNotice("Đã tạo website ở trạng thái chưa công khai. Hãy chọn Xuất bản khi sẵn sàng.");
    return created;
  }

  async function publishPublication(row) {
    return api(`/publications/${encodeURIComponent(row.publication_id)}/publish`, {
      method: "POST",
      body: JSON.stringify({ expected_lifecycle_revision: row.lifecycle_revision }),
    });
  }

  async function unpublishPublication(row) {
    return api(`/publications/${encodeURIComponent(row.publication_id)}/unpublish`, {
      method: "POST",
      body: JSON.stringify({ expected_lifecycle_revision: row.lifecycle_revision }),
    });
  }

  async function revokePublication(row) {
    return api(`/publications/${encodeURIComponent(row.publication_id)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ expected_lifecycle_revision: row.lifecycle_revision }),
    });
  }

  async function updatePublication(row, card) {
    let lifecycleRevision = row.lifecycle_revision;
    if (row.publication_status === "PUBLISHED") {
      const result = await unpublishPublication(row);
      lifecycleRevision = result.lifecycle_revision;
    }
    await api(`/publications/${encodeURIComponent(row.publication_id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: row.revision,
        expected_lifecycle_revision: lifecycleRevision,
        asset_consents: selectedAssets(card),
      }),
    });
    setNotice("Đã lưu snapshot mới ở trạng thái chưa công khai. Xuất bản lại để người nhận thấy thay đổi.");
  }

  list.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
    if (!button) return;
    const card = button.closest(".card");
    const row = rows.find((item) => item.design_id === card?.dataset.designId);
    if (!row || !(button instanceof HTMLButtonElement)) return;
    button.disabled = true;
    try {
      if (button.dataset.action === "create") await createPublication(row, card);
      else if (button.dataset.action === "publish") await publishPublication(row);
      else if (button.dataset.action === "unpublish") await unpublishPublication(row);
      else if (button.dataset.action === "revoke") await revokePublication(row);
      else if (button.dataset.action === "update") await updatePublication(row, card);
      else if (button.dataset.action === "renew") await createRenewalOrder(row, card);
      else if (button.dataset.action === "revoke-consent") {
        const assetId = button.dataset.asset;
        if (!assetId) throw new Error("Không tìm thấy ảnh cần thu hồi quyền.");
        await api(`/publications/${encodeURIComponent(row.publication_id)}/assets/${encodeURIComponent(assetId)}/consent`, {
          method: "POST",
          body: JSON.stringify({}),
        });
      }
      else if (button.dataset.action === "copy") {
        await navigator.clipboard.writeText(row.public_url);
        setNotice("Đã sao chép liên kết website.");
      }
      if (button.dataset.action !== "renew") await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Không thể hoàn tất yêu cầu.", "error");
      button.disabled = false;
    }
  });

  async function start() {
    try {
      const customer = await api("/customers/me");
      csrfToken = customer.csrf_token || "";
      await loadStoragePlans();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Hãy đăng nhập để xem thiết kế của bạn.", "error");
      const link = document.createElement("a");
      link.className = "button";
      link.href = "/templates/our-universe/";
      link.textContent = "Đăng nhập / mở Crushify";
      list.replaceChildren(link);
    }
  }

  void start();
})();
