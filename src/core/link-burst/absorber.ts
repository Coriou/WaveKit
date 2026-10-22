import {
	ABSORBER_LAGGARD_MS,
	ABSORBER_RELEASE_BYTES,
	LINK_QUALITY_SLOT_MS,
	LINK_QUALITY_WINDOW_MS,
	type BurstAbsorber,
	type BurstAbsorberDeps,
} from "./contract.js"

export function createBurstAbsorber(deps: BurstAbsorberDeps): BurstAbsorber {
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
	const active = new Set<string>()
	const congested = new Set<string>()
	const excluded = new Set<string>()
	const since = new Map<string, number>()
	const progress = new Map<string, number>()
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
	function gated(now: number): boolean {
		fanout.activeBranchIds(active)
		fanout.congestedBranchIds(congested)
		if (active.size <= 1) excluded.clear()
		for (const id of since.keys()) {
			if (!active.has(id) || !congested.has(id)) {
				since.delete(id)
				progress.delete(id)
				excluded.delete(id)
			}
		}
		let hasProgress = false
		for (const id of active)
			if (!excluded.has(id) && !congested.has(id)) hasProgress = true
		let blocked = false
		for (const id of congested) {
			if (!active.has(id)) continue
			const start = since.get(id) ?? now
			since.set(id, start)
			if (hasProgress) progress.set(id, now)
			if (
				active.size > 1 &&
				now - start >= ABSORBER_LAGGARD_MS &&
				(progress.get(id) ?? -Infinity) >= start
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
		if (releasing || !ring) return
		releasing = true
		try {
			while (length >= frameBytes && !gated(now)) {
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
		} finally {
			releasing = false
		}
	}
	const wake = () => {
		const now = monoNow()
		rotate(now)
		release(now)
	}
	const backpressure = (id: string) => {
		const now = monoNow()
		rotate(now)
		if (!since.has(id)) since.set(id, now)
	}
	const drain = (id: string) => {
		since.delete(id)
		progress.delete(id)
		excluded.delete(id)
		wake()
	}
	fanout.on("backpressure", backpressure)
	fanout.on("drain", drain)
	fanout.on("branch-added", wake)
	fanout.on("branch-removed", drain)
	function flush(): void {
		const now = monoNow()
		rotate(now)
		flushed += length
		flushes[index()] = flushes[index()]! + length
		length = head = 0
		endHolding(now)
		endOverflow(now)
		since.clear()
		progress.clear()
		excluded.clear()
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
				if (length === 0) holdingSince = now
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
		dispose() {
			if (disposed) return
			flush()
			disposed = true
			fanout.off("backpressure", backpressure)
			fanout.off("drain", drain)
			fanout.off("branch-added", wake)
			fanout.off("branch-removed", drain)
			ring = null
		},
	}
}
