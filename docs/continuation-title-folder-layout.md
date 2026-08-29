# Continuation prompt for Codex — title-folder library layout

Repo: `/Users/sonat/Documents/Development/Media-Server`
Lab: `/Volumes/Expansion/seyirlik-lab`, lab server `http://127.0.0.1:43111`
(`bash scripts/run-media-lab-server.sh`; it runs from source via tsx, so restart
it after any server change, and `npm run build` after any client change because
the server serves `dist`).

## State at handoff — everything below is green

```
npx vitest run     1282 passed, 0 failed, 20 skipped (database-gated)
npx tsc --noEmit   clean
npm run lint       0 errors, 178 warnings (pre-existing baseline)
npm run format:check  clean
```

The packaging, publishing and serving layers are **done**. The remaining work is
the player labels, the artwork move, and regenerating the lab library.

## The goal

Everything a title owns lives in the title's own folder instead of a parallel
tree keyed by an opaque id:

```
Dune (2021)/
  Dune (2021).mp4              source, untouched (removable once this is proven)
  content/                     backdrop, cover, logo, trailers   <-- NOT DONE
  video/2160p60 HDR.mp4        video only, no audio
  video/1080p60.mp4  480p.mp4  360p.mp4  240p.mp4  144p.mp4
  audio/english.m4a            one file per kept language
  subtitle/english.vtt
  .seyirlik/                   playlists + manifests, hidden
    master.m3u8
    package.json               operational manifest
    build.json                 packager's record: validation, keyframes, bitrates
    video/1080p60.m3u8   audio/english.m3u8   subtitle/english.m3u8
```

Rules already agreed with the user:

- Video renditions carry **no** audio (already true).
- Ladder: 2160, 1080, 720, 480, 360, 240, 144, **plus the source's own class** as
  a real processed rendition — that top rung is what makes the source file
  removable later.
- Frame rate: 60 kept at 720p and above, halved to 30 below, never above source.
- Labels: `60` joined to the `p` (`1080p60`), `HDR` after a space
  (`2160p60 HDR`), plain `480p` at 24/30 fps.
- Audio is `.m4a` (AAC in fMP4), not `.mp3`. Subtitles `.vtt`.
- Artwork: **one** `backdrop` — collapse the duplicate landscape usage onto it —
  and rename the `folder` image type to `cover`. Artwork and trailers into
  `content/`.
- Never modify or delete production media under `/Volumes/Expansion/media`.
- The source file is read-only to the processor and is never moved or rewritten.

## Decisions taken that differ from the original sketch

The user's sketch showed `video/2160p60 (original).mp4`. They then chose
"process the source quality as well so we have original source and processed
original quality", so:

- The **source file stays where it is** and is untouched. It is still offered as
  `Original` in the quality list.
- The top rung is a **processed rendition at the source's own class**, named
  plainly (`2160p60 HDR.mp4`) with no `(original)` marker. When the sources are
  eventually deleted, that rung takes over with no rename and no URL change.
- `(original)` is instead used on an **audio** track carrying the original
  language disposition (`audio/english (original).m4a`).

HLS needs playlist files, and putting them in `video/` would litter the folders
the user wants clean, so `video/`, `audio/` and `subtitle/` hold **only** media
files and the `.m3u8` playlists plus manifests live in a hidden `.seyirlik/`
directory at the title root, referring to media by relative path. Cache
correctness does not depend on the filenames: the package's build stamp is in the
URL, so a regenerated rendition is served from a new URL even though the file on
disk keeps its name.

## What is done

1. `src/renditions/adaptive/layout.ts` (+ test) — ladder classes,
   `frameRateForClass`, `qualityLabel`, `safeFileStem`, `audioFileStem`,
   `subtitleFileStem`, `GENERATED_TITLE_DIRECTORIES`.
2. `src/renditions/policy.ts` — `RENDITION_TARGETS` extended to seven rungs;
   `buildRenditionRequirements` emits the source's own class first at the
   source's real dimensions (a 2.39:1 4K master stays 3840x1604). Generated
   folders added to `EXCLUDED_DIRECTORY_NAMES`.
3. `src/renditions/encoding.ts` — bitrate policy for 2160/360/240/144 in both
   codec families; `levelFor` fixed for 4K (was declaring 4.1, a level that does
   not admit a 4K frame).
4. `src/renditions/adaptive/encoding.ts` — `AdaptiveVideoOutput.frameRate`, an
   `fps=` filter before the scale only where the rate changes, per-rung level
   and GOP.
5. `src/renditions/adaptive/titleLayout.ts` (+ test) — plans published paths,
   rewrites rendition playlists and the master, percent-encodes names.
6. `src/renditions/adaptive/publishTitle.ts` (+ test) — moves the validated
   package in, stages then swaps by rename, writes `package.json` and
   `build.json`, `readTitlePackageManifest`.
7. `src/renditions/adaptive/packager.ts` — publishes into
   `path.dirname(request.sourcePath)`; "already current" answered from the title
   manifest; the rendition-root pointer is no longer written.
8. `src/renditions/adaptive/metadata.ts` — `enforceCanonicalPaths` option.
9. `src/renditions/adaptive/validation.ts` — recognises both layouts (prefers
   `.seyirlik/build.json`), resolves master and segment URIs relative to the
   playlist and decodes percent-encoding before comparing.
10. `src/renditions/adaptive/inspect.ts` — now takes `titleRoot` and reads
    `.seyirlik/build.json`; a fingerprint or profile mismatch is reported as
    `stale`, not as a parse failure. Callers updated: `renditionService.ts`,
    `analysis.ts`, `scripts/media-renditions.ts`.
11. `src/server/renditionService.ts` — resolves assets from the title folder;
    the playback URL names the master's real path; `ADAPTIVE_ASSET_PATTERN`
    replaced with a traversal-safe **shape** check (see the trap below).
12. `src/server/ownApi/scanner/nameParser.ts` — `GENERATED_TITLE_DIRECTORIES`
    added to `EXTRA_DIRECTORY_NAMES`.

`npx vitest run src/renditions/adaptive/packaging.integration.test.ts` — 17/17
with real ffmpeg encodes, including alignment across mixed frame rates.

## What is left, in order

1. **Player quality labels.** Use `qualityLabel` from
   `src/renditions/adaptive/layout.ts` so the settings panel shows
   `2160p60 HDR` / `1080p60` / `480p`. The manifest already carries
   `qualityHeight`, `frameRate` and `hdr` per rendition.
2. **Artwork into `content/`.** Today artwork is fetched from TMDB into a
   content-addressed store (`src/server/ownApi/images/imageStorage.ts`,
   `<hash>.jpg`); there is **no** on-disk convention in title folders at all,
   and trailers are detected as `*-trailer.*` video files by
   `src/server/ownApi/scanner/libraryScan.ts`. Write `content/backdrop.jpg`,
   `content/cover.jpg`, `content/logo.png`; move trailers to
   `content/trailers/`; rename the `folder` image type to `cover` through
   `ItemImageType` in `src/server/ownApi/catalogue/itemDto.ts` and the UI;
   collapse the duplicate landscape usage onto `backdrop`. Needs a migration for
   existing items. This is a new writer, not a rename.
3. **Regenerate the lab library and verify.** Repackage:

```
export LAB=/Volumes/Expansion/seyirlik-lab
SEYIRLIK_MEDIA_ROOT="$LAB/media" \
SEYIRLIK_RENDITION_ROOT="$LAB/outputs/native-cmaf" \
SEYIRLIK_RENDITION_STATE_ROOT="$LAB/reports/native-cmaf" \
npm run media:renditions:process -- --profile adaptive --workers 1
```

Then `npm run media:lab:verify-matrix`, `npm run media:lab:verify-http`, and the
browser batteries in
`/private/tmp/claude-501/-Volumes-Expansion/1f7af0f1-5972-4ffe-ba85-089a3b1eae1e/scratchpad/audit-harness`
(`node startup.mjs chrome|webkit`, then `audio.mjs`, `quality.mjs`,
`subtitles.mjs`, `seeking.mjs`). They need a lab admin account — the temporary
one was deleted; re-provision with `npm run admin:provision` against the lab
database and update the ids in `harness.mjs` to match the catalogue.

Old packages still sit under `$LAB/outputs/native-cmaf/`. Nothing reads them any
more; delete only with the user's say-so.

## Traps that already cost time

- **A package is published beside its source**, so two runs against one fixture
  share a destination and the second finds the first as "already current". Every
  packaging test copies its fixture into its own title folder first. Keep doing
  that, and never let a suite build into `getAdaptiveFixtureDirectory()`.
- **`ADAPTIVE_ASSET_PATTERN` is an allow-list in front of the package.** It was
  previously a list of layouts and was not updated when the packager gained
  subtitle renditions, so every subtitle playlist 404d — and a 404 behind an
  advertised subtitle group does not degrade to "no subtitles", it fails the
  whole title (`subtitleTrackLoadError` in Chrome, `MEDIA_ERR_DECODE` in
  WebKit). It is now a traversal-safe shape check, with authorisation resting on
  the manifest's exact-match map. Do not turn it back into a layout list.
- **Bumping `ADAPTIVE_PROFILE_VERSION` invalidates every package at once** — the
  server declines a stale one and falls back to live transcoding, which this
  FFmpeg build cannot do for HDR. Repackage in the same change.
- **Do not point the database-gated integration suites at the lab database.**
  They own their schema and reset it, which wipes the lab catalogue. Use a
  throwaway database and `--no-file-parallelism` (three of them contend).
- `npm run lint` reports 178 warnings, 0 errors — the pre-existing baseline.

## Standing instructions

Do not weaken, skip, or delete failing tests. Say exactly which engine was
tested — WebKit 26.5 via Playwright is not Safari.app, and driving Safari.app
needs "Allow Remote Automation" (an admin password).
