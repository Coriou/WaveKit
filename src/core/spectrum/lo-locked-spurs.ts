/**
 * LO-locked spurs from sightings (memory only). A receiver spur at a fixed offset from the tuned
 * centre (a clock harmonic mixed with the LO, a reference leak) moves with every retune: tuned at
 * C1 it shows at C1 + Δ, tuned at C2 at C2 + Δ. A real emitter stays at its RF frequency, so its
 * offset changes by C1 − C2. The spectrum's own spur map needs three centres and minutes of
 * observation; this needs two sightings.
 *
 * Per source, for every record a caller notes, the tuned centres it was sighted from and its
 * offset at each. A new sighting at offset Δ under centre C is LO-locked when a noted record the
 * caller accepts (`eligible`: evidence-free, say) was sighted from another centre, at least
 * `minSeparationHz` from C, at the same offset (within `offsetHz`) with a compatible width, and
 * was never sighted from C itself (a real emitter inside both windows is sighted from both). The
 * offset is then learned: every later sighting at it, under any centre, is LO-locked too, so the
 * spur does not come back when the tuner returns to C1.
 *
 * Bounds (constructor options): records per source (least recently sighted dropped), centres per
 * record (oldest dropped), learned offsets per source (oldest dropped) and sources (a new source
 * past the cap is not remembered: nothing is LO-locked there, the safe answer is today's).
 * Non-finite input is never noted and never LO-locked.
 */

export interface LoSighting {
	sourceId: string
	/** Tuned centre of the sighting's epoch (Hz). */
	tunedHz: number
	/** Measured centre (Hz). */
	centreHz: number
	/** Occupied bandwidth (Hz); non-finite or non-positive counts as the width floor. */
	obwHz: number
}

export interface LoLockedOptions {
	offsetHz: number
	minSeparationHz: number
	widthRatio: number
	widthFloorHz: number
	recordsPerSource: number
	centresPerRecord: number
	offsetsPerSource: number
	sourcesMax: number
}

interface CentreEntry {
	tunedHz: number
	offsetHz: number
	widthHz: number
}

interface SourceState {
	/** Insertion order = least recently sighted first. */
	records: Map<string, CentreEntry[]>
	learned: CentreEntry[]
}

export interface LoCheck {
	locked: boolean
	/** Noted, eligible records sighted at this offset from other centres (the spur's earlier records). */
	partners: string[]
}

const NOT_LOCKED: LoCheck = Object.freeze({
	locked: false,
	partners: Object.freeze([]) as unknown as string[],
})

export class LoLockedSpurs {
	private readonly sources = new Map<string, SourceState>()

	constructor(private readonly opts: LoLockedOptions) {}

	/** Remembers that record `id` was sighted at `s`. */
	note(id: string, s: LoSighting): void {
		if (!finite(s)) return
		const st = this.state(s.sourceId, true)
		if (st === undefined) return
		const entry: CentreEntry = {
			tunedHz: s.tunedHz,
			offsetHz: s.centreHz - s.tunedHz,
			widthHz: this.width(s.obwHz),
		}
		const list = st.records.get(id) ?? []
		st.records.delete(id)
		const same = list.findIndex(
			e => Math.abs(e.tunedHz - s.tunedHz) < this.opts.minSeparationHz,
		)
		if (same >= 0) list.splice(same, 1)
		list.push(entry)
		while (list.length > this.opts.centresPerRecord) list.shift()
		st.records.set(id, list)
		while (st.records.size > this.opts.recordsPerSource) {
			const oldest = st.records.keys().next()
			if (oldest.done === true) break
			st.records.delete(oldest.value)
		}
	}

	/** Drops a record (deleted or merged away). */
	forget(id: string): void {
		for (const st of this.sources.values()) st.records.delete(id)
	}

	/** Drops everything a source taught (source removed). */
	clear(sourceId?: string): void {
		if (sourceId === undefined) this.sources.clear()
		else this.sources.delete(sourceId)
	}

	/** Learned spur offsets of a source (Hz from the tuned centre), oldest first. */
	learnedOffsets(sourceId: string): number[] {
		return (this.sources.get(sourceId)?.learned ?? []).map(e => e.offsetHz)
	}

	/**
	 * Is `s` an LO-locked spur? Learns its offset when a partner shows it. `eligible` filters the
	 * noted records that may stand as the spur's earlier sighting (one with a decode is a real
	 * emitter, never a partner).
	 */
	check(s: LoSighting, eligible: (id: string) => boolean): LoCheck {
		if (!finite(s)) return NOT_LOCKED
		const st = this.state(s.sourceId, false)
		if (st === undefined) return NOT_LOCKED
		const offset = s.centreHz - s.tunedHz
		const width = this.width(s.obwHz)
		const partners: string[] = []
		for (const [id, list] of st.records) {
			let other = false
			let here = false
			for (const e of list) {
				if (Math.abs(e.tunedHz - s.tunedHz) < this.opts.minSeparationHz) {
					here = true
					break
				}
				if (
					Math.abs(e.offsetHz - offset) <= this.opts.offsetHz &&
					this.widthsAgree(e.widthHz, width)
				)
					other = true
			}
			if (other && !here && eligible(id)) partners.push(id)
		}
		const known = st.learned.some(
			e =>
				Math.abs(e.offsetHz - offset) <= this.opts.offsetHz &&
				this.widthsAgree(e.widthHz, width),
		)
		if (partners.length === 0)
			return known ? { locked: true, partners } : NOT_LOCKED
		if (!known) {
			st.learned.push({ tunedHz: s.tunedHz, offsetHz: offset, widthHz: width })
			while (st.learned.length > this.opts.offsetsPerSource) st.learned.shift()
		}
		return { locked: true, partners }
	}

	private state(sourceId: string, create: boolean): SourceState | undefined {
		let st = this.sources.get(sourceId)
		if (
			st === undefined &&
			create &&
			this.sources.size < this.opts.sourcesMax
		) {
			st = { records: new Map(), learned: [] }
			this.sources.set(sourceId, st)
		}
		return st
	}

	private width(obwHz: number): number {
		return Number.isFinite(obwHz) && obwHz > this.opts.widthFloorHz
			? obwHz
			: this.opts.widthFloorHz
	}

	private widthsAgree(a: number, b: number): boolean {
		return Math.max(a, b) <= this.opts.widthRatio * Math.min(a, b)
	}
}

function finite(s: LoSighting): boolean {
	return (
		typeof s.sourceId === "string" &&
		Number.isFinite(s.tunedHz) &&
		Number.isFinite(s.centreHz) &&
		s.tunedHz > 0
	)
}
