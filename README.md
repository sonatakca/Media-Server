# Seyirlik Web

Seyirlik Web is a custom frontend/client for an existing Jellyfin server.

Jellyfin remains the backend. This project does not rebuild Jellyfin, does not add a custom backend, and does not modify Jellyfin server files. The browser talks directly to Jellyfin through Jellyfin's HTTP API.

## Tech Stack

- Vite
- React
- TypeScript
- Tailwind CSS
- React Router
- hls.js for HLS playback on browsers without native HLS support
- Browser `fetch` requests to Jellyfin

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

## Jellyfin Server URL

On first launch, Seyirlik Web asks for your Jellyfin server URL and saves the normalized URL in browser `localStorage`. Trailing slashes are removed.

Supported examples:

- `http://localhost:8096`
- `http://192.168.1.50:8096`
- `https://jellyfin.mydomain.com`
- `https://mydomain.com/jellyfin`

### Testing from Mac when Jellyfin is on Windows

`localhost` means the current machine. If you run Seyirlik Web on your Mac, `http://localhost:8096` means Jellyfin running on your Mac.

If Jellyfin is running on your Windows PC and you are testing from your Mac, enter the Windows PC local IP address:

```text
http://WINDOWS_PC_LOCAL_IP:8096
```

Example:

```text
http://192.168.1.50:8096
```

### Testing from Windows when Jellyfin is on Windows

If you run Seyirlik Web directly on the same Windows PC where Jellyfin is installed, this may work:

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

Open the browser console while testing `/watch/:itemId`. Seyirlik Web logs the selected Jellyfin media source, whether it is using `DirectPlay`, `DirectStream`, or `Transcoding`, and a redacted playback URL.

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
