import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";
import { publicProductCatalog } from "../src/product-catalog.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const templatePages = [
  ["our-universe", "../templates/our-universe/index.html"],
  ["love-letter", "../templates/love-letter/index.html"],
  ["our-memories", "../templates/our-memories/index.html"],
  ["say-yes", "../templates/say-yes/index.html"],
  ["distance-means-nothing", "../templates/distance-means-nothing/index.html"],
];

function fakeElement() {
  const classes = new Set();
  return {
    attributes: {},
    children: [],
    listeners: {},
    classes,
    classList: { add(name) { classes.add(name); } },
    append(...children) { this.children.push(...children); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    getBoundingClientRect() { return { bottom: 40 }; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

describe("guest template preview", () => {
  it("activates only for the explicit guest flag and removes design tokens from the URL", () => {
    const body = fakeElement();
    const elements = [];
    const location = {
      pathname: "/templates/love-letter/index.html",
      search: "?guest=1&design=private-id&publication=private-slug",
      hash: "#private-token",
      replace(url) { this.replacedWith = url; },
      reload() { this.reloaded = true; },
    };
    const context = {
      URLSearchParams,
      Event,
      window: { addEventListener() {}, dispatchEvent(event) { this.resetEvent = event; return true; } },
      location,
      history: { replaceState(_state, _title, url) { this.replacedWith = url; } },
      document: {
        body,
        documentElement: { style: { setProperty(name, value) { this[name] = value; } } },
        createElement() {
          const element = fakeElement();
          elements.push(element);
          return element;
        },
        querySelectorAll() { return []; },
      },
    };

    vm.runInNewContext(read("../shared/guest-preview.js"), context);

    assert.equal(context.window.CRUSHIFY_GUEST_PREVIEW, true);
    assert.equal(context.history.replacedWith, "/templates/love-letter/index.html?guest=1");
    assert.equal(body.children.length, 1);
    assert.ok(body.classes.has("crushify-guest-mode"));
    assert.ok(body.classes.has("crushify-guest-template-love-letter"));
    assert.equal(context.document.documentElement.style["--crushify-guest-offset"], "48px");
    assert.equal(elements[0].attributes["aria-label"], "Chế độ xem thử khách");
    assert.equal(elements[1].attributes["aria-live"], "polite");
    assert.equal(elements[2].children[0].type, "button");
    elements[2].children[0].listeners.click();
    assert.equal(location.reloaded, true);
  });

  it("does not activate guest mode without the explicit flag", () => {
    const body = fakeElement();
    const context = {
      URLSearchParams,
      window: {},
      location: { pathname: "/templates/say-yes/index.html", search: "?design=private-id", hash: "" },
      history: { replaceState() { assert.fail("non-guest URL should not be rewritten"); } },
      document: { body, createElement: fakeElement, querySelectorAll() { return []; } },
    };

    vm.runInNewContext(read("../shared/guest-preview.js"), context);

    assert.equal(context.window.CRUSHIFY_GUEST_PREVIEW, false);
    assert.equal(body.children.length, 0);
  });

  it("uses the current template's guest reset handler before falling back to a page reload", () => {
    const body = fakeElement();
    const elements = [];
    const location = {
      pathname: "/templates/love-letter/index.html",
      search: "?guest=1",
      hash: "",
      replace(url) { this.replacedWith = url; },
      reload() { this.reloaded = true; },
    };
    let resetHandler;
    const context = {
      URLSearchParams,
      Event,
      window: {
        addEventListener(type, callback) {
          if (type === "crushify:guest-reset") resetHandler = callback;
        },
        dispatchEvent(event) {
          this.resetEvent = event;
          resetHandler?.(event);
          return !event.defaultPrevented;
        },
      },
      location,
      history: { replaceState() {} },
      document: {
        body,
        documentElement: { style: { setProperty() {} } },
        createElement() {
          const element = fakeElement();
          elements.push(element);
          return element;
        },
        querySelectorAll() { return []; },
      },
    };
    vm.runInNewContext(read("../shared/guest-preview.js"), context);
    resetHandler = (event) => event.preventDefault();

    elements[2].children[0].listeners.click();

    assert.equal(location.replacedWith, undefined);
    assert.equal(context.window.resetEvent.type, "crushify:guest-reset");
    assert.equal(context.window.resetEvent.cancelable, true);
  });

  it("skips publication API calls for explicit guest sessions", async () => {
    let fetchCount = 0;
    const context = {
      URLSearchParams,
      window: { CRUSHIFY_GUEST_PREVIEW: true },
      location: { search: "?guest=1&publication=private-slug" },
      document: { currentScript: null },
      fetch() { fetchCount++; throw new Error("Guest preview must not fetch"); },
    };

    vm.runInNewContext(read("../shared/publication-bootstrap.js"), context);

    assert.equal(await context.window.loadCrushifyPublication("our-memories"), null);
    assert.equal(fetchCount, 0);
  });

  it("does not initialize customer API tools for guest editors", () => {
    let fetchCount = 0;
    const context = {
      URLSearchParams,
      window: { CRUSHIFY_GUEST_PREVIEW: true },
      location: { search: "?guest=1" },
      document: {
        querySelector() { assert.fail("guest registration must not create customer tools"); },
      },
      fetch() { fetchCount++; throw new Error("Guest preview must not fetch"); },
    };
    vm.runInNewContext(read("../shared/customer-editor.js"), context);
    context.window.registerCrushifyCustomerEditor({
      templateId: "our-memories",
      schemaVersion: 1,
      serialize() {},
      hydrate() {},
    });

    assert.equal(fetchCount, 0);
  });

  it("wires every template to the explicit, isolated guest route", () => {
    const home = read("../index.html");
    const scripts = read("../js/main.js");
    const editor = read("../shared/customer-editor.js");
    const bootstrap = read("../shared/publication-bootstrap.js");
    const guestStyles = read("../shared/guest-preview.css");

    for (const [templateId, path] of templatePages) {
      const html = read(path);
      assert.match(html, /\/shared\/guest-preview\.css/);
      assert.match(html, /\/shared\/guest-preview\.js/);
      assert.match(scripts, new RegExp(`guestHref: 'templates/${templateId === "distance-means-nothing" ? "distance-means-nothing" : templateId}/index\\.html\\?guest=1'`));
      assert.match(scripts, /template-guest-link/);
      assert.match(home, /id="templateGrid"/);
      assert.ok(html.indexOf("/shared/guest-preview.js") < html.indexOf("/shared/publication-bootstrap.js"));
      assert.match(bootstrap, /get\("guest"\) === "1"/);
    }

    assert.match(editor, /get\("guest"\) === "1"\) return;/);
    assert.match(guestStyles, /body\.crushify-guest-mode #app/);
    assert.match(guestStyles, /body\.crushify-guest-template-our-memories #tabs/);
    assert.match(guestStyles, /body\.crushify-guest-template-distance-means-nothing:not\(\.view\) #app/);
    assert.match(read("../templates/our-universe/index.html"), /initializeGuestPreview\(\);else await initializeApi\(\)/);
    assert.match(read("../templates/our-universe/index.html"), /async function addGuestPhoto/);
    assert.match(read("../templates/our-universe/index.html"), /URL\.revokeObjectURL\(url\)/);
    assert.match(read("../templates/love-letter/index.html"), /if\(!window\.CRUSHIFY_GUEST_PREVIEW&&Q\.get\('guest'\)!=='1'\)window\.__love/);
  });

  it("keeps guest edits page-local and preserves each template's live update path", () => {
    const loveLetter = read("../templates/love-letter/index.html");
    const memories = read("../templates/our-memories/our-memories.js");
    const proposal = read("../templates/say-yes/say-yes.js");
    const distance = read("../templates/distance-means-nothing/app.js");
    const universe = read("../templates/our-universe/index.html");
    for (const source of [loveLetter, memories, proposal, distance, universe]) {
      assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage)\b/);
    }
    assert.match(loveLetter, /Object\.values\(F\)\.forEach\(e=>e\.addEventListener\('input',inp\)\)/);
    assert.match(memories, /i\.oninput=\(\)=>\{D\[i\.dataset\.k\]=i\.value;soon\(\)\}/);
    assert.match(proposal, /i\.oninput=i\.onchange=\(\)=>\{D\[k\]=i\.value;apply\(\)\}/);
    assert.match(distance, /set\(S,el\.dataset\.k,v\);if\(el\.dataset\.k==='distance\.mode'\).*?changed\(/);
    assert.match(distance, /const guestPreview=window\.CRUSHIFY_GUEST_PREVIEW===true/);
    assert.match(distance, /S=guestPreview\?demoData\(\):merge\(publicationData\)/);
    assert.match(distance, /name:'Minh',city:'Hà Nội'/);
    assert.match(distance, /name:'Linh',city:'Tokyo'/);
    assert.match(universe, /e\.oninput=\(\)=>\{set\(D,path,e\.value\);renderText\(\);scheduleSave\(\)\}/);
    assert.match(universe, /window\.CRUSHIFY_GUEST_PREVIEW===true\|\|Q\.get\('guest'\)==='1'\)initializeGuestPreview\(\)/);
  });

  it("keeps guest demo edits and photo previews client-side without order or payment requests", () => {
    const sources = templatePages.map(([, path]) => read(path));
    const universe = read("../templates/our-universe/index.html");
    const guestPhotoFunction = /async function addGuestPhoto\(file\)\{([^\n]*)\}/.exec(universe)?.[1];

    assert.ok(guestPhotoFunction, "Our Universe guest photo handler is missing");
    assert.doesNotMatch(guestPhotoFunction, /\b(?:fetch|apiFetch|apiJson|upload)\s*\(/);
    assert.match(guestPhotoFunction, /URL\.createObjectURL\(file\)/);
    assert.match(guestPhotoFunction, /drawImage/);
    assert.match(universe, /if\(window\.CRUSHIFY_GUEST_PREVIEW===true\|\|Q\.get\('guest'\)==='1'\)addPhoto=addGuestPhoto/);

    for (const source of [
      read("../templates/love-letter/index.html"),
      read("../templates/our-memories/our-memories.js"),
      read("../templates/say-yes/say-yes.js"),
    ]) {
      assert.match(source, /URL\.createObjectURL\(/);
      assert.match(source, /URL\.revokeObjectURL\(/);
      assert.match(source, /toDataURL\(/);
    }

    assert.doesNotMatch(sources.join("\n"), /\/api\/v1\/(?:orders|payments|checkout)\b/);
  });

  it("resets the affected guest editors and scenes without changing authenticated hydration", () => {
    const loveLetter = read("../templates/love-letter/index.html");
    const proposal = read("../templates/say-yes/say-yes.js");
    const distance = read("../templates/distance-means-nothing/app.js");
    const customerEditor = read("../shared/customer-editor.js");
    const guestPreview = read("../shared/guest-preview.js");

    assert.match(guestPreview, /new Event\("crushify:guest-reset", \{ cancelable: true \}\)/);
    assert.match(guestPreview, /location\.reload\(\)/);
    assert.match(loveLetter, /const D=\{from:'Anh',to:'Em'/);
    assert.match(loveLetter, /finally\{URL\.revokeObjectURL\(url\)\}/);
    assert.match(proposal, /window\.addEventListener\('crushify:guest-reset',event=>/);
    assert.match(proposal, /D=defaults\(\);S\.cel=0;S\.kick=0;S\.fw=0/);
    assert.match(proposal, /pendingPhotoUrls\.delete\(url\);URL\.revokeObjectURL\(url\)/);
    assert.match(distance, /window\.addEventListener\('crushify:guest-reset',event=>/);
    assert.match(distance, /S=demoData\(\);bind\(\);render\(\)/);
    assert.match(customerEditor, /if \(window\.CRUSHIFY_GUEST_PREVIEW === true \|\|/);
    assert.match(customerEditor, /await adapter\.hydrate\(design\.data/);
  });

  it("renders a locked, canonical homepage catalog when the public API is unavailable", async () => {
    const ids = templatePages.map(([id]) => id);
    const cardPrices = ids.map((id) => ({ dataset: { templatePrice: id }, textContent: "" }));
    const elements = Object.fromEntries([
      "startingPrice",
      "startingPriceNote",
      "includedHostingPrice",
      "additionalHostingPrice",
      "lifetimePrice",
      "pricingFormula",
      "pricingAvailability",
    ].map((id) => [id, { dataset: {}, textContent: "" }]));
    const document = {
      querySelectorAll(selector) {
        assert.equal(selector, "[data-template-price]");
        return cardPrices;
      },
      getElementById(id) { return elements[id]; },
    };
    const warnings = [];
    const context = {
      document,
      Intl,
      console: { warn(...args) { warnings.push(args); }, error() { assert.fail("Canonical fallback should render"); } },
      window: {},
    };
    vm.runInNewContext(read("../shared/catalog-pricing.js"), context);
    const fallbackCatalog = JSON.parse(JSON.stringify(context.window.CRUSHIFY_PUBLIC_CATALOG));
    const canonicalCatalog = publicProductCatalog();

    assert.deepEqual(fallbackCatalog.pricing_policy, canonicalCatalog.pricing_policy);
    assert.deepEqual(fallbackCatalog.products, canonicalCatalog.products);
    assert.equal(fallbackCatalog.checkout_enabled, false);

    const requests = [];
    const result = await context.window.loadCrushifyCatalogPricing(async (url, options) => {
      requests.push({ url, options });
      throw new Error("Preview runtime guard returned HTTP 500");
    });

    assert.equal(result, "fallback");
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method ?? "GET"]), [
      ["/api/v1/catalog", "GET"],
    ]);
    assert.equal(cardPrices.length, 5);
    assert.ok(cardPrices.every((node) => node.textContent === "59.000 đ · gồm 1 tháng hosting"));
    assert.equal(elements.startingPrice.textContent, "59.000 đ");
    assert.equal(elements.additionalHostingPrice.textContent, "Mỗi tháng hosting thêm: 10.000 đ");
    assert.equal(elements.lifetimePrice.textContent, "Gói trọn đời: 199.000 đ");
    assert.equal(elements.pricingAvailability.dataset.state, "locked");
    assert.match(elements.pricingAvailability.textContent, /Tạo đơn chưa mở/);
    assert.equal(warnings.length, 1);
    assert.equal(read("../index.html").includes('src="shared/catalog-pricing.js"'), true);
    assert.equal(read("../js/main.js").includes("loadCrushifyCatalogPricing"), true);
  });

  it("routes card viewing interactions and modal actions to Guest Preview", () => {
    const home = read("../index.html");
    const main = read("../js/main.js");
    const styles = read("../css/style.css");
    const cardElements = [...home.matchAll(/<article class="template-card"[^>]*data-href="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
    const expectedCards = [
      ["our-universe", "Vũ trụ của chúng mình", "Một vũ trụ nhỏ chỉ có hai người."],
      ["love-letter", "Lá thư tình", "Mở phong thư, mở cả lòng mình."],
      ["our-memories", "Kỷ niệm đôi mình", "Gom những khoảnh khắc thành một nơi."],
      ["say-yes", "Hãy nói đồng ý!", "Một câu hỏi nhỏ, một khoảnh khắc nhớ lâu."],
      ["distance-means-nothing", "Xa mặt không cách lòng", "Dành cho hai người dưới cùng một bầu trời."],
    ];

    assert.equal(cardElements.length, expectedCards.length);
    for (const [id, title, description] of expectedCards) {
      const guestHref = `templates/${id}/index.html?guest=1`;
      const card = cardElements.find(([, href]) => href === guestHref)?.[2];
      assert.ok(card, `homepage card is missing for ${id}`);
      assert.ok(card.includes(`<h3><a class="template-card-link" href="${guestHref}">`), `${id} title link is not a guest link`);
      assert.ok(card.includes(`>${title}</a></h3>`), `${id} title is not canonical`);
      assert.ok(card.includes(`<p>${description}</p>`), `${id} description is not canonical`);

      const anchors = [...card.matchAll(/<a\b([^>]*)href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      const customizeLink = anchors.find(([, attributes]) => attributes.includes("template-order-link"));
      assert.ok(customizeLink, `${id} authenticated customize link is missing`);
      assert.equal(customizeLink[2], `templates/${id}/index.html`);
      assert.equal(customizeLink[3].replace(/<[^>]*>/g, "").trim(), "Đăng nhập để tùy chỉnh ↗");

      const previewLinks = anchors.filter(([, attributes]) => !attributes.includes("template-order-link"));
      assert.ok(previewLinks.length >= 2, `${id} needs title and card preview links`);
      assert.ok(previewLinks.every(([, , href]) => href === guestHref), `${id} has a preview link to the authenticated editor`);
    }

    for (const [id] of expectedCards) {
      assert.ok(main.includes(`guestHref: 'templates/${id}/index.html?guest=1'`), `${id} guestHref is incorrect`);
    }
    assert.match(main, /template\.guestHref === card\.dataset\.href/);
    assert.match(main, /guestLink\.href = item\.guestHref/);
    assert.match(main, /modalChoose\.href = item\.guestHref/);
    assert.match(main, /window\.location\.assign\(card\.dataset\.href\)/);
    assert.match(styles, /\.template-card-link::after\{content:"";position:absolute;inset:0\}/);
    assert.match(styles, /\.template-order-link,\.round-arrow,\.template-preview\{position:relative;z-index:1\}/);
    assert.match(home, /href="templates\/our-universe\/index\.html\?guest=1" id="modalChoose"/);
  });
});
