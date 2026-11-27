import asyncio
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[1]
PRIMARY = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"
FALLBACK = "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"
THREE_SOURCE = urllib.request.urlopen(
    PRIMARY,
    timeout=30,
).read()
THREE_INTEGRITY = "sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu"


async def scenario(browser, template, primary_status, fallback_status):
    context = await browser.new_context(viewport={"width": 390, "height": 844})
    page = await context.new_page()
    if primary_status == "no-global":
        await page.add_init_script(
            """
            window.__qaPrimaryAssigned = false;
            window.__qaFallbackAssigned = false;
            let qaFallbackValue;
            Object.defineProperty(window, "THREE", {
                configurable: true,
                get() {
                    return window.__qaFallbackAssigned ? qaFallbackValue : undefined;
                },
                set(value) {
                    if (!window.__qaPrimaryAssigned) {
                        window.__qaPrimaryAssigned = true;
                        return;
                    }
                    qaFallbackValue = value;
                    window.__qaFallbackAssigned = true;
                }
            });
            """
        )
    counts = {PRIMARY: 0, FALLBACK: 0}
    failed = []
    console_errors = []
    page.on("request", lambda request: counts.__setitem__(
        request.url, counts.get(request.url, 0) + 1
    ) if request.url in counts else None)
    page.on("requestfailed", lambda request: failed.append(request.url))
    page.on("console", lambda message: console_errors.append(message.text)
              if message.type == "error" else None)

    async def route_handler(route):
        url = route.request.url
        if url.endswith(f"/templates/{template}/index.html") and fallback_status in (
            "existing-failed",
            "existing-pending",
            "existing-fail-after",
        ):
            with urllib.request.urlopen(url, timeout=30) as response:
                html = response.read().decode("utf-8")
            existing = (
                f'<script src="{PRIMARY}" integrity="{THREE_INTEGRITY}" '
                'crossorigin="anonymous" referrerpolicy="no-referrer"></script>'
            )
            html = html.replace("<head>", "<head>" + existing, 1)
            await route.fulfill(status=200, content_type="text/html", body=html)
            return
        if url == PRIMARY:
            if fallback_status == "existing-pending":
                await asyncio.sleep(0.6)
                await route.fulfill(status=200, content_type="application/javascript", body=THREE_SOURCE)
            elif fallback_status == "existing-fail-after":
                await asyncio.sleep(0.6)
                await route.abort("failed")
            elif primary_status == "fail":
                await route.abort("failed")
            elif primary_status == "no-global":
                await route.fulfill(status=200, content_type="application/javascript", body=THREE_SOURCE)
            else:
                await route.fulfill(status=200, content_type="application/javascript", body=THREE_SOURCE)
        elif url == FALLBACK:
            if fallback_status == "fail":
                await route.abort("failed")
            elif fallback_status == "no-global":
                await route.fulfill(status=200, content_type="application/javascript", body=THREE_SOURCE)
            else:
                await route.fulfill(status=200, content_type="application/javascript", body=THREE_SOURCE)
        else:
            await route.continue_()

    await context.route("**/*", route_handler)
    wait_until = (
        "domcontentloaded"
        if fallback_status in ("existing-pending", "existing-fail-after")
        else "load"
    )
    await page.goto(
        f"http://127.0.0.1:4173/templates/{template}/index.html",
        wait_until=wait_until,
        timeout=15000,
    )
    await page.wait_for_timeout(300)

    if fallback_status == "existing-failed":
        concurrent = await page.evaluate(
            """async () => {
                if (typeof window.loadCrushifyThree !== "function") {
                    return {available: false, samePromise: false, states: ["not-exported"]};
                }
                const calls = [window.loadCrushifyThree(), window.loadCrushifyThree(), window.loadCrushifyThree()];
                const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 2500));
                const settled = await Promise.race([
                    Promise.allSettled(calls).then((results) => ({
                        states: results.map((result) => result.status)
                    })),
                    timeout
                ]);
                return {
                    available: true,
                    samePromise: calls[0] === calls[1] && calls[1] === calls[2],
                    states: typeof settled === "string" ? [settled] : settled.states
                };
            }"""
        )
    else:
        concurrent = await page.evaluate(
            """async () => {
                const calls = [window.loadCrushifyThree(), window.loadCrushifyThree(), window.loadCrushifyThree()];
                const results = await Promise.allSettled(calls);
                return {
                    samePromise: calls[0] === calls[1] && calls[1] === calls[2],
                    states: results.map((result) => result.status)
                };
            }"""
        )
    await page.wait_for_timeout(300)

    state = await page.evaluate(
        """template => {
            return {
                template,
                three: !!window.THREE,
                universe: !!window.__universe,
                love: !!window.__love,
                scriptCount: [...document.scripts].filter((script) =>
                    script.src === "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" ||
                    script.src === "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"
                ).length,
                fallback: template === "our-universe"
                    ? document.querySelector("#cv2") !== null || document.querySelector("#note")?.hidden === false
                    : document.querySelector("#fb")?.hidden === false
            };
        }""",
        template,
    )

    await context.close()
    return {
        "counts": counts,
        "failed": failed,
        "consoleErrors": console_errors,
        "concurrent": concurrent,
        "state": state,
    }


async def run():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        output = {}
        for template in ("our-universe", "love-letter"):
            output[template] = {}
            output[template]["primary-success"] = await scenario(browser, template, "success", "success")
            output[template]["fallback-success"] = await scenario(browser, template, "fail", "success")
            output[template]["both-fail"] = await scenario(browser, template, "fail", "fail")
            output[template]["script-no-global"] = await scenario(browser, template, "no-global", "no-global")
            output[template]["existing-failed"] = await scenario(browser, template, "fail", "existing-failed")
            output[template]["existing-pending"] = await scenario(browser, template, "fail", "existing-pending")
            output[template]["existing-fail-after"] = await scenario(browser, template, "fail", "existing-fail-after")

            primary = output[template]["primary-success"]
            fallback = output[template]["fallback-success"]
            both = output[template]["both-fail"]
            no_global = output[template]["script-no-global"]
            existing = output[template]["existing-failed"]
            existing_pending = output[template]["existing-pending"]
            existing_fail_after = output[template]["existing-fail-after"]

            assert primary["counts"][PRIMARY] == 1, primary
            assert primary["counts"][FALLBACK] == 0, primary
            assert primary["concurrent"]["samePromise"], primary
            assert primary["state"]["scriptCount"] == 1, primary
            assert primary["state"]["fallback"] is False, primary

            assert fallback["counts"][PRIMARY] == 1, fallback
            assert fallback["counts"][FALLBACK] == 1, fallback
            assert fallback["concurrent"]["samePromise"], fallback
            assert fallback["state"]["scriptCount"] == 2, fallback
            assert fallback["state"]["fallback"] is False, fallback

            assert both["counts"][PRIMARY] == 1, both
            assert both["counts"][FALLBACK] == 1, both
            assert both["concurrent"]["states"] == ["rejected"] * 3, both
            assert both["state"]["scriptCount"] == 2, both
            assert both["state"]["fallback"] is True, both

            assert no_global["counts"][PRIMARY] == 1, no_global
            assert no_global["counts"][FALLBACK] == 1, no_global
            assert no_global["state"]["three"] is True, no_global
            assert no_global["state"]["fallback"] is False, no_global

            assert existing["counts"][PRIMARY] == 1, existing
            assert existing["concurrent"]["samePromise"], existing
            assert "timeout" not in existing["concurrent"]["states"], existing
            assert existing["counts"][FALLBACK] == 1, existing

            assert existing_pending["counts"][PRIMARY] == 1, existing_pending
            assert existing_pending["counts"][FALLBACK] == 0, existing_pending
            assert existing_pending["concurrent"]["samePromise"], existing_pending
            assert existing_pending["state"]["three"] is True, existing_pending

            assert existing_fail_after["counts"][PRIMARY] == 1, existing_fail_after
            assert existing_fail_after["counts"][FALLBACK] == 1, existing_fail_after
            assert existing_fail_after["concurrent"]["samePromise"], existing_fail_after
            assert existing_fail_after["state"]["three"] is True, existing_fail_after
        await browser.close()
        print(json.dumps(output, indent=2))


def main():
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "4173", "--bind", "127.0.0.1"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        asyncio.run(run())
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    main()
