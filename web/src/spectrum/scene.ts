/**
 * Render state shared by the worker (OffscreenCanvas) and the main-thread fallback: ring position,
 * axis, view, levels, layout, the smoothed trace row and peak hold. It uploads each row once and asks for a redraw only when
 * something visible changed; the caller coalesces redraws with a RenderScheduler.
 */

import { levelsToLinear } from "./codec.ts"
import {
	PeakHold,
	TraceAverage,
	axisResetReason,
	axisShifted,
} from "./history.ts"
import type {
	ResetReason,
	RowAxis,
	SpectrumLayout,
	SpectrumLevels,
	SpectrumSize,
	SpectrumViewSpan,
} from "./protocol.ts"
import type { DrawParams, SceneRenderer } from "./renderer.ts"
import { splitHeight, texMapping, visibleRows } from "./view.ts"

export interface SceneOptions {
	depth: number
	texWidth: number
	layout: SpectrumLayout
	levels: SpectrumLevels
	size: SpectrumSize
	/** Asks for a redraw (coalesced by the caller). */
	invalidate: () => void
	now?: () => number
}

export class SpectrumScene {
	private readonly renderer: SceneRenderer
	private readonly depth: number
	private readonly texWidth: number
	private readonly invalidate: () => void
	private readonly now: () => number
	private readonly peak: PeakHold
	private readonly average: TraceAverage
	private axis: RowAxis | null = null
	/** startHz of each ring row; rows from before a retune keep theirs. */
	private readonly starts: Float64Array
	/** Each row's start in bins from the newest row's (uploaded to the renderer). */
	private readonly offsets: Float32Array
	private next = 0
	private filled = 0
	private lastRowAt: number | null = null
	private view: SpectrumViewSpan | null = null
	private levels: SpectrumLevels
	private layout: SpectrumLayout
	private size: SpectrumSize

	constructor(renderer: SceneRenderer, opts: SceneOptions) {
		this.renderer = renderer
		this.depth = opts.depth
		this.texWidth = opts.texWidth
		this.levels = opts.levels
		this.layout = opts.layout
		this.size = opts.size
		this.invalidate = opts.invalidate
		this.now = opts.now ?? (() => performance.now())
		this.peak = new PeakHold(opts.texWidth)
		this.average = new TraceAverage(opts.texWidth)
		this.starts = new Float64Array(opts.depth)
		this.offsets = new Float32Array(opts.depth)
		this.applySize()
	}

	/** Adds the newest row; clears the history first when its axis differs. */
	addRow(axis: RowAxis, row: Uint8Array, count: number): ResetReason | null {
		const reason = axisResetReason(this.axis, axis)
		const shifted = reason === null && axisShifted(this.axis, axis)
		if (reason !== null) this.reset()
		if (shifted) {
			// A retune: the trace and peak restart on the new bins, the waterfall keeps its rows.
			this.peak.reset()
			this.average.reset()
			this.lastRowAt = null
		}
		this.axis = axis
		const index = this.next
		this.starts[index] = axis.startHz
		this.renderer.uploadRow(index, row, count)
		if (shifted || this.offsets[index] !== 0) this.uploadOffsets(axis)
		this.next = (index + 1) % this.depth
		if (this.filled < this.depth) this.filled++
		this.average.update(row, count, this.layout.traceAlpha)
		this.renderer.uploadTrace(this.average.bytes, count)
		if (this.layout.peakHold) {
			const now = this.now()
			const dt = this.lastRowAt === null ? 0 : (now - this.lastRowAt) / 1000
			this.lastRowAt = now
			this.peak.update(row, count, this.layout.peakDecayDbPerSec * 2 * dt)
			this.renderer.uploadPeak(this.peak.bytes, count)
		}
		this.invalidate()
		return reason
	}

	reset(): void {
		this.axis = null
		this.next = 0
		this.filled = 0
		if (this.offsets.some(o => o !== 0)) {
			this.offsets.fill(0)
			this.renderer.uploadRowOffsets(this.offsets)
		}
		this.lastRowAt = null
		this.peak.reset()
		this.average.reset()
		this.invalidate()
	}

	setView(view: SpectrumViewSpan | null): void {
		this.view = view
		this.invalidate()
	}

	setLevels(levels: SpectrumLevels): void {
		this.levels = levels
		this.invalidate()
	}

	setLayout(layout: SpectrumLayout): void {
		if (layout.peakHold !== this.layout.peakHold) {
			this.peak.reset()
			this.lastRowAt = null
		}
		this.layout = layout
		this.invalidate()
	}

	setSize(size: SpectrumSize): void {
		this.size = size
		this.applySize()
		this.invalidate()
	}

	setRamp(rgba: Uint8Array): void {
		this.renderer.setRamp(rgba)
		this.invalidate()
	}

	/** Draw parameters for the current state (exposed for tests). */
	drawParams(): DrawParams {
		const heightPx = this.pixelHeight()
		const { tracePx, waterfallPx } = splitHeight(
			heightPx,
			this.layout.splitRatio,
		)
		const gapPx = Math.min(
			waterfallPx,
			Math.max(0, Math.round(this.layout.gapCss * this.size.dpr)),
		)
		const axis = this.axis ?? { startHz: 0, binHz: 1, binCount: 0 }
		return {
			map: texMapping(this.view, axis, this.texWidth),
			level: levelsToLinear(this.levels.minDb, this.levels.maxDb),
			newest: (this.next - 1 + this.depth) % this.depth,
			filled: this.filled,
			rows: visibleRows(
				waterfallPx - gapPx,
				this.layout.rowHeightCss * this.size.dpr,
				this.depth,
			),
			tracePx,
			gapPx,
			// 1.25 CSS px, as on the design board.
			lineHalfWidth: 0.625 * this.size.dpr,
			peakHold: this.layout.peakHold,
		}
	}

	/** Row offsets from the newest row, in bins, for the rows held. */
	private uploadOffsets(axis: RowAxis): void {
		const n = Math.min(this.depth, this.filled + 1)
		for (let k = 0; k < this.depth; k++) {
			const i = (this.next - k + this.depth) % this.depth
			this.offsets[i] =
				k < n
					? ((this.starts[i] ?? axis.startHz) - axis.startHz) / axis.binHz
					: 0
		}
		this.renderer.uploadRowOffsets(this.offsets)
	}

	render(): void {
		this.renderer.draw(this.drawParams())
	}

	private pixelHeight(): number {
		return Math.max(1, Math.round(this.size.heightCss * this.size.dpr))
	}

	private applySize(): void {
		this.renderer.resize(
			Math.max(1, Math.round(this.size.widthCss * this.size.dpr)),
			this.pixelHeight(),
		)
	}
}
