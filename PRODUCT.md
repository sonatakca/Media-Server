# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the operator/developer themself, plus a small circle of
household and friends who each get their own account. It is not a
multi-tenant public product — it is a personal library shared with people the
operator knows, with per-library permissions for administration.

## Product Purpose

Seyirlik is a self-hosted media server and web client for a personal film,
television, and ebook library. It scans a library on disk, catalogues it in
PostgreSQL, fetches metadata and artwork, decides how to deliver each file to
each requesting browser, and serves the interface that plays or reads it.
Success means the operator's own library streams reliably to their circle
without depending on a third-party service.

## Positioning

Seyirlik began as a Jellyfin frontend and no longer is one: the client talks
only to Seyirlik's own API, and nothing in the data path depends on another
media server being installed. Its mechanism a neighboring "pretty client for
someone else's server" product could not copy is that it owns the whole
path — disk scan, catalogue, metadata, delivery decision, and playback — as
one system.

## Operating Context

- Self-hosted on the operator's own hardware/home network; a `mediaServer`
  process serves the built client and `/ownAPI/v1`, with an optional
  `mediaWorker` running the same job queue for scanning/probing off the
  playback box.
- Real production media lives on disk (e.g. an attached volume) as the
  source of truth; NFO export/import round-trips against it.
- TMDB is an optional metadata/artwork source — the library still scans,
  probes, and plays using on-disk names without an API key.
- Desktop and mobile get distinct page implementations of the same web
  design language (not separate native platforms); installable as a PWA.
- Bilingual throughout: English and Turkish.

## Capabilities and Constraints

- Library: scans movies, series, and ebooks; infers seasons/episodes from
  filenames but falls back to a plain title rather than guessing wrong;
  keeps history for files that disappear instead of deleting it; global
  fuzzy search (`Cmd/Ctrl+K`); favourites, "My List", continue-watching,
  next-up.
- Playback: per-browser choice between direct delivery, remuxing, and
  bounded FFmpeg transcoding; audio/subtitle track and quality selection
  with subtitle delay; trickplay scrub thumbnails; series/collection queues;
  skip-segment (intro/credits); watch-together synchronised playback.
- Reading: an EPUB reader for books in the library.
- Administration: user accounts with per-library permissions; an artwork
  tool for identifying titles against TMDB, replacing artwork, and
  hand-positioning logos on cards; background jobs (scan/probe/metadata
  refresh) with progress reporting.
- Hard constraint carried from engineering practice: production media on
  disk is never modified or deleted by the application or its tooling.

## Brand Commitments

- Product name: **Seyirlik**.
- Existing wordmark/lockups in `src/assets/` (`Seyirlik-Logo-OnSide`,
  `-OnSide-cropped`, `-OnTop`, `-Inside`).
- Mark: a stack of horizontal bars on black, a warm-to-cool gradient
  (red → orange → yellow → yellow-green → green → teal) — see
  `public/seyirlik-preview.png`. Treat as incumbent brand evidence for
  `document`/`new-work`, not a palette decision made here.
- Bilingual identity (English/Turkish) is a standing commitment, not a
  per-surface choice.

## Evidence on Hand

- `public/seyirlik-preview.png` — the current logo mark/social preview.
- `src/assets/Seyirlik-Logo-*.png` — existing wordmark lockups.
- `README.md` — the fullest existing statement of product scope and
  architecture; treat it as authoritative product description, not
  marketing copy to reproduce verbatim.
- No testimonials, case studies, press, or third-party evidence exist or
  should be fabricated — there is no external audience to source them from.

## Product Principles

1. Own the whole path. Every feature should reduce reliance on another
   media server or external service, not add a new dependency to it.
2. Never guess wrong. When the system can't confidently infer something
   (an episode number, a match), fall back to a plain/unprocessed state
   over a confident-looking wrong answer.
3. Protect the source library. Production media on disk is the durable
   source of truth; tooling observes and organizes it, never destroys it.
4. Design for the circle, not the public. This is a personal library
   shared with known people, not a multi-tenant SaaS — admin surfaces can
   assume a trusted, small user base.
5. One design language, adapted per device. Desktop and mobile are
   distinct implementations of the same product and visual system, not
   two different products.

## Accessibility & Inclusion

No specific individual accessibility requirement is known. Build to normal
web accessibility standards rather than a documented special requirement.
