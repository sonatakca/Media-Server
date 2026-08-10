# Jellyfin Removal Verification Record

This is a live record. A phase is not complete merely because TypeScript compiles. Commands, failures, manual checks, limitations, remaining dependencies, and regression risks are recorded separately.

## Repository protection baseline

Recorded at the start of the migration on 2026-07-23.

- Branch: `main`.
- The first status snapshot saw HEAD `6014821 auth page redirect hotfix` with 54 paths already staged (6,695 insertions, 4,806 deletions) and no unstaged changes.
- A concurrent external action committed exactly that staged change set as `54ef745 v2.2.1.7` at `2026-07-23 16:04:43 +0300` and updated `origin/main` while the read-only baseline commands were in progress. This migration did not create that commit or push it.
- Current baseline for migration edits is therefore HEAD `54ef745`; only the four Phase 0 documents were untracked immediately after creation.
- The pre-existing change set includes substantial UI/CSS/refactoring, Jellyfin URL helpers/tests, user management, admin models, and playback reporting changes.
- Migration edits must not overwrite/revert that work.
- This migration has performed no commit, push, reset, clean, checkout, restore, PR, publication, or deployment.

## Phase 0 — Inventory and contracts

### Commands executed

```text
git branch --show-current
git status --short
git diff --stat
git diff --cached --stat
git log -1 --oneline --decorate
npm test -- --run
npm run build
npx prettier --check "src/**/*.{ts,tsx,js,jsx,css}" "*.{json,js,ts,css,md}"
node --version
npm --version
command -v ffmpeg && ffmpeg -version
command -v ffprobe && ffprobe -version
```

Repository inspection also enumerated source/docs/tests/config, read the manifest, Vite/Vercel/TypeScript configuration, README, native playback architecture, backend/server modules, auth storage, Jellyfin API/types, SyncPlay modules, and performed source-wide semantic searches excluding `node_modules`, `.git`, and generated bundles from primary results.

### Tests passed

- Production typecheck + Vite/PWA build: **passed**.
- Full Vitest suite: **290 of 294 tests passed** across **46 of 49 test files**.
- FFmpeg available at execution time: version `8.1.2`.
- ffprobe available at execution time: version `8.1.2`.
- Node: `v22.23.1`; npm: `10.9.8`.

### Pre-existing test failures

The following failures occurred before migration code was added and are baseline failures, not migration regressions:

1. `src/lib/jellyfinApi.test.ts > getNextEpisodeInSeason > returns the next higher-index episode from the same season`
   - Test expects `/Shows/Episodes`; implementation calls `/Shows/:seriesId/Episodes`.
2. `src/lib/jellyfinApi.test.ts > getNextEpisodeInSeason > falls back to the season parent items endpoint when the series endpoint is empty`
   - Same endpoint expectation mismatch on the first request.
3. `src/lib/playTarget.test.ts > play target resolver > falls back to the series library route when a show has no episodes`
   - Expected `/library/series-1`; actual `/shows/series-1`.
4. `src/components/player/PlayerQueuePanel.test.tsx > PlayerQueuePanel > marks watched items and prevents replaying the current item`
   - Expected text `İzlendi` is not rendered; the watched control is present with translation-key aria text.

Vitest also reports a pre-existing invalid nested-button warning in the player queue and React Router v7 future-flag warnings.

### Formatting failures

Prettier check failed before migration edits on 12 files:

```text
src/components/player/CustomVideoPlayer.css
src/components/TimedMediaGallery.tsx
src/lib/episodeMetadataPreferences.ts
src/lib/playback-planner/customPlaybackApi.test.ts
src/lib/playback-planner/ffmpegRuntime.test.ts
src/lib/playback-planner/nativeClientProfile.ts
src/lib/playback-planner/playbackRoutes.ts
src/lib/playbackEnvironmentDiagnostics.ts
src/lib/seo.ts
src/lib/serverConnectionDiagnostics.ts
src/pages/ServerSetupPage.tsx
vite.config.ts
```

These files must not be mass-formatted because some are part of the user's existing staged work. New migration files must pass targeted formatting independently.

### Manual checks completed

- Confirmed repository has no Dockerfile/Compose/reverse-proxy configuration.
- Confirmed Vercel deployment is static and rewrites application paths to `index.html`.
- Confirmed native Node playback backend is optional and starts separately.
- Confirmed no application database, durable queue, or native WebSocket server exists.
- Confirmed existing backend uses trusted-root checks, byte ranges, FFmpeg HLS, bounded transcode concurrency, and graceful shutdown.
- Confirmed browser media auth token is stored in localStorage and appended to Jellyfin media URLs.
- Confirmed backend environment startup requires Jellyfin URL and API key.
- Confirmed native playback still resolves item paths from Jellyfin and its frontend plan is mapped back into Jellyfin-shaped DTOs.

### Known limitations

- No native authentication, user database, catalogue, scanner, metadata cache, durable jobs, trickplay generator, settings store, or SyncPlay server exists yet.
- Native playback is a substantial partial implementation but is not authorized by native media-user sessions and is still dependent on Jellyfin for production item-to-file resolution.
- Health currently exposes only `/health` with a static process status and does not distinguish dependencies.
- Existing Vercel routing would send `/ownAPI/v1/...` to the SPA unless deployment/reverse-proxy routing is changed.
- No Docker build can be verified because Docker artifacts do not exist.
- No end-to-end browser framework is configured.

### Remaining Jellyfin dependencies

All parity-matrix rows remain active. Key blockers are frontend auth/catalogue/data shapes, backend media resolution, TMDB item lookup, SyncPlay REST/WebSocket, environment startup, PWA exclusions, and generated bundles.

### Regression risks

- The working tree contains a large staged behavior-preserving refactor; overlapping edits can damage unrelated work.
- `JellyfinItem` is used as a broad view model throughout components, so deleting DTOs before adapters exist would cause high-risk UI regressions.
- Existing native playback tests are valuable and must be preserved while route/auth contracts change.
- Static deployment and self-hosted media-backend requirements are currently mismatched.

## Phase 1 — Native `/ownAPI/v1/` foundation

_Status: foundation verified; database-backed readiness and native authentication remain future gates._

### Implemented

- Mounted `GET /ownAPI/v1/health` inside the existing Node backend without removing legacy playback/TMDB routes.
- Added validated/generated request IDs, response correlation headers, `Cache-Control: no-store`, structured success/error envelopes, safe 404/405/500 handling, route-template-only request logging, and default-deny authorization helpers for future protected routes.
- Added real FFmpeg, ffprobe, readable-media-root, and writable-generated-storage probes with bounded timeouts, TTL caching, and concurrent-request coalescing. The configured ffprobe binary and generated-storage path are used by both health and playback. Database reports `unavailable` and jobs report `disabled` honestly until those systems exist; either state prevents readiness.
- Added credential-safe allowlisted CORS headers, expanded methods for the versioned API, and request IDs plus sanitized completion logs on rejected own-API origins. Production defaults to no cross-origin allowlist while still permitting true same-origin requests. Direct requests derive the effective origin from transport plus `Host`; trusted TLS proxies use explicit `SEYIRLIK_PUBLIC_ORIGIN` rather than untrusted forwarded headers. An explicit `SEYIRLIK_ALLOWED_ORIGINS` value replaces rather than extends defaults, normalizes valid HTTP(S) origins, and rejects wildcard, opaque, credential-bearing, or path-bearing values.
- Added a typed browser client under `src/api/ownApi/` using only the relative `/ownAPI/v1` base path, cookie credentials, strict outgoing/header/envelope request-ID equality, runtime health-DTO validation, single and paginated envelope handling, normalized malformed/network/serialization failures, abort signals, auth-expiry callbacks, and no hidden retry.
- Added `npm run audit:jellyfin` as a fail-closed runtime/source/config audit gate. Intentionally named audit code and migration documentation are excluded from the runtime failure count, and audit paths are normalized to portable `/` separators before exclusion matching.

Foundation runtime configuration now includes `SEYIRLIK_FFPROBE_PATH`, `SEYIRLIK_GENERATED_STORAGE`, `SEYIRLIK_ALLOWED_ORIGINS`, and `SEYIRLIK_PUBLIC_ORIGIN` alongside the existing FFmpeg configuration. These values select runtime resources, replace the CORS allowlist, or identify the trusted canonical origin behind a TLS proxy; none are returned by health or structured errors.

### RED evidence

The focused tests were observed failing before implementation:

```text
npx vitest run src/server/ownApi/ownApiHandler.test.ts
# exit 1: ./ownApiHandler did not exist

npx vitest run src/server/ownApi/runtimeHealthService.test.ts
# exit 1: ./runtimeHealthService did not exist

npx vitest run src/server/playbackBackend.test.ts -t "mounts the native API health route"
# exit 1: expected 200, received 404

npx vitest run src/server/playbackBackend.test.ts -t "CORS"
# exit 1: two failures (missing credential header and denied-request correlation)

npx vitest run src/api/ownApi/client.test.ts
# exit 1: ./client did not exist
```

### GREEN and regression evidence

```text
npx vitest run src/server/ownApi/ownApiHandler.test.ts src/server/ownApi/runtimeHealthService.test.ts src/server/playbackBackend.test.ts
# exit 0: 3 files, 30 tests passed (before the later CORS test was added)

npx vitest run src/server/playbackBackend.test.ts -t "CORS"
# exit 0: 3 selected tests passed

npx vitest run src/server/ownApi src/api/ownApi src/server/playbackBackend.test.ts
# exit 0: 4 files, 38 tests passed

npx vitest run src/server/ownApi/ownApiHandler.test.ts src/server/ownApi/runtimeHealthService.test.ts src/api/ownApi/client.test.ts src/server/playbackBackend.test.ts src/server/analysisCache.test.ts
# exit 0 after the second independent-review remediation and health-DTO hardening: 5 files, 60 tests passed

npx tsc --noEmit
# exit 0 after the concurrent HeroSection edit was corrected by its external editor

npm run build
# exit 0 after the native-bootstrap slice; TypeScript + Vite/PWA production build passed

VITE_SERVER_BOOTSTRAP_PROVIDER=own-api npm run build
# exit 0: the explicit native-bootstrap production bundle and PWA service worker were generated successfully

npm test -- --run
# exit 1 after adding permanent 204-correlation coverage: 337 of 341 tests passed across 52 of 55 files; only the same four documented baseline failures remain

npx vitest run src/App.bootstrap.test.tsx src/components/ServerConnectionErrorPage.test.tsx src/lib/serverAvailability.test.ts src/api/ownApi/client.test.ts src/server/ownApi/ownApiHandler.test.ts src/server/ownApi/runtimeHealthService.test.ts src/server/playbackBackend.test.ts src/server/analysisCache.test.ts
# exit 0: 8 files, 71 focused tests passed

npx prettier --check <all migration files and modified integration files>
# exit 0
```

During review, an unrelated concurrent edit temporarily left malformed JSX in `src/components/HeroSection.tsx`, blocking TypeScript and the build. Its external editor corrected it without this migration touching that file. The canonical TypeScript and production-build gates now pass again. `src/components/HeroSection.tsx` and `src/components/TimedCarouselIndicators.tsx` remain concurrent modified files and are not attributed to this migration.

A live temporary backend was started with a configured media root and queried through HTTP:

```text
GET /ownAPI/v1/health
status: 200
requestId header/body: live-smoke-request
alive: true
ready: false
database: unavailable
jobs: disabled
ffmpeg: available
ffprobe: available
mediaStorage: available
generatedStorage: writable
```

No private path, command, version, environment value, credential, or stack trace appeared in that response.

A post-review live smoke used the configured generated-storage path for both health and the playback session manager and returned:

```text
status: 200
cache-control: no-store
requestId header/body: review-smoke-request
alive: true
ready: false
jobs: disabled
generatedStorage: writable
sessionOutputRootMatches: true
```

The first ad-hoc `tsx -e` attempt for this additional smoke exited 1 because top-level await is unsupported in its CommonJS eval mode. Wrapping the same check in an async function corrected the command; the result above is from the successful rerun.

A second-remediation live smoke sent an `Origin` equal to the direct backend origin through the strict browser client and a raw request. It returned:

```text
clientAlive: true
clientReady: false
sameOriginStatus: 200
access-control-allow-origin: absent (correct for same-origin)
requestId header/body: same-origin-live
cache-control: no-store
```

The same strict client rejected missing or mismatched correlation in focused tests instead of accepting an uncorrelated response.

The provider-gated bootstrap slice was also exercised through a real Vite development proxy and temporary native backend:

```text
GET http://127.0.0.1:5179/ownAPI/v1/health
status: 200
content-type: application/json; charset=utf-8
requestId header/body: vite-bootstrap-smoke
alive: true
ready: false
SPA HTML response: false
```

The temporary backend and Vite processes were stopped, and ports `43110` and `5179` were verified closed. Adapter and App tests prove that native mode does not invoke the Jellyfin probe on success, failure, diagnostics, or retry. This is local/runtime evidence only; no production reverse-proxy route was provisioned.

The current fail-closed migration audit reports:

```text
npm run audit:jellyfin
# exit 1 (expected until final removal)
# 263 source/config files scanned; 148 files with matches; 2,400 legacy-pattern matches

node scripts/audit-jellyfin-runtime.mjs --report-only --include-docs --include-generated
# exit 0 in report-only mode
# 299 files scanned; 168 files with matches; 3,069 pattern matches including docs and generated bundles
```

The count increased from the foundation checkpoint because this transitional slice adds a provider adapter and tests that explicitly name and verify the retained Jellyfin rollback path. It does not represent runtime removal progress. The audit remains fail-closed, and the added fallback references must be deleted when bootstrap parity is enabled without rollback.

### Independent review remediation

An independent read-only review initially withheld approval. It identified production CORS override semantics, caller-controlled path logging, ffprobe/generated-storage configuration drift, permissive `jobs: disabled` readiness, unbounded dependency probes, cacheable health responses, browser-client malformed/network/pagination gaps, and non-portable audit exclusion matching. Those findings were reproduced or covered with failing tests, corrected, and rerun.

A second independent read-only review then found two remaining logic defects: an empty production cross-origin allowlist rejected legitimate Origin-bearing same-origin requests, and the browser accepted missing or mismatched response correlation. Both were reproduced with red tests. Same-origin requests now compare against the direct transport/`Host` origin or explicit trusted `SEYIRLIK_PUBLIC_ORIGIN`; no forwarded header is trusted implicitly, with an explicit negative test for spoofed forwarded origin headers. Explicit CORS values are normalized and unsafe origin forms are rejected. The client now requires the outgoing, response-header, and success/error-envelope IDs to be valid and identical, while `204` requires the matching header. Health DTOs are also validated against their finite runtime contract. Denied native CORS requests emit sanitized route-template completion logs, and request-body serialization failures are distinguished from network failures. The remediation-focused suite now covers 5 files and 60 tests.

A final independent read-only review of the remediated foundation and provider-gated bootstrap slice returned **PASS** with no blocking security or logic findings. It independently reran focused tests, TypeScript, formatting, diff checks, and the full-suite comparison; it confirmed no hidden legacy-provider call in native success, failure, diagnostics, or retry. Its only non-blocking finding was stale wording in `own-api-contract.md` claiming the client was not wired into a screen; that contract wording is now corrected. The reviewer also confirmed that native mode is safe to keep disabled until production `/ownAPI/*` routing is provisioned.

An earlier third review result arrived after that final review. It also returned **PASS** with no unresolved security or logic findings. Its useful remaining suggestion was permanent direct coverage for matching, missing, and mismatched `X-Request-Id` values on HTTP 204. Those three cases are now covered in `src/api/ownApi/client.test.ts`; the focused suite, full-suite comparison, TypeScript, and production build were rerun afterward.

### Verification gate

- [x] Request ID generated/validated and returned in header/body.
- [x] Invalid, duplicated, and oversized caller request IDs are replaced; client header overrides cannot replace its validated correlation ID.
- [x] Structured unknown-route and method errors contain a safe request ID.
- [x] Health distinguishes database, jobs, FFmpeg, ffprobe, media storage, and generated storage without exposing paths or versions; probes are bounded and responses are not stored.
- [x] CORS remains allowlist-based and permits credentials only for an explicitly reflected cross-origin caller; production defaults to same-origin-only without rejecting Origin-bearing same-origin requests.
- [x] Existing playback/TMDB routes continue to pass their focused backend suite.
- [x] Existing backend graceful HTTP/FFmpeg shutdown tests continue to pass.
- [x] Focused tests were observed failing before implementation, then passing.
- [x] Canonical TypeScript and production build pass; the full suite has only the four documented baseline failures.
- [x] Provider-gated native bootstrap, retry, strict health validation, local Vite proxying, and no-hidden-fallback behavior pass focused tests and a live local proxy smoke.
- [ ] Production `/ownAPI/v1/*` reverse-proxy routing is provisioned and smoke-tested; native bootstrap remains disabled in production until then.
- [ ] Database and durable job infrastructure become available and readiness becomes true.
- [x] Provider-gated native authentication is connected to PostgreSQL users and durable opaque sessions; native catalogue authorization remains pending.

### Remaining limitations and risks

- This remains infrastructure rather than Jellyfin parity. Native authentication exists, but no native sign-in screen, catalogue, state, or authorized playback endpoint exists yet.
- Database availability now participates in native runtime readiness. Overall `ready: false` remains intentional while durable jobs are disabled.
- Native mode validates `/auth/me` and fails closed on a dedicated foundation gate; it never renders the Jellyfin login or protected catalogue. The normal Jellyfin UI remains unchanged in default Jellyfin mode.
- Vercel reserves `/ownAPI/v1/*` ahead of the SPA fallback and returns correlated JSON `503 PRODUCTION_ROUTING_UNAVAILABLE`. A confirmed persistent-backend reverse proxy is still required before production enablement.
- The audit remains red by design and demonstrates that Jellyfin removal is nowhere near its final gate.
- `npm audit --omit=dev --audit-level=high` exits 1 with 10 transitive findings: 2 high-severity `@xmldom/xmldom` findings through `epubjs`, plus 8 moderate React Router and `uuid` dependency findings. Suggested complete fixes include breaking dependency changes. This phase added `argon2`, `pg`, and `@types/pg`; none of the reported advisory chains originate from those additions. No unrelated forced upgrade was applied.

### Final repository snapshot for this phase

Observed after the foundation and provider-gated bootstrap-slice checks on 2026-07-23:

```text
branch: main
HEAD: 54ef745 (v2.2.1.7)
staged changes: none
modified tracked files:
  README.md
  package.json
  src/App.tsx
  src/components/ServerConnectionErrorPage.tsx
  src/lib/playback-planner/mediaAnalysis.ts
  src/lib/playback-planner/playbackSessionManager.ts
  src/server/analysisCache.test.ts
  src/server/analysisCache.ts
  src/server/playbackBackend.test.ts
  src/server/playbackBackend.ts
  vite.config.ts
concurrent modified tracked files not owned by this migration:
  src/components/HeroSection.tsx
  src/components/TimedCarouselIndicators.tsx
untracked migration files/directories:
  docs/jellyfin-parity-matrix.md
  docs/jellyfin-removal-plan.md
  docs/jellyfin-removal-verification.md
  docs/own-api-contract.md
  scripts/audit-jellyfin-runtime.mjs
  src/App.bootstrap.test.tsx
  src/api/ownApi/client.test.ts
  src/api/ownApi/client.ts
  src/components/ServerConnectionErrorPage.test.tsx
  src/lib/serverAvailability.test.ts
  src/lib/serverAvailability.ts
  src/server/ownApi/ownApiHandler.test.ts
  src/server/ownApi/ownApiHandler.ts
  src/server/ownApi/runtimeHealthService.test.ts
  src/server/ownApi/runtimeHealthService.ts
```

No commit, push, reset, clean, checkout, staging change, or other destructive Git operation was performed for this phase.

## Durable native identity foundation — 2026-07-24

This bounded phase added PostgreSQL migrations and repositories, explicit Argon2id credentials, transactional administrator provisioning, durable opaque session families, atomic refresh rotation/reuse revocation, native auth HTTP endpoints, signed CSRF, strict direct-origin checks, secure cookies, bounded rate limiting, frontend runtime validation, and provider isolation.

Observed verification:

```text
Live PostgreSQL 17 integration (serial, loopback-only):
  4 files passed; 14 tests passed

Focused own API/backend/frontend identity suite:
  14 files passed; 101 tests passed; 4 integration files / 14 tests skipped without the database variable

Native frontend bootstrap/client suite:
  3 files passed; 28 tests passed

npm run build:
  exit 0; TypeScript and Vite production build passed

npx tsc --noEmit && git diff --check:
  exit 0

npm test -- --run (database variable unset):
  64 files passed; 3 failed; 4 skipped
  384 tests passed; 4 documented baseline tests failed; 14 database tests skipped
```

The four full-suite baseline failures remain outside this phase: two stale next-episode endpoint expectations in `jellyfinApi.test.ts`, one stale series route expectation in `playTarget.test.ts`, and one translated watched-label expectation in `PlayerQueuePanel.test.tsx`. Native identity focused and live-database gates are green.

Database integration files intentionally reset a shared test schema and therefore must be run serially with `--maxWorkers=1 --no-file-parallelism`. Running those destructive integration files concurrently against the same database causes cross-suite table drops and is not valid verification.

Provider behavior is closed and explicit: absent flags remain Jellyfin; malformed values fail; native backend startup requires the database, current migration checksums, and independent session/CSRF secrets; native frontend bootstrap forces own-API health plus `/auth/me` and does not persist or invoke a Jellyfin fallback URL. Because no native catalogue slice exists, successful native bootstrap stops at an honest foundation gate rather than entering Jellyfin-backed routes.

Production remains disabled. The Vercel guard proves `/ownAPI/v1/health` and `/ownAPI/v1/auth/me` cannot fall through to SPA HTML, but it deliberately returns JSON 503 and does not host PostgreSQL or authentication. Replace it with a same-origin route to the persistent Node backend and repeat cookie, CSRF, correlation, restart, and database durability smoke tests before changing production provider flags.

## Phase 4-6 foundation — native catalogue schema, router, scanner, probe inventory (2026-08-10)

Scope of this pass: the durable catalogue substrate that every remaining native
slice depends on. No production flag changed; Jellyfin remains the default
provider and no frontend module was rewired yet.

Delivered and covered by tests:

- `002_catalogue.sql` and `003_user_state_and_operations.sql`: libraries and
  roots, per-user library permissions, logical items separated from
  `media_files`, normalized `media_streams`, chapters, genres, people, cached
  images, segments, trickplay sets, user item state, settings, devices, a durable
  job queue with leases, activity, playback sessions, and SyncPlay groups.
- `ownApi/api/`: path-parameter router with per-route access levels, strict
  Origin plus session-bound CSRF on every mutation, fixed route templates for
  logging, success/collection/accepted envelopes, and opaque keyset cursors.
- `ownApi/scanner/`: pure name parsing (movies, series, seasons, episodes,
  multi-episode ranges, specials, books, trailers, external subtitle suffixes),
  an injectable-filesystem tree walker, and an idempotent reconciler.
- `ownApi/probe/`: pure ffprobe-to-row mapping plus a batch probe service that
  persists streams, chapters and runtime and stores only sanitized errors.
- `ownApi/catalogue/`: read repository with library visibility enforced inside
  SQL, and a separate scan-write store that preserves locked metadata fields.

Behavioural decisions worth recording:

- Session and CSRF cookies moved from `Path=/ownAPI/v1/auth` to `Path=/ownAPI/v1`.
  Catalogue, image, media and WebSocket requests are authorized by the same
  cookie, so the narrower scope would never have sent it.
- Item identity is derived from on-disk location, not from the title, so a
  re-encode or a container change re-attaches to the existing item and its watch
  history instead of creating a duplicate.
- Reconciliation never deletes immediately. A vanished item is marked missing and
  removed only after a grace period, and a scan in which more than half the known
  files disappear suppresses removals entirely unless an administrator forces it.
  An unmounted volume therefore cannot erase watch history.

Verification:

```text
npx tsc --noEmit -p tsconfig.json:
  exit 0

npx vitest run:
  86 files passed; 3 failed; 4 skipped
  539 tests passed; 4 documented baseline tests failed; 14 database tests skipped
```

The four failures are exactly the documented baseline set (two stale next-episode
expectations in `jellyfinApi.test.ts`, one stale series route expectation in
`playTarget.test.ts`, one translated watched-label expectation in
`PlayerQueuePanel.test.tsx`). No new failure was introduced.

Known limitations of this pass: the SQL in `catalogueScanStore.ts`,
`catalogueRepository.ts` and `probeService.ts` is unit-typed but not yet
integration-verified, because this pass ran on a host with neither a PostgreSQL
instance nor the media volume. Those files need a live-database run before their
parity rows may be marked verified. No catalogue HTTP route, metadata provider,
image endpoint, playback authority, trickplay, SyncPlay or frontend cutover is
implemented yet.

## Phase 6-10 — native catalogue API, playback authority, durable jobs (2026-08-10)

Second pass of the same session. The backend is now able to run with Jellyfin
stopped; the frontend has not been cut over yet, so the shipped app still uses
the Jellyfin client.

Delivered:

- `ownApi/catalogue/`: native `ItemDto` (camelCase, millisecond runtimes, RFC
  3339 dates, opaque ids, no filesystem paths), batched artwork and user-state
  enrichment, keyset pagination, and routes for libraries, items, streams,
  chapters, segments, trailers, movies, series, seasons, episodes, next episode,
  first-unwatched, home aggregate, continue-watching, next-up, latest, search,
  genres, favourites and collections.
- `ownApi/progress/`: sequence-protected progress writes, played/unplayed,
  favourites, and Seyirlik's recursive reset/mark-watched behaviour preserved as
  single endpoints rather than N client requests.
- `ownApi/playback/`: `/playback/plan` and `/playback/sessions` over the stored
  ffprobe inventory, native `DIRECT_PLAY`/`REMUX`/`DIRECT_STREAM`/`TRANSCODE`
  modes with stable reason codes, durable session rows, byte-range file
  delivery, HLS playlist and segment delivery, and idle session expiry that
  stops the FFmpeg process rather than only marking the row ended.
- `ownApi/tasks/`: PostgreSQL job queue with leases, `SKIP LOCKED` claiming,
  dedupe keys, cooperative cancellation, backoff, a draining worker, scan and
  probe handlers, and admin task routes.
- `ownApi/libraries/`: JSON-declared libraries provisioned idempotently at
  startup, with root paths validated as relative before anything reads them.
- `src/server/mediaServer.ts` and `src/server/mediaWorker.ts`: entry points that
  require no Jellyfin variable at all (`npm run server`, `npm run worker`).

Decisions worth recording:

- Playback authorization happens during item resolution, per user, not in a
  shared resolver. Possession of an item or media-file id can never be traded
  for bytes from a library the caller cannot see.
- The router now prefers literal path segments over parameters. The HLS playlist
  references segments by bare filename, so they arrive at
  `/playback/sessions/:id/<name>`; without specificity ordering, registration
  order would silently decide whether that shadowed `/file` and `/master.m3u8`.
- Absent and forbidden are deliberately indistinguishable (404 both ways) so an
  item id cannot be used to probe what exists in a hidden library.
- Reconciliation derives "this file changed" from the store's return value
  rather than from a pre-scan snapshot the store is free to have mutated.

Verification:

```text
npx tsc --noEmit -p tsconfig.json:
  exit 0

npx vitest run:
  91 files passed; 3 failed; 4 skipped
  592 tests passed; 4 documented baseline tests failed; 14 database tests skipped
```

The four failures remain exactly the documented baseline set; no new failure was
introduced by this phase.

Known limitations: the same SQL-not-yet-integration-verified caveat applies to
every repository added here. `src/server/playbackBackend.ts` and its Jellyfin
resolver still exist and are still what the shipped frontend talks to; they are
removed in the cutover phase, not this one. Metadata/TMDB, native image
delivery, trickplay, subtitle extraction, SyncPlay and the frontend cutover are
not implemented.

## Phase 5 — TMDB metadata and native image cache (2026-08-10)

Delivered:

- `ownApi/metadata/matcher.ts`: pure provider-match selection. Token-overlap
  similarity (release titles differ by whole words, not characters), year
  proximity with a one-year tolerance, popularity only as a tie-breaker, and a
  decisiveness gate.
- `ownApi/metadata/tmdbClient.ts`: TMDB v3 access with the key sent as a bearer
  token rather than a query parameter, a bounded timeout, and typed
  not-found/rate-limited/unavailable errors. No URL or key reaches an error
  message.
- `ownApi/metadata/metadataRepository.ts`: per-field lock guards expressed
  inside the UPDATE, so an operator edit made during an in-flight refresh cannot
  be clobbered by a read-modify-write race. Genres and people are replaced
  transactionally.
- `ownApi/metadata/metadataService.ts`: identification, metadata application,
  episode-level application for series, and best-effort artwork.
- `ownApi/images/imageStorage.ts`: content-addressed artwork storage with magic
  byte verification, HTTPS-only fetching, size limits, and atomic
  write-then-rename.
- `ownApi/images/imageRoutes.ts`: authorized delivery with the content hash as
  the ETag, `private` caching, and episode-to-season-to-series artwork fallback.
- `ownApi/metadata/metadataRoutes.ts`: candidate listing, explicit identify,
  refresh, and field-locking edits.
- Metadata scan and refresh job types wired into the worker and queued
  automatically after a scan creates items.

Decisions worth recording:

- A low-confidence or near-tied match is recorded as `unmatched`, never applied.
  Metadata that silently renames the wrong film is worse than missing metadata.
- Editing a field through the admin route locks it implicitly. An operator who
  typed a title does not expect the next refresh to replace it. The write is
  applied before the lock is placed, because the lock would otherwise make the
  operator's own edit a no-op.
- An item with a locked identity is moved out of the `pending` metadata state.
  Leaving it pending made the batch scan reselect it forever; a seen-set
  termination guard in the job handler covers the general case.
- Artwork whose content hash is unchanged is not rewritten, so ETags stay stable
  and clients keep their cached copies across refreshes.
- Metadata is optional. With no `SEYIRLIK_TMDB_API_KEY` the metadata routes are
  not mounted and the catalogue still scans, probes and plays.

Verification:

```text
npx tsc --noEmit -p tsconfig.json:
  exit 0

npx vitest run:
  94 files passed; 3 failed; 4 skipped
  626 tests passed; 4 documented baseline tests failed; 14 database tests skipped
```

Known limitations: no live TMDB call was made from this host, so the client's
response mapping is covered by unit fakes rather than by recorded provider
fixtures. Trickplay, subtitle extraction, SyncPlay and the frontend cutover
remain unimplemented.

## Phase 14 (partial) — view-model rename and native client adapters (2026-08-10)

First, additive half of the frontend cutover. Nothing was deleted and no module
changed which backend it talks to; the shipped app still reaches Jellyfin.

Delivered:

- `src/lib/types.ts`: the de-facto view models were renamed off the provider
  (`JellyfinItem` to `MediaItem`, `JellyfinMediaSource` to `MediaSource`, and so
  on for eighteen types) and given a header explaining why they keep tick-based
  durations. Field names were deliberately left alone so no component or player
  arithmetic changed. 89 files updated mechanically; `tsc` clean.
- `src/api/ownApi/dto.ts`: the native wire shapes, mirroring the server exactly.
- `src/api/ownApi/adapters.ts`: the single bridge between the two. Converts
  millisecond durations to ticks, maps native kinds to the `Type` strings the UI
  switches on, and projects native artwork references onto the image-tag fields
  the cards already read, including series-inherited artwork for episodes.

Verification:

```text
npx tsc --noEmit -p tsconfig.json:
  exit 0

npx vitest run:
  94 files passed; 3 failed; 4 skipped
  626 tests passed; 4 documented baseline tests failed; 14 database tests skipped
```

Remaining before the cutover can complete, in dependency order:

1. `/admin/users` CRUD and `/items/:itemId/trickplay` do not exist yet, and the
   frontend's user-management and seek-bar code needs them. They are gaps in
   phases 10 and 9 respectively, not in the cutover.
2. `src/lib/mediaApi.ts` implementing the 63 symbols the app imports from
   `jellyfinApi.ts`, over the native client and adapters.
3. The mechanical import rewrite across the 56 consuming modules.
4. Deletion of `jellyfinApi.ts`, `authStorage.ts`'s token handling, the SyncPlay
   client and socket, `jellyfinMediaResolver.ts`, `jellyfinPlaybackAuth.ts`,
   `playbackBackend.ts`, the Jellyfin PWA exclusions and the Jellyfin
   environment variables.

Writing `mediaApi.ts` before item 1 would mean shipping functions that call
endpoints which do not exist, so the order above is deliberate.

## Subsequent phases

Add a dated section for every completed vertical slice with:

- exact command and exit status;
- focused RED and GREEN evidence;
- full-suite comparison against the four baseline failures;
- manual/API/browser/playback checks;
- failure/security tests;
- known limitations and remaining parity rows;
- `git status --short` without modifying staging.

No final Jellyfin removal or completion declaration is permitted until the complete acceptance matrix, Jellyfin-disabled run, security checks, migration verification, playback fixture matrix, E2E tests, production build, and any added Docker build all pass with real recorded output.
