import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assetReferences,
  publicTemplateData,
  TEMPLATE_RENDERERS,
  validateTemplateData,
} from "../src/template-registry.ts";

const firstAsset = "11111111-1111-4111-8111-111111111111";
const secondAsset = "22222222-2222-4222-8222-222222222222";

const templates = {
  "our-universe": {
    sender: "Minh",
    receiver: "Linh",
    nickname: "Bé yêu",
    headline: "Một vũ trụ dành riêng cho hai ta",
    subheadline: "Hai tâm hồn.",
    mainMessage: "Tin nhắn dành riêng.",
    startDate: "2024-02-14",
    theme: "rose-nebula",
    animation: "cinematic",
    memories: [
      { title: "Lần đầu", description: "Ngày gặp nhau." },
      { title: "Hành trình", description: "Cùng trưởng thành." },
      { title: "Mãi mãi", description: "Còn nhiều điều phía trước." },
    ],
    photos: [{ asset_id: firstAsset, caption: "Kỷ niệm" }],
  },
  "love-letter": {
    from: "Anh",
    to: "Em",
    title: "Gửi người mình thương",
    msg: "Cảm ơn em.",
    secret: "Em là vũ trụ của anh.",
    theme: "rose",
    spd: "1",
  },
  "our-memories": {
    templateId: "our-memories",
    sender: "Minh",
    receiver: "Linh",
    nickname: "Bé yêu",
    albumTitle: "Kỷ niệm đôi mình",
    subtitle: "Những khoảnh khắc đẹp.",
    anniversary: "2024-02-14",
    theme: "rose-memories",
    animation: "cinematic",
    coverImage: firstAsset,
    introduction: "Cuốn album của chúng mình.",
    story: "Mọi chuyện bắt đầu từ một tách cà phê.",
    chapters: [
      { id: "first-meet", title: "Lần đầu gặp gỡ", date: "2024-02-14", description: "Ngày đầu tiên.", photos: [{ asset_id: secondAsset, caption: "Cùng nhau" }] },
      { id: "our-journey", title: "Hành trình", date: "2025-01-01", description: "Cùng đi xa hơn.", photos: [] },
      { id: "to-infinity", title: "Đến vô cùng", date: "", description: "Còn nhiều điều phía trước.", photos: [] },
    ],
    closingMessage: "Mong còn nhiều kỷ niệm.",
    signature: "Minh",
    music: "",
  },
  "say-yes": {
    templateId: "say-yes",
    sender: "Minh",
    receiver: "Linh",
    nickname: "Bé yêu",
    question: "Em sẽ đồng ý bên anh chứ?",
    subtitle: "Anh có điều này muốn hỏi em.",
    yesLabel: "EM ĐỒNG Ý",
    noLabel: "EM XIN TỪ CHỐI",
    yesHeadline: "Em đã khiến vũ trụ trọn vẹn.",
    yesMessage: "Cảm ơn em đã đồng ý.",
    letter: "Anh muốn cùng em viết tiếp.",
    signature: "Minh",
    specialDate: "2026-02-14",
    noMessage: "Mong em luôn hạnh phúc.",
    noBackLabel: "Quay lại",
    showNoMessage: true,
    theme: "rose-proposal",
    animation: "cinematic",
    particles: true,
    autoRotate: true,
    music: "",
    photos: [{ asset_id: firstAsset, caption: "Ngày đầu tiên" }],
  },
  "distance-means-nothing": {
    templateId: "distance",
    sender: { name: "Minh", city: "Hà Nội", timezone: "Asia/Ho_Chi_Minh", lat: 21.0285, lon: 105.8542 },
    receiver: { name: "Linh", city: "Đà Nẵng", timezone: "Asia/Ho_Chi_Minh", lat: 16.0544, lon: 108.2022 },
    anniversary: "2024-02-14",
    nextMeeting: { date: "2026-12-01", time: "18:30", timezone: "Asia/Ho_Chi_Minh" },
    headline: "Xa mặt không cách lòng",
    message: "Chúng mình sẽ sớm gặp lại.",
    theme: "midnight-distance",
    animation: "cinematic",
    distance: { mode: "coordinates", distanceKm: null },
    messages: [{ emoji: "💌", title: "Mở khi nhớ anh", body: "Anh luôn ở đây." }],
    memories: [{ title: "Lần đầu", body: "Ngày mình gặp nhau." }],
  },
} as const;

describe("publication template registry", () => {
  it("accepts each canonical template's version-one customer data", () => {
    assert.deepEqual(Object.keys(TEMPLATE_RENDERERS), Object.keys(templates));
    for (const [templateId, data] of Object.entries(templates)) {
      const validated = validateTemplateData(templateId, 1, data);
      assert.deepEqual(validated.fields, undefined, `${templateId} should validate`);
      assert.ok(validated.value, `${templateId} should have normalized data`);
    }
  });

  it("extracts unique photo references and only converts approved asset references", () => {
    const data = templates["our-memories"];
    assert.deepEqual(assetReferences("our-memories", data), [firstAsset, secondAsset]);
    const publicData = publicTemplateData("our-memories", data, (id) => `/approved/${id}`);
    assert.equal(publicData.coverImage, `/approved/${firstAsset}`);
    const chapters = publicData.chapters as Array<{ photos: Array<{ url: string }> }>;
    assert.equal(chapters[0]?.photos[0]?.url, `/approved/${secondAsset}`);
    assert.equal(assetReferences("love-letter", templates["love-letter"]).length, 0);
  });

  it("supports versioned Love Letter media while preserving version-one drafts", () => {
    const oldDraft = templates["love-letter"];
    const newDraft = { ...oldDraft, photos: [{ asset_id: secondAsset, caption: "Kỷ niệm" }] };
    assert.ok(validateTemplateData("love-letter", 1, oldDraft).value);
    assert.deepEqual(assetReferences("love-letter", newDraft), [secondAsset]);
    assert.deepEqual(validateTemplateData("love-letter", 2, newDraft).value, newDraft);
    assert.equal(validateTemplateData("love-letter", 2, oldDraft).value, undefined);
    const publicData = publicTemplateData("love-letter", newDraft, (id) => `/approved/${id}`);
    assert.deepEqual(publicData.photos, [{ url: `/approved/${secondAsset}`, caption: "Kỷ niệm" }]);
  });

  it("escapes untrusted chapter and caption text before rendering in the our-memories editor", () => {
    const source = readFileSync(new URL("../templates/our-memories/our-memories.js", import.meta.url), "utf8");
    assert.match(source, /const escHtml=value=>/);
    assert.match(source, /escHtml\(c\.title\)/);
    assert.match(source, /escHtml\(p\.caption\|\|''\)/);
  });

  it("provides accessible names for dynamically generated photo and chapter controls", () => {
    const universe = readFileSync(new URL("../templates/our-universe/index.html", import.meta.url), "utf8");
    const memories = readFileSync(new URL("../templates/our-memories/our-memories.js", import.meta.url), "utf8");
    const proposal = readFileSync(new URL("../templates/say-yes/say-yes.js", import.meta.url), "utf8");
    assert.match(universe, /cap\.setAttribute\('aria-label',`Chú thích ảnh \$\{i\+1\}`\)/);
    assert.match(memories, /aria-label="Tiêu đề kỷ niệm \$\{i\+1\}"/);
    assert.match(memories, /aria-label="Chú thích ảnh \$\{i\+1\}"/);
    assert.match(memories, /aria-label="Chương cho ảnh \$\{i\+1\}"/);
    assert.match(proposal, /aria-label="Chú thích ảnh \$\{i\+1\}"/);
  });

  it("uses keyboard-operable photo pickers and restores focus after photo-list updates", () => {
    const loveLetterHtml = readFileSync(new URL("../templates/love-letter/index.html", import.meta.url), "utf8");
    const memoriesHtml = readFileSync(new URL("../templates/our-memories/index.html", import.meta.url), "utf8");
    const proposalHtml = readFileSync(new URL("../templates/say-yes/index.html", import.meta.url), "utf8");
    const memories = readFileSync(new URL("../templates/our-memories/our-memories.js", import.meta.url), "utf8");
    const proposal = readFileSync(new URL("../templates/say-yes/say-yes.js", import.meta.url), "utf8");
    for (const html of [loveLetterHtml, memoriesHtml, proposalHtml]) {
      assert.match(html, /<button id="pick-photos"[^>]*type="button"/);
    }
    for (const source of [loveLetterHtml, memories, proposal]) {
      assert.match(source, /\$\('#pick-photos'\)\.onclick=\(\)=>\$\('#up'\)\.click\(\)/);
    }
    assert.ok(memories.includes('[data-a="cov"]`)?.focus()'));
    assert.ok(memories.includes('[data-a="ch"]`)?.focus()'));
    assert.ok(proposal.includes('data-i="${focusIndex}"] button`)?.focus()'));
  });

  it("rerenders loaded Our Memories images without triggering another design save", () => {
    const memories = readFileSync(new URL("../templates/our-memories/our-memories.js", import.meta.url), "utf8");
    assert.match(memories, /const renderSoon=\(\)=>\{clearTimeout\(tm\);tm=setTimeout\(apply,220\)\}/);
    assert.match(memories, /const soon=\(\)=>\{window\.dispatchEvent\(new Event\('crushify:changed'\)\);renderSoon\(\)\}/);
    assert.match(memories, /i\.onload=\(\)=>\{i\.ok=1;renderSoon\(\)\}/);
    assert.match(memories, /document\.fonts\.ready\.then\(renderSoon\)/);
  });

  it("keeps the Our Universe inline script hash synchronized with its CSP", () => {
    const source = readFileSync(new URL("../templates/our-universe/index.html", import.meta.url), "utf8");
    const script = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
      .find(([, attributes]) => !/\bsrc\s*=/.test(attributes ?? ""));
    const policy = source.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i);
    assert.ok(script, "expected an inline application script");
    assert.ok(policy, "expected a page Content Security Policy");
    const body = (script[2] ?? "").replace(/\r\n?/g, "\n");
    const hash = createHash("sha256").update(body).digest("base64");
    assert.ok(policy[1]?.includes(`'sha256-${hash}'`), "CSP must authorize the exact inline script");
  });

  it("rejects unknown schemas and data fields instead of passing them to a renderer", () => {
    assert.equal(validateTemplateData("say-yes", 2, templates["say-yes"]).value, undefined);
    assert.equal(validateTemplateData("unknown", 1, {}).value, undefined);
    assert.equal(validateTemplateData("love-letter", 1, {
      ...templates["love-letter"],
      event_handler: "unexpected",
    }).value, undefined);
  });
});
