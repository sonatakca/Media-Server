/**
 * A deliberately small XML reader for indexer responses.
 *
 * Written rather than taken from a package for two reasons. The shape it has
 * to read is narrow — RSS with namespaced attribute elements — and the input
 * arrives over the network from a third party, so the things this refuses
 * matter more than the things it supports. There is no DTD handling, no
 * entity table beyond the five predefined names and numeric references, and
 * no external resolution, which removes entity-expansion and external-entity
 * attacks by construction rather than by configuration flag.
 *
 * The two XML parsers already present in `node_modules` are transitive
 * dependencies of jsdom, which is a dev dependency: they are absent from a
 * production install and may vanish on any lockfile change.
 */

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text, with CDATA included and entities resolved. */
  readonly text: string;
}

export interface ParseXmlLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxElements?: number;
}

const DEFAULT_LIMITS: Required<ParseXmlLimits> = {
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxElements: 200_000,
};

const PREDEFINED = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["apos", "'"],
  ["quot", '"'],
]);

/**
 * Resolves the five predefined entities and numeric character references.
 *
 * Anything else is left as written. A named entity Seyirlik does not know is
 * a document that declared it in a DTD, and a DTD is exactly what this reader
 * refuses to process, so inventing a value for it would be a guess.
 */
function decodeEntities(raw: string): string {
  return raw.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return PREDEFINED.get(body) ?? match;
    },
  );
}

interface MutableElement {
  name: string;
  attributes: Map<string, string>;
  children: MutableElement[];
  text: string;
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;

export function parseXml(
  source: string,
  limits: ParseXmlLimits = {},
): XmlElement {
  const { maxBytes, maxDepth, maxElements } = { ...DEFAULT_LIMITS, ...limits };
  if (source.length > maxBytes) {
    throw new XmlError("The response is larger than this reader accepts.");
  }

  let at = 0;
  let elements = 0;
  const stack: MutableElement[] = [];
  let root: MutableElement | undefined;

  const readName = (): string => {
    NAME.lastIndex = at;
    const match = NAME.exec(source);
    if (!match) throw new XmlError("Expected a name.");
    at = NAME.lastIndex;
    return match[0];
  };

  const skipSpace = (): void => {
    while (at < source.length && /\s/.test(source[at]!)) at += 1;
  };

  while (at < source.length) {
    const open = source.indexOf("<", at);
    if (open === -1) break;

    if (open > at) {
      const chunk = source.slice(at, open);
      const current = stack[stack.length - 1];
      if (current) current.text += decodeEntities(chunk);
      else if (chunk.trim())
        throw new XmlError("Text outside the root element.");
    }
    at = open;

    if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      if (end === -1) throw new XmlError("An unterminated comment.");
      at = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", at)) {
      const end = source.indexOf("]]>", at + 9);
      if (end === -1) throw new XmlError("An unterminated CDATA section.");
      const current = stack[stack.length - 1];
      if (current) current.text += source.slice(at + 9, end);
      at = end + 3;
      continue;
    }
    if (source.startsWith("<?", at)) {
      const end = source.indexOf("?>", at + 2);
      if (end === -1)
        throw new XmlError("An unterminated processing instruction.");
      at = end + 2;
      continue;
    }
    if (
      source.startsWith("<!DOCTYPE", at) ||
      source.startsWith("<!ENTITY", at)
    ) {
      // Refused outright rather than skipped: a document that needs a DTD to
      // be understood is one this reader must not pretend to have read.
      throw new XmlError("Document type declarations are not accepted.");
    }
    if (source.startsWith("</", at)) {
      at += 2;
      const name = readName();
      skipSpace();
      if (source[at] !== ">") throw new XmlError("A malformed closing tag.");
      at += 1;
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw new XmlError(
          "A closing tag that does not match its opening tag.",
        );
      }
      continue;
    }

    at += 1;
    const name = readName();
    elements += 1;
    if (elements > maxElements)
      throw new XmlError("The response has too many elements.");
    const element: MutableElement = {
      name,
      attributes: new Map(),
      children: [],
      text: "",
    };

    for (;;) {
      skipSpace();
      if (at >= source.length) throw new XmlError("An unterminated tag.");
      if (source.startsWith("/>", at)) {
        at += 2;
        break;
      }
      if (source[at] === ">") {
        at += 1;
        stack.push(element);
        if (stack.length > maxDepth)
          throw new XmlError("The response is nested too deeply.");
        break;
      }
      const attributeName = readName();
      skipSpace();
      if (source[at] !== "=")
        throw new XmlError("An attribute without a value.");
      at += 1;
      skipSpace();
      const quote = source[at];
      if (quote !== '"' && quote !== "'")
        throw new XmlError("An unquoted attribute value.");
      const end = source.indexOf(quote, at + 1);
      if (end === -1) throw new XmlError("An unterminated attribute value.");
      // First wins, so a duplicated attribute cannot overwrite an earlier one.
      if (!element.attributes.has(attributeName)) {
        element.attributes.set(
          attributeName,
          decodeEntities(source.slice(at + 1, end)),
        );
      }
      at = end + 1;
    }

    const parent =
      stack[stack.length - 1] === element
        ? stack[stack.length - 2]
        : stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) throw new XmlError("More than one root element.");
    else root = element;
  }

  if (stack.length > 0) throw new XmlError("An unclosed element.");
  if (!root) throw new XmlError("The response contained no XML element.");
  return root;
}

/** Direct children with this exact tag name. */
export function childrenNamed(
  element: XmlElement,
  name: string,
): readonly XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

/** The first direct child with this exact tag name, if any. */
export function childNamed(
  element: XmlElement,
  name: string,
): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}
