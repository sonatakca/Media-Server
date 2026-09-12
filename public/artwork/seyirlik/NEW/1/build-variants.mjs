// Run from repository root: node public/artwork/seyirlik/NEW/1/build-variants.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root = 'public/artwork/seyirlik';
const out = `${root}/NEW/1`;
const colors = { 'warm-red': '#bd3f28', amber: '#fa9b1d', gold: '#d3ca22', olive: '#bacb7d', green: '#67a478', teal: '#337b6c' };
const rgb = hex => hex.slice(1).match(/../g).map(v => parseInt(v, 16));
const dark = rgb('#050607'), white = rgb('#f8fafc');
const clamp = v => Math.max(0, Math.min(1, v));
const luminance = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
async function read(file) {
  return sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function write(file, data, width, height, channels = 3) {
  await sharp(data, { raw: { width, height, channels } }).png().toFile(`${out}/${file}`);
}
const entries = [];
function record(file, method) { entries.push({ file, method }); }
// One shared coverage mask; every variant uses exactly the same pixel coordinates.
const angular = await read(`${root}/explorations/wordmark-angular.png`);
const { width: w, height: h } = angular.info;
const mask = Buffer.alloc(w * h);
for (let p = 0; p < mask.length; p++) {
  mask[p] = Math.round(255 * clamp((245 - luminance(angular.data, p * 3)) / 230));
}
await write('templates/wordmark-angular-mask.png', mask, w, h, 1);
record('templates/wordmark-angular-mask.png', 'Coverage mask extracted once from original wordmark-angular; white is foreground.');
async function wordmark(name, foreground, background) {
  const data = Buffer.alloc(w * h * 3);
  for (let p = 0; p < mask.length; p++) {
    const a = mask[p] / 255;
    for (let c = 0; c < 3; c++) data[p * 3 + c] = Math.round(background[c] * (1 - a) + foreground[c] * a);
  }
  const file = `wordmarks/${name}.png`;
  await write(file, data, w, h);
  const decoded = await read(`${out}/${file}`);
  assert.deepEqual(decoded.data, data);
  record(file, 'Exact shared angular coverage mask; only foreground/background RGB changes.');
}
for (const [name, hex] of Object.entries(colors)) await wordmark(name, rgb(hex), dark);
await wordmark('white-on-warm-red', white, rgb(colors['warm-red']));
await wordmark('white-on-dark', white, dark);
// Preserve the S and lettering byte-for-byte: crop only empty top padding.
const vertical = await read(`${root}/lockups/primary-vertical.png`);
const vw = vertical.info.width, vh = vertical.info.height;
let top = 0;
while (top < vh && !Array.from({ length: vw }, (_, x) => luminance(vertical.data, (top * vw + x) * 3) > 128).some(Boolean)) top++;
assert(top > 0 && top < vh / 3);
const crop = vertical.data.subarray(top * vw * 3);
await write('lockups/primary-vertical-top-exact.png', crop, vw, vh - top);
assert.deepEqual((await read(`${out}/lockups/primary-vertical-top-exact.png`)).data, crop);
record('lockups/primary-vertical-top-exact.png', `Original RGB pixels, cropped ${top} empty top rows only; no rescaling or redrawing.`);
// Recolor original stripe silhouettes in their established top-to-bottom order.
const stripes = await read(`${root}/explorations/icon-stripes.png`);
const sw = stripes.info.width, sh = stripes.info.height;
const bands = [];
let active = false;
for (let y = 0; y < sh; y++) {
  let present = false;
  for (let x = 0; x < sw; x++) if (luminance(stripes.data, (y * sw + x) * 3) > 128) { present = true; break; }
  if (present && !active) bands.push({ start: y, end: y });
  if (present) bands.at(-1).end = y;
  active = present;
}
assert.equal(bands.length, 6);
const stripeData = Buffer.from(stripes.data);
for (let n = 0; n < bands.length; n++) {
  const color = rgb(Object.values(colors)[n]);
  for (let y = bands[n].start - 2; y <= bands[n].end + 2; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 3;
    const a = clamp((luminance(stripes.data, i) - 15) / 225);
    if (!a) continue;
    for (let c = 0; c < 3; c++) stripeData[i + c] = Math.round(dark[c] * (1 - a) + color[c] * a);
  }
}
await write('icons/stripes-spectrum-exact.png', stripeData, sw, sh);
record('icons/stripes-spectrum-exact.png', 'Original six stripe silhouettes recolored top-to-bottom using website accent order.');
// Retain original spectrum lettering pixels, using only the edited tile region.
const spectrum = await read(`${root}/poster/spectrum.png`);
const edited = await read(`${out}/poster/spectrum-irregular.png`);
assert.equal(spectrum.info.width, edited.info.width);
assert.equal(spectrum.info.height, edited.info.height);
const pw = spectrum.info.width, ph = spectrum.info.height, boundary = 690;
const poster = Buffer.from(spectrum.data);
edited.data.copy(poster, boundary * pw * 3, boundary * pw * 3);
// Use generated irregular tile outlines, but give their interiors exact RGB accents.
const centers = [293, 484, 674, 863, 1053, 1244];
for (let y = boundary; y < ph; y++) for (let x = 0; x < pw; x++) {
  const i = (y * pw + x) * 3;
  const max = Math.max(...poster.subarray(i, i + 3));
  const min = Math.min(...poster.subarray(i, i + 3));
  if (max - min < 12 || max < 24) continue;
  const n = centers.reduce((best, center, j) => Math.abs(x - center) < Math.abs(x - centers[best]) ? j : best, 0);
  const color = rgb(Object.values(colors)[n]);
  const a = clamp((max - min - 12) / 35);
  for (let c = 0; c < 3; c++) poster[i + c] = Math.round(dark[c] * (1 - a) + color[c] * a);
}
assert.deepEqual(poster.subarray(0, boundary * pw * 3), spectrum.data.subarray(0, boundary * pw * 3));
await write('poster/spectrum-irregular-exact.png', poster, pw, ph);
record('poster/spectrum-irregular-exact.png', 'Original spectrum rows 0–689 unchanged; image-generated irregular tiles below, recolored to website accents.');
for (const e of entries) {
  const bytes = await fs.readFile(`${out}/${e.file}`);
  const m = await sharp(bytes).metadata();
  Object.assign(e, { width: m.width, height: m.height, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
const old = JSON.parse(await fs.readFile(`${root}/manifest.json`, 'utf8'));
for (const asset of old.assets) assert.equal(crypto.createHash('sha256').update(await fs.readFile(`${root}/${asset.file}`)).digest('hex'), asset.sha256);
await fs.writeFile(`${out}/manifest.json`, JSON.stringify({ batch: 1, palette: colors, neutral: { dark: '#050607', white: '#f8fafc' }, excluded: ['icon-ribbon'], assets: entries, preservedDrafts: ['icons/stripes-spectrum.png', 'lockups/primary-vertical-top.png', 'poster/spectrum-irregular.png'], verification: 'All 19 original assets unchanged. Wordmarks share one coverage mask. Vertical crop and spectrum lettering verified byte-for-byte.' }, null, 2) + '\n');
console.log(`Created ${entries.length - 1} final artworks and one reusable mask. All checks passed; ${top} rows cropped.`);
