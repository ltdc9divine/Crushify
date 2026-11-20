import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

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
    };
    const context = {
      URLSearchParams,
      window: { addEventListener() {} },
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
    assert.equal(location.replacedWith, "/templates/love-letter/index.html?guest=1");
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
});
