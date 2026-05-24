# Seyirlik PWA Setup

Seyirlik is configured as an installable Vite PWA with `vite-plugin-pwa`.
The plugin is registered in `vite.config.ts` with `registerType: "autoUpdate"`,
a generated web app manifest, and a Workbox service worker.

## Manifest

The generated manifest uses:

- Name and short name: `Seyirlik`
- Description: `Personal media server interface`
- Start URL and scope: `/`
- Display mode: `standalone`
- Orientation: `any`
- Theme and background color: `#000000`
- Categories: `entertainment`, `video`, `media`

The app also includes iPhone/Safari metadata in `index.html`, including
standalone mode, a black translucent status bar, `viewport-fit=cover`, and the
Apple touch icon.

## Icons

The PWA icon files live in `public/`:

- `pwa-192x192.png`
- `pwa-512x512.png`
- `apple-touch-icon.png`
- `maskable-icon-512x512.png`

These are generated from the existing Seyirlik app icon artwork in
`src/assets/AppIcon2.png`. If the source icon changes, regenerate these public
files before deploying.

## Caching Policy

The service worker precaches the built frontend shell and static frontend
assets only: HTML, JavaScript, CSS, favicons, PWA icons, and other local image
assets emitted by the Vite build.

It intentionally does not define runtime caching for Jellyfin API calls,
remote media images, subtitles, HLS manifests, transport stream segments, or
video files. Media playback should stay live and dynamic so Jellyfin sessions,
transcoding, progress reporting, subtitles, and authorization do not become
stale or accidentally cached.

## Local Testing

Build and preview the production app:

```sh
npm run build
npm run preview
```

Open the preview URL, then check browser DevTools:

- Application > Manifest shows the Seyirlik manifest and icons.
- Application > Service Workers shows the generated service worker.
- Cache Storage contains app-shell/static build files, not Jellyfin media/API
  responses.

## iPhone Install

Deploy the app over HTTPS, then on iPhone Safari:

1. Open the deployed Seyirlik URL.
2. Tap Share.
3. Tap Add to Home Screen.
4. Launch Seyirlik from the Home Screen icon.

The installed app should open in standalone mode with a black launch/status
appearance and normal Seyirlik routing.

## Deployment Requirements

PWAs require HTTPS in production. Localhost is the browser exception for
development testing.

On Vercel, `vercel.json` must allow the generated PWA files to be served as
static files instead of rewriting them to `index.html`: `manifest.webmanifest`,
`sw.js`, `registerSW.js`, `workbox-*.js`, and the PWA icons.
