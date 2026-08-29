# Media processing system

Seyirlik processes its own library. This describes what runs, where its state
lives, and how to operate it.

## What it does

For one source file the system probes it, decides what to produce, estimates the
disk it needs, encodes an aligned CMAF/HLS package, validates that package, and
publishes it atomically under a build-versioned path. The source is never
written to.

## Architecture

```
                 admin UI  /dev/media-processing
                     |  REST + Server-Sent Events
        ownApi/processing/processingRoutes.ts
                     |
   processing_jobs   |   jobs (generic durable queue: leases, retry, dedupe)
   jobStore.ts <-----+-----> tasks/jobQueue.ts -> tasks/worker.ts
                     |
        ownApi/processing/jobRunner.ts   (stages, progress, cancellation)
                     |
   renditions/processing/decide.ts       (what to produce, and why)
   renditions/processing/streamPolicy.ts (which languages survive)
   renditions/hardware/detect.ts         (what this machine can encode with)
                     |
   renditions/adaptive/packager.ts       (encode, package, validate, publish)
```

Scheduling and media work are deliberately separate. The generic `jobs` table
already provides leases, retry, cancellation and de-duplication, so a processing
job has one scheduling row there and one domain row in `processing_jobs`. A
worker claims the first and writes the second.

## Hardware

`detectHardware()` probes by actually encoding a frame at the size processing
will use, because an encoder can be compiled into FFmpeg on a machine with no
accelerator to run it, and one that opens at a thumbnail size can still refuse a
real frame. Adapters that cannot run here are still reported with a reason, so
the page can explain an absent hardware path rather than leaving a blank space.

| Adapter               | Platform | State in this build                           |
| --------------------- | -------- | --------------------------------------------- |
| Apple VideoToolbox    | macOS    | Implemented and proven                        |
| CPU (libx264/libx265) | any      | Implemented and proven                        |
| Intel Quick Sync      | any      | Implemented; reported unavailable when absent |
| NVIDIA NVENC          | any      | Recognised; encoder arguments not written yet |
| AMD AMF               | Windows  | Recognised; encoder arguments not written yet |
| VA-API                | Linux    | Recognised; encoder arguments not written yet |

The adapter interface is the cross-platform contract. Adding NVENC, AMF or
VA-API means writing their encoder arguments in
`renditions/adaptive/encoding.ts` and adding them to `DRIVEABLE_ENCODERS`;
nothing above that layer changes.

## Retention policy

Audio, in order:

1. the source's own default track, whatever language it is in;
2. the best English track, if English is not already kept;
3. the best Turkish track, if Turkish is not already kept.

"Best" prefers more channels, then lossless, then bitrate, then the default
flag. A language already covered is not kept twice. Commentary and audio
description are opt-in and are held apart from the language de-duplication,
because commentary is a different programme rather than another mix of the same
one. Every keep and drop is recorded with its reason.

Subtitles: English and Turkish, plus their forced tracks. SDH is opt-in. Text
subtitles become WebVTT; image subtitles (PGS, VobSub, DVB) are retained and
flagged as needing OCR or burn-in rather than silently discarded.

Generated audio is AAC stereo. This is a compatibility floor, not a preference:
Chromium rejects AAC 7.1 outright, and some Chromium versions fail AAC 5.1 after
a seek. The original file keeps its surround tracks.

## Stages and progress

`waiting → analysing → planning → video → audio → subtitles → packaging →
validating → publishing → complete`

Overall progress is a weighted sum, not "stage N of 9": encoding is worth 70% of
the bar because it is where the time goes. Progress is a high-water mark in both
the runner and the database, so an out-of-order update or a retry cannot walk
the bar backwards. FFmpeg is read through `-progress`, never by parsing its
console output.

## Live progress

`GET /processing/jobs/:id/stream` is Server-Sent Events. Every stage event
carries the job's own sequence number as the SSE id, so a browser reconnecting
with `Last-Event-ID` resumes exactly where it stopped rather than replaying the
timeline or losing part of it.

## Safety

- The source is opened read-only and never written to.
- A package is built in a staging directory and published by an atomic rename.
- The previous published package stays in place until its replacement is ready.
- Publication happens only after validation passes; a failed package stays as
  diagnostics and never becomes playable.
- Free space is checked before encoding, against the package plus its staging
  copy plus a reserve.
- One active job per media file, enforced by a partial unique index, so two
  workers cannot process the same source and an operator cannot queue it twice.
- Cancellation aborts FFmpeg itself, not just the loop around it, and never
  removes an already-published package.

## Output URLs

Adaptive assets are served `immutable`, so their URL is keyed to the package
build — profile version, source fingerprint and the package's creation stamp.
Rebuilding a package therefore lands on a new URL, and a client holding the old
one misses rather than reading new media through a stale playlist.

Only the asset shapes named in `ADAPTIVE_ASSET_PATTERN`
(`src/server/renditionService.ts`) are servable: the master, the video and audio
renditions, and the WebVTT subtitle renditions. It is an allow-list, so adding a
new rendition kind to the packager means adding it here too — a shape the master
advertises but this pattern does not name returns 404, and a 404 behind an
advertised subtitle group does not degrade to "no subtitles", it fails the whole
title in both engines.

Raising `ADAPTIVE_PROFILE_VERSION` invalidates every existing package at once:
the server declines a stale one and falls back to live transcoding, which for an
HDR source this FFmpeg build cannot do. Repackage the library in the same change
that raises it.

## Operating it

Open **Developer tools → Media Processing** (`/dev/media-processing`).

- The header shows what this machine can encode with, and why anything absent is
  absent.
- Choose a title and press **Preview decision** to see what would happen —
  rungs, encoder, estimated size, and every language keep/drop — without
  queueing anything.
- **Start processing** enqueues it. The queue row shows stage, progress, speed,
  frames per second, time remaining and output size.
- **Inspect** opens the stage timeline, the disk impact, the retained and
  dropped languages, the validation result, and the raw event log behind a
  diagnostics panel.
- **Cancel** stops the encode; **Retry** re-queues a job that failed or was
  cancelled.

From the command line, the existing CLI still works and shares the same
packager:

```sh
npm run media:renditions:process -- --profile adaptive --all-audio-tracks
```

## Lab

All first-run source, staging, output, logs and reports live under
`/Volumes/Expansion/seyirlik-lab`. Start the isolated server with:

```sh
npm run media:lab:server
```

and verify with `npm run media:lab:verify-matrix` and
`npm run media:lab:verify-http`.
