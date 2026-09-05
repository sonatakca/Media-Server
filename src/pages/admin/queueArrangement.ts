/**
 * Rearranging the waiting queue in one press, rather than one drag at a time.
 *
 * A backlog is queued the way it was found — a season here, a film there, an
 * episode somebody asked for twice — and the order it comes out in is the
 * order it will be watched in. Dragging forty rows into that order by hand is
 * not a thing anybody does, so the arrangements people actually want are
 * written here as functions of the list.
 *
 * All of them take the waiting order and return a new one. None of them look
 * at the running or the paused rows: those hold no position in the queue, and
 * a rearrangement that claimed to move them would be describing a queue the
 * server does not have.
 */

/** What the queue knows about a job, for the purpose of ordering it. */
export interface QueueTitleFacts {
  /** The show an episode belongs to. Absent for a film. */
  seriesTitle?: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** `S01E01`, when the server is older than the two numbers above. */
  code?: string;
}

/** Where an episode sits in its show, as far as anything here can tell. */
type Place = { season: number | null; episode: number | null };

const CODE = /^s(\d+)(?:e(\d+))?$/i;

/**
 * The season and episode, preferring what the server said outright.
 *
 * The code is parsed only as a fallback. It is a label — a server that starts
 * writing `1x02`, or a special with no episode number at all, would quietly
 * change what this function means — whereas the two numbers are the catalogue's
 * own answer. Reading both is what lets the button work against a server that
 * predates them instead of arranging every show alphabetically by accident.
 */
export function placeOf(facts: QueueTitleFacts | undefined): Place {
  if (!facts) return { season: null, episode: null };
  const parsed = CODE.exec(facts.code ?? "");
  const season =
    typeof facts.seasonNumber === "number"
      ? facts.seasonNumber
      : parsed
        ? Number(parsed[1])
        : null;
  const episode =
    typeof facts.episodeNumber === "number"
      ? facts.episodeNumber
      : parsed?.[2] !== undefined
        ? Number(parsed[2])
        : null;
  return {
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null,
  };
}

/**
 * Groups the waiting jobs by show, in the order the shows already stand in.
 *
 * The rule is the operator's own: whichever show is highest in the queue keeps
 * that place and collects the rest of its episodes underneath it, in the order
 * they are meant to be watched. So a queue reading
 *
 *     Arcane S01E01 · House S01E05 · Arcane S01E03 · Arcane S01E02 · House S01E04
 *
 * becomes
 *
 *     Arcane S01E01 · Arcane S01E02 · Arcane S01E03 · House S01E04 · House S01E05
 *
 * Arcane stays in front because it was in front, not because of its name — a
 * pass that sorted by title would quietly reorder the operator's priorities as
 * well as their episodes.
 *
 * A film is a group of one, so it keeps its place among the shows rather than
 * being swept to either end. An episode whose season or episode number nobody
 * knows sorts after the ones that are known, in the order it was already in:
 * unknown is not zero, and pretending otherwise puts specials in front of the
 * pilot.
 */
export function arrangeByShowAndEpisode(
  ids: readonly string[],
  facts: (id: string) => QueueTitleFacts | undefined,
): string[] {
  const groups = new Map<string, { at: number; members: string[] }>();
  ids.forEach((id, index) => {
    const series = facts(id)?.seriesTitle?.trim();
    // A film is keyed by its own row, so two films never merge and neither of
    // them ever moves past a show that was queued before it.
    const key = series ? `show:${series.toLowerCase()}` : `job:${id}`;
    const group = groups.get(key);
    if (group) group.members.push(id);
    else groups.set(key, { at: index, members: [id] });
  });

  const position = new Map(ids.map((id, index) => [id, index]));
  const ordered: string[] = [];
  for (const group of [...groups.values()].sort(
    (left, right) => left.at - right.at,
  )) {
    const sorted = [...group.members].sort((left, right) => {
      const leftPlace = placeOf(facts(left));
      const rightPlace = placeOf(facts(right));
      const bySeason = compareNullsLast(leftPlace.season, rightPlace.season);
      if (bySeason !== 0) return bySeason;
      const byEpisode = compareNullsLast(leftPlace.episode, rightPlace.episode);
      if (byEpisode !== 0) return byEpisode;
      // Everything else equal, the queue's own order is the answer. Array.sort
      // is stable, but saying it here keeps that from being load-bearing.
      return position.get(left)! - position.get(right)!;
    });
    ordered.push(...sorted);
  }
  return ordered;
}

function compareNullsLast(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

/**
 * The selected rows lifted to the front of the queue, in the order they are in.
 *
 * Their order among themselves is left alone on purpose: the operator has
 * either arranged it already or is about to, and a promotion that also
 * reshuffled would be two decisions taken on one press.
 */
export function moveToFront(
  ids: readonly string[],
  selection: Iterable<string>,
): string[] {
  const chosen = new Set(selection);
  const moved = ids.filter((id) => chosen.has(id));
  return [...moved, ...ids.filter((id) => !chosen.has(id))];
}

/** The selected rows dropped to the back of the queue, in the order they are in. */
export function moveToBack(
  ids: readonly string[],
  selection: Iterable<string>,
): string[] {
  const chosen = new Set(selection);
  const moved = ids.filter((id) => chosen.has(id));
  return [...ids.filter((id) => !chosen.has(id)), ...moved];
}

/**
 * The rows of `selection` gathered into one block, dropped at `index`.
 *
 * `index` counts in the list the block has been lifted out of, which is how a
 * pointer names a place: between two rows that are still on screen. Out of
 * range is clamped rather than refused, so a drop past the last row means the
 * end of the queue.
 */
export function moveBlock(
  ids: readonly string[],
  selection: Iterable<string>,
  index: number,
): string[] {
  const chosen = new Set(selection);
  const moved = ids.filter((id) => chosen.has(id));
  if (moved.length === 0) return [...ids];
  const rest = ids.filter((id) => !chosen.has(id));
  const at = Math.min(Math.max(index, 0), rest.length);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}
