import {
	ABSORBER_LAGGARD_MS,
	ABSORBER_RELEASE_BYTES,
	LINK_QUALITY_SLOT_MS,
	LINK_QUALITY_WINDOW_MS,
	type BurstAbsorber,
	type BurstAbsorberDeps,
} from "./contract.js"

export const ABSORBER_RELEASE_STEP_BLOCKS = 4
// Ten laggard windows prove sustained recovery rather than one transient drain.
export const ABSORBER_RECOVERY_MS = 5_000
// A relapse in the next recovery-length interval needs no second hold.
export const ABSORBER_REINCLUSION_COOLDOWN_MS = 5_000

/**
 * Which branches held the absorber when it overflowed: a congested branch
 * holds input for every branch, so overflow during its hold is its loss.
 */
export interface OverflowGates {
	/**
	 * Overflow bytes lost while each branch (fanout id) held the absorber,
	 * totals since creation; a removed branch's total is forgotten.
	 */
	overflowGatedBy(): Readonly<Record<string, number>>
}

export const hasOverflowGates = (
	absorber: BurstAbsorber,
): absorber is BurstAbsorber & OverflowGates =>
	typeof (absorber as Partial<OverflowGates>).overflowGatedBy === "function"

export function createBurstAbsorber(
	deps: BurstAbsorberDeps,
): BurstAbsorber & OverflowGates {
	const { fanout, recorder, monoNow, frameBytes, log } = deps
	let ring: Buffer | null = null
	let head = 0
	let length = 0
	let absorbed = 0
	let overflow = 0
	let overflowChunks = 0
	let flushed = 0
	let holdingSince: number | null = null
	let episodeSince: number | null = null
	let episodeBytes = 0
	let episodeChunks = 0
	let disposed = false
	let releasing = false
	let continuation: ReturnType<typeof setImmediate> | null = null
	const active = new Set<string>()
	const congested = new Set<string>()
	const excluded = new Set<string>()
	const since = new Map<string, number>()
	const recovering = new Map<string, number>()
	const reincluded = new Map<string, number>()
	const gatedOverflow = new Map<string, number>()
	let releaseStarted = false
	const branchStates = [since, recovering, reincluded]
	let deadline: ReturnType<typeof setTimeout> | null = null
	let deadlineAt = Infinity
	const slots = LINK_QUALITY_WINDOW_MS / LINK_QUALITY_SLOT_MS
	const peaks = new Float64Array(slots)
	const absorbs = new Float64Array(slots)
	const overflows = new Float64Array(slots)
	const flushes = new Float64Array(slots)
	const durations = new Float64Array(slots)
	const excludes = new Float64Array(slots).fill(-1)
	let slot = Math.floor(monoNow() / LINK_QUALITY_SLOT_MS)
	const index = () => ((slot % slots) + slots) % slots
	function rotate(now: number): void {
		const next = Math.floor(now / LINK_QUALITY_SLOT_MS)
		if (next - slot >= slots) {
			for (const values of [peaks, absorbs, overflows, flushes, durations])
				values.fill(0)
			excludes.fill(-1)
			slot = next
		} else {
			while (slot < next) {
				slot++
				const i = index()
				peaks[i] = absorbs[i] = overflows[i] = flushes[i] = durations[i] = 0
				excludes[i] = -1
			}
		}
		if (holdingSince !== null)
			durations[index()] = Math.max(durations[index()]!, now - holdingSince)
		peaks[index()] = Math.max(peaks[index()]!, length)
	}
	function endHolding(now: number): void {
		if (holdingSince !== null) {
			durations[index()] = Math.max(durations[index()]!, now - holdingSince)
			holdingSince = null
			if (deadline !== null) clearTimeout(deadline)
			deadline = null
		}
	}
	function endOverflow(now: number): void {
		if (episodeSince === null) return
		log.info(
			{
				overflowBytes: episodeBytes,
				overflowChunks: episodeChunks,
				durationMs: now - episodeSince,
			},
			"Absorber overflow ended",
		)
		episodeSince = null
	}
	function recover(id: string, now: number): void {
		const start = recovering.get(id)
		if (
			excluded.has(id) &&
			start !== undefined &&
			now - start >= ABSORBER_RECOVERY_MS
		) {
			excluded.delete(id)
			recovering.delete(id)
			reincluded.set(id, start + ABSORBER_RECOVERY_MS)
		}
	}
	function gated(now: number): boolean {
		fanout.congestedBranchIds(congested)
		// Pass-through fast path: with no congestion and no per-branch state,
		// the full pass below prunes nothing, excludes nothing and returns
		// false, so the active-set read and the five loops are skipped.
		if (
			congested.size === 0 &&
			since.size === 0 &&
			excluded.size === 0 &&
			recovering.size === 0 &&
			reincluded.size === 0
		)
			return false
		fanout.activeBranchIds(active)
		for (const state of branchStates)
			for (const id of state.keys()) if (!active.has(id)) state.delete(id)
		for (const id of excluded) {
			if (!active.has(id)) {
				excluded.delete(id)
				continue
			}
			if (congested.has(id)) recovering.delete(id)
			else {
				const start = recovering.get(id) ?? now
				recovering.set(id, start)
				recover(id, now)
			}
		}
		for (const id of since.keys()) if (!congested.has(id)) since.delete(id)
		let blocked = false
		for (const id of congested) {
			if (!active.has(id)) continue
			const start = since.get(id) ?? now
			since.set(id, start)
			if (
				(reincluded.has(id) &&
					now - reincluded.get(id)! < ABSORBER_REINCLUSION_COOLDOWN_MS) ||
				now - start >= ABSORBER_LAGGARD_MS ||
				// The episode deadline bounds the original wait. A sibling that
				// fills during catch-up gets its own congestion deadline, never
				// the expired deadline of the consumer we just excluded.
				(!releaseStarted &&
					holdingSince !== null &&
					now - holdingSince >= ABSORBER_LAGGARD_MS)
			) {
				if (!excluded.has(id)) {
					excluded.add(id)
					excludes[index()] = Math.max(excludes[index()]!, now - start)
				}
			}
			if (!excluded.has(id)) blocked = true
		}
		return blocked
	}
	function release(now: number): void {
		if (disposed || releasing || !ring) return
		releasing = true
		try {
			// Four 64 KiB blocks = 256 KiB per synchronous step, ≈ 0.16 ms at the
			// measured ~1.6 GB/s copy and distribute, under the 2 ms loop budget.
			// One continuation per loop turn still outpaces 2.4 Msps × 4 B = 9.6 MB/s.
			let blocks = 0
			while (
				blocks < ABSORBER_RELEASE_STEP_BLOCKS &&
				length >= frameBytes &&
				!gated(now)
			) {
				releaseStarted = true
				blocks++
				const size =
					Math.floor(Math.min(length, ABSORBER_RELEASE_BYTES) / frameBytes) *
					frameBytes
				const chunk = Buffer.allocUnsafe(size)
				const first = Math.min(size, ring.length - head)
				ring.copy(chunk, 0, head, head + first)
				if (first < size) ring.copy(chunk, first, 0, size - first)
				head = (head + size) % ring.length
				length -= size
				if (length === 0) {
					endHolding(now)
					endOverflow(now)
				}
				fanout.distribute(chunk)
			}
			if (length >= frameBytes && !gated(now) && continuation === null) {
				continuation = setImmediate(() => {
					continuation = null
					if (!disposed) wake()
				})
			}
		} finally {
			releasing = false
			armDeadline(now)
		}
	}
	function armDeadline(now: number): void {
		if (holdingSince === null) return
		let at = Infinity
		for (const id of congested) {
			if (!active.has(id) || excluded.has(id)) continue
			at = Math.min(at, (since.get(id) ?? now) + ABSORBER_LAGGARD_MS)
		}
		if (!releaseStarted && Number.isFinite(at))
			at = Math.min(at, holdingSince + ABSORBER_LAGGARD_MS)
		if (deadline !== null && deadlineAt === at) return
		if (deadline !== null) clearTimeout(deadline)
		deadline = null
		deadlineAt = at
		if (!Number.isFinite(at)) return
		deadline = setTimeout(
			() => {
				deadline = null
				wake()
			},
			Math.max(1, at - now),
		)
		deadline.unref()
	}
	const wake = () => {
		const now = monoNow()
		rotate(now)
		release(now)
	}
	const backpressure = (id: string) => {
		const now = monoNow()
		rotate(now)
		recover(id, now)
		recovering.delete(id)
		if (!since.has(id)) since.set(id, now)
	}
	const drain = (id: string) => {
		since.delete(id)
		if (excluded.has(id)) recovering.set(id, monoNow())
		wake()
	}
	const removed = (id: string) => {
		since.delete(id)
		excluded.delete(id)
		recovering.delete(id)
		reincluded.delete(id)
		gatedOverflow.delete(id)
		wake()
	}
	fanout.on("backpressure", backpressure)
	fanout.on("drain", drain)
	fanout.on("writable-drain", drain)
	fanout.on("branch-added", wake)
	fanout.on("branch-removed", removed)
	function flush(): void {
		if (continuation !== null) clearImmediate(continuation)
		continuation = null
		const now = monoNow()
		rotate(now)
		flushed += length
		flushes[index()] = flushes[index()]! + length
		length = head = 0
		endHolding(now)
		endOverflow(now)
		since.clear()
		excluded.clear()
		recovering.clear()
		reincluded.clear()
	}
	return {
		configure(capacityBytes) {
			if (disposed) return
			const capacity = Number.isFinite(capacityBytes)
				? Math.max(0, Math.floor(capacityBytes / frameBytes) * frameBytes)
				: 0
			flush()
			if (capacity === (ring?.length ?? 0)) return
			ring = capacity ? Buffer.allocUnsafeSlow(capacity) : null
		},
		ingest(chunk) {
			if (disposed) return
			const now = monoNow()
			// rotate() is a no-op within the current slot while nothing is held
			// (peaks already >= 0, no holding duration), so skip the call there.
			if (
				length !== 0 ||
				holdingSince !== null ||
				Math.floor(now / LINK_QUALITY_SLOT_MS) !== slot
			)
				rotate(now)
			if (!ring || (length === 0 && !gated(now))) {
				fanout.distribute(chunk)
				return
			}
			recorder?.noteHolding(now)
			const free = ring.length - length
			const accepted =
				chunk.length <= free
					? chunk.length
					: Math.floor(free / frameBytes) * frameBytes
			if (accepted > 0) {
				if (length === 0) {
					holdingSince = now
					releaseStarted = false
				}
				const tail = (head + length) % ring.length
				const first = Math.min(accepted, ring.length - tail)
				chunk.copy(ring, tail, 0, first)
				if (first < accepted) chunk.copy(ring, 0, first, accepted)
				length += accepted
				absorbed += accepted
				absorbs[index()] = absorbs[index()]! + accepted
				peaks[index()] = Math.max(peaks[index()]!, length)
			}
			const lost = chunk.length - accepted
			if (lost > 0) {
				// Overflow path only: refresh the hold and charge the branches
				// holding it (congested, active and not excluded).
				gated(now)
				for (const id of congested)
					if (active.has(id) && !excluded.has(id))
						gatedOverflow.set(id, (gatedOverflow.get(id) ?? 0) + lost)
				overflow += lost
				overflowChunks++
				overflows[index()] = overflows[index()]! + lost
				if (episodeSince === null) {
					episodeSince = now
					episodeBytes = episodeChunks = 0
					log.info(
						{ overflowBytes: lost, overflowChunks: 1, durationMs: 0 },
						"Absorber overflow started",
					)
				}
				episodeBytes += lost
				episodeChunks++
			} else endOverflow(now)
			release(now)
		},
		flush,
		counters() {
			rotate(monoNow())
			const sum = (values: Float64Array) => values.reduce((a, b) => a + b, 0)
			const maxExclude = Math.max(...excludes)
			return {
				capacityBytes: ring?.length ?? 0,
				heldBytes: length,
				absorbedBytesTotal: absorbed,
				overflowBytesTotal: overflow,
				overflowChunksTotal: overflowChunks,
				flushedBytesTotal: flushed,
				window: {
					peakHeldBytes: Math.max(...peaks),
					absorbedBytes: sum(absorbs),
					overflowBytes: sum(overflows),
					flushedBytes: sum(flushes),
					peakHeldMs: Math.max(...durations),
					maxLaggardExcludeMs: maxExclude < 0 ? null : maxExclude,
				},
			}
		},
		overflowGatedBy() {
			return Object.fromEntries(gatedOverflow)
		},
		dispose() {
			if (disposed) return
			flush()
			disposed = true
			fanout.off("backpressure", backpressure)
			fanout.off("drain", drain)
			fanout.off("writable-drain", drain)
			fanout.off("branch-added", wake)
			fanout.off("branch-removed", removed)
			ring = null
		},
	}
}
