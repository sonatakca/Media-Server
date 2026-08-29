# Seyirlik — session handoff (2026-08-29)

Repo: `/Users/sonat/Documents/Development/Media-Server`
Lab: `/Volumes/Expansion/seyirlik-lab`, lab server `http://127.0.0.1:43111`
(started with `bash scripts/run-media-lab-server.sh`, runs from source via tsx —
restart it after any server-side edit; run `npm run build` after any client edit,
because the server serves `dist`).

Lab admin account: a temporary `labaudit` account was provisioned for the audit
and removed at the end of the session. Re-provision with
`npm run admin:provision` against the lab database if the lab is needed again.

## Standing constraints

- Never modify or delete production media under `/Volumes/Expansion/media`.
- Source media is read-only to the processor; never overwrite a source in place.
- Do not delete FileFlows data or configuration without explicit permission.
- Do not weaken, skip, or delete failing tests.
- Say exactly which engine was tested. WebKit 26.5 via Playwright is not
  Safari.app; driving Safari.app needs "Allow Remote Automation" (admin password).

## What this session changed (Claude)

All seven are user-visible playback defects found by driving the real UI.

1. **`src/lib/playback-planner/playbackSessionManager.ts` — startup deadline.**
   Was 2.5 s for a stream copy and 5 s for an audio transcode. Both wait on the
   same demux of the source; a 4K HDR master needs far longer. Now: 8 s when the
   video is transcoded or subtitles are burned, 20 s otherwise (the deadline is a
   failure detector, not a latency target). Tests:
   `src/lib/playback-planner/playbackSessionStartup.test.ts`.

2. **Same file — cleanup no longer replaces the error.** The `rm` of the session
   output directory ran before the typed `PlaybackSessionStartupError` was
   rethrown; losing the race with FFmpeg threw `ENOTEMPTY` over it, so the client
   got an anonymous 500 instead of the 409 that names the failing stage. The
   remove is now wrapped and retried, and a cleanup failure only warns.
   Regression test reproduces it with a read-only parent directory.

3. **`src/lib/mediaApi.ts` — the server's delivery URL is now authoritative.**
   `buildPlaybackCandidates` preferred `qualityManifest.adaptive.playbackUrl`
   whenever a manifest existed. The manifest travels with _every_ plan, including
   the plans where the server deliberately chose a live session (asking for an
   audio track the retention policy dropped). The player therefore attached the
   package instead: the requested track never came on, and because the URL had
   not changed `switchPlayerSource` skipped the switch as a no-op — leaving the
   title to restart from zero. Tests: `src/lib/mediaApi.delivery.test.ts`.

4. **`src/components/player/PlayerControls.tsx` — forwards `audioNoticeText`.**
   `CustomVideoPlayer` passed the notice; `PlayerControls` neither declared nor
   forwarded it, so it never reached `PlayerSettingsPanel`. Tests:
   `src/components/player/PlayerControls.notice.test.tsx`.

5. **`src/components/player/CustomVideoPlayer.tsx` — `audioSelectionNotice`.**
   The audio failure notice borrowed `qualitySelectionNotice`, which the quality
   machinery clears during the very re-plan the failure comes out of. It now has
   its own state, is set on both failure paths (the adaptive re-plan and the
   `buildConfiguredSource` catch that previously returned in silence), and is
   cleared on a successful switch.

6. **`src/server/renditionService.ts` — subtitle assets pass the allow-list.**
   `ADAPTIVE_ASSET_PATTERN` named only `master.m3u8` and
   `video|audio/<rung>/…`. The packager writes each embedded text subtitle as
   `subtitles/subtitle-<n>/{playlist.m3u8,subtitles.vtt}` and advertises the
   group in the master, and the metadata registration already covered them — the
   pattern in front did not. Every subtitle playlist 404d, and a 404 behind an
   advertised subtitle group does not degrade to "no subtitles": it fails the
   whole title (`subtitleTrackLoadError` in Chrome, `MEDIA_ERR_DECODE` in
   WebKit). Dune Language Fixture would not start in either engine. Covered in
   `src/server/renditionService.test.ts`.

7. **`playbackSessionManager.ts` — a finished playlist is accepted as final.**
   The readiness check gained a resume-position gate: wait until the playlist
   covers `startTimeSeconds + 12`. That is right while FFmpeg is still writing
   and wrong once it has stopped. The target is clamped to
   `sourceDurationSeconds`, which is the _container_ duration — on the
   Multilingual MKV fixture the subtitle track runs to 21.73 s while the video
   is 20.02 s, so the gate demanded 21.45 s of media the muxer will never
   produce. FFmpeg exited 0 having written a complete package and the session
   was failed anyway, in both engines. A playlist containing `#EXT-X-ENDLIST` is
   now treated as complete regardless of the target. Covered in
   `playbackSessionStartup.test.ts`.

## What Codex changed before this session (verified working)

- `src/renditions/adaptive/masterSelection.ts` — rewrites the master playlist so
  Safari's native HLS engine defaults to the requested audio rendition.
- `startTimeMs` on `POST /playback/sessions`, carried into `plan.startTimeSeconds`
  so a re-plan resumes at the switch point. Verified: 93.6 s → 106.5 s across a
  track change in both engines.
- `src/renditions/adaptive/subtitles.ts` — embedded text subtitles extracted to
  WebVTT and advertised as HLS subtitle renditions.
- `ADAPTIVE_PROFILE_VERSION` bumped to `cmaf-hls-aligned-v3`.

## Trap to know about

Bumping `ADAPTIVE_PROFILE_VERSION` invalidates every existing package: the server
declines a stale one and falls back to live transcoding, which for an HDR source
this FFmpeg build cannot do (no `zscale`/tone-map). That is what broke
`npm run media:lab:verify-http` mid-session. Fix is to repackage:

```
export LAB=/Volumes/Expansion/seyirlik-lab
SEYIRLIK_MEDIA_ROOT="$LAB/media" \
SEYIRLIK_RENDITION_ROOT="$LAB/outputs/native-cmaf" \
SEYIRLIK_RENDITION_STATE_ROOT="$LAB/reports/native-cmaf" \
npm run media:renditions:process -- --profile adaptive --workers 1
```

Nothing reports the fleet-wide cost of a bump before you make it. Worth building.

## Lab database incident

The database-gated integration suites were pointed at the lab database to stop
them skipping. They own their schema and reset it, which emptied the lab
catalogue (admin account + all eight scanned titles). Only that Postgres database
was affected — every source file, generated package and report on disk survived,
and the rendition registry keys on relative path rather than catalogue id, so no
package was orphaned. Recovered by re-provisioning `labaudit` and re-scanning.

Two consequences: item ids differ from the earlier report, and those suites must
be run against a throwaway database **and serially** — three of them contend over
one schema and fail when run in parallel (`--no-file-parallelism`).

## Gate at handoff

- `npm test -- --run` — 1250 passed, 0 failed, 20 skipped (database-gated)
- with a lab database, serial — 366 passed, 0 skipped across `src/server/ownApi`
- `npx tsc --noEmit` — clean
- `npm run lint` — 0 errors, 178 warnings (none from the files changed here;
  each was linted individually and came back clean)
- `npm run format:check` — clean
- `npm run media:lab:verify-matrix` — pass
- `npm run media:lab:verify-http` — pass
- Lab sources byte-identical and mtime-unchanged (Dune still 477,590,241 bytes,
  mtime Aug 28 20:29:32)

## Known open items

- NVENC / AMF / VA-API are named by the adapter layer and reported with a reason,
  but their encoder arguments are not written.
- Adaptive audio is stereo for every client; surround stays on the original file.
- Pause is not implemented (cancel and retry are).
- External sidecar subtitle _files_ are still not folded into a package.
- No HDR→SDR lane: any plan needing a live HDR video conversion is refused.
