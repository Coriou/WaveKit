/**
 * LO-locked spurs from sightings (memory only). A receiver spur at a fixed offset from the tuned
 * centre (a clock harmonic mixed with the LO, a reference leak) moves with every retune: tuned at
 * C1 it shows at F1 = C1 + Δ, tuned at C2 at F2 = C2 + Δ. A real emitter stays at its RF frequency.
 * Two real emitters can sit at one offset too, so the answer is only ever a flag (the caller hides
 * the record by default and never deletes it), and when unsure the answer is "clear" (discover).
 *
 * Per source, every sighting the caller reports (`observe`) is logged in its dwell: the run of
 * ticks and sightings under one tuned centre and sample rate, with the RF lines seen there. The
 * caller ticks every block (`tick`) so a dwell's length is the time the tuner stayed, and reports
 * receiver mask lines (`observeMask`: the engine's provisional, comb and baseband spur lines, which
 * hide a line from tracking once it has been on for 30 s) as steady lines once the dwell is
 * `maskSettleMs` old.
 *
 * An offset Δ (per sample rate) is learned (`check`) when, among the logged dwells within the TTL:
 * - a steady narrow line with no evidence of a real signal sat at centre + Δ (within `offsetHz`,
 *   widths within `widthRatio` of the checked sighting's) under at least `minCentres` distinct
 *   tuned centres (pairwise at least `minSeparationHz` apart; revisits count once), with no
 *   requirement that one centre's window covers another's position;
 * - no such line's RF position was sighted from another centre whose usable window covered it
 *   (one RF line seen from two centres is a real emitter);
 * - no line at Δ under any dwell was proven real or seen as not steady; and
 * - no complete dwell (at least `dwellMs` long, line log complete, Δ inside its usable window and
 *   outside its DC guard) saw nothing at centre + Δ (a miss: a spur is under every centre).
 * A learned offset then answers "locked" for any steady sighting at it (not seen from another
 * centre at its RF position) until it expires (`ttlMs` after it was last re-proven) or is revoked
 * (no lock there for `ttlMs`) on contradictory evidence: a sighting with evidence of a real signal
 * at it, a sighting at it that is not a steady narrow line, or one RF line seen from two centres
 * where one of its offsets is learned. Revocations and expiries are reported (`takeRevoked`) so
 * the caller can lift the flags it set at that offset; a flag stands only while its offset is
 * learned (`isLearned`).
 *
 * Records (`note`): only a record whose whole history this tracker saw is remembered: it enters
 * when created by a sighting with a tuned centre (`born`), and leaves for good (`taint`) when any
 * part of its history is unknown or contradictory (a sighting without a tuned centre, a merge, a
 * sighting that is no steady line, a replaced entry that was not the same steady line, an entry
 * dropped by the per-record bound).
 * A record restored from disk was never born here and is never remembered. A lock names as
 * partners the remembered records sighted only as a steady narrow line at Δ, all within the TTL
 * (`eligible` filters them further). A record also sighted at another offset is one RF line seen
 * from two centres and is never a partner.
 *
 * Bounds (constructor options): dwells per source (oldest dropped), lines per dwell (past it the
 * dwell proves no absence), records per source (least recently sighted dropped: never a partner
 * again, counted in `historyDropped`), centres per record (past it the record leaves), learned and
 * revoked offsets per source (oldest dropped) and sources (a new source past the cap is not
 * remembered: nothing is LO-locked there). Non-finite input is never logged and never LO-locked.
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
	/** Distinct tuned centres a steady line at one offset must be seen from. */
	minCentres: number
	/** A mask line counts in a dwell only this long after the dwell began. */
	maskSettleMs: number
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
	sourceId: string
	/** Oldest first; the last is the current dwell. */
	dwells: Dwell[]
	/** Records whose whole history was seen; insertion order = least recently sighted first. */
	records: Map<string, CentreEntry[]>
	learned: OffsetEntry[]
	revoked: OffsetEntry[]
	locked: number
	historyDropped: number
}

export type LoVerdict = "clear" | "locked"

export interface LoCheck {
	verdict: LoVerdict
	/** Remembered, eligible records that were the spur's sightings (only when locked). */
	partners: string[]
	/** Distinct tuned centres the line was seen from (only when locked; 0 for a learned offset). */
	centres: number
}

export interface LoRevocation {
	sourceId: string
	rateHz: number
	offsetHz: number
}

const CLEAR: LoCheck = Object.freeze({
	verdict: "clear",
	partners: Object.freeze([]) as unknown as string[],
	centres: 0,
})

const NO_REVOCATIONS: readonly LoRevocation[] = Object.freeze([])

export class LoLockedSpurs {
	private readonly sources = new Map<string, SourceState>()
	private revocations: LoRevocation[] = []

	constructor(private readonly opts: LoLockedOptions) {}

	/** The tuner is at `tunedHz` / `rateHz` now (one block): extends or opens the current dwell. */
	tick(sourceId: string, tunedHz: number, rateHz: number, atMs: number): void {
		if (
			!Number.isFinite(tunedHz) ||
			!Number.isFinite(rateHz) ||
			!Number.isFinite(atMs) ||
			tunedHz <= 0 ||
			rateHz <= 0
		)
			return
		const st = this.state(sourceId, true)
		if (st === undefined) return
		this.expire(st, atMs)
		this.dwellAt(st, tunedHz, rateHz, atMs)
	}

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
			this.revokeMatching(s.sourceId, st, s.sampleRateHz, offset, s.atMs)
		const cur = this.dwellAt(st, s.tunedHz, s.sampleRateHz, s.atMs)
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
			if (
				d === cur ||
				d.rateHz !== s.sampleRateHz ||
				!this.apart(d.tunedHz, s.tunedHz)
			)
				continue
			for (const l of d.lines)
				if (Math.abs(l.rfHz - s.centreHz) <= this.opts.offsetHz) {
					this.revokeLearned(s.sourceId, st, s.sampleRateHz, offset, s.atMs)
					this.revokeLearned(
						s.sourceId,
						st,
						d.rateHz,
						l.rfHz - d.tunedHz,
						s.atMs,
					)
				}
		}
	}

	/**
	 * A receiver mask line at `s` (steady, never real): logged like a steady sighting once the
	 * current dwell at its centre is `maskSettleMs` old. Returns whether it was logged.
	 */
	observeMask(s: LoSighting): boolean {
		if (!finite(s)) return false
		const st = this.state(s.sourceId, false)
		const cur = st?.dwells.at(-1)
		if (
			cur === undefined ||
			cur.rateHz !== s.sampleRateHz ||
			this.apart(cur.tunedHz, s.tunedHz) ||
			s.atMs - cur.firstMs < this.opts.maskSettleMs
		)
			return false
		this.observe({ ...s, steady: true }, false)
		return true
	}

	/**
	 * Remembers that record `id` was sighted at `s`. `born`: this sighting created the record, so
	 * its whole history is seen from here; a record not born here is never remembered.
	 */
	note(id: string, s: LoSighting, born: boolean): void {
		if (!finite(s)) {
			this.taint(id)
			return
		}
		// A measurement that is no steady line (modulated, bursty, too wide) anywhere in a record's
		// lifetime: never a spur's record again.
		if (s.steady === false) {
			this.taint(id)
			return
		}
		const st = this.state(s.sourceId, true)
		if (st === undefined) return
		const known = st.records.get(id)
		if (known === undefined && !born) return
		const entry: CentreEntry = {
			tunedHz: s.tunedHz,
			rateHz: s.sampleRateHz,
			offsetHz: s.centreHz - s.tunedHz,
			widthHz: this.width(s.obwHz),
			steady: s.steady,
			atMs: s.atMs,
		}
		const list = known ?? []
		st.records.delete(id)
		const same = list.findIndex(
			e =>
				e.rateHz === s.sampleRateHz &&
				Math.abs(e.tunedHz - s.tunedHz) < this.opts.minSeparationHz,
		)
		if (same >= 0) {
			const prev = list[same]
			if (prev !== undefined && !this.sameLine(prev, entry)) {
				this.taint(id)
				return
			}
			list.splice(same, 1)
		}
		list.push(entry)
		if (list.length > this.opts.centresPerRecord) {
			this.taint(id)
			return
		}
		st.records.set(id, list)
		while (st.records.size > this.opts.recordsPerSource) {
			const oldest = st.records.keys().next()
			if (oldest.done === true) break
			st.records.delete(oldest.value)
			st.historyDropped++
		}
	}

	/** Record `id`'s history is unknown or contradictory: never a partner again. */
	taint(id: string): void {
		for (const st of this.sources.values()) st.records.delete(id)
	}

	/** Drops a record (deleted or merged away). */
	forget(id: string): void {
		this.taint(id)
	}

	/** Is `id`'s whole history known here (a possible partner)? */
	remembers(sourceId: string, id: string): boolean {
		return this.sources.get(sourceId)?.records.has(id) === true
	}

	/** Is `id` remembered under any source? */
	remembersAny(id: string): boolean {
		for (const st of this.sources.values()) if (st.records.has(id)) return true
		return false
	}

	/**
	 * Is `offsetHz` (within `offsetHz` tolerance) a learned, unexpired offset of the source at
	 * `rateHz` now? A flag set at an offset stands only while this holds.
	 */
	isLearned(
		sourceId: string,
		rateHz: number,
		offsetHz: number,
		atMs: number,
	): boolean {
		const st = this.sources.get(sourceId)
		if (st === undefined) return false
		for (const e of st.learned)
			if (
				e.rateHz === rateHz &&
				Math.abs(e.offsetHz - offsetHz) <= this.opts.offsetHz &&
				atMs - e.atMs <= this.opts.ttlMs
			)
				return true
		return false
	}

	/** Records dropped by the per-source bound so far (diagnostics: they are never flagged). */
	historyDropped(sourceId: string): number {
		return this.sources.get(sourceId)?.historyDropped ?? 0
	}

	/** Offsets revoked or expired since the last call (the caller lifts its flags there). */
	takeRevoked(): readonly LoRevocation[] {
		// Called once per block summary: no revocation returns one shared frozen array (no alloc).
		if (this.revocations.length === 0) return NO_REVOCATIONS
		const out = this.revocations
		this.revocations = []
		return out
	}

	/** A replaced entry agrees with its successor: same steady line (offset, width, steadiness). */
	private sameLine(a: CentreEntry, b: CentreEntry): boolean {
		return (
			a.steady !== false &&
			b.steady !== false &&
			a.rateHz === b.rateHz &&
			Math.abs(a.offsetHz - b.offsetHz) <= this.opts.offsetHz &&
			this.widthsAgree(a.widthHz, b.widthHz)
		)
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
		return this.sources.get(sourceId)?.locked ?? 0
	}

	/**
	 * Is `s` an LO-locked spur? See the module comment. Call after `observe` (and `note`) for the
	 * same sighting. `eligible` filters the remembered records that may be flagged with it.
	 */
	check(s: LoSighting, eligible: (id: string) => boolean): LoCheck {
		if (!finite(s) || s.steady !== true) return CLEAR
		const st = this.state(s.sourceId, false)
		if (st === undefined) return CLEAR
		this.expire(st, s.atMs)
		const offset = s.centreHz - s.tunedHz
		const rate = s.sampleRateHz
		if (this.matches(st.revoked, rate, offset)) return CLEAR
		const width = this.width(s.obwHz)
		// This very position seen from another centre whose window covered it: a real emitter.
		if (this.seenElsewhere(st, s.centreHz, s.tunedHz, rate)) return CLEAR
		const learned = st.learned.find(
			e =>
				e.rateHz === rate &&
				Math.abs(e.offsetHz - offset) <= this.opts.offsetHz,
		)
		let centres = 0
		const evidence = this.evidence(st, offset, width, rate, s.atMs)
		if (evidence === "contradicted") return CLEAR
		if (evidence >= this.opts.minCentres) {
			centres = evidence
			if (learned !== undefined) learned.atMs = s.atMs
			else {
				st.learned.push({ offsetHz: offset, rateHz: rate, atMs: s.atMs })
				while (st.learned.length > this.opts.offsetsPerSource)
					st.learned.shift()
			}
		} else if (learned === undefined) return CLEAR
		const partners: string[] = []
		for (const [id, list] of st.records) {
			if (list.length === 0) continue
			let all = true
			for (const e of list)
				if (
					e.rateHz !== rate ||
					e.steady !== true ||
					s.atMs - e.atMs > this.opts.ttlMs ||
					Math.abs(e.offsetHz - offset) > this.opts.offsetHz ||
					!this.widthsAgree(e.widthHz, width)
				) {
					all = false
					break
				}
			if (all && eligible(id)) partners.push(id)
		}
		st.locked++
		return { verdict: "locked", partners, centres }
	}

	/**
	 * The dwell evidence for a spur at `offset`: the number of distinct centres whose dwells hold a
	 * steady unproven line at it (not seen from another centre), or "contradicted" when a line at
	 * it was proven real or not steady, a line at it was seen from another centre, or a complete
	 * dwell saw nothing there.
	 */
	private evidence(
		st: SourceState,
		offset: number,
		width: number,
		rate: number,
		atMs: number,
	): number | "contradicted" {
		const hitCentres: number[] = []
		for (const d of st.dwells) {
			if (d.rateHz !== rate || atMs - d.lastMs > this.opts.ttlMs) continue
			const pos = d.tunedHz + offset
			let found: Line | undefined
			for (const l of d.lines)
				if (Math.abs(l.rfHz - pos) <= this.opts.offsetHz) {
					found = l
					break
				}
			if (found === undefined) {
				if (
					!d.overflow &&
					d.lastMs - d.firstMs >= this.opts.dwellMs &&
					this.inWindow(pos, width, d.tunedHz, rate) &&
					!this.sighted(d, pos)
				)
					return "contradicted"
				continue
			}
			if (found.real || found.steady === false) return "contradicted"
			if (found.steady !== true || !this.widthsAgree(found.widthHz, width))
				continue
			if (this.seenElsewhere(st, found.rfHz, d.tunedHz, rate))
				return "contradicted"
			if (!hitCentres.some(c => !this.apart(c, d.tunedHz)))
				hitCentres.push(d.tunedHz)
		}
		return hitCentres.length
	}

	/** Something was sighted at `rfHz` from a centre apart from `tunedHz` whose window covered it. */
	private seenElsewhere(
		st: SourceState,
		rfHz: number,
		tunedHz: number,
		rate: number,
	): boolean {
		for (const d of st.dwells)
			if (
				d.rateHz === rate &&
				this.apart(d.tunedHz, tunedHz) &&
				this.inWindow(rfHz, 0, d.tunedHz, rate) &&
				this.sighted(d, rfHz)
			)
				return true
		return false
	}

	private dwellAt(
		st: SourceState,
		tunedHz: number,
		rateHz: number,
		atMs: number,
	): Dwell {
		let cur = st.dwells.at(-1)
		if (
			cur === undefined ||
			cur.rateHz !== rateHz ||
			this.apart(cur.tunedHz, tunedHz)
		) {
			cur = {
				tunedHz,
				rateHz,
				firstMs: atMs,
				lastMs: atMs,
				lines: [],
				overflow: false,
			}
			st.dwells.push(cur)
			while (st.dwells.length > this.opts.dwellsPerSource) st.dwells.shift()
		}
		if (atMs > cur.lastMs) cur.lastMs = atMs
		return cur
	}

	private apart(a: number, b: number): boolean {
		return Math.abs(a - b) >= this.opts.minSeparationHz
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
		sourceId: string,
		st: SourceState,
		rateHz: number,
		offset: number,
		atMs: number,
	): void {
		if (!this.matches(st.learned, rateHz, offset)) return
		this.revokeMatching(sourceId, st, rateHz, offset, atMs)
	}

	private revokeMatching(
		sourceId: string,
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
		const wasLearned = before !== st.learned.length
		// Only an offset that was learned or could lock is worth remembering as revoked: one with a
		// steady unproven line in a past dwell.
		const candidate =
			wasLearned ||
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
		this.report(sourceId, rateHz, offset)
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

	/**
	 * A revoked or expired offset, for the caller to lift its flags there. Bounded at
	 * `offsetsPerSource` × 4 between two `takeRevoked` calls (the caller drains it after every
	 * ingest and block); past it a flag still lifts when read (`isLearned`).
	 */
	private report(sourceId: string, rateHz: number, offsetHz: number): void {
		if (this.revocations.length < this.opts.offsetsPerSource * 4)
			this.revocations.push({ sourceId, rateHz, offsetHz })
	}

	/** Runs every block: plain loops, no allocation, nothing done when nothing is due. */
	private expire(st: SourceState, atMs: number): void {
		const ttl = this.opts.ttlMs
		const dwells = st.dwells
		while (dwells.length > 1 && atMs - dwells[0]!.lastMs > ttl) dwells.shift()
		const last = dwells.length > 0 ? dwells[dwells.length - 1] : undefined
		if (last !== undefined && atMs - last.lastMs > ttl) dwells.pop()
		const learned = st.learned
		let w = 0
		for (let r = 0; r < learned.length; r++) {
			const e = learned[r]!
			if (atMs - e.atMs <= ttl) learned[w++] = e
			else this.report(st.sourceId, e.rateHz, e.offsetHz)
		}
		learned.length = w
		const revoked = st.revoked
		w = 0
		for (let r = 0; r < revoked.length; r++) {
			const e = revoked[r]!
			if (atMs - e.atMs <= ttl) revoked[w++] = e
		}
		revoked.length = w
	}

	private state(sourceId: string, create: boolean): SourceState | undefined {
		let st = this.sources.get(sourceId)
		if (
			st === undefined &&
			create &&
			this.sources.size < this.opts.sourcesMax
		) {
			st = {
				sourceId,
				dwells: [],
				records: new Map(),
				learned: [],
				revoked: [],
				locked: 0,
				historyDropped: 0,
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
