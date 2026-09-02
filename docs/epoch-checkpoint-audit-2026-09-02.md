# Epoch checkpointing — production-readiness audit (2026-09-02)

Audit of the durable five-minute encoding epochs described in
`docs/session-handoff-2026-09-02.md`. Everything below was established by
running the code and measuring its output. Where a claim in the handoff turned
out to be wrong, the measurement that shows it is given rather than an opinion.

**Verdict.** One blocking defect (§1), one design gap (§1), and two documented
behaviours that do not happen (§3, §4). The first two are fixed with regression
tests; the last two are corrections to the record, not to the code. The
architecture itself measures out well: on a real 16-minute HEVC/10-bit/PQ title
cut into three epochs, all eight rungs assembled to one initialisation segment,
one keyframe grid and zero discontinuities, and real Safari played through both
joins.

Environment: FFmpeg 9.0.1, Node 22.23.2, macOS 25.3.0, MacBookPro18,2 (10 core).
The production worker was encoding another title throughout, so wall-clock
figures are pessimistic.

---

## 1. Persistent EIO versus missing storage

Files: `src/renditions/adaptive/epochs/failure.ts`,
`epochs/engine.ts`, `epochs/policy.ts`,
`src/server/ownApi/processing/jobRunner.ts`,
`src/renditions/processing/storageWatchdog.ts`,
`src/server/ownApi/nativeRuntime.ts`.

### What was already right

`storageWatchdog.ts` does check volume _identity_, not just presence: it
remembers the `st_dev` each root was on when last healthy and treats a root that
returns on a different device as still missing (`storageIdentity`, and the
`previous !== device` branch in `poll`). A different disk mounted at
`/Volumes/Expansion` is therefore not mistaken for recovery.

### Defect A — a parked job the watchdog cannot see (blocking)

`finishStorageInterrupted` in `jobRunner.ts` set `state: "paused"` and cleared
`errorCode`, `errorMessage` and `finishedAt`, but never set `paused_reason`.
Recovery runs through `requeueStorageInterruptedJobs` in `nativeRuntime.ts`,
which finds work with `processingJobs.listPaused("storage-unavailable")` — a
query on `paused_reason`.

So a job parked by the encoder's own `EIO` classification — which is the
_ordinary_ path, because the engine classifies before the watchdog's five-second
poll has run — landed in `paused` with no reason, no error, no finish time, and
nothing that would ever pick it up again. It only recovered by accident: if the
volume really had gone, the watchdog's `onLost` later stamped the reason via
`requestPause` (`ACTIVE_STATES` includes `paused`). If the volume had _not_ gone,
nothing ever did.

Reproduced before fixing:

```
FAIL src/server/ownApi/processing/jobRunner.test.ts >
     stamps the storage reason so the watchdog can find the job it parked
AssertionError: expected null to be 'storage-unavailable'
```

Fixed by stamping `pausedReason: "storage-unavailable"` in
`finishStorageInterrupted`.

### Defect B — no escalation, so a healthy volume with bad media waits for ever

`classifyFailure` returned `storage-unavailable` for any message matching
`looksLikeStorageLoss` **regardless of whether the storage was available**. The
existing test named that as intended behaviour ("recognises an I/O error as
disappearing storage even before the watchdog notices"), and the reasoning is
sound _once_: the watchdog polls, so the first `EIO` proves nothing. But there
was no bound. A mounted, healthy, identical volume whose source returns `EIO`
from a bad region was classified as a disconnection every time.

Implemented escalation. State transitions, all in `engine.ts`'s per-epoch
attempt loop:

```
FFmpeg exits non-zero
  └─ ask storageAvailable() directly
       ├─ false ──────────────────────────────► storage-unavailable
       │                                        StorageInterruptedError
       │                                        job → paused (reason stamped)
       │                                        watchdog auto-resumes
       ├─ true, ENOSPC ───────────────────────► out-of-space
       └─ true, EIO-shaped
            └─ wait SOURCE_IO_RETRY_BACKOFF_MS[n]   (1s, 6s, 12s — each longer
               │                                     than one 5s watchdog poll)
               └─ ask storageAvailable() again
                    ├─ false ──────────────────► storage-unavailable  (late discovery)
                    └─ true
                         ├─ n < 4 ─────────────► bounded source readability
                         │                       re-check (ffprobe over the
                         │                       epoch's own window), discard
                         │                       the partial epoch, retry.
                         │                       Emits `source-io-retry` to the
                         │                       job event log.
                         └─ n = 4 ─────────────► source-io
                                                 SourceReadError
                                                 job → FAILED, needs a person
                                                 every checkpoint preserved
```

The read budget is per epoch and separate from the validation-retry budget, so a
bad region cannot be masked by a validation retry and vice versa. A missing
volume always wins over an exhausted read budget: a drive pulled mid-escalation
is still a drive pulled.

Tests: six unit tests in `epochs/failure.test.ts` (`escalating a repeated I/O
error`, `SourceReadError`), three real-FFmpeg integration tests in
`epochs/failureInjection.integration.test.ts`:

- `waits for the volume when the re-check finds it has gone` → `interrupted` /
  `storage`, checkpoints `["000000","000001"]` intact, no partials left.
- `re-reads a source that failed once and finishes the title` → `ready`, exactly
  one `source-io-retry` event. **This is new behaviour**: a transient read error
  used to park the build for a watchdog transition that was never coming.
- `gives up on a source that keeps failing while its volume stays healthy` →
  `failed` (not `interrupted`), message names damaged media or a failing disk,
  retries bounded at `[1,2,3,4]`, checkpoints `["000000","000001"]` intact.

---

## 2. Initialisation segment / codec configuration safety

The digest chain:

| Stage       | Location                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Generated   | `epochs/validateEpoch.ts:173` — `createHash("sha256").update(init)`, over the exact `EXT-X-MAP` byte range |
| Recorded    | `epochs/checkpoints.ts:79` — `EpochRenditionRecord.initDigest`                                             |
| Written     | `epochs/engine.ts:502` — into the epoch's `COMPLETE.json`                                                  |
| Compared    | `epochs/assemble.ts:126-139` — against epoch 0, per rendition                                              |
| On mismatch | Throws, naming the epoch, **before the output stream is opened**                                           |

Because the digest is over the whole initialisation segment, it subsumes every
field the audit asked about — VPS/SPS/PPS inside `hvcC`/`avcC`, profile, level,
pixel format, dimensions, the `colr` box and its HDR signalling, and the `mdhd`
timescale. There is no field list to keep in step with the format. The timescale
is _additionally_ compared on its own, because it is the one value assembly
arithmetic uses, and a mismatch deserves a message an operator can act on.

There was no test that a mismatch is rejected. Added `epochs/assemble.test.ts`
(6 tests), including deliberately altering one epoch's digest and one epoch's
timescale, and asserting no media file is created when the check fails.

Measured on the real HDR title — 8 rungs × 3 epochs, `unique_digests=1` for
every rung:

```
1080p: epochs=[0,1,2] digest=12d69b8b1175e4f2… unique_digests=1 timescale={24000} pix={'yuv420p10le'} colour={('bt2020','smpte2084','bt2020nc')} dims={(1920,800)} codec={'hvc1.2.4.L120.b0'}
1440p: epochs=[0,1,2] digest=1d55ef70e502ac35… unique_digests=1 … dims={(2560,1066)} codec={'hvc1.2.4.L150.b0'}
2160p: epochs=[0,1,2] digest=731d4037cc5120eb… unique_digests=1 … dims={(3840,1600)} codec={'hvc1.2.4.L150.b0'}
 720p: epochs=[0,1,2] digest=8772198eb19603c6… unique_digests=1 … dims={(1280,534)}  codec={'hvc1.2.4.L93.b0'}
 480p / 360p / 240p / 144p: likewise
ALL RENDITIONS BYTE-IDENTICAL INIT ACROSS EPOCHS: True
```

---

## 3. Assembler audit

### What FFmpeg 9 actually writes

Inspected with the repository's own `walkBoxes`, on both a synthetic encode and
the production HDR package:

```
sidx  v1  refId=1 timescale=24000 EPT=48048 refCount=1
          refs={type:0, size:2586620, dur:48048, sap:0x80000000}
moof  → mfhd sequence=2
      → traf → tfhd, tfdt v1 baseMediaDecodeTime=48048,
                     trun flags=0x205 sampleCount=48 dataOffset=304
mdat
```

Three consequences the code did not know about:

1. **`tfdt` is version 1.** The 32-bit widening path in `widenTfdt` is
   unreachable with this muxer. (The comment justifying it is also wrong on the
   arithmetic: 2½ hours at 90 kHz is 8.1 × 10⁸ ticks, not past 2³².)
2. **`sidx` is version 1.** The 32-bit "drop the index" path is likewise
   unreachable.
3. **`trun` flags are `0x205`** — data offset, first-sample flags, sample
   _sizes_. No sample **durations**, and no composition offsets. Durations come
   from `tfhd`'s default.

`fragments.test.ts` builds fragments with a v0 `tfdt`, a v0 `sidx` with
**zero references**, and per-sample durations present — a shape FFmpeg does not
produce. Added `epochs/fragments.real.integration.test.ts` (13 tests) which
encodes with the real muxer at the packager's own settings and pins all of the
above, so a future FFmpeg that changes it is caught here.

### Whole-title measurement

485 fragments of the assembled 2160p HDR rendition, every one parsed:

```
fragments: 485
sequence numbers strictly increasing: true
sequence numbers unique: true
sequence starts at 1, ends at 485
tfdt strictly increasing: true
sidx EPT === tfdt for every fragment: true
fragments whose predecessor does not end exactly where they begin: 2
   at fragment 150 (t=300.008000s): prev ends 300.008042s, delta -1 ticks (-0.042 ms)
   at fragment 300 (t=600.016000s): prev ends 600.016042s, delta -1 ticks (-0.042 ms)
```

- **`tfdt`** — strictly increasing over the whole title; each epoch shifted by
  `timestampToTicks(planEntry.start, timescale)`.
- **`mfhd`** — 1…485, unique and monotonic.
- **`sidx` earliest presentation time** — equals `tfdt` for all 485 fragments,
  i.e. the second record of position agrees with the first everywhere. This is
  the trap the handoff documented, and it is closed.
- **`sidx` referenced size** — verified to equal `segment length − sidx length`;
  nothing in assembly changes `moof` or `mdat` size, so it stays correct.
- **`trun` data offsets** — unchanged by a patch (asserted byte-for-byte).
- **`moof` size** — unchanged (asserted; no widening occurs).
- **Composition offsets / B-frames** — absent from this encoder's output, and in
  any case they live in `trun` records and `mdat`, both of which are proved to be
  copied unchanged.
- **Duration** — assembled 969.093042 s against a 969.008 s source (+85 ms,
  about two frames, in the final segment's own measured length).
- **Seeking and random access** — see below.

Keyframes across both joins, unbroken at 2.0020 s including the join instants
themselves:

```
298.0060 -> 300.0080   gap 2.0020      (join 1)
300.0080 -> 302.0100   gap 2.0020
598.0140 -> 600.0160   gap 2.0020      (join 2)
600.0160 -> 602.0180   gap 2.0020
```

Decode across each join, and seeks to exactly 05:00 and 10:00:

```
--- decode 297.008s +6s across join at 300.008s ---   exit=0  frames=144  stderr: (clean)
--- decode 597.016s +6s across join at 600.016s ---   exit=0  frames=144  stderr: (clean)
--- seek 300s, decode 3s --- exit=0 (clean), first frame key=1 at 298.006042
--- seek 600s, decode 3s --- exit=0 (clean), first frame key=1 at 598.014042
```

Whole-title packet timing:

```
packets: 23235   (source 23232)
first=0.000000  last=969.051333
distinct inter-frame gaps (us): [(41667, 2), (41708, 15489), (41709, 7743)]
strictly increasing: True
duplicate presentation times: 0
```

The two 41667 µs gaps are the two joins: one tick (41.67 µs, a thousandth of a
frame) tighter than nominal. Everything else is the ordinary 23.976 fps spacing.

### Fixed: a stale second record of duration

`adjustLastSampleDuration` changed a sample's duration in `trun` but left the
enclosing `sidx`'s `subsegment_duration` alone — the same class of defect as the
`earliest_presentation_time` trap, and invisible for the same reason (the
synthetic test fixture's `sidx` has no references). Now updated together;
3 regression tests in `fragments.test.ts`.

### Not fixed, reported

`widenTfdt` grows the `moof` by four bytes and corrects container sizes and
`trun` data offsets, but not a preceding `sidx`'s `referenced_size`. Unreachable
with FFmpeg 9 (both boxes are v1), and reachable only in a window a few frames
wide where the presentation time fits in 32 bits while the decode time does not.
Left alone deliberately rather than adding code to a path the muxer cannot enter.

---

## 4. Variable-rate seam policy

> "sub-frame seams are closed by adjusting the last sample of the previous
> epoch; a gap over ~1.5 frames is preserved as a genuine source gap and counted
> in `sourceGaps` (warned, never silently filled)."

**Neither half of this happens.**

### The adjustment cannot occur

`adjustLastSampleDuration` requires `TRUN_SAMPLE_DURATION_PRESENT`. FFmpeg 9's
constant-rate output does not set it (`flags=0x205`). On a real fragment:

```
{ "adjustReturned": false, "requestedDeltaTicks": 100,
  "trunSumBefore": 48048, "trunSumAfter": 48048, "trunSumChangedBy": 0 }
```

It returns `false` and changes nothing, so `seamsClosed` is always 0 and the
media keeps the muxer's guess. The _playlist_ is still exactly contiguous,
because `assembleVideoRenditions` recomputes every `EXTINF` from the next
fragment's decode time — the seam is closed in the advertised timeline, not in
the media. Measured effect on the real title: two fragments out of 485 declare
one tick (41.67 µs) more than the playlist says. Safari played through both.

Lengthening the header default would move every sample in the fragment;
adding a duration array would change box sizes and every offset past them.
Neither is a change this audit should make. The function now documents why it
refuses, and `fragments.real.integration.test.ts` asserts the refusal leaves the
buffer byte-identical, so the assembler can treat a refusal as "this seam stays
as it is" rather than assuming it was closed.

### The gap cannot be seen

A gap inside an epoch never reaches the assembler: FFmpeg normalises to constant
rate _within each epoch encode_. Measured on a purpose-built fixture — five
stretches at 24/12/30/15/24 fps, eighteen pairs of frames sharing a presentation
time, and a deliberate 2.042 s hole:

```
SOURCE    315 frames   gaps(ms): 0×18, 41×78, 42×154, 83×42, 84×21, 2042×1
ASSEMBLED 408 frames   gaps(us): 41666×136, 41667×271
          duplicate PTS: 0    strictly increasing: True
```

93 frames were invented, the hole was filled, and the duplicate timestamps were
resolved. `sourceGaps` would report **0** for a source that genuinely contains a
two-second hole. Anything relying on that counter is relying on something that
cannot happen. Against the audit's specific questions: it cannot hide a real gap
_at a join_ (that path is intact), it does not invent frame duration (it never
runs), it cannot accumulate A/V drift (there is no adjustment to accumulate), and
it cannot duplicate a presentation time (measured: zero duplicates, strictly
increasing, on both fixtures and on the real title).

Boundaries are already source-derived rather than repaired after the fact:
`buildEpochPlan` places each epoch's start on a real source packet PTS via
`probeSourceFrameTimeline`/`straddlingFrames`, and cuts midway between frames.
The real HDR title's boundaries came out at 300.008 s and 600.016 s, not at
round numbers.

New: `epochs/variableFrameRate.integration.test.ts` (2 tests) builds that
fixture and asserts the behaviour above, so the record cannot drift again.

---

## 5. Progress numerical correctness

The reported "checkpoint protected through 10:00 … progress at interruption
09:59 / 50.0%" is **not reproducible from any code path**, because no code emits
that line. `scripts/benchmark-epoch-checkpoints.ts` contains no such string; it
was prose in the report.

It is also arithmetically impossible. `protectedSecondsAfter(plan, n)` returns
`timestampSeconds(plan.epochs[n].start)` — the presentation time of the first
source frame _at or after_ the boundary, so it is never below it. Measured on
the real title: 300.008 s and 600.016 s, which `formatClock` renders as
`00:05:00` and `00:10:00`, at 30.96 % and 61.92 %. And `epochProgress` floors
`encodedSeconds` at `protectedSeconds` with `Math.max`.

Invariants verified, and now enforced and tested rather than merely emergent:

| Invariant                                              | Where                                                                                                               | Test                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `encodedSeconds ≥ protectedSeconds`                    | `epochs/progress.ts` `Math.max`                                                                                     | 6 parameterised cases                           |
| `protectedSeconds` monotonic                           | `jobRunner` `Math.max` on `epoch-complete`; `processingModel.protectedSeconds` takes the max of row and live sample | 1 test                                          |
| `encodedSeconds ≤ sourceDuration`                      | `Math.min`                                                                                                          | 6 parameterised cases                           |
| epoch-local progress bounded to the epoch              | ceiling at `epochEndSeconds`                                                                                        | 1 test                                          |
| UI interpolation cannot move behind protected progress | **was not enforced** — `smoothedEncodedSeconds` had a ceiling but no floor                                          | now floored at `live.protectedSeconds`; 2 tests |
| UI cannot show 09:59 after 10:00 is durable            | page floored the position at the row but not at the protected mark                                                  | now floored at both; explicit test              |

14 new tests in `epochs/progress.test.ts`, 6 in `processingModel.test.ts`.

---

## 6. Live progress storage location

`src/server/ownApi/processing/liveProgress.ts` — already correct, verified
against the running production processes rather than by reading the code:

```
worker pid 45951  TMPDIR=/var/folders/xg/n4ctjty96yn8lrbx8tg0wm500000gn/T/
server pid 89193  TMPDIR=/var/folders/xg/n4ctjty96yn8lrbx8tg0wm500000gn/T/
df -P "$TMPDIR" → /System/Volumes/Data       (internal boot volume)
```

Both processes are separate launchd jobs (PPID 1) with the _identical_ per-user
temporary directory, which is on internal storage, not `/Volumes/Expansion`. The
samples therefore stay writable and readable when the media volume disappears.

- Atomic writes — write to `<target>.<pid>.tmp`, then `rename`.
- Stale cleanup — `pruneLiveProgress(activeJobIds)` at startup;
  `LIVE_PROGRESS_STALE_MS = 6000` so a reader discards a frozen sample.
- Path safety — the job id is refused unless it matches `^[A-Za-z0-9_-]{1,64}$`.
- Graceful fallback — every write is wrapped and swallowed; telemetry never
  stops an encode.
- No secrets — the snapshot carries job id, epoch position, times, speeds,
  encoder name and quality heights.
- Database is _not_ written at 4 Hz: `PERSIST_INTERVAL_MS = 1000` throttles the
  durable row, and state changes are written on their own.

Overridable with `SEYIRLIK_LIVE_PROGRESS_DIR`.

One thing to know: the directory did not exist at audit time because the running
worker (started 18:56) predates `liveProgress.ts` (written 01:42). **This code is
not deployed.**

---

## 7. Pause, lease and storage edge cases

Real processes, real signals, real `ps` output.

### A job paused with SIGSTOP keeps its lease

The lease is held by the _worker's Node process_, whose heartbeat is a
`setInterval` (`tasks/worker.ts`, `max(1000, leaseMs/3)` = 20 s for the 60 s
default). `bindChildToPauseController` sends SIGSTOP to the FFmpeg **child**
only, so the thing holding the lease is untouched.

```
running:  [{"pid":89776,"state":"S"}]
paused:   [{"pid":89776,"state":"T"}]
holding 85000ms > lease 60000ms ...
  worker heartbeat #1..#5 — lease extended 60000ms      (all delivered while stopped)
  t+20s/40s/60s/80s/100s  [{"pid":89776,"state":"T"}]
ASSERT one process:      true
ASSERT still stopped(T): true
ASSERT same pid:         true
after SIGCONT: [{"pid":89776,"state":"S"}]
ASSERT same pid continued and is not stopped: true
ASSERT no ffmpeg left: true
```

One process throughout, no duplicate worker or FFmpeg, same PID continued.

### A stopped process when the storage goes

```
running pid=90189, 48 bytes written
operator paused: [{"pid":90189,"state":"T"}]
storage reported unavailable -> SIGCONT, then abort
processes after the abort: []      (within 0.6 s)
ASSERT no orphan ffmpeg: true
partial output still on disk (the caller discards it): 109555 bytes
```

The ordering is enforced in two independent places — `jobRunner`'s watchdog
(`pauseController.resume()` then `encodeAbort.abort()`) and `runFfmpeg`'s own
`onAbort`, which sends SIGCONT before SIGTERM (`processor.ts:184-194`). A control
run that aborted _without_ continuing first also left no orphan, because
`runFfmpeg` wakes the process itself:

```
=== SCENARIO C: aborting WITHOUT continuing first ===
stopped: [{"pid":90269,"state":"T"}]
processes 6s after abort: []
orphan left behind: false
```

Checkpoints are preserved on both paths: `handle.discard()` removes only the
partial epoch workspace, and `finishStorageInterrupted` writes no failure.

---

## 8. Test counts

The handoff's "approximately 159 newly added tests" is not supported. Measured
per file, from `npx vitest run`:

| New file                                                | Tests         |
| ------------------------------------------------------- | ------------- |
| `epochs/checkpoints.test.ts`                            | 26            |
| `epochs/plan.test.ts`                                   | 27            |
| `epochs/fragments.test.ts`                              | 15            |
| `epochs/progress.test.ts`                               | 14            |
| `epochs/failure.test.ts`                                | 12            |
| `epochs/cleanup.test.ts`                                | 10            |
| `epochs/failureInjection.integration.test.ts`           | 9             |
| `epochs/epochBuild.integration.test.ts`                 | 7             |
| **subtotal**                                            | **120**       |
| `jobRunner.test.ts` (modified)                          | +3 (15 → 18)  |
| `processingModel.test.ts` (modified)                    | +19 (35 → 54) |
| **total node tests added by the epoch work**            | **142**       |
| `epochPackagePlayback.browser.test.tsx` (browser suite) | 4 cases       |

Baseline before this audit: `1918 passed | 21 skipped (1939)`, 195 files.

"All 9 failure injection tests" is **correct**: `failureInjection.integration.test.ts`
contained exactly 9 `it(...)` blocks. Several of them exercise more than one
scenario, which is where the larger enumeration came from.

---

## 9. Production-like test

Source: a 16-minute stream copy from
`Pirates of the Caribbean - Dead Man's Chest (2006).mkv` — the library's only
HEVC 10-bit PQ title. Read-only; nothing under `/Volumes/Expansion` was written.

```
HEVC Main 10, 3840x1600, yuv420p10le, bt2020 / smpte2084 / bt2020nc,
23.976 fps, 23232 frames, 969.008 s
```

Built with the real ladder and `hevc_videotoolbox`, 300 s epochs:

```
epochCount=3   boundaries 0 → 300.008 → 600.016 → 969.008
epoch 0: 243.2 s wall, 1 122 419 466 bytes
epoch 1: 244.9 s wall, 1 187 242 006 bytes
epoch 2: 295.7 s wall, 1 455 047 260 bytes
STATUS=ready   FFMPEG_INVOCATIONS=4 (3 epochs + audio)   WALL_SECONDS=898.3
```

Eight rungs 2160p→144p, all `hevc_videotoolbox` Main 10, HDR preserved per rung
via explicit `-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc`
and `-tag:v hvc1`. Assembled output:

```
2160p  hevc / Main 10 / hvc1 / level 150 / 3840x1600 / yuv420p10le
       bt2020 / smpte2084 / bt2020nc / 23.976 fps / 969.093042 s / 1 403 565 599 B

every rung: duration 969.093042, 485 segments, EXT-X-MAP=1, EXT-X-DISCONTINUITY=0
master:     VIDEO-RANGE=PQ on all 8 variants
codecs:     hvc1.2.4.L150.b0 (2160p, 1440p), L120 (1080p), L93 (720p),
            L90 (480p), L63 (360p), L60 (240p, 144p), + mp4a.40.2
audio:      aac 48 kHz stereo, 968.893 s
```

Init digests, timeline, keyframe grid, decode through joins, seeks at 05:00 and
10:00, duration and codec strings are all in §2 and §3 above.

Two small discrepancies worth knowing: the assembled title carries 23 235
packets against the source's 23 232 (+3 frames, +85 ms of advertised duration),
and the audio is 200 ms shorter than the video. Neither is drift — both are
fixed offsets at the end of the title.

---

## 10. Real Safari

Served over a byte-range-capable local server and driven by a page that plays,
seeks and posts its own results back, so nothing depends on reading a screenshot.
**Safari 26.3.1 on macOS**, native HLS (not WebKit under Playwright):

```
userAgent: … AppleWebKit/605.1.15 … Version/26.3.1 Safari/605.1.15
ok: True   errors: []
duration: 969.093
join1: {'from': 299.814, 'to': 305.816, 'crossed': True}
join2: {'from': 599.815, 'to': 605.816, 'crossed': True}
seek to exactly 05:00  → seeked, played on to 302.752
seek to exactly 10:00  → seeked, played on to 602.815
seek near the end (940) → seeked, played on to 942.814
selected variant: 1281x534 throughout
```

Six seconds of wall clock advanced 6.001 s of media across each join: no stall,
no re-buffer, no discontinuity handling. Start, seek, cross-boundary and
play-through-boundary all pass.

**Limitations, stated rather than glossed:** the element was muted, so audio
continuity was not verified by ear; ABR held one variant because the element was
640 px wide, so a rung _switch_ was not exercised; and no iPad or native iOS
Safari was tested — the device lab was not used.

---

## 11. Gates, and a flake that is not a code defect

```
npm run build                                     — exit 0
npx eslint src scripts                            — 0 errors, 185 warnings (all pre-existing)
npx vitest run --config vitest.browser.config.ts  — 8 files, 22 passed | 2 skipped, exit 0
npx vitest run src/renditions/adaptive/epochs     — 11 files, 166 tests
```

`npx vitest run` was run four times over the audit:

| Run                                          | Result                                         | Notes                                                       |
| -------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| baseline, before any change                  | `1918 passed \| 21 skipped (1939)`, exit 0     | 195 files                                                   |
| after the fixes, before the VFR file existed | `1969 passed \| 21 skipped (1990)`, exit 0     | 197 files                                                   |
| with the VFR file                            | `1 failed \| 1970 passed \| 21 skipped (1992)` | `variableFrameRate` + `packaging.integration`               |
| again, benchmark stopped                     | `1 failed \| 1970 passed \| 21 skipped (1992)` | `incremental.integration` — a **different**, untouched test |
| once more, nothing else of mine running      | `1971 passed \| 21 skipped (1992)`, exit 0     | 198 files passed, 5 skipped (203)                           |

The clean run is the one to read: **+53 tests over the 1918 baseline**, which
is exactly the number this audit added.

A different test fails each time, and the cause is in the output:

```
[h264_videotoolbox @ …] Error retrieving the supported property dictionary err=-12903
[vost#0:5/h264_videotoolbox] Error while opening encoder
[out#0/hls] Nothing was written into output file
```

`-12903` is VideoToolbox refusing a new encoder session. The production worker
was encoding another title throughout this audit (six concurrent VideoToolbox
sessions), and the adaptive integration suite opens six to eight more per test,
several tests at a time. The hardware runs out.

Run in isolation, with the production encode still going, all three of the
tests that failed pass:

```
npx vitest run src/renditions/adaptive/incremental.integration.test.ts \
               src/renditions/adaptive/packaging.integration.test.ts \
               src/renditions/adaptive/epochs/variableFrameRate.integration.test.ts
 Test Files  3 passed (3)
      Tests  20 passed (20)
```

Two things follow, and neither is about the epoch code. The suite needs
VideoToolbox largely to itself, so a green run means little on a machine that is
also encoding — worth a note in the contributing guide. And operationally, two
concurrent hardware-encoding jobs on this machine will fail outright with
`-12903`; with the escalation from §1 that is now correctly classified as an
`encoder` fault and fails the job rather than parking it, which is right, but the
concurrency limit itself is unguarded.

## 12. Benchmark

Not run to a figure, deliberately. Nothing changed on the encode hot path: the
escalation in `engine.ts` lives entirely inside the `catch` around `runEncoder`,
`verifySourceReadable` is only called between failed reads,
`shiftSubsegmentDurations` only runs when `adjustLastSampleDuration` actually
adjusts something (which §4 shows never happens on this muxer's output), and the
two UI changes are `Math.max` calls. A run started against the handoff's own
configuration (`--generated-seconds 900 --epoch-seconds 300`) was stopped when it
became clear it was competing with both the production encode and the test suite
for the same hardware encoder — a number measured under that contention would be
worse than none. Re-run it on a quiet machine to compare against the handoff's
+7.8 %.

## What is still open

1. The migration is still unapplied, and nothing is committed.
2. The epoch work is **not deployed** — the running worker predates it.
3. `seamsClosed` is dead and `sourceGaps` can only ever see a gap that falls
   exactly on an epoch boundary (§4). Either remove them or replace them with a
   measurement taken where the resampling actually happens.
4. `widenTfdt`'s unreachable `sidx` inconsistency (§3).
5. No ABR-switch or audio-continuity verification on Apple hardware (§10).
6. The +3 frames and the 200 ms audio/video length difference on a real title
   (§9) are unexplained, though both are small and neither accumulates.
7. The overhead benchmark has not been re-measured on a quiet machine (§12).
8. Nothing limits concurrent hardware-encoding jobs, and VideoToolbox refuses
   sessions past its limit with `-12903` (§11).
