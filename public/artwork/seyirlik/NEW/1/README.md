# Revision batch 1

11 final artworks, plus the shared angular wordmark mask. All prior files are preserved. Icon-ribbon is rejected and excluded from this batch; its historical file remains untouched.

## Final artworks

- [Stripes with website accents, top to bottom](icons/stripes-spectrum-exact.png)
- [Original vertical S touching the top](lockups/primary-vertical-top-exact.png)
- [Original spectrum lettering with irregular tiles](poster/spectrum-irregular-exact.png)

All eight wordmarks below use the **same exact coverage mask** extracted from the original `explorations/wordmark-angular.png`. Dimensions, spacing, outlines and dotted İ positions are identical; only colors change.

- [Warm Red](wordmarks/warm-red.png)
- [Amber](wordmarks/amber.png)
- [Gold](wordmarks/gold.png)
- [Olive](wordmarks/olive.png)
- [Green](wordmarks/green.png)
- [Teal](wordmarks/teal.png)
- [White on Warm Red](wordmarks/white-on-warm-red.png)
- [White on dark](wordmarks/white-on-dark.png)

The accent order is Warm Red `#bd3f28`, Amber `#fa9b1d`, Gold `#d3ca22`, Olive `#bacb7d`, Green `#67a478`, Teal `#337b6c`, sourced from `src/lib/accentTheme.ts`. Solid foreground interiors use exact RGB values; antialiased edges blend with their backgrounds.

## Preservation and method

Direct pixel editing was explicitly approved. The vertical alternative removes 208 empty top rows without resizing or redrawing. The spectrum preserves every original pixel above row 690, including the complete wordmark. Only the lower tile region uses image-generated geometry. The stripes retain the original strip silhouettes.

The three initial image-generated drafts are retained at `icons/stripes-spectrum.png`, `lockups/primary-vertical-top.png` and `poster/spectrum-irregular.png`. Prefer the `-exact` versions linked above. Prompts are recorded in [generation-prompts.json](generation-prompts.json).

[Manifest and checksums](manifest.json) · [Shared mask](templates/wordmark-angular-mask.png) · [Reproduction script](build-variants.mjs)

Run from the repository root: `node public/artwork/seyirlik/NEW/1/build-variants.mjs`. This regenerates only this batch's derived outputs and checks all 19 original asset hashes. The website UI, favicon and production deployment are unchanged.
