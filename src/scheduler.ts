import { randomToken, safeId } from "./http.ts";
import { runPublicationLifecycle } from "./publications.ts";
import { reconcileUploadAttemptCleanup } from "./assets.ts";
import type { Env } from "./types.ts";

const TASK_NAME = "publication-lifecycle";
const LEASE_SECONDS = 5 * 60;

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
  expired?: number;
  erased?: number;
  retryable?: number;
}> {
  const now = options.now ?? new Date();
  const token = await acquireScheduledTaskLease(env, now);
  if (!token) return { acquired: false };

  const runId = safeId();
  const startedAt = now.toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO scheduled_task_runs (id, task_name, status, started_at)
       VALUES (?, ?, 'RUNNING', ?)`,
    ).bind(runId, TASK_NAME, startedAt).run();
    const result = await runPublicationLifecycle(env, {
      now,
      limit: options.limit ?? 10,
    });
    const uploadCleanup = await reconcileUploadAttemptCleanup(env, {
      now,
      limit: options.limit ?? 10,
    });
    await env.DB.prepare(
      `UPDATE scheduled_task_runs SET status = 'COMPLETED', completed_at = ?, result_json = ?
       WHERE id = ? AND status = 'RUNNING'`,
    ).bind(new Date().toISOString(), JSON.stringify({ ...result, uploadCleanup }), runId).run();
    return { acquired: true, ...result };
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
