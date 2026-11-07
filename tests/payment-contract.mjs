import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

const TEST_AMOUNT_VND = 50_000;

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
      body: JSON.stringify({ design_id: id, ...extra }),
    },
  );
  const unpriced = await createRequest(`unpriced-${randomUUID()}`);
  assert.equal(unpriced.response.status, 422, `${label}: empty catalog cannot create an order`);
  assert.equal(unpriced.body.error.code, "PRICE_UNAVAILABLE");
  await seedPrice(TEST_AMOUNT_VND);

  const unauthorized = await request("/orders", null, {
    method: "POST",
    json: { design_id: designId },
  });
  assert.equal(unauthorized.response.status, 401, `${label}: order requires authentication`);

  const tampered = await createRequest(`tampered-${randomUUID()}`, designId, { amount: 1 });
  assert.equal(tampered.response.status, 400, `${label}: client cannot set amount`);

  const created = await createRequest();
  assert.equal(created.response.status, 201, `${label}: create test order`);
  assert.equal(created.body.total_minor, TEST_AMOUNT_VND, `${label}: server-side price snapshot`);
  assert.equal(created.body.currency, "VND");
  assert.equal(created.body.status, "AWAITING_PAYMENT");
  assert.equal(created.body.payment.status, "PENDING");
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
      amount_minor: TEST_AMOUNT_VND,
      reference: created.body.payment.reference,
      qr_url: created.body.payment.qr_url,
    });
  }
  assert.match(created.body.order_reference, /^CRF[A-F0-9]{16}$/);
  assert.match(created.body.payment.reference, /^CRP[A-F0-9]{16}$/);
  assert.notEqual(created.body.order_reference, created.body.payment.reference,
    `${label}: order and payment references are independent`);

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
      body: JSON.stringify({ design_id: designId }),
    });
    assert.equal(crossOwnerCreate.response.status, 404, `${label}: another customer cannot order an owned draft`);
  }

  const invalidBody = JSON.stringify({ id: 880001, accountNumber: receivingAccount, code: created.body.payment.reference,
    transferType: "in", transferAmount: TEST_AMOUNT_VND });
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
  const futureHeaders = signedHeaders(webhookSecret, invalidBody, Math.floor(Date.now() / 1000) + 301);
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
    transferAmount: TEST_AMOUNT_VND,
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
  assert.equal(paid.body.status, "PAID", `${label}: signed exact transfer marks order paid`);
  assert.equal(paid.body.payment.status, "SUCCEEDED");
  const replay = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: validHeaders,
    body: validPayload,
  });
  assert.equal(replay.response.status, 200, `${label}: provider retry is acknowledged`);
  const stillPaid = await request(`/orders/${created.body.order_id}/status`, owner);
  assert.equal(stillPaid.body.status, "PAID", `${label}: replay does not apply the payment twice`);

  const mismatchOrder = await createRequest(`mismatch-${randomUUID()}`);
  assert.equal(mismatchOrder.response.status, 201);
  const mismatchTransactionId = String(Number(`${Date.now()}`.slice(-8)) + 2);
  const mismatchPayload = JSON.stringify({
    id: mismatchTransactionId,
    accountNumber: receivingAccount,
    code: mismatchOrder.body.payment.reference,
    transferType: "in",
    transferAmount: TEST_AMOUNT_VND - 1,
  });
  const mismatch = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, mismatchPayload),
    body: mismatchPayload,
  });
  assert.equal(mismatch.response.status, 200, `${label}: verified mismatch is persisted for review`);
  const manualReview = await request(`/orders/${mismatchOrder.body.order_id}/status`, owner);
  assert.equal(manualReview.body.status, "MANUAL_REVIEW");
  assert.equal(manualReview.body.payment.status, "MANUAL_REVIEW");
  if (inspectWebhookEvent) {
    const mismatchEvent = await inspectWebhookEvent(mismatchTransactionId);
    assert.equal(mismatchEvent.outcome, "MANUAL_REVIEW");
    assert.equal(mismatchEvent.expected_amount_minor, TEST_AMOUNT_VND);
    assert.equal(mismatchEvent.actual_amount_minor, TEST_AMOUNT_VND - 1);
    assert.equal(mismatchEvent.provider_transaction_id, mismatchTransactionId);
    assert.ok(mismatchEvent.processing_attempts >= 1);
  }

  const wrongAccountOrder = await createRequest(`account-${randomUUID()}`);
  const wrongAccountPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 3,
    accountNumber: "0000000001",
    code: wrongAccountOrder.body.payment.reference,
    transferType: "in",
    transferAmount: TEST_AMOUNT_VND,
  });
  const wrongAccount = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, wrongAccountPayload),
    body: wrongAccountPayload,
  });
  assert.equal(wrongAccount.response.status, 200);
  const accountReview = await request(`/orders/${wrongAccountOrder.body.order_id}/status`, owner);
  assert.equal(accountReview.body.status, "MANUAL_REVIEW");

  const overpaymentOrder = await createRequest(`overpayment-${randomUUID()}`);
  const overpaymentPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 8,
    accountNumber: receivingAccount,
    code: overpaymentOrder.body.payment.reference,
    transferType: "in",
    transferAmount: TEST_AMOUNT_VND + 1,
  });
  const overpayment = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, overpaymentPayload),
    body: overpaymentPayload,
  });
  assert.equal(overpayment.response.status, 200);
  const overpaymentReview = await request(`/orders/${overpaymentOrder.body.order_id}/status`, owner);
  assert.equal(overpaymentReview.body.status, "MANUAL_REVIEW",
    `${label}: overpayment never marks an order paid`);

  const competingOrder = await createRequest(`competing-${randomUUID()}`);
  assert.equal(competingOrder.response.status, 201);
  const transactionIds = [Date.now() * 10 + 1, Date.now() * 10 + 2];
  const competingDeliveries = await Promise.all(transactionIds.map((id) => {
    const body = JSON.stringify({
      id,
      accountNumber: receivingAccount,
      code: competingOrder.body.payment.reference,
      transferType: "in",
      transferAmount: TEST_AMOUNT_VND,
    });
    return request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: signedHeaders(webhookSecret, body),
      body,
    });
  }));
  assert.deepEqual(competingDeliveries.map((item) => item.response.status), [200, 200]);
  const competingStatus = await request(`/orders/${competingOrder.body.order_id}/status`, owner);
  assert.equal(competingStatus.body.status, "PAID",
    `${label}: concurrent different transactions cannot prevent the first payment`);
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
    transferAmount: TEST_AMOUNT_VND,
  });
  const collision = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, duplicateTransactionPayload),
    body: duplicateTransactionPayload,
  });
  assert.equal(collision.response.status, 200);
  const collisionReview = await request(`/orders/${duplicateOrder.body.order_id}/status`, owner);
  assert.equal(collisionReview.body.status, "MANUAL_REVIEW",
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
    transferAmount: TEST_AMOUNT_VND,
  });
  const late = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, latePayload),
    body: latePayload,
  });
  assert.equal(late.response.status, 200);
  const lateReview = await request(`/orders/${expiredOrder.body.order_id}/status`, owner);
  assert.equal(lateReview.body.status, "MANUAL_REVIEW", `${label}: late transfer is reviewed, not paid`);

  if (cancelOrder) {
    const cancelledOrder = await createRequest(`cancelled-${randomUUID()}`);
    await cancelOrder(cancelledOrder.body.order_id);
    const cancelledPayload = JSON.stringify({
      id: Number(`${Date.now()}`.slice(-8)) + 9,
      accountNumber: receivingAccount,
      code: cancelledOrder.body.payment.reference,
      transferType: "in",
      transferAmount: TEST_AMOUNT_VND,
    });
    const cancelledWebhook = await request("/payments/sepay/webhook", null, {
      method: "POST",
      headers: signedHeaders(webhookSecret, cancelledPayload),
      body: cancelledPayload,
    });
    assert.equal(cancelledWebhook.response.status, 200);
    const cancelledStatus = await request(`/orders/${cancelledOrder.body.order_id}/status`, owner);
    assert.equal(cancelledStatus.body.status, "MANUAL_REVIEW",
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
      transferAmount: TEST_AMOUNT_VND,
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
    assert.equal(recoveredStatus.body.status, "PAID",
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
    transferAmount: TEST_AMOUNT_VND,
  });
  const outgoing = await request("/payments/sepay/webhook", null, {
    method: "POST",
    headers: signedHeaders(webhookSecret, outgoingPayload),
    body: outgoingPayload,
  });
  assert.equal(outgoing.response.status, 200);
  const outgoingReview = await request(`/orders/${outgoingOrder.body.order_id}/status`, owner);
  assert.equal(outgoingReview.body.status, "MANUAL_REVIEW");

  const unmatchedPayload = JSON.stringify({
    id: Number(`${Date.now()}`.slice(-8)) + 6,
    accountNumber: receivingAccount,
    code: "CRFNOTANORDER",
    transferType: "in",
    transferAmount: TEST_AMOUNT_VND,
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
}
