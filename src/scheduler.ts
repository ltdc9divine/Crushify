import { randomToken, safeId } from "./http.ts";
import { logSafeError, logSafeInfo } from "./logging.ts";
import { resolvePaymentEnvironmentPolicy } from "./payments/policy.ts";
import { recoverPendingSePayWebhookEvents } from "./payments.ts";
import {
  reconcilePublicationDerivativeCleanup,
  recoverPendingFulfillments,
  runPublicationLifecycle,
  type PublicationDerivativeCleanupResult,
} from "./publications.ts";
import { reconcileUploadAttemptCleanup } from "./assets.ts";
import { DatabaseError } from "./database.ts";
import type { Env } from "./types.ts";

const TASK_NAME = "publication-lifecycle";
const LEASE_SECONDS = 5 * 60;

type ScheduledOperation<T> =
  | { status: "completed"; result: T }
  | { status: "failed"; error_code: "DATABASE_ERROR" | "OPERATION_FAILED" }
  | { status: "skipped"; reason: "runtime_policy" };

async function runOperation<T>(
  name: string,
  category: "lifecycle" | "payment",
  env: Env,
  operation: () => Promise<T>,
): Promise<ScheduledOperation<T>> {
  try {
    return { status: "completed", result: await operation() };
  } catch (error) {
    logSafeError(`scheduler.${name}_failed`, category, error, {
      environment: env.ENVIRONMENT,
    });
    return {
      status: "failed",
      error_code: error instanceof DatabaseError ? "DATABASE_ERROR" : "OPERATION_FAILED",
    };
  }
}

export async function acquireScheduledTaskLease(
  env: Env,
  now: Date,
  token = randomToken(24),
): Promise<string | null> {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid scheduled task time");
  const timestamp = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO scheduled_task_leases (task_name, lease_token, lease_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_name) DO UPDATE SET
       lease_token = excluded.lease_token,
       lease_until = excluded.lease_until,
       updated_at = excluded.updated_at
     WHERE scheduled_task_leases.lease_until <= ?`,
  ).bind(TASK_NAME, token, leaseUntil, timestamp, timestamp).run();
  return result.meta.changes === 1 ? token : null;
}

export async function runScheduledPublicationLifecycle(
  env: Env,
  options: { now?: Date; limit?: number } = {},
): Promise<{
  acquired: boolean;
  failed?: boolean;
  pending?: boolean;
  expired?: number;
  erased?: number;
  retryable?: number;
  operations?: {
    sepayWebhookRecovery: ScheduledOperation<{
      attempted: number;
      pending: number;
    }>;
    fulfillmentRecovery: ScheduledOperation<{
      attempted: number;
      completed: number;
      retryable: number;
      manualReview: number;
    }>;
    publicationLifecycle: ScheduledOperation<{
      expired: number;
      erased: number;
      retryable: number;
    }>;
    uploadCleanup: ScheduledOperation<{
      processed: number;
      cleaned: number;
      retryable: number;
      manualReview: number;
    }>;
    publicationDerivativeCleanup: ScheduledOperation<{
      status: PublicationDerivativeCleanupResult["status"];
      processed: number;
      cleaned: number;
      pending: number;
      deferred: number;
      retryable: number;
      manualReview: number;
      hasMore: boolean;
    }>;
  };
}> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Scheduled maintenance batch size must be between 1 and 100");
  }
  const token = await acquireScheduledTaskLease(env, now);
  if (!token) return { acquired: false };

  const runId = safeId();
  const startedAt = now.toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO scheduled_task_runs (id, task_name, status, started_at)
       VALUES (?, ?, 'RUNNING', ?)`,
    ).bind(runId, TASK_NAME, startedAt).run();
    const paymentPolicy = resolvePaymentEnvironmentPolicy(env);
    const sepayWebhookRecovery = paymentPolicy.sepayWebhookEnabled
      ? await runOperation(
        "sepay_webhook_recovery",
        "payment",
        env,
        () => recoverPendingSePayWebhookEvents(env, limit),
      )
      : { status: "skipped", reason: "runtime_policy" } as const;
    const fulfillmentRecovery = paymentPolicy.fulfillmentEnabled
      ? await runOperation(
        "fulfillment_recovery",
        "payment",
        env,
        () => recoverPendingFulfillments(env, limit, now),
      )
      : { status: "skipped", reason: "runtime_policy" } as const;
    const publicationLifecycle = await runOperation(
      "publication_lifecycle",
      "lifecycle",
      env,
      () => runPublicationLifecycle(env, { now, limit }),
    );
    const uploadCleanup = await runOperation(
      "upload_cleanup",
      "lifecycle",
      env,
      () => reconcileUploadAttemptCleanup(env, { now, limit }),
    );
    const publicationDerivativeCleanup = await runOperation(
      "publication_derivative_cleanup",
      "lifecycle",
      env,
      () => reconcilePublicationDerivativeCleanup(env, { now, limit }),
    );
    if (publicationDerivativeCleanup.status === "completed") {
      const cleanup = publicationDerivativeCleanup.result;
      logSafeInfo(`scheduler.derivative_cleanup_${cleanup.status}`, "lifecycle", {
        environment: env.ENVIRONMENT,
        counts: {
          derivative_cleanup_processed: cleanup.processed,
          derivative_cleanup_cleaned: cleanup.cleaned,
          derivative_cleanup_pending: cleanup.pending,
          derivative_cleanup_deferred: cleanup.deferred,
          derivative_cleanup_failed: cleanup.status === "failed" ? cleanup.retryable : 0,
          derivative_cleanup_retryable: cleanup.retryable,
          derivative_cleanup_manual_review: cleanup.manualReview,
          derivative_cleanup_has_more: cleanup.hasMore ? 1 : 0,
        },
      });
    }
    const cleanupResult = publicationDerivativeCleanup.status === "completed"
      ? publicationDerivativeCleanup.result
      : null;
    const cleanupFailed = cleanupResult?.status === "failed" ||
      cleanupResult?.status === "manual_review";
    const pending = cleanupResult?.status === "pending" ||
      cleanupResult?.status === "deferred" ||
      (publicationLifecycle.status === "completed" &&
        publicationLifecycle.result.retryable > 0) ||
      (uploadCleanup.status === "completed" &&
        (uploadCleanup.result.retryable > 0 || uploadCleanup.result.manualReview > 0)) ||
      (fulfillmentRecovery.status === "completed" &&
        (fulfillmentRecovery.result.retryable > 0 || fulfillmentRecovery.result.manualReview > 0)) ||
      (sepayWebhookRecovery.status === "completed" &&
        sepayWebhookRecovery.result.pending > 0);
    const failed = [
      sepayWebhookRecovery, fulfillmentRecovery, publicationLifecycle, uploadCleanup,
      publicationDerivativeCleanup,
    ]
      .some((operation) => operation.status === "failed") || cleanupFailed;
    const result = {
      acquired: true,
      failed,
      pending: Boolean(pending),
      ...(publicationLifecycle.status === "completed" ? publicationLifecycle.result : {}),
      operations: {
        sepayWebhookRecovery,
        fulfillmentRecovery,
        publicationLifecycle,
        uploadCleanup,
        publicationDerivativeCleanup,
      },
    };
    await env.DB.prepare(
      `UPDATE scheduled_task_runs SET status = ?, completed_at = ?, result_json = ?, error_code = ?
       WHERE id = ? AND status = 'RUNNING'`,
    ).bind(
      failed ? "FAILED" : "COMPLETED",
      new Date().toISOString(),
      JSON.stringify(result),
      failed ? "SCHEDULED_OPERATION_FAILED" : null,
      runId,
    ).run();
    return result;
  } catch (error) {
    const errorCode = error instanceof Error ? error.name.slice(0, 60) : "UNKNOWN_ERROR";
    await env.DB.prepare(
      `UPDATE scheduled_task_runs SET status = 'FAILED', completed_at = ?, error_code = ?
       WHERE id = ? AND status = 'RUNNING'`,
    ).bind(new Date().toISOString(), errorCode, runId).run();
    throw error;
  } finally {
    await env.DB.prepare(
      `UPDATE scheduled_task_leases SET lease_until = ?, updated_at = ?
       WHERE task_name = ? AND lease_token = ?`,
    ).bind(new Date().toISOString(), new Date().toISOString(), TASK_NAME, token).run();
  }
}
