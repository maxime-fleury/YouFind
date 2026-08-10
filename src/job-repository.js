import { db } from "./db.js";

const JOB_STATUSES = new Set([
  "queued",
  "running",
  "paused",
  "done",
  "error",
  "cancelled",
  "interrupted",
]);
const JOB_TYPES = new Set(["scoring", "related-discovery"]);
const MAX_FAILURES = 100;
const MAX_RESULTS = 5000;

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function serializeArray(value, maxLength) {
  return JSON.stringify(Array.isArray(value) ? value.slice(-maxLength) : []);
}

function normalizeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    ...row,
    failures: parseJson(row.failures, []),
    results: parseJson(row.results, []),
    payload: parseJson(row.payload, {}),
  };
}

export function createJobRepository(database) {
  const createJobStmt = database.prepare(`
    INSERT INTO jobs (id, type, mode, status, payload, started_at)
    VALUES ($id, $type, $mode, 'running', $payload, datetime('now'))
  `);
  const getJobStmt = database.prepare("SELECT * FROM jobs WHERE id = ?");
  const updateJobStmt = database.prepare(`
    UPDATE jobs SET
      status = COALESCE($status, status),
      total = COALESCE($total, total),
      completed = COALESCE($completed, completed),
      succeeded = COALESCE($succeeded, succeeded),
      failed = COALESCE($failed, failed),
      current = COALESCE($current, current),
      failures = COALESCE($failures, failures),
      results = COALESCE($results, results),
      error = COALESCE($error, error),
      started_at = COALESCE($started_at, started_at),
      finished_at = COALESCE($finished_at, finished_at)
    WHERE id = $id
  `);
  const interruptRunningJobsStmt = database.prepare(`
    UPDATE jobs
    SET status = 'interrupted',
        error = COALESCE(error, 'Process interrupted before completion'),
        finished_at = datetime('now')
    WHERE status IN ('queued', 'running', 'paused')
  `);

  function getJob(id, expectedType = null) {
    if (typeof id !== "string" || id.length < 1 || id.length > 120) return null;
    const job = normalizeJob(getJobStmt.get(id));
    if (!job || (expectedType && job.type !== expectedType)) return null;
    return job;
  }

  function createJob({ id, type, mode = "", payload = {} }) {
    if (typeof id !== "string" || id.length < 1 || id.length > 120) {
      throw new TypeError("Job id must be a non-empty string");
    }
    if (!JOB_TYPES.has(type)) throw new TypeError(`Unsupported job type: ${type}`);
    createJobStmt.run({
      $id: id,
      $type: type,
      $mode: typeof mode === "string" ? mode.slice(0, 100) : "",
      $payload: JSON.stringify(payload && typeof payload === "object" ? payload : {}),
    });
    return getJob(id);
  }

  function updateJob(id, fields = {}) {
    const values = {
      $id: id,
      $status: JOB_STATUSES.has(fields.status) ? fields.status : null,
      $total: normalizeCounter(fields.total),
      $completed: normalizeCounter(fields.completed),
      $succeeded: normalizeCounter(fields.succeeded),
      $failed: normalizeCounter(fields.failed),
      $current: typeof fields.current === "string" ? fields.current.slice(0, 500) : null,
      $failures: fields.failures !== undefined ? serializeArray(fields.failures, MAX_FAILURES) : null,
      $results: fields.results !== undefined ? serializeArray(fields.results, MAX_RESULTS) : null,
      $error: typeof fields.error === "string" ? fields.error.slice(0, 2000) : null,
      $started_at: fields.startedAt || null,
      $finished_at: fields.finishedAt || null,
    };
    updateJobStmt.run(values);
    return getJob(id);
  }

  function finishJob(id, status, fields = {}) {
    if (!JOB_STATUSES.has(status) || ["queued", "running", "paused", "interrupted"].includes(status)) {
      throw new TypeError(`Invalid terminal job status: ${status}`);
    }
    return updateJob(id, {
      ...fields,
      status,
      finishedAt: fields.finishedAt || new Date().toISOString(),
    });
  }

  function recoverInterruptedJobs() {
    return interruptRunningJobsStmt.run().changes;
  }

  return { createJob, getJob, updateJob, finishJob, recoverInterruptedJobs };
}

const repository = createJobRepository(db);
export const createJob = repository.createJob;
export const getJob = repository.getJob;
export const updateJob = repository.updateJob;
export const finishJob = repository.finishJob;
export const recoverInterruptedJobs = repository.recoverInterruptedJobs;
export { JOB_STATUSES, JOB_TYPES };
