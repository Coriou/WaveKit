/**
 * LO-locked spurs from sightings (memory only). A receiver spur at a fixed offset from the tuned
 * centre (a clock harmonic mixed with the LO, a reference leak) moves with every retune: tuned at
 * C1 it shows at F1 = C1 + Δ, tuned at C2 at F2 = C2 + Δ. A real emitter stays at its RF frequency.
 * Two real emitters can sit at one offset too, so a shared offset alone proves nothing: a sighting
 * is LO-locked only on positive evidence that each position is empty when seen from the other
 * centre. When unsure, the answer is "clear" (discover).
 *
 * Per source, every sighting the caller reports (`observe`) is logged in its dwell: the run of
 * sightings under one tuned centre and sample rate, with the RF lines seen there. A steady narrow
 * sighting at offset Δ under centre C (`check`) is LO-locked when an earlier dwell D at another
 * centre Cp (at least `minSeparationHz` away, same sample rate, last sighted within `ttlMs`, at least
 * `dwellMs` long, its line log complete) holds:
 * - a steady narrow line at Cp + Δ (within `offsetHz`, widths within `widthRatio`) with no evidence
 *   of a real signal on it, and
 * - nothing at F = C + Δ, while F lay inside D's usable window (outside its DC guard, the line's
 *   width inside the usable half-span), so a real emitter at F would have been seen;
 * and the current dwell holds Cp + Δ inside its usable window with nothing sighted there after at
 * least `dwellMs` (its line log complete). Until the current dwell is that long, or while the
 * sighting is too young to say whether it is steady, the answer is "pending" (the caller holds the
 * sighting back). If either window does not cover the other position, the answer is "clear".
 *
 * A lock learns the offset (per sample rate). Learned offsets expire after `ttlMs`, and an offset
 * is revoked (no lock there for `ttlMs`) on contradictory evidence: a sighting with evidence of a
 * real signal at it, a sighting at it that is not a steady narrow line, or one RF line seen from two
 * centres where one of its offsets is learned. A learned offset never locks by itself: every lock
 * needs the dwell evidence above.
 *
 * Records (`note`): the caller's records sighted per centre; a lock names as partners the records
 * sighted as a steady narrow line at Cp + Δ from Cp and never from C (`eligible` filters them).
 *
 * Bounds (constructor options): dwells per source (oldest dropped), lines per dwell (past it the
 * dwell proves no absence), records per source (least recently sighted dropped), centres per record
 * (oldest dropped), learned and revoked offsets per source (oldest dropped) and sources (a new source
 * past the cap is not remembered: nothing is LO-locked there). Non-finite input is never logged and
 * never LO-locked.
 */

export interface LoSighting {
	sourceId: string
	/** Tuned centre of the sighting's epoch (Hz). */
	tunedHz: number
	/** Sample rate of the sighting's epoch (Hz). */
	sampleRateHz: number
	/** Measured centre (Hz). */
	centreHz: number
	/** Occupied bandwidth (Hz); non-finite or non-positive counts as the width floor. */
	obwHz: number
	/** A steady narrow line; undefined while too young to tell. */
	steady: boolean | undefined
	/** Wall clock of the sighting (ms). */
	atMs: number
}

export interface LoLockedOptions {
	offsetHz: number
	minSeparationHz: number
	widthRatio: number
	widthFloorHz: number
	/** Usable fraction of the sample rate (the window is ± fraction × rate / 2). */
	usableFraction: number
	dcGuardHz: number
	dwellMs: number
	ttlMs: number
	dwellsPerSource: number
	linesPerDwell: number
	recordsPerSource: number
	centresPerRecord: number
	offsetsPerSource: number
	sourcesMax: number
}

interface Line {
	rfHz: number
	widthHz: number
	steady: boolean | undefined
	/** A sighting of it had evidence of a real signal (sticky). */
	real: boolean
}

interface Dwell {
	tunedHz: number
	rateHz: number
	firstMs: number
	lastMs: number
	lines: Line[]
	/** More lines than the bound: the log is incomplete and proves no absence. */
	overflow: boolean
}

interface CentreEntry {
	tunedHz: number
	rateHz: number
	offsetHz: number
	widthHz: number
	steady: boolean | undefined
	atMs: number
}

interface OffsetEntry {
	offsetHz: number
	rateHz: number
	atMs: number
}

interface SourceState {
	/** Oldest first; the last is the current dwell. */
	dwells: Dwell[]
	/** Insertion order = least recently sighted first. */
	records: Map<string, CentreEntry[]>
	learned: OffsetEntry[]
	revoked: OffsetEntry[]
	suppressed: number
}

export type LoVerdict = "clear" | "pending" | "locked"

export interface LoCheck {
	verdict: LoVerdict
	/** Noted, eligible records that were the spur's earlier sightings (only when locked). */
	partners: string[]
}

const CLEAR: LoCheck = Object.freeze({
	verdict: "clear",
	partners: Object.freeze([]) as unknown as string[],
})
const PENDING: LoCheck = Object.freeze({
	verdict: "pending",
	partners: Object.freeze([]) as unknown as string[],
})

export class LoLockedSpurs {
	private readonly sources = new Map<string, SourceState>()

	constructor(private readonly opts: LoLockedOptions) {}

	/**
	 * Logs a sighting in its source's current dwell (a new dwell when the centre or rate changed).
	 * `real`: the sighting had evidence of a real signal (a decode, a proof, an operator's record).
	 * Applies the revocation rules.
	 */
	observe(s: LoSighting, real: boolean): void {
		if (!finite(s)) return
		const st = this.state(s.sourceId, true)
		if (st === undefined) return
		this.expire(st, s.atMs)
		const offset = s.centreHz - s.tunedHz
		if (real || s.steady === false)
			this.revokeMatching(st, s.sampleRateHz, offset, s.atMs)
		let cur = st.dwells.at(-1)
		if (cur === undefined || !this.sameCentre(cur, s)) {
			cur = {
				tunedHz: s.tunedHz,
				rateHz: s.sampleRateHz,
				firstMs: s.atMs,
				lastMs: s.atMs,
				lines: [],
				overflow: false,
			}
			st.dwells.push(cur)
			while (st.dwells.length > this.opts.dwellsPerSource) st.dwells.shift()
		}
		if (s.atMs > cur.lastMs) cur.lastMs = s.atMs
		const width = this.width(s.obwHz)
		const line = cur.lines.find(
			l => Math.abs(l.rfHz - s.centreHz) <= this.opts.offsetHz,
		)
		if (line !== undefined) {
			line.rfHz = s.centreHz
			line.widthHz = width
			line.steady = s.steady
			line.real ||= real
			return
		}
		if (cur.lines.length >= this.opts.linesPerDwell) {
			cur.overflow = true
			return
		}
		cur.lines.push({ rfHz: s.centreHz, widthHz: width, steady: s.steady, real })
		// One RF line seen from two centres is a real emitter: an offset of it that was learned is
		// revoked.
		for (const d of st.dwells) {
			if (d === cur || d.rateHz !== s.sampleRateHz || this.sameCentre(d, s))
				continue
			for (const l of d.lines)
				if (Math.abs(l.rfHz - s.centreHz) <= this.opts.offsetHz) {
					this.revokeLearned(st, s.sampleRateHz, offset, s.atMs)
					this.revokeLearned(st, d.rateHz, l.rfHz - d.tunedHz, s.atMs)
				}
		}
	}

	/** Remembers that record `id` was sighted at `s` (its partner candidates). */
	note(id: string, s: LoSighting): void {
		if (!finite(s)) return
		const st = this.state(s.sourceId, true)
		if (st === undefined) return
		const entry: CentreEntry = {
			tunedHz: s.tunedHz,
			rateHz: s.sampleRateHz,
			offsetHz: s.centreHz - s.tunedHz,
			widthHz: this.width(s.obwHz),
			steady: s.steady,
			atMs: s.atMs,
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

	/** Learned spur offsets of a source (Hz from the tuned centre), oldest first; expired ones not. */
	learnedOffsets(sourceId: string, atMs?: number): number[] {
		const st = this.sources.get(sourceId)
		if (st === undefined) return []
		return st.learned
			.filter(e => atMs === undefined || atMs - e.atMs <= this.opts.ttlMs)
			.map(e => e.offsetHz)
	}

	/** LO-locked sightings of a source so far (each locked `check` counts once). */
	suppressed(sourceId: string): number {
		return this.sources.get(sourceId)?.suppressed ?? 0
	}

	/**
	 * Is `s` an LO-locked spur? See the module comment. Call before `observe` for the same sighting.
	 * `eligible` filters the noted records that may stand as the spur's earlier sightings.
	 */
	check(s: LoSighting, eligible: (id: string) => boolean): LoCheck {
		if (!finite(s) || s.steady === false) return CLEAR
		const st = this.state(s.sourceId, false)
		if (st === undefined) return CLEAR
		this.expire(st, s.atMs)
		const offset = s.centreHz - s.tunedHz
		const rate = s.sampleRateHz
		if (this.matches(st.revoked, rate, offset)) return CLEAR
		const width = this.width(s.obwHz)
		const last = st.dwells.at(-1)
		const cur =
			last !== undefined && this.sameCentre(last, s) ? last : undefined
		const curLong =
			cur !== undefined && s.atMs - cur.firstMs >= this.opts.dwellMs
		if (cur?.overflow === true) return CLEAR
		let pending = false
		const partnerCentres: Dwell[] = []
		for (const d of st.dwells) {
			if (
				d === cur ||
				d.rateHz !== rate ||
				this.sameCentre(d, s) ||
				d.overflow ||
				d.lastMs - d.firstMs < this.opts.dwellMs ||
				s.atMs - d.lastMs > this.opts.ttlMs
			)
				continue
			// F (this sighting) lay in D's window and nothing was there.
			if (
				!this.inWindow(s.centreHz, width, d.tunedHz, rate) ||
				this.sighted(d, s.centreHz)
			)
				continue
			for (const l of d.lines) {
				if (
					l.steady !== true ||
					l.real ||
					Math.abs(l.rfHz - d.tunedHz - offset) > this.opts.offsetHz ||
					!this.widthsAgree(l.widthHz, width)
				)
					continue
				// Its position Cp + Δ lies in this window and is empty here.
				if (!this.inWindow(l.rfHz, l.widthHz, s.tunedHz, rate)) continue
				if (cur !== undefined && this.sighted(cur, l.rfHz)) continue
				if (curLong && s.steady === true) partnerCentres.push(d)
				else pending = true
				break
			}
		}
		if (partnerCentres.length === 0) return pending ? PENDING : CLEAR
		const partners: string[] = []
		for (const [id, list] of st.records) {
			let there = false
			let here = false
			for (const e of list) {
				if (Math.abs(e.tunedHz - s.tunedHz) < this.opts.minSeparationHz) {
					here = true
					break
				}
				if (
					e.rateHz === rate &&
					e.steady === true &&
					s.atMs - e.atMs <= this.opts.ttlMs &&
					Math.abs(e.offsetHz - offset) <= this.opts.offsetHz &&
					this.widthsAgree(e.widthHz, width) &&
					partnerCentres.some(
						d => Math.abs(e.tunedHz - d.tunedHz) < this.opts.minSeparationHz,
					)
				)
					there = true
			}
			if (there && !here && eligible(id)) partners.push(id)
		}
		const known = st.learned.find(
			e =>
				e.rateHz === rate &&
				Math.abs(e.offsetHz - offset) <= this.opts.offsetHz,
		)
		if (known !== undefined) known.atMs = s.atMs
		else {
			st.learned.push({ offsetHz: offset, rateHz: rate, atMs: s.atMs })
			while (st.learned.length > this.opts.offsetsPerSource) st.learned.shift()
		}
		st.suppressed++
		return { verdict: "locked", partners }
	}

	private sameCentre(d: Dwell, s: LoSighting): boolean {
		return (
			d.rateHz === s.sampleRateHz &&
			Math.abs(d.tunedHz - s.tunedHz) < this.opts.minSeparationHz
		)
	}

	/** The line (centre ± width / 2) lies in the usable window of `tunedHz`, outside the DC guard. */
	private inWindow(
		rfHz: number,
		widthHz: number,
		tunedHz: number,
		rateHz: number,
	): boolean {
		const off = Math.abs(rfHz - tunedHz)
		const half = (this.opts.usableFraction * rateHz) / 2
		return off + widthHz / 2 <= half && off > this.opts.dcGuardHz
	}

	/** Something was sighted at `rfHz` in the dwell (a line whose width, plus tolerance, covers it). */
	private sighted(d: Dwell, rfHz: number): boolean {
		return d.lines.some(
			l => Math.abs(l.rfHz - rfHz) <= l.widthHz / 2 + this.opts.offsetHz,
		)
	}

	private matches(
		list: OffsetEntry[],
		rateHz: number,
		offset: number,
	): boolean {
		return list.some(
			e =>
				e.rateHz === rateHz &&
				Math.abs(e.offsetHz - offset) <= this.opts.offsetHz,
		)
	}

	/** A learned offset matching `offset` is revoked: dropped, and no lock there for the TTL. */
	private revokeLearned(
		st: SourceState,
		rateHz: number,
		offset: number,
		atMs: number,
	): void {
		if (!this.matches(st.learned, rateHz, offset)) return
		this.revokeMatching(st, rateHz, offset, atMs)
	}

	private revokeMatching(
		st: SourceState,
		rateHz: number,
		offset: number,
		atMs: number,
	): void {
		const before = st.learned.length
		st.learned = st.learned.filter(
			e =>
				!(
					e.rateHz === rateHz &&
					Math.abs(e.offsetHz - offset) <= this.opts.offsetHz
				),
		)
		// Only an offset that was learned or could lock is worth remembering as revoked: one with a
		// steady unproven line in a past dwell.
		const candidate =
			before !== st.learned.length ||
			st.dwells.some(
				d =>
					d.rateHz === rateHz &&
					d.lines.some(
						l =>
							l.steady === true &&
							!l.real &&
							Math.abs(l.rfHz - d.tunedHz - offset) <= this.opts.offsetHz,
					),
			)
		if (!candidate) return
		const hit = st.revoked.find(
			e =>
				e.rateHz === rateHz &&
				Math.abs(e.offsetHz - offset) <= this.opts.offsetHz,
		)
		if (hit !== undefined) hit.atMs = atMs
		else {
			st.revoked.push({ offsetHz: offset, rateHz, atMs })
			while (st.revoked.length > this.opts.offsetsPerSource) st.revoked.shift()
		}
	}

	private expire(st: SourceState, atMs: number): void {
		const ttl = this.opts.ttlMs
		while (st.dwells.length > 1 && atMs - st.dwells[0]!.lastMs > ttl)
			st.dwells.shift()
		const last = st.dwells.at(-1)
		if (last !== undefined && atMs - last.lastMs > ttl) st.dwells.pop()
		if (st.learned.some(e => atMs - e.atMs > ttl))
			st.learned = st.learned.filter(e => atMs - e.atMs <= ttl)
		if (st.revoked.some(e => atMs - e.atMs > ttl))
			st.revoked = st.revoked.filter(e => atMs - e.atMs <= ttl)
	}

	private state(sourceId: string, create: boolean): SourceState | undefined {
		let st = this.sources.get(sourceId)
		if (
			st === undefined &&
			create &&
			this.sources.size < this.opts.sourcesMax
		) {
			st = {
				dwells: [],
				records: new Map(),
				learned: [],
				revoked: [],
				suppressed: 0,
			}
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
		Number.isFinite(s.sampleRateHz) &&
		Number.isFinite(s.atMs) &&
		s.tunedHz > 0 &&
		s.sampleRateHz > 0
	)
}
