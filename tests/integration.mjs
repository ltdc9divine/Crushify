import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { runDatabaseContract } from "./database-contract.mjs";
import { runPaymentContract } from "./payment-contract.mjs";
import { createLocalEmailSink } from "./local-email-sink.mjs";

const root = await realpath(process.cwd());
const systemTempRoot = await realpath(tmpdir());
function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
if (isWithin(root, systemTempRoot) || isWithin(systemTempRoot, root)) {
  throw new Error("System temporary directory must be separate from the repository");
}
const createdPersistDirectory = await mkdtemp(join(systemTempRoot, "crushify-d1-contract-"));
const persistDirectory = await realpath(createdPersistDirectory);
const emptyEnvFile = join(persistDirectory, "integration.env");
await writeFile(emptyEnvFile, "", { flag: "wx" });
function assertDisposablePersistenceDirectory() {
  if (!isWithin(systemTempRoot, persistDirectory) ||
      isWithin(root, persistDirectory) ||
      isWithin(persistDirectory, root) ||
      !basename(persistDirectory).startsWith("crushify-d1-contract-")) {
    throw new Error("Refusing to run integration tests without an isolated temporary D1 directory");
  }
}
assertDisposablePersistenceDirectory();
async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Could not reserve a local integration port");
  }
  const availablePort = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return availablePort;
}
const localD1Flags = () => {
  assertDisposablePersistenceDirectory();
  return ["--local", "--persist-to", persistDirectory];
};
const port = await findAvailablePort();
const origin = `http://127.0.0.1:${port}`;
const webhookSecret = randomBytes(32).toString("hex");
const receivingAccount = "0000000000";
const emailSink = await createLocalEmailSink();
const workerEnvironmentNames = new Set([
  "APPDATA",
  "CI",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
]);
const workerProcessEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => workerEnvironmentNames.has(name.toUpperCase())),
);
let child;
let logs = "";
let localWorkerAvailable = false;
let spawnError;
const capture = (chunk) => {
  logs += chunk.toString();
  if (logs.length > 64 * 1024) logs = logs.slice(-64 * 1024);
};

function startWorker(
  adminEmails = "  PHASE2-ADMIN@EXAMPLE.TEST  ",
  paymentMode = "sepay-test",
) {
  localWorkerAvailable = false;
  spawnError = undefined;
  logs = "";
  const args = [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "tests/integration-worker.mjs",
    ...localD1Flags(),
    "--env-file",
    emptyEnvFile,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--local-protocol",
    "http",
    "--var",
    "ENVIRONMENT:local",
    "--var",
    "LOCAL_TEST_MODE:true",
    "--var",
    `LOCAL_TEST_MAIL_SINK_URL:${emailSink.url}`,
    "--var",
    "LOCAL_TEST_CATALOG_OVERRIDE:true",
  ];
  if (adminEmails !== null) args.push("--var", `ADMIN_EMAILS:${adminEmails}`);
  if (paymentMode === "manual-bank-transfer") {
    args.push(
      "--var",
      "PAYMENT_MODE:manual-bank-transfer",
      "--var",
      "MANUAL_BANK_CODE:MB",
      "--var",
      `MANUAL_BANK_ACCOUNT:${receivingAccount}`,
      "--var",
      "MANUAL_ACCOUNT_NAME:Crushify Test",
    );
  } else {
    args.push(
      "--var",
      "PAYMENT_MODE:sepay-test",
      "--var",
      `SEPAY_WEBHOOK_SECRET:${webhookSecret}`,
      "--var",
      "SEPAY_BANK_CODE:MB",
      "--var",
      `SEPAY_BANK_ACCOUNT:${receivingAccount}`,
      "--var",
      "SEPAY_ACCOUNT_NAME:Crushify Test",
    );
  }
  child = spawn(
    process.execPath,
    args,
    {
      cwd: root,
      env: workerProcessEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    spawnError = error;
    capture(Buffer.from(`Worker process error: ${error.message}`));
  });
}

function sanitizedLogs() {
  return logs
    .split(webhookSecret).join("[redacted]")
    .split(emailSink.url).join("[local email sink]")
    .replace(/magic_token=[A-Za-z0-9_-]+/g, "magic_token=[redacted]");
}

function executeLocalD1(sql, action = "run") {
  assertDisposablePersistenceDirectory();
  if (child && child.exitCode === null && !localWorkerAvailable) {
    throw new Error("Refusing to execute local D1 SQL while the Worker is starting");
  }
  if (localWorkerAvailable) {
    return execFileSync(process.execPath, [
      "tests/integration-sql.mjs",
      origin,
      action,
      sql,
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  return execFileSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "crushify-local",
    ...localD1Flags(),
    "--command",
    sql,
    "--json",
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function queryLocalD1(sql) {
  const result = JSON.parse(executeLocalD1(sql, "query"));
  return result[0]?.results || [];
}

function assertD1Failure(sql, pattern) {
  try {
    executeLocalD1(sql);
  } catch (error) {
    const output = error instanceof Error && "stdout" in error && "stderr" in error
      ? `${String(error.stdout)}\n${String(error.stderr)}\n${error.message}`
      : String(error);
    assert.match(output, pattern);
    return;
  }
  assert.fail("Expected local D1 command to fail");
}

async function stopWorker() {
  if (!child) return;
  const worker = child;
  child = null;
  localWorkerAvailable = false;
  if (worker.exitCode === null && worker.signalCode === null) {
    worker.kill();
    await new Promise((resolveExit) => worker.once("exit", resolveExit));
  }
}

async function waitReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Could not start Wrangler.\n${sanitizedLogs()}`);
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Wrangler exited before becoming healthy.\n${sanitizedLogs()}`);
    }
    let response;
    try {
      response = await fetch(`${origin}/api/v1/health/live`, {
        signal: AbortSignal.timeout(1_000),
      });
    } catch {
      // Wrangler may still be binding its local listener.
    }
    if (response?.status === 200) {
      if (/Using secrets defined in .*\.dev\.vars/i.test(logs)) {
        throw new Error("Wrangler loaded the repository's developer vars during integration");
      }
      localWorkerAvailable = true;
      return;
    }
    await delay(250);
  }
  throw new Error(`Wrangler did not become healthy within 60 seconds.\n${sanitizedLogs()}`);
}

async function waitForMagicToken(after) {
  return emailSink.waitForMagicToken(after);
}

function makeRequest(session, options = {}) {
  const headers = new Headers(options.headers || {});
  if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
  if (options.mutating) {
    headers.set("Origin", origin);
    if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
  }
  return { ...options, headers };
}

async function json(path, session, options = {}) {
  const request = makeRequest(session, options);
  request.headers.set("Connection", "close");
  const response = await fetch(origin + "/api/v1" + path, request);
  const body = response.status === 204 ||
    !response.headers.get("content-type")?.includes("application/json")
    ? null
    : await response.json();
  return { response, body };
}

async function integrationFulfillmentAction(action, orderId) {
  const response = await fetch(origin + "/api/__integration/fulfillment", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ action, order_id: orderId }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `integration fulfillment action ${action}`);
  return body;
}

async function integrationSePayScan(input) {
  const response = await fetch(origin + "/api/__integration/sepay-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(input),
  });
  return { response, body: await response.json() };
}

async function integrationSePayLeaseContract() {
  const response = await fetch(origin + "/api/__integration/sepay-lease-contract", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: "{}",
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  for (const [name, passed] of Object.entries(body)) {
    assert.equal(passed, true, `SePay D1 lease contract: ${name}`);
  }
}

async function runSePayD1ReconciliationContract() {
  const scanKey = "local-contract-sepay-api-v2";
  const bankAccountId = "f9e8d7c6-b5a4-3210-fedc-ba0987654321";
  const transactions = [
    {
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      bank_account_id: bankAccountId,
      transaction_date: "2026-01-01T10:00:00+07:00",
      transfer_type: "in",
      amount_in: 50_000,
      amount_out: 0,
      reference_number: "FT26069ABC",
      code: "CRPLOCAL000000000001",
      webhook_success: 1,
    },
    {
      id: "b2c3d4e5-f678-4123-8123-456789abcdef",
      bank_account_id: bankAccountId,
      transaction_date: "2026-01-01T10:01:00+07:00",
      transfer_type: "in",
      amount_in: 50_000,
      amount_out: 0,
      reference_number: "FT26069DEF",
      code: "CRPLOCAL000000000002",
      webhook_success: null,
    },
  ];
  const input = {
    scan_key: scanKey,
    bank_account_id: bankAccountId,
    transactions,
    per_page: 1,
  };
  const failed = await integrationSePayScan({ ...input, fail_page: 2 });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error, "HTTP_ERROR");
  assert.deepEqual(queryLocalD1(
    `SELECT window_end, scan_completed_at, lease_token,
            pending_window_start, pending_window_end, pending_next_page,
            pending_complete
       FROM sepay_api_reconciliation_cursors
      WHERE scan_key = ${sqlText(scanKey)} AND scan_mode = 'DATE_WINDOW'`,
  )[0], {
    window_end: null,
    scan_completed_at: null,
    lease_token: null,
    pending_window_start: "2026-01-01T00:00:00.000Z",
    pending_window_end: "2026-01-02T00:00:00.000Z",
    pending_next_page: 2,
    pending_complete: 0,
  });
  assert.equal(Number(queryLocalD1(
    `SELECT COUNT(*) AS count FROM sepay_api_observations`,
  )[0]?.count), 1, "the fetched page is safely persisted without advancing the cursor");

  const completed = await integrationSePayScan(input);
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.status, "completed");
  assert.equal(completed.body.pages, 1);
  assert.equal(completed.body.observations, 1);
  assert.equal(completed.body.lastTransactionId, transactions[1].id);
  const repeated = await integrationSePayScan(input);
  assert.equal(repeated.response.status, 200);
  assert.equal(Number(queryLocalD1(
    "SELECT COUNT(*) AS count FROM sepay_api_observations",
  )[0]?.count), 2, "repeated API observations are idempotent");
  assert.equal(Number(queryLocalD1(
    "SELECT COUNT(*) AS count FROM payment_settlement_evidence WHERE evidence_source = 'SEPAY_API_V2'",
  )[0]?.count), 0, "API observations do not create settlement evidence");
  const cursor = queryLocalD1(
    `SELECT window_end, scan_completed_at, lease_token
       FROM sepay_api_reconciliation_cursors
      WHERE scan_key = ${sqlText(scanKey)} AND scan_mode = 'DATE_WINDOW'`,
  )[0];
  assert.equal(cursor.window_end, "2026-01-02T00:00:00.000Z");
  assert.equal(cursor.lease_token, null);

  const denseScanKey = "local-contract-sepay-api-v2-over-400";
  const denseTransactions = Array.from({ length: 401 }, (_, index) => ({
    ...transactions[0],
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    transaction_date: new Date(Date.parse("2026-01-01T10:00:00.000Z") + index * 1000)
      .toISOString(),
  }));
  const denseInput = {
    scan_key: denseScanKey,
    bank_account_id: bankAccountId,
    transactions: denseTransactions,
    per_page: 100,
    max_pages: 4,
  };
  const partial = await integrationSePayScan(denseInput);
  assert.equal(partial.response.status, 206);
  assert.equal(partial.body.status, "partial");
  assert.equal(partial.body.pages, 4);
  assert.equal(partial.body.observations, 400);
  assert.equal(partial.body.continuationPage, 5);
  assert.equal(partial.body.remainingPages, 1);
  const partialCursor = queryLocalD1(
    `SELECT window_end, pending_next_page, pending_last_page,
            pending_total_records, pending_complete, lease_token
       FROM sepay_api_reconciliation_cursors
      WHERE scan_key = ${sqlText(denseScanKey)} AND scan_mode = 'DATE_WINDOW'`,
  )[0];
  assert.deepEqual(partialCursor, {
    window_end: null,
    pending_next_page: 5,
    pending_last_page: 5,
    pending_total_records: 401,
    pending_complete: 0,
    lease_token: null,
  });
  const continued = await integrationSePayScan(denseInput);
  assert.equal(continued.response.status, 200);
  assert.equal(continued.body.status, "completed");
  assert.equal(continued.body.pages, 1);
  assert.equal(continued.body.observations, 1);
  assert.equal(Number(queryLocalD1(
    `SELECT COUNT(*) AS count FROM sepay_api_observations
      WHERE transaction_uuid BETWEEN
        '00000000-0000-4000-8000-000000000000' AND
        '00000000-0000-4000-8000-000000000190'`,
  )[0]?.count), 401, "the 400-record run resumes at page 5 without losing records");
  const denseCursor = queryLocalD1(
    `SELECT window_end, pending_window_start, pending_next_page, pending_complete
       FROM sepay_api_reconciliation_cursors
      WHERE scan_key = ${sqlText(denseScanKey)} AND scan_mode = 'DATE_WINDOW'`,
  )[0];
  assert.equal(denseCursor.window_end, "2026-01-02T00:00:00.000Z");
  assert.equal(denseCursor.pending_window_start, null);
  assert.equal(denseCursor.pending_next_page, 1);
  assert.equal(denseCursor.pending_complete, 0);

  const atomicScanKey = "local-contract-sepay-api-v2-page-rollback";
  const atomicTransactions = [
    {
      ...transactions[0],
      id: "c1111111-1111-4111-8111-111111111111",
    },
    {
      ...transactions[1],
      id: "d2222222-2222-4222-8222-222222222222",
    },
  ];
  const atomicInput = {
    scan_key: atomicScanKey,
    bank_account_id: bankAccountId,
    transactions: atomicTransactions,
    per_page: 2,
  };
  executeLocalD1(
    "CREATE TRIGGER d1_sepay_reject_observation BEFORE INSERT ON sepay_api_observations " +
    "WHEN NEW.transaction_uuid = 'd2222222-2222-4222-8222-222222222222' " +
    "BEGIN SELECT RAISE(ABORT, 'forced reconciliation page failure'); END",
  );
  try {
    const failedPagePersistence = await integrationSePayScan(atomicInput);
    assert.equal(failedPagePersistence.response.status, 500);
    assert.equal(failedPagePersistence.body.error, "INTEGRATION_SCAN_FAILED");
    assert.equal(Number(queryLocalD1(
      `SELECT COUNT(*) AS count FROM sepay_api_observations
        WHERE transaction_uuid IN (
          'c1111111-1111-4111-8111-111111111111',
          'd2222222-2222-4222-8222-222222222222'
        )`,
    )[0]?.count), 0, "failed page batches do not leave partial observation rows");
    const atomicCursor = queryLocalD1(
      `SELECT pending_next_page, pending_complete
         FROM sepay_api_reconciliation_cursors
        WHERE scan_key = ${sqlText(atomicScanKey)} AND scan_mode = 'DATE_WINDOW'`,
    )[0];
    assert.deepEqual(atomicCursor, {
      pending_next_page: 1,
      pending_complete: 0,
    }, "failed persistence does not advance the continuation pointer");
  } finally {
    executeLocalD1("DROP TRIGGER d1_sepay_reject_observation");
  }
  const recoveredPage = await integrationSePayScan(atomicInput);
  assert.equal(recoveredPage.response.status, 200);
  assert.equal(recoveredPage.body.status, "completed");
  assert.equal(Number(queryLocalD1(
    `SELECT COUNT(*) AS count FROM sepay_api_observations
      WHERE transaction_uuid IN (
        'c1111111-1111-4111-8111-111111111111',
        'd2222222-2222-4222-8222-222222222222'
      )`,
  )[0]?.count), 2);
  await integrationSePayLeaseContract();
}

async function paymentContractRequest(path, session, options = {}) {
  const { json: jsonBody, token, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});
  if (jsonBody !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return json(path, session, {
    ...requestOptions,
    headers,
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });
}

async function signIn(email, verificationIp) {
  const start = emailSink.current();
  const requested = await json("/customers/session", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(requested.response.status, 202);
  assert.doesNotMatch(logs, /magic_token=/, "magic links must not appear in Wrangler logs");
  const token = await waitForMagicToken(start);
  const magicLinkMessage = emailSink.messages[start];
  assert.match(magicLinkMessage.text, /#magic_token=/);
  assert.doesNotMatch(magicLinkMessage.text, /\?magic_token=/);
  const verified = await json("/customers/session/verify", null, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(verificationIp ? { "CF-Connecting-IP": verificationIp } : {}),
    },
    body: JSON.stringify({ token }),
  });
  assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
  const setCookies = verified.response.headers.getSetCookie();
  const cookies = setCookies.map((value) => value.split(";", 1)[0]);
  const csrf = cookies.find((value) => value.startsWith("crushify_csrf="))?.split("=", 2)[1];
  const sessionCookie = setCookies.find((value) => value.startsWith("crushify_session="));
  const csrfCookie = setCookies.find((value) => value.startsWith("crushify_csrf="));
  assert.ok(sessionCookie, `${email}: session cookie`);
  assert.ok(csrfCookie, `${email}: CSRF cookie`);
  const sessionAttributes = sessionCookie.slice(sessionCookie.indexOf(";") + 1);
  const csrfAttributes = csrfCookie.slice(csrfCookie.indexOf(";") + 1);
  assert.ok(/(?:^|;)\s*HttpOnly(?:;|$)/i.test(sessionAttributes), "local session cookie is HttpOnly");
  assert.ok(/(?:^|;)\s*SameSite=Lax(?:;|$)/i.test(sessionAttributes), "local session cookie uses SameSite=Lax");
  assert.ok(/(?:^|;)\s*Path=\/api\/v1(?:;|$)/i.test(sessionAttributes), "local session cookie has a narrow API path");
  assert.ok(/(?:^|;)\s*Max-Age=1209600(?:;|$)/i.test(sessionAttributes), "local session cookie has a 14-day lifetime");
  assert.ok(!/(?:^|;)\s*Secure(?:;|$)/i.test(sessionAttributes), "local HTTP session cookie omits Secure");
  assert.ok(!/(?:^|;)\s*Domain=|(?:^|;)\s*Expires=/i.test(sessionAttributes), "local session cookie has no Domain or Expires attribute");
  assert.ok(!/(?:^|;)\s*HttpOnly(?:;|$)/i.test(csrfAttributes), "CSRF cookie is readable by the client");
  assert.ok(/(?:^|;)\s*SameSite=Lax(?:;|$)/i.test(csrfAttributes), "local CSRF cookie uses SameSite=Lax");
  assert.ok(/(?:^|;)\s*Path=\/api\/v1(?:;|$)/i.test(csrfAttributes), "local CSRF cookie has a narrow API path");
  assert.ok(/(?:^|;)\s*Max-Age=1209600(?:;|$)/i.test(csrfAttributes), "local CSRF cookie has a 14-day lifetime");
  assert.ok(!/(?:^|;)\s*Secure(?:;|$)/i.test(csrfAttributes), "local HTTP CSRF cookie omits Secure");
  assert.ok(!/(?:^|;)\s*Domain=|(?:^|;)\s*Expires=/i.test(csrfAttributes), "local CSRF cookie has no Domain or Expires attribute");
  assert.ok(csrf);
  const session = { cookies, csrf };
  const me = await json("/customers/me", session);
  assert.equal(me.response.status, 200);
  return session;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function seedPaidOrder(email, designId, revision) {
  const customer = queryLocalD1(
    `SELECT id FROM customers WHERE email_normalized = ${sqlText(email)}`,
  )[0];
  assert.ok(customer?.id);
  const designSnapshot = queryLocalD1(
    `SELECT d.template_id, d.schema_version, revision.data_json
       FROM designs d
       JOIN design_revisions revision ON revision.design_id = d.id AND revision.revision = ${revision}
      WHERE d.id = ${sqlText(designId)}`,
  )[0];
  assert.ok(designSnapshot?.data_json);
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const orderItemId = crypto.randomUUID();
  const storageItemId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const webhookId = crypto.randomUUID();
  const transactionId = `phase6-${randomBytes(12).toString("hex")}`;
  const orderReference = `CRF${randomBytes(8).toString("hex").toUpperCase()}`;
  const paymentReference = `CRP${randomBytes(8).toString("hex").toUpperCase()}`;
  const statements = [
    `INSERT INTO orders (
       id, customer_id, order_type, status, currency, subtotal_minor, discount_minor, total_minor,
       design_id, idempotency_key, created_at, updated_at, paid_at, expires_at, order_reference,
       design_revision, request_hash, payment_review_required
     ) VALUES (
       ${sqlText(orderId)}, ${sqlText(customer.id)}, 'SELF_SERVICE', 'PAID', 'VND', 50000, 0, 50000,
       ${sqlText(designId)}, ${sqlText(`phase6-${orderId}`)}, ${sqlText(now)}, ${sqlText(now)},
       ${sqlText(now)}, NULL, ${sqlText(orderReference)}, ${revision}, ${sqlText("a".repeat(64))}, 0
     )`,
    `INSERT INTO order_items (
       id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
       line_total_minor, metadata_json, created_at
     ) VALUES (
       ${sqlText(orderItemId)}, ${sqlText(orderId)}, 'TEMPLATE_LICENSE', 'our-universe',
       'Our Universe', 1, 50000, 50000, '{"schema_version":1}', ${sqlText(now)}
     )`,
    `INSERT INTO order_items (
       id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
       line_total_minor, metadata_json, created_at
     ) VALUES (
       ${sqlText(storageItemId)}, ${sqlText(orderId)}, 'ADD_ON', '1-month',
       '1 tháng', 1, 0, 0,
       '{"kind":"STORAGE_PLAN","storage_plan_id":"1-month","title":"1 tháng","duration_months":1,"lifetime":false,"asset_consents":[]}',
       ${sqlText(now)}
     )`,
    `INSERT INTO order_design_snapshots (
       order_id, design_id, design_revision, template_id, schema_version,
       data_json, content_sha256, created_at
     ) VALUES (
       ${sqlText(orderId)}, ${sqlText(designId)}, ${revision},
       ${sqlText(designSnapshot.template_id)}, ${Number(designSnapshot.schema_version)},
       ${sqlText(designSnapshot.data_json)},
       ${sqlText(createHash("sha256").update(String(designSnapshot.data_json)).digest("hex"))},
       ${sqlText(now)}
     )`,
    `INSERT INTO order_asset_refs (order_id, asset_id, created_at)
     SELECT ${sqlText(orderId)}, asset_id, ${sqlText(now)}
       FROM design_asset_refs WHERE design_id = ${sqlText(designId)}
         AND revision = ${revision}`,
    `INSERT INTO payments (
       id, order_id, provider, provider_payment_id, status, amount_minor, currency, idempotency_key,
       created_at, updated_at, succeeded_at, payment_reference, review_required
     ) VALUES (
       ${sqlText(paymentId)}, ${sqlText(orderId)}, 'SEPAY', ${sqlText(transactionId)}, 'SUCCEEDED',
       50000, 'VND', ${sqlText(`phase6-payment-${paymentId}`)}, ${sqlText(now)}, ${sqlText(now)},
       ${sqlText(now)}, ${sqlText(paymentReference)}, 0
     )`,
    `INSERT INTO payment_webhook_events (
       id, provider, event_id, payload_hash, received_at, processed_at, outcome,
       raw_payload, provider_transaction_id, order_reference, expected_amount_minor, actual_amount_minor
     ) VALUES (
       ${sqlText(webhookId)}, 'SEPAY', ${sqlText(transactionId)}, ${sqlText("b".repeat(64))},
       ${sqlText(now)}, ${sqlText(now)}, 'PROCESSED', '{}', ${sqlText(transactionId)},
       ${sqlText(orderReference)}, 50000, 50000
     )`,
    `INSERT INTO payment_settlement_evidence (
       id, payment_id, provider, evidence_source, source_transaction_id,
       amount_minor, currency, verified_at, payload_hash, status, created_at
     ) VALUES (
       ${sqlText(randomBytes(16).toString("hex"))}, ${sqlText(paymentId)}, 'SEPAY',
       'SEPAY_WEBHOOK', ${sqlText(transactionId)}, 50000, 'VND', ${sqlText(now)},
       ${sqlText("b".repeat(64))}, 'VERIFIED', ${sqlText(now)}
     )`,
  ];
  for (const statement of statements) executeLocalD1(statement);
  return orderId;
}

function makePng() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const kind = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from([120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function uploadImage(session, designId, bytes, declaredType = "image/png") {
  const grant = await json("/assets/upload-url", session, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, media_type: declaredType, size: bytes.length }),
  });
  assert.equal(grant.response.status, 201);
  const uploaded = await fetch(origin + grant.body.upload_url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${grant.body.upload_token}`,
      "Content-Type": declaredType,
    },
    body: bytes,
  });
  return { grant: grant.body, uploaded };
}

try {
  assertDisposablePersistenceDirectory();
  execFileSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "crushify-local",
    ...localD1Flags(),
  ], { cwd: root, stdio: "ignore" });
  startWorker();
  await waitReady();
  const live = await json("/health/live", null);
  assert.equal(live.response.status, 200);
  await runSePayD1ReconciliationContract();

  const ownerEmail = "phase2-admin@example.test";
  const first = await signIn(ownerEmail);
  const csrfRequest = (csrfToken) => fetch(origin + "/api/v1/designs", {
    method: "POST",
    headers: {
      Cookie: first.cookies.join("; "),
      Origin: origin,
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal((await csrfRequest(null)).status, 403, "missing CSRF header is rejected");
  assert.equal((await csrfRequest("synthetic-mismatched-csrf-token")).status, 403,
    "mismatched CSRF header is rejected");

  const invalidReturnPaths = [
    "https://evil.example",
    "//evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:alert(1)",
    "file:///synthetic",
    "/%2f%2fevil.example",
    "/%252e%252e%252f",
  ];
  for (const [index, returnTo] of invalidReturnPaths.entries()) {
    const invalidReturn = await json("/customers/session", null, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `redirect-check-${index}-${crypto.randomUUID()}@example.test`,
        return_to: returnTo,
      }),
    });
    assert.equal(invalidReturn.response.status, 400, `unsafe return path ${index} is rejected`);
  }

  const expiredMagicStart = emailSink.current();
  const expiredMagicEmail = `expired-magic-${crypto.randomUUID()}@example.test`;
  const expiredMagicRequest = await json("/customers/session", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: expiredMagicEmail }),
  });
  assert.equal(expiredMagicRequest.response.status, 202);
  const expiredMagicToken = await waitForMagicToken(expiredMagicStart);
  const expiredMagicHash = createHash("sha256").update(expiredMagicToken).digest("hex");
  executeLocalD1(
    `UPDATE login_tokens SET expires_at = '2000-01-01T00:00:00.000Z' ` +
    `WHERE token_hash = ${sqlText(expiredMagicHash)}`,
  );
  const expiredMagicVerify = await json("/customers/session/verify", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: expiredMagicToken }),
  });
  assert.equal(expiredMagicVerify.response.status, 401, "expired magic link is rejected");

  const expiringSession = await signIn(`expired-session-${crypto.randomUUID()}@example.test`);
  const rawSessionCookie = expiringSession.cookies.find((value) =>
    value.startsWith("crushify_session="),
  );
  assert.ok(rawSessionCookie, "synthetic session cookie exists");
  const rawSession = rawSessionCookie.slice("crushify_session=".length);
  const sessionHash = createHash("sha256").update(rawSession).digest("hex");
  executeLocalD1(
    `UPDATE customer_sessions SET expires_at = '2000-01-01T00:00:00.000Z' ` +
    `WHERE token_hash = ${sqlText(sessionHash)}`,
  );
  assert.equal(
    (await json("/customers/me", expiringSession)).response.status,
    401,
    "expired session is rejected",
  );

  const unauthenticated = await json("/designs", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(unauthenticated.response.status, 401);

  const unsupported = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "not-a-template", schema_version: 1 }),
  });
  assert.equal(unsupported.response.status, 422);

  const created = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(created.response.status, 201);
  const designId = created.body.design_id;
  assert.equal(created.body.data.sender, "Minh");
  const paymentDesign = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(paymentDesign.response.status, 201);
  const paymentDesignData = structuredClone(paymentDesign.body.data);
  const syntheticHeadline = `ORDERS-2.7 synthetic ${crypto.randomUUID()}`;
  paymentDesignData.headline = syntheticHeadline;
  const savedPaymentDesign = await json(`/designs/${paymentDesign.body.design_id}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_version: paymentDesign.body.schema_version,
      expected_revision: paymentDesign.body.revision,
      data: paymentDesignData,
    }),
  });
  assert.equal(savedPaymentDesign.response.status, 200);
  assert.equal(savedPaymentDesign.body.revision, paymentDesign.body.revision + 1);
  const reloadedPaymentDesign = await json(`/designs/${paymentDesign.body.design_id}`, first);
  assert.equal(reloadedPaymentDesign.response.status, 200);
  assert.equal(reloadedPaymentDesign.body.data.headline, syntheticHeadline);
  const designPreview = await json(`/designs/${paymentDesign.body.design_id}/preview`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(designPreview.response.status, 201);
  const previewData = await paymentContractRequest("/previews", null, {
    token: designPreview.body.token,
  });
  assert.equal(previewData.response.status, 200);
  assert.equal(previewData.body.data.headline, syntheticHeadline);
  await runPaymentContract({
    request: paymentContractRequest,
    async seedPrice(amount) {
      for (const [templateId, schemaVersion] of [
        ["our-universe", 1],
        ["love-letter", 2],
        ["our-memories", 1],
        ["say-yes", 1],
        ["distance-means-nothing", 1],
      ]) {
        executeLocalD1(
          `INSERT INTO template_prices (
            id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
          ) VALUES (
            'payment-test-price-${templateId}', '${templateId}', ${schemaVersion}, 'VND', ${amount}, 1,
            '${new Date().toISOString()}', '${new Date().toISOString()}'
          )`,
        );
      }
      for (const [planId, priceId] of [
        ["1-month", "payment-test-storage-1"],
        ["3-months", "payment-test-storage-3"],
        ["6-months", "payment-test-storage-6"],
        ["12-months", "payment-test-storage-12"],
        ["lifetime", "payment-test-storage-life"],
      ]) {
        executeLocalD1(
          `INSERT INTO storage_plan_prices (
            id, storage_plan_id, currency, amount_minor, is_active, created_at, updated_at
          ) VALUES (
            '${priceId}', '${planId}', 'VND', 1000, 1,
            '${new Date().toISOString()}', '${new Date().toISOString()}'
          )`,
        );
      }
    },
    inspectOrderPricingSnapshot(orderId) {
      const readSnapshot = () => queryLocalD1(
        `SELECT item_type, unit_amount_minor, line_total_minor, metadata_json
         FROM order_items WHERE order_id = '${orderId}' ORDER BY item_type`,
      );
      const before = readSnapshot();
      const templateRow = queryLocalD1(
        "SELECT id, amount_minor FROM template_prices WHERE template_id = 'our-universe' AND is_active = 1",
      )[0];
      const storageRow = queryLocalD1(
        "SELECT id, amount_minor FROM storage_plan_prices WHERE storage_plan_id = '1-month' AND is_active = 1",
      )[0];
      assert.ok(templateRow?.id && storageRow?.id);
      try {
        executeLocalD1(`UPDATE template_prices SET amount_minor = ${templateRow.amount_minor + 1} WHERE id = '${templateRow.id}'`);
        executeLocalD1(`UPDATE storage_plan_prices SET amount_minor = ${storageRow.amount_minor + 1} WHERE id = '${storageRow.id}'`);
        assert.deepEqual(readSnapshot(), before, "saved order price snapshots do not change with catalog updates");
      } finally {
        executeLocalD1(`UPDATE template_prices SET amount_minor = ${templateRow.amount_minor} WHERE id = '${templateRow.id}'`);
        executeLocalD1(`UPDATE storage_plan_prices SET amount_minor = ${storageRow.amount_minor} WHERE id = '${storageRow.id}'`);
      }
    },
    tamperOrderPricingSnapshot(orderId) {
      const row = queryLocalD1(
        `SELECT metadata_json FROM order_items
         WHERE order_id = '${orderId}' AND item_type = 'ADD_ON'`,
      )[0];
      assert.ok(row?.metadata_json);
      const original = row.metadata_json;
      const metadata = JSON.parse(original);
      metadata.pricing_snapshot.total_minor += 1;
      executeLocalD1(
        `UPDATE order_items SET metadata_json = ${sqlText(JSON.stringify(metadata))}
         WHERE order_id = '${orderId}' AND item_type = 'ADD_ON'`,
      );
      return original;
    },
    restoreOrderPricingSnapshot(orderId, metadata) {
      executeLocalD1(
        `UPDATE order_items SET metadata_json = ${sqlText(metadata)}
         WHERE order_id = '${orderId}' AND item_type = 'ADD_ON'`,
      );
    },
    owner: first,
    otherOwner: await signIn(`phase2-payment-other-${crypto.randomUUID()}@example.test`),
    designId: paymentDesign.body.design_id,
    webhookSecret,
    receivingAccount,
    async cancelOrder(orderId) {
      executeLocalD1(
        `UPDATE orders SET status = 'CANCELLED' WHERE id = '${orderId}'`,
      );
      executeLocalD1(
        `UPDATE payments SET status = 'CANCELLED' WHERE order_id = '${orderId}' AND status = 'PENDING'`,
      );
    },
    expireOrder(orderId) {
      executeLocalD1(
        `UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${orderId}'`,
      );
    },
    inspectWebhookOutcomes(transactionIds) {
      const values = transactionIds.map((id) => `'${id}'`).join(", ");
      const rows = queryLocalD1(
        `SELECT outcome FROM payment_webhook_events
          WHERE provider = 'SEPAY' AND event_id IN (${values})`,
      );
      return rows.map((row) => row.outcome);
    },
    inspectWebhookEvent(transactionId) {
      const rows = queryLocalD1(
        `SELECT outcome, review_reason, processing_attempts, provider_transaction_id,
                order_reference, expected_amount_minor, actual_amount_minor
           FROM payment_webhook_events WHERE provider = 'SEPAY' AND event_id = '${transactionId}'`,
      );
      assert.equal(rows.length, 1);
      return rows[0];
    },
    inspectSettlementEvidence(transactionId) {
      return Number(queryLocalD1(
        `SELECT COUNT(*) AS count FROM payment_settlement_evidence
         WHERE provider = 'SEPAY' AND evidence_source = 'SEPAY_WEBHOOK'
           AND source_transaction_id = '${transactionId}'`,
      )[0]?.count ?? 0);
    },
    inspectSettlementEvidenceOwner(transactionId) {
      return queryLocalD1(
        `SELECT DISTINCT evidence.payment_id, payments.order_id
           FROM payment_settlement_evidence AS evidence
           JOIN payments ON payments.id = evidence.payment_id
          WHERE evidence.provider = 'SEPAY'
            AND evidence.source_transaction_id = ${sqlText(transactionId)}
          ORDER BY evidence.payment_id`,
      );
    },
    inspectEvidenceSources(orderId) {
      const evidence = { SEPAY_WEBHOOK: 0, SEPAY_API_V2: 0 };
      for (const row of queryLocalD1(
        `SELECT evidence_source, COUNT(*) AS count
         FROM payment_settlement_evidence
         WHERE payment_id = (SELECT id FROM payments WHERE order_id = ${sqlText(orderId)})
         GROUP BY evidence_source`,
      )) {
        evidence[row.evidence_source] = Number(row.count);
      }
      evidence.API_OBSERVATIONS = Number(queryLocalD1(
        `SELECT COUNT(*) AS count FROM sepay_api_observations
         WHERE payment_id = (SELECT id FROM payments WHERE order_id = ${sqlText(orderId)})`,
      )[0]?.count ?? 0);
      return evidence;
    },
    inspectSettlementState(orderId, transactionId) {
      return queryLocalD1(
        `SELECT o.status AS order_status, p.status AS payment_status,
                p.provider_payment_id, p.review_required, o.payment_review_required,
                (SELECT outcome FROM payment_webhook_events
                 WHERE provider = 'SEPAY' AND event_id = ${sqlText(transactionId)}) AS webhook_outcome,
                (SELECT COUNT(*) FROM payment_settlement_evidence
                 WHERE payment_id = p.id) AS evidence_count,
                (SELECT status FROM fulfillment_jobs
                 WHERE order_id = o.id) AS fulfillment_job_status,
                (SELECT COUNT(*) FROM fulfillment_jobs
                 WHERE order_id = o.id) AS fulfillment_job_count,
                (SELECT COUNT(*) FROM publications
                 WHERE order_id = o.id) AS publication_count
         FROM orders o JOIN payments p ON p.order_id = o.id
         WHERE o.id = ${sqlText(orderId)}`,
      )[0];
    },
    insertApiObservation(orderId, transactionId) {
      const now = new Date().toISOString();
      executeLocalD1(
        `INSERT INTO sepay_api_observations (
           transaction_uuid, bank_account_id, transaction_date, transfer_type,
           amount_in, amount_out, payload_hash, scan_type, status, reason_code,
           payment_id, first_observed_at, last_observed_at
         )
         SELECT '${crypto.randomUUID()}',
                'f9e8d7c6-b5a4-3210-fedc-ba0987654321', ${sqlText(now)}, 'in',
                amount_minor, 0, ${sqlText("c".repeat(64))}, 'DATE_WINDOW',
                'MANUAL_REVIEW', 'TEST_ONLY', id, ${sqlText(now)}, ${sqlText(now)}
         FROM payments WHERE order_id = ${sqlText(orderId)}`,
      );
    },
    seedRecoveryOrder(orderId, evidenceCase) {
      if (!["missing", "revoked", "mismatched", "api-only"].includes(evidenceCase)) {
        throw new Error("Unexpected synthetic recovery evidence case");
      }
      const now = new Date().toISOString();
      const transactionId = `d1-recovery-${evidenceCase}-${crypto.randomUUID()}`;
      const payloadHash = randomBytes(32).toString("hex");
      const providerPaymentId = evidenceCase === "api-only" ? "NULL" : sqlText(transactionId);
      executeLocalD1(
        `UPDATE payments SET status = 'SUCCEEDED', provider_payment_id = ${providerPaymentId},
           succeeded_at = ${sqlText(now)}, updated_at = ${sqlText(now)},
           review_required = 0
         WHERE order_id = ${sqlText(orderId)}`,
      );
      executeLocalD1(
        `UPDATE orders SET status = 'PAID', paid_at = ${sqlText(now)},
           updated_at = ${sqlText(now)}, payment_review_required = 0
         WHERE id = ${sqlText(orderId)}`,
      );
      if (evidenceCase === "revoked" || evidenceCase === "mismatched") {
        executeLocalD1(
          `INSERT INTO payment_webhook_events (
             id, provider, event_id, payload_hash, received_at, processed_at, outcome,
             raw_payload, provider_transaction_id, order_reference,
             expected_amount_minor, actual_amount_minor
           )
           SELECT '${crypto.randomUUID()}', 'SEPAY', ${sqlText(transactionId)},
                  ${sqlText(payloadHash)}, ${sqlText(now)}, ${sqlText(now)}, 'PROCESSED',
                  '{}', ${sqlText(transactionId)}, o.order_reference,
                  p.amount_minor, p.amount_minor
           FROM orders o JOIN payments p ON p.order_id = o.id
           WHERE o.id = ${sqlText(orderId)}`,
        );
        executeLocalD1(
          `INSERT INTO payment_settlement_evidence (
             id, payment_id, provider, evidence_source, source_transaction_id,
             amount_minor, currency, verified_at, payload_hash, status, created_at
           )
           SELECT '${crypto.randomUUID()}', id, 'SEPAY', 'SEPAY_WEBHOOK',
                  ${sqlText(transactionId)}, amount_minor, currency,
                  ${sqlText(now)}, ${sqlText(payloadHash)}, 'VERIFIED', ${sqlText(now)}
           FROM payments WHERE order_id = ${sqlText(orderId)}`,
        );
        if (evidenceCase === "revoked") {
          executeLocalD1(
            `UPDATE payment_settlement_evidence SET status = 'REVOKED'
             WHERE payment_id = (SELECT id FROM payments WHERE order_id = ${sqlText(orderId)})`,
          );
        } else {
          executeLocalD1(
            `UPDATE payment_settlement_evidence SET amount_minor = amount_minor + 1
             WHERE payment_id = (SELECT id FROM payments WHERE order_id = ${sqlText(orderId)})`,
          );
        }
      } else if (evidenceCase === "api-only") {
        executeLocalD1(
          `INSERT INTO sepay_api_observations (
             transaction_uuid, bank_account_id, transaction_date, transfer_type,
             amount_in, amount_out, payload_hash, scan_type, status, reason_code,
             payment_id, first_observed_at, last_observed_at
           )
           SELECT '${crypto.randomUUID()}',
                  'f9e8d7c6-b5a4-3210-fedc-ba0987654321', ${sqlText(now)}, 'in',
                  amount_minor, 0, ${sqlText(payloadHash)}, 'DATE_WINDOW',
                  'MANUAL_REVIEW', 'TEST_ONLY', id, ${sqlText(now)}, ${sqlText(now)}
           FROM payments WHERE order_id = ${sqlText(orderId)}`,
        );
      }
      executeLocalD1(
        `INSERT INTO fulfillment_jobs (id, order_id, status, created_at, updated_at)
         VALUES ('${crypto.randomUUID()}', ${sqlText(orderId)}, 'PENDING',
                 ${sqlText(now)}, ${sqlText(now)})`,
      );
      return transactionId;
    },
    setManualReviewFlags(orderId) {
      executeLocalD1(
        `UPDATE payments SET review_required = 1 WHERE order_id = ${sqlText(orderId)}`,
      );
      executeLocalD1(
        `UPDATE orders SET payment_review_required = 1 WHERE id = ${sqlText(orderId)}`,
      );
    },
    insertPendingFulfillmentJob(orderId) {
      const now = new Date().toISOString();
      executeLocalD1(
        `INSERT INTO fulfillment_jobs (id, order_id, status, created_at, updated_at)
         VALUES ('${crypto.randomUUID()}', ${sqlText(orderId)}, 'PENDING',
                 ${sqlText(now)}, ${sqlText(now)})`,
      );
    },
    callFulfillmentForOrder(orderId) {
      return integrationFulfillmentAction("fulfill", orderId);
    },
    recoverFulfillments() {
      return integrationFulfillmentAction("recover", null);
    },
    setPublicationExpiry(publicationId, expiresAt) {
      executeLocalD1(
        `UPDATE publications SET expires_at = '${expiresAt}' WHERE id = '${publicationId}'`,
      );
      executeLocalD1(
        `UPDATE storage_entitlements SET expires_at = '${expiresAt}', status = 'ACTIVE'
          WHERE publication_id = '${publicationId}' AND status IN ('ACTIVE','EXPIRED')`,
      );
    },
    setPublicationEntitlementStatus(publicationId, status) {
      if (!["ACTIVE", "REVOKED"].includes(status)) throw new Error("Unexpected synthetic entitlement status");
      executeLocalD1(
        `UPDATE storage_entitlements SET status = '${status}'
          WHERE id = (
            SELECT id FROM storage_entitlements WHERE publication_id = '${publicationId}'
            ORDER BY created_at DESC, id DESC LIMIT 1
          )`,
      );
    },
    countOrdersForDesign(designId) {
      const rows = queryLocalD1(
        `SELECT COUNT(*) AS count FROM orders WHERE design_id = '${designId}'`,
      );
      return Number(rows[0]?.count ?? 0);
    },
    deactivateTemplatePrice() {
      executeLocalD1(
        "UPDATE template_prices SET is_active = 0 WHERE template_id = 'our-universe' AND schema_version = 1",
      );
    },
    inspectEntitlement(orderId) {
      const rows = queryLocalD1(
        `SELECT activated_at, starts_at, previous_expires_at, expires_at, status, duration_months
          FROM storage_entitlements WHERE order_id = '${orderId}'`,
      );
      assert.equal(rows.length, 1);
      return rows[0];
    },
    inspectStoragePlan(planId) {
      const rows = queryLocalD1(
        `SELECT id, duration_months, is_lifetime, status
          FROM storage_plans WHERE id = '${planId}'`,
      );
      assert.equal(rows.length, 1);
      return rows[0];
    },
    failSettlementStep(step, orderId) {
      const definitions = {
        evidence: {
          name: "d1_reject_test_settlement_evidence",
          create: `BEFORE INSERT ON payment_settlement_evidence
                   WHEN NEW.payment_id = (
                     SELECT id FROM payments WHERE order_id = ${sqlText(orderId)}
                   )`,
        },
        payment: {
          name: "d1_reject_test_payment_status",
          create: `BEFORE UPDATE OF status ON payments
                   WHEN NEW.order_id = ${sqlText(orderId)} AND NEW.status = 'SUCCEEDED'`,
        },
        order: {
          name: "d1_reject_test_order_paid",
          create: `BEFORE UPDATE OF status ON orders
                   WHEN NEW.id = ${sqlText(orderId)} AND NEW.status = 'PAID'`,
        },
        "webhook-outcome": {
          name: "d1_reject_test_webhook_outcome",
          create: `BEFORE UPDATE OF outcome ON payment_webhook_events
                   WHEN NEW.outcome = 'PROCESSED' AND NEW.order_reference = (
                     SELECT order_reference FROM orders WHERE id = ${sqlText(orderId)}
                   )`,
        },
        "fulfillment-job": {
          name: "d1_reject_test_fulfillment_job",
          create: `BEFORE INSERT ON fulfillment_jobs
                   WHEN NEW.order_id = ${sqlText(orderId)}`,
        },
      };
      const definition = definitions[step];
      if (!definition) throw new Error("Unexpected settlement failure injection step");
      executeLocalD1(
        `CREATE TRIGGER ${definition.name} ${definition.create}
         BEGIN SELECT RAISE(ABORT, 'forced settlement transaction failure'); END`,
      );
    },
    restoreSettlementStep(step) {
      const names = {
        evidence: "d1_reject_test_settlement_evidence",
        payment: "d1_reject_test_payment_status",
        order: "d1_reject_test_order_paid",
        "webhook-outcome": "d1_reject_test_webhook_outcome",
        "fulfillment-job": "d1_reject_test_fulfillment_job",
      };
      const name = names[step];
      if (!name) throw new Error("Unexpected settlement failure injection step");
      executeLocalD1(`DROP TRIGGER ${name}`);
    },
    expectedMode: "sepay-test",
    testStandardPricing: true,
    allTemplates: true,
    label: "Cloudflare Worker + local D1/R2",
  });

  const oversized = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(70_000) }),
  });
  assert.equal(oversized.response.status, 413);

  const invalid = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      expected_revision: 1,
      data: { ...created.body.data, startDate: "2024-99-99" },
    }),
  });
  assert.equal(invalid.response.status, 422);

  const changed = {
    ...created.body.data,
    sender: "An",
    receiver: "Bình",
    headline: "Bầu trời của đôi mình",
    mainMessage: "Tin nhắn được lưu trên D1",
    startDate: "2025-03-08",
    theme: "blue-aurora",
  };
  const updated = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 1, data: changed }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.revision, 2);

  const conflict = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 1, data: changed }),
  });
  assert.equal(conflict.response.status, 409);

  const reloaded = await json(`/designs/${designId}`, first);
  assert.equal(reloaded.response.status, 200);
  assert.equal(reloaded.body.data.receiver, "Bình");
  assert.equal(reloaded.body.data.mainMessage, "Tin nhắn được lưu trên D1");
  assert.equal(reloaded.body.data.startDate, "2025-03-08");
  assert.equal(reloaded.body.data.theme, "blue-aurora");

  const secondEmail = `phase2-${crypto.randomUUID()}@example.test`;
  const second = await signIn(secondEmail);
  const customPage = await fetch(origin + "/custom-design/");
  assert.equal(customPage.status, 200);
  assert.match(await customPage.text(), /Yêu cầu của bạn/);
  assert.equal((await fetch(origin + "/custom-design/custom-design.js")).status, 200);
  assert.equal((await fetch(origin + "/custom-design/custom-design.css")).status, 200);

  const unauthenticatedCustomList = await json("/custom-design/requests", null);
  assert.equal(unauthenticatedCustomList.response.status, 401);
  const customRequestKey = `custom-${crypto.randomUUID()}`;
  const customRequestInput = {
    preferred_template: "custom",
    brief: "Một trang kể chuyện tương tác cho ngày kỷ niệm.",
    requirements: "Tối ưu cho điện thoại; không cần thanh toán trong yêu cầu.",
    requested_delivery_date: "2027-02-14",
    reference_urls: ["https://example.test/idea"],
    assets_rights_confirmed: true,
  };
  const customRequest = await json("/custom-design/requests", first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": customRequestKey,
    },
    body: JSON.stringify(customRequestInput),
  });
  assert.equal(customRequest.response.status, 201, JSON.stringify(customRequest.body));
  assert.equal(customRequest.body.status, "QUOTE_PENDING");
  assert.equal(customRequest.body.communication_status, "AWAITING_REVIEW");
  assert.equal(customRequest.body.customer_message, null);
  assert.deepEqual(customRequest.body.reference_urls, customRequestInput.reference_urls);

  const adminPage = await fetch(origin + "/admin/");
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /Quản trị vận hành/);
  assert.equal((await fetch(origin + "/admin/admin.js")).status, 200);
  assert.equal((await fetch(origin + "/admin/admin.css")).status, 200);
  assert.equal((await json("/admin/operations", null)).response.status, 401);
  assert.equal((await json("/admin/operations", second)).response.status, 403);
  const adminOperations = await json("/admin/operations", first);
  assert.equal(adminOperations.response.status, 200, JSON.stringify(adminOperations.body));
  assert.ok(Array.isArray(adminOperations.body.orders));
  assert.ok(Array.isArray(adminOperations.body.settlement_evidence));
  assert.ok(adminOperations.body.settlement_evidence.length > 0);
  assert.ok(Array.isArray(adminOperations.body.admin_activity_events));
  assert.ok(adminOperations.body.admin_activity_events.some((event) =>
    event.action === "OPERATIONS_VIEWED" && event.outcome === "COMPLETED"
  ));
  assert.ok(adminOperations.body.admin_activity_events.every((event) =>
    event.actor_email === ownerEmail
  ));
  assert.ok(adminOperations.body.settlement_evidence.every((item) =>
    item.evidence_source === "SEPAY_WEBHOOK"
  ));
  assert.equal("raw_payload" in (adminOperations.body.webhook_reviews[0] ?? {}), false);

  const noCsrfAdminAction = await json(
    `/admin/custom-design/requests/${customRequest.body.request_id}`,
    { ...first, csrf: "" },
    {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    },
  );
  assert.equal(noCsrfAdminAction.response.status, 403);
  const unauthorizedAdminAction = await json(
    `/admin/custom-design/requests/${customRequest.body.request_id}`,
    second,
    {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    },
  );
  assert.equal(unauthorizedAdminAction.response.status, 403);

  const startReview = await json(
    `/admin/custom-design/requests/${customRequest.body.request_id}`,
    first,
    {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    },
  );
  assert.equal(startReview.response.status, 200);
  assert.equal(startReview.body.status, "IN_REVIEW");
  const invalidReviewTransition = await json(
    `/admin/custom-design/requests/${customRequest.body.request_id}`,
    first,
    {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    },
  );
  assert.equal(invalidReviewTransition.response.status, 409);

  const requestInformation = await json(
    `/admin/custom-design/requests/${customRequest.body.request_id}`,
    first,
    {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "request_information",
        customer_message: "Vui lòng xác nhận quyền sử dụng hình ảnh tham khảo.",
      }),
    },
  );
  assert.equal(requestInformation.response.status, 200);
  assert.equal(requestInformation.body.status, "CUSTOMER_ACTION_REQUIRED");
  const customerSeesInformationRequest = await json(
    `/custom-design/requests/${customRequest.body.request_id}`,
    first,
  );
  assert.equal(customerSeesInformationRequest.body.communication_status, "CUSTOMER_ACTION_REQUIRED");
  assert.equal(customerSeesInformationRequest.body.customer_message,
    "Vui lòng xác nhận quyền sử dụng hình ảnh tham khảo.");

  const customerReplyPath = `/custom-design/requests/${customRequest.body.request_id}/replies`;
  const missingReplyCsrf = await json(customerReplyPath, { ...first, csrf: "" }, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ message: "Tôi có quyền sử dụng hình ảnh." }),
  });
  assert.equal(missingReplyCsrf.response.status, 403);
  const invalidCustomerReply = await json(customerReplyPath, first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(invalidCustomerReply.response.status, 422);
  assert.equal((await json(
    `/custom-design/requests/${customRequest.body.request_id}`,
    second,
  )).response.status, 404);
  const unauthorizedCustomerReply = await json(customerReplyPath, second, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ message: "Tôi có quyền sử dụng hình ảnh." }),
  });
  assert.equal(unauthorizedCustomerReply.response.status, 404);

  const replyAttempts = [
    { key: crypto.randomUUID(), message: "Tôi xác nhận có quyền sử dụng hình ảnh tham khảo." },
    { key: crypto.randomUUID(), message: "Tôi xác nhận và sẽ gửi thêm nội dung." },
  ];
  const replyResults = await Promise.all(replyAttempts.map(({ key, message }) =>
    json(customerReplyPath, first, {
      method: "POST",
      mutating: true,
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ message }),
    })
  ));
  assert.deepEqual(replyResults.map((result) => result.response.status).sort(), [201, 409]);
  const successfulReplyIndex = replyResults.findIndex((result) => result.response.status === 201);
  const successfulReply = replyResults[successfulReplyIndex].body;
  const successfulReplyInput = replyAttempts[successfulReplyIndex];
  assert.equal(successfulReply.status, "IN_REVIEW");
  assert.equal(successfulReply.communication_status, "RESPONDED");
  assert.equal(successfulReply.customer_reply, successfulReplyInput.message);
  assert.equal(successfulReply.customer_reply_at !== null, true);
  const replayedCustomerReply = await json(customerReplyPath, first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": successfulReplyInput.key,
    },
    body: JSON.stringify({ message: successfulReplyInput.message }),
  });
  assert.equal(replayedCustomerReply.response.status, 200);
  assert.equal(replayedCustomerReply.body.customer_reply, successfulReplyInput.message);
  const conflictingCustomerReply = await json(customerReplyPath, first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": successfulReplyInput.key,
    },
    body: JSON.stringify({ message: "Nội dung khác với khóa đã sử dụng." }),
  });
  assert.equal(conflictingCustomerReply.response.status, 409);

  const replyRow = queryLocalD1(
    `SELECT id, customer_id FROM custom_design_customer_replies
      WHERE request_id = '${customRequest.body.request_id}'`,
  )[0];
  assert.ok(replyRow?.id);
  assert.equal(queryLocalD1(
    `SELECT customer_reply_submission_token FROM custom_design_requests
      WHERE id = '${customRequest.body.request_id}'`,
  )[0].customer_reply_submission_token, null);
  const secondCustomerId = queryLocalD1(
    `SELECT id FROM customers WHERE email_normalized = ${sqlText(secondEmail)}`,
  )[0]?.id;
  assert.ok(secondCustomerId);
  assertD1Failure(
    `INSERT INTO custom_design_customer_replies (
       id, request_id, customer_id, idempotency_key, reply_hash, message,
       from_status, to_status, from_communication_status, to_communication_status, created_at
     ) VALUES (
       '00000000-0000-4000-8000-000000000022',
       '${customRequest.body.request_id}', '${secondCustomerId}',
       'customer-reply-owner-test', '${"a".repeat(64)}', 'Unauthorized reply',
       'CUSTOMER_ACTION_REQUIRED', 'IN_REVIEW',
       'CUSTOMER_ACTION_REQUIRED', 'RESPONDED', '2026-01-01T00:00:00.000Z'
     )`,
    /owner mismatch/,
  );
  assertD1Failure(
    `UPDATE custom_design_customer_replies SET message = 'changed' WHERE id = '${replyRow.id}'`,
    /immutable/,
  );
  assertD1Failure(
    `DELETE FROM custom_design_customer_replies WHERE id = '${replyRow.id}'`,
    /immutable/,
  );
  const customerReplyVisibleToAdmin = (await json("/admin/operations", first)).body
    .custom_design_requests.find((request) => request.id === customRequest.body.request_id);
  assert.equal(customerReplyVisibleToAdmin.customer_reply, successfulReplyInput.message);

  const requestInformationAgain = await json(
    `/admin/custom-design/requests/${customRequest.body.request_id}`,
    first,
    {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "request_information",
        customer_message: "Cảm ơn bạn. Vui lòng xác nhận nội dung cần ưu tiên.",
      }),
    },
  );
  assert.equal(requestInformationAgain.response.status, 200);
  assert.equal(requestInformationAgain.body.status, "CUSTOMER_ACTION_REQUIRED");

  const adminReply = await json(
    `/admin/custom-design/requests/${customRequest.body.request_id}`,
    first,
    {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "reply",
        customer_message: "Cảm ơn bạn, yêu cầu đang được xem xét.",
      }),
    },
  );
  assert.equal(adminReply.response.status, 200);
  assert.equal(adminReply.body.status, "IN_REVIEW");
  assert.equal(adminReply.body.communication_status, "RESPONDED");
  assert.equal((await json("/custom-design/requests", first)).body.requests[0].customer_message,
    "Cảm ơn bạn, yêu cầu đang được xem xét.");
  assert.equal((await json("/admin/operations", first)).body.custom_design_requests
    .find((request) => request.id === customRequest.body.request_id).status, "IN_REVIEW");
  assert.equal(queryLocalD1(
    `SELECT COUNT(*) AS count FROM custom_design_request_events
      WHERE request_id = '${customRequest.body.request_id}'`,
  )[0].count, 4);

  const nonAdminRecovery = await json("/admin/fulfillments/recover", second, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(nonAdminRecovery.response.status, 403);
  const csrflessAdminRecovery = await json(
    "/admin/fulfillments/recover",
    { cookies: first.cookies, csrf: "" },
    {
      method: "POST",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(csrflessAdminRecovery.response.status, 403);
  const adminRecovery = await json("/admin/fulfillments/recover", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(adminRecovery.response.status, 200, JSON.stringify(adminRecovery.body));
  assert.equal(typeof adminRecovery.body.result, "object");
  const adminDerivativeReconciliation = await json(
    "/admin/publication-derivatives/reconcile",
    first,
    {
      method: "POST",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(adminDerivativeReconciliation.response.status, 200,
    JSON.stringify(adminDerivativeReconciliation.body));
  const auditedOperations = await json("/admin/operations", first);
  assert.ok(auditedOperations.body.admin_activity_events.some((event) =>
    event.action === "FULFILLMENT_RECOVERY" && event.outcome === "STARTED"
  ));
  assert.ok(auditedOperations.body.admin_activity_events.some((event) =>
    event.action === "FULFILLMENT_RECOVERY" && event.outcome === "COMPLETED"
  ));
  assert.ok(auditedOperations.body.admin_activity_events.some((event) =>
    event.action === "PUBLICATION_DERIVATIVE_RECONCILIATION" &&
    event.outcome === "COMPLETED"
  ));
  assert.ok(auditedOperations.body.admin_activity_events.some((event) =>
    event.action === "CUSTOM_DESIGN_REPLY" &&
    event.target_id === customRequest.body.request_id &&
    event.outcome === "COMPLETED"
  ));

  const repeatedCustomRequest = await json("/custom-design/requests", first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": customRequestKey,
    },
    body: JSON.stringify(customRequestInput),
  });
  assert.equal(repeatedCustomRequest.response.status, 200);
  assert.equal(repeatedCustomRequest.body.request_id, customRequest.body.request_id);

  const conflictingCustomRequest = await json("/custom-design/requests", first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": customRequestKey,
    },
    body: JSON.stringify({ ...customRequestInput, brief: "Nội dung khác" }),
  });
  assert.equal(conflictingCustomRequest.response.status, 409);

  for (let attempt = 0; attempt < 4; attempt++) {
    const additionalRequest = await json("/custom-design/requests", first, {
      method: "POST",
      mutating: true,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `custom-limit-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        ...customRequestInput,
        brief: `Rate limit request ${attempt + 2}`,
      }),
    });
    assert.equal(additionalRequest.response.status, 201);
  }
  const limitedCustomRequest = await json("/custom-design/requests", first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `custom-limit-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ ...customRequestInput, brief: "Request beyond daily limit" }),
  });
  assert.equal(limitedCustomRequest.response.status, 429);

  const unsafeReference = await json("/custom-design/requests", first, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `custom-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      ...customRequestInput,
      reference_urls: ["javascript:alert(1)"],
    }),
  });
  assert.equal(unsafeReference.response.status, 422);

  const ownedCustomRequest = await json(
    `/custom-design/requests/${customRequest.body.request_id}`,
    first,
  );
  assert.equal(ownedCustomRequest.response.status, 200);
  const foreignCustomRequest = await json(
    `/custom-design/requests/${customRequest.body.request_id}`,
    second,
  );
  assert.equal(foreignCustomRequest.response.status, 404);
  const customerCustomRequests = await json("/custom-design/requests", second);
  assert.equal(customerCustomRequests.response.status, 200);
  assert.equal(customerCustomRequests.body.requests.length, 0);

  const crossOwner = await json(`/designs/${designId}`, second);
  assert.equal(crossOwner.response.status, 404);
  const crossOwnerUpdate = await json(`/designs/${designId}`, second, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 2, data: changed }),
  });
  assert.equal(crossOwnerUpdate.response.status, 404);

  const tooLargeGrant = await json("/assets/upload-url", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, media_type: "image/png", size: 5 * 1024 * 1024 + 1 }),
  });
  assert.equal(tooLargeGrant.response.status, 413);

  const badImage = await uploadImage(first, designId, Buffer.from("GIF89a", "ascii"));
  assert.equal(badImage.uploaded.status, 422);
  const badImageDelete = await json(`/assets/${badImage.grant.asset_id}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(badImageDelete.response.status, 200);

  const png = makePng();
  const goodImage = await uploadImage(first, designId, png);
  assert.equal(goodImage.uploaded.status, 204);
  const completed = await json(`/assets/${goodImage.grant.asset_id}/complete`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.status, "READY");

  const privateImage = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`, {
    headers: { Cookie: second.cookies.join("; ") },
  });
  assert.equal(privateImage.status, 404);
  const anonymousImage = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`);
  assert.equal(anonymousImage.status, 401);
  const ownerImage = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`, {
    headers: { Cookie: first.cookies.join("; ") },
  });
  assert.equal(ownerImage.status, 200);
  assert.equal(ownerImage.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await ownerImage.arrayBuffer()), png);

  const withPhoto = { ...changed, photos: [{ asset_id: goodImage.grant.asset_id, caption: "Kỷ niệm" }] };
  const savedPhoto = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 2, data: withPhoto }),
  });
  assert.equal(savedPhoto.response.status, 200);
  const photoReloaded = await json(`/designs/${designId}`, first);
  assert.equal(photoReloaded.response.status, 200);
  assert.deepEqual(photoReloaded.body.data.photos, [{ asset_id: goodImage.grant.asset_id, caption: "Kỷ niệm" }]);
  const previewCreated = await json(`/designs/${designId}/preview`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(previewCreated.response.status, 201);
  assert.ok(previewCreated.body.url.includes("#"));

  const crossBrowserPreview = await fetch(origin + "/api/v1/previews", {
    headers: { Authorization: `Bearer ${previewCreated.body.token}` },
  });
  assert.equal(crossBrowserPreview.status, 200);
  const previewBody = await crossBrowserPreview.json();
  assert.equal(previewBody.data.sender, "An");
  assert.equal(previewBody.data.photos[0].caption, "Kỷ niệm");
  const previewImage = await fetch(origin + previewBody.data.photos[0].url, {
    headers: { Authorization: `Bearer ${previewCreated.body.token}` },
  });
  assert.equal(previewImage.status, 200);

  const paidOrderId = seedPaidOrder(ownerEmail, designId, 3);
  const consent = {
    asset_id: goodImage.grant.asset_id,
    consent_version: "public-image-v1",
  };
  const unauthorizedPublication = await json("/publications", second, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: paidOrderId, expected_revision: 3, asset_consents: [consent] }),
  });
  assert.equal(unauthorizedPublication.response.status, 422);

  const createdPublication = await json("/publications", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: paidOrderId, expected_revision: 3, asset_consents: [consent] }),
  });
  assert.equal(createdPublication.response.status, 201, JSON.stringify(createdPublication.body));
  const publicationId = createdPublication.body.publication_id;
  const publicationSlug = new URL(createdPublication.body.url).pathname.split("/").at(-1);
  assert.match(publicationSlug, /^g[A-Za-z0-9_-]{20,40}$/);
  const unpublishedPublicRead = await json(`/publications/${publicationSlug}`, null);
  assert.equal(unpublishedPublicRead.response.status, 410);
  const publicationShell = await fetch(origin + `/p/${publicationSlug}`);
  assert.equal(publicationShell.status, 200);
  assert.match(publicationShell.headers.get("content-type") || "", /text\/html/);
  const publicationCss = await fetch(origin + "/p/publication.css");
  assert.match(publicationCss.headers.get("content-type") || "", /text\/css/);
  assert.equal((await fetch(origin + "/shared/publication-bootstrap.js")).status, 200);

  const crossOwnerPublication = await json(`/publications/${publicationId}`, second);
  assert.equal(crossOwnerPublication.response.status, 404);
  const firstPublish = await json(`/publications/${publicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 1 }),
  });
  assert.equal(firstPublish.response.status, 200, JSON.stringify(firstPublish.body));
  const publicRead = await json(`/publications/${publicationSlug}`, null);
  assert.equal(publicRead.response.status, 200, JSON.stringify(publicRead.body));
  assert.equal(publicRead.body.template_id, "our-universe");
  assert.equal(publicRead.body.data.photos[0].caption, "Kỷ niệm");
  assert.equal(publicRead.body.data.photos[0].asset_id, undefined);
  const publishedImagePath = publicRead.body.data.photos[0].url;
  const publishedImage = await fetch(origin + publishedImagePath);
  assert.equal(publishedImage.status, 200);
  assert.equal(publishedImage.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await publishedImage.arrayBuffer()), png);

  const firstUnpublish = await json(`/publications/${publicationId}/unpublish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 2 }),
  });
  assert.equal(firstUnpublish.response.status, 200);
  assert.equal((await json(`/publications/${publicationSlug}`, null)).response.status, 410);
  const republished = await json(`/publications/${publicationId}/republish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 3 }),
  });
  assert.equal(republished.response.status, 200, JSON.stringify(republished.body));

  const changedPublicationData = { ...withPhoto, headline: "Bầu trời của chúng mình" };
  const changedForPublication = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 3, data: changedPublicationData }),
  });
  assert.equal(changedForPublication.response.status, 200);
  const unpublishBeforeUpdate = await json(`/publications/${publicationId}/unpublish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 4 }),
  });
  assert.equal(unpublishBeforeUpdate.response.status, 200);
  const updateBody = JSON.stringify({
      expected_revision: 4,
      expected_lifecycle_revision: 5,
      asset_consents: [],
    });
  const concurrentUpdates = await Promise.all([
    json(`/publications/${publicationId}`, first, {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: updateBody,
    }),
    json(`/publications/${publicationId}`, first, {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: updateBody,
    }),
  ]);
  assert.deepEqual(
    concurrentUpdates.map((item) => item.response.status).sort(),
    [200, 409],
    "one publication update succeeds and the stale concurrent update conflicts",
  );
  const updateSnapshot = concurrentUpdates.find((item) => item.response.status === 200);
  assert.ok(updateSnapshot);
  assert.equal(updateSnapshot.body.lifecycle_revision, 6);
  const publishUpdated = await json(`/publications/${publicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 6 }),
  });
  assert.equal(publishUpdated.response.status, 200, JSON.stringify(publishUpdated.body));
  const updatedPublicRead = await json(`/publications/${publicationSlug}`, null);
  assert.equal(updatedPublicRead.response.status, 200);
  assert.equal(updatedPublicRead.body.data.headline, "Bầu trời của chúng mình");
  assert.deepEqual(updatedPublicRead.body.data.photos, []);

  const unpublishBeforeConsent = await json(`/publications/${publicationId}/unpublish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 7 }),
  });
  assert.equal(unpublishBeforeConsent.response.status, 200);
  const regrantConsent = await json(`/publications/${publicationId}`, first, {
    method: "PATCH",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expected_revision: 4,
      expected_lifecycle_revision: 8,
      asset_consents: [consent],
    }),
  });
  assert.equal(regrantConsent.response.status, 200);
  const publishWithConsent = await json(`/publications/${publicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 9 }),
  });
  assert.equal(publishWithConsent.response.status, 200);
  const withdrawConsent = await json(
    `/publications/${publicationId}/assets/${goodImage.grant.asset_id}/consent`,
    first,
    { method: "POST", mutating: true, headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  assert.equal(withdrawConsent.response.status, 200, JSON.stringify(withdrawConsent.body));
  const consentWithdrawnRead = await json(`/publications/${publicationSlug}`, null);
  assert.deepEqual(consentWithdrawnRead.body.data.photos, []);
  assert.equal((await fetch(origin + publishedImagePath)).status, 404);
  const revokePublication = await json(`/publications/${publicationId}/revoke`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 11 }),
  });
  assert.equal(revokePublication.response.status, 200);
  assert.equal((await json(`/publications/${publicationSlug}`, null)).response.status, 410);

  const websites = await json("/publications", first);
  assert.equal(websites.response.status, 200);
  assert.ok(websites.body.websites.some((website) => website.publication_id === publicationId));

  const referencedDelete = await json(`/assets/${goodImage.grant.asset_id}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(referencedDelete.response.status, 409, JSON.stringify(referencedDelete.body));
  const withoutPhoto = { ...changedPublicationData, photos: [] };
  const unlinked = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 4, data: withoutPhoto }),
  });
  assert.equal(unlinked.response.status, 200);
  const removed = await json(`/assets/${goodImage.grant.asset_id}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(removed.response.status, 409,
    "paid order snapshots retain referenced source assets after the draft unlinks them");
  const removedRead = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`, {
    headers: { Cookie: first.cookies.join("; ") },
  });
  assert.equal(removedRead.status, 200);

  const tokenHash = createHash("sha256").update(previewCreated.body.token).digest("hex");
  executeLocalD1(
    `UPDATE preview_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = '${tokenHash}'`,
  );
  const expiredPreview = await fetch(origin + "/api/v1/previews", {
    headers: { Authorization: `Bearer ${previewCreated.body.token}` },
  });
  assert.equal(expiredPreview.status, 404);

  executeLocalD1(
    `UPDATE orders SET status = 'FULFILLED' WHERE id = '${paidOrderId}'`,
  );
  const deletedDesign = await json(`/designs/${designId}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(deletedDesign.response.status, 202);
  const goneDesign = await json(`/designs/${designId}`, first);
  assert.equal(goneDesign.response.status, 404);

  const designForDeletion = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(designForDeletion.response.status, 201);
  const deletionDesignId = designForDeletion.body.design_id;
  const deletionImage = await uploadImage(first, deletionDesignId, png);
  assert.equal(deletionImage.uploaded.status, 204);
  const deletionImageComplete = await json(`/assets/${deletionImage.grant.asset_id}/complete`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(deletionImageComplete.response.status, 200);
  const deletionDesignWithPhoto = await json(`/designs/${deletionDesignId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      expected_revision: 1,
      data: {
        ...designForDeletion.body.data,
        photos: [{ asset_id: deletionImage.grant.asset_id, caption: "Deletion cleanup" }],
      },
    }),
  });
  assert.equal(deletionDesignWithPhoto.response.status, 200);
  const deletionOrderId = seedPaidOrder(ownerEmail, deletionDesignId, 2);
  const deletionPublication = await json("/publications", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order_id: deletionOrderId,
      expected_revision: 2,
      asset_consents: [{
        asset_id: deletionImage.grant.asset_id,
        consent_version: "public-image-v1",
      }],
    }),
  });
  assert.equal(deletionPublication.response.status, 201);
  const deletionPublicationId = deletionPublication.body.publication_id;
  const deletionPublicationSlug = new URL(deletionPublication.body.url).pathname.split("/").at(-1);
  const publishForDeletion = await json(`/publications/${deletionPublicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 1 }),
  });
  assert.equal(publishForDeletion.response.status, 200);
  const liveDeletionPublication = await json(`/publications/${deletionPublicationSlug}`, null);
  assert.equal(liveDeletionPublication.response.status, 200);
  const deletionPublicImagePath = liveDeletionPublication.body.data.photos[0].url;
  assert.equal((await fetch(origin + deletionPublicImagePath)).status, 200);
  executeLocalD1(
    `UPDATE orders SET status = 'FULFILLED' WHERE id = '${deletionOrderId}'`,
  );
  const removedPublishedDesign = await json(`/designs/${deletionDesignId}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(removedPublishedDesign.response.status, 202);
  assert.equal((await json(`/publications/${deletionPublicationSlug}`, null)).response.status, 404);
  assert.equal((await fetch(origin + deletionPublicImagePath)).status, 404);
  const deletionState = queryLocalD1(
    `SELECT d.status AS design_status, p.status AS publication_status,
            pa.derivative_status, pa.derivative_key, a.status AS asset_status
       FROM designs d
       JOIN publications p ON p.design_id = d.id
       JOIN publication_assets pa ON pa.publication_id = p.id
       JOIN assets a ON a.id = pa.asset_id
      WHERE d.id = '${deletionDesignId}'`,
  );
  assert.equal(deletionState.length, 1);
  assert.equal(deletionState[0].design_status, "DELETION_PENDING");
  assert.equal(deletionState[0].publication_status, "UNPUBLISHED");
  assert.equal(deletionState[0].derivative_status, "DELETED");
  assert.equal(deletionState[0].derivative_key, null);
  assert.equal(deletionState[0].asset_status, "READY");

  const revoked = await json("/customers/session", first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(revoked.response.status, 200);
  const revokedMe = await json("/customers/me", first);
  assert.equal(revokedMe.response.status, 401);

  const contractRequest = async (path, session, options = {}) => {
    const headers = new Headers(options.headers ?? {});
    if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
    if (options.mutating) {
      headers.set("Origin", origin);
      if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
    }
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      options = { ...options, body: JSON.stringify(options.json) };
    }
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    const response = await fetch(origin + "/api/v1" + path, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
    });
    const body = response.status === 204 ||
      !response.headers.get("content-type")?.includes("application/json")
      ? null
      : await response.json();
    return { response, body };
  };
  const contract = await runDatabaseContract({
    request: contractRequest,
    getMagicToken: () => emailSink.waitForMagicToken(),
    label: "Cloudflare D1 + local R2",
  });

  const assetFailureDesign = await contractRequest("/designs", contract.owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(assetFailureDesign.response.status, 201);
  executeLocalD1(
    "CREATE TRIGGER d1_contract_reject_asset_metadata BEFORE UPDATE OF sha256 ON assets " +
    "WHEN NEW.status = 'QUARANTINED' BEGIN SELECT RAISE(ABORT, 'forced asset metadata failure'); END",
  );
  const failedUpload = await uploadImage(contract.owner, assetFailureDesign.body.design_id, makePng());
  assert.equal(failedUpload.uploaded.status, 503);
  const inaccessibleFailedUpload = await contractRequest(
    `/assets/${failedUpload.grant.asset_id}`,
    contract.owner,
  );
  assert.equal(inaccessibleFailedUpload.response.status, 404);
  executeLocalD1("DROP TRIGGER d1_contract_reject_asset_metadata");
  const uploadRetry = await fetch(origin + failedUpload.grant.upload_url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${failedUpload.grant.upload_token}`,
      "Content-Type": "image/png",
    },
    body: makePng(),
  });
  assert.equal(uploadRetry.status, 204, "failed DB write should clean binary and release the one-time upload token");
  const completedRetry = await contractRequest(
    `/assets/${failedUpload.grant.asset_id}/complete`,
    contract.owner,
    { method: "POST", mutating: true },
  );
  assert.equal(completedRetry.response.status, 200);
  const retriedAssetCount = queryLocalD1(
    `SELECT COUNT(*) AS count FROM assets
      WHERE id = '${failedUpload.grant.asset_id}' AND status = 'READY'`,
  );
  assert.equal(retriedAssetCount[0].count, 1, "retry reuses the original asset row");

  const uploadDeletionRaceDesign = await contractRequest("/designs", contract.owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(uploadDeletionRaceDesign.response.status, 201);
  const uploadDeletionRaceGrant = await contractRequest("/assets/upload-url", contract.owner, {
    method: "POST",
    mutating: true,
    json: {
      design_id: uploadDeletionRaceDesign.body.design_id,
      media_type: "image/png",
      size: makePng().length,
    },
  });
  assert.equal(uploadDeletionRaceGrant.response.status, 201);
  executeLocalD1(
    `UPDATE asset_upload_sessions
        SET status = 'UPLOADING', used_at = '2026-11-14T00:00:00.000Z',
            lease_expires_at = '2099-01-01T00:00:00.000Z'
      WHERE asset_id = '${uploadDeletionRaceGrant.body.asset_id}'`,
  );
  const activeUploadDelete = await contractRequest(
    `/designs/${uploadDeletionRaceDesign.body.design_id}`,
    contract.owner,
    { method: "DELETE", mutating: true },
  );
  assert.equal(activeUploadDelete.response.status, 409);
  assert.equal(queryLocalD1(
    `SELECT status FROM designs WHERE id = '${uploadDeletionRaceDesign.body.design_id}'`,
  )[0].status, "DRAFT");
  executeLocalD1(
    `UPDATE asset_upload_sessions
        SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE asset_id = '${uploadDeletionRaceGrant.body.asset_id}'`,
  );
  const expiredUploadDelete = await contractRequest(
    `/designs/${uploadDeletionRaceDesign.body.design_id}`,
    contract.owner,
    { method: "DELETE", mutating: true },
  );
  assert.equal(expiredUploadDelete.response.status, 200);
  const cancelledUpload = await fetch(origin + uploadDeletionRaceGrant.body.upload_url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${uploadDeletionRaceGrant.body.upload_token}`,
      "Content-Type": "image/png",
    },
    body: makePng(),
  });
  assert.equal(cancelledUpload.status, 409);
  const archivedUploadDesign = await contractRequest(
    "/assets/upload-url",
    contract.owner,
    {
      method: "POST",
      mutating: true,
      json: {
        design_id: uploadDeletionRaceDesign.body.design_id,
        media_type: "image/png",
        size: makePng().length,
      },
    },
  );
  assert.equal(archivedUploadDesign.response.status, 404);
  assert.deepEqual(queryLocalD1(
    `SELECT d.status AS design_status, a.status AS asset_status, u.status AS upload_status
       FROM designs d JOIN assets a ON a.design_id = d.id
       JOIN asset_upload_sessions u ON u.asset_id = a.id
      WHERE d.id = '${uploadDeletionRaceDesign.body.design_id}'`,
  )[0], {
    design_status: "ARCHIVED",
    asset_status: "DELETED",
    upload_status: "CANCELLED",
  });

  const rollbackDesign = await contractRequest("/designs", contract.owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(rollbackDesign.response.status, 201);
  executeLocalD1(
    "CREATE TRIGGER d1_contract_reject_revision BEFORE INSERT ON design_revisions " +
    "WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'forced contract failure'); END",
  );
  const rejectedUpdate = await contractRequest(`/designs/${rollbackDesign.body.design_id}`, contract.owner, {
    method: "PUT",
    mutating: true,
    json: {
      schema_version: 1,
      expected_revision: 1,
      data: { ...rollbackDesign.body.data, sender: "Should roll back" },
    },
  });
  assert.equal(rejectedUpdate.response.status, 500);
  const unchangedAfterRollback = await contractRequest(
    `/designs/${rollbackDesign.body.design_id}`,
    contract.owner,
  );
  assert.equal(unchangedAfterRollback.response.status, 200);
  assert.equal(unchangedAfterRollback.body.revision, 1);
  assert.notEqual(unchangedAfterRollback.body.data.sender, "Should roll back");
  executeLocalD1("DROP TRIGGER d1_contract_reject_revision");

  let verificationRateLimited = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const verification = await json("/customers/session/verify", null, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: `synthetic-invalid-token-${attempt}` }),
    });
    if (verification.response.status === 429) {
      verificationRateLimited = true;
      break;
    }
    assert.equal(verification.response.status, 401, "invalid magic link is rejected before rate limit");
  }
  assert.ok(verificationRateLimited, "verification endpoint enforces its local rate limit");

  await stopWorker();
  assertD1Failure(
    `UPDATE custom_design_request_events SET action = 'reply' WHERE request_id = '${customRequest.body.request_id}'`,
    /custom design review events are immutable/i,
  );
  assertD1Failure(
    `DELETE FROM custom_design_request_events WHERE request_id = '${customRequest.body.request_id}'`,
    /custom design review events are immutable/i,
  );
  assertD1Failure(
    "UPDATE admin_activity_events SET outcome = 'FAILED' WHERE action = 'OPERATIONS_VIEWED'",
    /admin activity events are immutable/i,
  );
  assertD1Failure(
    "DELETE FROM admin_activity_events WHERE action = 'OPERATIONS_VIEWED'",
    /admin activity events are immutable/i,
  );
  startWorker(null);
  await waitReady();
  for (const [adminEmails, label] of [
    [null, "missing"],
    ["", "empty"],
    ["invalid-email", "invalid"],
  ]) {
    if (label !== "missing") {
      await stopWorker();
      startWorker(adminEmails);
      await waitReady();
    }
    const disabledAdmin = await json("/admin/operations", contract.owner);
    assert.equal(disabledAdmin.response.status, 503, `${label} admin allowlist fails closed`);
    assert.equal(disabledAdmin.body.error.code, "ADMIN_DISABLED");
  }
  await stopWorker();
  const manualAdminEmail = `manual-admin-${randomBytes(8).toString("hex")}@example.test`;
  const manualCustomerEmail = `manual-customer-${randomBytes(8).toString("hex")}@example.test`;
  startWorker(manualAdminEmail, "manual-bank-transfer");
  await waitReady();
  const manualAdmin = await signIn(manualAdminEmail, "198.51.100.11");
  const manualCustomer = await signIn(manualCustomerEmail, "198.51.100.12");
  const manualDesign = await json("/designs", manualAdmin, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(manualDesign.response.status, 201);

  const manualOrder = await json("/orders", manualAdmin, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `manual-${randomBytes(16).toString("hex")}`,
    },
    body: JSON.stringify({
      design_id: manualDesign.body.design_id,
      duration_type: "monthly",
      hosting_months: 1,
      asset_consents: [],
    }),
  });
  assert.equal(manualOrder.response.status, 201, "manual transfer order is created");
  assert.equal(manualOrder.body.payment.provider, "MANUAL_BANK_TRANSFER");
  assert.equal(manualOrder.body.payment.instructions.bank_code, "MB");
  assert.equal(manualOrder.body.payment.instructions.bank_account, receivingAccount);
  assert.equal(manualOrder.body.payment.instructions.reference, manualOrder.body.order_reference,
    "manual transfer instructions use the unique order reference");
  assert.notEqual(manualOrder.body.payment.instructions.reference, manualOrder.body.payment.reference,
    "manual transfer instructions do not confuse payment and order references");
  assert.equal(manualOrder.body.payment.qr_url, null, "manual transfer does not create a payment QR");
  assert.ok(Date.parse(manualOrder.body.expires_at) - Date.now() > 23 * 60 * 60 * 1000,
    "manual transfer orders have a 24-hour payment window");
  assert.equal((await json(
    `/orders/${manualOrder.body.order_id}/status`,
    manualCustomer,
  )).response.status, 404, "another customer cannot read the manual order");

  const manualAmount = manualOrder.body.total_minor;
  const manualConfirmationPath =
    `/admin/orders/${manualOrder.body.order_id}/manual-payment-confirmation`;
  const manualConfirmationBody = {
    amount_minor: manualAmount,
    transaction_reference: `MANUAL-${randomBytes(8).toString("hex")}`,
  };
  const customerConfirmation = await json(manualConfirmationPath, manualCustomer, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manualConfirmationBody),
  });
  assert.equal(customerConfirmation.response.status, 403,
    "a customer without admin authorization cannot confirm payment");
  const missingCsrfConfirmation = await json(manualConfirmationPath, manualAdmin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manualConfirmationBody),
  });
  assert.equal(missingCsrfConfirmation.response.status, 403,
    "manual payment confirmation requires CSRF protection");
  const wrongAmountConfirmation = await json(manualConfirmationPath, manualAdmin, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...manualConfirmationBody, amount_minor: manualAmount + 1 }),
  });
  assert.equal(wrongAmountConfirmation.response.status, 409,
    "manual payment confirmation must match the server-side order amount");
  assert.equal((await json(
    `/orders/${manualOrder.body.order_id}/status`,
    manualAdmin,
  )).body.status, "AWAITING_PAYMENT", "invalid confirmations do not change order state");

  const duplicateReferenceOrder = await json("/orders", manualAdmin, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `manual-${randomBytes(16).toString("hex")}`,
    },
    body: JSON.stringify({
      design_id: manualDesign.body.design_id,
      duration_type: "monthly",
      hosting_months: 1,
      asset_consents: [],
    }),
  });
  assert.equal(duplicateReferenceOrder.response.status, 201);
  const confirmedManual = await json(manualConfirmationPath, manualAdmin, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manualConfirmationBody),
  });
  assert.equal(confirmedManual.response.status, 200);
  assert.equal(confirmedManual.body.confirmed, true);
  assert.equal(confirmedManual.body.fulfillment.completed, true,
    "a valid admin confirmation automatically fulfills the order");
  const duplicateReference = await json(
    `/admin/orders/${duplicateReferenceOrder.body.order_id}/manual-payment-confirmation`,
    manualAdmin,
    {
      method: "POST",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...manualConfirmationBody,
        transaction_reference: manualConfirmationBody.transaction_reference.toLowerCase(),
      }),
    },
  );
  assert.equal(duplicateReference.response.status, 409,
    "a bank transaction reference cannot confirm a second order");
  const replayedManualConfirmation = await json(manualConfirmationPath, manualAdmin, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manualConfirmationBody),
  });
  assert.equal(replayedManualConfirmation.response.status, 200);
  assert.equal(replayedManualConfirmation.body.replayed, true);
  assert.equal(replayedManualConfirmation.body.fulfillment.completed, true);
  const manualOrderStatus = await json(
    `/orders/${manualOrder.body.order_id}/status`,
    manualAdmin,
  );
  assert.equal(manualOrderStatus.response.status, 200);
  assert.equal(manualOrderStatus.body.status, "FULFILLED");
  assert.equal(manualOrderStatus.body.payment.status, "SUCCEEDED");
  assert.deepEqual(queryLocalD1(
    `SELECT
       (SELECT COUNT(*) FROM manual_payment_confirmations WHERE order_id = '${manualOrder.body.order_id}') AS confirmations,
       (SELECT COUNT(*) FROM fulfillment_jobs WHERE order_id = '${manualOrder.body.order_id}') AS jobs,
       (SELECT COUNT(*) FROM publications WHERE order_id = '${manualOrder.body.order_id}') AS publications`,
  ), [{ confirmations: 1, jobs: 1, publications: 1 }],
  "confirmation replay must not duplicate evidence, fulfillment, or publication");

  const manualWebsites = await json("/publications", manualAdmin);
  const manualWebsite = manualWebsites.body.websites.find(
    (website) => website.design_id === manualDesign.body.design_id,
  );
  assert.ok(manualWebsite, "the owner receives the fulfilled website in their account");
  assert.equal(manualWebsite.publication_status, "PUBLISHED");
  const manualPublicUrl = new URL(manualWebsite.public_url);
  assert.equal(manualPublicUrl.origin, origin);
  assert.match(manualPublicUrl.pathname, /^\/p\/g[A-Za-z0-9_-]{20,40}$/);
  const manualSlug = manualPublicUrl.pathname.split("/").at(-1);
  const manualPublicPage = await json(`/publications/${manualSlug}`, null);
  assert.equal(manualPublicPage.response.status, 200,
    "the server-confirmed canonical website URL resolves publicly");
  const manualQr = await fetch(
    `${origin}/api/v1/publications/${manualWebsite.publication_id}/qr.svg`,
    { headers: { Cookie: manualAdmin.cookies.join("; "), Connection: "close" } },
  );
  assert.equal(manualQr.status, 200, "published website QR is available to its owner");
  assert.match(manualQr.headers.get("content-type") ?? "", /^image\/svg\+xml/);

  const renewalExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  executeLocalD1(
    `UPDATE publications SET expires_at = '${renewalExpiry}' WHERE id = '${manualWebsite.publication_id}'`,
  );
  executeLocalD1(
    `UPDATE storage_entitlements SET expires_at = '${renewalExpiry}', status = 'ACTIVE'
     WHERE publication_id = '${manualWebsite.publication_id}' AND status IN ('ACTIVE', 'EXPIRED')`,
  );
  const manualRenewalOrder = await json("/orders", manualAdmin, {
    method: "POST",
    mutating: true,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `manual-renewal-${randomBytes(16).toString("hex")}`,
    },
    body: JSON.stringify({
      design_id: manualDesign.body.design_id,
      renewal_publication_id: manualWebsite.publication_id,
      duration_type: "monthly",
      hosting_months: 1,
      asset_consents: [],
    }),
  });
  assert.equal(manualRenewalOrder.response.status, 201,
    "manual bank transfer supports server-priced storage renewal");
  const manualRenewalConfirmation = await json(
    `/admin/orders/${manualRenewalOrder.body.order_id}/manual-payment-confirmation`,
    manualAdmin,
    {
      method: "POST",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_minor: manualRenewalOrder.body.total_minor,
        transaction_reference: `RENEWAL-${randomBytes(8).toString("hex")}`,
      }),
    },
  );
  assert.equal(manualRenewalConfirmation.response.status, 200);
  assert.equal(manualRenewalConfirmation.body.fulfillment.completed, true,
    "a confirmed renewal extends its existing publication");
  assert.equal((await json(
    `/orders/${manualRenewalOrder.body.order_id}/status`,
    manualAdmin,
  )).body.status, "FULFILLED");
  const renewedWebsite = (await json("/publications", manualAdmin)).body.websites.find(
    (website) => website.publication_id === manualWebsite.publication_id,
  );
  assert.ok(Date.parse(renewedWebsite.expires_at) > Date.parse(renewalExpiry),
    "manual renewal extends the existing website entitlement");

  assertD1Failure(
    `UPDATE manual_payment_confirmations SET amount_minor = ${manualAmount + 1} WHERE order_id = '${manualOrder.body.order_id}'`,
    /manual payment confirmations are immutable/i,
  );
  assertD1Failure(
    `DELETE FROM manual_payment_confirmations WHERE order_id = '${manualOrder.body.order_id}'`,
    /manual payment confirmations are immutable/i,
  );

  await stopWorker();
  executeLocalD1(
    "CREATE TABLE d1_contract_unique (id TEXT PRIMARY KEY, value TEXT NOT NULL UNIQUE)",
  );
  executeLocalD1("INSERT INTO d1_contract_unique (id, value) VALUES ('one', 'same')");
  assertD1Failure(
    "INSERT INTO d1_contract_unique (id, value) VALUES ('two', 'same')",
    /UNIQUE constraint failed/i,
  );
  executeLocalD1(
    "CREATE TABLE d1_contract_fk (id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id))",
  );
  assertD1Failure(
    "INSERT INTO d1_contract_fk (id, customer_id) VALUES ('orphan', 'missing-customer')",
    /FOREIGN KEY constraint failed/i,
  );

  console.log("Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).");
} catch (error) {
  console.error(error);
  console.error(sanitizedLogs());
  process.exitCode = 1;
} finally {
  try {
    await stopWorker();
  } finally {
    try {
      await emailSink.close();
    } finally {
      await rm(persistDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  }
}
