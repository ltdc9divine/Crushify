import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  CheckoutIntentError,
  createCheckoutIntentStore,
  prepareCheckoutOrderRequest,
} from "../checkout/checkout-intent.js";

const design = {
  design_id: "11111111-1111-4111-8111-111111111111",
  revision: 3,
  template_id: "our-universe",
  schema_version: 1,
};

const payload = {
  design_id: design.design_id,
  duration_type: "monthly",
  hosting_months: 3,
  asset_consents: [
    { asset_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", consent_version: "public-image-v1" },
    { asset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", consent_version: "public-image-v1" },
  ],
};

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    values,
  };
}

function createCrypto(ids) {
  return {
    subtle: webcrypto.subtle,
    randomUUID() {
      const id = ids.shift();
      if (!id) throw new Error("No test UUIDs remain");
      return id;
    },
  };
}

function createStore(storage, ids) {
  return createCheckoutIntentStore({
    storageKey: `crushify-checkout-intent:v1:${design.design_id}`,
    storageProvider: () => storage,
    cryptoProvider: () => createCrypto(ids),
    accountKey: "account-a",
    designId: design.design_id,
    locksProvider: () => ({
      request(name, operation) {
        return operation();
      },
    }),
  });
}

test("reuses one intent across a lost response and page reload", async () => {
  const storage = createStorage();
  const uuids = [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const firstStore = createStore(storage, uuids);
  const first = await prepareCheckoutOrderRequest(firstStore, payload, design);
  const record = JSON.parse(storage.values.values().next().value);
  assert.deepEqual(Object.keys(record).sort(), [
    "accountKey",
    "createdAt",
    "designId",
    "fingerprint",
    "intentId",
    "key",
    "revision",
    "serverOrderId",
    "status",
    "updatedAt",
    "version",
  ]);
  assert.equal(record.version, 1);
  assert.match(record.fingerprint, /^[0-9a-f]{64}$/);

  const serverOrders = new Map();
  let createdOrderCount = 0;
  await assert.rejects(async () => {
    const key = first.requestOptions.headers["Idempotency-Key"];
    if (!serverOrders.has(key)) {
      serverOrders.set(key, { order_id: "order-1" });
      createdOrderCount += 1;
    }
    throw new Error("response lost");
  }, /response lost/);

  const reloadedStore = createStore(storage, uuids);
  const retry = await prepareCheckoutOrderRequest(reloadedStore, payload, design);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.equal(serverOrders.get(retry.idempotencyKey).order_id, "order-1");
  assert.equal(createdOrderCount, 1);
  assert.deepEqual(JSON.parse(retry.requestOptions.body), {
    ...payload,
    asset_consents: [...payload.asset_consents].sort((left, right) =>
      left.asset_id < right.asset_id ? -1 : left.asset_id > right.asset_id ? 1 : 0),
  });
});

test("rotates the key only for changed order fields or an explicit new intent", async () => {
  const storage = createStorage();
  const store = createStore(storage, [
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ]);
  const first = await store.prepare(payload, design);
  const changed = await store.prepare(
    { ...payload, hosting_months: 4 },
    design,
    { allowPayloadChange: true },
  );
  assert.notEqual(changed.key, first.key);
  assert.notEqual(changed.fingerprint, first.fingerprint);

  const explicitNewOrder = await store.prepare(
    { ...payload, hosting_months: 4 },
    design,
    { forceNew: true },
  );
  assert.notEqual(explicitNewOrder.key, changed.key);
  assert.equal(explicitNewOrder.fingerprint, changed.fingerprint);
});

test("submits and replays an explicitly selected second intent without changing the first", async () => {
  const storage = createStorage();
  const store = createStore(storage, [
    "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a",
    "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a",
  ]);
  const first = await prepareCheckoutOrderRequest(store, payload, design);
  const separate = await store.prepare(payload, design, { forceNew: true });
  assert.notEqual(separate.key, first.idempotencyKey);

  const serverOrders = new Map([
    [first.idempotencyKey, { order_id: "order-first" }],
  ]);
  let createdOrderCount = serverOrders.size;
  const submitSecond = async () => {
    const prepared = await prepareCheckoutOrderRequest(
      store,
      payload,
      design,
      { activeIntentId: separate.intentId },
    );
    if (!serverOrders.has(prepared.idempotencyKey)) {
      serverOrders.set(prepared.idempotencyKey, { order_id: "order-second" });
      createdOrderCount++;
    }
    await store.associate(prepared.intentId, serverOrders.get(prepared.idempotencyKey).order_id);
    return prepared;
  };

  const firstSecondSubmission = await submitSecond();
  const repeatedSubmission = await submitSecond();
  assert.equal(repeatedSubmission.idempotencyKey, firstSecondSubmission.idempotencyKey);
  assert.equal(createdOrderCount, 2);
  assert.equal(serverOrders.get(first.idempotencyKey).order_id, "order-first");
  assert.equal(serverOrders.get(separate.key).order_id, "order-second");
  assert.equal((await store.prepare(payload, design, { activeIntentId: separate.intentId })).key,
    separate.key);
});

test("treats a new design revision as a different checkout payload", async () => {
  const storage = createStorage();
  const store = createStore(storage, [
    "12121212-1212-4212-8212-121212121212",
    "13131313-1313-4313-8313-131313131313",
  ]);
  const first = await store.prepare(payload, design);
  await assert.rejects(
    () => store.prepare(payload, { ...design, revision: design.revision + 1 }),
    (error) => error instanceof CheckoutIntentError &&
      error.code === "CHECKOUT_INTENT_MISMATCH",
  );
  const changedRevision = await store.prepare(
    payload,
    { ...design, revision: design.revision + 1 },
    { allowPayloadChange: true },
  );
  assert.notEqual(changedRevision.key, first.key);
  assert.notEqual(changedRevision.fingerprint, first.fingerprint);
});

test("keeps equivalent consent ordering stable and excludes unrelated fields", async () => {
  const storage = createStorage();
  const store = createStore(storage, ["77777777-7777-4777-8777-777777777777"]);
  const first = await store.prepare(payload, design);
  const reordered = await store.prepare({
    ...payload,
    asset_consents: [...payload.asset_consents].reverse(),
    recipient_message: "private design content",
    customer_email: "private@example.test",
  }, design);
  assert.equal(reordered.key, first.key);
  assert.equal(reordered.fingerprint, first.fingerprint);
  assert.equal(JSON.stringify([...storage.values.values()]).includes("private"), false);
  assert.equal(JSON.stringify(reordered.payload).includes("recipient_message"), false);
});

test("blocks a changed retry until the user explicitly starts a new intent", async () => {
  const storage = createStorage();
  const store = createStore(storage, [
    "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999999",
  ]);
  await store.prepare(payload, design);
  await assert.rejects(
    () => store.prepare({ ...payload, hosting_months: 4 }, design),
    (error) => error instanceof CheckoutIntentError &&
      error.code === "CHECKOUT_INTENT_MISMATCH",
  );
  const newIntent = await store.prepare(
    { ...payload, hosting_months: 4 },
    design,
    { forceNew: true },
  );
  assert.equal(newIntent.key, "checkout-99999999-9999-4999-8999-999999999999");
});

test("account namespaces isolate intents and deliberate separate intents remain separate", async () => {
  function persistence() {
    const records = new Map();
    return {
      async list(accountKey, designId) {
        return [...records.values()].filter((record) =>
          record.accountKey === accountKey &&
          record.designId === designId &&
          record.status === "unresolved");
      },
      async get(intentId) {
        return records.get(intentId) || null;
      },
      async put(record) {
        records.set(record.intentId, record);
        return record;
      },
    };
  }
  const persistenceA = persistence();
  const persistenceB = persistence();
  const cryptoA = createCrypto([
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  ]);
  const cryptoB = createCrypto(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
  const accountA = createCheckoutIntentStore({
    storageKey: `crushify-checkout-intent:v1:${design.design_id}`,
    persistenceProvider: () => persistenceA,
    cryptoProvider: () => cryptoA,
    accountKey: "account-a",
    designId: design.design_id,
  });
  const accountB = createCheckoutIntentStore({
    storageKey: `crushify-checkout-intent:v1:${design.design_id}`,
    persistenceProvider: () => persistenceB,
    cryptoProvider: () => cryptoB,
    accountKey: "account-b",
    designId: design.design_id,
  });

  await accountA.prepare(payload, design);
  const separate = await accountB.prepare(payload, design);
  assert.match(separate.key, /^checkout-/);
  assert.equal(separate.accountKey, "account-b");

  const first = await accountA.prepare(payload, design);
  const second = await accountA.prepare(payload, design, { forceNew: true });
  assert.notEqual(first.key, second.key);
  await accountA.associate(second.intentId, "order-b");
  const remaining = await accountA.list();
  assert.ok(remaining.some((intent) => intent.intentId === second.intentId));
});

test("stale async writes cannot replace the active intent", async () => {
  const records = new Map();
  const persistence = {
    async list(accountKey, designId) {
      return [...records.values()].filter((record) =>
        record.accountKey === accountKey &&
        record.designId === designId &&
        record.status === "unresolved");
    },
    async get(intentId) {
      return records.get(intentId) || null;
    },
    async put(record) {
      records.set(record.intentId, record);
      return record;
    },
  };
  const store = createCheckoutIntentStore({
    storageKey: `crushify-checkout-intent:v1:${design.design_id}`,
    persistenceProvider: () => persistence,
    cryptoProvider: () => createCrypto([
      "abababab-abab-4bab-8bab-abababababab",
      "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    ]),
    accountKey: "account-a",
    designId: design.design_id,
  });
  const first = await store.prepare(payload, design);
  const separate = await store.prepare(payload, design, { forceNew: true });
  await assert.rejects(
    () => store.updateIfCurrent(
      first.intentId,
      "2099-01-01T00:00:00.000Z",
      { serverOrderId: "stale-order" },
    ),
    (error) => error instanceof CheckoutIntentError &&
      error.code === "STALE_CHECKOUT_INTENT",
  );
  assert.equal((await store.prepare(payload, design, { activeIntentId: separate.intentId })).key,
    separate.key);
  assert.equal((await store.prepare(payload, design, { activeIntentId: first.intentId })).key,
    first.key);
});

test("concurrent acquisition serializes to one key and stale replacement is blocked", async () => {
  const storage = createStorage();
  let operation;
  let running = false;
  const locks = {
    request(name, next) {
      if (running) throw new Error("lock was not serialized");
      running = true;
      const result = Promise.resolve().then(next);
      return result.finally(() => { running = false; });
    },
  };
  const store = createCheckoutIntentStore({
    storageKey: `crushify-checkout-intent:v1:${design.design_id}`,
    storageProvider: () => storage,
    cryptoProvider: () => createCrypto([
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ]),
    accountKey: "account-a",
    designId: design.design_id,
    locksProvider: () => locks,
  });
  operation = store.prepare(payload, design);
  const first = await operation;
  const second = await store.prepare(payload, design);
  assert.equal(first.key, second.key);
});

test("fails closed for malformed metadata and unavailable storage or cryptography", async () => {
  const key = `crushify-checkout-intent:v1:${design.design_id}`;
  const malformedStorage = createStorage({ [key]: "{\"key\":\"not-a-valid-intent\"}" });
  const malformedStore = createCheckoutIntentStore({
    storageKey: key,
    storageProvider: () => malformedStorage,
    cryptoProvider: () => createCrypto(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]),
  });
  await assert.rejects(
    () => prepareCheckoutOrderRequest(malformedStore, payload, design),
    (error) => error instanceof CheckoutIntentError &&
      error.code === "INVALID_SAVED_CHECKOUT_INTENT",
  );

  const unavailableStorage = createCheckoutIntentStore({
    storageKey: key,
    storageProvider: () => {
      throw new Error("storage disabled");
    },
    cryptoProvider: () => createCrypto(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]),
  });
  let requestSent = false;
  await assert.rejects(async () => {
    await prepareCheckoutOrderRequest(unavailableStorage, payload, design);
    requestSent = true;
  }, (error) => error instanceof CheckoutIntentError &&
    error.code === "CHECKOUT_STORAGE_UNAVAILABLE");
  assert.equal(requestSent, false);

  const unavailableWrite = createCheckoutIntentStore({
    storageKey: key,
    storageProvider: () => ({
      getItem: () => null,
      setItem: () => {
        throw new Error("storage quota exceeded");
      },
    }),
    cryptoProvider: () => createCrypto(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]),
  });
  await assert.rejects(async () => {
    await prepareCheckoutOrderRequest(unavailableWrite, payload, design);
    requestSent = true;
  }, (error) => error instanceof CheckoutIntentError &&
    error.code === "CHECKOUT_STORAGE_UNAVAILABLE");
  assert.equal(requestSent, false);

  const unavailableCrypto = createCheckoutIntentStore({
    storageKey: key,
    storageProvider: () => createStorage(),
    cryptoProvider: () => ({}),
  });
  await assert.rejects(
    () => unavailableCrypto.prepare(payload, design),
    (error) => error instanceof CheckoutIntentError &&
      error.code === "CHECKOUT_CRYPTO_UNAVAILABLE",
  );
});
