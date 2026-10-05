---
version: 1
slug: "src-pages-bookreaderpage-tsx"
primary_target: "src/pages/BookReaderPage.tsx"
related_targets: ["src/pages/reader/readerModel.ts","src/pages/BookReaderPage.css"]
---

# Book reader

Scope: the EPUB reader (`/read/:id`), desktop and mobile; other formats (PDF, text, HTML, image) share its shell. Mode: Read inside the Screening Room. The book is the content; chrome recedes until asked for.

Reader: the operator and their circle, reading their own Turkish/English EPUBs, often at night, for long stretches. Job: read comfortably, know where they are and how long is left, adjust type and light live, jump chapters, keep their place.

## Direction contract

THESIS: The reading line is lit. One continuous column where the paragraph at the reading line carries full ink and the text above and below falls off like screen glow; position is a ruler, not a page counter. Refuses the flat page, toolbar and fake page-number pill.

OWN-WORLD: Screening Void ground with Night/Dim/Sepia/Paper themes; Literata for the book, Archivo for chrome, numerals and drop caps; glass rounded-full pill; accent only as ruler marker, opener rule, progress hairline, focus.

STORY: Where am I in this chapter, how long is left. Change theme, face, size, spacing, width and light live; jump chapters; bookmark; finish, open, download.

FIRST VIEWPORT: Top bar: back + Kitaplar, centred title over author · chapter, pill of contents, bookmark, Aa, more. Centred 66ch Literata column; chapter ruler 176px left of it; "Bölüm sonuna ≈ N dk" right of it at 40vh.

FORM: surface structure 4 of 7 (dealt order 5, 3, 4); seed key b858c69b.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Signature interaction and motion

Spotlight follows scroll through a 0.35s opacity transition per block; strength off / soft (0.4) / strong (0.16). Chrome retreats on scroll down and returns on scroll up, pointer at the top edge or a tap. Settings is an anchored popover on desktop and a bottom sheet on mobile; contents is a left drawer. Sine and expo-out eases, no travel above 32px per frame.
