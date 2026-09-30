# Backup and restore

What a backup has to prove before it counts, and the contract between the
script that takes one and the panel that reports it.

## Why this is written down

The restore-verification step counted rows in `schema_migrations`. That table
has never existed here — the real one is `seyirlik_migrations` — so the query
failed, the count came back empty, and the check reported success for years
while verifying nothing. A backup nobody has restored is a hope, not a backup,
and a check that cannot fail is not a check.

So the rule is: **a run is `verified` only when a restore actually happened.**
Not when a dump file exists, not when a script exited zero.

## What a run has to do

1. Read the live facts first — table count, migration count, newest migration.
   Reading them before the dump means a mismatch afterwards is evidence about
   the dump rather than about drift that happened during it.
2. `pg_dump -Fc` to the protected directory.
3. Copy the configuration and the secrets file. Three separate booleans get
   recorded, because a dump without its configuration is a different kind of
   incomplete from configuration without its dump.
4. **Restore into a scratch database and count its tables.** The scratch
   database is dropped afterwards; its name is checked against the production
   database name first, and the run refuses rather than continues if they
   match.
5. Write `manifest.json`.
6. Call `scripts/record-backup-run.ts` with it.

Step 4 is the one that makes the others mean anything.

## The manifest contract

The backup runs in PowerShell because it needs `pg_dump`, the secrets file and
a scratch database — none of which the application should hold open. It cannot
write a row the rest of the system understands, so it leaves a manifest and
`scripts/record-backup-run.ts` records it.

| Key                                              | Meaning                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `startedAt`, `finishedAt`                        | ISO 8601. A run with no `finishedAt` never reported an ending.     |
| `dumpPresent`, `configPresent`, `secretsPresent` | What was found on disk when the run ended.                         |
| `dumpBytes`                                      | Size of the dump.                                                  |
| `schemaVersion`, `schemaCount`                   | The schema **the dump carries**, not the schema now.               |
| `liveTables`, `verifiedTables`                   | Table counts either side of the restore rehearsal.                 |
| `verification`                                   | `verified` only if the rehearsal ran and the counts matched.       |
| `destinationClass`                               | `local-protected`, `removable` or `remote`. A class, never a path. |
| `failureClass`, `failureDetail`                  | Present only on a failed run.                                      |

An unrecognised `destinationClass` or `verification` is narrowed to the
cautious value rather than trusted, so a malformed manifest cannot make a run
look verified.

`schemaVersion` reads as stale on purpose after a deployment: a backup taken
before a migration carries the older schema, and recording the newer one would
describe a dump that does not exist.

## What is deliberately not stored

No password, no secret content, no credential-bearing command, no absolute
path. The destination is a class and what was found is a set of booleans, so
the history can be shown to an operator and put in a log without redaction.

The secrets file _is_ copied into the backup directory — a restore needs it —
but nothing about its contents reaches the database or the panel.

## Reading it back

`GET /admin/backups` returns the newest run, the newest verified run, the last
twenty, and a `health` verdict. The verdict is not "a file exists": it requires
a run that finished, carried both a dump and its configuration, and had a
restore rehearsed. It reports `never-run`, `last-run-failed`, `incomplete`,
`unverified` or `verified`, so a red panel says which of those it is.

## Restoring

Restore into a **new** database and repoint the application, rather than over
the live one. The dump is `-Fc`, so `pg_restore --no-owner --no-privileges` is
what reads it.

Then check the schema before starting the services: they validate migrations at
startup and refuse a schema they do not understand, so a restore of an older
dump needs `npm run db:migrate` from the matching code first. The ordering rule
in [deployment-model.md](deployment-model.md) applies to a restore exactly as
it applies to a deployment.

## The nightly run

`deploy/windows/backup-database.ps1` is the run described above, and
`deploy/windows/install-backup-task.ps1` schedules it as **Seyirlik Nightly
Backup**: 04:30 every night, as SYSTEM, from the active release, at below-normal
priority, catching up after a night the host was off. Each run lands in
`C:\ProgramData\Seyirlik\backups\nightly-<stamp>` (dump, configuration,
secrets, manifest); the newest fourteen are kept. It logs to
`C:\ProgramData\Seyirlik\logs\backup.log` without credentials, and the task
fails if the run was not verified or not recorded.

It does not interrupt anyone watching. On 2026-09-30 a run took about five
seconds for a 4.4 MB dump: `pg_dump` reads a snapshot while playback, progress
and every other write carry on (only a schema change would wait), the database
is on `C:` while films stream from `D:`, and no service is stopped.

A verified run moves the heartbeat's last-verified-backup time, which closes the
alert service's "no verified backup in 36 hours"; a failed one raises "the
backup failed" (see [alerts.md](alerts.md)).
