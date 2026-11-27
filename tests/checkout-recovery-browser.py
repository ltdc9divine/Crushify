import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse

from playwright.async_api import async_playwright


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


async def read_ready_line(process):
    deadline = time.time() + 60
    while time.time() < deadline:
        line = await asyncio.to_thread(process.stdout.readline)
        if line:
            if "BROWSER_FIXTURE_READY" in line:
                payload = line.split("BROWSER_FIXTURE_READY", 1)[1].strip()
                return json.loads(payload)
        if process.poll() is not None:
            raise RuntimeError("Browser fixture exited unexpectedly")
        await asyncio.sleep(0.05)
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


async def login_as(page, control_origin, origin, email):
    login = await asyncio.to_thread(
        get_json,
        control_origin + "/login?email=" + urllib.request.quote(email, safe=""),
    )
    token = login["token"]
    result = await page.evaluate(
        """
        async ({ origin, token }) => {
          const response = await fetch(origin + '/api/v1/customers/session/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          });
          return { status: response.status, body: await response.json() };
        }
        """,
        {"origin": origin, "token": token},
    )
    if result["status"] != 200:
        raise AssertionError({"login_failed": email, "result": result})


async def logout(page):
    result = await page.evaluate(
        """
        async () => {
          const me = await fetch('/api/v1/customers/me');
          const body = await me.json();
          const response = await fetch('/api/v1/customers/session', {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': body.csrf_token || '',
            },
          });
          return { status: response.status, body: await response.json() };
        }
        """
    )
    if result["status"] != 200:
        raise AssertionError({"logout_failed": result})


async def main():
    fixture = subprocess.Popen(
        ["node", "tests/orders-2-10-browser-fixture.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    profile = tempfile.TemporaryDirectory(prefix="crushify-checkout-recovery-profile-")

    try:
        ready = await read_ready_line(fixture)
        origin = ready["origin"]
        control_origin = ready["controlOrigin"]

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch_persistent_context(
                profile.name,
                headless=True,
            )
            page = await browser.new_page()
            await page.goto(control_origin + "/open?template=our-universe", wait_until="networkidle")

            created = await page.evaluate(
                """
                async () => {
                  const me = await fetch('/api/v1/customers/me');
                  const meBody = await me.json();
                  const response = await fetch('/api/v1/designs', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'X-CSRF-Token': meBody.csrf_token || '',
                    },
                    body: JSON.stringify({ template_id: 'our-universe', schema_version: 1 }),
                  });
                  return { status: response.status, body: await response.json() };
                }
                """
            )
            assert created["status"] == 201, created
            design_id = created["body"]["design_id"]

            design = {
                "design_id": design_id,
                "revision": created["body"]["revision"],
                "template_id": "our-universe",
                "schema_version": 1,
            }
            payload = {
                "design_id": design_id,
                "duration_type": "monthly",
                "hosting_months": 1,
                "asset_consents": [],
            }

            account_key = await page.evaluate(
                """
                async () => {
                  const bytes = new TextEncoder().encode('orders-2-10-admin@example.test');
                  const digest = await crypto.subtle.digest('SHA-256', bytes);
                  return [...new Uint8Array(digest)].map((value) =>
                    value.toString(16).padStart(2, '0')).join('');
                }
                """
            )

            prepare = """
                async ({ accountKey, design, payload }) => {
                  const module = await import('/checkout/checkout-intent.js');
                  const store = module.createCheckoutIntentStore({
                    storageKey: `checkout:${accountKey}:${design.design_id}`,
                    accountKey,
                    designId: design.design_id,
                  });
                  return store.prepare(payload, design);
                }
            """

            second_page = await browser.new_page()
            await second_page.goto(origin + "/checkout/?design_id=" + design_id, wait_until="networkidle")

            tab_a, tab_b = await asyncio.gather(
                page.evaluate(prepare, {
                    "accountKey": account_key,
                    "design": design,
                    "payload": payload,
                }),
                second_page.evaluate(prepare, {
                    "accountKey": account_key,
                    "design": design,
                    "payload": payload,
                }),
            )
            assert tab_a["key"] == tab_b["key"], "genuine concurrent acquisition diverged"
            stale_record = await page.evaluate(
                """
                async ({ accountKey, design }) => {
                  const module = await import('/checkout/checkout-intent.js');
                  const store = module.createCheckoutIntentStore({
                    storageKey: `checkout:${accountKey}:${design.design_id}`,
                    accountKey,
                    designId: design.design_id,
                  });
                  const records = await store.list();
                  return records[0];
                }
                """,
                {"accountKey": account_key, "design": design},
            )
            newer_result = await second_page.evaluate(
                """
                async ({ accountKey, design, intentId }) => {
                  const module = await import('/checkout/checkout-intent.js');
                  const store = module.createCheckoutIntentStore({
                    storageKey: `checkout:${accountKey}:${design.design_id}`,
                    accountKey,
                    designId: design.design_id,
                  });
                  await store.associate(intentId, 'newer-order');
                  return { associated: 'newer-order' };
                }
                """,
                {"accountKey": account_key, "design": design, "intentId": stale_record["intentId"]},
            )
            await page.wait_for_timeout(50)
            stale_result = await page.evaluate(
                """
                async ({ accountKey, design, record }) => {
                  const module = await import('/checkout/checkout-intent.js');
                  const store = module.createCheckoutIntentStore({
                    storageKey: `checkout:${accountKey}:${design.design_id}`,
                    accountKey,
                    designId: design.design_id,
                  });
                  try {
                    await store.updateIfCurrent(
                      record.intentId,
                      record.updatedAt,
                      { serverOrderId: 'stale-order' },
                      record.revision || 1,
                    );
                    return { staleAccepted: true };
                  } catch (error) {
                    return { staleAccepted: false, code: error.code };
                  }
                }
                """,
                {"accountKey": account_key, "design": design, "record": stale_record},
            )
            assert stale_result["staleAccepted"] is False, stale_result
            assert stale_result["code"] == "STALE_CHECKOUT_INTENT", stale_result
            assert newer_result["associated"] == "newer-order"

            separate = await page.evaluate(
                """
                async ({ accountKey, design, payload }) => {
                  const module = await import('/checkout/checkout-intent.js');
                  const store = module.createCheckoutIntentStore({
                    storageKey: `checkout:${accountKey}:${design.design_id}`,
                    accountKey,
                    designId: design.design_id,
                  });
                  return store.prepare(payload, design, { forceNew: true });
                }
                """,
                {"accountKey": account_key, "design": design, "payload": payload},
            )
            assert separate["key"] != tab_a["key"], "explicit new intent reused key"
            await page.evaluate(
                """
                async ({ accountKey, design, intentId }) => {
                  const module = await import('/checkout/checkout-intent.js');
                  const store = module.createCheckoutIntentStore({
                    storageKey: `checkout:${accountKey}:${design.design_id}`,
                    accountKey,
                    designId: design.design_id,
                  });
                  await store.archive(intentId);
                }
                """,
                {
                    "accountKey": account_key,
                    "design": design,
                    "intentId": separate["intentId"],
                },
            )

            upload_checks = await page.evaluate(
                """
                async ({ designId }) => {
                  const request = async (body) => {
                    const me = await fetch('/api/v1/customers/me');
                    const meBody = await me.json();
                    const response = await fetch('/api/v1/assets/upload-url', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': meBody.csrf_token || '',
                      },
                      body: JSON.stringify(body),
                    });
                    return { status: response.status, body: await response.json() };
                  };
                  return {
                    oversized: await request({
                      design_id: designId,
                      media_type: 'image/png',
                      size: 4 * 1024 * 1024 + 1,
                    }),
                    validSizeProcessorUnavailable: await request({
                      design_id: designId,
                      media_type: 'image/png',
                      size: 1024,
                    }),
                    missingSize: await request({
                      design_id: designId,
                      media_type: 'image/png',
                    }),
                  };
                }
                """,
                {"designId": design_id},
            )
            assert upload_checks["oversized"]["status"] == 413, upload_checks
            assert upload_checks["validSizeProcessorUnavailable"]["status"] == 503, upload_checks
            assert upload_checks["missingSize"]["status"] in (400, 413), upload_checks

            await page.goto(origin + "/checkout/?design_id=" + design_id, wait_until="networkidle")
            await page.wait_for_selector("#checkout-panel:not([hidden])")
            await page.check("#terms-confirm")
            await page.wait_for_selector("#submit-order:not([disabled])")

            async def lost_response_handler(route):
                if route.request.method == "POST":
                    await route.fetch()
                    await route.fulfill(status=503, body="response lost")
                else:
                    await route.continue_()

            await page.route("**/api/v1/orders", lost_response_handler)
            await page.click("#submit-order")
            await page.wait_for_timeout(1500)
            await page.unroute("**/api/v1/orders")
            submission_ui = await page.evaluate(
                """
                async () => ({
                  notice: document.querySelector('#notice')?.textContent,
                  url: location.href,
                  checkoutHidden: document.querySelector('#checkout-panel')?.hidden,
                  orderHidden: document.querySelector('#order-panel')?.hidden,
                })
                """
            )

            pre_recovery = await page.evaluate(
                """
                async () => {
                  const response = await fetch('/api/v1/orders');
                  return { status: response.status, body: await response.json() };
                }
                """
            )
            assert pre_recovery["status"] == 200
            matching_before_recovery = [
                order for order in pre_recovery["body"]["orders"]
                if order["design_id"] == design_id
            ]
            assert len(matching_before_recovery) >= 1, {
                "worker": "did not commit order",
                "response": pre_recovery,
                "submission_ui": submission_ui,
            }
            original_order_id = matching_before_recovery[0]["order_id"]

            immediate_counts = await asyncio.to_thread(
                get_json,
                control_origin + "/db-counts?design_id=" + urllib.request.quote(design_id)
                + "&order_id=" + urllib.request.quote(original_order_id)
                + "&customer_email=" + urllib.request.quote("orders-2-10-admin@example.test", safe=""),
            )
            assert immediate_counts["matchingOrder"] == 1, immediate_counts
            assert immediate_counts["paymentsForOrder"] == 1, immediate_counts

            newer_orders = await page.evaluate(
                """
                async ({ designId }) => {
                  const me = await fetch('/api/v1/customers/me');
                  const meBody = await me.json();
                  const results = [];
                  for (let index = 0; index < 51; index++) {
                    const response = await fetch('/api/v1/orders', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': meBody.csrf_token || '',
                        'Idempotency-Key': `pagination-newer-${crypto.randomUUID()}`,
                      },
                      body: JSON.stringify({
                        design_id: designId,
                        duration_type: 'monthly',
                        hosting_months: 1,
                        asset_consents: [],
                      }),
                    });
                    results.push(response.status);
                    if (response.status !== 201) return results;
                  }
                  return results;
                }
                """,
                {"designId": design_id},
            )
            assert len(newer_orders) == 51
            assert all(status == 201 for status in newer_orders), newer_orders

            await page.evaluate(
                """
                async () => {
                  await new Promise((resolve, reject) => {
                    const request = indexedDB.deleteDatabase('crushify-checkout-intents');
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                    request.onblocked = () => reject(new Error('IndexedDB deletion blocked'));
                  });
                }
                """
            )

            await browser.close()
            browser = await playwright.chromium.launch_persistent_context(
                profile.name,
                headless=True,
            )
            reopened = await browser.new_page()
            await reopened.goto(origin + "/checkout/?design_id=" + design_id, wait_until="networkidle")
            await reopened.wait_for_selector("#recovery-panel:not([hidden])")
            target_button = reopened.locator(
                f'#recovery-options button[data-order-id="{original_order_id}"]'
            )
            await target_button.wait_for(state="visible")
            await target_button.click()
            await reopened.wait_for_url("**/checkout/*order_id=*")
            recovered_order_id = urllib.parse.parse_qs(
                urllib.parse.urlparse(reopened.url).query,
            ).get("order_id", [])
            assert recovered_order_id == [original_order_id]
            await reopened.wait_for_selector("#order-panel:not([hidden])")

            await logout(reopened)

            account_b_email = "orders-2-10-browser-b@example.test"
            await login_as(reopened, control_origin, origin, account_b_email)
            account_b_orders = await reopened.evaluate(
                """
                async () => {
                  const response = await fetch('/api/v1/orders');
                  return { status: response.status, body: await response.json() };
                }
                """
            )
            assert account_b_orders["status"] == 200
            assert not any(order["order_id"] == original_order_id
                           for order in account_b_orders["body"]["orders"]), "customer B saw customer A order"

            detail_as_b = await reopened.evaluate(
                """
                async ({ orderId }) => {
                  const response = await fetch('/api/v1/orders/' + orderId + '/status');
                  return { status: response.status };
                }
                """,
                {"orderId": original_order_id},
            )
            assert detail_as_b["status"] == 404

            await logout(reopened)
            await login_as(reopened, control_origin, origin, "orders-2-10-admin@example.test")
            account_a_orders = await reopened.evaluate(
                """
                async ({ orderId }) => {
                  const response = await fetch('/api/v1/orders/' + orderId + '/status');
                  return { status: response.status, body: await response.json() };
                }
                """,
                {"orderId": original_order_id},
            )
            assert account_a_orders["status"] == 200

            db_counts = await asyncio.to_thread(
                get_json,
                control_origin + "/db-counts?design_id=" + urllib.request.quote(design_id)
                + "&order_id=" + urllib.request.quote(original_order_id)
                + "&customer_email=" + urllib.request.quote("orders-2-10-admin@example.test", safe=""),
            )
            assert db_counts["ordersForDesign"] == 52, db_counts
            assert db_counts["matchingOrder"] == 1, db_counts
            assert db_counts["paymentsForOrder"] == 1, db_counts

            await browser.close()

        print(json.dumps({
            "actual_browser": "chromium persistent context",
            "real_ui_lost_response_recovery": True,
            "concurrent_web_locks": True,
            "explicit_new_intent": True,
            "real_account_switch": True,
            "orders_for_design": db_counts["ordersForDesign"],
            "payments_for_order": db_counts["paymentsForOrder"],
            "original_order_id": original_order_id,
        }))
    finally:
        try:
            urllib.request.urlopen(
                urllib.request.Request(control_origin + "/cleanup", data=b"", method="POST"),
                timeout=5,
            )
        except Exception:
            pass
        stop_fixture(fixture)
        profile.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
