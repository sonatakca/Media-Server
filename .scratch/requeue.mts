/**
 * Requeues one processing job through the same store + queue calls the admin
 * retry route makes, skipping only the HTTP session it would need. Diagnostic
 * harness for the source-damage acceptance test; not shipped.
 */
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const root = "/Users/sonat/Documents/Development/Media-Server";
for (const line of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  if (!line.includes("=") || line.trim().startsWith("#")) continue;
  const at = line.indexOf("=");
  process.env[line.slice(0, at).trim()] ??= line.slice(at + 1).trim();
}

const { createDatabasePool } = await import(
  "../src/server/ownApi/database/databasePool"
);
const { createProcessingJobStore } = await import(
  "../src/server/ownApi/processing/jobStore"
);
const { createJobQueue } = await import("../src/server/ownApi/tasks/jobQueue");

const pool = createDatabasePool({
  connectionString: process.env.DATABASE_URL ?? "",
} as never);
const store = createProcessingJobStore(pool);
const queue = createJobQueue(pool);

const processingJobId = process.argv[2];
if (!processingJobId) throw new Error("usage: requeue.mts <processingJobId>");

const job = await store.get(processingJobId);
if (!job) throw new Error("no such processing job");
if (["queued", "running", "pending"].includes(job.state)) {
  throw new Error(`job is ${job.state}; refusing to double-queue`);
}

const { rows } = await pool.query(
  "select relative_path, size_bytes from media_files where id = $1",
  [job.mediaFileId] as never,
);
const file = rows[0] as { relative_path: string; size_bytes: string };
const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT ?? "";
const absolutePath = path.join(mediaRoot, ...file.relative_path.split("/"));
const stats = await stat(absolutePath);

await store.beginAttempt(processingJobId, {});
const queueJobId = await queue.enqueue({
  jobType: "media.process",
  payload: {
    processingJobId,
    sourcePath: absolutePath,
    relativePath: file.relative_path,
    sizeBytes: Number(file.size_bytes),
    mtimeMs: stats.mtimeMs,
  },
  dedupeKey: `processing:${job.mediaFileId}:acceptance:${Date.now()}`,
});
await store.attachQueueJob(processingJobId, queueJobId);
await store.appendEvent({
  processingJobId,
  stage: "waiting",
  message: "Re-queued for the source-damage acceptance test.",
});
console.log(
  JSON.stringify(
    { processingJobId, queueJobId, absolutePath, mtimeMs: stats.mtimeMs },
    null,
    2,
  ),
);
await pool.end?.();
