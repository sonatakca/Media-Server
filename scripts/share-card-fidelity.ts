/**
 * Measures how closely the shared-link card matches the card the site draws.
 *
 * The site's card is CSS; the share image is sharp and librsvg. This renders
 * the same cover, logo and layout both ways at the same pixel size — the CSS
 * in Chromium, from the very style functions the card calls — and reports the
 * difference, writing both images and an amplified difference beside them.
 *
 *   npx tsx scripts/share-card-fidelity.ts <cover> <logo> <outDir> [x y width shadow]
 *
 * Without a layout it checks the unadjusted card.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright";
import {
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFilter,
  type LogoLayout,
} from "../src/lib/logoLayout";
import {
  REFERENCE_CARD_HEIGHT,
  REFERENCE_CARD_WIDTH,
  renderPosterCard,
} from "../src/server/ownApi/share/posterCard";

function style(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`,
    )
    .join(";");
}

async function main() {
  const [coverPath, logoPath, outDir, ...rest] = process.argv.slice(2);
  if (!coverPath || !logoPath || !outDir) {
    throw new Error("usage: <cover> <logo> <outDir> [x y width shadow]");
  }
  const layout: LogoLayout | null =
    rest.length === 4
      ? {
          x: Number(rest[0]),
          y: Number(rest[1]),
          width: Number(rest[2]),
          shadow: Number(rest[3]),
        }
      : null;

  const cover = await readFile(coverPath);
  // The card fetches its logo at 520px wide; both sides get those bytes.
  const logo = await sharp(await readFile(logoPath))
    .resize({ width: 520, withoutEnlargement: true })
    .png()
    .toBuffer();
  const width = 550;
  const scale = width / REFERENCE_CARD_WIDTH;

  const filter = getLogoShadowFilter(layout?.shadow ?? 1);
  const logoImg = (extra: Record<string, string | undefined>) =>
    `<img src="data:image/png;base64,${logo.toString("base64")}" style="${style({
      ...extra,
      filter,
    })}">`;
  const backdrop = layout ? getLogoShadowBackdropStyle(layout.shadow) : null;
  const logoMarkup = layout
    ? `<div style="${style({
        position: "absolute",
        zIndex: "20",
        ...getLogoLayoutStyle(layout),
      })}">${
        backdrop
          ? `<span style="${style({
              position: "absolute",
              borderRadius: "45%",
              ...backdrop,
            })}"></span>`
          : ""
      }${logoImg({
        position: "relative",
        zIndex: "10",
        display: "block",
        height: "auto",
        width: "100%",
        objectFit: "contain",
      })}</div>`
    : logoImg({
        position: "absolute",
        left: "0",
        right: "0",
        bottom: "16px",
        margin: "0 auto",
        zIndex: "20",
        height: "auto",
        width: "auto",
        maxHeight: "96px",
        maxWidth: "80%",
        objectFit: "contain",
      });

  const html = `<!doctype html><html><body style="margin:0;background:#000">
<div id="card" style="position:relative;width:${REFERENCE_CARD_WIDTH}px;height:${REFERENCE_CARD_HEIGHT}px;overflow:hidden;border-radius:12px">
<img src="data:image/jpeg;base64,${cover.toString("base64")}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
${logoMarkup}
</div></body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: scale });
  await page.setContent(html, { waitUntil: "load" });
  const css = await page.locator("#card").screenshot({ omitBackground: true });
  await browser.close();

  const ours = await renderPosterCard({ cover, logo, layout, width });

  const read = async (bytes: Buffer) =>
    sharp(bytes)
      .resize(width, Math.round(width * 1.5), { fit: "fill" })
      .flatten({ background: "#000" })
      .raw()
      .toBuffer({ resolveWithObject: true });
  const a = await read(css);
  const b = await read(ours);

  let sum = 0;
  let over8 = 0;
  let max = 0;
  const diff = Buffer.alloc(a.data.length);
  const pixels = a.data.length / 3;
  for (let i = 0; i < a.data.length; i += 3) {
    let worst = 0;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(a.data[i + c]! - b.data[i + c]!);
      sum += d;
      worst = Math.max(worst, d);
      diff[i + c] = Math.min(255, d * 8);
    }
    max = Math.max(max, worst);
    if (worst > 8) over8 += 1;
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "css.png"), css);
  await writeFile(path.join(outDir, "server.png"), ours);
  await sharp(diff, { raw: a.info })
    .png()
    .toFile(path.join(outDir, "diff-x8.png"));
  console.log(
    JSON.stringify({
      layout,
      meanAbsError: Number((sum / a.data.length).toFixed(3)),
      pixelsOver8: `${((100 * over8) / pixels).toFixed(3)}%`,
      maxChannelError: max,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
