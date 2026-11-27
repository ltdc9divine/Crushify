import asyncio
import json
import os
import struct
import subprocess
import time
import urllib.parse
import urllib.request
import zlib

from playwright.async_api import async_playwright


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


async def read_ready_line(process):
    deadline = time.time() + 90
    while time.time() < deadline:
        line = await asyncio.to_thread(process.stdout.readline)
        if "BROWSER_FIXTURE_READY" in line:
            return json.loads(line.split("BROWSER_FIXTURE_READY", 1)[1].strip())
        if process.poll() is not None:
            raise RuntimeError("Browser fixture exited before becoming ready")
    raise TimeoutError("Browser fixture did not become ready")


def png_bytes():
    def chunk(name, data):
        return (
            struct.pack(">I", len(data))
            + name
            + data
            + struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x22\x88\xff"))
        + chunk(b"IEND", b"")
    )


def stop_fixture(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def request_cleanup(control_origin):
    with urllib.request.urlopen(
        control_origin + "/cleanup",
        data=b"",
        timeout=5,
    ) as response:
        response.read()


async def main():
    fixture = subprocess.Popen(
        [
            "node",
            "tests/orders-2-10-browser-fixture.mjs",
            "--with-local-image-normalizer",
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    control_origin = None
    browser = None
    try:
        ready = await read_ready_line(fixture)
        origin = ready["origin"]
        control_origin = ready["controlOrigin"]
        asset_responses = []
        order_requests = []
        page_errors = []
        csp_errors = []

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": 390, "height": 844})
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on(
                "console",
                lambda message: csp_errors.append(message.text)
                if message.type == "error" and "data:," in message.text
                else None,
            )
            page.on(
                "request",
                lambda request: order_requests.append(request.url)
                if request.method == "POST" and request.url.endswith("/api/v1/orders")
                else None,
            )
            page.on(
                "response",
                lambda response: asset_responses.append(
                    (response.request.method, response.url, response.status)
                )
                if "/api/v1/assets/" in response.url
                else None,
            )

            response = await page.goto(origin + "/", wait_until="networkidle")
            assert response and response.status == 200
            await page.locator(
                'a.template-card-link[href^="templates/our-universe/"]'
            ).click()
            await page.wait_for_function(
                "() => typeof window.CRUSHIFY_GUEST_EDITOR?.serializeGuest === 'function'",
                timeout=30000,
            )
            await page.locator(
                '#ed input:not([type="date"]):not([type="file"]):not([type="hidden"])'
            ).first.fill("QA Sender")
            await page.locator("#ed textarea").first.fill("QA image handoff")
            await page.locator('input[type="file"]').set_input_files(
                {
                    "name": "guest-photo.png",
                    "mimeType": "image/png",
                    "buffer": png_bytes(),
                }
            )
            await page.wait_for_function(
                "async () => (await window.CRUSHIFY_GUEST_EDITOR.serializeGuest())"
                ".guestPhotos?.length > 0",
                timeout=15000,
            )
            await page.locator("#b-pv").click()
            await page.wait_for_function(
                "() => document.querySelector('#app')?.classList.contains('rc')"
            )
            await page.locator(".crushify-guest-order").click()
            await page.wait_for_function(
                "() => new URL(location.href).searchParams.has('guest_draft')",
                timeout=30000,
            )
            await page.wait_for_function(
                "() => typeof window.CrushifyGuestDraft?.createStore === 'function'",
                timeout=15000,
            )
            draft_id = await page.evaluate(
                "() => new URL(location.href).searchParams.get('guest_draft')"
            )
            draft = await page.evaluate(
                """async (id) => (await window.CrushifyGuestDraft
                  .createStore().load(id)).data""",
                draft_id,
            )
            assert draft["design"]["sender"] == "QA Sender"
            assert len(draft["guestPhotos"]) == 1

            login = await asyncio.to_thread(
                get_json,
                control_origin
                + "/login?"
                + urllib.parse.urlencode({"email": "guest-image@example.test"}),
            )
            target = origin + "/templates/our-universe/?" + urllib.parse.urlencode(
                {"guest_draft": draft_id, "magic_token": login["token"]}
            )
            failed_transfer = {"injected": False}

            async def fail_first_design_save(route):
                if route.request.method == "PUT" and not failed_transfer["injected"]:
                    failed_transfer["injected"] = True
                    await route.fulfill(
                        status=503,
                        content_type="application/json",
                        body=json.dumps({"error": {"message": "Synthetic save failure"}}),
                    )
                    return
                await route.continue_()

            await page.route("**/api/v1/designs/*", fail_first_design_save)
            await page.goto(target, wait_until="domcontentloaded")
            await page.get_by_text("Bản nháp tạm vẫn được giữ trên thiết bị.", exact=False).wait_for(
                timeout=30000
            )
            retained_draft = await page.evaluate(
                """async (id) => {
                  const draft = await window.CrushifyGuestDraft.createStore().load(id);
                  return draft.data.design.sender;
                }""",
                draft_id,
            )
            assert retained_draft == "QA Sender"
            await page.unroute("**/api/v1/designs/*", fail_first_design_save)
            await page.goto(
                origin + "/templates/our-universe/?" +
                urllib.parse.urlencode({"guest_draft": draft_id}),
                wait_until="domcontentloaded",
            )
            await page.wait_for_function(
                "() => location.pathname === '/checkout/' && "
                "new URL(location.href).searchParams.has('design_id')",
                timeout=30000,
            )
            design_id = await page.evaluate(
                "() => new URL(location.href).searchParams.get('design_id')"
            )
            await page.wait_for_selector("#checkout-panel:not([hidden])")
            saved = await page.evaluate(
                """async (id) => {
                  const response = await fetch('/api/v1/designs/' + encodeURIComponent(id));
                  return { status: response.status, design: await response.json() };
                }""",
                design_id,
            )
            assert saved["status"] == 200
            photos = saved["design"]["data"]["photos"]
            assert len(photos) == 1 and photos[0].get("asset_id")
            draft_removed = await page.evaluate(
                """async (id) => {
                  try {
                    await window.CrushifyGuestDraft.createStore().load(id);
                    return false;
                  } catch {
                    return true;
                  }
                }""",
                draft_id,
            )
            assert draft_removed
            assert await page.locator("#submit-order").is_disabled()
            assert not page_errors, page_errors
            assert not csp_errors, csp_errors
            assert not order_requests, order_requests
            assert any(
                method == "POST" and url.endswith("/api/v1/assets/upload-url") and status == 201
                for method, url, status in asset_responses
            ), asset_responses
            assert any(
                method == "PUT" and "/content" in url and status == 204
                for method, url, status in asset_responses
            ), asset_responses
            assert any(
                method == "POST" and "/complete" in url and status == 200
                for method, url, status in asset_responses
            ), asset_responses

            print(
                json.dumps(
                    {
                        "image_guest_draft_handoff": True,
                        "failed_transfer_preserved_and_recovered": True,
                        "normalized_asset_upload_and_completion": True,
                        "saved_design_contains_asset_reference": True,
                        "order_submitted": False,
                        "uncaught_page_errors": page_errors,
                        "checkout_csp_errors": csp_errors,
                    },
                    ensure_ascii=True,
                )
            )
    finally:
        try:
            if browser:
                await browser.close()
        finally:
            try:
                if control_origin:
                    await asyncio.to_thread(request_cleanup, control_origin)
            finally:
                stop_fixture(fixture)


asyncio.run(main())
