import { describe, expect, it } from "vitest";
import {
  ArchiveUnsupportedError,
  subtitleEntries,
  toUtf8,
} from "./subtitleArchive";
import { buildZip } from "./zipFixture";

const SRT = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nMerhaba\n");

describe("subtitle archives", () => {
  it("reads stored and deflated subtitle entries and skips everything else", () => {
    const zip = buildZip([
      { name: "Show/Show.S01E01.srt", content: SRT },
      { name: "Show.S01E02.srt", content: SRT, store: true },
      { name: "readme.txt", content: Buffer.from("not a subtitle") },
      { name: "__MACOSX/._Show.S01E01.srt", content: SRT },
    ]);
    const entries = subtitleEntries(zip, "fallback.srt");
    expect(entries.map((entry) => entry.name)).toEqual([
      "Show.S01E01.srt",
      "Show.S01E02.srt",
    ]);
    expect(Buffer.from(entries[0]!.bytes).equals(SRT)).toBe(true);
  });

  it("passes a bare subtitle through under the fallback name", () => {
    expect(subtitleEntries(SRT, "123.srt")).toEqual([
      { name: "123.srt", bytes: SRT },
    ]);
  });

  it("refuses RAR by name so the next candidate is tried", () => {
    const rar = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00]);
    expect(() => subtitleEntries(rar, "x.srt")).toThrow(
      ArchiveUnsupportedError,
    );
  });

  it("drops an entry whose inflated size disagrees with its header", () => {
    const zip = buildZip([{ name: "a.srt", content: SRT }]);
    // Claim a smaller uncompressed size in the central directory.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(3, central + 24);
    expect(subtitleEntries(zip, "x.srt")).toEqual([]);
  });
});

describe("subtitle text encoding", () => {
  it("decodes a Turkish Windows-1254 file to UTF-8", () => {
    // "ığş" in Windows-1254.
    const legacy = new Uint8Array([0xfd, 0xf0, 0xfe]);
    expect(new TextDecoder().decode(toUtf8(legacy, "tur"))).toBe("ığş");
  });

  it("leaves valid UTF-8 untouched and decodes UTF-16 with a BOM", () => {
    const utf8 = new TextEncoder().encode("ığş");
    expect(toUtf8(utf8, "tur")).toBe(utf8);
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("ığş", "utf16le"),
    ]);
    expect(new TextDecoder().decode(toUtf8(utf16, "tur"))).toBe("ığş");
  });
});
