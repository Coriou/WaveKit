/**
 * Where one channel's recording files start and end, in engine sample indices. A file starts
 * `preRoll` before the first transmission's onset (never before the previous file's end or the
 * epoch floor), runs while any joined track is open, and ends `hang` after the last track's end.
 * A track that opens before that end joins the file (a gap shorter than the hang never splits);
 * one that opens later starts a new file. A cut end (retune, stream change) ends at the track's
 * last sample at once. A file longer than `maxSegment` rolls over into a continuation file.
 *
 * Decisions are final only `holdback` samples after the end target, so a track open the engine
 * reports late (detection latency) still joins. `planSegments` is the offline reference the
 * streaming state machine must match when every open arrives less than `holdback` late.
 */
export type SegmentEndCut = "completed" | "duration-limit" | "cut"

export interface SegmentEvent {
	readonly kind: "start" | "end"
	readonly sample: number
	readonly cut?: SegmentEndCut
}

export interface SegmenterOptions {
	readonly preRollSamples: number
	readonly hangSamples: number
	readonly holdbackSamples: number
	readonly maxSegmentSamples: number
}

interface OpenFile {
	start: number
	readonly open: Set<string>
	lastEnd: number
	endTarget: number | null
	quiet: boolean
}

function validCount(value: number, positive = false): boolean {
	return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
}

export class TransmissionSegmenter {
	private file: OpenFile | null = null
	private prevEnd = Number.NEGATIVE_INFINITY

	constructor(private readonly o: SegmenterOptions) {
		if (
			!validCount(o.preRollSamples) ||
			!validCount(o.hangSamples) ||
			!validCount(o.holdbackSamples) ||
			!validCount(o.maxSegmentSamples, true)
		)
			throw new RangeError("Invalid segmenter bounds")
	}

	/** The open file's start sample, or null. */
	get fileStart(): number | null {
		return this.file?.start ?? null
	}

	/** The decided end of the open file (its tracks closed), or null while a track is open. */
	get endTarget(): number | null {
		return this.file?.endTarget ?? null
	}

	get openTracks(): number {
		return this.file?.open.size ?? 0
	}

	/** End of the last finished file (clamps the next pre-roll), or −∞. */
	get previousEnd(): number {
		return this.prevEnd
	}

	/**
	 * A track of this channel opened at `startSample`. `floor` is the earliest sample a file may
	 * start at (epoch start, oldest ring sample). Returns the events it causes.
	 */
	open(
		trackId: string,
		startSample: number,
		floor = Number.NEGATIVE_INFINITY,
	): SegmentEvent[] {
		const events: SegmentEvent[] = []
		const f = this.file
		if (f) {
			if (f.open.has(trackId)) return events
			if (
				f.open.size > 0 ||
				(f.endTarget !== null && startSample < f.endTarget)
			) {
				f.open.add(trackId)
				f.endTarget = null
				f.quiet = true
				return events
			}
			events.push(this.endFile(f.endTarget ?? f.lastEnd, "completed"))
		}
		const start = Math.max(
			startSample - this.o.preRollSamples,
			this.prevEnd,
			floor,
		)
		this.file = {
			start,
			open: new Set([trackId]),
			lastEnd: startSample,
			endTarget: null,
			quiet: true,
		}
		events.push({ kind: "start", sample: start })
		return events
	}

	/** A joined track closed at `lastSample`; `quiet` false is a cut (no hang, ends at once). */
	close(trackId: string, lastSample: number, quiet: boolean): void {
		const f = this.file
		if (!f || !f.open.delete(trackId)) return
		f.lastEnd = Math.max(f.lastEnd, lastSample)
		if (!quiet) f.quiet = false
		if (f.open.size === 0)
			f.endTarget = f.quiet ? f.lastEnd + this.o.hangSamples : f.lastEnd
	}

	/** The live edge reached `edge`: ends a decided file and rolls an over-long one. */
	advance(edge: number): SegmentEvent[] {
		const events: SegmentEvent[] = []
		for (;;) {
			const f = this.file
			if (!f) return events
			const rollAt = f.start + this.o.maxSegmentSamples
			// An open track may still close (late) before rollAt: wait out the holdback first.
			const rollDue =
				f.endTarget === null
					? edge >= rollAt + this.o.holdbackSamples
					: f.endTarget > rollAt && edge >= rollAt
			if (rollDue) {
				events.push(this.endFile(rollAt, "duration-limit"))
				this.file = { ...f, start: rollAt, open: new Set(f.open) }
				events.push({ kind: "start", sample: rollAt })
				continue
			}
			if (
				f.endTarget !== null &&
				(!f.quiet || edge >= f.endTarget + this.o.holdbackSamples)
			) {
				events.push(this.endFile(f.endTarget, f.quiet ? "completed" : "cut"))
			}
			return events
		}
	}

	/**
	 * Samples up to which audio is certainly in the open file: everything before the end target,
	 * or, while a track is open, everything older than the holdback (its close may come late).
	 */
	writableUntil(edge: number): number {
		const f = this.file
		if (!f) return Number.NEGATIVE_INFINITY
		if (f.endTarget !== null) return Math.min(f.endTarget, edge)
		return edge - this.o.holdbackSamples
	}

	/** Drops the open file without an end event (cancelled recording). */
	abort(): void {
		if (this.file) this.prevEnd = Math.max(this.prevEnd, this.file.lastEnd)
		this.file = null
	}

	private endFile(at: number, cut: SegmentEndCut): SegmentEvent {
		this.prevEnd = at
		this.file = null
		return { kind: "end", sample: at, cut }
	}
}

export interface PlannedSegment {
	readonly start: number
	readonly end: number
	readonly cut: SegmentEndCut
}

/**
 * The offline reference: `intervals` are one channel's transmissions [start, end] in sample
 * order, all quiet ends. Gaps shorter than the hang merge; each group is one file (split at
 * `maxSegment`), starting preRoll early but never before the previous file's end or `floor`.
 */
export function planSegments(
	intervals: readonly { readonly start: number; readonly end: number }[],
	o: Pick<
		SegmenterOptions,
		"preRollSamples" | "hangSamples" | "maxSegmentSamples"
	>,
	floor = Number.NEGATIVE_INFINITY,
): PlannedSegment[] {
	const out: PlannedSegment[] = []
	let prevEnd = Number.NEGATIVE_INFINITY
	let i = 0
	while (i < intervals.length) {
		const first = intervals[i]!
		let end = first.end
		i++
		while (i < intervals.length && intervals[i]!.start < end + o.hangSamples) {
			end = Math.max(end, intervals[i]!.end)
			i++
		}
		let start = Math.max(first.start - o.preRollSamples, prevEnd, floor)
		const stop = end + o.hangSamples
		while (stop > start + o.maxSegmentSamples) {
			out.push({
				start,
				end: start + o.maxSegmentSamples,
				cut: "duration-limit",
			})
			start += o.maxSegmentSamples
		}
		out.push({ start, end: stop, cut: "completed" })
		prevEnd = stop
	}
	return out
}
