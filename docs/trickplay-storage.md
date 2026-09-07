# Trickplay storage

Seek-bar preview sheets, where they live, and the three different things in this
installation that carry the word "trickplay".

## The three populations

They look alike and are handled by entirely separate code. Confusing them is the
one mistake in this area that loses data, so they are named here first.

| Population                                   | Where                                   | Live?         | Owned by | Handled by                                          |
| -------------------------------------------- | --------------------------------------- | ------------- | -------- | --------------------------------------------------- |
| **Managed trickplay**                        | `<titleRoot>/trickplay/`                | yes           | Seyirlik | `trickplayService.ts` — generation, serving, delete |
| **Legacy external (Jellyfin-era) trickplay** | `<something>.trickplay/` in the library | no            | operator | `legacyTrickplayArchive.ts` — archived out          |
| **Old Seyirlik UUID storage**                | `<generated>/trickplay/<uuid>/`         | being retired | Seyirlik | `trickplayMigration.ts` — moved into title folders  |

Only the first has any authority at runtime. The second and third are, in
different ways, on their way out.

## The live layout

Everything a title owns sits in the title's own folder. Trickplay is one of
those things, beside the rungs and the tracks rather than in a tree of its own:

```
titleRoot/
  content/          backdrop, cover, logo, trailers
  audio/            one file per kept language
  video/            one file per ladder rung
  subtitle/
  trickplay/        seek-bar preview sheets
    sprite_0.jpg
    sprite_1.jpg
    ...
  .seyirlik/        playlists and the package manifest, hidden
  movie.nfo
```

Not every sibling exists for every title. The rule is only that `trickplay/` is
a direct child of the title root.

**A movie**

```
/Volumes/Expansion/media/Movies/Dune (2021)/trickplay/sprite_0.jpg
```

**An episode** — an episode's title root is nested, because a season folder
holds twelve of them:

```
/Volumes/Expansion/media/Series/Andor/Season 1/Andor - S01E01 - Kassa/trickplay/sprite_0.jpg
```

Both are computed by the same resolver the packager publishes `video/` and
`audio/` with — `resolveTitleRoot` in `src/renditions/adaptive/titleRoot.ts`,
with `titleRootLayoutForKind` deciding nested from beside. There is no second
path algorithm for trickplay, and there must never be one.

`.seyirlik/` is **not** the destination. It is the hidden playback layer:
`package.json`, `master.m3u8`, the rendition playlists. Trickplay is visible
generated media and belongs beside the other visible generated media.

## The single resolver

`src/server/ownApi/trickplay/trickplayStorage.ts` is the only place a trickplay
path is constructed:

```
source path -> resolveTitleRoot(...) -> path.join(titleRoot, TITLE_TRICKPLAY_DIRECTORY)
```

Generation, serving, deletion, regeneration, migration and validation all go
through it. `TITLE_TRICKPLAY_DIRECTORY` lives with `TITLE_VIDEO_DIRECTORY` and
its siblings in `src/renditions/adaptive/layout.ts` and is a member of
`GENERATED_TITLE_DIRECTORIES`, which is what stops the scanner walking into it.

## Generation is transactional

FFmpeg never writes into the live directory. A generation:

1. stages into `<titleRoot>/.trickplay-publish-<uuid>/` — hidden, so the scanner
   ignores it even if a crash leaves one behind;
2. validates the staged bytes: sheet count, consecutive numbering, regular
   files, non-zero length, JPEG headers, and a frame width that matches the
   geometry the row will claim;
3. swaps the staged directory in by rename, moving the previous set aside;
4. writes the database row from what validation counted, not from what the
   layout predicted;
5. removes the previous set.

Failure at any step before 5 leaves the previous set live and readable. This is
the invariant the whole design exists for:

> an existing valid set, plus a failed regeneration, is still an existing valid
> set.

If the row cannot be written after the swap, the previous set is put back, so
the folder and the database never disagree about the geometry.

Progress is reported as **indeterminate**. FFmpeg decodes the whole file to
sample it and says nothing about how far in it is, so the queue shows elapsed
time and the title's name rather than a percentage nobody measured.

If the media volume goes away mid-generation, the failure is an ordinary
retryable one — the existing storage semantics apply, no row is published, and
the previous set survives.

## The database

`trickplay_sets` no longer records where the bytes are, because the bytes are at
a location derived from the media file. `storage_prefix` remains, made nullable
by `019_trickplay_title_storage.sql`, as the one thing distinguishing the two
layouts during the migration:

- `storage_prefix IS NULL` — the set is at `<titleRoot>/trickplay/`. Every set
  this server writes is of this kind.
- `storage_prefix IS NOT NULL` — the set is still in the old UUID tree. It is
  still served, so the migration can be run at leisure rather than during a
  restart.

The column can be dropped once no row carries one.

## Migrating the old UUID sets

```bash
npm run media:trickplay:migrate:plan     # dry run, writes nothing
npm run media:trickplay:migrate          # the real thing
```

Per set: read the old directory, validate it against its own row, copy it into
staging beside the destination, compare the copy to the original by SHA-256 file
by file, publish, clear `storage_prefix`, and only then remove the old
directory. The removal is last and is reached only when the bytes exist
elsewhere and the database says so.

It is idempotent (a cleared row is not selected again), restartable (an
interrupted run's half-published state is recognised and finished), and it never
fabricates success: a missing source, a destination holding different bytes, or
a set that does not match its row are each reported by name, with the old
directory left where it was. The old central root is removed only when it is
genuinely empty.

A UUID directory that no row claims is an **orphan** — output from a set that
was later deleted, or from a generation whose row never landed. There is no
media file to resolve a destination from, so it cannot be migrated. Orphans are
listed by name at the end of the run, never adopted and never removed, and they
are the reason the old root can survive a run in which every set succeeded.

## The library is on exFAT, and that matters

`/Volumes/Expansion` is exFAT, which has nowhere to store an extended attribute.
macOS tags every file a process creates with `com.apple.provenance`, and on such
a volume that tag is materialised as an AppleDouble sidecar — writing
`sprite_0.jpg` silently produces a 4 KiB `._sprite_0.jpg` beside it, and making a
directory produces a `._` twin of the directory too.

So a perfectly good set of four sheets is eight files, none of which FFmpeg
wrote half of. `isFilesystemSidecar` in `trickplayStorage.ts` is the one place
that knows the difference, and three things depend on it:

- **Validation.** Without it the strict "nothing here but sheets" rule read every
  generation on this volume as corrupt output, and the migration dry run
  reported all twenty-three sets as `invalid-source`.
- **The old root's emptiness.** Removing `<uuid>` leaves `._<uuid>` behind, so
  counting raw entries would report a root holding nothing but macOS bookkeeping
  as still in use, for ever.
- **Copy order.** `copyOrder` in `directoryVerification.ts` writes every payload
  entry first and every sidecar last. Copying `sprite_0.jpg` rewrites the
  destination's `._sprite_0.jpg`, so in plain sorted order — where `._` sorts
  first — the payload's copy silently overwrites the sidecar that was just
  placed, and the destination ends up holding its own metadata rather than the
  source's. Directories count as payload and are recursed into before their `._`
  twin is written, because creating the directory is what makes the twin appear.
  The first real migration run hit exactly this: thirty sets copied, thirty
  failed verification on `._` files alone, thirty old directories rightly kept.

The allowance is an exact two-name list — `._*` and `.DS_Store` — not "ignore
anything unexpected". The two checks exist to notice things that should not be
there, and they go on noticing everything else.

Two things this does **not** change. Sheet counts are taken from what validation
counted, never from a file count: on this volume the two differ by a factor of
two, and a row claiming twice as many sheets as exist sends the seek bar after
sheets that were never written. And nothing is excluded from verification —
sidecars are copied and compared like any other file, which is why the order
they are written in had to be fixed rather than the comparison relaxed.

## Archiving the legacy external trickplay

The `*.trickplay` folders are Jellyfin-era, external, and have never been live.
They are wanted out of the media volume but not deleted, so they are copied to a
human-owned archive and verified before anything is removed:

```
/Volumes/Expansion/
  media/            the library
  old-trickplays/   the historical archive
  seyirlik/         generated, renditions, work, state, logs
```

**Dry run — reports the plan, writes nothing:**

```bash
npm run maintenance:archive-legacy-trickplay -- --archive-root /Volumes/Expansion/old-trickplays --dry-run
```

**Real run:**

```bash
npm run maintenance:archive-legacy-trickplay -- --archive-root /Volumes/Expansion/old-trickplays
```

The archive root is required and never defaulted: this command deletes from a
real library, and where the copies go is the operator's decision.

Each folder's archive path preserves its position relative to the media root, so
the relative path _is_ its identity in the archive:

```
media/Movies/Dune (2021)/Dune (2021) [438631].trickplay/320 - 10x10/0.jpg
old-trickplays/Movies/Dune (2021)/Dune (2021) [438631].trickplay/320 - 10x10/0.jpg
```

Nothing is flattened by basename — two films each with a `trailers/trailer.trickplay`
would otherwise become one.

**The lifecycle is discover → copy → verify → remove, never a move.** Every
regular file is compared by relative path, size and SHA-256. A single mismatch
anywhere in a folder keeps the whole folder and reports a failure. A destination
that already holds identical bytes is recognised as a completed archive and the
original may then go; a destination holding _different_ bytes is a conflict — the
archive is not overwritten, no `copy 2` name is invented, and the original stays.
An interrupted run resumes naturally on the next invocation.

Selection is an exact `.trickplay` suffix test, never a substring search, and
the managed `trickplay` directory is excluded explicitly. Symlinks are refused
rather than followed, in the walk and in the copy, and both roots are checked to
be outside one another before a byte moves.

## What has no authority

`/Volumes/Expansion/old-trickplays` is offline historical comparison material.
Nothing under it is served, scanned, catalogued, or considered by generation
eligibility, `deleteForItem`, or generated-storage cleanup.

Legacy `*.trickplay` folders inside the media volume have no authority either,
even before they are archived. A title has live trickplay when, and only when,
there is a `trickplay_sets` row _and_ the managed directory that row's file
resolves to. The presence of `Dune (2021) [438631].trickplay` next to a film
does not make Seyirlik think that film has trickplay, and does not stop it
generating some.

## Terminology

The operation is called **trickplay**, never "thumbnails". This product has real
thumbnails — the `thumb` artwork type, cover art, provider images — and they
keep their name. The change was made at the source: the job handler emits
`Generating trickplay`, so every consumer downstream receives truthful wording.

| Situation      | English                    | Turkish                         |
| -------------- | -------------------------- | ------------------------------- |
| Action         | Generate trickplay         | Trickplay oluştur               |
| Bulk discovery | Scan for missing trickplay | Eksik trickplay'leri tara       |
| Running        | Generating trickplay       | Trickplay oluşturuluyor         |
| Sweep          | Trickplay sweep            | Trickplay taraması              |
| No result      | No trickplay generated     | Trickplay oluşturulmadı         |
| Sheets written | Trickplay sheets generated | Oluşturulan trickplay sayfaları |

Internal names such as `thumbnailCount` are left alone: they correctly describe
the number of individual preview tiles, and renaming them would be churn.
