import type { Database } from "../database.ts";
import { safeId, sha256 } from "../http.ts";
import {
  type SePayApiV2ScanMode,
  type SePayApiV2Page,
  type SePayApiV2ScanOptions,
  type SePayApiV2Transaction,
  SePayApiV2Client,
} from "./sepay-api-v2.ts";

const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_LEASE_MS = 30 * 60_000;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60_000;
const MAX_OVERLAP_MS = 7 * 24 * 60 * 60_000;

interface CursorRow {
  scan_mode: SePayApiV2ScanMode;
  cursor_transaction_id: string | null;
  window_end: string | null;
  pending_window_start: string | null;
  pending_window_end: string | null;
  pending_since_id: string | null;
  pending_next_page: number;
  pending_complete: number;
  pending_last_transaction_id: string | null;
  pending_last_transaction_date: string | null;
  pending_last_page_fingerprint: string | null;
  pending_last_page: number | null;
  pending_total_records: number | null;
}

export interface SePayApiV2DateWindow {
  initialFrom: Date;
  scanThrough: Date;
  overlapMs?: number;
}

export interface RunSePayApiV2ScanOptions {
  scanKey: string;
  mode: SePayApiV2ScanMode;
  bankAccountId: string;
  initialSinceId?: string;
  dateWindow?: SePayApiV2DateWindow;
  perPage?: number;
  maxPages?: number;
  leaseMs?: number;
  now?: () => Date;
}

export interface SePayApiV2ScanResult {
  status: "completed" | "partial";
  pages: number;
  observations: number;
  lastTransactionId: string | null;
  continuationPage?: number;
  lastPage?: number;
  totalRecords?: number;
  remainingPages?: number;
  scannedFrom?: string;
  scannedThrough?: string;
}

export type SePayApiV2LeaseErrorCode = "LEASE_HELD" | "LEASE_LOST";

export class SePayApiV2LeaseError extends Error {
  readonly code: SePayApiV2LeaseErrorCode;

  constructor(code: SePayApiV2LeaseErrorCode) {
    super(code);
    this.name = "SePayApiV2LeaseError";
    this.code = code;
  }
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function floorToSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

function sePayDateFilter(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}

function transactionFingerprintInput(transaction: SePayApiV2Transaction): string {
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

function initialDisposition(
  transaction: SePayApiV2Transaction,
  expectedBankAccountId: string,
): { status: "UNMATCHED" | "MANUAL_REVIEW"; reasonCode: string } {
  if (transaction.bankAccountId.toLowerCase() !== expectedBankAccountId.toLowerCase()) {
    return { status: "MANUAL_REVIEW", reasonCode: "BANK_ACCOUNT_ID_MISMATCH" };
  }
  if (transaction.transferType !== "in" || transaction.amountOut !== 0) {
    return { status: "MANUAL_REVIEW", reasonCode: "WRONG_TRANSFER_DIRECTION" };
  }
  return { status: "UNMATCHED", reasonCode: "MATCHING_NOT_ENABLED" };
}

async function persistPage(
  database: Database,
  page: SePayApiV2Page,
  scanMode: SePayApiV2ScanMode,
  scanKey: string,
  leaseToken: string,
  leaseMs: number,
  bankAccountId: string,
  observedAt: string,
): Promise<void> {
  const statements = await Promise.all(page.transactions.map(async (transaction) => {
    const fingerprint = await sha256(transactionFingerprintInput(transaction));
    const disposition = initialDisposition(transaction, bankAccountId);
    return database.prepare(
      `INSERT INTO sepay_api_observations (
         transaction_uuid, bank_account_id, transaction_date, transfer_type,
         amount_in, amount_out, reference_number, code, webhook_success,
         payload_hash, scan_type, status, reason_code, first_observed_at, last_observed_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sepay_api_reconciliation_cursors
         WHERE scan_key = ? AND scan_mode = ? AND lease_token = ?
           AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )
       ON CONFLICT(transaction_uuid) DO UPDATE SET
         status = CASE WHEN sepay_api_observations.payload_hash <> excluded.payload_hash
           THEN 'MANUAL_REVIEW' ELSE sepay_api_observations.status END,
         reason_code = CASE WHEN sepay_api_observations.payload_hash <> excluded.payload_hash
           THEN 'TRANSACTION_DATA_CHANGED' ELSE sepay_api_observations.reason_code END,
         last_observed_at = excluded.last_observed_at`,
    ).bind(
      transaction.id,
      transaction.bankAccountId,
      transaction.transactionDate,
      transaction.transferType,
      transaction.amountIn,
      transaction.amountOut,
      transaction.referenceNumber,
      transaction.code,
      transaction.webhookSuccess,
      fingerprint,
      scanMode,
      disposition.status,
      disposition.reasonCode,
      observedAt,
      observedAt,
      scanKey,
      scanMode,
      leaseToken,
    );
  }));
  const progress = database.prepare(
    `UPDATE sepay_api_reconciliation_cursors
     SET pending_next_page = ?,
         pending_complete = ?,
         pending_last_transaction_id = ?,
         pending_last_transaction_date = ?,
         pending_last_page_fingerprint = ?,
         pending_last_page = ?,
         pending_total_records = ?,
         lease_expires_at = strftime(
           '%Y-%m-%dT%H:%M:%fZ', julianday('now') + (? / 86400000.0)
         ),
         updated_at = ?
     WHERE scan_key = ? AND scan_mode = ? AND lease_token = ?
       AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(
    page.hasMore ? page.page + 1 : page.page,
    page.hasMore ? 0 : 1,
    page.lastTransactionId,
    page.lastTransactionDate,
    page.fingerprint,
    page.lastPage,
    page.totalRecords,
    leaseMs,
    observedAt,
    scanKey,
    scanMode,
    leaseToken,
  );
  const results = await database.batch([progress, ...statements]);
  if (results[0]?.meta.changes !== 1 ||
      results.slice(1).some((result) => result.meta.changes !== 1)) {
    throw new SePayApiV2LeaseError("LEASE_LOST");
  }
}

async function initializePendingScan(
  database: Database,
  cursor: CursorRow,
  options: RunSePayApiV2ScanOptions,
  leaseToken: string,
  scan: {
    windowStart: string | null;
    windowEnd: string | null;
    sinceId: string | null;
  },
  updatedAt: string,
): Promise<void> {
  const initialized = await database.prepare(
    `UPDATE sepay_api_reconciliation_cursors
     SET pending_window_start = ?,
         pending_window_end = ?,
         pending_since_id = ?,
         pending_next_page = 1,
         pending_complete = 0,
         pending_last_transaction_id = NULL,
         pending_last_transaction_date = NULL,
         pending_last_page_fingerprint = NULL,
         pending_last_page = NULL,
         pending_total_records = NULL,
         updated_at = ?
     WHERE scan_key = ? AND scan_mode = ? AND lease_token = ?
       AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND pending_window_start IS NULL
       AND pending_window_end IS NULL
       AND pending_since_id IS NULL`,
  ).bind(
    scan.windowStart,
    scan.windowEnd,
    scan.sinceId,
    updatedAt,
    options.scanKey,
    options.mode,
    leaseToken,
  ).run();
  if (initialized.meta.changes !== 1) {
    throw new SePayApiV2LeaseError("LEASE_LOST");
  }
  cursor.pending_window_start = scan.windowStart;
  cursor.pending_window_end = scan.windowEnd;
  cursor.pending_since_id = scan.sinceId;
  cursor.pending_next_page = 1;
  cursor.pending_complete = 0;
  cursor.pending_last_transaction_id = null;
  cursor.pending_last_transaction_date = null;
  cursor.pending_last_page_fingerprint = null;
  cursor.pending_last_page = null;
  cursor.pending_total_records = null;
}

export async function runSePayApiV2Scan(
  database: Database,
  client: SePayApiV2Client,
  options: RunSePayApiV2ScanOptions,
): Promise<SePayApiV2ScanResult> {
  if (!options.scanKey.trim() ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(options.bankAccountId)) {
    throw new TypeError("Invalid SePay reconciliation scan identity");
  }
  if ((options.mode === "DATE_WINDOW") !== Boolean(options.dateWindow) ||
      (options.mode === "SINCE_ID" && options.dateWindow)) {
    throw new TypeError("Scan options do not match the selected SePay scan mode");
  }
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > MAX_LEASE_MS) {
    throw new TypeError("Invalid SePay reconciliation lease duration");
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  if (!isValidDate(startedAt)) throw new TypeError("Invalid SePay reconciliation clock");
  const timestamp = startedAt.toISOString();
  const leaseToken = safeId();

  await database.prepare(
    `INSERT INTO sepay_api_reconciliation_cursors (
       scan_key, scan_mode, updated_at
     ) VALUES (?, ?, ?)
     ON CONFLICT(scan_key, scan_mode) DO NOTHING`,
  ).bind(options.scanKey, options.mode, timestamp).run();

  const claimed = await database.prepare(
    `UPDATE sepay_api_reconciliation_cursors
     SET lease_token = ?,
         lease_expires_at = strftime(
           '%Y-%m-%dT%H:%M:%fZ', julianday('now') + (? / 86400000.0)
         ),
         updated_at = ?
     WHERE scan_key = ? AND scan_mode = ?
       AND (
         lease_token IS NULL OR
         lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )`,
  ).bind(
    leaseToken,
    leaseMs,
    timestamp,
    options.scanKey,
    options.mode,
  ).run();
  if (claimed.meta.changes !== 1) throw new SePayApiV2LeaseError("LEASE_HELD");

  let leaseHeld = true;
  let result: SePayApiV2ScanResult | undefined;
  try {
    const cursor = await database.prepare(
      `SELECT scan_mode, cursor_transaction_id, window_end,
              pending_window_start, pending_window_end, pending_since_id,
              pending_next_page, pending_complete, pending_last_transaction_id,
              pending_last_transaction_date, pending_last_page_fingerprint,
              pending_last_page, pending_total_records
       FROM sepay_api_reconciliation_cursors
       WHERE scan_key = ? AND scan_mode = ? AND lease_token = ?`,
    ).bind(options.scanKey, options.mode, leaseToken).first<CursorRow>();
    if (!cursor || cursor.scan_mode !== options.mode) {
      throw new Error("SePay reconciliation cursor is unavailable");
    }

    let scanOptions: SePayApiV2ScanOptions;
    let scannedFrom: string | undefined;
    let scannedThrough: string | undefined;
    const hasPendingDateWindow =
      cursor.pending_window_start !== null || cursor.pending_window_end !== null;
    const hasPendingSinceId = cursor.pending_since_id !== null;
    const hasPending = hasPendingDateWindow || hasPendingSinceId;
    if (cursor.pending_complete !== 0 && cursor.pending_complete !== 1) {
      throw new Error("SePay reconciliation continuation state is invalid");
    }
    if (hasPending &&
        ((options.mode === "DATE_WINDOW" &&
          (!cursor.pending_window_start || !cursor.pending_window_end || hasPendingSinceId)) ||
         (options.mode === "SINCE_ID" &&
          (!hasPendingSinceId || hasPendingDateWindow)))) {
      throw new Error("SePay reconciliation continuation state does not match its scan mode");
    }
    if (cursor.pending_complete === 1 && !hasPending) {
      throw new Error("SePay reconciliation completion state is invalid");
    }

    if (options.mode === "SINCE_ID") {
      const sinceId = hasPending
        ? cursor.pending_since_id
        : cursor.cursor_transaction_id ?? options.initialSinceId ?? null;
      if (!sinceId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(sinceId)) {
        throw new TypeError("SINCE_ID scans require a valid initial transaction UUID");
      }
      if (!hasPending) {
        const initializedAt = now();
        if (!isValidDate(initializedAt)) {
          throw new TypeError("Invalid SePay reconciliation clock");
        }
        await initializePendingScan(database, cursor, options, leaseToken, {
          windowStart: null,
          windowEnd: null,
          sinceId,
        }, initializedAt.toISOString());
      }
      scanOptions = {
        mode: options.mode,
        sinceId,
        bankAccountId: options.bankAccountId,
        perPage: options.perPage,
        maxPages: options.maxPages,
        startPage: cursor.pending_next_page,
        lastTransactionId: cursor.pending_last_transaction_id,
        lastTransactionDate: cursor.pending_last_transaction_date,
        previousPageFingerprint: cursor.pending_last_page_fingerprint,
      };
    } else {
      const window = options.dateWindow!;
      if (!isValidDate(window.initialFrom) || !isValidDate(window.scanThrough)) {
        throw new TypeError("Invalid SePay date-window bounds");
      }
      const overlapMs = window.overlapMs ?? 24 * 60 * 60_000;
      if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs > MAX_OVERLAP_MS) {
        throw new TypeError("Invalid SePay date-window overlap");
      }

      let dateStart: Date;
      let dateEnd: Date;
      if (hasPending) {
        dateStart = new Date(cursor.pending_window_start!);
        dateEnd = new Date(cursor.pending_window_end!);
        const requestedEnd = floorToSecond(window.scanThrough);
        if (!isValidDate(dateStart) || !isValidDate(dateEnd) ||
            dateStart > dateEnd || dateEnd > requestedEnd ||
            dateEnd.getTime() - dateStart.getTime() > MAX_WINDOW_MS) {
          throw new Error("SePay reconciliation date-window continuation is invalid");
        }
      } else {
        dateEnd = floorToSecond(window.scanThrough);
        dateStart = floorToSecond(window.initialFrom);
        if (cursor.window_end) {
          const previousEnd = Date.parse(cursor.window_end);
          if (!Number.isFinite(previousEnd) || dateEnd.getTime() < previousEnd) {
            throw new TypeError("SePay date-window cursor is invalid or ahead of the requested scan");
          }
          dateStart = new Date(Math.max(
            dateStart.getTime(),
            previousEnd - overlapMs,
          ));
          dateStart = floorToSecond(dateStart);
        }
        if (dateStart > dateEnd ||
            dateEnd.getTime() - dateStart.getTime() > MAX_WINDOW_MS) {
          throw new TypeError("SePay date-window range exceeds the supported bound");
        }
        const initializedAt = now();
        if (!isValidDate(initializedAt)) {
          throw new TypeError("Invalid SePay reconciliation clock");
        }
        await initializePendingScan(database, cursor, options, leaseToken, {
          windowStart: dateStart.toISOString(),
          windowEnd: dateEnd.toISOString(),
          sinceId: null,
        }, initializedAt.toISOString());
      }

      scannedFrom = dateStart.toISOString();
      scannedThrough = dateEnd.toISOString();
      scanOptions = {
        mode: options.mode,
        transactionDateFrom: sePayDateFilter(dateStart),
        transactionDateTo: sePayDateFilter(dateEnd),
        bankAccountId: options.bankAccountId,
        perPage: options.perPage,
        maxPages: options.maxPages,
        startPage: cursor.pending_next_page,
        lastTransactionId: cursor.pending_last_transaction_id,
        lastTransactionDate: cursor.pending_last_transaction_date,
        previousPageFingerprint: cursor.pending_last_page_fingerprint,
      };
    }

    let observations = 0;
    const scan = cursor.pending_complete === 1
      ? {
          lastTransactionId: cursor.pending_last_transaction_id,
          lastTransactionDate: cursor.pending_last_transaction_date,
          lastPage: cursor.pending_last_page ?? 0,
          totalRecords: cursor.pending_total_records ?? 0,
          pages: 0,
          complete: true,
          continuationPage: null,
          fingerprint: cursor.pending_last_page_fingerprint,
        }
      : await client.scanTransactions(scanOptions, async (page) => {
          const renewedAt = now();
          if (!isValidDate(renewedAt)) {
            throw new TypeError("Invalid SePay reconciliation clock");
          }
          await persistPage(
            database,
            page,
            options.mode,
            options.scanKey,
            leaseToken,
            leaseMs,
            options.bankAccountId,
            renewedAt.toISOString(),
          );
          observations += page.transactions.length;
        });

    if (!scan.complete) {
      result = {
        status: "partial",
        pages: scan.pages,
        observations,
        lastTransactionId: scan.lastTransactionId,
        continuationPage: scan.continuationPage ?? undefined,
        lastPage: scan.lastPage,
        totalRecords: scan.totalRecords,
        remainingPages: scan.continuationPage === null
          ? 0
          : Math.max(0, scan.lastPage - scan.continuationPage + 1),
        ...(scannedFrom ? { scannedFrom } : {}),
        ...(scannedThrough ? { scannedThrough } : {}),
      };
    } else {
      const completedAt = now();
      if (!isValidDate(completedAt)) {
        throw new TypeError("Invalid SePay reconciliation clock");
      }
      const completed = await database.prepare(
        `UPDATE sepay_api_reconciliation_cursors
         SET cursor_transaction_id = CASE WHEN scan_mode = 'SINCE_ID'
               THEN COALESCE(?, cursor_transaction_id) ELSE NULL END,
             window_start = ?, window_end = ?, scan_completed_at = ?,
             pending_window_start = NULL, pending_window_end = NULL,
             pending_since_id = NULL, pending_next_page = 1, pending_complete = 0,
             pending_last_transaction_id = NULL, pending_last_transaction_date = NULL,
             pending_last_page_fingerprint = NULL, pending_last_page = NULL,
             pending_total_records = NULL,
             lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE scan_key = ? AND scan_mode = ? AND lease_token = ?
           AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).bind(
        scan.lastTransactionId,
        scannedFrom ?? null,
        scannedThrough ?? null,
        completedAt.toISOString(),
        completedAt.toISOString(),
        options.scanKey,
        options.mode,
        leaseToken,
      ).run();
      if (completed.meta.changes !== 1) {
        throw new SePayApiV2LeaseError("LEASE_LOST");
      }
      leaseHeld = false;
      result = {
        status: "completed",
        pages: scan.pages,
        observations,
        lastTransactionId: scan.lastTransactionId,
        lastPage: scan.lastPage,
        totalRecords: scan.totalRecords,
        ...(scannedFrom ? { scannedFrom } : {}),
        ...(scannedThrough ? { scannedThrough } : {}),
      };
    }
  } finally {
    if (leaseHeld) {
      await database.prepare(
        `UPDATE sepay_api_reconciliation_cursors
         SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE scan_key = ? AND scan_mode = ? AND lease_token = ?`,
      ).bind(now().toISOString(), options.scanKey, options.mode, leaseToken).run();
    }
  }
  if (!result) throw new Error("SePay reconciliation scan did not complete");
  return result;
}
