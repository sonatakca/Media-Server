# Who owns which file in the library

Several subsystems write into the same directories. This is the list of who
owns what, so that two of them never decide the same file is theirs.

The rule underneath all of it: **a subsystem may replace only what it can prove
it wrote.** Anything else in the library belongs to the person who put it there,
whatever it is called.

## The map

| Artefact                                  | Path shape                                 | Owner                     | How ownership is proven                                                                                    |
| ----------------------------------------- | ------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Video, and the container's own streams    | `<title>/<name>.mkv`                       | the **importer**          | The catalogue records the file it committed. Nothing else writes media.                                    |
| `.nfo`                                    | `<title>/<name>.nfo`                       | the **NFO service**       | A marker inside the file — `Seyirlik nfo-export`. A file without it is `foreign` and is never overwritten. |
| Poster, backdrop, logo                    | `<title>/content/…`                        | the **image service**     | Written to a temporary name and renamed into place; the catalogue records the storage key.                 |
| Trickplay sheets                          | `<title>/trickplay/`                       | the **trickplay service** | Staged in `.trickplay-staging-<id>` and published by rename.                                               |
| Rendition package                         | `<title>/.seyirlik/`, `video/`, `audio/`   | the **packager**          | The package manifest.                                                                                      |
| **Subtitle that arrived with a download** | `<title>/<name>.<lang>.srt`                | the **importer**          | An `import_files` row with role `subtitle`.                                                                |
| **Subtitle this system fetched**          | `<title>/<name>.<lang>[.forced][.sdh].srt` | the **subtitle service**  | A `subtitle_installations` row carrying the path _and the digest of the bytes written_.                    |
| Anything else                             | —                                          | **nobody**                | Left alone.                                                                                                |

## Two boundaries worth stating out loud

### A release's `.nfo` is never imported

`IMPORTED_ROLES` is `["media", "subtitle"]`. `metadata` is recognised and
deliberately excluded: a release's `.nfo` is usually a note about the release,
and the library's `.nfo` files are written by the NFO service. Importing one
would put a scene text file exactly where that service expects to own the name.
It stays in the download, where anyone who wants it can still read it.

Pinned by `importState.test.ts`.

### The two kinds of subtitle do not overwrite each other

Both the importer and the subtitle service write subtitles into the same folder,
and this is the one genuinely new overlap in Phase 7. They are separated by
evidence, not by naming:

- The subtitle service will replace a file **only** when
  `subtitle_installations` holds a row for that exact path _and_ the digest in
  it still matches the bytes on disk. A subtitle that came in with a download
  has no such row, so it is refused as `destination-occupied`.
- A file whose digest no longer matches has been edited by somebody since, and
  the record is deleted rather than kept — stale ownership is worse than none,
  because it would authorise overwriting a file that is no longer ours.

The consequence is deliberate and worth knowing: **a subtitle that arrived with
a release cannot currently be upgraded by the subtitle service.** It can be
removed by a person, after which the next search installs one. Making an
imported subtitle upgradable would mean the importer recording a digest at
import time, which is a change to the import pipeline rather than to this one.

A subtitle has nowhere to carry a marker of its own — unlike an NFO, which has
its text — which is why ownership here is a database record rather than a
property of the file.

## What a new writer has to do

Anything that writes into a title folder must:

1. Write to a temporary name in the same directory, `fsync`, and rename or link
   into place, so a crash never leaves a half-written file under a real name.
2. Prove ownership before replacing anything, by a marker in the file or a
   record of the digest.
3. Refuse rather than guess when the destination holds something unexpected.
4. Stay inside the configured root, checked after path resolution rather than
   before it.
