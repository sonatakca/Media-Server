import { describe, expect, it } from "vitest";
import {
  NFO_MANAGED_MARKER,
  escapeXml,
  isManagedNfo,
  serializeNfo,
  type NfoDocument,
} from "./nfoSerializer";

function movie(overrides: Partial<NfoDocument> = {}): NfoDocument {
  return { root: "movie", title: "Dune", ...overrides };
}

describe("nfo serializer", () => {
  it("writes a declaration, the generator marker, and the requested root", () => {
    const xml = serializeNfo(movie());

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    expect(xml).toContain(NFO_MANAGED_MARKER);
    expect(xml).toContain("<movie>");
    expect(xml.endsWith("</movie>\n")).toBe(true);
    expect(isManagedNfo(xml)).toBe(true);
  });

  it("uses the documented root element for every kind", () => {
    expect(serializeNfo({ root: "tvshow", title: "Şahsiyet" })).toContain(
      "<tvshow>",
    );
    expect(serializeNfo({ root: "season", seasonNumber: 2 })).toContain(
      "<season>",
    );
    expect(serializeNfo({ root: "episodedetails", title: "Pilot" })).toContain(
      "<episodedetails>",
    );
  });

  describe("escaping", () => {
    it("escapes every character that would break the document", () => {
      const xml = serializeNfo(
        movie({ title: `A & B <tag> "quoted" 'single'` }),
      );

      expect(xml).toContain(
        "<title>A &amp; B &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;</title>",
      );
      // The raw characters must not survive anywhere in the body.
      expect(xml).not.toContain("<tag>");
    });

    it("escapes attribute values as well as text", () => {
      const xml = serializeNfo(
        movie({ uniqueIds: [{ type: 'tm"db', value: "1", isDefault: true }] }),
      );

      expect(xml).toContain('type="tm&quot;db"');
    });

    it("cannot be closed early by a value that looks like markup", () => {
      const xml = serializeNfo(
        movie({ plot: "</movie><injected>hostile</injected><movie>" }),
      );

      expect(xml).not.toContain("<injected>");
      expect(xml.match(/<movie>/g)).toHaveLength(1);
      expect(xml.match(/<\/movie>/g)).toHaveLength(1);
    });

    it("drops control characters XML cannot represent", () => {
      expect(escapeXml("a\u0000b\u0008c")).toBe("abc");
      // Tab, newline and carriage return are legal; CR is normalised to LF.
      expect(escapeXml("a\tb\r\nc")).toBe("a\tb\nc");
    });

    it("drops lone surrogates but keeps real astral characters", () => {
      expect(escapeXml("a\uD800b")).toBe("ab");
      expect(escapeXml("emoji \u{1F3AC} here")).toBe("emoji \u{1F3AC} here");
    });
  });

  describe("unicode", () => {
    it("keeps Turkish characters exactly as written", () => {
      const xml = serializeNfo(
        movie({
          title: "Ayla: Savaşın Kızı",
          originalTitle: "Ayla: The Daughter of War",
          plot: "İstanbul'da geçen bir hikâye. Şöyle: ğüşiöç ĞÜŞİÖÇ.",
          genres: ["Dram", "Savaş"],
          actors: [{ name: "İsmail Hacıoğlu", character: "Süleyman" }],
        }),
      );

      expect(xml).toContain("<title>Ayla: Savaşın Kızı</title>");
      expect(xml).toContain("ğüşiöç ĞÜŞİÖÇ");
      expect(xml).toContain("<genre>Savaş</genre>");
      expect(xml).toContain("<name>İsmail Hacıoğlu</name>");
      expect(xml).toContain("<role>Süleyman</role>");
      // The apostrophe inside Turkish text is escaped, not dropped.
      expect(xml).toContain("İstanbul&apos;da");
      // Round-trips through UTF-8 without loss.
      expect(Buffer.from(xml, "utf8").toString("utf8")).toBe(xml);
    });

    it("keeps non-Latin scripts and combining marks", () => {
      const xml = serializeNfo(movie({ title: "千と千尋の神隠し" }));
      expect(xml).toContain("<title>千と千尋の神隠し</title>");
    });
  });

  describe("determinism", () => {
    it("produces identical bytes for the same document", () => {
      const document = movie({
        originalTitle: "Dune",
        year: 2021,
        rating: 7.8,
        genres: ["Science Fiction", "Adventure"],
        uniqueIds: [
          { type: "tmdb", value: "438631", isDefault: true },
          { type: "imdb", value: "tt1160419" },
        ],
        actors: [{ name: "Timothée Chalamet", character: "Paul", order: 0 }],
        streamDetails: {
          video: [{ codec: "hevc", isDefault: true, isForced: false }],
          audio: [{ codec: "eac3", isDefault: true, isForced: false }],
          subtitle: [],
        },
      });

      expect(serializeNfo(document)).toBe(serializeNfo(document));
      expect(serializeNfo(document)).toBe(serializeNfo({ ...document }));
    });

    it("renders a rating at a fixed precision", () => {
      expect(serializeNfo(movie({ rating: 7.7999997138977 }))).toContain(
        "<rating>7.8</rating>",
      );
      expect(serializeNfo(movie({ rating: 8 }))).toContain(
        "<rating>8.0</rating>",
      );
    });
  });

  describe("absent metadata", () => {
    it("omits every field it was not given", () => {
      const xml = serializeNfo(movie());

      for (const field of [
        "originaltitle",
        "sorttitle",
        "plot",
        "tagline",
        "year",
        "premiered",
        "enddate",
        "runtime",
        "rating",
        "mpaa",
        "genre",
        "uniqueid",
        "director",
        "credits",
        "actor",
        "fileinfo",
      ]) {
        expect(xml).not.toContain(`<${field}>`);
      }
    });

    it("treats a blank string as absent rather than emitting an empty tag", () => {
      const xml = serializeNfo(movie({ tagline: "   ", plot: "" }));

      expect(xml).not.toContain("<tagline>");
      expect(xml).not.toContain("<plot>");
    });

    it("keeps a zero that is a real value", () => {
      expect(serializeNfo({ root: "season", seasonNumber: 0 })).toContain(
        "<seasonnumber>0</seasonnumber>",
      );
    });
  });

  describe("identifiers", () => {
    it("marks TMDB as the default and emits the legacy elements too", () => {
      const xml = serializeNfo(
        movie({
          uniqueIds: [
            { type: "tmdb", value: "438631", isDefault: true },
            { type: "imdb", value: "tt1160419" },
            { type: "tvdb", value: "12345" },
          ],
        }),
      );

      expect(xml).toContain(
        '<uniqueid type="tmdb" default="true">438631</uniqueid>',
      );
      expect(xml).toContain('<uniqueid type="imdb">tt1160419</uniqueid>');
      expect(xml).toContain('<uniqueid type="tvdb">12345</uniqueid>');
      expect(xml).toContain("<tmdbid>438631</tmdbid>");
      expect(xml).toContain("<imdbid>tt1160419</imdbid>");
      expect(xml).toContain("<tvdbid>12345</tvdbid>");
    });

    it("emits no identifier at all when none is known", () => {
      expect(serializeNfo(movie({ uniqueIds: [] }))).not.toContain("uniqueid");
    });
  });

  it("writes writers as <credits>, which is what Kodi reads", () => {
    const xml = serializeNfo(
      movie({ directors: ["Denis Villeneuve"], writers: ["Jon Spaihts"] }),
    );

    expect(xml).toContain("<director>Denis Villeneuve</director>");
    expect(xml).toContain("<credits>Jon Spaihts</credits>");
  });

  it("nests stream details under fileinfo in video, audio, subtitle order", () => {
    const xml = serializeNfo(
      movie({
        streamDetails: {
          video: [
            {
              codec: "hevc",
              width: 3840,
              height: 2160,
              aspect: 16 / 9,
              durationSeconds: 9180,
              bitDepth: 10,
              hdrType: "hdr10",
              language: "eng",
              isDefault: true,
              isForced: false,
            },
          ],
          audio: [
            {
              codec: "eac3",
              language: "tur",
              channels: 6,
              isDefault: true,
              isForced: false,
            },
          ],
          subtitle: [
            {
              codec: "subrip",
              language: "tur",
              isDefault: false,
              isForced: true,
            },
          ],
        },
      }),
    );

    expect(xml).toContain("<fileinfo>");
    expect(xml).toContain("<streamdetails>");
    expect(xml.indexOf("<video>")).toBeLessThan(xml.indexOf("<audio>"));
    expect(xml.indexOf("<audio>")).toBeLessThan(xml.indexOf("<subtitle>"));
    expect(xml).toContain("<aspect>1.778</aspect>");
    expect(xml).toContain("<durationinseconds>9180</durationinseconds>");
    expect(xml).toContain("<hdrtype>hdr10</hdrtype>");
    expect(xml).toContain("<channels>6</channels>");
    expect(xml).toContain("<forced>true</forced>");
  });
});
