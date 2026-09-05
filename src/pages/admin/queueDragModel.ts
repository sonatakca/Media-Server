/**
 * The geometry behind dragging a job up or down the queue.
 *
 * Kept pure, and kept away from React, because the part that decides *where a
 * card would land* is the part that has to be right at every pixel of the
 * gesture: the list under the cursor is only honest if the slot it opens is
 * the slot the drop will use. The component measures, this decides, and the
 * two never disagree.
 */

/** One sortable row, as measured before the gesture began. */
export type SortableRect = {
  id: string;
  /** Page coordinates, so a scroll during the drag does not move the model. */
  top: number;
  height: number;
};

export type QueueDragPlan = {
  /** The order the queue would be in if the pointer were released now. */
  order: string[];
  /** Where the dragged block sits in the list it was lifted out of. */
  index: number;
  /**
   * How far each *other* row has to move to make room, in pixels. Rows that
   * do not move are absent rather than present as zero, so a render can tell
   * "unchanged" from "returned to where it started".
   */
  shifts: Map<string, number>;
  /** Where the dragged block's own slot is, relative to where it started. */
  activeSlotOffset: number;
  /**
   * Where each dragged row is drawn, relative to the block's own offset.
   *
   * A block of one is a single zero: the row is the block. A block of several
   * is what turns a scattered selection into something that can be carried —
   * every member is drawn stacked under the row the pointer is holding, so the
   * gap the list opens is the size of what is about to go into it, and the
   * rows in between are not left standing inside their own selection.
   */
  memberAnchors: Map<string, number>;
  /**
   * How far the card should actually be drawn from where it started.
   *
   * The pointer's own travel, held inside the list: a card dragged well past
   * the last row has nowhere further to go, and letting it sail off down the
   * page would say the queue has positions that it does not have.
   */
  boundedOffset: number;
  /**
   * Where the card is actually drawn: its slot, give or take the pointer.
   *
   * Drawing it at `boundedOffset` instead is what made the old gesture read as
   * a card floating over the page. The list would open the right gap and the
   * card would hang somewhere else entirely — below its own slot, across the
   * statistics of the row beneath — so the operator had to guess which of the
   * two places the drop meant. Here the card is held in the gap that opened
   * for it, and the pointer moves it only far enough to feel connected.
   *
   * It changes by a whole row when `index` does, which is why the caller has
   * to draw it with a transition: this is the position the card settles into,
   * not the position it should appear at instantly.
   */
  magneticOffset: number;
};

/**
 * How far the card is allowed to sit from the slot it would drop into.
 *
 * The whole of the magnet, in one number. Anything larger and the card starts
 * covering the row it is passing — these cards are the width of the page and
 * carry three rows of statistics, so a card drawn half over its neighbour is
 * two sets of numbers on top of each other and neither of them readable. This
 * is about the depth of a card's own top padding: enough for the card to
 * answer the hand holding it, not enough to cover anything.
 */
export const MAGNET_GIVE = 16;

/**
 * The pointer's pull on the card, held to `MAGNET_GIVE` without a hard edge.
 *
 * `tanh` is one-to-one for small movements and flattens as it approaches the
 * limit, so a card nudged inside its slot tracks the pointer honestly and a
 * card dragged well past it eases to a stop instead of hitting a wall. A plain
 * clamp would follow the pointer and then freeze dead, which reads as the drag
 * having broken rather than as the slot holding on.
 */
function magnetise(deviation: number): number {
  return MAGNET_GIVE * Math.tanh(deviation / MAGNET_GIVE);
}

/**
 * The vertical space between two rows, read from the rows themselves.
 *
 * Taking it from the gap between the first pair rather than from a constant
 * means the model keeps agreeing with the stylesheet after somebody changes
 * the list's spacing. A single-row list has no gap to read and needs none.
 */
export function measureGap(rects: readonly SortableRect[]): number {
  if (rects.length < 2) return 0;
  const gap = rects[1]!.top - (rects[0]!.top + rects[0]!.height);
  return Number.isFinite(gap) && gap > 0 ? gap : 0;
}

/**
 * Where the dragged row would land, and what everything else does about it.
 *
 * The candidate slots are built from the *other* rows in their unchanged
 * order, so the answer depends only on how far the pointer has travelled —
 * never on the answer the previous pointer event gave. That is what keeps a
 * card resting near a boundary from flickering between two positions: there
 * is no feedback loop to oscillate in, and the switch between slot k and slot
 * k+1 happens exactly at the midpoint between their two centres.
 *
 * Heights are read per row, so a tall episode card moving between short ones
 * opens a tall gap and a short one opens a short gap.
 */
export function planQueueDrag(
  rects: readonly SortableRect[],
  active: string | readonly string[],
  offsetY: number,
  anchorId?: string,
): QueueDragPlan | null {
  const requested = typeof active === "string" ? [active] : active;
  const chosen = new Set(requested);
  // In list order, whatever order they were chosen in: a block carries the
  // arrangement the queue already has, not the order somebody ticked boxes.
  const members = rects.filter((rect) => chosen.has(rect.id));
  if (members.length === 0) return null;
  const anchor =
    members.find((rect) => rect.id === (anchorId ?? requested[0])) ??
    members[0]!;

  const activeIndex = rects.indexOf(members[0]!);
  const others = rects.filter((rect) => !chosen.has(rect.id));
  const gap = measureGap(rects);
  const listTop = rects[0]!.top;

  /*
   * The block, as one row: its members stacked in list order with the list's
   * own spacing between them, and its top placed so that the row the pointer
   * is holding does not move when the gesture begins. Anchoring on the held
   * row rather than on the first member is what keeps the card under the
   * cursor still under the cursor when a selection is picked up by its last
   * member.
   */
  const memberAnchors = new Map<string, number>();
  let within = 0;
  let anchorWithin = 0;
  for (const member of members) {
    if (member.id === anchor.id) anchorWithin = within;
    memberAnchors.set(member.id, within);
    within += member.height + gap;
  }
  const blockHeight = Math.max(within - gap, 0);
  const blockTop = anchor.top - anchorWithin;
  for (const member of members) {
    // Restated as a displacement from where the row actually is, which is what
    // the caller draws with.
    memberAnchors.set(
      member.id,
      blockTop + memberAnchors.get(member.id)! - member.top,
    );
  }

  /*
   * The top edge of the dragged row's slot for every index it could take.
   * Increasing in the index, which is what makes the choice below a monotone
   * function of the pointer rather than a search that can double back.
   */
  const slotTops: number[] = [];
  let cursor = listTop;
  for (let index = 0; index <= others.length; index += 1) {
    slotTops.push(cursor);
    const next = others[index];
    if (next) cursor += next.height + gap;
  }

  const draggedCentre = blockTop + offsetY + blockHeight / 2;
  let index = activeIndex;
  let best = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < slotTops.length; candidate += 1) {
    const distance = Math.abs(
      draggedCentre - (slotTops[candidate]! + blockHeight / 2),
    );
    /*
     * Ties go to the slot the row is already in. Two slots are exactly equally
     * close only when the pointer sits on a boundary, and that is precisely
     * where a row must be made to stay put rather than to choose.
     */
    if (
      distance < best - 0.5 ||
      (Math.abs(distance - best) <= 0.5 &&
        Math.abs(candidate - activeIndex) < Math.abs(index - activeIndex))
    ) {
      best = Math.min(best, distance);
      index = candidate;
    }
  }

  const order = others.map((rect) => rect.id);
  order.splice(index, 0, ...members.map((rect) => rect.id));

  /*
   * Where every row ends up under that order, and therefore how far it has to
   * travel from where it was measured. Rows before the disturbed stretch come
   * out at zero and are left out of the map.
   */
  const shifts = new Map<string, number>();
  const byId = new Map(rects.map((rect) => [rect.id, rect]));
  let top = listTop;
  let activeSlotOffset = 0;
  for (const id of order) {
    const rect = byId.get(id)!;
    const shift = top - rect.top;
    // The block's members are not shifted individually: they are drawn from
    // the block's own offset, and the first of them is where the block is.
    if (chosen.has(id)) {
      if (id === members[0]!.id) activeSlotOffset = top - blockTop;
    } else if (shift !== 0) {
      shifts.set(id, shift);
    }
    top += rect.height + gap;
  }

  const firstSlot = slotTops[0]! - blockTop;
  const lastSlot = slotTops[slotTops.length - 1]! - blockTop;
  const boundedOffset = Math.min(Math.max(offsetY, firstSlot), lastSlot);

  return {
    order,
    index,
    shifts,
    activeSlotOffset,
    memberAnchors,
    boundedOffset,
    magneticOffset:
      activeSlotOffset + magnetise(boundedOffset - activeSlotOffset),
  };
}

/**
 * How fast the page should scroll while a card is held against an edge.
 *
 * Zero everywhere but the last few dozen pixels, and proportional inside them,
 * so approaching the edge speeds up smoothly instead of the list bolting the
 * moment the cursor crosses a line.
 */
export function edgeScrollVelocity(
  pointerY: number,
  viewportHeight: number,
  zone = 96,
  maxPixelsPerFrame = 14,
): number {
  if (viewportHeight <= zone * 2) return 0;
  if (pointerY < zone) {
    return -Math.round(maxPixelsPerFrame * ((zone - pointerY) / zone));
  }
  const fromBottom = viewportHeight - pointerY;
  if (fromBottom < zone) {
    return Math.round(maxPixelsPerFrame * ((zone - fromBottom) / zone));
  }
  return 0;
}
