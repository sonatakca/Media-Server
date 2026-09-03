/**
 * Reproduces the placeholder's initialisation segment and compares it with a
 * real epoch's. Diagnostic only; the duration is short because the init segment
 * is decided by encoder configuration rather than by length.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPlaceholderEpochArgs } from "../src/renditions/adaptive/epochs/placeholder";
import { generatePlaceholderEpoch } from "../src/renditions/adaptive/epochs/placeholder";
import { runFfmpeg } from "../src/renditions/processor";
import { parseMediaPlaylist } from "../src/renditions/adaptive/playlist";
import { readInitSegment } from "../src/renditions/adaptive/epochs/fragments";

const EPOCHS =
  "/Volumes/Expansion/seyirlik/work/renditions/9f18d579-268f-445f-8a99-ef76033afa62/cmaf-hls-aligned-v3-2babccc71a782fd9/epochs";

const reference = JSON.parse(
  await readFile(path.join(EPOCHS, "000009", "COMPLETE.json"), "utf8"),
) as {
  renditions: Array<{
    id: string;
    qualityHeight: number;
    width: number;
    height: number;
    frameRate: number;
    mediaTimescale: number;
    initDigest: string;
    mediaPath: string;
    playlistPath: string;
  }>;
};

const videoOutputs = reference.renditions
  .filter((entry) => entry.qualityHeight > 0)
  .map((entry) => ({
    qualityHeight: entry.qualityHeight,
    width: entry.width,
    height: entry.height,
  }));

const frameRate = reference.renditions[0]!.frameRate;
console.log("rungs", videoOutputs.map((o) => `${o.width}x${o.height}`).join(" "));
console.log("frameRate", frameRate);

const workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-init-repro-"));
const args = buildPlaceholderEpochArgs({
  directory: workspace,
  videoOutputs,
  encoder: "hevc_videotoolbox",
  hdr: { colorPrimaries: "bt2020", colorTransfer: "smpte2084", colorSpace: "bt2020nc" },
  frameRate,
  segmentSeconds: 2,
  preset: "medium",
  durationSeconds: 8,
});
console.log("\nffmpeg args:\n", args.join(" ").slice(0, 1400));

await generatePlaceholderEpoch({
  directory: workspace,
  videoOutputs,
  encoder: "hevc_videotoolbox",
  hdr: { colorPrimaries: "bt2020", colorTransfer: "smpte2084", colorSpace: "bt2020nc" },
  frameRate,
  segmentSeconds: 2,
  preset: "medium",
  durationSeconds: 8,
  ffmpegPath: "ffmpeg",
  logPath: path.join(workspace, "ffmpeg.log"),
  runEncoder: runFfmpeg,
});

async function digestOf(root: string, playlistPath: string, mediaPath: string) {
  const playlist = parseMediaPlaylist(
    await readFile(path.join(root, playlistPath), "utf8"),
  );
  const handle = await readFile(path.join(root, mediaPath));
  const init = handle.subarray(
    playlist.map.byteRange.offset,
    playlist.map.byteRange.offset + playlist.map.byteRange.length,
  );
  const { mediaTimescale } = readInitSegment(init);
  return {
    digest: createHash("sha256").update(init).digest("hex"),
    mediaTimescale,
    bytes: init.length,
    init,
  };
}

console.log("\nid            timescale  digest(12)  bytes   match");
for (const entry of reference.renditions.filter((e) => e.qualityHeight > 0)) {
  const made = await digestOf(workspace, entry.playlistPath, entry.mediaPath);
  const same = made.digest === entry.initDigest;
  console.log(
    entry.id.padEnd(8),
    String(made.mediaTimescale).padStart(9),
    made.digest.slice(0, 12),
    "ref",
    entry.initDigest.slice(0, 12),
    String(made.bytes).padStart(5),
    same ? "SAME" : `DIFF (ref ts ${entry.mediaTimescale})`,
  );
  if (!same && entry.id === "2160p") {
    const refMedia = await readFile(path.join(EPOCHS, "000009", entry.mediaPath));
    const refPlaylist = parseMediaPlaylist(
      await readFile(path.join(EPOCHS, "000009", entry.playlistPath), "utf8"),
    );
    const refInit = refMedia.subarray(
      refPlaylist.map.byteRange.offset,
      refPlaylist.map.byteRange.offset + refPlaylist.map.byteRange.length,
    );
    await Bun_write(workspace, refInit, made.init);
  }
}

async function Bun_write(dir: string, refInit: Buffer, madeInit: Buffer) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile("/private/tmp/claude-501/ref-init.bin", refInit);
  await writeFile("/private/tmp/claude-501/made-init.bin", madeInit);
  console.log(
    "\n2160p init sizes: reference",
    refInit.length,
    "placeholder",
    madeInit.length,
  );
  const limit = Math.min(refInit.length, madeInit.length);
  const diffs: number[] = [];
  for (let i = 0; i < limit; i += 1)
    if (refInit[i] !== madeInit[i]) diffs.push(i);
  console.log("first differing offsets:", diffs.slice(0, 20));
}

console.log("\nworkspace:", workspace);
