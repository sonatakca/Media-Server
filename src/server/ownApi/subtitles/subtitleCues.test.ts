import { describe, expect, it } from "vitest";
import {
  cueIntervals,
  documentCues,
  formatCueTimestamp,
  parseCueTimestamp,
  parseSubtitleDocument,
  retimeBlocks,
  serialiseSubtitleDocument,
  sniffCueFormat,
} from "./subtitleCues";

const SRT = [
  "1",
  "00:00:10,500 --> 00:00:12,000",
  "First line.",
  "",
  "2",
  "00:01:00,000 --> 00:01:02,250",
  "Second line,",
  "over two rows.",
  "",
].join("\n");

const VTT = [
  "WEBVTT",
  "",
  "NOTE This block is not a cue.",
  "",
  "cue-1",
  "00:00:10.500 --> 00:00:12.000 line:90%",
  "First line.",
  "",
  "00:01:00.000 --> 00:01:02.250",
  "Second line.",
  "",
].join("\n");

describe("parseSubtitleDocument", () => {
  it("reads SubRip cues and their numbering", () => {
    const document = parseSubtitleDocument(SRT);
    expect(document.format).toBe("srt");
    const cues = documentCues(document);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.startSeconds).toBeCloseTo(10.5, 6);
    expect(cues[0]?.lead).toEqual(["1"]);
    expect(cues[1]?.text).toEqual(["Second line,", "over two rows."]);
  });

  it("reads WebVTT cue settings and identifiers", () => {
    const cues = documentCues(parseSubtitleDocument(VTT));
    expect(cues).toHaveLength(2);
    expect(cues[0]?.settings).toBe("line:90%");
    expect(cues[0]?.lead).toEqual(["cue-1"]);
  });

  it("keeps blocks it does not understand instead of dropping them", () => {
    const document = parseSubtitleDocument(VTT);
    const raw = document.blocks.filter((block) => block.kind === "raw");
    expect(raw.map((block) => block.text)).toEqual([
      "WEBVTT",
      "NOTE This block is not a cue.",
    ]);
  });

  it("accepts either timestamp spelling in either format", () => {
    const cues = documentCues(
      parseSubtitleDocument("1\n00:00:01.500 --> 00:00:02,000\nHello.\n"),
    );
    expect(cues[0]?.startSeconds).toBeCloseTo(1.5, 6);
    expect(cues[0]?.endSeconds).toBeCloseTo(2, 6);
  });
});

describe("serialiseSubtitleDocument", () => {
  it("round-trips a SubRip document unchanged", () => {
    expect(serialiseSubtitleDocument(parseSubtitleDocument(SRT))).toBe(SRT);
  });

  it("round-trips a WebVTT document unchanged", () => {
    expect(serialiseSubtitleDocument(parseSubtitleDocument(VTT))).toBe(VTT);
  });

  it("keeps the line endings the file arrived with", () => {
    const windows = SRT.replace(/\n/g, "\r\n");
    expect(serialiseSubtitleDocument(parseSubtitleDocument(windows))).toBe(
      windows,
    );
  });

  it("writes each format's own timestamp separator", () => {
    const document = parseSubtitleDocument(SRT);
    expect(serialiseSubtitleDocument({ ...document, format: "vtt" })).toContain(
      "00:00:10.500 --> 00:00:12.000",
    );
  });

  it("restores a WebVTT signature the document has lost", () => {
    const document = parseSubtitleDocument(VTT);
    const withoutHeader = {
      ...document,
      blocks: document.blocks.filter(
        (block) => block.kind !== "raw" || block.text !== "WEBVTT",
      ),
    };
    expect(serialiseSubtitleDocument(withoutHeader).startsWith("WEBVTT")).toBe(
      true,
    );
  });
});

describe("formatCueTimestamp", () => {
  it("never carries a rounded millisecond into a fourth digit", () => {
    expect(formatCueTimestamp(9.9999, "vtt")).toBe("00:00:10.000");
  });

  it("writes hours even when there are none", () => {
    expect(formatCueTimestamp(61.25, "srt")).toBe("00:01:01,250");
  });

  it("holds a negative time at zero rather than writing one", () => {
    expect(formatCueTimestamp(-3, "vtt")).toBe("00:00:00.000");
  });

  it("round-trips through the parser", () => {
    expect(parseCueTimestamp(formatCueTimestamp(3723.456, "srt"))).toBeCloseTo(
      3723.456,
      3,
    );
  });
});

describe("sniffCueFormat", () => {
  it("believes the bytes rather than an extension", () => {
    expect(sniffCueFormat("WEBVTT\n\n00:00.000 --> 00:01.000\nx")).toBe("vtt");
    expect(sniffCueFormat("1\n00:00:00,000 --> 00:00:01,000\nx")).toBe("srt");
  });
});

describe("retimeBlocks", () => {
  it("applies the offset and the rate to every cue", () => {
    const document = parseSubtitleDocument(SRT);
    const { blocks } = retimeBlocks(document.blocks, {
      rate: 1,
      offsetSeconds: -5,
    });
    const cues = blocks.filter((block) => block.kind === "cue");
    expect(cues[0]?.startSeconds).toBeCloseTo(5.5, 6);
    expect(cues[1]?.startSeconds).toBeCloseTo(55, 6);
  });

  it("scales before it shifts", () => {
    const document = parseSubtitleDocument(SRT);
    const { blocks } = retimeBlocks(document.blocks, {
      rate: 2,
      offsetSeconds: 1,
    });
    const cues = blocks.filter((block) => block.kind === "cue");
    expect(cues[0]?.startSeconds).toBeCloseTo(22, 6);
  });

  it("drops a cue pushed entirely before the media begins", () => {
    const document = parseSubtitleDocument(SRT);
    const report = retimeBlocks(document.blocks, {
      rate: 1,
      offsetSeconds: -30,
    });
    expect(report.dropped).toBe(1);
    expect(report.blocks.filter((block) => block.kind === "cue")).toHaveLength(
      1,
    );
  });

  it("holds a cue that merely starts too early at zero", () => {
    const document = parseSubtitleDocument(SRT);
    const report = retimeBlocks(document.blocks, {
      rate: 1,
      offsetSeconds: -11,
    });
    expect(report.dropped).toBe(0);
    expect(report.clamped).toBe(1);
    const first = report.blocks.find((block) => block.kind === "cue");
    expect(first?.kind === "cue" && first.startSeconds).toBe(0);
    expect(first?.kind === "cue" && first.endSeconds).toBeCloseTo(1, 6);
  });

  it("leaves everything that is not a cue alone", () => {
    const document = parseSubtitleDocument(VTT);
    const { blocks } = retimeBlocks(document.blocks, {
      rate: 1.05,
      offsetSeconds: 3,
    });
    expect(
      blocks.filter((block) => block.kind === "raw").map((b) => b.text),
    ).toEqual(["WEBVTT", "NOTE This block is not a cue."]);
  });
});

describe("cueIntervals", () => {
  it("orders by start and refuses a cue with no duration", () => {
    const document = parseSubtitleDocument(
      "1\n00:00:05,000 --> 00:00:06,000\nb\n\n2\n00:00:01,000 --> 00:00:01,000\na\n",
    );
    expect(cueIntervals(documentCues(document))).toEqual([
      { startSeconds: 5, endSeconds: 6 },
    ]);
  });
});
