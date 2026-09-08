# Import

Taking a finished download and making it library media, durably enough that a
crash at any point converges on one answer.

Phase 4 ends with bytes on disk and a path. This is what turns that into a file
the library owns — and it is the first part of Seyirlik that can destroy
something, so almost everything here is about what it refuses to do.

## Layers

```
importRoutes.ts      admin routes; a caller names an acquisition, never a path
importJobs.ts        two handlers on the existing durable job queue
importService.ts     the commit protocol, and recovery from an unknown outcome
importOperations.ts  the only filesystem calls an import may make
importFileSystem.ts  one authorised root, proven twice
importDestination.ts what a file will be called, and where
importSource.ts      what is in the download, and what is claimed of it
importRepository.ts  PostgreSQL, with conditional writes and unique indexes
importState.ts       legal moves, failure classes, retry planning
```

## Who owns what

|             | Owns                                                        |
| ----------- | ----------------------------------------------------------- |
| SABnzbd     | the incomplete bytes, unpacking, repair                     |
| Acquisition | the record that a download finished, and where              |
| Importer    | the transaction: planning, staging, committing, reconciling |
| Library     | the committed file, once it is durable                      |

The rule that keeps those apart: **a source file existing does not mean an
import failed, and a destination file existing does not mean one succeeded.**
Only the database and the filesystem read together say what happened.

## The commit protocol

A filesystem and a database cannot be committed in one transaction, so the
order is chosen so that every point the process can die at leaves evidence the
next process can act on.

```
1  stage      link, copy or move every source to a name beside its
              destination that only this import would have used
2  remember   record each staged file's identity, while it is still staged
3  declare    write `committing` — before the first activation, never after
4  activate   rename staging to the destination, refusing to replace
5  commit     record each file committed; the unique index decides
6  conclude   write `committed` once every file has been
```

**Step 2 is what makes the rest recoverable.** A rename preserves a file's
identity, so the identity of the staged file _is_ the identity the destination
will have. A process that restarts inside step 4 — with no idea whether the
rename happened — looks at the destination and knows from one `stat` whether
the file there is its own work or a stranger's. Without it, "a file exists at
the destination" and "somebody else's film is in the way" are the same
observation, and the only safe response to both would be to stop forever.

Staging is a separate pass over every file rather than being interleaved with
activation, so the window in which the library is half-written is as long as
the renames, not as long as the copies.

### What a crash leaves

| Died during                            | Row says     | Recovery                                       |
| -------------------------------------- | ------------ | ---------------------------------------------- |
| staging                                | `staging`    | discard staging, stage again                   |
| between staging and the declaration    | `staging`    | as above                                       |
| after the declaration, before a rename | `committing` | destination absent → finish the activation     |
| after a rename, before recording it    | `committing` | identity matches → record what is already true |
| after recording, before cleanup        | `committed`  | run cleanup                                    |
| cleanup                                | `cleaning`   | run cleanup again; the import is already good  |

## States, and why `failed` is a claim

`failed` asserts two things: no destination was activated, and the source is
untouched. Nothing in the activation path may say it, because nothing there has
checked. Everything genuinely ambiguous becomes `uncertain`, whose only exits
are the ones reality decides, and `committing` has no path to `failed` at all.

`needs_attention` is for what a person must judge: a destination holding a file
this system did not import, a name that cannot be represented, a download with
no media in it.

## What it refuses

- **A path from a client.** The API takes an acquisition id. The source comes
  from the download that acquisition recorded and is still checked against the
  authorised root; the destination root comes from configuration.
- **A path outside its roots.** Checked lexically before any syscall — which
  catches `..`, backslash-smuggled segments and NUL, and works on a destination
  that does not exist yet — and again after resolution, which is the only check
  that catches a junction planted inside a download. `lstat` throughout, so a
  junction is visible as a junction rather than followed.
- **Replacing anything.** Every write refuses an occupied destination, and
  `COPYFILE_EXCL` refuses it again at the filesystem. `rename` and `copyFile`
  replace silently on POSIX, and that is the behaviour that would lose a film.
- **Deleting anything it did not create.** The discard helper accepts only this
  import's own staging or retirement names. A deletion helper that takes any
  path is one that will eventually be handed the wrong path.
- **Deciding that one release is better than another.** An import replaces
  library media only when it was told the release is an upgrade _and_ the file
  it would replace is one this system imported. A file with no import behind it
  is somebody's own.

## Upgrades

An upgrade never deletes and then hopes. The old file is renamed aside under a
name that says which import moved it, the new one is renamed into place, and
only once that is recorded is the old one discarded. A crash in the two
syscalls between the renames leaves both files on disk; at no point does the
library hold neither.

The row the upgrade replaced is marked `superseded` rather than deleted —
partly because it is the evidence that a file really was in the library, and
partly because the unique index counts only committed rows, so superseding is
what frees the destination at all.

## Choosing hardlink, copy or move

Measured, not assumed. The importer writes a file that does not matter, links
it from one root to the other, compares the two identities, and removes both. A
filesystem that satisfies `link` with a copy fails that check, which is what
stops it silently doubling the library's size.

- **hardlink** when it works: no space, no time, and cleanup removes a name
  rather than a film.
- **copy** when the roots are not one filesystem, or when copies were asked
  for, or when the download must be kept.
- **move** last, and only when nothing wants the source afterwards — it is the
  one choice that cannot be undone by deleting what it created.

## Naming

The layout is the one the library already uses:
`Title (Year)/src/Title (Year).mkv`, and
`Series/Season 1/src/Series - S01E01 - Episode.mkv`. The extension comes from
the source; everything else comes from the target, so a badly named download
cannot name a library file.

Windows refuses more than POSIX does, and refuses some of it silently — a
trailing space or dot is dropped, which turns two plans that look different
into one file — so names are normalised before anything is written. Device
names (`CON`, `NUL`, `COM1`…) are escaped, because `CON.mkv` is not a file.
Unicode is composed, so one title cannot become two destinations.

Paths are budgeted to 200 characters for the library-relative part. Node will
write past Windows' 260-character limit using the `\\?\` prefix, but Explorer,
most players and most backup tools will not read what it wrote — the ceiling is
what everything else can open, not what this process can write.

## Configuration

`SEYIRLIK_IMPORT` in the non-secret settings file:

```json
{
  "downloadRoot": "C:\\SeyirlikDownloads\\complete\\seyirlik",
  "retainSource": false,
  "forceCopy": false
}
```

Absent configuration means no import routes, no handlers and no reconcile
timer. A declared root that is not absolute stops the process at startup, since
a relative one would resolve against whatever directory the service happened to
start in.

The library root is not configured here: it comes from `SEYIRLIK_LIBRARIES`,
by the kind of media being imported.

## Cleanup

Cleanup runs after the commit and cannot un-commit it. A source that will not
delete leaves the library object exactly as valid as it was, and the import
still completes — the two outcomes are recorded separately on purpose. Source
data is only ever removed once a destination is proven durable, and anything
unresolved keeps it, because it is the only other copy of the bytes.
