import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../shared/guest-draft.js", import.meta.url), "utf8");
const validId = "123e4567-e89b-42d3-a456-426614174000";

function createHarness() {
  const records = new Map();
  let now = 1_800_000_000_000;
  let sequence = 0;
  const window = {};
  vm.runInNewContext(source, { window, TextEncoder });
  const store = window.CrushifyGuestDraft.createStore({
    persistenceProvider: async () => ({
      async get(id) { return records.get(id) || null; },
      async put(record) { records.set(record.draftId, record); },
      async delete(id) { records.delete(id); },
      async list() { return [...records.values()]; },
    }),
    cryptoProvider: () => ({
      randomUUID() {
        sequence++;
        return sequence === 1 ? validId : "223e4567-e89b-42d3-a456-426614174000";
      },
    }),
    nowProvider: () => now,
  });
  return { store, records, setNow(value) { now = value; } };
}

describe("temporary guest drafts", () => {
  it("preserves validated draft data and deletes it after transfer", async () => {
    const { store, records } = createHarness();
    const data = { headline: "Our story", photo: "data:image/jpeg;base64,abc" };
    const draft = await store.save({ templateId: "our-universe", schemaVersion: 1, data });

    assert.equal((await store.load(draft.draftId)).data.headline, "Our story");
    assert.notEqual(draft.data, data);
    await store.delete(draft.draftId);
    assert.equal(records.has(draft.draftId), false);
  });

  it("expires drafts after the temporary handoff window", async () => {
    const { store, setNow } = createHarness();
    const draft = await store.save({ templateId: "say-yes", schemaVersion: 1, data: { sender: "Minh" } });
    setNow(draft.expiresAt);

    await assert.rejects(store.load(draft.draftId), /đã hết hạn/);
  });

  it("rejects malformed or oversized draft payloads", async () => {
    const { store } = createHarness();
    await assert.rejects(
      store.save({ templateId: "not-a-template", schemaVersion: 1, data: {} }),
      /không hợp lệ/,
    );
    await assert.rejects(store.load("not-a-uuid"), /không hợp lệ/);
    await assert.rejects(
      store.save({
        templateId: "our-universe",
        schemaVersion: 1,
        data: { content: "x".repeat(10 * 1024 * 1024) },
      }),
      /10 MB/,
    );
  });
});
