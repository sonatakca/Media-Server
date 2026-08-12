# Migration from Jellyfin

Seyirlik began as a web client for a Jellyfin server. It is now a media server
in its own right, and Jellyfin is no longer involved in any part of the running
system. This note exists so the shape of the codebase makes sense to somebody
reading it for the first time.

It replaces three documents that tracked the migration while it was in
progress — a parity matrix, a removal plan, and a verification log. They were
deleted rather than updated: they inventoried files that no longer exist and
listed work as "not started" that had long since shipped, so keeping them would
have been worse than having nothing.

## What replaced what

| Was                                                  | Is                                              |
| ---------------------------------------------------- | ----------------------------------------------- |
| Jellyfin `/System/Info/Public` probe                 | `GET /ownAPI/v1/health`                         |
| Jellyfin token in `localStorage`, `X-Emby-*` headers | `HttpOnly` cookie session, `GET /auth/me`       |
| Jellyfin `/Users/AuthenticateByName`                 | `POST /auth/login`, Argon2 hashes in PostgreSQL |
| Jellyfin `/Items`, `/UserViews`, `/Shows/*`          | The catalogue built by Seyirlik's own scanner   |
| Jellyfin `PlaybackInfo` and its transcoder           | Seyirlik's playback planner and FFmpeg pipeline |
| Jellyfin user data and resume points                 | `user_item_state` in PostgreSQL                 |
| Jellyfin artwork endpoints                           | Content-addressed artwork in generated storage  |

## What the migration left behind

Three things outlived their purpose and were removed later, in separate passes:

- **Provider switches.** `VITE_IDENTITY_PROVIDER` and
  `VITE_SERVER_BOOTSTRAP_PROVIDER` chose between Jellyfin and native code paths
  during the cutover. They became actively dangerous once the cutover finished:
  the client defaulted to `jellyfin` while the bootstrap call defaulted to
  `native`, so the app worked only because nobody set the flag. Setting it to
  the value that described reality would have rendered a migration-phase
  placeholder instead of the app.
- **Session compatibility fields.** `AuthSession` carried `serverUrl`,
  `accessToken`, and `deviceId` long after all three were permanently empty
  strings, which quietly disabled at least one diagnostic probe that was gated
  on a token that could never exist.
- **Connection diagnostics.** The failure page still probed
  `/System/Info/Public` and swept `localhost:8096` looking for a server that
  was no longer there, and classified cloudflared tunnel states. It now asks
  `/ownAPI/v1/health` once and reports which layer is actually failing.

The lesson worth keeping: a compatibility shim needs an expiry date. All three
read as harmless while they were silently doing nothing useful, or worse.

## Terminology you may still find

Some names in the codebase are inherited rather than descriptive:

- View models use Jellyfin-style PascalCase field names (`Id`, `Name`,
  `UserData`, `ImageTags`). `src/api/ownApi/adapters.ts` is the single place
  that converts the API's own camelCase DTOs into them. This is a naming
  convention now, not a dependency.
- Runtime durations are expressed in ticks (100ns) because the player's
  arithmetic was written against them. The API speaks milliseconds, and the
  same adapter is the only place that converts.

Neither is a reason to think Jellyfin is still involved. If you find anything
that genuinely still calls a Jellyfin endpoint, it is a bug.
