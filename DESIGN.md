---
name: Seyirlik
description: A self-hosted media server designed as a private screening room with a projection booth behind it.
colors:
  seyirlik-teal: "#467a6c"
  seyirlik-teal-hover: "#75a27b"
  screening-void: "#050607"
  glass-surface: "rgba(255, 255, 255, 0.065)"
  glass-surface-hover: "rgba(255, 255, 255, 0.11)"
  text-primary: "#f8fafc"
  text-secondary: "rgba(226, 232, 240, 0.72)"
  hairline-border: "rgba(255, 255, 255, 0.12)"
  status-success: "#34d399"
  status-warning: "#fbbf24"
  status-critical: "#f87171"
  status-danger-action: "#fda4af"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.25rem, 4vw + 1rem, 4.5rem)"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "normal"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: "0.12em"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.seyirlik-teal}"
    textColor: "#09090b"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.seyirlik-teal-hover}"
  button-secondary:
    backgroundColor: "{colors.glass-surface-hover}"
    textColor: "{colors.text-primary}"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "#e4e4e7"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  media-card:
    backgroundColor: "{colors.glass-surface}"
    rounded: "{rounded.md}"
  admin-card:
    backgroundColor: "{colors.glass-surface}"
    rounded: "{rounded.lg}"
    padding: "1rem 1.25rem"
---

# Design System: Seyirlik

## Overview

**Creative North Star: "The Private Screening Room"**

Seyirlik is one facility with two rooms. The audience-facing side — home, library, hero, the player — is the screening room itself: a dark, immersive space designed to disappear behind the poster art and video it's showing, lit by one restrained signal color. The admin side — scanning, processing, artwork, users — is the projection booth behind the screen: quieter, flatter, information-dense, precise, and built for repeated operational use rather than atmosphere. Both rooms belong to the same building, built from the same materials (near-black ground, Seyirlik Teal, the same heavy-weight Inter type, the same two-radius shape language), but the booth never borrows the screening room's decoration to prove they match.

Deep black, cinematic hierarchy, restrained teal accenting, confident heavy typography, strong media imagery, and a real sense of depth are the durable identity. The exact intensity of glass blur, glow, shadow softness, and gradients are implementation choices within that identity, refinable whenever a change improves clarity, performance, hierarchy, or restraint — they are not, themselves, what makes Seyirlik look like Seyirlik.

**Key Characteristics:**

- Near-black ground throughout, lit by artwork and screen glow rather than by a light UI chrome.
- One accent color (Seyirlik Teal), used sparingly as a signal, never as a fill.
- Type weight _is_ the display system — no separate display face, just Inter pushed to 900.
- Two-radius shape grammar: `rounded-full` for every control, a small radius step for buttons and cards.
- Screening room surfaces carry cinematic depth (layered shadow, glass blur, accent-tinted glow); control-booth surfaces are flat and dense by design, not by neglect.

## Colors

The palette is almost monochrome by design: everything is near-black, near-white, or translucent white, with exactly one hue doing all the signaling.

### Primary

- **Seyirlik Teal** (`#467a6c`) / **hover** (`#75a27b`): the one accent in the system. Used for hover glow, progress fills, focus rings, active/selected state, and the rare primary call-to-action. Never the dominant color of a screen — its rarity is what makes it read as a signal.

### Neutral

- **Screening Void** (`#050607`, deepening to `#000` at the html root): the base ground of every surface.
- **Glass Surface** (`rgba(255,255,255,0.065)`) / **hover** (`rgba(255,255,255,0.11)`): the translucent panel fill used for cards, chips, and controls floated over the void.
- **Hairline Border** (`rgba(255,255,255,0.12)`): the only border weight in the system; borders are a whisper, not a frame.
- **Text Primary** (`#f8fafc`) / **Text Secondary** (`rgba(226,232,240,0.72)`): near-white for headings and primary copy, translucent for supporting copy — opacity does the work a second gray would otherwise do.

### Status (functional, Control Booth)

- **Success** (`#34d399`, emerald): healthy/succeeded state — status dots, watched indicators.
- **Warning** (`#fbbf24`, amber): degraded/paused state — non-blocking alerts.
- **Critical** (`#f87171`, red): blocked/failed state — the storage-quarantine banner and hard failures.
- **Danger Action** (`#fda4af`, rose): the destructive-button variant. Deliberately a different hue family from Critical red — a button you're about to press reads differently from a state that already happened to the system.

### The Accent Ramp

The six selectable accents (`src/lib/accentTheme.ts`) are the six bars of the logo, running warm to cool: **Warm Red** (`#bd3f28`), **Amber** (`#fa9b1d`), **Gold** (`#d3ca22`), **Olive** (`#bacb7d`), **Green** (`#67a478`), **Teal** (`#337b6c`). One of them is live at any moment as `--accent`; the ramp as a whole is also available as a scale in its own right.

### Named Rules

**The One Signal Light Rule.** Seyirlik Teal appears as a glow, a fill, a ring, or a dot — never as a background, never as a large shape. If teal is the first thing you notice on a screen, it's being overused.

**The Ramp-Is-The-Pipeline Rule.** Where a surface must tell several kinds of background work apart, it reads the accent ramp as one scale: the warm end is trouble (Warm Red = failed, Amber = needs a person), and the cool run is healthy work ordered by how far through the pipeline it has travelled — Gold (discovery: scan, probe) → Olive (description: metadata, artwork, trickplay) → Green (encoding) → Teal (export). Status always outranks the job: a failure is red whatever produced it. These are fixed points of the ramp, not the viewer's chosen `--accent`, so a colour means the same job for everyone; the derived values and their measured contrast live in `src/lib/notifications/notificationAccent.ts`. Colour is never the only code — the glyph carries the state, the card names its own work, and the scale steps down in lightness so the order survives without hue.

## Typography

**Body & Display Font:** Inter (with `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`).

**Character:** One typeface carries the whole system; hierarchy is built from weight, size, and letter-spacing rather than a second display face. Heavy weight (900, `font-black`) is the system's display device — it's what a hero title, a stat number, and an eyebrow label all reach for.

### Hierarchy

- **Display** (900, `clamp(2.25rem, 4vw + 1rem, 4.5rem)`, leading 0.95): hero titles over backdrop art, always paired with a cinematic drop-shadow so it stays legible over busy imagery.
- **Headline** (900, `1.5rem`, tabular-nums where numeric): section headers and the large stat numbers in the Control Booth.
- **Title** (700, `1rem`–`1.125rem`): card titles, button labels, nav labels.
- **Body** (600, `0.75rem`–`0.875rem`, leading 1.4–1.5): descriptions, metadata rows, supporting copy — set in Text Secondary more often than Text Primary.
- **Label** (900, `0.66rem`–`0.6875rem`, tracking `0.08em`–`0.18em`, uppercase): eyebrows, category badges, and count chips. This is the system's most-repeated typographic gesture.

### Named Rules

**The Weight-Not-Face Rule.** Never reach for a second font family to add hierarchy or occasion (a title card, a stat, a badge). Reach for 900 and letter-spacing instead.

## Layout

The screening room and the control booth use different spatial grammars on the same grid.

**Screening room (home, library, hero, player):** a centered container (`max-width: 95%`) with generous, viewport-responsive gutters; hero sections break out full-bleed past that container to fill the viewport edge to edge. Media rows scroll horizontally with a soft edge-mask fade rather than a hard clip, so a row reads as continuing past the frame. The navbar starts fully transparent over the hero and only becomes an opaque glass bar once the page scrolls — the chrome earns its presence instead of always claiming it. Safe-area insets (`env(safe-area-inset-*)`) are load-bearing throughout, not an afterthought, because the client runs as an installed PWA on phones.

**Control booth (admin):** plain stacked/grid sections of bordered cards, no full-bleed compositions, no edge-fade scrollers — density and scanability over atmosphere.

## Elevation & Depth

Elevation is deliberately hybrid, split along the Screening Room / Control Booth line rather than applied uniformly.

**Screening room:** a full named shadow vocabulary carries real depth — `cinematic-card` / `cinematic-card-hover` under posters, `floating-panel` under overlays, `navbar-glass` under the scrolled header, `artwork-glow` and `player-controls` around playback chrome, `button-glow` under primary CTAs — layered, soft-edged (30–120px blur), and darker/more dramatic on hover. Interactive chrome floated over media (icon buttons, segmented toolbars, pill inputs) is glassed: `backdrop-blur-2xl` over a near-black translucent fill. Hover states add an accent-tinted glow via `color-mix()` rather than a flat color shift.

**Control booth:** flat by contrast. Depth is conveyed by a hairline border and a faint fill-opacity step (`bg-white/[0.03]`), not by shadow or blur. No glass, no glow — clarity and scan speed outrank atmosphere here.

### Shadow Vocabulary (Screening Room)

- **Cinematic Card** (`--shadow-cinematic-card`): rest state under posters and media cards.
- **Cinematic Card Hover** (`--shadow-cinematic-card-hover`): deeper, accent-tinted, on hover/focus.
- **Floating Panel** (`--shadow-floating-panel`): modals, overlays, the notification stack.
- **Navbar Glass** (`--shadow-navbar-glass`): the header once scrolled.
- **Artwork Glow** (`--shadow-artwork-glow`): large hero/backdrop art.
- **Player Controls** (`--shadow-player-controls`): floating playback chrome.
- **Button Glow** (`--shadow-button-glow`): primary calls to action.
- **Soft Inset** (`--shadow-soft-inset`): the subtle top/bottom inner highlight inside glass panels.

### Named Rules

**The Booth-Doesn't-Glow Rule.** Admin/operational surfaces never inherit glass blur, glow, or gradient decoration purely to match the browsing side. Shared identity there is carried by color, type, and shape — not by shadow.

## Shapes

A two-radius grammar, applied without exception:

- **`rounded-full`** for every interactive control: icon buttons, pill buttons, segmented-toolbar items, chips, badges, progress dots. Nothing that a finger taps is ever a rectangle.
- **A small radius step for containers** — `8px` for standard buttons, `12px` for media cards and inputs, `16px` for larger panels and Control Booth cards.

There are no sharp corners anywhere in the system, and no radius values outside this scale.

## Components

### Buttons

- **Shape:** `8px` radius (`rounded-lg`), never a pill except the hero/player CTAs, which intentionally step up to `rounded-full` as the most prominent calls to action in the room.
- **Primary:** Seyirlik Teal fill, near-black text, hover shifts to the lighter teal, focus ring in the accent, hover lifts `-1px`, press scales to `0.98`.
- **Secondary:** translucent white fill (`bg-white/10`) with a hairline border, brightens on hover.
- **Ghost:** transparent, fills translucent white on hover only.
- **Danger:** translucent fill with a rose border/text — deliberately not the same red used for critical system alerts.

### Cards / Containers

- **Media Card** (signature): `12px` radius, `aspect-[4/3]` (row) or portrait poster (grid), rests on `cinematic-card` shadow. Its metadata panel sits over a duplicated, blurred, mirrored copy of the artwork itself behind a black scrim — the panel appears to be made of the same image it's describing. A shimmer sweep (accent-tinted) fills the frame while art loads; a thin accent progress bar tracks continue-watching state along the bottom edge. On hover/focus: lifts, scales up slightly, and its border brightens from `white/10` to `white/20` — the shadow deepens to `cinematic-card-hover` at the same time.
- **Admin Card** (Control Booth signature): `16px` radius, hairline border, `bg-white/[0.03]` fill, `1rem`–`1.25rem` padding. Holds tabular stat rows (`tabular-nums`, `2xl`/`900` for the headline number) and small status dots (emerald/amber) rather than icons or imagery.

### Glass Controls (Screening Room signature)

Icon buttons, segmented toolbars, and pill inputs floated over media share one recipe: near-black translucent fill (`~75%` opacity), `backdrop-blur-2xl`, a one-pixel white hairline plus an inset top highlight and a soft drop shadow, brightening fill and shadow on hover, scaling down slightly on press. This is the system's one truly tactile control family — everything that lives on top of video or artwork uses it.

### Notifications (signature)

A stack of glass chips (rounded, black/70, backdrop-blur) anchored bottom-right, collapsing into a pile with a mask-faded top/bottom edge rather than a hard-clipped scroll boundary. A balanced-ink spinner (two opposed arcs of equal weight) keeps its optical center still while it spins. Count badges are small pill chips in translucent white, heavy weight, tabular numerals.

### Navigation

Transparent over the hero, becomes an opaque glass bar (`navbar-glass` shadow, `backdrop-blur-2xl`, `bg-black/75`) once the page scrolls. Active link state is plain white text, not the accent color — Seyirlik Teal is reserved for hover/focus/progress signaling, never for "you are here."

## Do's and Don'ts

### Do:

- **Do** keep Seyirlik Teal rare: a glow, a fill, a ring, a dot — never a screen's dominant color (**The One Signal Light Rule**).
- **Do** build hierarchy from Inter's weight and letter-spacing (900 + tracked uppercase for labels) instead of introducing a second typeface (**The Weight-Not-Face Rule**).
- **Do** let Screening Room surfaces (browse, hero, player) carry real cinematic depth — layered shadow, glass blur, accent-tinted glow — proportional to how close the surface sits to the media itself.
- **Do** keep Control Booth surfaces flat, dense, and fast to scan: hairline borders, tabular numbers, minimal motion, no glow or blur (**The Booth-Doesn't-Glow Rule**).
- **Do** use `rounded-full` for every control the user taps or clicks, and the `8/12/16px` step scale for every container.

### Don't:

- **Don't** let admin/operational UI inherit decorative cinema effects (glow, blur, gradients) merely to look "consistent" with the browsing side — Control Booth clarity outranks Screening Room polish there.
- **Don't** drift toward a generic self-hosted-dashboard or admin-template look: no Bootstrap-style boxed cards, arbitrary borders, blue-primary SaaS chrome, or dashboard chrome that exists for its own sake.
- **Don't** imitate another streaming product's exact layout, navigation, artwork treatment, typography, or interaction pattern (Netflix, Jellyfin, Plex) — Seyirlik is authored, not a clone of a category.
- **Don't** add a visual effect that doesn't earn its place through hierarchy, comprehension, feedback, or atmosphere — gratuitous gradients, glow, or glass; oversized empty spacing; decorative analytics for their own sake.
- **Don't** let dense technical/admin UI leak into the viewing experience, or let cinematic decoration leak into admin.
