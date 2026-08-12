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
 catalogue,   (read-only   (artwork cache,     (optional
 users,       source of    trickplay,          metadata)
 progress     truth)       transcode temp)
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

- **The media root** is the source of truth and is treated as read-only.
  Seyirlik never writes into it.
- **Generated storage** holds everything derived: cached artwork and its
  resized variants, trickplay sprites, and transcode scratch space. Safe to
  delete; it will be rebuilt.
- **PostgreSQL** holds the catalogue, users, sessions, watch progress, and the
  job queue.

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

| Variable                     | Default        | Purpose                                                                     |
| ---------------------------- | -------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`               | —              | PostgreSQL connection URL. Required.                                        |
| `SEYIRLIK_MEDIA_ROOT`        | —              | Absolute path to the media volume. Required, and never written to.          |
| `SEYIRLIK_GENERATED_STORAGE` | temp dir       | Where derived files are cached. Set this in production.                     |
| `SEYIRLIK_LIBRARIES`         | none           | JSON array of library definitions. See below.                               |
| `SEYIRLIK_STATIC_ROOT`       | none           | Directory of the built client to serve. Usually `dist`.                     |
| `SEYIRLIK_HOST`              | `127.0.0.1`    | Listen address. Set to `0.0.0.0` to accept connections from other machines. |
| `SEYIRLIK_PORT`              | `43110`        | Listen port.                                                                |
| `SEYIRLIK_DATABASE_POOL_MAX` | driver default | Maximum pooled connections.                                                 |

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
| `SEYIRLIK_SOFTWARE_TRANSCODE_THREADS` | auto              | Thread count for software transcoding.                                |

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

To move scanning and probing off the machine serving playback, point a second
process at the same database and media root:

```bash
npm run worker
```

### Maintenance commands

```bash
npm run db:migrate         # apply pending migrations
npm run admin:provision    # create the first administrator
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
- The media root is never written to. Everything generated goes to generated
  storage.
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
