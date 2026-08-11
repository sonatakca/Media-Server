/**
 * Monotonic sequence for playback progress writes.
 *
 * The server keeps the highest sequence it has ever stored for an item and
 * rejects anything at or below it, so a delayed retry from a backgrounded tab
 * cannot rewind a position the viewer has since passed.
 *
 * That means the sequence has to be monotonic across page loads, not merely
 * within one. A counter starting at zero was not: after the first viewing every
 * write arrived below the stored value and was rejected as stale, so progress
 * silently stopped being saved for anything already watched once.
 *
 * Seeding from the wall clock fixes that. Stepping past `now` rather than to it
 * keeps successive writes in the same millisecond strictly increasing, and
 * survives a clock that jumps backwards.
 */
let sequence = Date.now();

export function nextProgressSequence(): number {
  sequence = Math.max(sequence + 1, Date.now());
  return sequence;
}
