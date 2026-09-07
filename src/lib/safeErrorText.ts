/**
 * An error message that may be shown to a browser.
 *
 * Two places need this and both promise it: the dependency gate, whose last
 * error is rendered in the processing panel, and the startup record, whose
 * phase errors are served by the public health endpoint. They had a copy each,
 * with a note in one saying it matched the other. They did not match for long,
 * and worse, both were wrong in the same way — the path pattern required the
 * path to begin the string or follow a space, and Node quotes its paths:
 *
 *   ENOENT: no such file or directory, stat '/Volumes/Expansion/media'
 *
 * went out with the media root intact. One implementation, and it is this one.
 */

/*
 * Removed before paths, because a connection URL contains slashes and a
 * path-shaped match inside one would leave the host and credentials behind.
 */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;

/*
 * A path is anything slash-led that starts the string or follows a separator —
 * whitespace, a quote, a bracket, or the punctuation Node puts in front of one.
 * The separator is kept and the path is not, so `stat '/Volumes/x'` becomes
 * `stat ''`: still legible as a failed `stat`, with nothing left to identify
 * the volume.
 */
const PATH_LIKE = /(^|[\s'"`([<=,;:])((?:[A-Za-z]:)?[\\/][^\s'"`)\]>,;]*)/g;

const MAX_LENGTH = 240;

export function describeErrorSafely(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw
      .split("\n", 1)[0]
      ?.replace(URL_LIKE, " ")
      .replace(PATH_LIKE, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, MAX_LENGTH) || fallback
  );
}
