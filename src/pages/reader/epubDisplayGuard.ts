import { Contents, EpubCFI, type Rendition } from "epubjs";

type Position = { left: number; top: number };
type CfiParts = {
  range: boolean;
  path: { steps: unknown[] };
  start: { steps: unknown[] } | null;
  findNode: (steps: unknown[], doc: Document) => Node | null | undefined;
};

/**
 * The CFIs the reader saves count the soft hyphens Turkish text is given once
 * a section has loaded, and epub.js resolves a CFI the moment a section's
 * frame exists, before they are in. Its offset then overruns the bare text,
 * epub.js's own recovery hands Range an element with no such child, and the
 * throw lands inside a promise chain that never settles: that display, and
 * every one queued behind it, waits forever.
 *
 * A CFI that cannot be resolved exactly here stands instead for the nearest
 * element on its path that can, which is the paragraph it points into.
 */
export function locateNearest(document: Document, target: string): Position {
  try {
    const cfi = new EpubCFI(target) as unknown as CfiParts;
    const steps = cfi.range
      ? cfi.path.steps.concat(cfi.start?.steps ?? [])
      : cfi.path.steps;

    for (let length = steps.length; length > 0; length -= 1) {
      const node = cfi.findNode(steps.slice(0, length), document);
      const element =
        node?.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : (node?.parentElement ?? null);

      if (element) {
        const { left, top } = element.getBoundingClientRect();
        return { left, top };
      }
    }
  } catch {
    // Not a CFI this section can read at all: its start, then.
  }

  return { left: 0, top: 0 };
}

let installed = false;

/** Makes epub.js place an unresolvable CFI near its paragraph, never throw. */
export function guardCfiLocation(): void {
  if (installed) {
    return;
  }

  installed = true;
  const prototype = Contents.prototype as unknown as {
    document?: Document;
    locationOf: (target: unknown, ignoreClass?: string) => Position;
  };
  const locationOf = prototype.locationOf;

  prototype.locationOf = function (target, ignoreClass) {
    try {
      return locationOf.call(this, target, ignoreClass);
    } catch {
      return this.document && typeof target === "string"
        ? locateNearest(this.document, target)
        : { left: 0, top: 0 };
    }
  };
}

/**
 * epub.js reports a display that failed (a section that would not load, say)
 * as an event, and leaves the promise `display()` returned pending. That
 * promise is also what its queue waits on, so nothing could display again.
 * Rejected here, the caller learns of it and the queue moves on.
 */
export function settleFailedDisplays(rendition: Rendition): () => void {
  const reject = (error: unknown) => {
    const pending = (
      rendition as unknown as {
        displaying?: { reject: (reason: unknown) => void };
      }
    ).displaying;
    pending?.reject(error ?? new Error("The section could not be displayed"));
  };

  rendition.on("displayerror", reject);
  return () => rendition.off("displayerror", reject);
}
