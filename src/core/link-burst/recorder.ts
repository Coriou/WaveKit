import {
	CATCHUP_BUCKET_BASE_BYTES,
	CATCHUP_BUCKETS,
	CATCHUP_WINDOW_MS,
	CHUNK_SIZE_BUCKETS,
	GAP_BUCKETS,
	LINK_GAP_MS,
	LINK_RECOVERY_WAIT_MS,
	LINK_QUALITY_SLOT_MS,
	LINK_QUALITY_WINDOW_MS,
} from "./contract.js"
import type {
	IngestInterval,
	IngestRecorder,
	IngestWindowStats,
} from "./contract.js"

const SLOTS = LINK_QUALITY_WINDOW_MS / LINK_QUALITY_SLOT_MS
const CELL_MS = 250
const CELLS = 64
const LOG_RATIO = Math.log(1.25)

export function createIngestRecorder(): IngestRecorder {
	const stamps = new Float64Array(SLOTS).fill(-Infinity)
	const gaps = new Uint32Array(SLOTS * GAP_BUCKETS)
	const sizes = new Uint32Array(SLOTS * CHUNK_SIZE_BUCKETS)
	const bursts = new Uint32Array(SLOTS * CATCHUP_BUCKETS)
	const worst = new Float64Array(SLOTS)
	const catchup = new Float64Array(SLOTS)
	const chunks = new Float64Array(SLOTS)
	const seconds = new Float64Array(600).fill(-Infinity)
	const cellStamps = new Float64Array(CELLS).fill(-Infinity)
	const cellGaps = new Float64Array(CELLS)
	const cellChunks = new Float64Array(CELLS)
	const cellCatchup = new Float64Array(CELLS)
	const intervalResult: IngestInterval = {
		maxGapMs: 0,
		catchupBytes: 0,
		chunks: 0,
	}
	const windowResult: IngestWindowStats = {
		worstStallMs: null,
		gapP99Ms: null,
		burstSeconds: 0,
		catchupBytes: 0,
		chunks: 0,
	}
	const totals = new Float64Array(GAP_BUCKETS)
	const arrival = new Float64Array(1).fill(NaN)
	let highWaterCell = -Infinity
	let first: number | null = null
	let nominal = 0
	let totalBytes = 0
	let sequence = 0
	let completedSequence = 0
	let failedSequence = 0
	let recovery: {
		start: number
		arrived: number
		base: number
		gap: number
	} | null = null
	let burstStart: number | null = null
	let burstBytes = 0
	function slot(now: number): number {
		const stamp = Math.floor(now / LINK_QUALITY_SLOT_MS)
		const i = stamp % SLOTS
		if (stamps[i] !== stamp) {
			stamps[i] = stamp
			gaps.fill(0, i * GAP_BUCKETS, (i + 1) * GAP_BUCKETS)
			sizes.fill(0, i * CHUNK_SIZE_BUCKETS, (i + 1) * CHUNK_SIZE_BUCKETS)
			bursts.fill(0, i * CATCHUP_BUCKETS, (i + 1) * CATCHUP_BUCKETS)
			worst[i] = 0
			catchup[i] = 0
			chunks[i] = 0
		}
		return i
	}
	function cell(now: number): number {
		const stamp = Math.floor(now / CELL_MS)
		highWaterCell = Math.max(highWaterCell, stamp)
		const i = stamp % CELLS
		if (cellStamps[i] !== stamp) {
			cellStamps[i] = stamp
			cellGaps[i] = 0
			cellChunks[i] = 0
			cellCatchup[i] = 0
		}
		return i
	}
	function close(now: number): void {
		if (burstStart === null || now < burstStart + CATCHUP_WINDOW_MS) return
		const end = burstStart + CATCHUP_WINDOW_MS
		const bytes = Math.max(0, burstBytes - (nominal * CATCHUP_WINDOW_MS) / 1000)
		// Attribute a completed burst to its fixed window endpoint, independent of read timing.
		if (
			Math.floor(end / LINK_QUALITY_SLOT_MS) >
			Math.floor(now / LINK_QUALITY_SLOT_MS) - SLOTS
		) {
			const s = slot(end)
			catchup[s] = (catchup[s] ?? 0) + bytes
			const b = Math.min(
				CATCHUP_BUCKETS - 1,
				Math.max(
					0,
					1 + Math.floor(Math.log2(bytes / CATCHUP_BUCKET_BASE_BYTES)),
				),
			)
			const index = s * CATCHUP_BUCKETS + b
			bursts[index] = (bursts[index] ?? 0) + 1
		}
		if (Math.floor(end / CELL_MS) > Math.floor(now / CELL_MS) - CELLS) {
			const c = cell(end)
			cellCatchup[c] = (cellCatchup[c] ?? 0) + bytes
		}
		burstStart = null
		burstBytes = 0
	}
	function holding(now: number): void {
		const second = Math.floor(now / 1000)
		seconds[second % 600] = second
	}
	return {
		recovery(now) {
			if (!recovery || nominal <= 0) return null
			if (
				now >= recovery.arrived + LINK_RECOVERY_WAIT_MS &&
				completedSequence === sequence
			)
				return null
			const expected = (nominal * (now - recovery.start)) / 1000
			const full = totalBytes - recovery.base >= expected * 0.99
			if (full) completedSequence = sequence
			return {
				sequence,
				completedSequence,
				failedSequence,
				maxGapMs: recovery.gap,
				shortfall: full
					? false
					: now < recovery.arrived + LINK_RECOVERY_WAIT_MS
						? null
						: true,
			}
		},
		configure(rate, frame) {
			recovery = null
			nominal = rate * frame
			arrival[0] = NaN
			burstStart = null
			burstBytes = 0
		},
		resetArrival() {
			recovery = null
			arrival[0] = NaN
			burstStart = null
			burstBytes = 0
		},
		noteHolding: holding,
		observeChunk(bytes, now) {
			close(now)
			first ??= now
			const s = slot(now)
			const c = cell(now)
			chunks[s] = (chunks[s] ?? 0) + 1
			cellChunks[c] = (cellChunks[c] ?? 0) + 1
			const size =
				s * CHUNK_SIZE_BUCKETS +
				Math.min(
					CHUNK_SIZE_BUCKETS - 1,
					Math.max(0, Math.floor(Math.log2(bytes))),
				)
			sizes[size] = (sizes[size] ?? 0) + 1
			const previous = arrival[0] ?? NaN
			if (!Number.isNaN(previous)) {
				const gap = now - previous
				const b =
					gap < 1
						? 0
						: Math.min(
								GAP_BUCKETS - 1,
								1 + Math.floor(Math.log(gap) / LOG_RATIO),
							)
				const index = s * GAP_BUCKETS + b
				gaps[index] = (gaps[index] ?? 0) + 1
				worst[s] = Math.max(worst[s] ?? 0, gap)
				cellGaps[c] = Math.max(cellGaps[c] ?? 0, gap)
				if (gap >= LINK_GAP_MS) {
					if (
						recovery === null ||
						now >= recovery.arrived + LINK_RECOVERY_WAIT_MS ||
						totalBytes - recovery.base >=
							((nominal * (previous - recovery.start)) / 1000) * 0.99
					) {
						if (
							recovery &&
							totalBytes - recovery.base >=
								((nominal * (previous - recovery.start)) / 1000) * 0.99
						)
							completedSequence = sequence
						else if (recovery) failedSequence = sequence
						sequence++
						recovery = { start: previous, arrived: now, base: totalBytes, gap }
					}
					holding(now)
					if (burstStart === null) {
						burstStart = now
						burstBytes = 0
					}
				}
			}
			totalBytes += bytes
			if (burstStart !== null) burstBytes += bytes
			arrival[0] = now
		},
		interval(from, to) {
			close(to)
			if (
				first === null ||
				from < first ||
				to < from ||
				Math.floor(from / CELL_MS) < highWaterCell - CELLS + 1 ||
				to - from > CELLS * CELL_MS
			)
				return null
			intervalResult.maxGapMs = 0
			intervalResult.catchupBytes = 0
			intervalResult.chunks = 0
			for (let i = 0; i < CELLS; i++) {
				const stamp = cellStamps[i] ?? -Infinity
				if (
					stamp >= Math.floor(from / CELL_MS) &&
					stamp <= Math.floor(to / CELL_MS)
				) {
					intervalResult.maxGapMs = Math.max(
						intervalResult.maxGapMs,
						cellGaps[i] ?? 0,
					)
					intervalResult.catchupBytes += cellCatchup[i] ?? 0
					intervalResult.chunks += cellChunks[i] ?? 0
				}
			}
			return intervalResult
		},
		window(now) {
			close(now)
			totals.fill(0)
			let count = 0
			let max = 0
			windowResult.catchupBytes = 0
			windowResult.chunks = 0
			windowResult.burstSeconds = 0
			for (let s = 0; s < SLOTS; s++) {
				const stamp = stamps[s] ?? -Infinity
				if (
					stamp > Math.floor(now / LINK_QUALITY_SLOT_MS) - SLOTS &&
					stamp <= Math.floor(now / LINK_QUALITY_SLOT_MS)
				) {
					max = Math.max(max, worst[s] ?? 0)
					windowResult.catchupBytes += catchup[s] ?? 0
					windowResult.chunks += chunks[s] ?? 0
					for (let b = 0; b < GAP_BUCKETS; b++) {
						const n = gaps[s * GAP_BUCKETS + b] ?? 0
						totals[b] = (totals[b] ?? 0) + n
						count += n
					}
				}
			}
			windowResult.worstStallMs = count ? max : null
			windowResult.gapP99Ms = null
			let cumulative = 0
			for (let b = 0; b < GAP_BUCKETS && count; b++) {
				cumulative += totals[b] ?? 0
				if (cumulative >= Math.ceil(count * 0.99)) {
					windowResult.gapP99Ms = b === GAP_BUCKETS - 1 ? max : 1.25 ** b
					break
				}
			}
			for (let i = 0; i < 600; i++) {
				const second = seconds[i] ?? -Infinity
				if (
					second > Math.floor(now / 1000) - 600 &&
					second <= Math.floor(now / 1000)
				)
					windowResult.burstSeconds++
			}
			return windowResult
		},
		histograms(now) {
			close(now)
			function sum(data: Uint32Array, width: number): number[] {
				const result = new Array<number>(width).fill(0)
				for (let s = 0; s < SLOTS; s++) {
					const stamp = stamps[s] ?? -Infinity
					if (
						stamp > Math.floor(now / LINK_QUALITY_SLOT_MS) - SLOTS &&
						stamp <= Math.floor(now / LINK_QUALITY_SLOT_MS)
					)
						for (let b = 0; b < width; b++)
							result[b] = (result[b] ?? 0) + (data[s * width + b] ?? 0)
				}
				return result
			}
			// Last gap, chunk-size and catch-up buckets are open-ended; listed edges
			// are the lower bounds of overflow.
			return {
				gapBucketUpperMs: Array.from(
					{ length: GAP_BUCKETS },
					(_, b) => 1.25 ** b,
				),
				gapCounts: sum(gaps, GAP_BUCKETS),
				chunkSizeBucketUpperBytes: Array.from(
					{ length: CHUNK_SIZE_BUCKETS },
					(_, b) => 2 ** (b + 1),
				),
				chunkSizeCounts: sum(sizes, CHUNK_SIZE_BUCKETS),
				catchupBucketUpperBytes: Array.from(
					{ length: CATCHUP_BUCKETS },
					(_, b) => CATCHUP_BUCKET_BASE_BYTES * 2 ** b,
				),
				catchupCounts: sum(bursts, CATCHUP_BUCKETS),
			}
		},
	}
}
