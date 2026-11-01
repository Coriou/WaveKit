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

/**
 * Two points are the same when every field is equal. The core tracker only adds a point that moved
 * at least `minTrackDistance` (50 m) from the previous one, so neighbouring points always differ in
 * position, whereas timestamps do not order them: several points can share a millisecond
 * (Date.now()) and the clock can step back.
 */
export function samePoint(a: TrailPointLike, b: TrailPointLike): boolean {
	if (a === b) return true
	const ka = Object.keys(a)
	if (ka.length !== Object.keys(b).length) return false
	return ka.every(k =>
		Object.is(
			(a as unknown as Record<string, unknown>)[k],
			(b as unknown as Record<string, unknown>)[k],
		),
	)
}

/**
 * `newer` points past `older`'s newest, then `older`; both most recent first; at most TRAIL_MAX_POINTS.
 * The overlap is found by content, never by timestamp: when `newer` contains `older`'s newest point
 * only the points above it are new; when `older` contains `newer`'s newest point `newer` is stale
 * (already in `older`); otherwise the two are disjoint and all of `newer` goes on top (a delta).
 */
export function mergeTrackPoints<P extends TrailPointLike>(
	newer: readonly P[],
	older: readonly P[],
): P[] {
	const top = older[0]
	let ahead: readonly P[] = newer
	if (top !== undefined && newer.length > 0) {
		const at = newer.findIndex(p => samePoint(p, top))
		if (at >= 0) ahead = newer.slice(0, at)
		else {
			const first = newer[0]
			if (first !== undefined && older.some(p => samePoint(p, first)))
				ahead = []
		}
	}
	const merged = ahead.length > 0 ? [...ahead, ...older] : [...older]
	if (merged.length > TRAIL_MAX_POINTS) merged.length = TRAIL_MAX_POINTS
	return merged
}

/**
 * A full trail (`snapshot`, from GET /api/aircraft, `aircraft:new` or a resync) over the trail held
 * (`held`): the snapshot is authoritative and replaces it. The only points of `held` kept are those
 * provably newer than the snapshot: `held` contains the snapshot's newest point (by content) and has
 * points above it, which arrived ahead of the snapshot (deltas applied before an older GET answer).
 * A disjoint snapshot replaces the trail whole and an empty one clears it.
 */
export function replaceTrackPoints<P extends TrailPointLike>(
	held: readonly P[],
	snapshot: readonly P[],
): P[] {
	const top = snapshot[0]
	const at = top === undefined ? -1 : held.findIndex(p => samePoint(p, top))
	const merged = at > 0 ? [...held.slice(0, at), ...snapshot] : [...snapshot]
	if (merged.length > TRAIL_MAX_POINTS) merged.length = TRAIL_MAX_POINTS
	return merged
}

/**
 * `next` applied over `previous` (an older message or the known state of the same aircraft):
 * - `next` has the full trail: it replaces `previous`'s, except points of `previous` provably newer
 *   than it (a delta that overtook a snapshot), which stay on top (replaceTrackPoints);
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
			trackHistory: replaceTrackPoints(before, next.trackHistory),
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
