import asyncio
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request

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
    with urllib.request.urlopen(control_origin + "/cleanup", data=b"", timeout=5) as response:
        response.read()


async def main():
    fixture = subprocess.Popen(
        ["node", "tests/orders-2-10-browser-fixture.mjs"],
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
        page_errors = []

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": 390, "height": 844})
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            response = await page.goto(origin + "/account/websites/", wait_until="networkidle")
            assert response and response.status == 200
            await page.locator("#login-form").wait_for(state="visible", timeout=30000)
            assert await page.locator("#notice").inner_text() == (
                "Đăng nhập để xem thiết kế và website của bạn."
            )

            email = "account-dashboard@example.test"
            await page.locator("#login-email").fill(email)
            await page.locator('#login-form button[type="submit"]').click()
            await page.get_by_text(
                "Nếu địa chỉ có thể dùng, liên kết đăng nhập sẽ được gửi qua email."
            ).wait_for()

            login = await asyncio.to_thread(
                get_json,
                control_origin + "/login?" + urllib.parse.urlencode(
                    {"email": email, "return_to": "/account/websites/"}
                ),
            )
            await page.goto(origin + "/", wait_until="networkidle")
            await page.goto(
                origin + "/account/websites/#magic_token=" + urllib.parse.quote(login["token"]),
                wait_until="networkidle",
            )
            await page.wait_for_function(
                "() => document.querySelector('#notice')?.textContent !== 'Đang tải tài khoản…'",
                timeout=30000,
            )
            assert await page.locator("#session-actions").is_visible(), (
                f"dashboard sign-in failed: {await page.locator('#notice').inner_text()}; "
                f"url={page.url}"
            )
            assert "magic_token" not in page.url
            assert await page.locator("#account-email").inner_text() == email
            await page.get_by_text("Chưa có thiết kế nào trong tài khoản.").wait_for()

            await page.reload(wait_until="networkidle")
            await page.locator("#session-actions").wait_for(state="visible")

            created = await page.evaluate(
                """async () => {
                  const account = await fetch('/api/v1/customers/me').then((r) => r.json());
                  const response = await fetch('/api/v1/designs', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'X-CSRF-Token': account.csrf_token,
                    },
                    body: JSON.stringify({ template_id: 'our-universe', schema_version: 1 }),
                  });
                  return { status: response.status, body: await response.json() };
                }"""
            )
            assert created["status"] == 201, created
            await page.reload(wait_until="networkidle")
            edit = page.get_by_role("link", name="Mở trình chỉnh sửa / xem trước")
            await edit.wait_for()
            assert f"design={created['body']['design_id']}" in await edit.get_attribute("href")

            for width in (390, 1280):
                await page.set_viewport_size({"width": width, "height": 844})
                assert await page.evaluate(
                    "() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"
                ), f"dashboard horizontally overflows at {width}px"

            await edit.click()
            await page.wait_for_url("**/templates/our-universe/**")
            await page.wait_for_load_state("networkidle")
            reopened_text = await page.locator("body").inner_text()
            assert "Đã tải bản thiết kế từ máy chủ" in reopened_text, (
                f"saved design could not be reopened at {page.url}: {reopened_text[:1000]}"
            )

            await page.goto(origin + "/account/websites/", wait_until="networkidle")

            async def fail_publications(route):
                await route.fulfill(
                    status=503,
                    content_type="application/json",
                    body=json.dumps({"error": {"message": "Synthetic dashboard failure"}}),
                )

            await page.route("**/api/v1/publications", fail_publications)
            await page.reload(wait_until="networkidle")
            await page.get_by_text("Synthetic dashboard failure").wait_for()
            assert await page.locator("#login-form").is_hidden()
            retry = page.get_by_role("button", name="Thử tải lại")
            await retry.wait_for()
            await page.unroute("**/api/v1/publications", fail_publications)
            await retry.click()
            await page.get_by_role("link", name="Mở trình chỉnh sửa / xem trước").wait_for()

            await page.locator("#logout").click()
            await page.locator("#login-form").wait_for(state="visible")
            assert await page.locator("#session-actions").is_hidden()
            unauthenticated = await page.evaluate(
                "() => fetch('/api/v1/customers/me').then((response) => response.status)"
            )
            assert unauthenticated == 401
            assert not page_errors, page_errors

            print(json.dumps({
                "dashboard_magic_link_login": True,
                "session_persisted_after_reload": True,
                "empty_and_error_recovery_states": True,
                "saved_design_reopened": True,
                "logout_revoked_session": True,
                "responsive_widths": [390, 1280],
                "page_errors": page_errors,
            }))
    finally:
        if browser:
            await browser.close()
        try:
            if control_origin:
                await asyncio.to_thread(request_cleanup, control_origin)
        finally:
            stop_fixture(fixture)


asyncio.run(main())
