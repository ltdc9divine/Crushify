(() => {
  "use strict";

  const DATABASE_NAME = "crushify-guest-drafts";
  const STORE_NAME = "drafts";
  const RECORD_VERSION = 1;
  const MAX_DRAFT_BYTES = 10 * 1024 * 1024;
  const DRAFT_TTL_MS = 60 * 60 * 1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let databasePromise;

  function openDatabase(indexedDBProvider) {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDBProvider().open(DATABASE_NAME, 1);
      } catch (error) {
        databasePromise = null;
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "draftId" });
        }
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error("Could not open temporary draft storage"));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error("Temporary draft storage upgrade was blocked"));
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
    return databasePromise;
  }

  function requestResult(request, failureMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(failureMessage));
    });
  }

  async function createPersistence(indexedDBProvider) {
    const database = await openDatabase(indexedDBProvider);
    return {
      async get(draftId) {
        const transaction = database.transaction(STORE_NAME, "readonly");
        return requestResult(transaction.objectStore(STORE_NAME).get(draftId), "Could not read temporary draft");
      },
      async put(record) {
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).put(record);
          transaction.oncomplete = () => resolve(record);
          transaction.onerror = () => reject(transaction.error || new Error("Could not save temporary draft"));
          transaction.onabort = () => reject(transaction.error || new Error("Could not save temporary draft"));
        });
      },
      async delete(draftId) {
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).delete(draftId);
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("Could not delete temporary draft"));
          transaction.onabort = () => reject(transaction.error || new Error("Could not delete temporary draft"));
        });
      },
      async list() {
        const transaction = database.transaction(STORE_NAME, "readonly");
        return requestResult(transaction.objectStore(STORE_NAME).getAll(), "Could not list temporary drafts");
      },
    };
  }

  function createStore({
    persistenceProvider,
    indexedDBProvider = () => globalThis.indexedDB,
    cryptoProvider = () => globalThis.crypto,
    nowProvider = () => Date.now(),
  } = {}) {
    async function persistence() {
      return typeof persistenceProvider === "function"
        ? persistenceProvider()
        : createPersistence(indexedDBProvider);
    }

    return {
      async save({ templateId, schemaVersion, data }) {
        if (typeof templateId !== "string" ||
            !/^(our-universe|love-letter|our-memories|say-yes|distance-means-nothing)$/.test(templateId) ||
            !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 ||
            !data || typeof data !== "object" || Array.isArray(data)) {
          throw new Error("Không thể lưu bản nháp tạm không hợp lệ.");
        }
        let serialized;
        try {
          serialized = JSON.stringify(data);
        } catch {
          throw new Error("Không thể chuẩn bị nội dung bản nháp tạm.");
        }
        if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_BYTES) {
          throw new Error("Bản nháp vượt quá giới hạn lưu tạm 10 MB. Hãy giảm số lượng hoặc kích thước ảnh.");
        }
        const cryptoObject = cryptoProvider();
        const draftId = cryptoObject?.randomUUID?.();
        if (!UUID.test(draftId || "")) {
          throw new Error("Trình duyệt không thể tạo mã bản nháp an toàn.");
        }
        const now = nowProvider();
        const record = {
          draftId,
          version: RECORD_VERSION,
          templateId,
          schemaVersion,
          data: JSON.parse(serialized),
          createdAt: now,
          expiresAt: now + DRAFT_TTL_MS,
        };
        const store = await persistence();
        for (const existing of await store.list()) {
          if (!Number.isFinite(existing.expiresAt) || existing.expiresAt <= now) {
            await store.delete(existing.draftId);
          }
        }
        await store.put(record);
        return record;
      },

      async load(draftId) {
        if (!UUID.test(draftId || "")) {
          throw new Error("Mã bản nháp tạm không hợp lệ.");
        }
        const store = await persistence();
        const record = await store.get(draftId);
        if (!record || record.version !== RECORD_VERSION ||
            !Number.isFinite(record.expiresAt) || record.expiresAt <= nowProvider()) {
          if (record) await store.delete(draftId);
          throw new Error("Bản nháp tạm đã hết hạn hoặc không còn trên thiết bị này. Hãy quay lại mẫu để tạo lại.");
        }
        return record;
      },

      async delete(draftId) {
        if (!UUID.test(draftId || "")) {
          throw new Error("Mã bản nháp tạm không hợp lệ.");
        }
        const store = await persistence();
        await store.delete(draftId);
      },

      async cleanupExpired() {
        const store = await persistence();
        const now = nowProvider();
        for (const record of await store.list()) {
          if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) {
            await store.delete(record.draftId);
          }
        }
      },
    };
  }

  window.CrushifyGuestDraft = { createStore };
})();
