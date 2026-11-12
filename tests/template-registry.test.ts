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

  it("keeps the customer toolbar label out of the page heading hierarchy", () => {
    const editor = readFileSync(new URL("../shared/customer-editor.js", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../shared/customer-editor.css", import.meta.url), "utf8");
    assert.match(editor, /<p class="crushify-customer-tools-title">Crushify · Lưu thiết kế riêng<\/p>/);
    assert.match(styles, /\.crushify-customer-tools-title\s*\{/);
    assert.doesNotMatch(editor, /<h[1-6]>Crushify · Lưu thiết kế riêng<\/h[1-6]>/);
  });

  it("uses keyboard-operable photo pickers and restores focus after photo-list updates", () => {
    const loveLetterHtml = readFileSync(new URL("../templates/love-letter/index.html", import.meta.url), "utf8");
    const memoriesHtml = readFileSync(new URL("../templates/our-memories/index.html", import.meta.url), "utf8");
    const proposalHtml = readFileSync(new URL("../templates/say-yes/index.html", import.meta.url), "utf8");
    const memories = readFileSync(new URL("../templates/our-memories/our-memories.js", import.meta.url), "utf8");
    const proposal = readFileSync(new URL("../templates/say-yes/say-yes.js", import.meta.url), "utf8");
    const universe = readFileSync(new URL("../templates/our-universe/index.html", import.meta.url), "utf8");
    for (const html of [loveLetterHtml, memoriesHtml, proposalHtml]) {
      assert.match(html, /<button id="pick-photos"[^>]*type="button"/);
    }
    for (const source of [loveLetterHtml, memories, proposal]) {
      assert.match(source, /\$\('#pick-photos'\)\.onclick=\(\)=>\$\('#up'\)\.click\(\)/);
    }
    assert.ok(memories.includes('[data-a="cov"]`)?.focus()'));
    assert.ok(memories.includes('[data-a="ch"]`)?.focus()'));
    assert.ok(proposal.includes('data-i="${focusIndex}"] [data-a="del"]`)?.focus()'));
    assert.match(memories, /data-a="up" aria-label="Di chuyển ảnh \$\{i\+1\} lên"/);
    assert.match(memories, /data-a="down" aria-label="Di chuyển ảnh \$\{i\+1\} xuống"/);
    assert.match(memories, /function movePhoto\(index,direction\)/);
    assert.match(proposal, /data-a="up" aria-label="Di chuyển ảnh \$\{i\+1\} lên"/);
    assert.match(proposal, /data-a="down" aria-label="Di chuyển ảnh \$\{i\+1\} xuống"/);
    assert.match(proposal, /function reorderPhoto\(index,direction\)/);
    assert.match(universe, /`Di chuyển ảnh \$\{i\+1\} lên`/);
    assert.match(universe, /`Di chuyển ảnh \$\{i\+1\} xuống`/);
  });

  it("moves focus into recipient preview and restores it to the editor", () => {
    const universe = readFileSync(new URL("../templates/our-universe/index.html", import.meta.url), "utf8");
    const loveLetter = readFileSync(new URL("../templates/love-letter/index.html", import.meta.url), "utf8");
    const memories = readFileSync(new URL("../templates/our-memories/our-memories.js", import.meta.url), "utf8");
    const proposal = readFileSync(new URL("../templates/say-yes/say-yes.js", import.meta.url), "utf8");
    const distance = readFileSync(new URL("../templates/distance-means-nothing/app.js", import.meta.url), "utf8");
    const distanceStyles = readFileSync(new URL("../templates/distance-means-nothing/distance.css", import.meta.url), "utf8");
    for (const source of [universe, loveLetter]) {
      assert.match(source, /if\(v&&!exit\.hidden\)exit\.focus\(\)/);
      assert.match(source, /else if\(!v&&was\)\$\('#b-pv'\)\.focus\(\)/);
    }
    assert.match(memories, /document\.body\.classList\.add\('recipient'\);\$\('#backEdit'\)\.focus\(\)/);
    assert.match(memories, /document\.body\.classList\.remove\('recipient'\);\$\('#asRecipient'\)\.focus\(\)/);
    assert.match(proposal, /document\.body\.classList\.add\('recipient','pv'\);replay\(\);\$\('#backEdit'\)\.focus\(\)/);
    assert.match(proposal, /document\.body\.classList\.remove\('recipient'\);\$\('#asRecipient'\)\.focus\(\)/);
    assert.match(distance, /if\(v\)\$\('#backEdit'\)\.focus\(\);else \$\('#viewAs'\)\.focus\(\)/);
    assert.match(distanceStyles, /body\.view-preview #backEdit\{display:block\}/);
  });

  it("provides visible focus styles and a logical top-level heading across standard templates", () => {
    const memoriesCss = readFileSync(new URL("../templates/our-memories/our-memories.css", import.meta.url), "utf8");
    const proposalCss = readFileSync(new URL("../templates/say-yes/say-yes.css", import.meta.url), "utf8");
    const distanceCss = readFileSync(new URL("../templates/distance-means-nothing/distance.css", import.meta.url), "utf8");
    const memoriesHtml = readFileSync(new URL("../templates/our-memories/index.html", import.meta.url), "utf8");
    const proposalHtml = readFileSync(new URL("../templates/say-yes/index.html", import.meta.url), "utf8");
    const distanceHtml = readFileSync(new URL("../templates/distance-means-nothing/index.html", import.meta.url), "utf8");
    const loveLetterHtml = readFileSync(new URL("../templates/love-letter/index.html", import.meta.url), "utf8");
    const universeHtml = readFileSync(new URL("../templates/our-universe/index.html", import.meta.url), "utf8");
    assert.match(memoriesCss, /button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible/);
    assert.match(proposalCss, /button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible/);
    assert.match(distanceCss, /:focus-visible/);
    for (const html of [memoriesHtml, proposalHtml, distanceHtml]) {
      assert.match(html, /<h1 class="editor-title">/);
      assert.doesNotMatch(html, /<h[2-6][^>]*>[^<]*(?:Kỷ niệm đôi mình|Hãy nói đồng ý|Xa mặt không cách lòng)/);
    }
    assert.match(loveLetterHtml, /<h2>1 · Câu chuyện<\/h2>/);
    assert.doesNotMatch(loveLetterHtml, /<h3>/);
    assert.match(universeHtml, /createElement\('h2'\);h\.className='editor-section-title'/);
  });

  it("exposes Love Letter photo deletion as a named keyboard-operable button", () => {
    const loveLetter = readFileSync(new URL("../templates/love-letter/index.html", import.meta.url), "utf8");
    assert.match(loveLetter, /b\.className='photo-thumb';b\.setAttribute\('aria-label',`Xóa ảnh kỷ niệm \$\{i\+1\}`\)/);
    assert.match(loveLetter, /b\.onclick=\(\)=>\{up\.splice\(i,1\);D\.photos\?\.splice\(i,1\);PH\.length=0;syncPh\(\)\}/);
  });

  it("deletes removed assets only after the updated design is saved", () => {
    const editor = readFileSync(new URL("../shared/customer-editor.js", import.meta.url), "utf8");
    const save = editor.slice(editor.indexOf("async function save()"), editor.indexOf("function scheduleSave()"));
    const designUpdate = save.indexOf("const result = await api(`/designs/");
    const assetDelete = save.indexOf('await api(`/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" }, csrf);');
    assert.ok(designUpdate >= 0);
    assert.ok(assetDelete > designUpdate);
    assert.match(editor, /key === "asset_id" \|\| key === "coverImage"/);
    assert.match(save, /if \(!currentAssetIds\.has\(assetId\)\) pendingAssetDeletes\.add\(assetId\)/);
    assert.match(save, /cleanupErrors\.length/);
  });

  it("uses CSP-safe static selectors for Love Letter theme changes", () => {
    const loveLetter = readFileSync(new URL("../templates/love-letter/index.html", import.meta.url), "utf8");
    assert.match(loveLetter, /document\.documentElement\.dataset\.theme=TH\[k\]\?k:'rose'/);
    assert.doesNotMatch(loveLetter, /document\.documentElement\.style\.setProperty/);
    assert.doesNotMatch(loveLetter, /b\.style\.borderColor=/);
    for (const theme of ["rose", "mid", "lav", "ivory"]) {
      assert.match(loveLetter, new RegExp(`:root\\[data-theme=${theme}\\]`));
      assert.match(loveLetter, new RegExp(`#themes \\[data-k=${theme}\\]`));
    }
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
    const style = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)][0];
    const policy = source.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i);
    assert.ok(script, "expected an inline application script");
    assert.ok(style, "expected inline styles");
    assert.ok(policy, "expected a page Content Security Policy");
    const body = (script[2] ?? "").replace(/\r\n?/g, "\n");
    const styles = (style[1] ?? "").replace(/\r\n?/g, "\n");
    const hash = createHash("sha256").update(body).digest("base64");
    const styleHash = createHash("sha256").update(styles).digest("base64");
    assert.ok(policy[1]?.includes(`'sha256-${hash}'`), "CSP must authorize the exact inline script");
    assert.ok(policy[1]?.includes(`'sha256-${styleHash}'`), "CSP must authorize the exact inline style");
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
