# Seyirlik — session handoff (2026-09-02)

Repo: `/Users/sonat/Documents/Development/Media-Server`
Branch: `main`, uncommitted. Nothing has been committed or pushed.

This session replaced the adaptive packager's whole-title transaction with
durable five-minute encoding epochs. The work is complete and green; this
document exists so the next session does not have to rediscover the FFmpeg
behaviour that shaped it.

## Standing constraints

- Never modify or delete production media under `/Volumes/Expansion/media`.
  Source media is read-only to the processor.
- Do not weaken, skip or delete failing tests.
- Do not run migrations against the production database. Validate DDL on a
  throwaway database created and dropped for the check (this session did; see
  "How to verify").
- Say exactly which engine was tested. WebKit via Playwright is not Safari.app.

## What this session changed

The packager no longer builds a title as one transaction. The timeline is cut
into nominal five-minute **epochs**; each is encoded by one FFmpeg process with
**one source read and one decode feeding every rung**, then validated,
manifested and atomically renamed into place, after which it is immutable.
Assembly joins them by copying bytes — no decoder, no encoder, no remux.

```text
epoch N:  -ss <midpoint cut> -i source
            trim=start=0,setpts=PTS-STARTPTS      drop the seek pre-roll, rebase to 0
            split → 2160p 1440p 1080p 720p 480p 360p 240p 144p
          -t <first kept frame → next cut>
          validate → write COMPLETE.json → atomic rename → immutable
assembly: init(epoch 0) + every fragment, tfdt/sidx/mfhd shifted onto the
          global timeline, EXTINF recomputed from real decode times
```

Audio became its own whole-title checkpointed stage, so a soundtrack failure
cannot touch a video epoch and a redone epoch cannot re-encode audio.

Everything downstream is unchanged: the same publisher, the same deep package
validator, the same master generator, the same player. There is no
`EXT-X-DISCONTINUITY` and no second `EXT-X-MAP` — the assembled output is
indistinguishable from a single uninterrupted encode, which is why nothing in
playback had to change.

## Traps to know about

These are the two findings that cost the most to establish. Both were proved
with real FFmpeg experiments, not reasoning.

### 1. FFmpeg's accurate `-ss` is not frame-exact for fragmented MP4

An accurate input seek does **not** hand the filter graph only the frames from
the seek point. It also hands over the frame immediately before it, carrying a
negative timestamp, and expects the container to hide it with an edit list. A
progressive MP4 does exactly that, which is why the behaviour is invisible in
ordinary use. Fragmented MP4 has no such edit to apply, so that frame is
delivered.

Measured on a 26 s 23.976 fps fixture: every epoch after the first began one
frame early, the assembled title carried 625 frames where the source had 624,
and every epoch's picture sat a frame later than its own timeline claimed.

The fix is `trim=start=0,setpts=PTS-STARTPTS` at the head of the filter graph,
applied only when a seek is in play (`buildAdaptiveFilterComplex`,
`trimSeekPreroll`). It works because the cut is always placed **midway between
two real frames**, so the pre-roll is the only frame below zero.

### 2. `sidx` is a second, silent record of where a fragment sits

FFmpeg writes a segment index in front of every fMP4 segment, and its
`earliest_presentation_time` duplicates what `tfdt` says. Left at epoch-local
values while `tfdt` was shifted, the assembled file's **frames were perfectly
correct** and its reported duration was that of its last epoch alone — 8.05 s of
a 26.07 s title. FFmpeg's own demuxer prefers the index. Everything that
inspected the media agreed it was fine except the one number the validator
reads. `patchFragment` now shifts `sidx` too, and drops a 32-bit index it cannot
express rather than truncating it.

### 3. Things that were verified and can be relied on

- With each epoch muxed on its own zero-based timeline, every epoch's
  **initialisation segment is byte-identical**, so one init serves the whole
  title. The assembler checks this rather than assuming it, and the epoch
  manifest stores a SHA-256 of the init for that comparison.
- `-force_key_frames expr:gte(t,n_forced*2)` keeps working unchanged: each
  epoch's local timeline starts at ~0 and boundaries are snapped to a whole
  number of two-second segments, so the global grid runs unbroken through every
  join (measured: keyframes at exactly 2.002 s intervals across all joins, in
  every rung).
- `ffprobe -read_intervals` measures its duration from **where the seek landed**,
  not from the requested start. Use an absolute end (`START%END`), never
  `START%+DURATION`, or a source with sparse keyframes returns the wrong window.
  This is why `probeSourceFrameTimeline` uses absolute ends.
- Packet timestamps are used rather than decoded frames when planning
  boundaries: a video packet carries exactly one frame's presentation time, and
  reading packets means the planner never decodes.

## On-disk layout

```text
<workRoot>/<mediaId>/
  <profileVersion>-<fingerprint16>/            durable build — survives everything
    plan.json                                  immutable, deterministic
    epochs/000000/COMPLETE.json + video/<id>/{media.m4s,playlist.m3u8}
    epochs/000002.partial-<pid>-<token>/OWNER.json   never read as done
    audio-stage/COMPLETE.json + audio/<id>/…
  <profileVersion>-<fingerprint>.<pid>-<id>.partial/   this attempt's staging
```

A directory named `000011` is finished. `000011.partial-…` is in progress and
nothing may read it. Nothing moves between the two except an atomic rename
performed _after_ validation, with the manifest already written inside — so a
crash leaves either a complete checkpoint or an obviously incomplete one, never
something that looks complete and is not.

The checkpoint root is removed in exactly one place: after a successful publish,
in `packageAdaptiveRendition`. Nothing else may delete a valid checkpoint.

## Where things live

| Concern                                         | File                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| Constants, directory naming, versions           | `src/renditions/adaptive/epochs/policy.ts`                       |
| Boundary planning, determinism, identity        | `epochs/plan.ts`                                                 |
| Source packet probing, midpoint cuts            | `epochs/sourceTimeline.ts`                                       |
| Layout, manifests, promote, reconcile           | `epochs/checkpoints.ts`                                          |
| ISO-BMFF box walking, tfdt/sidx/mfhd/trun edits | `epochs/fragments.ts`                                            |
| Level-one (per-epoch) validation                | `epochs/validateEpoch.ts`                                        |
| The resumable encode loop                       | `epochs/engine.ts`                                               |
| Whole-title audio stage                         | `epochs/audioStage.ts`                                           |
| Byte-copy assembly                              | `epochs/assemble.ts`                                             |
| Progress maths, ETA smoothing, interpolation    | `epochs/progress.ts`                                             |
| EIO / ENOSPC / ENOENT classification            | `epochs/failure.ts`                                              |
| Checkpoint-preserving cleanup                   | `epochs/cleanup.ts`                                              |
| CLI `status` summary                            | `epochs/status.ts`                                               |
| Orchestration (unchanged entry point)           | `src/renditions/adaptive/packager.ts`                            |
| 4 Hz cross-process progress file                | `src/server/ownApi/processing/liveProgress.ts`                   |
| Job lifecycle, event log, DB throttling         | `processing/jobRunner.ts`                                        |
| Epoch columns                                   | `processing/jobStore.ts`, `migrations/010_processing_epochs.sql` |
| SSE `live` lane at 250 ms                       | `processing/processingRoutes.ts`                                 |
| Page + `EpochPanel`                             | `src/pages/admin/MediaProcessingPage.tsx`                        |
| Presentation rules (tested without rendering)   | `src/pages/admin/processingModel.ts`                             |

## How to verify

```sh
npm run build                                    # tsc --noEmit && vite build
npx vitest run                                   # 1918 passed | 21 skipped (200 files)
npx vitest run --config vitest.browser.config.ts # 22 passed | 2 skipped, Chromium + WebKit
npx eslint src scripts                           # 0 errors (185 pre-existing warnings)
npm run bench:epochs -- --generated-seconds 900 --epoch-seconds 300
```

The epoch suites are the ones that matter and they need real FFmpeg:

```sh
npx vitest run src/renditions/adaptive/epochs                  # 111 tests
npx vitest run src/renditions/adaptive/epochs/failureInjection.integration.test.ts
npx vitest run --config vitest.browser.config.ts src/components/player/epochPackagePlayback.browser.test.tsx
```

**The migration has not been applied to any real database.** Validate it the way
this session did — create a scratch database, run `runMigrations`, inspect
`information_schema`, drop it — then apply with `npm run db:migrate` when you
are ready. The new columns are additive with defaults; nothing existing changes
meaning.

## Measured evidence

Benchmark (10-core Apple silicon, `h264_videotoolbox`, 6-rung ladder, 1080p
23.976). Baseline is the previous architecture exactly: one invocation, one
decode, whole ladder plus audio.

| 15:00 source                     | Wall  | Speed  | CPU   | Output    | FFmpeg runs |
| -------------------------------- | ----- | ------ | ----- | --------- | ----------- |
| One pass (previous architecture) | 03:31 | 4.261× | 648 s | 161.7 MiB | 1           |
| Checkpointed, 3 × 300 s epochs   | 03:47 | 3.951× | 669 s | 161.6 MiB | 4           |

+7.8 % end-to-end. The encode itself is +2.9 %; assembly is 1.8 %; validation
and publication are 2.6 % and the old architecture also paid them — the
encode-only baseline simply skipped them. Genuinely new cost ≈ +4.7 %. At an
unrealistically dense 60 s epoch the figure is +13.4 %.

Recovery, 20:00 source, 300 s epochs, drive pulled during epoch 3:

```text
checkpoint saved — protected through 05:00 (1/4, 52.3 MiB)
checkpoint saved — protected through 10:00 (2/4, 52.6 MiB)
encoding epoch 3/4 10:00–15:00
outcome: interrupted / storage — The storage this job needs became unavailable (/Volumes/Expansion).
progress when the drive went: 50.0% (09:59)
durable epochs on disk: 000000, 000001
--- drive back ---
reconciled: reusing 2/4 checkpoints, protected through 10:00
outcome: ready — 3 ffmpeg invocations, 228.9 MiB published
```

Timeline correctness (26 s 23.976 fps fixture, 4 epochs): assembled renditions
carry frame-for-frame identical PTS to the source, strictly increasing, keyframes
on an unbroken 2.002 s grid across every join and identical between rungs,
decoding clean, passing the existing deep package validator.

## Gate at handoff

- `npm run build` — clean.
- `npx vitest run` — 1918 passed, 21 skipped, 200 files, 0 failed.
- Browser suite — 22 passed, 2 skipped, on Chromium (hls.js) and WebKit (native
  HLS), stable across three consecutive runs.
- `npx eslint src scripts` — 0 errors. The 185 warnings all pre-date this work.
- Prettier — every file this session touched is formatted. Thirteen files were
  already unformatted before it started and were deliberately left alone.

## Known open items

1. **The migration has not been applied.** `npm run db:migrate` when ready.
2. **Nothing is committed.** The change set is 21 modified files plus
   `src/renditions/adaptive/epochs/`, `liveProgress.ts`,
   `010_processing_epochs.sql`, `benchmark-epoch-checkpoints.ts`,
   `epochPackageFixture.ts` and `epochPackagePlayback.browser.test.tsx`.
3. **Old in-progress adaptive work is not migrated** and is not intended to be.
   It has no plan and no way to prove which part of the timeline its bytes
   cover, so the first run re-encodes and `cleanup` removes the leftovers.
   Published packages are unaffected: `ADAPTIVE_PROFILE_VERSION` did not move.
4. **FFmpeg's pid is not in the structured record.** Everything else asked for is
   (per-job event log with detail JSON): media id, epoch index and window,
   fingerprint, encoder, state transitions, checkpoint creation/reuse/
   invalidation-with-reason, pause/resume, storage loss and recovery, assembly,
   validation, publish. `runFfmpeg` does not surface the pid and its signature
   was left alone.
5. **No "Retry storage check" button.** The watchdog polls every 5 s and
   auto-resumes, so a button would be theatre. The string was removed rather
   than shipping one.
6. **Variable-rate seams**: sub-frame seams are closed by adjusting the previous
   epoch's last sample; a gap over ~1.5 frames is preserved as a genuine source
   gap and counted in `sourceGaps` (warned, never silently filled). This has not
   been exercised against a real VFR feature-length source, only the synthetic
   VFR fixture in the existing packaging suite.
7. **`--older-than-hours` on `cleanup` is now accepted and ignored**, so existing
   cron lines keep working. Age is no evidence about a checkpoint.
8. **Not touched**: `docs/media-processing-lab.md` and the lab HTTP verifier.
   They exercise the published package shape, which is unchanged.

## Prompt for the next session

```text
You are working in my Seyirlik Media-Server repository at
~/Documents/Development/Media-Server, on branch main with uncommitted work.

Read docs/session-handoff-2026-09-02.md first. It describes an adaptive
packaging rewrite completed in the previous session: the timeline is now cut
into durable five-minute encoding epochs, each encoded by one FFmpeg process
with one shared decode across the whole rendition ladder, checkpointed
immutably on disk, and joined at the end by copying bytes rather than
re-encoding. Read the "Traps to know about" section before touching anything
in src/renditions/adaptive/epochs/ — it records FFmpeg behaviour that is not
obvious and that silently corrupts the timeline if forgotten.

Current state: build clean, 1918 tests passing, browser suite green on
Chromium and WebKit, lint clean. Nothing committed. Migration
010_processing_epochs.sql has been validated on a throwaway database but not
applied to a real one.

Standing constraints: never modify or delete production media under
/Volumes/Expansion/media; do not weaken, skip or delete failing tests; do not
run migrations against the production database without asking; verify claims
by measurement rather than by reasoning about FFmpeg.

What I want you to do next:

<state your task here — for example one of:>
  - Apply the migration and take a checkpointed build through the admin page
    against a real title on the Expansion volume, watching the live progress,
    then pause, cancel, retry and pull the drive to confirm the recovery
    behaviour end to end on real hardware.
  - Commit the work in reviewable pieces with clear messages.
  - Exercise a real variable-frame-rate feature-length source and confirm the
    seam handling in epochs/assemble.ts holds (open item 6).
  - Record the FFmpeg pid in the job event log (open item 4).

Before declaring anything done: npm run build, npx vitest run,
npx vitest run --config vitest.browser.config.ts, npx eslint src scripts.
```
