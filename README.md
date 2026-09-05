# Seyirlik

A self-hosted media server and web client for a personal film, television, and
ebook library. Seyirlik owns the whole path: it scans the files on disk, builds
its own catalogue in PostgreSQL, fetches metadata and artwork, decides how each
file should be delivered to each browser, and serves the interface that plays
it.

Seyirlik began as a frontend for Jellyfin and no longer is one. The client talks
only to Seyirlik's own API, and nothing in the data path depends on another
media server being installed.

---

## Contents

- [What it does](#what-it-does)
- [How it fits together](#how-it-fits-together)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Laying out your library](#laying-out-your-library)
- [Running it](#running-it)
- [Development](#development)
- [NFO export](#nfo-export)
- [Renditions](#renditions)
- [Security model](#security-model)
- [Further reading](#further-reading)

---

## What it does

**Library**

- Scans movies, series, and ebooks from folders on disk into a PostgreSQL
  catalogue, keeping track of files that disappear rather than deleting their
  history.
- Reads titles, seasons, and episode numbers from names, and refuses to guess:
  a name it cannot understand becomes a plain title rather than a wrong episode
  filed under the wrong show.
- Fetches metadata, posters, backdrops, and logos from TMDB. Optional — without
  an API key the library still scans, probes, and plays, using the names on
  disk.
- Global search over everything, tolerant of typos and reachable with
  `Cmd/Ctrl+K`.
- Favourites, a "My List" page, continue-watching, and next-up.

**Playback**

- Chooses per browser between direct file delivery, remuxing, and bounded
  FFmpeg transcoding, based on what that browser can actually decode.
- Audio track, subtitle track, and quality selection, with adjustable subtitle
  delay.
- Trickplay thumbnails on the scrub bar.
- Playback queues for series and collections.
- Skip-segment support for intros and credits.
- Watch-together: synchronised playback across sessions.

**Reading**

- An EPUB reader for the books in the library.

**Administration**

- User accounts with per-library permissions.
- An artwork tool for identifying titles against TMDB, replacing artwork, and
  positioning logos on cards by hand.
- Background jobs for scanning, probing, and metadata refreshes, with progress
  reporting.

**Client**

- Installable as a PWA, with separate desktop and mobile interfaces.
- English and Turkish throughout.

---

## How it fits together

```
      browser
         │  HTTPS
         ▼
┌─────────────────────┐
│    mediaServer      │  serves the built client and /ownAPI/v1
│                     │  auth, catalogue, images, playback, syncplay
└──────────┬──────────┘
           │
     ┌─────┴──────┬──────────────┬──────────────┐
     ▼            ▼              ▼              ▼
 PostgreSQL   media root   generated storage   TMDB
 catalogue,   (media and   (artwork cache,     (optional
 users,       NFO source   trickplay,          metadata)
 progress     of truth)    transcode temp)
           ▲
           │
┌──────────┴──────────┐
│    mediaWorker      │  optional, same job queue
│                     │  scanning and probing off the playback box
└─────────────────────┘
```

Two entry points share one runtime:

- **`src/server/mediaServer.ts`** — the HTTP server. Serves the API under
  `/ownAPI/v1`, and the built client from `SEYIRLIK_STATIC_ROOT` when set.
- **`src/server/mediaWorker.ts`** — an optional second process that drains the
  same job queue, so scanning and analysis can run somewhere other than the
  machine serving playback. Not required; the server runs jobs itself.

Three storage locations, with different rules:

- **The media root** is the source of truth. Playback, discovery, probing and
  transcoding treat media files as read-only; only the two explicitly listed
  features below write adjacent metadata or artwork.
- **Generated storage** holds everything derived: cached artwork and its
  resized variants, trickplay sprites, and transcode scratch space. Safe to
  delete; it will be rebuilt.
- **PostgreSQL** holds the catalogue, users, sessions, watch progress, and the
  job queue.

### What may write to the media root

Two narrowly scoped features write there, and both are named here rather than
left to be discovered from a diff:

| Feature                | Writes                          | Default | How to turn it off                      |
| ---------------------- | ------------------------------- | ------- | --------------------------------------- |
| Title-owned artwork    | `<Title>/content/cover.jpg` and | **on**  | Leave `SEYIRLIK_TMDB_API_KEY` unset, or |
|                        | `backdrop.jpg`, `logo.png`      |         | do not use the artwork admin pages      |
| NFO export (`sidecar`) | `movie.nfo`, `tvshow.nfo`,      | **on**  | Set `SEYIRLIK_NFO_EXPORT=disabled`      |
|                        | `season.nfo`, `<episode>.nfo`   |         |                                         |
| Organising folders     | Moves originals into `src/` and | **off** | Leave `SEYIRLIK_MEDIA_ORGANIZE` unset   |
|                        | episode .nfo files into the     |         |                                         |
|                        | episode's folder                |         |                                         |

Artwork writes are long-standing behaviour: a cover placed in the title's own
`content/` folder travels with the title when it is moved or backed up, which a
hash-named cache file does not. NFO sidecars are generated during scans by
default and use managed-only replacement, so files from another application or
a person are preserved.

Everything else — trickplay, variants, renditions, transcode scratch — stays on
generated storage.

The client is a React app under `src/`, split into `pages/desktop` and
`pages/mobile` where the two need to differ. Shared logic lives in `src/lib`,
which both the client and the server import from — the playback planner and the
artwork sizing rules are used by both sides, and keeping one copy is what stops
them disagreeing.

---

## Requirements

- **Node 20.6 or newer.** The scripts use `node --env-file`.
- **PostgreSQL.** Any reasonably current version.
- **FFmpeg and ffprobe**, for probing, transcoding, and trickplay.
- **A TMDB API key**, optional, for metadata and artwork.

---

## Getting started

```bash
npm install
```

Create a `.env` in the project root:

```bash
DATABASE_URL=postgresql://seyirlik:password@127.0.0.1:5432/seyirlik
SEYIRLIK_MEDIA_ROOT=/srv/media
SEYIRLIK_GENERATED_STORAGE=/var/lib/seyirlik
SEYIRLIK_LIBRARIES=[{"slug":"movies","name":"Movies","kind":"movies","roots":["Movies"]},{"slug":"shows","name":"Shows","kind":"series","roots":["Series"]},{"slug":"books","name":"Books","kind":"books","roots":["Books"]}]
SEYIRLIK_TMDB_API_KEY=your-key
```

Create the schema:

```bash
npm run db:migrate
```

Create the first administrator. The password is read from stdin so it never
reaches your shell history or the process list:

```bash
printf '%s' 'your-password' | npm run admin:provision -- --username you --display-name "You" --password-stdin
```

Start the server:

```bash
npm run server
```

Then sign in and trigger a library scan from the admin tools.

---

## Configuration

Everything is read from the environment. Only `DATABASE_URL` and
`SEYIRLIK_MEDIA_ROOT` are required.

### Core

| Variable                           | Default        | Purpose                                                                                                                           |
| ---------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                     | —              | PostgreSQL connection URL. Required.                                                                                              |
| `SEYIRLIK_MEDIA_ROOT`              | —              | Absolute path to the media volume. Required, and never written to.                                                                |
| `SEYIRLIK_GENERATED_STORAGE`       | temp dir       | Where derived files are cached. Set this in production.                                                                           |
| `SEYIRLIK_PROCESSING_SCRATCH_ROOT` | unset          | Optional fast scratch root. Jobs build and verify under `<root>/jobs/<job-id>` before transactional publication to media storage. |
| `SEYIRLIK_LIBRARIES`               | none           | JSON array of library definitions. See below.                                                                                     |
| `SEYIRLIK_STATIC_ROOT`             | none           | Directory of the built client to serve. Usually `dist`.                                                                           |
| `SEYIRLIK_HOST`                    | `127.0.0.1`    | Listen address. Set to `0.0.0.0` to accept connections from other machines.                                                       |
| `SEYIRLIK_PORT`                    | `43110`        | Listen port.                                                                                                                      |
| `SEYIRLIK_DATABASE_POOL_MAX`       | driver default | Maximum pooled connections.                                                                                                       |
| `SEYIRLIK_RUN_WORKER`              | `true`         | Whether this process also runs background jobs. See "Running it".                                                                 |

### Networking and cookies

| Variable                   | Default   | Purpose                                                             |
| -------------------------- | --------- | ------------------------------------------------------------------- |
| `SEYIRLIK_PUBLIC_ORIGIN`   | none      | The origin browsers reach Seyirlik on, behind a reverse proxy.      |
| `SEYIRLIK_ALLOWED_ORIGINS` | none      | Comma-separated additional origins allowed to call the API.         |
| `SEYIRLIK_COOKIE_DOMAIN`   | host only | Cookie domain, when the client and API sit on different subdomains. |

### Media processing

| Variable                              | Default           | Purpose                                                               |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `SEYIRLIK_TMDB_API_KEY`               | none              | Enables metadata and artwork. Without it, titles come from filenames. |
| `SEYIRLIK_FFMPEG_PATH`                | `ffmpeg` on PATH  | FFmpeg binary.                                                        |
| `SEYIRLIK_FFPROBE_PATH`               | `ffprobe` on PATH | ffprobe binary.                                                       |
| `SEYIRLIK_FFMPEG_VIDEO_ENCODER`       | auto              | Force a specific video encoder.                                       |
| `SEYIRLIK_MAX_VIDEO_TRANSCODES`       | bounded           | Concurrent transcode ceiling.                                         |
| `SEYIRLIK_SOFTWARE_TRANSCODE_THREADS` | topology-aware    | Optional software encoder thread override.                            |

### Restarting

| Variable                | Default                                             | Purpose                                                              |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `SEYIRLIK_RESTART_MODE` | `respawn`, or `supervisor` under systemd or launchd | How the server comes back after the Server Control page restarts it. |

`respawn` makes the process start its own replacement, which is what a bare
`npm run server` needs. Set `supervisor` when Docker or pm2 restarts the
process for you — under those, respawning would put two servers on one port.
systemd and launchd are detected on their own, through `INVOCATION_ID` and
`XPC_SERVICE_NAME`. `disabled` turns the endpoints off, and the page says so
rather than failing on the button.

Under a supervisor, check that its restart policy covers a _clean_ exit. A
restart requested from the Server Control page ends the process with status 0,
so a policy of "restart only after a failure" — launchd's
`KeepAlive: {SuccessfulExit: false}`, Docker's `on-failure` — reads that as a
deliberate stop and leaves the server down.

### NFO export

Sidecar generation runs during scans by default. Set the mode to `disabled` for
an explicit opt-out.

| Variable                             | Default        | Purpose                                                                  |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------ |
| `SEYIRLIK_NFO_EXPORT`                | `sidecar`      | Scan output: `disabled`, `preview`, `generated`, or `sidecar`.           |
| `SEYIRLIK_NFO_OVERWRITE`             | `managed-only` | `force` also replaces .nfo files Seyirlik did not write.                 |
| `SEYIRLIK_NFO_ARR_MANAGED_LIBRARIES` | none           | Library slugs a Radarr/Sonarr instance owns; never exported to natively. |

### Organising the media folders

| Variable                  | Default | Purpose                                                         |
| ------------------------- | ------- | --------------------------------------------------------------- |
| `SEYIRLIK_MEDIA_ORGANIZE` | `off`   | Tidying pass at the start of a scan: `off`, `plan`, or `apply`. |

See [Keeping it tidy](#keeping-it-tidy) for the layout it produces and for the
dry run to check first.

### Libraries

`SEYIRLIK_LIBRARIES` is a JSON array. Each entry needs a `slug` (lowercase
letters, digits, dashes), a `name`, a `kind`, and one or more `roots` given
**relative to the media root**:

```json
[
  { "slug": "movies", "name": "Movies", "kind": "movies", "roots": ["Movies"] },
  { "slug": "shows", "name": "Shows", "kind": "series", "roots": ["Series"] },
  { "slug": "books", "name": "Books", "kind": "books", "roots": ["Books"] }
]
```

Valid kinds are `movies`, `series`, `books`, `collections`, and `mixed`.

Roots are validated at startup rather than at scan time, so a configuration
mistake stops the server with a clear message instead of surfacing later as a
path traversal attempt from inside the scanner. Absolute paths, drive letters,
UNC paths, and `..` segments are rejected. A leading slash is stripped, because
`/Movies` is how people naturally write "the Movies folder in the media root".

---

## Laying out your library

The scanner is deliberately conservative. A name it cannot parse becomes a
plain title with no season or episode numbers, because a wrong guess silently
files an episode under the wrong series and that is worse than missing data.

**Movies** — one folder per film, with the year in the folder name:

```
Movies/
  Oppenheimer (2023)/
    Oppenheimer (2023).mkv
    Oppenheimer (2023).tr.srt
```

**Series** — a folder per show, then a folder per season:

```
Series/
  Severance/
    Season 1/
      Severance S01E01.mkv
      Severance S01E02.mkv
    Specials/
```

Season folders may be named `Season 1`, `S01`, or similar. `Specials`, `Season
0`, `S00`, and `Özel` are all read as season zero.

**Books** — EPUB files, one per book.

Hidden files, macOS and Windows sidecar files, and the directories Seyirlik
generates are skipped. External subtitles beside a video are picked up
automatically.

Artwork comes from TMDB, not from the folder. Images sitting next to your media
— `folder.jpg`, `backdrop.jpg` — are ignored; use the admin artwork tool to
override what TMDB supplied.

### Keeping it tidy

A season folder that is halfway through processing is the untidiest thing in a
library: ten sources, ten subtitles, ten .nfo files and ten generated folders,
interleaved by name so nothing lines up. Seyirlik can tidy that at the start of
every scan — off by default, because moving somebody's files is not a thing to
enable by inference.

Turned on, originals and their sidecar subtitles move into a `src/` bucket, and
each episode's .nfo is filed inside the folder that already holds that
episode's renditions:

```
Series/House of the Dragon/
  tvshow.nfo
  Season 1/
    season.nfo
    src/
      House of the Dragon - S01E01 - The Heirs of the Dragon.mp4
      House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt
    House of the Dragon - S01E01 - The Heirs of the Dragon/
      House of the Dragon - S01E01 - The Heirs of the Dragon.nfo
      video/  audio/  subtitle/  .seyirlik/
```

A movie has no season above it and no episode below it, so its folder is the
title: the originals go to `Gladiator (2000)/src/` and the .nfo stays at the
folder root, which is where Kodi and Jellyfin look for it. A loose file at the
library root gains a folder of its own on the way.

Nothing is renamed, nothing is overwritten and nothing is deleted — a move
whose destination is occupied is reported and skipped. No title changes
identity either: `src/` is transparent to the scanner and to the code that
decides where a package lives, so packages already built keep working and the
catalogue keeps its watch history.

It never moves a file while there is live processing work — **queued as much as
running**. A running encode re-opens its source at the start of every epoch, and
a queued attempt froze the absolute path of its source into its queue row when
it was queued. Both are checked again immediately before the first rename, and
`npm run media:organize:apply` refuses outright rather than deferring. A paused
or storage-held job is not live: resuming one rebuilds its path from the
catalogue, which by then names the new location.

See exactly what it would do before enabling it:

```bash
npm run media:organize:plan            # every move, against your real library
npm run media:organize:apply           # carry it out, once — refuses if the
                                       # processing queue is not empty
```

Then, to have every scan keep the library tidy:

```bash
SEYIRLIK_MEDIA_ORGANIZE=apply          # or `plan` to keep reporting only
```

---

## Running it

Build the client and run the server against it:

```bash
npm run build
SEYIRLIK_STATIC_ROOT=dist npm run server
```

The server speaks plain HTTP and expects to sit behind a reverse proxy that
terminates TLS. Set `SEYIRLIK_PUBLIC_ORIGIN` to the origin browsers actually
use so cookies and CORS line up.

### Splitting the worker out

By default one process does everything, which is the right shape for one
machine. Scanning, probing and encoding can be moved into a process of their
own instead — on the same machine or another one — by pointing it at the same
database and media root:

```bash
SEYIRLIK_RUN_WORKER=false npm run server   # serves the site and the API
npm run worker                             # scans, probes and encodes
```

`SEYIRLIK_RUN_WORKER=false` is the half that matters: without it the API
process keeps its own worker and both halves claim from the same queue.

The two never talk to each other directly; they meet in the job queue in
PostgreSQL, and a job survives either one restarting. That is the point of the
split — restarting the site from the Server Control page no longer abandons an
encode half-way through, and an encoder that wedges no longer takes playback
with it.

### Running as a service

`deploy/` holds a launchd job for each half, and the comments in them explain
the two settings that are easy to get wrong: run the Node binary rather than
`npm`, so the process the supervisor watches is the server itself and cannot be
orphaned holding the port, and keep the process alive after a clean exit, so
the restart button comes back.

```bash
cp deploy/org.seyirlik.server.plist ~/Library/LaunchAgents/
cp deploy/org.seyirlik.worker.plist ~/Library/LaunchAgents/   # only if splitting
launchctl bootout gui/$UID/org.seyirlik.server 2>/dev/null
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/org.seyirlik.server.plist
```

Both write to `~/Library/Logs/Seyirlik/`.

### Maintenance commands

```bash
npm run db:migrate           # apply pending migrations
npm run admin:provision      # create the first administrator
npm run media:organize:plan  # what tidying the media folders would move
npm run media:organize:apply # move it
```

---

## Development

```bash
npm run dev      # Vite dev server, proxies /ownAPI to the API
npm run server   # the API, in another terminal
npm test         # vitest, watch mode
npm run build    # typecheck, then production build
npm run format   # prettier
```

The dev server proxies `/ownAPI` to `http://127.0.0.1:43110` by default;
override with `SEYIRLIK_OWN_API_UPSTREAM`.

### Tests

Around 800 tests run without a database or a media volume. Anything touching
PostgreSQL is an integration test and skips unless
`SEYIRLIK_TEST_DATABASE_URL` points at a **disposable** database — those tests
truncate the tables they use.

```bash
npx vitest run
```

### Project layout

```
src/
  api/ownApi/     client for the native API, and DTO adapters
  components/     shared UI; player/, search/, hero/, admin/
  pages/          routes, split desktop/ and mobile/ where they differ
  lib/            logic shared by client and server
  renditions/     the offline re-encode pipeline
  server/
    mediaServer.ts    HTTP entry point
    mediaWorker.ts    job-queue entry point
    ownApi/           auth, catalogue, images, playback, scanner,
                      metadata, progress, syncplay, tasks, users
scripts/          migrations, admin provisioning, rendition CLI
docs/             architecture notes
```

---

## NFO export

Seyirlik writes Kodi/Jellyfin-compatible `.nfo` sidecars from its catalogue as
the final stage of every library scan, so a library stays readable by another
program — or by a person with a text editor — without Seyirlik running. The
catalogue is the source of truth; an `.nfo` is an output of a scan, not an input
to it.

### The four modes

```
SEYIRLIK_NFO_EXPORT=disabled    explicit opt-out; nothing is generated
SEYIRLIK_NFO_EXPORT=preview     XML through the API only; no file is written
SEYIRLIK_NFO_EXPORT=generated   files under SEYIRLIK_GENERATED_STORAGE/nfo/
SEYIRLIK_NFO_EXPORT=sidecar     files beside the media              (default)
```

`preview` and `generated` never touch the media root. `generated` mirrors the
media layout under generated storage, so you can read the output, diff it, or
rsync it into place yourself before committing to anything.

`sidecar` is part of the media-root write policy: scans may create or update
Seyirlik-managed NFO files beside media. Set `SEYIRLIK_NFO_EXPORT=disabled` to
keep scans read-only with respect to NFO metadata.

### What is written where

| Item    | File                       | Root element       |
| ------- | -------------------------- | ------------------ |
| Movie   | `movie.nfo` in the folder  | `<movie>`          |
| Series  | `tvshow.nfo` in the folder | `<tvshow>`         |
| Season  | `season.nfo` in the folder | `<season>`         |
| Episode | `<video stem>.nfo`         | `<episodedetails>` |

A movie with several versions in one folder also gets a `.nfo` named after each
video file, because one `movie.nfo` cannot describe two different resolutions.
Books, collections and trailers are not exported.

Output is UTF-8 with an XML declaration, every value escaped, and deterministic:
unchanged metadata produces byte-identical output, so re-running an export
rewrites nothing and changes no modification times.

### Existing files are never overwritten

The default overwrite policy is `managed-only`. Seyirlik writes a marker comment
into the files it generates, and replaces **only** files carrying that marker.
A legacy Jellyfin, Radarr, Sonarr, Kodi or hand-written `.nfo` is reported as a
conflict and left exactly as it is. So is anything at the path that is not a
regular file, and any path that resolves through a symlink out of the export
root.

An administrator can override that per request with `{"force": true}` on an
export endpoint, or globally with `SEYIRLIK_NFO_OVERWRITE=force`. Nothing is
ever deleted; an `.nfo` that stops being generated stays where it is.

### Running an export

```bash
# What would be written for one item, and what is already there.
curl --cookie … https://seyirlik.example/ownAPI/v1/admin/items/<itemId>/nfo/preview

# Queue an export. Both return 202 with a task id to poll on /admin/tasks/:id.
curl -X POST … /ownAPI/v1/admin/items/<itemId>/nfo/export
curl -X POST … /ownAPI/v1/admin/libraries/<libraryId>/nfo/export
```

Both manual operations run as background jobs — `nfo.export.item` and
`nfo.export.library` — which deduplicate, report progress, and finish with counts
of created, updated, unchanged, skipped-conflict and failed files, plus a bounded
list of conflicting paths. Normal library scans run the same safe exporter
directly before the scan task completes.

### Alongside Radarr or Sonarr

If a Radarr or Sonarr instance already writes `.nfo` files for a library, list
that library's slug in `SEYIRLIK_NFO_ARR_MANAGED_LIBRARIES`. Seyirlik then never
writes to it, whatever the mode says. Two programs managing the same file is not
a conflict either can detect — both files look valid and the library churns.

Seyirlik does not talk to Radarr or Sonarr. `src/server/ownApi/nfo/arrClient.ts`
defines the interface a future adapter would implement and nothing constructs
one.

---

## Renditions

Separate from live transcoding, Seyirlik can pre-encode a library into
browser-friendly renditions ahead of time, so awkward files play by direct
delivery instead of occupying the CPU during playback.

```bash
npm run media:renditions:analyse    # report what would be re-encoded
npm run media:renditions:process    # encode
npm run media:renditions:resume     # continue an interrupted run
npm run media:renditions:status     # progress
npm run media:renditions:validate   # verify output
npm run media:renditions:cleanup    # remove stale output
```

Configured with `SEYIRLIK_RENDITION_ROOT`, `SEYIRLIK_RENDITION_STATE_ROOT`,
`SEYIRLIK_RENDITION_ENCODER`, `SEYIRLIK_RENDITION_HDR`, and
`SEYIRLIK_RENDITION_RESERVE_GB`, which holds back disk space so a long run
cannot fill the volume.

Start with `analyse`. It is read-only and tells you the cost before you commit
to it.

---

## Security model

- Passwords are hashed with Argon2. Login is rate limited.
- Sessions are HTTP-only cookies. State-changing requests carry a CSRF token;
  `GET` requests for images are exempt, because an `<img>` element cannot send
  a header, and they remain authorized by the session cookie.
- Every catalogue read is filtered by the viewer's library permissions. Holding
  an item id or an image id is not authorization — artwork inherits the
  visibility of the item it belongs to.
- Paths from the database and from requests are resolved against the media root
  before anything is opened, so a crafted relative path cannot escape it.
- The media root is read-only outside two documented features,
  both listed under "What may write to the media root": title-owned artwork,
  and scan-time NFO export in `sidecar` mode. Everything else generated goes to
  generated storage.
- TLS is the reverse proxy's job. Do not expose the server directly.

---

## Further reading

- [`docs/own-api-contract.md`](docs/own-api-contract.md) — the API surface.
- [`docs/NATIVE_PLAYBACK_ARCHITECTURE.md`](docs/NATIVE_PLAYBACK_ARCHITECTURE.md)
  — how playback decisions are made.
- [`docs/rendition-roadmap.md`](docs/rendition-roadmap.md) — the rendition
  pipeline.
- [`docs/PWA_SETUP.md`](docs/PWA_SETUP.md) — installable-app setup.
- [`docs/migration-from-jellyfin.md`](docs/migration-from-jellyfin.md) — what
  Seyirlik used to be, and why some names look the way they do.
