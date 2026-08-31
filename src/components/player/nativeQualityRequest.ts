/**
 * Deciding whether a native-HLS re-plan is worth starting.
 *
 * Safari exposes no level controller, so changing quality means asking the
 * server for a differently-shaped master and attaching it. That is slow and
 * asynchronous, and the URL the player reads back only changes once the new
 * source has attached — which makes "is this already applied?" the wrong
 * question on its own. For the whole of that window the answer is no, so
 * anything that asks again inside it starts a *second* re-plan on top of the
 * first. Selecting a rung does exactly that: it sets the locked rendition id,
 * which re-runs the effect that reapplies the saved preference. Each re-plan
 * replaced the source again, so none of them finished attaching and the
 * picture stayed black at a stopped clock.
 *
 * So the question is asked in two parts: what is attached, and what has
 * already been asked for and not yet arrived.
 */

export interface NativeQualityRequest {
  qualityHeight?: number | null;
  maxHeight?: number | null;
}

/** A comparable form of one request, so two can be judged equal. */
export function nativeQualityRequestKey(
  request: NativeQualityRequest,
): string {
  return `${request.qualityHeight ?? "-"}:${request.maxHeight ?? "-"}`;
}

export type NativeReplanDecision = "attached" | "in-flight" | "start";

/**
 * Whether to begin a re-plan for `desired`.
 *
 * `attached` — the player already carries it, so there is nothing to do and no
 * request outstanding. `in-flight` — this exact request was already made and
 * has not arrived yet. `start` — genuinely new work.
 */
export function decideNativeReplan(
  desired: NativeQualityRequest,
  attached: NativeQualityRequest,
  pendingKey: string | null,
): NativeReplanDecision {
  const desiredKey = nativeQualityRequestKey(desired);
  if (desiredKey === nativeQualityRequestKey(attached)) return "attached";
  if (pendingKey === desiredKey) return "in-flight";
  return "start";
}
