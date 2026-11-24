/**
 * Copy (ghost) detection over a recorder's kept analog files (copy-fingerprint.ts for the
 * metric, copy-intermod.ts for the evidence): a ring of the recently finalized files' fingerprints
 * per source, and the one group record of which file is a copy of which root.
 *
 * pass(A, B): same source and epoch, the overlap rule, the same audio (sameAudio), and the WEAKER
 * of the two (total order below) carries evidence of its own: intermod evidence, or a frequency
 * off its band's raster. Level difference is never evidence (it only ranks), and an unknown
 * raster (no scan range covers the file) gives none: same audio without evidence changes
 * nothing (copySameAudioNoEvidence).
 *
 * Total order (restart-stable, transitive): stronger = higher round(snrDb) (whole dB), then the
 * earlier startSample, then the lexicographically smaller key.
 *
 * Invariant: every copy M of a root R passed against R DIRECTLY when last written and is weaker
 * than R; a copy is never attached through another copy, two roots are never merged, and a
 * copy's `of` always names a root. A new file N is compared only with the ring's roots
 * (candidates and originals), never with copies:
 * - no root passes: N is a candidate;
 * - else R* = the strongest root that passes (others stay roots: copyMultiRoot);
 * - N weaker than R*: N becomes a copy of R*;
 * - N stronger: N becomes the root, R* a copy of N, and each copy M of R* still in the ring is
 *   re-pointed to N only when pass(M, N) holds directly (score and evidence recomputed against
 *   N), else M becomes a candidate again (its copy.json removed: copyUnlinked).
 * forget(R) (the store removed R's operation): a copy or candidate leaves the ring; a root's
 * strongest remaining member M0 in the ring becomes the root (its copy.json removed) and every
 * other member is a copy of M0 only when pass(M, M0) holds, else a candidate. An evicted member
 * (out of the ring) is never rewritten: its `of` still names the root it passed against, and
 * the catalogue reads a named root that is gone or itself a copy as no copy.
 *
 * Work (bounds, arithmetic): `kept` and `forget` enqueue a job (at most COPY_QUEUE_MAX = 256,
 * the oldest dropped: copyQueueDropped; a dropped job only loses a link). Jobs run one at a time
 * on the recorder's thread; a job's comparisons run COPY_COMPARE_PER_TICK = 4 per event-loop turn
 * (setImmediate) against a ring no other job changes meanwhile. A job compares at most
 * COPY_RING_MAX − 1 = 63 roots plus at most 63 re-points: 126 comparisons, 32 turns. The ring
 * holds, per source, the files whose end is within COPY_HORIZON_MS (146 s: the 120 s file limit
 * + the 26 s late-verdict grace) of the newest end on it, at most COPY_RING_MAX = 64 (oldest out:
 * copyRingOverflow); 64 × (3 750 + 469) B ≈ 270 KB per source at most.
 *
 * A fingerprint enters the ring only once its operation settled `finalized` (a discarded,
 * aborted or failed file never does, and nothing is written for it). Writes (`write`) go to the
 * store, which writes or removes the file's copy.json under its lock; a skipped or failed write
 * leaves the file served as before.
 */
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import {
	compareEnvelopes,
	overlapAllowed,
	sameAudio,
	type CopyPlacement,
	type CopyScore,
} from "./copy-fingerprint.js"
import {
	COPY_HORIZON_MS,
	type IntermodEvidence,
	type RasterFit,
} from "./copy-intermod.js"

export const COPY_RING_MAX = 64
export const COPY_QUEUE_MAX = 256
export const COPY_COMPARE_PER_TICK = 4

export type CopyEvidence = "intermod" | "off-raster"

/** A kept file's fingerprint (built by the recorder when the file is kept). */
export interface CopyFingerprint extends CopyPlacement {
	readonly operationId: string
	readonly sourceId: string
	readonly epoch: number
	/** The input sample rate (Hz) of `startSample`. */
	readonly rateHz: number
	/** The demodulated centre (targetHz). */
	readonly hz: number
	/** The file's strongest joined-track SNR (dB): ranks only. */
	readonly snrDb: number
	readonly raster: RasterFit
	/** Captured when the file ended (copy-intermod.ts); null: none. */
	readonly intermod: IntermodEvidence | null
}

/** What the store persists for a copy (copy-facts.ts adds version, operationId and time). */
export interface CopyRecord {
	readonly of: { readonly key: string; readonly operationId: string }
	readonly score: {
		readonly r: number
		readonly z: number
		readonly neff: number
		readonly lagFrames: number
	}
	readonly evidence: readonly CopyEvidence[]
}

/** The operation's settled receipt, as far as the detector reads it. */
export interface CopySettled {
	readonly outcome: string
	readonly alias: string | null
}

export interface CopyDetectorDeps {
	/** Writes (`copy`) or removes (null) the operation's copy.json; never throws synchronously. */
	write(operationId: string, copy: CopyRecord | null): Promise<unknown>
	logger: Logger
	/** Next-turn scheduler; default setImmediate. */
	schedule?(run: () => void): void
	/** Monotonic ms for copyComparisonMsMax; default performance.now. */
	clock?(): number
}

export interface CopyCounters {
	copyCompared: number
	copyMarked: number
	copySameAudioNoEvidence: number
	copyIneligible: number
	copyMultiRoot: number
	copyUnlinked: number
	copyRingOverflow: number
	copyQueueDropped: number
	copyComparisonMsMax: number
}

type State =
	| { readonly kind: "root" }
	| { readonly kind: "copy"; readonly of: Entry }

interface Entry {
	readonly fp: CopyFingerprint
	readonly key: string
	state: State
	readonly end: number
}

interface KeptJob {
	readonly kind: "kept"
	readonly fp: CopyFingerprint
	readonly key: string
}
type Job = KeptJob | { readonly kind: "forget"; readonly operationId: string }

interface Passed {
	readonly ok: true
	readonly score: CopyScore
	readonly evidence: CopyEvidence[]
}
type PassResult = Passed | { readonly ok: false }

/** The file's own evidence of being a copy: intermod and/or off its raster. */
export function evidenceOf(fp: CopyFingerprint): CopyEvidence[] {
	const out: CopyEvidence[] = []
	if (fp.intermod !== null) out.push("intermod")
	if (fp.raster === "off") out.push("off-raster")
	return out
}

/** The total order: true when `a` is stronger than `b`. */
export function strongerThan(
	a: { readonly fp: CopyFingerprint; readonly key: string },
	b: { readonly fp: CopyFingerprint; readonly key: string },
): boolean {
	const sa = Math.round(a.fp.snrDb)
	const sb = Math.round(b.fp.snrDb)
	if (sa !== sb) return sa > sb
	if (a.fp.startSample !== b.fp.startSample)
		return a.fp.startSample < b.fp.startSample
	return a.key < b.key
}

const round = (v: number, places: number): number => {
	const f = 10 ** places
	return Math.round(v * f) / f
}

export class CopyDetector {
	private readonly log: Logger
	private readonly rings = new Map<string, Entry[]>()
	private readonly queue: Job[] = []
	private running = false
	private compared = 0
	private readonly schedule: (run: () => void) => void
	private readonly clock: () => number
	private readonly counters: CopyCounters = {
		copyCompared: 0,
		copyMarked: 0,
		copySameAudioNoEvidence: 0,
		copyIneligible: 0,
		copyMultiRoot: 0,
		copyUnlinked: 0,
		copyRingOverflow: 0,
		copyQueueDropped: 0,
		copyComparisonMsMax: 0,
	}
	/** Resolves when the queue is empty (tests and stop). */
	private idleWaiters: (() => void)[] = []

	constructor(private readonly deps: CopyDetectorDeps) {
		this.log = createComponentLogger(deps.logger, "CopyDetector")
		this.schedule = deps.schedule ?? (run => void setImmediate(run))
		this.clock = deps.clock ?? (() => performance.now())
	}

	/**
	 * A kept file: its fingerprint joins the ring once `settled` resolves `finalized` (any other
	 * outcome, or a rejection, drops it: nothing is written).
	 */
	kept(fp: CopyFingerprint, settled: Promise<CopySettled>): void {
		settled.then(
			receipt => {
				if (receipt.outcome !== "finalized" || receipt.alias === null) return
				this.enqueue({ kind: "kept", fp, key: `scan:${receipt.alias}` })
			},
			() => undefined,
		)
	}

	/** The store removed this operation (retention, a delete, recovery). */
	forget(operationId: string): void {
		this.enqueue({ kind: "forget", operationId })
	}

	status(): Readonly<CopyCounters> {
		return { ...this.counters }
	}

	/** Resolves once no job is queued or running. */
	idle(): Promise<void> {
		if (!this.running && this.queue.length === 0) return Promise.resolve()
		return new Promise(resolve => this.idleWaiters.push(resolve))
	}

	/** The detector's view of a key (tests, diagnostics): root, copy of a key, or absent. */
	stateOf(key: string): { kind: "root" } | { kind: "copy"; of: string } | null {
		for (const ring of this.rings.values())
			for (const e of ring)
				if (e.key === key)
					return e.state.kind === "root"
						? { kind: "root" }
						: { kind: "copy", of: e.state.of.key }
		return null
	}

	private enqueue(job: Job): void {
		if (this.queue.length >= COPY_QUEUE_MAX) {
			this.queue.shift()
			this.counters.copyQueueDropped++
		}
		this.queue.push(job)
		if (!this.running) {
			this.running = true
			this.schedule(() => void this.drain())
		}
	}

	private async drain(): Promise<void> {
		try {
			for (;;) {
				const job = this.queue.shift()
				if (job === undefined) break
				try {
					if (job.kind === "kept") await this.attach(job.fp, job.key)
					else await this.remove(job.operationId)
				} catch {
					this.log.warn("Copy detection job failed")
				}
			}
		} finally {
			this.running = false
			for (const w of this.idleWaiters.splice(0)) w()
		}
	}

	/** Yields a turn after every COPY_COMPARE_PER_TICK comparisons. */
	private async pace(): Promise<void> {
		if (++this.compared % COPY_COMPARE_PER_TICK !== 0) return
		await new Promise<void>(resolve => this.schedule(resolve))
	}

	private async pass(a: Entry, b: Entry): Promise<PassResult> {
		if (
			a.fp.sourceId !== b.fp.sourceId ||
			a.fp.epoch !== b.fp.epoch ||
			a.fp.rateHz !== b.fp.rateHz ||
			!overlapAllowed(a.fp, b.fp, a.fp.rateHz)
		)
			return { ok: false }
		const t0 = this.clock()
		const c = compareEnvelopes(a.fp, b.fp)
		const ms = this.clock() - t0
		if (ms > this.counters.copyComparisonMsMax)
			this.counters.copyComparisonMsMax = ms
		this.counters.copyCompared++
		await this.pace()
		if ("noCompare" in c) {
			if (c.noCompare === "ineligible") this.counters.copyIneligible++
			return { ok: false }
		}
		if (!sameAudio(c)) return { ok: false }
		const weaker = strongerThan(a, b) ? b : a
		const evidence = evidenceOf(weaker.fp)
		if (evidence.length === 0) {
			this.counters.copySameAudioNoEvidence++
			this.log.debug(
				{ r: round(c.r, 3), z: round(c.z, 1) },
				"Same audio without copy evidence",
			)
			return { ok: false }
		}
		return { ok: true, score: c, evidence }
	}

	private ringOf(sourceId: string): Entry[] {
		let ring = this.rings.get(sourceId)
		if (ring === undefined) {
			ring = []
			this.rings.set(sourceId, ring)
		}
		return ring
	}

	/** Age and count eviction of `ring` for a new entry (persisted state stays: row 11). */
	private evict(ring: Entry[], newest: Entry): void {
		const horizon = (COPY_HORIZON_MS * newest.fp.rateHz) / 1000
		for (let i = ring.length - 1; i >= 0; i--) {
			const e = ring[i]!
			if (
				e.fp.epoch !== newest.fp.epoch ||
				e.fp.rateHz !== newest.fp.rateHz ||
				e.end < newest.end - horizon
			)
				this.drop(ring, i)
		}
		while (ring.length >= COPY_RING_MAX) {
			this.drop(ring, 0)
			this.counters.copyRingOverflow++
		}
	}

	/** Removes ring[i]; copies of it in the ring keep their state (their `of` is persisted). */
	private drop(ring: Entry[], i: number): void {
		ring.splice(i, 1)
	}

	private write(e: Entry, copy: CopyRecord | null): void {
		if (copy !== null) this.counters.copyMarked++
		void this.deps.write(e.fp.operationId, copy).catch(() => undefined)
	}

	private recordOf(of: Entry, r: Passed): CopyRecord {
		return {
			of: { key: of.key, operationId: of.fp.operationId },
			score: {
				r: round(r.score.r, 3),
				z: round(r.score.z, 1),
				neff: Math.round(r.score.neff),
				lagFrames: r.score.lagFrames,
			},
			evidence: r.evidence,
		}
	}

	private membersOf(ring: readonly Entry[], root: Entry): Entry[] {
		return ring.filter(e => e.state.kind === "copy" && e.state.of === root)
	}

	private async attach(fp: CopyFingerprint, key: string): Promise<void> {
		const ring = this.ringOf(fp.sourceId)
		if (ring.some(e => e.fp.operationId === fp.operationId)) return
		const n: Entry = {
			fp,
			key,
			state: { kind: "root" },
			end: fp.startSample + fp.frames * fp.samplesPerFrame,
		}
		this.evict(ring, n)
		const passing: { root: Entry; r: Passed }[] = []
		for (const root of [...ring]) {
			if (root.state.kind !== "root") continue
			const r = await this.pass(n, root)
			if (r.ok) passing.push({ root, r })
		}
		ring.push(n)
		if (passing.length === 0) return
		if (passing.length > 1) this.counters.copyMultiRoot++
		let best = passing[0]!
		for (const p of passing) if (strongerThan(p.root, best.root)) best = p
		const star = best.root
		if (!strongerThan(n, star)) {
			n.state = { kind: "copy", of: star }
			this.write(n, this.recordOf(star, best.r))
			return
		}
		// N is the stronger: it becomes the root, R* its copy (pass held with R* the weaker).
		const members = this.membersOf(ring, star)
		star.state = { kind: "copy", of: n }
		this.write(star, this.recordOf(n, best.r))
		for (const m of members) {
			const r = await this.pass(m, n)
			if (r.ok && !strongerThan(m, n)) {
				m.state = { kind: "copy", of: n }
				this.write(m, this.recordOf(n, r))
			} else {
				m.state = { kind: "root" }
				this.counters.copyUnlinked++
				this.write(m, null)
			}
		}
	}

	private async remove(operationId: string): Promise<void> {
		for (const ring of this.rings.values()) {
			const i = ring.findIndex(e => e.fp.operationId === operationId)
			if (i < 0) continue
			const gone = ring[i]!
			ring.splice(i, 1)
			if (gone.state.kind !== "root") return
			const members = this.membersOf(ring, gone)
			if (members.length === 0) return
			let m0 = members[0]!
			for (const m of members) if (strongerThan(m, m0)) m0 = m
			m0.state = { kind: "root" }
			this.write(m0, null)
			for (const m of members) {
				if (m === m0) continue
				const r = await this.pass(m, m0)
				if (r.ok && !strongerThan(m, m0)) {
					m.state = { kind: "copy", of: m0 }
					this.write(m, this.recordOf(m0, r))
				} else {
					m.state = { kind: "root" }
					this.counters.copyUnlinked++
					this.write(m, null)
				}
			}
			return
		}
	}
}
