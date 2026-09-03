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
let after = Number(process.argv[2] ?? 0);
let lastState = "";
for (;;) {
  try {
    const ev = await pool.query(
      `select sequence, stage, level, left(message,200) as message
         from processing_job_events where processing_job_id=$1 and sequence > $2
         order by sequence limit 50`, [id, after] as never);
    for (const r of ev.rows as { sequence: number; stage: string; level: string; message: string }[]) {
      after = r.sequence;
      if (/^(Dropping|Keeping|Analysing \d|Choosing|Progress weights|Package )/.test(r.message)) continue;
      const t = new Date().toTimeString().slice(0, 8);
      console.log(`[${t}] #${r.sequence} ${r.stage}/${r.level}: ${r.message}`);
    }
    const j = await pool.query(
      `select state, stage, completed_epochs, source_damage is not null as damaged,
              left(coalesce(error_message,''),140) as err from processing_jobs where id=$1`, [id] as never);
    const row = j.rows[0] as { state: string; stage: string; completed_epochs: number; damaged: boolean; err: string };
    const key = `${row.state}/${row.stage}/${row.completed_epochs}/${row.damaged}`;
    if (key !== lastState) {
      lastState = key;
      const t = new Date().toTimeString().slice(0, 8);
      console.log(`[${t}] STATE ${key}${row.err ? ` err=${row.err}` : ""}`);
    }
    if (["succeeded", "failed", "cancelled"].includes(row.state)) {
      console.log(`[${new Date().toTimeString().slice(0, 8)}] TERMINAL ${row.state}`);
      break;
    }
  } catch (error) {
    console.log(`[poll error] ${(error as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
await pool.end();
