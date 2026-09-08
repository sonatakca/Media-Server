// @vitest-environment node
import { describe, expect, it } from "vitest";
import { childNamed, childrenNamed, parseXml, XmlError } from "./xmlReader";

describe("reading indexer XML", () => {
  it("reads elements, attributes, nesting and text", () => {
    const root = parseXml(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Geek</title>` +
        `<item><title>A</title><size>12</size></item>` +
        `<item><title>B</title><size>34</size></item></channel></rss>`,
    );
    expect(root.name).toBe("rss");
    expect(root.attributes.get("version")).toBe("2.0");
    const channel = childNamed(root, "channel");
    expect(channel?.text.trim()).toBe("");
    const items = childrenNamed(channel!, "item");
    expect(items).toHaveLength(2);
    expect(childNamed(items[0]!, "title")?.text).toBe("A");
    expect(childNamed(items[1]!, "size")?.text).toBe("34");
  });

  it("keeps a namespaced name intact, because that is how Newznab carries its attributes", () => {
    const root = parseXml(
      `<item><newznab:attr name="size" value="99"/><newznab:attr name="grabs" value="7"/></item>`,
    );
    const attrs = childrenNamed(root, "newznab:attr");
    expect(
      attrs.map((a) => [a.attributes.get("name"), a.attributes.get("value")]),
    ).toEqual([
      ["size", "99"],
      ["grabs", "7"],
    ]);
  });

  it("reads CDATA verbatim and resolves the entities it does know", () => {
    const root = parseXml(
      `<r><a><![CDATA[Some & <raw> text]]></a><b>Ampersand &amp; caret &#94; hex &#x41;</b></r>`,
    );
    expect(childNamed(root, "a")?.text).toBe("Some & <raw> text");
    expect(childNamed(root, "b")?.text).toBe("Ampersand & caret ^ hex A");
  });

  it("leaves an entity it does not know exactly as written", () => {
    // Substituting a guess would be worse than leaving it visible.
    expect(childNamed(parseXml("<r><a>&mystery;</a></r>"), "a")?.text).toBe(
      "&mystery;",
    );
  });

  it("ignores comments and the XML declaration", () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?><!-- note --><r><a>1</a><!-- x --></r>`,
    );
    expect(childNamed(root, "a")?.text).toBe("1");
  });

  it("handles self-closing elements without losing the following sibling", () => {
    const root = parseXml(`<r><a/><b>2</b></r>`);
    expect(root.children.map((c) => c.name)).toEqual(["a", "b"]);
    expect(childNamed(root, "b")?.text).toBe("2");
  });

  it("accepts single-quoted attribute values", () => {
    expect(parseXml(`<r a='1' b="2"/>`).attributes.get("a")).toBe("1");
  });

  describe("what it refuses", () => {
    it("refuses a document type declaration outright", () => {
      /*
       * The billion-laughs and external-entity families both need a DTD. This
       * is why the reader exists rather than a configuration flag on a general
       * parser: refusing is the default and cannot be switched off.
       */
      const bomb =
        `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>` +
        `<lolz>&lol2;</lolz>`;
      expect(() => parseXml(bomb)).toThrow(XmlError);
      expect(() =>
        parseXml(`<!DOCTYPE r SYSTEM "http://example.invalid/x.dtd"><r/>`),
      ).toThrow(/Document type declarations/);
    });

    it.each([
      ["mismatched tags", "<a><b></a></b>"],
      ["an unclosed element", "<a><b>text</b>"],
      ["an unterminated comment", "<a><!-- forever</a>"],
      ["an unterminated CDATA section", "<a><![CDATA[forever</a>"],
      ["an unquoted attribute value", "<a x=1/>"],
      ["an attribute without a value", "<a x/>"],
      ["two root elements", "<a/><b/>"],
      ["nothing at all", ""],
      ["text outside the root", "loose text<a/>"],
    ])("refuses %s", (_label, source) => {
      expect(() => parseXml(source)).toThrow(XmlError);
    });

    it("refuses input past its size, depth and element limits", () => {
      expect(() => parseXml("<r/>", { maxBytes: 2 })).toThrow(/larger than/);
      expect(() =>
        parseXml("<a><b><c><d/></c></b></a>", { maxDepth: 2 }),
      ).toThrow(/nested too deeply/);
      expect(() =>
        parseXml(`<r>${"<a/>".repeat(20)}</r>`, { maxElements: 5 }),
      ).toThrow(/too many elements/);
    });

    it("keeps the first of a duplicated attribute rather than the last", () => {
      expect(parseXml(`<a x="first" x="second"/>`).attributes.get("x")).toBe(
        "first",
      );
    });

    it("does not let a crafted name reach Object.prototype", () => {
      const root = parseXml(`<r><__proto__ polluted="yes">x</__proto__></r>`);
      expect(childNamed(root, "__proto__")?.text).toBe("x");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty("polluted");
    });
  });
});
