// @vitest-environment node
// The search process has no DOM of its own, so neither does this test.
import { describe, expect, it } from "vitest";

import { buildZip } from "../subtitles/zipFixture";
import { BookRejectedError } from "./epubArchive";
import { readBookPassages } from "./bookText";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
}

function epub(
  sections: Array<{ id: string; href: string; body: string; linear?: "no" }>,
  extra: Array<{ name: string; content: string }> = [],
): Buffer {
  const manifest = sections
    .map(
      (s) =>
        `<item id="${s.id}" href="${s.href}" media-type="application/xhtml+xml"/>`,
    )
    .join("");
  const spine = sections
    .map(
      (s) =>
        `<itemref idref="${s.id}"${s.linear ? ` linear="${s.linear}"` : ""}/>`,
    )
    .join("");
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>${manifest}</manifest><spine>${spine}</spine>
</package>`;
  return buildZip([
    {
      name: "mimetype",
      content: Buffer.from("application/epub+zip"),
      store: true,
    },
    { name: "META-INF/container.xml", content: Buffer.from(CONTAINER) },
    { name: "OEBPS/content.opf", content: Buffer.from(opf) },
    ...sections.map((s) => ({
      name: `OEBPS/${decodeURIComponent(s.href)}`,
      content: Buffer.from(xhtml(s.body)),
    })),
    ...extra.map((file) => ({
      name: file.name,
      content: Buffer.from(file.content),
    })),
  ]);
}

const long = (word: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${word} ${i}.`).join(" ");

describe("reading a book into passages", () => {
  it("numbers sections by spine position, linear=no included", () => {
    const passages = readBookPassages(
      epub([
        {
          id: "cover",
          href: "cover.xhtml",
          body: "<p>Cover</p>",
          linear: "no",
        },
        { id: "one", href: "Text/one.xhtml", body: "<p>First chapter.</p>" },
        {
          id: "two",
          href: "Text/two%20b.xhtml",
          body: "<p>Second chapter.</p>",
        },
      ]),
    );
    expect(passages.map((p) => [p.section, p.block, p.text])).toEqual([
      [0, 0, "Cover"],
      [1, 0, "First chapter."],
      [2, 0, "Second chapter."],
    ]);
  });

  it("counts blocks as the reader does: pictures count, wrappers do not", () => {
    const [passage, ...rest] = readBookPassages(
      epub([
        {
          id: "one",
          href: "one.xhtml",
          body: `<div class="wrap"><h1>Bir</h1><figure><img src="a.jpg"/></figure>
                 <p>Raif Efendi sustu.</p><div>Direct text in a div.</div></div>`,
        },
      ]),
    );
    // h1 = 0, figure = 1 (no text, still a block), p = 2, div with text = 3.
    expect(rest).toEqual([]);
    expect(passage).toMatchObject({ section: 0, block: 0, anchor: "Bir" });
    expect(passage!.text).toBe(
      "Bir\nRaif Efendi sustu.\nDirect text in a div.",
    );
  });

  it("gathers short blocks into passages and starts each at its own block", () => {
    const paragraph = long("Cümle", 30);
    const passages = readBookPassages(
      epub([
        {
          id: "one",
          href: "one.xhtml",
          body: Array.from({ length: 6 }, () => `<p>${paragraph}</p>`).join(""),
        },
      ]),
    );
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.anchor).toBe(paragraph.slice(0, 60));
      expect(passage.text.length).toBeGreaterThanOrEqual(paragraph.length);
    }
    expect(passages.map((p) => p.block)).toEqual(
      [...passages.map((p) => p.block)].sort((a, b) => a - b),
    );
  });

  it("cuts a chapter set as one block into pieces that all open at that block", () => {
    const passages = readBookPassages(
      epub([
        {
          id: "one",
          href: "one.xhtml",
          body: `<p>Önce.</p><div>${long("Uzun cümle burada", 120)}</div>`,
        },
      ]),
    );
    const pieces = passages.filter((p) => p.block === 1);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(piece.text.length).toBeLessThanOrEqual(2_200);
      expect(piece.text.startsWith(piece.anchor)).toBe(true);
    }
  });

  it("reads HTML entities in XHTML, as browsers do for an XHTML DTD", () => {
    const [passage] = readBookPassages(
      epub([
        {
          id: "one",
          href: "one.xhtml",
          body: "<p>Lenina&nbsp;&rsquo;nın yargısı &amp; Bernard</p>",
        },
      ]),
    );
    // A no-break space is whitespace like any other once the text is compared.
    expect(passage?.text).toBe("Lenina \u2019nın yargısı & Bernard");
  });

  it("still finds the text of a section no XML parser accepts", () => {
    const [passage] = readBookPassages(
      epub([
        {
          id: "one",
          href: "one.xhtml",
          body: "<p>Açık <br> kalan&bogus; etiket</p>",
        },
      ]),
    );
    expect(passage?.text).toContain("Açık");
  });

  it("drops what the reader removes and ignores soft hyphens", () => {
    const [passage] = readBookPassages(
      epub([
        {
          id: "one",
          href: "one.xhtml",
          body: `<script>alert(1)</script><p>ka­lem</p>`,
        },
      ]),
    );
    expect(passage).toMatchObject({ block: 0, text: "kalem" });
  });

  it("refuses a book the reader could not open either", () => {
    const drm = epub(
      [{ id: "one", href: "one.xhtml", body: "<p>x</p>" }],
      [{ name: "META-INF/rights.xml", content: "<rights/>" }],
    );
    expect(() => readBookPassages(drm)).toThrow(BookRejectedError);
    expect(() =>
      readBookPassages(
        epub([{ id: "one", href: "one.xhtml", body: "<img src='a.jpg'/>" }]),
      ),
    ).toThrow("This book has no text to search.");
  });
});
