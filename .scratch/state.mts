import { readFileSync } from "node:fs";
import pg from "pg";
const root = "/Users/sonat/Documents/Development/Media-Server";
for (const line of readFileSync(`${root}/.env`, "utf8").split("\n")) {
  if (!line.includes("=") || line.trim().startsWith("#")) continue;
  const at = line.indexOf("=");
  process.env[line.slice(0, at).trim()] ??= line.slice(at + 1).trim();
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const id = "c00e1a1f-c9b2-4f4b-940d-53fec686cf9e";
const job = await pool.query(
  `select state, stage, round(stage_progress::numeric,3) as stage_p, round(overall_progress::numeric,4) as overall,
          completed_epochs, epoch_count, round(protected_seconds::numeric,1) as protected_s,
          speed, fps, eta_seconds, error_code, left(coalesce(error_message,''),120) as err,
          source_damage is not null as damaged, attempts, paused_reason
     from processing_jobs where id = $1`, [id] as never);
console.table(job.rows);
if (job.rows[0]?.damaged) {
  const d = await pool.query(`select jsonb_pretty(source_damage::jsonb) as d from processing_jobs where id=$1`, [id] as never);
  console.log(d.rows[0].d);
}
const events = await pool.query(
  `select sequence, to_char(created_at,'HH24:MI:SS') as at, stage, level, left(message, 160) as message
     from processing_job_events where processing_job_id = $1 order by sequence desc limit $2`,
  [id, Number(process.argv[2] ?? 18)] as never);
console.table(events.rows.reverse());
const q = await pool.query(
  `select id, status, attempts, max_attempts, left(coalesce(safe_error,''),100) as err
     from jobs where job_type='media.process' order by queued_at desc limit 3`);
console.table(q.rows);
await pool.end();
