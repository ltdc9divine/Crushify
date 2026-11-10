import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

const TEST_AMOUNT_VND = 50_000;
const TEST_STORAGE_AMOUNT_VND = 1_000;
const TEST_TOTAL_VND = TEST_AMOUNT_VND + TEST_STORAGE_AMOUNT_VND;

function signedHeaders(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const signature = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), bodyBytes]))
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-SePay-Timestamp": String(timestamp),
    "X-SePay-Signature": `sha256=${signature}`,
  };
}

export async function runPaymentContract({
  request,
  seedPrice,
  owner,
  designId,
  webhookSecret,
  receivingAccount,
  otherOwner,
  expireOrder,
  cancelOrder,
  failOrderPayment,
  restoreOrderPayment,
  inspectWebhookOutcomes,
  inspectWebhookEvent,
  setPublicationExpiry,
  deactivateTemplatePrice,
  inspectEntitlement,
  inspectOrderArtifacts,
  inspectOrderPricingSnapshot,
  tamperOrderPricingSnapshot,
  restoreOrderPricingSnapshot,
  setPaymentCurrency,
  restorePaymentCurrency,
  failPublicationCreation,
  restorePublicationCreation,
  recoverFulfillments,
  allTemplates = false,
  testStandardPricing = false,
  expectedMode = "sepay-test",
  label,
}) {
  const idempotencyKey = `payment-test-${randomUUID()}`;
  const createRequest = (key = idempotencyKey, id = designId, extra = {}) => request(
    "/orders",
    owner,
    {
      method: "POST",
      mutating: true,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        design_id: id,
        storage_plan_id: "1-month",
        asset_consents: [],
        ...extra,
      }),
    },
  );
  const unpriced = await createRequest(`unpriced-${randomUUID()}`);
  assert.equal(unpriced.response.status, 422, `${label}: empty catalog cannot create an order`);
  assert.equal(unpriced.body.error.code, "PRICE_UNAVAILABLE");
  await seedPrice(TEST_AMOUNT_VND);

  const unauthorized = await request("/orders", null, {
    method: "POST",
    json: { design_id: designId, storage_plan_id: "1-month", asset_consents: [] },
  });
  assert.equal(unauthorized.response.status, 401, `${label}: order requires authentication`);

  const tampered = await createRequest(`tampered-${randomUUID()}`, designId, { amount: 1 });
  assert.equal(tampered.response.status, 400, `${label}: client cannot set amount`);
  const forgedPayment = await createRequest(`forged-payment-${randomUUID()}`, designId, {
    paid: true,
    status: "PAID",
    payment_verified: true,
    amount_paid: TEST_TOTAL_VND,
  });
  assert.equal(forgedPayment.response.status, 400,
    `${label}: customer-supplied payment claims are rejected`);

  const created = await createRequest();
  assert.equal(created.response.status, 201, `${label}: create test order`);
  assert.equal(created.body.total_minor, TEST_TOTAL_VND, `${label}: server-side price snapshot`);
  if (inspectOrderPricingSnapshot) {
    await inspectOrderPricingSnapshot(created.body.order_id);
  }
  assert.equal(created.body.currency, "VND");
  assert.equal(created.body.status, "AWAITING_PAYMENT");
  assert.equal(created.body.payment.status, "PENDING");
  assert.deepEqual(created.body.storage_plan, {
    id: "1-month",
    title: "1 tháng",
    duration_months: 1,
    lifetime: false,
  });
  if (expectedMode === "mock") {
    assert.equal(created.body.payment.qr_url, null, `${label}: mock mode never presents a bank QR`);
    assert.equal(created.body.payment.instructions, null, `${label}: mock mode has no bank instructions`);
    assert.equal(created.body.payment.mock_mode, true);
  } else {
    assert.equal(created.body.payment.mock_mode, false);
    assert.ok(created.body.payment.qr_url, `${label}: Test mode instructions include a QR`);
    assert.deepEqual(created.body.payment.instructions, {
      bank_code: "MB",
      bank_account: receivingAccount,
      account_name: "Crushify Test",
      amount_minor: TEST_TOTAL_VND,
      reference: created.body.payment.reference,
      qr_url: created.body.payment.qr_url,
    });
  }
  assert.match(created.body.order_reference, /^CRF[A-F0-9]{16}$/);
  assert.match(created.body.payment.reference, /^CRP[A-F0-9]{16}$/);
  assert.notEqual(created.body.order_reference, created.body.payment.reference,
    `${label}: order and payment references are independent`);

  if (testStandardPricing) {
    const termCases = [
      [1, 59_000],
      [2, 69_000],
      [3, 79_000],
      [6, 109_000],
      [12, 169_000],
    ];
    for (const [months, total] of termCases) {
      const result = await request("/orders", owner, {
        method: "POST",
        mutating: true,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `policy-${months}-${randomUUID()}`,
        },
        body: JSON.stringify({
          design_id: designId,
          duration_type: "monthly",
          hosting_months: months,
          asset_consents: [],
        }),
      });
      assert.equal(result.response.status, 201, `${label}: create ${months}-month policy order`);
      assert.equal(result.body.total_minor, total, `${label}: calculate ${months}-month policy price`);
      assert.equal(result.body.pricing_snapshot.total_minor, total);
      assert.equal(result.body.pricing_snapshot.hosting_months, months);
      assert.equal(result.body.pricing_snapshot.pricing_version, "standard-v1");
      const reloaded = await request(`/orders/${result.body.order_id}/status`, owner);
      assert.deepEqual(reloaded.body.pricing_snapshot, result.body.pricing_snapshot,
        `${label}: persisted pricing snapshot is returned unchanged`);
    }

    const lifetime = await request("/orders", owner, {
      method: "POST",
      mutating: true,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `policy-lifetime-${randomUUID()}`,
      },
      body: JSON.stringify({
        design_id: designId,
        duration_type: "lifetime",
        hosting_months: null,
        asset_consents: [],
      }),
    });
    assert.equal(lifetime.response.status, 201, `${label}: create lifetime policy order`);
    assert.equal(lifetime.body.total_minor, 199_000, `${label}: lifetime is a single 199000 VND package`);
    assert.equal(lifetime.body.pricing_snapshot.duration_type, "lifetime");
    assert.equal(lifetime.body.pricing_snapshot.lifetime_price_minor, 199_000);
    assert.equal(lifetime.body.pricing_snapshot.hosting_months, null);

    for (const hostingMonths of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await request("/orders", owner, {
        method: "POST",
        mutating: true,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `invalid-months-${randomUUID()}`,
        },
        body: JSON.stringify({
          design_id: designId,
          duration_type: "monthly",
          hosting_months: hostingMonths,
        }),
      });
      assert.equal(invalid.response.status, 400, `${label}: reject invalid month count ${hostingMonths}`);
    }

    const modifiedPrice = await request("/orders", owner, {
      method: "POST",
      mutating: true,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `modified-total-${randomUUID()}`,
      },
      body: JSON.stringify({
        design_id: designId,
        duration_type: "monthly",
        hosting_months: 3,
        total_minor: 1,
      }),
    });
    assert.equal(modifiedPrice.response.status, 400, `${label}: client cannot supply a total`);
  }

  const retried = await createRequest();
  assert.equal(retried.response.status, 200, `${label}: idempotent retry`);
  assert.equal(retried.body.order_id, created.body.order_id);

  const concurrentKey = `concurrent-${randomUUID()}`;
  const concurrentOrders = await Promise.all([
    createRequest(concurrentKey),
    createRequest(concurrentKey),
  ]);
  assert.ok(concurrentOrders.every((item) => item.response.status === 200 || item.response.status === 201),
    `${label}: concurrent order retries succeed idempotently`);
  assert.equal(concurrentOrders[0].body.order_id, concurrentOrders[1].body.order_id);

  const otherDesign = await request("/designs", owner, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(otherDesign.response.status, 201);
  const conflictingKey = await createRequest(idempotencyKey, otherDesign.body.design_id);
  assert.equal(conflictingKey.response.status, 409, `${label}: idempotency key binds request payload`);

  const anonymousStatus = await request(`/orders/${created.body.order_id}/status`);
  assert.equal(anonymousStatus.response.status, 401, `${label}: order status requires authentication`);
  if (otherOwner) {
    const crossOwnerStatus = await request(`/orders/${created.body.order_id}/status`, otherOwner);
    assert.equal(crossOwnerStatus.response.status, 404, `${label}: another customer cannot read order details`);
    const crossOwnerCreate = await request("/orders", otherOwner, {
      method: "POST",
      mutating: true,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `cross-owner-${randomUUID()}`,
      },
      body: JSON.stringify({
        design_id: designId,
        storage_plan_id: "1-month",
        asset_consents: [],
      }),
    });
    assert.equal(crossOwnerCreate.response.status, 404, `${label}: another customer cannot order an owned draft`);
  }

  const invalidBody = JSON.stringify({ id: 880001, accountNumber: receivingAccount, code: created.body.payment.reference,
    transferType: "in", transferAmount: created.body.total_minor });
  const invalidSignature = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SePay-Timestamp": String(Math.floor(Date.now() / 1000)),
      "X-SePay-Signature": `sha256=${"0".repeat(64)}`,
    },
    body: invalidBody,
  });
  assert.equal(invalidSignature.response.status, 401, `${label}: reject invalid signature`);
  const missingSignature = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: invalidBody,
  });
  assert.equal(missingSignature.response.status, 401, `${label}: reject missing signature`);
  const futureHeaders = signedHeaders(webhookSecret, invalidBody, Math.floor(Date.now() / 1000) + 302);
  const future = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: futureHeaders,
    body: invalidBody,
  });
  assert.equal(future.response.status, 401, `${label}: reject future timestamp`);
  const wrongContentType = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: { ...signedHeaders(webhookSecret, invalidBody), "Content-Type": "text/plain" },
    body: invalidBody,
  });
  assert.equal(wrongContentType.response.status, 415, `${label}: webhook requires JSON`);
  const invalidUtf8Body = Buffer.from([0xc3, 0x28]);
  const invalidUtf8 = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, invalidUtf8Body),
    body: invalidUtf8Body,
  });
  assert.equal(invalidUtf8.response.status, 400, `${label}: reject invalid UTF-8 after signature verification`);

  const staleHeaders = signedHeaders(webhookSecret, invalidBody, Math.floor(Date.now() / 1000) - 301);
  const stale = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: staleHeaders,
    body: invalidBody,
  });
  assert.equal(stale.response.status, 401, `${label}: reject expired timestamp`);

  const validPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 1,
    accountNumber: receivingAccount,
    code: created.body.payment.reference,
    transferType: "in",
    transferAmount: created.body.total_minor,
  });
  const validHeaders = signedHeaders(webhookSecret, validPayload);
  const concurrentDeliveries = await Promise.all([
    request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: validHeaders,
      body: validPayload,
    }),
    request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: validHeaders,
      body: validPayload,
    }),
  ]);
  assert.deepEqual(concurrentDeliveries.map((item) => item.response.status), [200, 200],
    `${label}: concurrent duplicate webhook is acknowledged idempotently`);
  const paid = await request(`/orders/${created.body.order_id}/status`, owner);
  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.status, "FULFILLED", `${label}: verified payment and publication complete fulfillment`);
  assert.equal(paid.body.fulfillment_status, "COMPLETED");
  assert.equal(paid.body.payment.status, "SUCCEEDED");
  const replay = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: validHeaders,
    body: validPayload,
  });
  assert.equal(replay.response.status, 200, `${label}: provider retry is acknowledged`);
  const stillPaid = await request(`/orders/${created.body.order_id}/status`, owner);
  assert.equal(stillPaid.body.status, "FULFILLED", `${label}: replay does not apply the payment twice`);
  if (inspectOrderArtifacts) {
    const artifacts = await inspectOrderArtifacts(created.body.order_id);
    assert.deepEqual(artifacts, {
      payments: 1,
      processedEvents: 1,
      publications: 1,
      entitlements: 1,
      fulfillmentJobs: 1,
    }, `${label}: replay creates no duplicate settlement or fulfillment records`);
  }

  if (allTemplates) {
    const templateIds = [
      "our-universe",
      "love-letter",
      "our-memories",
      "say-yes",
      "distance-means-nothing",
    ];
    const workflows = [];
    for (const [index, templateId] of templateIds.entries()) {
      if (templateId === "our-universe") continue;
      const createdDesign = await request("/designs", owner, {
        method: "POST",
        mutating: true,
        json: { template_id: templateId, schema_version: templateId === "love-letter" ? 2 : 1 },
      });
      assert.equal(createdDesign.response.status, 201,
        `${label}: create ${templateId} with its current schema version`);
      const data = structuredClone(createdDesign.body.data);
      const marker = `mock-publication-${templateId}-${randomUUID()}`;
      if (templateId === "love-letter") {
        data.from = "Synthetic Sender";
        data.to = "Synthetic Recipient";
        data.msg = marker;
      } else if (templateId === "our-memories") {
        data.sender = "Synthetic Sender";
        data.receiver = "Synthetic Recipient";
        data.story = marker;
      } else if (templateId === "say-yes") {
        data.sender = "Synthetic Sender";
        data.receiver = "Synthetic Recipient";
        data.question = marker;
      } else if (templateId === "distance-means-nothing") {
        data.sender.name = "Synthetic Sender";
        data.receiver.name = "Synthetic Recipient";
        data.message = marker;
      }
      const saved = await request(`/designs/${createdDesign.body.design_id}`, owner, {
        method: "PUT",
        mutating: true,
        json: {
          schema_version: createdDesign.body.schema_version,
          expected_revision: 1,
          data,
        },
      });
      assert.equal(saved.response.status, 200, `${label}: customize ${templateId}`);
      assert.equal(saved.body.revision, 2);
      const reloaded = await request(`/designs/${createdDesign.body.design_id}`, owner);
      assert.equal(reloaded.response.status, 200, `${label}: reload ${templateId}`);
      assert.equal(reloaded.body.revision, 2);
      const markerFrom = (value) => templateId === "love-letter" ? value.msg
        : templateId === "our-memories" ? value.story
          : templateId === "say-yes" ? value.question
            : value.message;
      assert.equal(markerFrom(reloaded.body.data), marker, `${label}: persist ${templateId} customization`);

      const staleRevision = await request(`/designs/${createdDesign.body.design_id}`, owner, {
        method: "PUT",
        mutating: true,
        json: {
          schema_version: createdDesign.body.schema_version,
          expected_revision: 1,
          data: reloaded.body.data,
        },
      });
      assert.equal(staleRevision.response.status, 409, `${label}: reject stale ${templateId} revision`);
      if (otherOwner) {
        const crossOwnerRead = await request(`/designs/${createdDesign.body.design_id}`, otherOwner);
        assert.equal(crossOwnerRead.response.status, 404, `${label}: protect ${templateId} design ownership`);
        const crossOwnerUpdate = await request(`/designs/${createdDesign.body.design_id}`, otherOwner, {
          method: "PUT",
          mutating: true,
          json: {
            schema_version: createdDesign.body.schema_version,
            expected_revision: 2,
            data: reloaded.body.data,
          },
        });
        assert.equal(crossOwnerUpdate.response.status, 404,
          `${label}: reject cross-owner ${templateId} updates`);
      }

      const preview = await request(`/designs/${createdDesign.body.design_id}/preview`, owner, {
        method: "POST",
        mutating: true,
      });
      assert.equal(preview.response.status, 201, `${label}: preview ${templateId}`);
      const previewData = await request("/previews", null, { token: preview.body.token });
      assert.equal(previewData.response.status, 200);
      assert.equal(previewData.body.template_id, templateId);
      assert.equal(markerFrom(previewData.body.data), marker, `${label}: preview saved ${templateId} data`);

      if (testStandardPricing) {
        const policyOrder = await request("/orders", owner, {
          method: "POST",
          mutating: true,
          headers: { "Idempotency-Key": `policy-${templateId}-${randomUUID()}` },
          json: {
            design_id: createdDesign.body.design_id,
            duration_type: "monthly",
            hosting_months: 3,
          },
        });
        assert.equal(policyOrder.response.status, 201,
          `${label}: central pricing accepts standard product ${templateId}`);
        assert.equal(policyOrder.body.total_minor, 79_000,
          `${label}: central 3-month total is consistent for ${templateId}`);
        assert.equal(policyOrder.body.pricing_snapshot.template_id, templateId);
      }

      const order = await request("/orders", owner, {
        method: "POST",
        mutating: true,
        headers: { "Idempotency-Key": `phase712-${randomUUID()}` },
        json: {
          design_id: createdDesign.body.design_id,
          storage_plan_id: "1-month",
          asset_consents: [],
        },
      });
      assert.equal(order.response.status, 201, `${label}: create ${templateId} order`);
      assert.equal(order.body.total_minor, TEST_TOTAL_VND);
      assert.equal(order.body.design_revision, 2);
      const unpaidPublication = await request("/publications", owner, {
        method: "POST",
        mutating: true,
        json: {
          order_id: order.body.order_id,
          expected_revision: 2,
          asset_consents: [],
        },
      });
      assert.equal(unpaidPublication.response.status, 422,
        `${label}: unpublished ${templateId} order cannot be published`);
      assert.equal(unpaidPublication.body.error.code, "PAYMENT_NOT_VERIFIED");
      workflows.push({ templateId, marker, designId: createdDesign.body.design_id, order });
    }

    for (const [index, workflow] of workflows.entries()) {
      const transactionId = String(Date.now() * 100 + index + 100);
      const payload = JSON.stringify({
        id: transactionId,
        accountNumber: receivingAccount,
        code: workflow.order.body.payment.reference,
        transferType: "in",
        transferAmount: workflow.order.body.total_minor,
      });
      if (workflow.templateId === "distance-means-nothing" && failPublicationCreation) {
        await failPublicationCreation(workflow.order.body.order_id);
      }
      const settlement = await request("/payments/sepay/webhook", null, {
        method: "POST",
        headers: signedHeaders(webhookSecret, payload),
        body: payload,
      });
      assert.equal(settlement.response.status, 200,
        `${label}: signed local settlement for ${workflow.templateId}`);
      if (workflow.templateId === "distance-means-nothing" && failPublicationCreation) {
        const deferred = await request(`/orders/${workflow.order.body.order_id}/status`, owner);
        assert.equal(deferred.body.status, "FULFILLING",
          `${label}: publication failure leaves the paid order retryable`);
        assert.equal(deferred.body.payment.status, "SUCCEEDED");
        const failed = await inspectOrderArtifacts(workflow.order.body.order_id);
        assert.deepEqual(failed, {
          payments: 1,
          processedEvents: 1,
          publications: 0,
          entitlements: 0,
          fulfillmentJobs: 1,
          failedJobs: 1,
        });
        await restorePublicationCreation(workflow.order.body.order_id);
        const recovered = await recoverFulfillments();
        assert.equal(recovered.completed, 1, `${label}: recovery retries failed fulfillment`);
      }

      const status = await request(`/orders/${workflow.order.body.order_id}/status`, owner);
      assert.equal(status.body.status, "FULFILLED",
        `${label}: ${workflow.templateId} fulfillment completes`);
      assert.equal(status.body.payment.status, "SUCCEEDED");
      const websites = await request("/publications", owner);
      assert.equal(websites.response.status, 200);
      const website = websites.body.websites.find((item) => item.design_id === workflow.designId);
      assert.ok(website?.publication_id, `${label}: ${workflow.templateId} has a publication`);
      assert.equal(website.template_id, workflow.templateId);
      assert.equal(website.publication_status, "PUBLISHED");
      assert.ok(website.storage_plan?.expires_at, `${label}: storage entitlement has an expiry`);

      const detail = await request(`/publications/${website.publication_id}`, owner);
      assert.equal(detail.response.status, 200);
      assert.equal(detail.body.status, "PUBLISHED");
      const slug = new URL(detail.body.url).pathname.split("/").at(-1);
      assert.match(slug, /^g[A-Za-z0-9_-]{20,40}$/);
      const publicSite = await request(`/publications/${slug}`);
      assert.equal(publicSite.response.status, 200,
        `${label}: public ${workflow.templateId} site resolves without a session`);
      assert.equal(publicSite.body.template_id, workflow.templateId);
      const publicMarker = workflow.templateId === "love-letter"
        ? publicSite.body.data.msg
        : workflow.templateId === "our-memories"
          ? publicSite.body.data.story
          : workflow.templateId === "say-yes"
            ? publicSite.body.data.question
            : publicSite.body.data.message;
      assert.equal(publicMarker, workflow.marker,
        `${label}: ${workflow.templateId} public snapshot matches its saved revision`);
      const foreignDesign = await request(`/designs/${workflow.designId}`, otherOwner);
      assert.equal(foreignDesign.response.status, 404);
      const foreignOrder = await request(`/orders/${workflow.order.body.order_id}/status`, otherOwner);
      assert.equal(foreignOrder.response.status, 404);
      const foreignPublication = await request(`/publications/${website.publication_id}`, otherOwner);
      assert.equal(foreignPublication.response.status, 404);
      const foreignMutation = await request(`/publications/${website.publication_id}/revoke`, otherOwner, {
        method: "POST",
        mutating: true,
        json: { expected_lifecycle_revision: detail.body.lifecycle_revision },
      });
      assert.equal(foreignMutation.response.status, 404);
      if (workflow.templateId === "love-letter") {
        await setPublicationExpiry(website.publication_id, "2000-01-01T00:00:00.000Z");
        const expired = await request(`/publications/${slug}`);
        assert.equal(expired.response.status, 410,
          `${label}: expired ${workflow.templateId} site is not served`);
        const entitlement = await inspectEntitlement(workflow.order.body.order_id);
        assert.equal(entitlement.status, "EXPIRED");
      } else if (workflow.templateId === "say-yes") {
        const revoked = await request(`/publications/${website.publication_id}/revoke`, owner, {
          method: "POST",
          mutating: true,
          json: { expected_lifecycle_revision: detail.body.lifecycle_revision },
        });
        assert.equal(revoked.response.status, 200);
        const revokedEntitlement = await inspectEntitlement(workflow.order.body.order_id);
        assert.equal(revokedEntitlement.status, "REVOKED");
        const unavailable = await request(`/publications/${slug}`);
        assert.equal(unavailable.response.status, 410,
          `${label}: revoked ${workflow.templateId} site is not served`);
      }
      if (inspectOrderArtifacts) {
        const artifacts = await inspectOrderArtifacts(workflow.order.body.order_id);
        assert.deepEqual(artifacts, {
          payments: 1,
          processedEvents: 1,
          publications: 1,
          entitlements: 1,
          fulfillmentJobs: 1,
        }, `${label}: ${workflow.templateId} settlement and fulfillment are idempotent`);
      }
    }
    const invalidSlug = await request("/publications/not-a-valid-slug");
    assert.equal(invalidSlug.response.status, 404,
      `${label}: invalid public slugs are not served`);
  }

  const mismatchOrder = await createRequest(`mismatch-${randomUUID()}`);
  assert.equal(mismatchOrder.response.status, 201);
  const mismatchTransactionId = String(Number(`${Date.now()}`.slice(-8)) + 2);
  const mismatchPayload = JSON.stringify({
    id: mismatchTransactionId,
    accountNumber: receivingAccount,
    code: mismatchOrder.body.payment.reference,
    transferType: "in",
    transferAmount: mismatchOrder.body.total_minor - 1,
  });
  const mismatch = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, mismatchPayload),
    body: mismatchPayload,
  });
  assert.equal(mismatch.response.status, 200, `${label}: verified mismatch is persisted for review`);
  const manualReview = await request(`/orders/${mismatchOrder.body.order_id}/status`, owner);
  assert.equal(manualReview.body.status, expectedMode === "mock" ? "AWAITING_PAYMENT" : "MANUAL_REVIEW");
  assert.equal(manualReview.body.payment.status, expectedMode === "mock" ? "PENDING" : "MANUAL_REVIEW");
  if (inspectWebhookEvent) {
    const mismatchEvent = await inspectWebhookEvent(mismatchTransactionId);
    assert.equal(mismatchEvent.outcome, "MANUAL_REVIEW");
    assert.equal(mismatchEvent.expected_amount_minor, mismatchOrder.body.total_minor);
    assert.equal(mismatchEvent.actual_amount_minor, mismatchOrder.body.total_minor - 1);
    assert.equal(mismatchEvent.provider_transaction_id, mismatchTransactionId);
    assert.ok(mismatchEvent.processing_attempts >= 1);
  }
  if (tamperOrderPricingSnapshot && restoreOrderPricingSnapshot) {
    const snapshotOrder = await createRequest(`snapshot-mismatch-${randomUUID()}`);
    assert.equal(snapshotOrder.response.status, 201);
    const originalMetadata = await tamperOrderPricingSnapshot(snapshotOrder.body.order_id);
    const snapshotTransactionId = String(Number(`${Date.now()}`.slice(-8)) + 7);
    const snapshotPayload = JSON.stringify({
      id: snapshotTransactionId,
      accountNumber: receivingAccount,
      code: snapshotOrder.body.payment.reference,
      transferType: "in",
      transferAmount: snapshotOrder.body.total_minor,
    });
    const snapshotMismatch = await request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: signedHeaders(webhookSecret, snapshotPayload),
      body: snapshotPayload,
    });
    assert.equal(snapshotMismatch.response.status, 200);
    const unverified = await request(`/orders/${snapshotOrder.body.order_id}/status`, owner);
    assert.notEqual(unverified.body.status, "PAID",
      `${label}: settlement is rejected when payment and saved price snapshot differ`);
    if (inspectWebhookEvent) {
      assert.equal((await inspectWebhookEvent(snapshotTransactionId)).outcome, "MANUAL_REVIEW");
    }
    await restoreOrderPricingSnapshot(snapshotOrder.body.order_id, originalMetadata);
  }
  if (setPaymentCurrency && restorePaymentCurrency) {
    const currencyOrder = await createRequest(`currency-${randomUUID()}`);
    const currencyTransactionId = String(Number(`${Date.now()}`.slice(-8)) + 11);
    const currencyPayload = JSON.stringify({
      id: currencyTransactionId,
      accountNumber: receivingAccount,
      code: currencyOrder.body.payment.reference,
      transferType: "in",
      transferAmount: currencyOrder.body.total_minor,
    });
    await setPaymentCurrency(currencyOrder.body.order_id, "USD");
    try {
      const currencyWebhook = await request("/payments/sepay/webhook", null, {
        method: "POST",
        headers: signedHeaders(webhookSecret, currencyPayload),
        body: currencyPayload,
      });
      assert.equal(currencyWebhook.response.status, 200);
    } finally {
      await restorePaymentCurrency(currencyOrder.body.order_id);
    }
    const currencyStatus = await request(`/orders/${currencyOrder.body.order_id}/status`, owner);
    assert.equal(currencyStatus.body.status,
      expectedMode === "mock" ? "AWAITING_PAYMENT" : "MANUAL_REVIEW",
      `${label}: mismatched payment currency cannot settle the order`);
    if (expectedMode === "mock") assert.equal(currencyStatus.body.payment.status, "PENDING");
    if (inspectWebhookEvent) {
      const currencyEvent = await inspectWebhookEvent(currencyTransactionId);
      assert.equal(currencyEvent.outcome, "MANUAL_REVIEW");
    }
  }
  const referenceOrder = await createRequest(`reference-${randomUUID()}`);
  const referenceTransactionId = String(Number(`${Date.now()}`.slice(-8)) + 12);
  const referencePayload = JSON.stringify({
    id: referenceTransactionId,
    accountNumber: receivingAccount,
    code: `${referenceOrder.body.payment.reference}X`,
    transferType: "in",
    transferAmount: referenceOrder.body.total_minor,
  });
  const referenceWebhook = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, referencePayload),
    body: referencePayload,
  });
  assert.equal(referenceWebhook.response.status, 200);
  const referenceStatus = await request(`/orders/${referenceOrder.body.order_id}/status`, owner);
  assert.equal(referenceStatus.body.status, "AWAITING_PAYMENT",
    `${label}: a mismatched payment reference is rejected without settling the order`);
  assert.equal(referenceStatus.body.payment.status, "PENDING");
  if (inspectWebhookEvent) {
    const referenceEvent = await inspectWebhookEvent(referenceTransactionId);
    assert.equal(referenceEvent.outcome, "MANUAL_REVIEW");
  }

  const wrongAccountOrder = await createRequest(`account-${randomUUID()}`);
  const wrongAccountPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 3,
    accountNumber: "0000000001",
    code: wrongAccountOrder.body.payment.reference,
    transferType: "in",
    transferAmount: wrongAccountOrder.body.total_minor,
  });
  const wrongAccount = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, wrongAccountPayload),
    body: wrongAccountPayload,
  });
  assert.equal(wrongAccount.response.status, 200);
  const accountReview = await request(`/orders/${wrongAccountOrder.body.order_id}/status`, owner);
  assert.equal(accountReview.body.status, expectedMode === "mock" ? "AWAITING_PAYMENT" : "MANUAL_REVIEW");
  if (expectedMode === "mock") assert.equal(accountReview.body.payment.status, "PENDING");

  const overpaymentOrder = await createRequest(`overpayment-${randomUUID()}`);
  const overpaymentPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 8,
    accountNumber: receivingAccount,
    code: overpaymentOrder.body.payment.reference,
    transferType: "in",
    transferAmount: overpaymentOrder.body.total_minor + 1,
  });
  const overpayment = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, overpaymentPayload),
    body: overpaymentPayload,
  });
  assert.equal(overpayment.response.status, 200);
  const overpaymentReview = await request(`/orders/${overpaymentOrder.body.order_id}/status`, owner);
  assert.equal(overpaymentReview.body.status, expectedMode === "mock" ? "AWAITING_PAYMENT" : "MANUAL_REVIEW",
    `${label}: overpayment never marks an order paid`);
  if (expectedMode === "mock") assert.equal(overpaymentReview.body.payment.status, "PENDING");

  const competingOrder = await createRequest(`competing-${randomUUID()}`);
  assert.equal(competingOrder.response.status, 201);
  const transactionIds = [Date.now() * 10 + 1, Date.now() * 10 + 2];
  const competingDeliveries = await Promise.all(transactionIds.map((id) => {
    const body = JSON.stringify({
      id,
      accountNumber: receivingAccount,
      code: competingOrder.body.payment.reference,
      transferType: "in",
      transferAmount: competingOrder.body.total_minor,
    });
    return request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: signedHeaders(webhookSecret, body),
      body,
    });
  }));
  assert.deepEqual(competingDeliveries.map((item) => item.response.status), [200, 200]);
  const competingStatus = await request(`/orders/${competingOrder.body.order_id}/status`, owner);
  assert.equal(competingStatus.body.status, "FULFILLED",
    `${label}: concurrent different transactions cannot prevent verified fulfillment`);
  if (inspectWebhookOutcomes) {
    const outcomes = await inspectWebhookOutcomes(transactionIds.map(String));
    assert.deepEqual(outcomes.sort(), ["MANUAL_REVIEW", "PROCESSED"],
      `${label}: only the transaction linked to the payment is processed`);
  }
  const duplicateOrder = await createRequest(`same-transaction-${randomUUID()}`);
  const duplicateTransactionPayload = JSON.stringify({
    id: validPayload && JSON.parse(validPayload).id,
    accountNumber: receivingAccount,
    code: duplicateOrder.body.payment.reference,
    transferType: "in",
    transferAmount: duplicateOrder.body.total_minor,
  });
  const collision = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, duplicateTransactionPayload),
    body: duplicateTransactionPayload,
  });
  assert.equal(collision.response.status, 200);
  const collisionReview = await request(`/orders/${duplicateOrder.body.order_id}/status`, owner);
  assert.equal(collisionReview.body.status, expectedMode === "mock" ? "AWAITING_PAYMENT" : "MANUAL_REVIEW",
    `${label}: one provider transaction cannot pay a second order`);

  const expiredOrder = await createRequest(`expired-${randomUUID()}`);
  assert.equal(expiredOrder.response.status, 201);
  if (expireOrder) await expireOrder(expiredOrder.body.order_id);
  const expiredStatus = await request(`/orders/${expiredOrder.body.order_id}/status`, owner);
  assert.equal(expiredStatus.body.status, "EXPIRED", `${label}: pending order expires server-side`);
  const latePayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 4,
    accountNumber: receivingAccount,
    code: expiredOrder.body.payment.reference,
    transferType: "in",
    transferAmount: expiredOrder.body.total_minor,
  });
  const late = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, latePayload),
    body: latePayload,
  });
  assert.equal(late.response.status, 200);
  const lateReview = await request(`/orders/${expiredOrder.body.order_id}/status`, owner);
  assert.equal(lateReview.body.status, expectedMode === "mock" ? "EXPIRED" : "MANUAL_REVIEW",
    `${label}: late transfer is reviewed, not paid`);

  if (cancelOrder) {
    const cancelledOrder = await createRequest(`cancelled-${randomUUID()}`);
    await cancelOrder(cancelledOrder.body.order_id);
    const cancelledPayload = JSON.stringify({
      id: Number(`${Date.now()}`.slice(-8)) + 9,
      accountNumber: receivingAccount,
      code: cancelledOrder.body.payment.reference,
      transferType: "in",
      transferAmount: cancelledOrder.body.total_minor,
    });
    const cancelledWebhook = await request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: signedHeaders(webhookSecret, cancelledPayload),
      body: cancelledPayload,
    });
    assert.equal(cancelledWebhook.response.status, 200);
    const cancelledStatus = await request(`/orders/${cancelledOrder.body.order_id}/status`, owner);
    assert.equal(cancelledStatus.body.status, expectedMode === "mock" ? "CANCELLED" : "MANUAL_REVIEW",
      `${label}: a late transfer cannot pay a cancelled order`);
  }

  if (failOrderPayment && restoreOrderPayment && inspectWebhookEvent) {
    const recoveryOrder = await createRequest(`recovery-${randomUUID()}`);
    const recoveryTransactionId = String(Number(`${Date.now()}`.slice(-8)) + 10);
    const recoveryPayload = JSON.stringify({
      id: recoveryTransactionId,
      accountNumber: receivingAccount,
      code: recoveryOrder.body.payment.reference,
      transferType: "in",
      transferAmount: recoveryOrder.body.total_minor,
    });
    await failOrderPayment(recoveryOrder.body.order_id);
    const failedProcessing = await request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: signedHeaders(webhookSecret, recoveryPayload),
      body: recoveryPayload,
    });
    assert.equal(failedProcessing.response.status, 500,
      `${label}: database transaction failure is retriable`);
    const stillPending = await request(`/orders/${recoveryOrder.body.order_id}/status`, owner);
    assert.equal(stillPending.body.status, "AWAITING_PAYMENT",
      `${label}: failed batch does not partially mark order paid`);
    const pendingEvent = await inspectWebhookEvent(recoveryTransactionId);
    assert.equal(pendingEvent.outcome, "RECEIVED");
    await restoreOrderPayment(recoveryOrder.body.order_id);
    const recovered = await request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: signedHeaders(webhookSecret, recoveryPayload),
      body: recoveryPayload,
    });
    assert.equal(recovered.response.status, 200);
    const recoveredStatus = await request(`/orders/${recoveryOrder.body.order_id}/status`, owner);
    assert.equal(recoveredStatus.body.status, "FULFILLED",
      `${label}: provider retry recovers an event persisted before a failed transaction`);
    const recoveredEvent = await inspectWebhookEvent(recoveryTransactionId);
    assert.equal(recoveredEvent.outcome, "PROCESSED");
    assert.ok(recoveredEvent.processing_attempts >= 2);
  }

  const outgoingOrder = await createRequest(`outgoing-${randomUUID()}`);
  const outgoingPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 5,
    accountNumber: receivingAccount,
    code: outgoingOrder.body.payment.reference,
    transferType: "out",
    transferAmount: outgoingOrder.body.total_minor,
  });
  const outgoing = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, outgoingPayload),
    body: outgoingPayload,
  });
  assert.equal(outgoing.response.status, 200);
  const outgoingReview = await request(`/orders/${outgoingOrder.body.order_id}/status`, owner);
  assert.equal(outgoingReview.body.status, expectedMode === "mock" ? "AWAITING_PAYMENT" : "MANUAL_REVIEW");
  if (expectedMode === "mock") assert.equal(outgoingReview.body.payment.status, "PENDING");

  const unmatchedPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 6,
    accountNumber: receivingAccount,
    code: "CRFNOTANORDER",
    transferType: "in",
    transferAmount: TEST_TOTAL_VND,
  });
  const unmatched = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, unmatchedPayload),
    body: unmatchedPayload,
  });
  assert.equal(unmatched.response.status, 200, `${label}: unmatched transfer is durably acknowledged`);

  const malformedPayload = "{";
  const malformed = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, malformedPayload),
    body: malformedPayload,
  });
  assert.equal(malformed.response.status, 200, `${label}: signed malformed payload is retained for review`);

  if (setPublicationExpiry && deactivateTemplatePrice && inspectEntitlement) {
    const websites = await request("/publications", owner);
    assert.equal(websites.response.status, 200, `${label}: load owned publication for renewal tests`);
    const website = websites.body.websites.find((item) => item.design_id === designId);
    assert.ok(website?.publication_id, `${label}: initial paid order creates a publication`);
    const publication = await request(`/publications/${website.publication_id}`, owner);
    assert.equal(publication.response.status, 200);
    const originalUrl = publication.body.url;
    await deactivateTemplatePrice();
    await setPublicationExpiry(website.publication_id, "2099-01-31T12:00:00.000Z");

    const submitRenewal = (planId, idempotencyKey = randomUUID()) => request("/orders", owner, {
      method: "POST",
      mutating: true,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `renewal-${idempotencyKey}`,
      },
      body: JSON.stringify({
        design_id: designId,
        renewal_publication_id: website.publication_id,
        storage_plan_id: planId,
        asset_consents: [],
      }),
    });
    const addMonths = (value, months) => {
      const start = new Date(value);
      const day = start.getUTCDate();
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() + months);
      const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
      start.setUTCDate(Math.min(day, lastDay));
      return start.toISOString();
    };
    let transactionSequence = 0;
    const makeRenewalPayment = (order) => {
      const transactionId = String(Date.now() * 100 + ++transactionSequence);
      const payload = JSON.stringify({
        id: transactionId,
        accountNumber: receivingAccount,
        code: order.body.payment.reference,
        transferType: "in",
        transferAmount: order.body.total_minor,
      });
      const options = {
        method: "POST",
        headers: signedHeaders(webhookSecret, payload),
        body: payload,
      };
      return options;
    };
    const confirmRenewal = async (order) => {
      const options = makeRenewalPayment(order);
      const [firstDelivery, duplicateDelivery] = await Promise.all([
        request("/payments/sepay/webhook", null, options),
        request("/payments/sepay/webhook", null, options),
      ]);
      assert.deepEqual(
        [firstDelivery.response.status, duplicateDelivery.response.status].sort(),
        [200, 200],
        `${label}: duplicate renewal webhook delivery is acknowledged`,
      );
      const status = await request(`/orders/${order.body.order_id}/status`, owner);
      assert.equal(status.body.status, "FULFILLED", `${label}: renewal fulfillment completes`);
      return { options };
    };

    const concurrentKey = randomUUID();
    const [renewalA, renewalB] = await Promise.all([
      submitRenewal("1-month", concurrentKey),
      submitRenewal("1-month", concurrentKey),
    ]);
    assert.ok([200, 201].includes(renewalA.response.status));
    assert.ok([200, 201].includes(renewalB.response.status));
    assert.equal(renewalA.body.order_id, renewalB.body.order_id,
      `${label}: concurrent renewal requests with one idempotency key share one order`);
    assert.equal(renewalA.body.total_minor, TEST_STORAGE_AMOUNT_VND,
      `${label}: renewal uses only the server-side storage price`);

    let expectedExpiry = "2099-01-31T12:00:00.000Z";
    const concurrentRenewals = await Promise.all([
      submitRenewal("1-month"),
      submitRenewal("1-month"),
    ]);
    assert.ok(concurrentRenewals.every((renewal) => renewal.response.status === 201),
      `${label}: distinct concurrent renewal orders can be created`);
    assert.notEqual(concurrentRenewals[0].body.order_id, concurrentRenewals[1].body.order_id);
    const concurrentResults = await Promise.all(concurrentRenewals.map((order) =>
      request("/payments/sepay/webhook", null, makeRenewalPayment(order))));
    assert.ok(concurrentResults.every((result) => result.response.status === 200),
      `${label}: concurrent paid renewal webhooks are acknowledged`);
    for (const order of concurrentRenewals) {
      const status = await request(`/orders/${order.body.order_id}/status`, owner);
      assert.equal(status.body.status, "FULFILLED",
        `${label}: distinct concurrent renewal orders both fulfill`);
    }
    const concurrentEntitlements = await Promise.all(concurrentRenewals.map((order) =>
      inspectEntitlement(order.body.order_id)));
    const orderedEntitlements = concurrentEntitlements.sort((left, right) =>
      left.starts_at.localeCompare(right.starts_at));
    const firstConcurrentExpiry = addMonths(expectedExpiry, 1);
    expectedExpiry = addMonths(firstConcurrentExpiry, 1);
    assert.equal(orderedEntitlements[0].previous_expires_at, "2099-01-31T12:00:00.000Z");
    assert.equal(orderedEntitlements[0].expires_at, firstConcurrentExpiry);
    assert.equal(orderedEntitlements[1].previous_expires_at, firstConcurrentExpiry);
    assert.equal(orderedEntitlements[1].expires_at, expectedExpiry,
      `${label}: concurrent renewals do not lose an extension`);

    const firstRenewal = await confirmRenewal(renewalA);
    let firstEntitlement = await inspectEntitlement(renewalA.body.order_id);
    assert.equal(firstEntitlement.starts_at, expectedExpiry);
    assert.equal(firstEntitlement.previous_expires_at, expectedExpiry);
    expectedExpiry = addMonths(expectedExpiry, 1);
    assert.equal(firstEntitlement.expires_at, expectedExpiry,
      `${label}: one-month renewal uses calendar-month arithmetic at month end`);

    await request("/payments/sepay/webhook", null, firstRenewal.options);
    firstEntitlement = await inspectEntitlement(renewalA.body.order_id);
    assert.equal(firstEntitlement.expires_at, expectedExpiry,
      `${label}: replaying a processed renewal webhook does not extend twice`);

    for (const [planId, months] of [["3-months", 3], ["6-months", 6], ["12-months", 12]]) {
      const renewal = await submitRenewal(planId);
      assert.equal(renewal.response.status, 201, `${label}: create ${planId} extension`);
      assert.equal(renewal.body.total_minor, TEST_STORAGE_AMOUNT_VND);
      await confirmRenewal(renewal);
      const entitlement = await inspectEntitlement(renewal.body.order_id);
      assert.equal(entitlement.previous_expires_at, expectedExpiry);
      assert.equal(entitlement.starts_at, expectedExpiry);
      expectedExpiry = addMonths(expectedExpiry, months);
      assert.equal(entitlement.expires_at, expectedExpiry,
        `${label}: ${planId} renewal extends from the existing expiry`);
    }

    const afterActiveRenewals = await request(`/publications/${website.publication_id}`, owner);
    assert.equal(afterActiveRenewals.body.url, originalUrl, `${label}: active renewal preserves the slug`);
    assert.equal(afterActiveRenewals.body.expires_at, expectedExpiry);

    await setPublicationExpiry(website.publication_id, "2000-01-01T00:00:00.000Z");
    const slug = new URL(originalUrl).pathname.split("/").at(-1);
    const expiredRead = await request(`/publications/${slug}`);
    assert.equal(expiredRead.response.status, 410, `${label}: expired recipient content is denied`);
    const expiredRenewal = await submitRenewal("3-months");
    assert.equal(expiredRenewal.response.status, 201);
    await confirmRenewal(expiredRenewal);
    const expiredEntitlement = await inspectEntitlement(expiredRenewal.body.order_id);
    assert.equal(expiredEntitlement.starts_at, expiredEntitlement.activated_at,
      `${label}: renewal after expiry starts when payment is confirmed`);
    assert.equal(expiredEntitlement.previous_expires_at, "2000-01-01T00:00:00.000Z");
    assert.equal(expiredEntitlement.expires_at, addMonths(expiredEntitlement.activated_at, 3));
    const restored = await request(`/publications/${slug}`);
    assert.equal(restored.response.status, 200, `${label}: verified renewal restores the stable URL`);
    const stableUrl = await request(`/publications/${website.publication_id}`, owner);
    assert.equal(stableUrl.body.url, originalUrl);

    const lifetimeOrder = await submitRenewal("lifetime");
    assert.equal(lifetimeOrder.response.status, 201);
    await confirmRenewal(lifetimeOrder);
    const lifetimeEntitlement = await inspectEntitlement(lifetimeOrder.body.order_id);
    assert.equal(lifetimeEntitlement.status, "LIFETIME");
    assert.equal(lifetimeEntitlement.expires_at, null);
    const lifetimePublication = await request(`/publications/${website.publication_id}`, owner);
    assert.equal(lifetimePublication.body.expires_at, null);
    assert.equal(lifetimePublication.body.url, originalUrl);
    const unnecessaryRenewal = await submitRenewal("1-month");
    assert.equal(unnecessaryRenewal.response.status, 409);
    assert.equal(unnecessaryRenewal.body.error.code, "LIFETIME_ACTIVE");
  }
}
