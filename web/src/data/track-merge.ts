/**
 * Aircraft trails over `aircraft:update` deltas. The core sends the full `trackHistory` with
 * GET /api/aircraft, `aircraft:new` and an occasional resync, and otherwise only `trackAppend`: the
 * points added since its previous update (both most recent first). Wherever updates are coalesced
 * (the events worker, FleetStore's pending map) or applied over a known aircraft, the older trail
 * is merged in so no delta is lost. No Zod or store imports: the events worker uses it too.
 */

export interface TrailPointLike {
	readonly timestamp: number
}

export interface TrailFields<P extends TrailPointLike> {
	trackHistory?: P[] | undefined
	trackAppend?: P[] | undefined
}

/** Points kept per trail: the core tracker's default `maxTrackPoints`. */
export const TRAIL_MAX_POINTS = 100

/** `newer` points past `older`'s newest, then `older`; both most recent first; at most TRAIL_MAX_POINTS. */
export function mergeTrackPoints<P extends TrailPointLike>(
	newer: readonly P[],
	older: readonly P[],
): P[] {
	const newest = older[0]?.timestamp ?? Number.NEGATIVE_INFINITY
	const ahead = newer.filter(p => p.timestamp > newest)
	const merged = ahead.length > 0 ? [...ahead, ...older] : [...older]
	if (merged.length > TRAIL_MAX_POINTS) merged.length = TRAIL_MAX_POINTS
	return merged
}

/**
 * `next` applied over `previous` (an older message or the known state of the same aircraft):
 * - `next` has the full trail: it wins; points of `previous` newer than it (a delta that overtook a
 *   snapshot) are kept on top;
 * - `next` has a delta or no trail: appended to `previous`'s full trail (the result has
 *   `trackHistory`), or to `previous`'s delta (the result keeps `trackAppend`), or kept as is.
 * Returns `next` itself when there is nothing to merge.
 */
export function mergeTrail<P extends TrailPointLike, T extends TrailFields<P>>(
	previous: TrailFields<P> | undefined,
	next: T,
): T {
	const before = previous?.trackHistory ?? previous?.trackAppend
	if (next.trackHistory) {
		if (!before || before.length === 0) {
			if (next.trackAppend === undefined) return next
			const { trackAppend: _drop, ...rest } = next
			return rest as T
		}
		const { trackAppend: _drop, ...rest } = next
		return {
			...rest,
			trackHistory: mergeTrackPoints(before, next.trackHistory),
		} as T
	}
	if (!before) return next
	const { trackAppend, ...rest } = next
	const merged = mergeTrackPoints(trackAppend ?? [], before)
	return (
		previous?.trackHistory
			? { ...rest, trackHistory: merged }
			: { ...rest, trackAppend: merged }
	) as T
}
