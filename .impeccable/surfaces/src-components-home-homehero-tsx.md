---
version: 1
slug: "src-components-home-homehero-tsx"
primary_target: "src/components/home/HomeHero.tsx"
related_targets: ["src/pages/desktop/DesktopHomePage.tsx", "src/pages/mobile/MobileHomePage.tsx", "src/components/home/TitleHero.tsx", "src/pages/mobile/MobileLibraryPage.tsx", "src/components/home/HomeHeroSkeleton.tsx"]
---

# Home hero (every device)

Scope: the home hero and its carousel, and the title hero it lends to film and series pages, on desktop, tablet and phone, with their loading skeletons. Mode: Experience inside the Screening Room (Operate affordances intact: play, details, save, rotation control). The phone and tablet pages render the same components as the desktop; the stage's shape, not the device, picks the layout.

## Direction contract

THESIS: A stage with its queue in view. Every featured title is one composition that is either on stage or waiting as its own miniature; every change is that composition physically travelling between the two. Refuses the category default: a backdrop crossfade over dot indicators.

OWN-WORLD: Screening Room void; the film's own artwork is the only colour; logo or Archivo 900 condensed title; glass rounded-full controls; accent only as the up-next progress line and focus.

STORY: What is on, what is next, and when it changes. Play, details, save, jump to any queued title, hold the rotation.

FIRST VIEWPORT: Full-bleed backdrop; logo lower-left near 34vw; facts, three-line overview, actions beneath; three miniatures bottom-right, the first carrying its progress; controls beside them.

TALL STAGE (phone, tablet upright, any portrait window): the stage ends at the tab bar; the poster fills it, top-anchored, sinking into the void, solid by the top of the logo's box, so its printed lettering never shows behind the copy; the actions span the foot; above them the facts (left) share a row with the queue (right), the pill above the queue; the logo rests full-size in the column the queue leaves. Swipe moves the stage (it gives under the finger first); the overview opens across the queue's row and the queue steps aside for it. A phone's row is compact and never holds more than three rounds: play stretches, Details turns round, start over waits for the title page at home, and on a title page Details and the overview stay home (the page below has both).

FORM: code-led section in an established world; no seed roll (section scope).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
