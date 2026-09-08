# Subtitles

Seyirlik finds, judges, downloads and installs subtitles itself. This is what
the subsystem guarantees, what it deliberately does not do, and how to turn it
on.

It exists to replace the application-level job Bazarr was doing. **Bazarr is not
a runtime dependency and must not become one.** Nothing here calls it, reads its
database, or requires it to be running. It is a thing that can be switched off
once this subsystem has been exercised against real media.

## Switched off unless configured

There is one environment variable, `SEYIRLIK_SUBTITLES`, holding JSON:

```json
{
  "libraryRoot": "/absolute/path",
  "providerIds": ["example"],
  "timeoutMs": 30000
}
```

Absent or empty, the subsystem does not exist: no runtime is constructed, no
query is issued, no route is mounted, and the worker's library lane is told to
exclude the three subtitle job types so it never leases work it cannot handle.
A server that has never heard of subtitles behaves exactly as it did before.

The declaration is refused rather than partially understood. An unknown key, a
relative `libraryRoot`, a provider id that is not a plain slug, a duplicate
provider id, or a `timeoutMs` that is not a whole number of milliseconds
between 1 and 300000 all fail the parse. An absent `timeoutMs` defaults to
30 seconds; an explicit `null` does not, because a null where a number belongs
is a mistake rather than a way of saying "unset".

**Secrets are not configuration fields.** There is no cookie, token or password
in this block, and the parser rejects any key it does not know, so one cannot be
smuggled in.

## What a client can ask for

Three administrator-only routes. A client names a catalogue id and a policy —
never a path, a provider URL, or a destination.

| Route                               | What it does                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /subtitles`                   | Records a want and queues a search. Body: `mediaFileId`, `language`, and optionally `forced`, `hearingImpaired`, `replace`. |
| `GET /subtitles/:attemptId`         | State, the provider being waited on, and the failure class. Nothing else.                                                   |
| `POST /subtitles/:attemptId/resume` | Continues an attempt that is waiting for a person to sign in. Refused in any other state.                                   |

The language is normalised to ISO 639-2 at the edge, so `tr`, `TR-tr` and `tur`
are one want, and a sidecar is named `.tur.srt`. A language nothing speaks is
refused rather than searched for.

`failureDetail` never leaves the server. It can carry a provider's own words,
and a provider's words are untrusted text.

## What it will and will not write

The full rules are in [library-file-ownership.md](library-file-ownership.md).
The short version:

- The destination is derived from the media file the catalogue id resolves to.
  No provider, payload, or API client chooses where a byte lands.
- Everything stays inside the configured root, checked after path resolution
  rather than before it, and a symbolic link _below_ the root on the way to a
  file is refused.
- A new file goes in with a no-clobber `link`, so two workers racing produce one
  file and one loser, never a torn one.
- A subtitle is replaced only when `subtitle_installations` holds a row for that
  exact path **and** the recorded digest still matches the bytes on disk.
  `replace` is permission to upgrade Seyirlik's own work, never permission to
  take somebody else's.
- Byte-identical content is a `duplicate`: it satisfies the want, it is not a
  write, and it does not confer ownership.

A known consequence: **a subtitle that arrived with a download cannot currently
be upgraded by this subsystem**, because the importer records no digest for it.
Closing that is a change to the import pipeline, and is recorded there rather
than worked around here.

## The states an attempt can be in

`wanted → searching → selected → downloading → validating → installed`, with
`superseded`, `unavailable` and `failed` as the other terminal answers, and
`needs-authentication` as the one state that is neither finished nor failed.

Two of these matter more than the rest:

**`needs-authentication` is a pause, not a failure.** A provider that wants a
person to prove something has not errored; it is waiting. The job returns that
state rather than throwing, so no retry is spent, the attempt is not marked
failed, and a human response time does not become a retry storm against a site
that already suspects us. The stage reached is checkpointed, and the resume job
re-enters the same implementation with that stage remembered — one code path and
a flag, not a second handler free to drift from the first.

On a deployment with no interactive session host wired in, every session-based
provider answers `needs-authentication` immediately. That is the correct answer
for a headless server: wiring a host in later resumes the work rather than
requiring it to be started again.

**`validating` means bytes may be on the disk that nothing has recorded.** It is
the state a crash between the write and the commit leaves behind. The
`subtitle.reconcile` job walks these: if the file at the derived path matches the
receipt — digest _and_ inode — the installation is recorded and the attempt
finishes without downloading anything again. If it does not match, the attempt
stays in `validating` and raises an `operator-attention` event, because guessing
is worse than asking.

## The three jobs

| Type                   | What it is for                                     |
| ---------------------- | -------------------------------------------------- |
| `subtitle.run`         | One attempt, start to finish.                      |
| `subtitle.auth-resume` | The same work, continued after somebody signed in. |
| `subtitle.reconcile`   | Sweeps attempts a crash could have left uncertain. |

They run on the existing leased queue. A task naming no attempt, or an attempt
that no longer exists, is refused permanently rather than retried — no amount of
retrying makes it valid. A media file another worker is already holding produces
a deferral, not a failure.

One PostgreSQL advisory lock per **media file** serialises every want for that
file across every worker, so two subtitles for one film are never written at the
same moment.

## Session material

A provider session lives in a closure, not on a property. There is no field for
a spread, a serialiser or a debugger snapshot to reach, and `toJSON` and
`toString` are overridden to return `[provider session withheld]` — overridden
rather than merely absent, because a structured logger reaches for `toJSON`
first.

Nothing a job returns, records as an event, or writes to the database carries
it. Migration 024 stores normalised candidate facts and a filesystem receipt;
neither has anywhere to put a cookie, and the checkpoint copies only the fields
the provider contract declares rather than whatever an adapter happened to
attach.

What is **not** implemented, on purpose: there is no Cloudflare bypass, no
CAPTCHA solving, no fingerprint or stealth evasion, and no hard-coded cookie.
`ProviderSessionManager` is an interface with no browser behind it. A real one
means an embedded browser window — a substantial runtime dependency — and
committing to that before the pipeline that consumes it existed would have been
building the expensive half first.

## How far it has been proven

`subtitleWorkflow.e2e.test.ts` runs twenty-nine scenarios against a real
temporary library: real handlers, service, state machine, pipeline, scorer,
payload validator and storage writer, with files written to a disk and read back
from it.

Two things are substituted there, and both matter when reading a green suite:

- **The providers are scripted.** A test that reached a real subtitle site would
  test that site's availability and spend somebody else's rate limit.
- **The execution repository is synthetic.** The real one is PostgreSQL — an
  advisory lock, a checkpoint `UPDATE`, an event `INSERT`. The fake honours the
  same contract, so the service's _use_ of it is covered, but **the SQL in
  `subtitleExecution.ts` and migrations 023–024 have not been run against a real
  database**, and must be before this subsystem is trusted in production.

Nor has any of it run against real media. That waits on the storage phase.

## Before switching it on

1. Apply migrations 023 and 024 — **before or with the code, never after it**.

   Migrations are validated at startup, not applied at startup. `nativeRuntime`
   and the identity runtime both call `validateMigrationsCurrent`, which
   compares every file in `migrations/` against the `seyirlik_migrations` table
   by version _and_ checksum, and throws when they disagree. Deploying a
   checkout that contains 023 and 024 to a host whose database has neither will
   stop the server and the worker from starting at all — not just the subtitle
   subsystem, and not just when it is configured. It is a deployment ordering
   hazard rather than a subtitle one, and it is why this is the first step.

   ```
   npm run db:migrate
   ```

   The role that runs it needs DDL rights on the schema; the application role
   does not need to be that role.

2. Run the execution repository against a real database.
3. Point `libraryRoot` at a synthetic directory first, not at the library.
4. Register at least one provider adapter. A configured provider id with no
   registered adapter is refused at startup rather than discovered at run time.
