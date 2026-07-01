# Seyirlik

Seyirlik is a custom frontend/client for an existing Jellyfin server.

Jellyfin remains the library/authentication backend. The browser normally talks
directly to Jellyfin, while an optional local playback backend provides
capability-based direct file delivery, remuxing, and bounded FFmpeg
transcoding. Seyirlik does not modify Jellyfin server files.

## Tech Stack

- Vite
- React
- TypeScript
- Tailwind CSS
- React Router
- hls.js for HLS playback on browsers without native HLS support
- Browser `fetch` requests to Jellyfin
- Optional Node playback backend with FFmpeg/ffprobe

## Install

```bash
npm install
```

## Run Development Server

```bash
npm run dev
```

Open the Vite URL shown in the terminal.

## Build

```bash
npm run build
```

## SEO / Search Indexing

Seyirlik uses Netflix-style app-entry SEO without a visible marketing landing
page:

- `/` is the only public indexable canonical URL with Turkish-first metadata.
- `/` immediately enters the private Jellyfin app flow and redirects users to
  `/home`, `/login`, or `/server` depending on local app state.
- `/app` is an alias for the same private app entry flow.
- `/login`, `/server`, `/home`, media routes, player routes, and developer
  routes are private/internal and should remain `noindex, nofollow`.
- Vercel sends `X-Robots-Tag: noindex, nofollow` for private route patterns
  so crawlers see noindex before React renders route metadata.
- `robots.txt` is served at `/robots.txt`.
- `sitemap.xml` is served at `/sitemap.xml` and only includes `/`.
- The canonical site URL is `https://www.seyirlik.sonatakca.com/`.

After deployment, submit `https://www.seyirlik.sonatakca.com/sitemap.xml` in
Google Search Console and inspect `https://www.seyirlik.sonatakca.com/`.

## Jellyfin Server URL

On first launch, Seyirlik asks for your Jellyfin server URL and saves the normalized URL in browser `localStorage`. Trailing slashes are removed.

Supported examples:

- `http://localhost:8096`
- `http://192.168.1.50:8096`
- `https://jellyfin.mydomain.com`
- `https://mydomain.com/jellyfin`

### Testing from Mac when Jellyfin is on Windows

`localhost` means the current machine. If you run Seyirlik on your Mac, `http://localhost:8096` means Jellyfin running on your Mac.

If Jellyfin is running on your Windows PC and you are testing from your Mac, enter the Windows PC local IP address:

```text
http://WINDOWS_PC_LOCAL_IP:8096
```

Example:

```text
http://192.168.1.50:8096
```

### Testing from Windows when Jellyfin is on Windows

If you run Seyirlik directly on the same Windows PC where Jellyfin is installed, this may work:

```text
http://localhost:8096
```

## Jellyfin API Docs

Jellyfin usually exposes API docs from your own server at:

```text
serverUrl/api-docs/swagger/index.html
```

Example:

```text
http://192.168.1.50:8096/api-docs/swagger/index.html
```

The current public OpenAPI specs are also listed at:

- <https://api.jellyfin.org/openapi/>

## Current Limitations

- Playback now uses Jellyfin `PlaybackInfo`, direct sources where browser-safe, and Jellyfin HLS/transcoding fallback where available.
- Audio track selection is still TODO.
- Subtitle selection is still TODO.
- Quality selector and bitrate switching controls are still TODO.
- Playback progress reporting is basic and best effort only.
- Watch-together and friend/session features are future work.
- Some files can still fail if Jellyfin transcoding, FFmpeg, permissions, range requests, reverse proxy, or CORS are not configured correctly.

## Playback Testing

Start with a known browser-friendly file:

```text
MP4 container, H.264 video, AAC audio
```

Then test a difficult file:

```text
MKV container, H.265/HEVC video, OPUS or other non-AAC audio
```

Open the browser console while testing `/watch/:itemId`. Seyirlik logs the selected Jellyfin media source, whether it is using `DirectPlay`, `DirectStream`, or `Transcoding`, and a redacted playback URL.

## Native Desktop Player Direction

The web player remains constrained by browser codec/container support. The
cross-platform desktop design uses a native libmpv/FFmpeg renderer for Windows,
Linux, and macOS, with direct play preferred over transcoding. The playback
planner already accepts native capability profiles, and the server now selects
available hardware H.264 encoders with bounded software fallback.

See [Native playback architecture](docs/NATIVE_PLAYBACK_ARCHITECTURE.md) for
the implementation plan, server controls, and the reasoning behind assigning a
live transcode to one healthy node instead of splitting every stream across
client and server.

## TMDB Artwork Dev Tool

The `/dev/tmdb-artwork` tool uses the local playback backend to search TMDB
and replace local sidecar artwork next to a Jellyfin movie or series. Configure
these backend variables before starting `npm run playback:backend`:

```text
SEYIRLIK_MEDIA_ROOT=/absolute/path/to/media
SEYIRLIK_JELLYFIN_SERVER_URL=http://127.0.0.1:8096
SEYIRLIK_JELLYFIN_API_KEY=replace-with-a-dedicated-jellyfin-api-key
SEYIRLIK_TMDB_API_KEY=replace-with-a-tmdb-v3-api-key
```

The picker only loads TMDB images tagged English, Turkish, or no language. It
replaces `folder.jpg` for posters, `backdrop.jpg` for backdrops,
`landscape.jpg` for landscape art, and `logo.png` for logos.

If you open the frontend through a LAN address such as
`http://192.168.1.186:5173`, add that exact origin to
`SEYIRLIK_ALLOWED_ORIGINS`; otherwise the browser can be blocked from calling
the local artwork backend even though TMDB works normally in another tab.

If playback still fails, check Jellyfin:

- Transcoding is enabled.
- FFmpeg is configured and working.
- The Jellyfin user has playback and transcoding permission.
- Your reverse proxy supports range requests and streaming responses.
- CORS allows the frontend origin when Jellyfin is on a different origin.

## CORS And Networking

During development, the frontend may be served from a different origin than Jellyfin. If browser CORS blocks requests, Jellyfin or your reverse proxy may need to allow the Vite development origin, or the app may later need to be served behind the same domain as Jellyfin.

This project intentionally does not solve CORS by adding a backend proxy yet.

## Security Note

Because this is frontend-only, the Jellyfin access token is stored in browser `localStorage`. Treat the browser profile as trusted, and avoid using this app from shared or untrusted browsers.
