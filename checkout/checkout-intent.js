const RECORD_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTENT_DATABASE_NAME = "crushify-checkout-intents";
const INTENT_STORE_NAME = "intents";
const INTENT_DATABASE_VERSION = 1;
let intentDatabasePromise;

export class CheckoutIntentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CheckoutIntentError";
    this.code = code;
  }
}

function invalidPayload() {
  return new CheckoutIntentError(
    "INVALID_CHECKOUT_PAYLOAD",
    "Các lựa chọn đặt hàng chưa hợp lệ. Chưa gửi yêu cầu.",
  );
}

function normalizeCheckoutPayload(payload, design) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !design || typeof design !== "object" || Array.isArray(design) ||
      typeof payload.design_id !== "string" ||
      payload.design_id !== design.design_id ||
      !Number.isSafeInteger(design.revision) || design.revision < 1 ||
      typeof design.template_id !== "string" ||
      !Number.isSafeInteger(design.schema_version) || design.schema_version < 1 ||
      !Array.isArray(payload.asset_consents)) {
    throw invalidPayload();
  }

  let hostingMonths = null;
  if (payload.duration_type === "monthly") {
    if (!Number.isSafeInteger(payload.hosting_months) || payload.hosting_months < 1) {
      throw invalidPayload();
    }
    hostingMonths = payload.hosting_months;
  } else if (payload.duration_type !== "lifetime") {
    throw invalidPayload();
  }

  const consentAssetIds = new Set();
  const assetConsents = payload.asset_consents.map((consent) => {
    if (!consent || typeof consent !== "object" || Array.isArray(consent) ||
        typeof consent.asset_id !== "string" || consent.asset_id.length === 0 ||
        typeof consent.consent_version !== "string" || consent.consent_version.length === 0 ||
        consentAssetIds.has(consent.asset_id)) {
      throw invalidPayload();
    }
    consentAssetIds.add(consent.asset_id);
    return {
      asset_id: consent.asset_id,
      consent_version: consent.consent_version,
    };
  }).sort((left, right) => left.asset_id < right.asset_id ? -1 : left.asset_id > right.asset_id ? 1 : 0);

  return {
    design: {
      design_id: design.design_id,
      revision: design.revision,
      template_id: design.template_id,
      schema_version: design.schema_version,
    },
    payload: {
      design_id: payload.design_id,
      duration_type: payload.duration_type,
      hosting_months: hostingMonths,
      asset_consents: assetConsents,
    },
  };
}

function getCrypto(cryptoProvider) {
  try {
    const cryptoObject = cryptoProvider();
    if (!cryptoObject?.subtle?.digest) throw new Error("Web Crypto unavailable");
    return cryptoObject;
  } catch {
    throw new CheckoutIntentError(
      "CHECKOUT_CRYPTO_UNAVAILABLE",
      "Trình duyệt không hỗ trợ mã hóa an toàn cần thiết. Chưa gửi yêu cầu.",
    );
  }
}

function getStorage(storageProvider) {
  try {
    const storage = storageProvider();
    if (!storage || typeof storage.getItem !== "function" ||
        typeof storage.setItem !== "function") {
      throw new Error("Session storage unavailable");
    }
    return storage;
  } catch {
    throw new CheckoutIntentError(
      "CHECKOUT_STORAGE_UNAVAILABLE",
      "Không thể lưu trạng thái đặt hàng an toàn trong phiên này. Chưa gửi yêu cầu.",
    );
  }
}

async function fingerprintCheckoutIntent(normalized, cryptoObject) {
  try {
    const input = new TextEncoder().encode(JSON.stringify(normalized));
    const digest = await cryptoObject.subtle.digest("SHA-256", input);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    throw new CheckoutIntentError(
      "CHECKOUT_CRYPTO_UNAVAILABLE",
      "Không thể xác minh an toàn các lựa chọn đặt hàng. Chưa gửi yêu cầu.",
    );
  }
}

function newIdempotencyKey(cryptoObject) {
  try {
    let uuid;
    if (typeof cryptoObject.randomUUID === "function") {
      uuid = cryptoObject.randomUUID();
    } else if (typeof cryptoObject.getRandomValues === "function") {
      const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    if (!UUID_PATTERN.test(uuid || "")) throw new Error("Invalid generated UUID");
    return `checkout-${uuid}`;
  } catch {
    throw new CheckoutIntentError(
      "CHECKOUT_CRYPTO_UNAVAILABLE",
      "Không thể tạo khóa đặt hàng an toàn. Chưa gửi yêu cầu.",
    );
  }
}

function openIntentDatabase(indexedDBProvider) {
  if (intentDatabasePromise) return intentDatabasePromise;
  intentDatabasePromise = new Promise((resolve, reject) => {
    let request;
    try {
      const indexedDB = indexedDBProvider();
      if (!indexedDB?.open) throw new Error("IndexedDB unavailable");
      request = indexedDB.open(INTENT_DATABASE_NAME, INTENT_DATABASE_VERSION);
    } catch (error) {
      intentDatabasePromise = null;
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INTENT_STORE_NAME)) {
        const store = database.createObjectStore(INTENT_STORE_NAME, { keyPath: "intentId" });
        store.createIndex("accountDesignStatus", ["accountKey", "designId", "status"], { unique: false });
        store.createIndex("accountStatus", ["accountKey", "status"], { unique: false });
      }
    };
    request.onerror = () => {
      intentDatabasePromise = null;
      reject(request.error || new Error("Could not open checkout intent database"));
    };
    request.onblocked = () => {
      intentDatabasePromise = null;
      reject(new Error("Checkout intent database upgrade was blocked"));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
  return intentDatabasePromise;
}

async function createIndexedDBPersistence(indexedDBProvider) {
  const database = await openIntentDatabase(indexedDBProvider);
  return {
    async list(accountKey, designId = null) {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(INTENT_STORE_NAME, "readonly");
        const store = transaction.objectStore(INTENT_STORE_NAME);
        const index = designId
          ? store.index("accountDesignStatus")
          : store.index("accountStatus");
        const range = designId
          ? IDBKeyRange.only([accountKey, designId, "unresolved"])
          : IDBKeyRange.only([accountKey, "unresolved"]);
        const request = index.getAll(range);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not read checkout intents"));
      });
    },
    async get(intentId) {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(INTENT_STORE_NAME, "readonly");
        const request = transaction.objectStore(INTENT_STORE_NAME).get(intentId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Could not read checkout intent"));
      });
    },
    async put(intent) {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(INTENT_STORE_NAME, "readwrite");
        transaction.objectStore(INTENT_STORE_NAME).put(intent);
        transaction.oncomplete = () => resolve(intent);
        transaction.onerror = () => reject(transaction.error || new Error("Could not save checkout intent"));
        transaction.onabort = () => reject(transaction.error || new Error("Could not save checkout intent"));
      });
    },
  };
}

function validIntent(record) {
  return Boolean(record &&
    record.version === RECORD_VERSION &&
    typeof record.intentId === "string" &&
    typeof record.accountKey === "string" &&
    typeof record.designId === "string" &&
    typeof record.key === "string" &&
    /^checkout-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.key) &&
    typeof record.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(record.fingerprint) &&
    (record.status === "unresolved" || record.status === "associated"));
}

export function createCheckoutIntentStore({
  storageKey,
  accountKey,
  designId,
  persistenceProvider,
  storageProvider,
  indexedDBProvider = () => globalThis.indexedDB,
  locksProvider = () => globalThis.navigator?.locks,
  cryptoProvider = () => globalThis.crypto,
  nowProvider = () => new Date().toISOString(),
} = {}) {
  if (typeof storageKey !== "string" || storageKey.length === 0 ||
      typeof cryptoProvider !== "function") {
    throw new TypeError("Checkout intent storage configuration is invalid.");
  }
  const effectiveAccountKey = accountKey || "test-account";
  const effectiveDesignId = designId || "test-design";

  return {
    async prepare(payload, design, {
      allowPayloadChange = false,
      forceNew = false,
      activeIntentId = null,
    } = {}) {
      const normalized = normalizeCheckoutPayload(payload, design);
      const cryptoObject = getCrypto(cryptoProvider);
      const fingerprint = await fingerprintCheckoutIntent(normalized, cryptoObject);
      const legacyPersistence = typeof storageProvider === "function";
      const locks = locksProvider();
      if (!locks?.request && !legacyPersistence) {
        throw new CheckoutIntentError(
          "CHECKOUT_COORDINATION_UNAVAILABLE",
          "Trình duyệt không hỗ trợ cơ chế khởi tạo đặt hàng an toàn. Chưa gửi yêu cầu.",
        );
      }
      let persistence;
      try {
        if (typeof persistenceProvider === "function") {
          persistence = await persistenceProvider();
        } else if (legacyPersistence) {
          const storage = storageProvider();
          persistence = {
            async list() {
              const raw = storage.getItem(storageKey);
              if (!raw) return [];
              try {
                const record = JSON.parse(raw);
                if (!validIntent(record)) {
                  throw new CheckoutIntentError(
                    "INVALID_SAVED_CHECKOUT_INTENT",
                    "Không thể xác minh lần đặt hàng trước. Chưa gửi yêu cầu.",
                  );
                }
                return record.accountKey === effectiveAccountKey &&
                  record.designId === effectiveDesignId
                  ? [record]
                  : [];
              } catch {
                throw new CheckoutIntentError(
                  "INVALID_SAVED_CHECKOUT_INTENT",
                  "Không thể xác minh lần đặt hàng trước. Chưa gửi yêu cầu.",
                );
              }
            },
            async get(intentId) {
              const raw = storage.getItem(storageKey);
              if (!raw) return null;
              try {
                const record = JSON.parse(raw);
                return record.intentId === intentId ? record : null;
              } catch {
                return null;
              }
            },
            async put(intent) {
              try {
                storage.setItem(storageKey, JSON.stringify(intent));
                return intent;
              } catch {
                throw new CheckoutIntentError(
                  "CHECKOUT_STORAGE_UNAVAILABLE",
                  "Không thể lưu trạng thái đặt hàng lâu dài. Chưa gửi yêu cầu.",
                );
              }
            },
          };
        } else {
          persistence = await createIndexedDBPersistence(indexedDBProvider);
        }
      } catch {
        throw new CheckoutIntentError(
          "CHECKOUT_STORAGE_UNAVAILABLE",
          "Không thể lưu trạng thái đặt hàng lâu dài. Chưa gửi yêu cầu.",
        );
      }

      const execute = async () => {
        const records = await persistence.list(effectiveAccountKey, effectiveDesignId);
        if (typeof activeIntentId === "string") {
          const activeRecord = records.find((record) =>
            validIntent(record) && record.intentId === activeIntentId);
          if (!activeRecord) {
            throw new CheckoutIntentError(
              "INVALID_CHECKOUT_INTENT",
              "Không thể xác minh lần đặt hàng đang chọn. Chưa gửi yêu cầu.",
            );
          }
          if (activeRecord.status !== "unresolved" ||
              activeRecord.accountKey !== effectiveAccountKey ||
              activeRecord.designId !== effectiveDesignId ||
              activeRecord.fingerprint !== fingerprint) {
            throw new CheckoutIntentError(
              "CHECKOUT_INTENT_MISMATCH",
              "Lựa chọn đặt hàng không còn khớp. Hãy tải lại hoặc bắt đầu đơn riêng.",
            );
          }
          return { ...activeRecord, payload: normalized.payload };
        }
        const validRecords = records.filter(validIntent)
          .filter((record) => record.fingerprint === fingerprint)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

        if (!forceNew && validRecords.length === 1) {
          return { ...validRecords[0], payload: normalized.payload };
        }

        if (!forceNew && validRecords.length > 1) {
          throw new CheckoutIntentError(
            "MULTIPLE_CHECKOUT_INTENTS",
            "Có nhiều lần đặt hàng chưa hoàn tất cho lựa chọn này. Hãy chọn lần đặt hàng cần tiếp tục.",
          );
        }

        if (!forceNew) {
          const allForDesign = records.filter(validIntent);
          if (!allowPayloadChange && allForDesign.some((record) => record.fingerprint !== fingerprint)) {
            throw new CheckoutIntentError(
              "CHECKOUT_INTENT_MISMATCH",
              "Lựa chọn hiện tại khác lần thử trước. Hãy khôi phục lựa chọn cũ hoặc bắt đầu một đơn riêng.",
            );
          }
        }

        const now = nowProvider();
        const key = newIdempotencyKey(cryptoObject);
        const intent = {
          key,
          intentId: `intent-${key.slice("checkout-".length)}`,
          version: RECORD_VERSION,
          revision: 1,
          accountKey: effectiveAccountKey,
          designId: effectiveDesignId,
          fingerprint,
          status: "unresolved",
          createdAt: now,
          updatedAt: now,
          serverOrderId: null,
        };
        await persistence.put(intent);
        return { ...intent, payload: normalized.payload };
      };
      return locks?.request
        ? locks.request(`crushify:checkout:${effectiveAccountKey}:${effectiveDesignId}`, execute)
        : execute();
    },

    async list() {
      const persistence = typeof persistenceProvider === "function"
        ? await persistenceProvider()
        : typeof storageProvider === "function"
          ? { list: async () => {
              const storage = storageProvider();
              const raw = storage.getItem(storageKey);
              if (!raw) return [];
              try {
                const record = JSON.parse(raw);
                return record.accountKey === effectiveAccountKey &&
                  record.designId === effectiveDesignId
                  ? [record]
                  : [];
              } catch {
                return [];
              }
            } }
          : await createIndexedDBPersistence(indexedDBProvider);
      return (await persistence.list(effectiveAccountKey, effectiveDesignId)).filter(validIntent);
    },

    async associate(intentId, serverOrderId) {
      let persistence;
      if (typeof persistenceProvider === "function") {
        persistence = await persistenceProvider();
      } else if (typeof storageProvider === "function") {
        const storage = getStorage(storageProvider);
        persistence = {
          async get(recordIntentId) {
            const raw = storage.getItem(storageKey);
            if (!raw) return null;
            try {
              const record = JSON.parse(raw);
              return record.intentId === recordIntentId ? record : null;
            } catch {
              return null;
            }
          },
          async put(record) {
            try {
              storage.setItem(storageKey, JSON.stringify(record));
              return record;
            } catch {
              throw new CheckoutIntentError(
                "CHECKOUT_STORAGE_UNAVAILABLE",
                "Không thể lưu trạng thái đặt hàng lâu dài. Chưa gửi yêu cầu.",
              );
            }
          },
        };
      } else {
        persistence = await createIndexedDBPersistence(indexedDBProvider);
      }
      const locks = locksProvider();
      const execute = async () => {
        if (typeof intentId !== "string" || typeof serverOrderId !== "string") {
          throw new CheckoutIntentError("INVALID_CHECKOUT_INTENT", "Cannot associate an invalid checkout intent.");
        }
        const record = await persistence.get(intentId);
        if (!validIntent(record) || record.accountKey !== effectiveAccountKey || record.designId !== effectiveDesignId) {
          throw new CheckoutIntentError("INVALID_CHECKOUT_INTENT", "Checkout intent cannot be associated.");
        }
        await persistence.put({
          ...record,
          serverOrderId,
          status: "unresolved",
          revision: (record.revision || 1) + 1,
          updatedAt: nowProvider(),
        });
      };
      return locks?.request
        ? locks.request(`crushify:checkout:${effectiveAccountKey}:${effectiveDesignId}`, execute)
        : execute();
    },

    async archive(intentId) {
      let persistence;
      if (typeof persistenceProvider === "function") {
        persistence = await persistenceProvider();
      } else if (typeof storageProvider === "function") {
        const storage = getStorage(storageProvider);
        persistence = {
          async get(recordIntentId) {
            const raw = storage.getItem(storageKey);
            if (!raw) return null;
            try {
              const record = JSON.parse(raw);
              return record.intentId === recordIntentId ? record : null;
            } catch {
              return null;
            }
          },
          async put(record) {
            try {
              storage.setItem(storageKey, JSON.stringify(record));
              return record;
            } catch {
              throw new CheckoutIntentError(
                "CHECKOUT_STORAGE_UNAVAILABLE",
                "Không thể lưu trạng thái đặt hàng lâu dài. Chưa gửi yêu cầu.",
              );
            }
          },
        };
      } else {
        persistence = await createIndexedDBPersistence(indexedDBProvider);
      }
      const locks = locksProvider();
      const execute = async () => {
        const record = await persistence.get(intentId);
        if (!record || record.accountKey !== effectiveAccountKey || record.designId !== effectiveDesignId) return;
        await persistence.put({
          ...record,
          status: "resolved",
          revision: (record.revision || 1) + 1,
          updatedAt: nowProvider(),
        });
      };
      return locks?.request
        ? locks.request(`crushify:checkout:${effectiveAccountKey}:${effectiveDesignId}`, execute)
        : execute();
    },

    async updateIfCurrent(intentId, expectedUpdatedAt, patch, expectedRevision = null) {
      if (typeof intentId !== "string" ||
          typeof expectedUpdatedAt !== "string" ||
          !patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new CheckoutIntentError("INVALID_CHECKOUT_INTENT", "Cannot update a stale checkout intent.");
      }
      let persistence;
      if (typeof persistenceProvider === "function") {
        persistence = await persistenceProvider();
      } else if (typeof storageProvider === "function") {
        const storage = getStorage(storageProvider);
        persistence = {
          async get(recordIntentId) {
            const raw = storage.getItem(storageKey);
            if (!raw) return null;
            try {
              const record = JSON.parse(raw);
              return record.intentId === recordIntentId ? record : null;
            } catch {
              return null;
            }
          },
          async put(record) {
            try {
              storage.setItem(storageKey, JSON.stringify(record));
              return record;
            } catch {
              throw new CheckoutIntentError(
                "CHECKOUT_STORAGE_UNAVAILABLE",
                "Không thể lưu trạng thái đặt hàng lâu dài. Chưa gửi yêu cầu.",
              );
            }
          },
        };
      } else {
        persistence = await createIndexedDBPersistence(indexedDBProvider);
      }
      const locks = locksProvider();
      const execute = async () => {
        const record = await persistence.get(intentId);
        if (!validIntent(record) || record.accountKey !== effectiveAccountKey || record.designId !== effectiveDesignId) {
          throw new CheckoutIntentError("INVALID_CHECKOUT_INTENT", "Checkout intent cannot be updated.");
        }
        if (record.updatedAt !== expectedUpdatedAt) {
          throw new CheckoutIntentError("STALE_CHECKOUT_INTENT", "A newer checkout intent state already won.");
        }
        if (expectedRevision !== null && record.revision !== expectedRevision) {
          throw new CheckoutIntentError("STALE_CHECKOUT_INTENT", "A newer checkout intent state already won.");
        }
        await persistence.put({
          ...record,
          ...patch,
          status: "unresolved",
          revision: (record.revision || 1) + 1,
          updatedAt: nowProvider(),
        });
      };
      return locks?.request
        ? locks.request(`crushify:checkout:${effectiveAccountKey}:${effectiveDesignId}`, execute)
        : execute();
    },
  };
}

export async function prepareCheckoutOrderRequest(intentStore, payload, design, options) {
  if (!intentStore || typeof intentStore.prepare !== "function") {
    throw new TypeError("Checkout intent store is required.");
  }
  const intent = await intentStore.prepare(payload, design, options);
  return {
    intentId: intent.intentId,
    idempotencyKey: intent.key,
    requestOptions: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": intent.key,
      },
      body: JSON.stringify(intent.payload),
    },
  };
}
