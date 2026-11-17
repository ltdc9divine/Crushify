export type SePayApiV2ScanMode = "DATE_WINDOW" | "SINCE_ID";

export interface SePayApiV2Transaction {
  id: string;
  bankAccountId: string;
  transactionDate: string;
  transferType: "in" | "out";
  amountIn: number;
  amountOut: number;
  referenceNumber: string | null;
  code: string | null;
  webhookSuccess: 0 | 1 | null;
}

export interface SePayApiV2Page {
  transactions: SePayApiV2Transaction[];
  page: number;
  lastPage: number;
  totalRecords: number;
  hasMore: boolean;
  lastTransactionId: string | null;
  lastTransactionDate: string | null;
  fingerprint: string;
}

export interface SePayApiV2ScanOptions {
  mode: SePayApiV2ScanMode;
  bankAccountId?: string;
  sinceId?: string;
  transactionDateFrom?: string;
  transactionDateTo?: string;
  perPage?: number;
  maxPages?: number;
  startPage?: number;
  lastTransactionId?: string | null;
  lastTransactionDate?: string | null;
  previousPageFingerprint?: string | null;
}

export interface SePayApiV2ClientOptions {
  baseUrl: string;
  apiToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  maxRetryAfterMs?: number;
  minimumRequestIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export type SePayApiV2ErrorCode =
  | "CONFIGURATION"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "PAGINATION_INCONSISTENT"
  | "REDIRECT_REJECTED"
  | "RETRY_DELAY_EXCEEDED"
  | "TIMEOUT";

export class SePayApiV2Error extends Error {
  readonly code: SePayApiV2ErrorCode;
  readonly status?: number;

  constructor(
    code: SePayApiV2ErrorCode,
    status?: number,
  ) {
    super(code);
    this.name = "SePayApiV2Error";
    this.code = code;
    this.status = status;
  }
}

interface Pagination {
  currentPage: number;
  lastPage: number;
  totalRecords: number;
  hasMore: boolean;
}

interface ParsedPage extends Pagination {
  transactions: SePayApiV2Transaction[];
}

const API_ORIGINS = new Set([
  "https://userapi.sepay.vn",
  "https://userapi-sandbox.sepay.vn",
]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MINIMUM_REQUEST_INTERVAL_MS = 350;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_FILTER = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const REQUEST_FIELDS = [
  "id",
  "bank_account_id",
  "transaction_date",
  "transfer_type",
  "amount_in",
  "amount_out",
  "reference_number",
  "code",
  "webhook_success",
].join(",");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInteger(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new SePayApiV2Error("INVALID_RESPONSE");
  }
  return Number(value);
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new SePayApiV2Error("INVALID_RESPONSE");
  return value;
}

function parseTransaction(value: unknown): SePayApiV2Transaction {
  if (!isRecord(value) ||
      typeof value.id !== "string" || !UUID_PATTERN.test(value.id) ||
      typeof value.bank_account_id !== "string" || !UUID_PATTERN.test(value.bank_account_id) ||
      typeof value.transaction_date !== "string" ||
      !ISO_DATE_TIME_WITH_ZONE.test(value.transaction_date) ||
      !Number.isFinite(Date.parse(value.transaction_date)) ||
      (value.transfer_type !== "in" && value.transfer_type !== "out") ||
      !(value.webhook_success === null || value.webhook_success === 0 || value.webhook_success === 1)) {
    throw new SePayApiV2Error("INVALID_RESPONSE");
  }
  const amountIn = requireInteger(value.amount_in, 0);
  const amountOut = requireInteger(value.amount_out, 0);
  const referenceNumber = nullableString(value.reference_number);
  const code = nullableString(value.code);

  return {
    id: value.id.toLowerCase(),
    bankAccountId: value.bank_account_id.toLowerCase(),
    transactionDate: value.transaction_date,
    transferType: value.transfer_type,
    amountIn,
    amountOut,
    referenceNumber,
    code,
    webhookSuccess: value.webhook_success,
  };
}

function parsePage(value: unknown, requestedPage: number, perPage: number): ParsedPage {
  if (!isRecord(value) || value.status !== "success" ||
      !Array.isArray(value.data) || !isRecord(value.meta) ||
      !isRecord(value.meta.pagination)) {
    throw new SePayApiV2Error("INVALID_RESPONSE");
  }
  const pagination = value.meta.pagination;
  const currentPage = requireInteger(pagination.current_page, 1);
  const lastPage = requireInteger(pagination.last_page, 0);
  const responsePerPage = requireInteger(pagination.per_page, 1);
  const totalRecords = requireInteger(pagination.total, 0);
  if (typeof pagination.has_more !== "boolean") {
    throw new SePayApiV2Error("INVALID_RESPONSE");
  }
  const expectedLastPage = totalRecords === 0 ? 0 : Math.ceil(totalRecords / perPage);
  if (currentPage !== requestedPage ||
      responsePerPage !== perPage ||
      value.data.length > perPage ||
      lastPage !== expectedLastPage ||
      pagination.has_more !== (currentPage < lastPage) ||
      (totalRecords === 0
        ? requestedPage !== 1 || value.data.length !== 0
        : currentPage > lastPage || value.data.length === 0)) {
    throw new SePayApiV2Error("PAGINATION_INCONSISTENT");
  }

  return {
    transactions: value.data.map(parseTransaction),
    currentPage,
    lastPage,
    totalRecords,
    hasMore: pagination.has_more,
  };
}

function canonicalTransaction(transaction: SePayApiV2Transaction): string {
  return JSON.stringify([
    transaction.bankAccountId,
    transaction.transactionDate,
    transaction.transferType,
    transaction.amountIn,
    transaction.amountOut,
    transaction.referenceNumber,
    transaction.code,
    transaction.webhookSuccess,
  ]);
}

async function pageFingerprint(transactions: SePayApiV2Transaction[]): Promise<string> {
  const input = JSON.stringify(transactions.map((transaction) => [
    transaction.id,
    canonicalTransaction(transaction),
  ]).sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function retryAfterMilliseconds(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function isRedirectRejected(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/redirect/i.test(error.message)) return true;
  const cause = "cause" in error ? error.cause : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause &&
    typeof cause.code === "string" && /REDIRECT/i.test(cause.code);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SePayApiV2Error("INVALID_RESPONSE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SePayApiV2Error("INVALID_RESPONSE");
  }
}

function validateConfiguration(options: SePayApiV2ClientOptions): URL {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new SePayApiV2Error("CONFIGURATION");
  }
  if (!API_ORIGINS.has(base.origin) ||
      base.pathname.replace(/\/+$/, "") !== "/v2" ||
      base.search || base.hash ||
      !/^[A-Za-z0-9]{64}$/.test(options.apiToken)) {
    throw new SePayApiV2Error("CONFIGURATION");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const retries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryAfter = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const interval = options.minimumRequestIntervalMs ?? DEFAULT_MINIMUM_REQUEST_INTERVAL_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_194_304 ||
      !Number.isInteger(retries) || retries < 0 || retries > 5 ||
      !Number.isInteger(retryAfter) || retryAfter < 0 || retryAfter > 300_000 ||
      !Number.isInteger(interval) || interval < 0 || interval > 10_000) {
    throw new SePayApiV2Error("CONFIGURATION");
  }
  return base;
}

export class SePayApiV2Client {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly configuration: SePayApiV2ClientOptions;
  private readonly options: Required<
    Pick<
      SePayApiV2ClientOptions,
      | "timeoutMs"
      | "maxResponseBytes"
      | "maxRetries"
      | "maxRetryAfterMs"
      | "minimumRequestIntervalMs"
      | "sleep"
      | "now"
    >
  >;
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(configuration: SePayApiV2ClientOptions) {
    this.configuration = configuration;
    this.baseUrl = validateConfiguration(configuration);
    this.fetchImpl = configuration.fetch ?? fetch;
    this.options = {
      timeoutMs: configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: configuration.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      maxRetries: configuration.maxRetries ?? DEFAULT_MAX_RETRIES,
      maxRetryAfterMs: configuration.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
      minimumRequestIntervalMs:
        configuration.minimumRequestIntervalMs ?? DEFAULT_MINIMUM_REQUEST_INTERVAL_MS,
      sleep: configuration.sleep ?? ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
      now: configuration.now ?? Date.now,
    };
  }

  async scanTransactions(
    options: SePayApiV2ScanOptions,
    onPage: (page: SePayApiV2Page) => Promise<void>,
  ): Promise<{
    lastTransactionId: string | null;
    lastTransactionDate: string | null;
    lastPage: number;
    totalRecords: number;
    pages: number;
    complete: boolean;
    continuationPage: number | null;
    fingerprint: string | null;
  }> {
    const scan = this.validateScanOptions(options);
    const seen = new Map<string, string>();
    const seenPageFingerprints = new Set<string>();
    let pageNumber = scan.startPage;
    let pages = 0;
    let lastTransactionId: string | null = scan.lastTransactionId ?? null;
    let lastTransactionDate: string | null = scan.lastTransactionDate ?? null;
    let previousFingerprint = scan.previousPageFingerprint ?? null;

    for (;;) {
      const page = await this.requestPage(scan, pageNumber);
      const fingerprint = await pageFingerprint(page.transactions);
      if (fingerprint === previousFingerprint || seenPageFingerprints.has(fingerprint)) {
        throw new SePayApiV2Error("PAGINATION_INCONSISTENT");
      }
      seenPageFingerprints.add(fingerprint);
      const uniqueTransactions: SePayApiV2Transaction[] = [];
      for (const transaction of page.transactions) {
        const transactionDate = Date.parse(transaction.transactionDate);
        if (lastTransactionDate && transactionDate < Date.parse(lastTransactionDate)) {
          throw new SePayApiV2Error("PAGINATION_INCONSISTENT");
        }
        lastTransactionDate = transaction.transactionDate;
        const canonical = canonicalTransaction(transaction);
        const previous = seen.get(transaction.id);
        if (previous !== undefined) {
          if (previous !== canonical) throw new SePayApiV2Error("PAGINATION_INCONSISTENT");
          continue;
        }
        seen.set(transaction.id, canonical);
        uniqueTransactions.push(transaction);
        lastTransactionId = transaction.id;
      }
      await onPage({
        transactions: uniqueTransactions,
        page: pageNumber,
        lastPage: page.lastPage,
        totalRecords: page.totalRecords,
        hasMore: page.hasMore,
        lastTransactionId,
        lastTransactionDate,
        fingerprint,
      });
      pages++;
      if (!page.hasMore) {
        return {
          lastTransactionId,
          lastTransactionDate,
          lastPage: page.lastPage,
          totalRecords: page.totalRecords,
          pages,
          complete: true,
          continuationPage: null,
          fingerprint,
        };
      }
      if (pages >= scan.maxPages) {
        return {
          lastTransactionId,
          lastTransactionDate,
          lastPage: page.lastPage,
          totalRecords: page.totalRecords,
          pages,
          complete: false,
          continuationPage: pageNumber + 1,
          fingerprint,
        };
      }
      previousFingerprint = fingerprint;
      pageNumber++;
    }
  }

  async listTransactions(
    options: SePayApiV2ScanOptions,
  ): Promise<{
    transactions: SePayApiV2Transaction[];
    pages: number;
    complete: boolean;
    continuationPage: number | null;
  }> {
    const transactions: SePayApiV2Transaction[] = [];
    const result = await this.scanTransactions(options, async (page) => {
      transactions.push(...page.transactions);
    });
    return {
      transactions,
      pages: result.pages,
      complete: result.complete,
      continuationPage: result.continuationPage,
    };
  }

  private validateScanOptions(options: SePayApiV2ScanOptions) {
    const perPage = options.perPage ?? 100;
    const maxPages = options.maxPages ?? 100;
    const startPage = options.startPage ?? 1;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100 ||
        !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 ||
        !Number.isSafeInteger(startPage) || startPage < 1 ||
        !Number.isSafeInteger(startPage + maxPages)) {
      throw new SePayApiV2Error("CONFIGURATION");
    }
    if ((options.bankAccountId && !UUID_PATTERN.test(options.bankAccountId)) ||
        (options.lastTransactionId !== undefined && options.lastTransactionId !== null &&
          !UUID_PATTERN.test(options.lastTransactionId)) ||
        (options.lastTransactionDate !== undefined && options.lastTransactionDate !== null &&
          (!ISO_DATE_TIME_WITH_ZONE.test(options.lastTransactionDate) ||
            !Number.isFinite(Date.parse(options.lastTransactionDate)))) ||
        (options.previousPageFingerprint !== undefined &&
          options.previousPageFingerprint !== null &&
          !/^[0-9a-f]{64}$/.test(options.previousPageFingerprint))) {
      throw new SePayApiV2Error("CONFIGURATION");
    }
    if (options.mode === "SINCE_ID") {
      if (options.sinceId && !UUID_PATTERN.test(options.sinceId)) {
        throw new SePayApiV2Error("CONFIGURATION");
      }
      if (options.transactionDateFrom || options.transactionDateTo) {
        throw new SePayApiV2Error("CONFIGURATION");
      }
    } else if (options.mode === "DATE_WINDOW") {
      if (options.sinceId ||
          !options.transactionDateFrom || !DATE_FILTER.test(options.transactionDateFrom) ||
          !options.transactionDateTo || !DATE_FILTER.test(options.transactionDateTo) ||
          options.transactionDateFrom > options.transactionDateTo) {
        throw new SePayApiV2Error("CONFIGURATION");
      }
    } else {
      throw new SePayApiV2Error("CONFIGURATION");
    }
    return { ...options, perPage, maxPages, startPage };
  }

  private async requestPage(
    scan: ReturnType<SePayApiV2Client["validateScanOptions"]>,
    page: number,
  ): Promise<ParsedPage> {
    const url = new URL("transactions", `${this.baseUrl.toString().replace(/\/+$/, "")}/`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(scan.perPage));
    url.searchParams.set("fields", REQUEST_FIELDS);
    url.searchParams.set("timestamp_format", "iso8601");
    url.searchParams.set("transaction_date_sort", "asc");
    if (scan.bankAccountId) url.searchParams.set("bank_account_id", scan.bankAccountId);
    if (scan.mode === "SINCE_ID" && scan.sinceId) {
      url.searchParams.set("since_id", scan.sinceId);
    } else if (scan.mode === "DATE_WINDOW") {
      url.searchParams.set("transaction_date_from", scan.transactionDateFrom!);
      url.searchParams.set("transaction_date_to", scan.transactionDateTo!);
    }

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      await this.waitForRequestSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let response: Response;
      let body = "";
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.configuration.apiToken}`,
          },
          redirect: "error",
          signal: controller.signal,
        });
        if (response.ok) body = await readBoundedBody(response, this.options.maxResponseBytes);
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof SePayApiV2Error) throw error;
        if (isRedirectRejected(error)) throw new SePayApiV2Error("REDIRECT_REJECTED");
        if (attempt < this.options.maxRetries) {
          await this.options.sleep(Math.min(500 * 2 ** attempt, this.options.maxRetryAfterMs));
          continue;
        }
        throw new SePayApiV2Error(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SePayApiV2Error("REDIRECT_REJECTED", response.status);
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < this.options.maxRetries) {
          const retryAfter = response.status === 429
            ? retryAfterMilliseconds(response.headers.get("Retry-After"), this.options.now())
            : null;
          const waitMs = retryAfter ?? Math.min(500 * 2 ** attempt, this.options.maxRetryAfterMs);
          if (waitMs > this.options.maxRetryAfterMs) {
            await response.body?.cancel();
            throw new SePayApiV2Error("RETRY_DELAY_EXCEEDED", response.status);
          }
          await response.body?.cancel();
          await this.options.sleep(waitMs);
          continue;
        }
        await response.body?.cancel();
        throw new SePayApiV2Error("HTTP_ERROR", response.status);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SePayApiV2Error("HTTP_ERROR", response.status);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new SePayApiV2Error("INVALID_JSON", response.status);
      }
      return parsePage(parsed, page, scan.perPage);
    }
    throw new SePayApiV2Error("NETWORK_ERROR");
  }

  private async waitForRequestSlot(): Promise<void> {
    const waitMs = this.lastRequestAt + this.options.minimumRequestIntervalMs - this.options.now();
    if (waitMs > 0) await this.options.sleep(waitMs);
    this.lastRequestAt = this.options.now();
  }
}
