/**
 * Reading HLS playlists for what a download has to fetch.
 *
 * Only the resources are wanted, not their byte ranges: a package may address
 * one file in ranges, and a stored copy of the whole file answers every range
 * of it.
 */

const URI_ATTRIBUTE = /URI="([^"]+)"/;

function resolve(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}

/** Every resource a playlist names, absolute, in order, each once. */
export function playlistReferences(text: string, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (
        line.startsWith("#EXT-X-MEDIA:") ||
        line.startsWith("#EXT-X-MAP:") ||
        line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")
      ) {
        const match = URI_ATTRIBUTE.exec(line);
        if (match?.[1]) found.add(resolve(match[1], baseUrl));
      }
      continue;
    }
    found.add(resolve(line, baseUrl));
  }
  return [...found];
}

/** Whether a playlist is a multivariant (master) playlist. */
export function isMultivariantPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

/**
 * The master playlist a download keeps: every audio and subtitle rendition,
 * so a stored copy offers the same tracks as streaming. I-frame playlists are
 * dropped: they only serve trick play, which a stored copy answers from its
 * stored seek thumbnails instead.
 */
export function withoutIFramePlaylists(master: string): string {
  return master
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#EXT-X-I-FRAME-STREAM-INF:"))
    .join("\n");
}
