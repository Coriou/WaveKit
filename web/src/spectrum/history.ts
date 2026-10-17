/** Waterfall history: a ring of decoded rows that never mixes two axes, plus the peak-hold row. */

import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
} from "@wavekit/api-types"
import type { ResetReason, RowAxis } from "./protocol.ts"

export function axisOf(frame: SpectrumFrameEventData): RowAxis {
	return {
		sourceId: frame.sourceId,
		epoch: frame.epoch,
		profile: frame.profile,
		binHz: frame.binHz,
		startHz: frame.startHz,
		binCount: frame.binCount,
	}
}

/**
 * Whether a row of `next` cannot sit under rows of `prev`: a change of sourceId, profile or binHz
 * (binCount too, as it sets the row width). A retune only moves startHz: the older rows stay, each
 * drawn at its own frequency (axisShifted), so dragging the spectrum never wipes the waterfall.
 * docs/API.md also names epoch, but the core opens
 * a new epoch without moving the axis (a gain change, an untracked-retune alarm on an unverified
 * tuner, a same-centre hop), so clearing on it wiped the waterfall every few seconds. The picture
 * keeps the rows of an earlier epoch when its frequency axis is unchanged; nothing here analyses them.
 */
export function axisResetReason(
	prev: RowAxis | null,
	next: RowAxis,
): ResetReason | null {
	if (prev === null) return null
	if (prev.sourceId !== next.sourceId) return "source"
	if (
		prev.profile !== next.profile ||
		prev.binHz !== next.binHz ||
		prev.binCount !== next.binCount
	)
		return "axis"
	return null
}

/** Whether `next` is the same axis as `prev` moved in frequency (a retune), the rows kept. */
export function axisShifted(prev: RowAxis | null, next: RowAxis): boolean {
	return (
		prev !== null &&
		axisResetReason(prev, next) === null &&
		prev.startHz !== next.startHz
	)
}

/**
 * Whether a `spectrum:profile` clears the waterfall of `sourceId`: every one does, except a
 * `removed` notice under the default selection, which drops only `removedSourceId`.
 */
export function profileEventResets(
	event: SpectrumProfileEventData,
	sourceId: string | null,
): boolean {
	if (event.outcome === "removed" && event.selection === "default")
		return event.removedSourceId === sourceId
	return true
}

/**
 * Whether a `spectrum:profile` ack keeps the rows held under `axis`: the same source and profile
 * served again (a reconnect or a repeated subscribe), or a rejected request, which keeps the
 * previous selection. The frames that follow land on the same axis, and `begin` still clears the
 * history if they do not.
 */
export function profileAckKeepsRows(
	event: SpectrumProfileEventData,
	axis: RowAxis | null,
): boolean {
	if (axis === null || event.selection !== "source") return false
	if (event.sourceId !== axis.sourceId) return false
	if (event.outcome === "rejected") return true
	if (event.outcome !== "exact" && event.outcome !== "nearest") return false
	return event.profile?.key === axis.profile
}

export class WaterfallHistory {
	readonly depth: number
	readonly width: number
	readonly data: Uint8Array
	private readonly rows: Uint8Array[]
	/** startHz of each ring row (rows of one history differ only by a retune). */
	private readonly starts: Float64Array
	/** Ring index of the next row to write. */
	private headIndex = 0
	private filledRows = 0
	private currentAxis: RowAxis | null = null

	constructor(depth: number, width: number) {
		this.depth = depth
		this.width = width
		this.data = new Uint8Array(depth * width)
		this.rows = Array.from({ length: depth }, (_, i) =>
			this.data.subarray(i * width, (i + 1) * width),
		)
		this.starts = new Float64Array(depth)
	}

	get axis(): RowAxis | null {
		return this.currentAxis
	}

	/** Rows held (≤ depth). */
	get filled(): number {
		return this.filledRows
	}

	/** Ring index of the next row to write; the newest row is head − 1. */
	get head(): number {
		return this.headIndex
	}

	/** Prepares for a row of `axis`, clearing the history first when the axis changed. */
	begin(axis: RowAxis): ResetReason | null {
		const reason = axisResetReason(this.currentAxis, axis)
		if (reason !== null) this.reset()
		this.currentAxis = axis
		return reason
	}

	/** The buffer the next row decodes into (reused; valid until commit). */
	slot(): Uint8Array {
		return this.rows[this.headIndex] as Uint8Array
	}

	/** Makes the slot the newest row; returns its ring index. */
	commit(): number {
		const index = this.headIndex
		this.starts[index] = this.currentAxis?.startHz ?? 0
		this.headIndex = (this.headIndex + 1) % this.depth
		if (this.filledRows < this.depth) this.filledRows++
		return index
	}

	/** Row `age` rows back (0 = newest), or null when not held. */
	row(age = 0): Uint8Array | null {
		if (age < 0 || age >= this.filledRows) return null
		const index = (this.headIndex - 1 - age + this.depth * 2) % this.depth
		return this.rows[index] ?? null
	}

	/** The axis row `age` rows back was measured on (the current one moved to its startHz). */
	rowAxis(age = 0): RowAxis | null {
		const axis = this.currentAxis
		if (!axis || age < 0 || age >= this.filledRows) return null
		const index = (this.headIndex - 1 - age + this.depth * 2) % this.depth
		return { ...axis, startHz: this.starts[index] ?? axis.startHz }
	}

	rowAt(index: number): Uint8Array {
		return this.rows[index] as Uint8Array
	}

	reset(): void {
		this.headIndex = 0
		this.filledRows = 0
		this.currentAxis = null
	}
}

/** Peak-hold row in byte units with an optional decay. */
export class PeakHold {
	readonly bytes: Uint8Array
	private readonly level: Float32Array
	private empty = true

	constructor(width: number) {
		this.bytes = new Uint8Array(width)
		this.level = new Float32Array(width)
	}

	/** Folds in a row; `decayBytes` is subtracted from the held level first (2 bytes per dB). */
	update(row: Uint8Array, count: number, decayBytes: number): void {
		const n = Math.min(count, row.length, this.bytes.length)
		const level = this.level
		const out = this.bytes
		for (let i = 0; i < n; i++) {
			const v = row[i] as number
			const held = this.empty ? v : (level[i] as number) - decayBytes
			const next = v > held ? v : held
			level[i] = next
			out[i] = next < 0 ? 0 : next
		}
		this.empty = false
	}

	reset(): void {
		this.empty = true
		this.level.fill(0)
		this.bytes.fill(0)
	}
}

/**
 * Smoothed trace row in byte units: an exponential average of the rows (DESIGN.md spectrum board,
 * `avg += (row − avg) · 0.35` per row). The trace and its fill draw from it; the waterfall keeps the
 * raw rows, so nothing is lost there.
 */
export class TraceAverage {
	readonly bytes: Uint8Array
	private readonly level: Float32Array
	private empty = true

	constructor(width: number) {
		this.bytes = new Uint8Array(width)
		this.level = new Float32Array(width)
	}

	/** Folds in a row with weight `alpha` (1 shows the raw row). */
	update(row: Uint8Array, count: number, alpha: number): void {
		const n = Math.min(count, row.length, this.bytes.length)
		const level = this.level
		const out = this.bytes
		for (let i = 0; i < n; i++) {
			const v = row[i] as number
			const next = this.empty
				? v
				: (level[i] as number) + (v - (level[i] as number)) * alpha
			level[i] = next
			out[i] = Math.round(next)
		}
		this.empty = false
	}

	reset(): void {
		this.empty = true
		this.level.fill(0)
		this.bytes.fill(0)
	}
}
