import { readFileSync } from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  readFileSync("/Users/sonat/Documents/Development/Media-Server/.env", "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);
const connectionString =
  env.SEYIRLIK_DATABASE_URL ?? env.DATABASE_URL ?? "";
const pool = new pg.Pool({ connectionString, max: 2 });

const q = async (label: string, sql: string, params: unknown[] = []) => {
  const result = await pool.query(sql, params as never);
  console.log(`\n=== ${label} ===`);
  console.table(result.rows);
};

await q("migrations", "select version from seyirlik_migrations order by version desc limit 4");
await q(
  "source_damage column",
  "select column_name from information_schema.columns where table_name='processing_jobs' and column_name in ('source_damage','paused_reason')",
);
await q(
  "pirates jobs",
  `select pj.id, pj.state, pj.stage, pj.error_code, pj.attempts,
          pj.completed_epochs, pj.epoch_count, round(pj.protected_seconds::numeric,1) as protected_s,
          pj.source_damage is not null as has_damage, mf.relative_path, mf.size_bytes, mf.id as media_file_id, pj.item_id
     from processing_jobs pj
     join media_files mf on mf.id = pj.media_file_id
    where mf.relative_path ilike '%Dead Man%'
    order by pj.created_at desc limit 5`,
);
await q(
  "queued media.process",
  `select id, status, attempts, max_attempts, left(coalesce(safe_error,''),80) as err, queued_at
     from jobs where job_type='media.process' and status in ('queued','running','pending')
    order by queued_at desc limit 5`,
);
await pool.end();
