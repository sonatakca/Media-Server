/**
 * Where a title's own folder is, as the filesystem spells it.
 *
 * A `source_key` is normalised to lower case so a rescan matches the same title
 * however the case is typed. That makes it a poor path: comparing
 * `movies/dune (2021)` against the real `Movies/Dune (2021)/…` fails for every
 * title with a capital letter in it, and deriving a directory from it would
 * write `movies/dune (2021)/content/` beside the real folder rather than into
 * it. The cased spelling has to come from a path the scanner actually recorded.
 */

/**
 * The leading segments of `relativePath` that correspond to `sourceRoot`.
 *
 * Returns undefined when the path does not sit under that root, so a mismatched
 * pair yields no title root rather than a plausible-looking wrong one.
 */
export function casedTitleRoot(
  sourceRoot: string | undefined,
  relativePath: string | null | undefined,
): string | undefined {
  if (!sourceRoot || !relativePath) return undefined;

  const rootSegments = sourceRoot.split("/").filter(Boolean);
  const pathSegments = relativePath.split("/").filter(Boolean);
  if (rootSegments.length === 0) return undefined;
  // The path must reach past the root: a title root with no file beneath it is
  // not a title root, it is the file itself.
  if (pathSegments.length <= rootSegments.length) return undefined;

  for (const [index, segment] of rootSegments.entries()) {
    if (pathSegments[index]?.toLowerCase() !== segment.toLowerCase()) {
      return undefined;
    }
  }

  return pathSegments.slice(0, rootSegments.length).join("/");
}

/** The part of a `source_key` after its `kind:` prefix. */
export function sourceRootOf(
  kind: string,
  sourceKey: string,
): string | undefined {
  const prefix = `${kind}:`;
  if (!sourceKey.startsWith(prefix)) return undefined;
  return sourceKey.slice(prefix.length) || undefined;
}

/**
 * A title's folder, from whichever recorded path is available.
 *
 * A movie owns its primary file directly. A series owns none — its episodes do
 * — so it falls back to any descendant's path, which sits deeper but still
 * begins with the same folder.
 */
export function resolveTitleRoot({
  kind,
  sourceKey,
  primaryRelativePath,
  descendantRelativePath,
}: {
  kind: string;
  sourceKey: string;
  primaryRelativePath?: string | null;
  descendantRelativePath?: string | null;
}): string | undefined {
  const sourceRoot = sourceRootOf(kind, sourceKey);
  return (
    casedTitleRoot(sourceRoot, primaryRelativePath) ??
    casedTitleRoot(sourceRoot, descendantRelativePath)
  );
}
