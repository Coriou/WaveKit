/**
 * Copy detector (copy-detector.ts): one test per transition-table row, the two bridging cases
 * (4a: two transmissions bridged by one ghost; 4b: a simulcast root reached through a ghost), the
 * total order, the re-point recompute, the ring and queue bounds and the serial, chunked work.
 * MODELLED frame-level envelopes (copy-envelopes.ts) and a fake store writer; nothing real.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	COPY_COMPARE_PER_TICK,
	COPY_QUEUE_MAX,
	COPY_RING_MAX,
	CopyDetector,
	safeErrorFields,
	strongerThan,
	type CopyFingerprint,
	type CopyRecord,
	type CopySettled,
} from "../../../../src/core/scanner/channel/copy-detector.js"
import {
	compareEnvelopes,
	overlapAllowed,
	sameAudio,
} from "../../../../src/core/scanner/channel/copy-fingerprint.js"
import { COPY_HORIZON_MS } from "../../../../src/core/scanner/channel/copy-intermod.js"
import {
	ENV_RATE,
	IM3,
	fingerprint,
	frameVoice,
	heardAgain,
	slice,
} from "./copy-envelopes.js"

/** Frames per second of the modelled clock (32 ms frames). */
const FPS = 1000 / 32
const sec = (s: number): number => Math.round(s * FPS)

interface Write {
	readonly operationId: string
	readonly copy: CopyRecord | null
}

function detector(schedule?: (run: () => void) => void) {
	const writes: Write[] = []
	const det = new CopyDetector({
		write: (operationId, copy) => {
			writes.push({ operationId, copy })
			return Promise.resolve("written")
		},
		logger: pino({ level: "silent" }),
		...(schedule ? { schedule } : {}),
	})
	return { det, writes }
}

const aliasOf = (fp: CopyFingerprint): string =>
	`d_test~analog-${fp.operationId}.wav`
const keyOf = (fp: CopyFingerprint): string => `scan:${aliasOf(fp)}`
const finalized = (fp: CopyFingerprint): Promise<CopySettled> =>
	Promise.resolve({ outcome: "finalized", alias: aliasOf(fp) })
const turn = (): Promise<void> => new Promise(r => setImmediate(r))

async function keep(
	det: CopyDetector,
	...fps: CopyFingerprint[]
): Promise<void> {
	for (const fp of fps) {
		det.kept(fp, finalized(fp))
		await turn()
		await det.idle()
	}
}

const lastWrite = (writes: readonly Write[], fp: CopyFingerprint) =>
	[...writes].reverse().find(w => w.operationId === fp.operationId)

/** One talker over `seconds`, from frame `from` of its seed's voice. */
const talk = (seed: number, seconds: number, from = 0) =>
	slice(frameVoice(seed, sec(200)), from, sec(seconds))

describe("copy detector: transition table", () => {
	const voice = talk(1, 20)
	const ghostAudio = heardAgain(voice, 11)

	it("row 2: a finalized file no root passes against is a candidate (nothing written)", async () => {
		const { det, writes } = detector()
		const a = fingerprint(voice)
		await keep(det, a)
		expect(det.stateOf(keyOf(a))).toEqual({ kind: "root" })
		expect(writes).toEqual([])
	})

	it("row 3: a finish that is not finalized, or a receipt that fails, never enters the ring", async () => {
		const { det, writes } = detector()
		const a = fingerprint(voice)
		const b = fingerprint(ghostAudio, { raster: "off", snrDb: 10 })
		det.kept(a, Promise.resolve({ outcome: "aborted", alias: null }))
		det.kept(b, Promise.reject(new Error("receipt failed")))
		await turn()
		await det.idle()
		expect(det.stateOf(keyOf(a))).toBeNull()
		expect(det.stateOf(keyOf(b))).toBeNull()
		expect(writes).toEqual([])
	})

	it("row 4: a weaker file with evidence and the root's audio becomes its copy; the root is the original", async () => {
		const { det, writes } = detector()
		const root = fingerprint(voice, { snrDb: 35 })
		const ghost = fingerprint(ghostAudio, { snrDb: 9, raster: "off" })
		await keep(det, root, ghost)
		expect(det.stateOf(keyOf(ghost))).toEqual({ kind: "copy", of: keyOf(root) })
		expect(det.stateOf(keyOf(root))).toEqual({ kind: "root" })
		expect(writes).toHaveLength(1)
		expect(writes[0]!.copy).toMatchObject({
			of: { key: keyOf(root), operationId: root.operationId },
			evidence: ["off-raster"],
		})
		expect(writes[0]!.copy!.score.r).toBeGreaterThan(0.9)
	})

	it("row 5: a stronger newcomer becomes the root; each copy re-points only when it passes directly (score recomputed), else it is unlinked", async () => {
		const { det, writes } = detector()
		const long = talk(2, 60)
		// R: a ghost of 0 to 40 s; M: a weaker ghost of 0 to 10 s (a copy of R); N: the voice itself,
		// on raster and the strongest, 8 to 48 s: it overlaps R by 32 s (0.8 of R) and M by 2 s.
		const r = fingerprint(heardAgain(slice(long, 0, sec(40)), 21, -15), {
			snrDb: 20,
			raster: "off",
		})
		const m = fingerprint(heardAgain(slice(long, 0, sec(10)), 22, -25), {
			snrDb: 8,
			raster: "off",
		})
		// M2: another weak ghost over R's whole span: it re-points to N (it overlaps N enough).
		const m2 = fingerprint(heardAgain(slice(long, sec(8), sec(40)), 23, -25), {
			atFrame: sec(8),
			snrDb: 7,
			intermod: IM3,
		})
		await keep(det, r, m, m2)
		expect(det.stateOf(keyOf(m))).toEqual({ kind: "copy", of: keyOf(r) })
		expect(det.stateOf(keyOf(m2))).toEqual({ kind: "copy", of: keyOf(r) })
		const m2Before = lastWrite(writes, m2)!.copy!
		const n = fingerprint(slice(long, sec(8), sec(40)), {
			atFrame: sec(8),
			snrDb: 40,
		})
		await keep(det, n)
		expect(det.stateOf(keyOf(n))).toEqual({ kind: "root" })
		expect(det.stateOf(keyOf(r))).toEqual({ kind: "copy", of: keyOf(n) })
		expect(det.stateOf(keyOf(m2))).toEqual({ kind: "copy", of: keyOf(n) })
		expect(det.stateOf(keyOf(m))).toEqual({ kind: "root" })
		expect(lastWrite(writes, r)!.copy!.of.key).toBe(keyOf(n))
		expect(lastWrite(writes, m)!.copy).toBeNull()
		const m2After = lastWrite(writes, m2)!.copy!
		expect(m2After.of.key).toBe(keyOf(n))
		// m8: the score is the one against N, not the one against R.
		expect(m2After.score).not.toEqual(m2Before.score)
		expect(m2After.evidence).toEqual(["intermod"])
		expect(det.status().copyUnlinked).toBe(1)
	})

	it("row 6: a newcomer is never compared with a copy for attachment", async () => {
		const { det, writes } = detector()
		const long = talk(3, 30)
		// R 0 to 20 s; M (copy of R) 2 to 22 s; N 4.5 to 24.5 s overlaps R by 15.5 s (< 0.8 × 20)
		// but M by 17.5 s: it would pass against M, which is not a root.
		const r = fingerprint(slice(long, 0, sec(20)), { snrDb: 30 })
		const m = fingerprint(heardAgain(slice(long, sec(2), sec(20)), 31), {
			atFrame: sec(2),
			snrDb: 10,
			raster: "off",
		})
		await keep(det, r, m)
		expect(det.stateOf(keyOf(m))).toEqual({ kind: "copy", of: keyOf(r) })
		const nAudio = heardAgain(slice(long, sec(4.5), sec(20)), 32)
		const n = fingerprint(nAudio, {
			atFrame: sec(4.5),
			snrDb: 5,
			raster: "off",
		})
		expect(overlapAllowed(n, m, ENV_RATE)).toBe(true)
		expect(overlapAllowed(n, r, ENV_RATE)).toBe(false)
		await keep(det, n)
		expect(det.stateOf(keyOf(n))).toEqual({ kind: "root" })
		expect(writes.filter(w => w.operationId === n.operationId)).toEqual([])
	})

	it("row 7: a newcomer passing two roots attaches to the strongest; the roots stay separate", async () => {
		const { det } = detector()
		const r1 = fingerprint(voice, { snrDb: 30 })
		const r2 = fingerprint(heardAgain(voice, 41, -3), { snrDb: 25 })
		const n = fingerprint(ghostAudio, { snrDb: 8, raster: "off" })
		await keep(det, r1, r2, n)
		expect(det.stateOf(keyOf(r1))).toEqual({ kind: "root" })
		expect(det.stateOf(keyOf(r2))).toEqual({ kind: "root" })
		expect(det.stateOf(keyOf(n))).toEqual({ kind: "copy", of: keyOf(r1) })
		expect(det.status().copyMultiRoot).toBe(1)
	})

	it("row 8: a deleted root in the ring: its strongest member becomes the root, the others re-point when they pass, else unlink", async () => {
		const { det, writes } = detector()
		const long = talk(4, 40)
		// The root covers 0 to 30 s; m0 and m1 0 to 20 s; m2 22 to 30 s: it passes the root but
		// never overlaps m0.
		const root = fingerprint(slice(long, 0, sec(30)), { snrDb: 40 })
		const m0 = fingerprint(heardAgain(slice(long, 0, sec(20)), 51, -10), {
			snrDb: 20,
			raster: "off",
		})
		const m1 = fingerprint(heardAgain(slice(long, 0, sec(20)), 52, -20), {
			snrDb: 10,
			intermod: IM3,
		})
		const m2 = fingerprint(heardAgain(slice(long, sec(22), sec(8)), 53, -20), {
			atFrame: sec(22),
			snrDb: 5,
			raster: "off",
		})
		await keep(det, root, m0, m1, m2)
		for (const m of [m0, m1, m2])
			expect(det.stateOf(keyOf(m))).toEqual({ kind: "copy", of: keyOf(root) })
		det.forget(root.operationId)
		await turn()
		await det.idle()
		expect(det.stateOf(keyOf(root))).toBeNull()
		expect(det.stateOf(keyOf(m0))).toEqual({ kind: "root" })
		expect(lastWrite(writes, m0)!.copy).toBeNull()
		expect(det.stateOf(keyOf(m1))).toEqual({ kind: "copy", of: keyOf(m0) })
		expect(lastWrite(writes, m1)!.copy!.of.key).toBe(keyOf(m0))
		expect(det.stateOf(keyOf(m2))).toEqual({ kind: "root" })
		expect(lastWrite(writes, m2)!.copy).toBeNull()
	})

	it("row 9: a deleted root out of the ring writes nothing (read time shows its copies again)", async () => {
		const { det, writes } = detector()
		const root = fingerprint(voice, { snrDb: 40 })
		const ghost = fingerprint(ghostAudio, { snrDb: 9, raster: "off" })
		await keep(det, root, ghost)
		// A file far later (past the horizon) evicts both by age.
		const later = fingerprint(talk(5, 10), {
			atFrame: Math.ceil(((COPY_HORIZON_MS + 30_000) / 1000) * FPS),
		})
		await keep(det, later)
		expect(det.stateOf(keyOf(root))).toBeNull()
		const before = writes.length
		det.forget(root.operationId)
		await turn()
		await det.idle()
		expect(writes.length).toBe(before)
	})

	it("row 10: a deleted copy leaves the ring and nothing else changes", async () => {
		const { det, writes } = detector()
		const root = fingerprint(voice, { snrDb: 40 })
		const ghost = fingerprint(ghostAudio, { snrDb: 9, raster: "off" })
		await keep(det, root, ghost)
		const before = writes.length
		det.forget(ghost.operationId)
		await turn()
		await det.idle()
		expect(det.stateOf(keyOf(ghost))).toBeNull()
		expect(det.stateOf(keyOf(root))).toEqual({ kind: "root" })
		expect(writes.length).toBe(before)
	})

	it(`row 11: count eviction past COPY_RING_MAX (${COPY_RING_MAX}) keeps persisted state; an evicted root's copy is never re-pointed`, async () => {
		const { det, writes } = detector()
		const long = talk(6, 30)
		const root = fingerprint(slice(long, 0, sec(10)), { snrDb: 30 })
		const ghost = fingerprint(heardAgain(slice(long, 0, sec(10)), 61), {
			snrDb: 9,
			raster: "off",
		})
		await keep(det, root, ghost)
		// Fillers (other voices, short, so they never pass anything) up to the bound.
		const fillers: CopyFingerprint[] = []
		for (let i = 0; i < COPY_RING_MAX - 2; i++)
			fillers.push(fingerprint(talk(100 + i, 6), { atFrame: sec(12) }))
		for (const f of fillers) det.kept(f, finalized(f))
		await turn()
		await det.idle()
		expect(det.status().copyRingOverflow).toBe(0)
		const before = writes.length
		// One more: the oldest (the root) leaves; a stronger same-audio newcomer finds no root.
		const n = fingerprint(slice(long, 0, sec(10)), { snrDb: 45 })
		await keep(det, n)
		expect(det.status().copyRingOverflow).toBe(1)
		expect(det.stateOf(keyOf(root))).toBeNull()
		expect(det.stateOf(keyOf(ghost))).toEqual({ kind: "copy", of: keyOf(root) })
		expect(det.stateOf(keyOf(n))).toEqual({ kind: "root" })
		expect(writes.length).toBe(before)
	}, 60_000)

	it("row 12: after a restart the ring is empty: nothing is compared again", async () => {
		const first = detector()
		const root = fingerprint(voice, { snrDb: 40 })
		await keep(first.det, root)
		const second = detector()
		const ghost = fingerprint(ghostAudio, { snrDb: 9, raster: "off" })
		await keep(second.det, ghost)
		expect(second.det.stateOf(keyOf(ghost))).toEqual({ kind: "root" })
		expect(second.writes).toEqual([])
		expect(second.det.status().copyCompared).toBe(0)
	})

	it("row 13: the same audio with no evidence on the weaker file changes nothing", async () => {
		const { det, writes } = detector()
		const a = fingerprint(voice, { snrDb: 35, raster: "on" })
		const b = fingerprint(ghostAudio, { snrDb: 10, raster: "unknown" })
		await keep(det, a, b)
		expect(det.stateOf(keyOf(b))).toEqual({ kind: "root" })
		expect(writes).toEqual([])
		expect(det.status().copySameAudioNoEvidence).toBe(1)
	})
})

describe("copy detector: bridging cases", () => {
	const orders = (n: string[]): string[][] =>
		n.length <= 1
			? [n]
			: n.flatMap((x, i) =>
					orders([...n.slice(0, i), ...n.slice(i + 1)]).map(r => [x, ...r]),
				)

	/** pass() as the detector reads it, directly between two fingerprints. */
	const passesDirectly = (a: CopyFingerprint, b: CopyFingerprint): boolean =>
		overlapAllowed(a, b, ENV_RATE) && sameAudio(compareEnvelopes(a, b))

	it("4a: two transmissions bridged by one ghost are never linked to each other", async () => {
		const x = talk(7, 10)
		const y = talk(8, 11)
		const a = fingerprint(x, { snrDb: 30 })
		const b = fingerprint(y, { atFrame: sec(9), snrDb: 30 })
		// The ghost: x's audio for 0 to 9 s, then y's for 9 to 20 s, off raster.
		const level = new Float64Array(sec(20))
		const voiced = new Uint8Array(sec(20))
		const gx = heardAgain(x, 71)
		const gy = heardAgain(y, 72)
		for (let k = 0; k < level.length; k++) {
			const fromY = k >= sec(9)
			const src = fromY ? gy : gx
			const j = fromY ? k - sec(9) : k
			level[k] = src.level[j] ?? 30
			voiced[k] = src.voiced[j] ?? 0
		}
		const g = fingerprint({ level, voiced }, { snrDb: 9, raster: "off" })
		const files: Record<string, CopyFingerprint> = { A: a, B: b, G: g }
		for (const order of [
			["A", "G", "B"],
			["A", "B", "G"],
			["G", "A", "B"],
			["G", "B", "A"],
		]) {
			const { det } = detector()
			await keep(det, ...order.map(k => files[k]!))
			const sa = det.stateOf(keyOf(a))
			const sb = det.stateOf(keyOf(b))
			const sg = det.stateOf(keyOf(g))
			expect(sa, order.join(",")).toEqual({ kind: "root" })
			expect(sb, order.join(",")).toEqual({ kind: "root" })
			// The ghost is a copy of exactly one of them, and passes against that one directly.
			expect(sg?.kind, order.join(",")).toBe("copy")
			if (sg?.kind === "copy") {
				const root = sg.of === keyOf(a) ? a : b
				expect(passesDirectly(g, root), order.join(",")).toBe(true)
			}
		}
	})

	it("4b: a simulcast root reached through a ghost: the two roots are never linked", async () => {
		const x = talk(9, 20)
		const a = fingerprint(x, { snrDb: 30, raster: "on" })
		const b = fingerprint(heardAgain(x, 81, -4), { snrDb: 25, raster: "on" })
		const g = fingerprint(heardAgain(x, 82), { snrDb: 9, raster: "off" })
		const files: Record<string, CopyFingerprint> = { A: a, B: b, G: g }
		for (const order of [
			["A", "G", "B"],
			["G", "A", "B"],
			["A", "B", "G"],
			["B", "G", "A"],
		]) {
			const { det } = detector()
			await keep(det, ...order.map(k => files[k]!))
			expect(det.stateOf(keyOf(a)), order.join(",")).toEqual({ kind: "root" })
			expect(det.stateOf(keyOf(b)), order.join(",")).toEqual({ kind: "root" })
			const sg = det.stateOf(keyOf(g))
			expect(sg?.kind, order.join(",")).toBe("copy")
			if (sg?.kind === "copy") expect([keyOf(a), keyOf(b)]).toContain(sg.of)
		}
		// Every order of the three, too.
		for (const order of orders(["A", "B", "G"])) {
			const { det } = detector()
			await keep(det, ...order.map(k => files[k]!))
			expect(det.stateOf(keyOf(b))?.kind).toBe("root")
			expect(det.stateOf(keyOf(a))?.kind).toBe("root")
		}
	})
})

describe("copy detector: order, bounds and pacing", () => {
	it("orders by whole-dB SNR, then the earlier start, then the smaller key", () => {
		const v = talk(10, 10)
		const e = (snrDb: number, atFrame: number, key: string) => ({
			fp: fingerprint(v, { snrDb, atFrame }),
			key,
		})
		// 30.4 and 29.6 both round to 30: the earlier start is stronger.
		expect(strongerThan(e(29.6, 0, "b"), e(30.4, 5, "a"))).toBe(true)
		expect(strongerThan(e(30.4, 5, "a"), e(29.6, 0, "b"))).toBe(false)
		// Same start: the smaller key.
		expect(strongerThan(e(30, 0, "a"), e(30, 0, "b"))).toBe(true)
		expect(strongerThan(e(30, 0, "b"), e(30, 0, "a"))).toBe(false)
		expect(strongerThan(e(31, 9, "z"), e(30, 0, "a"))).toBe(true)
	})

	it(`runs at most ${COPY_COMPARE_PER_TICK} comparisons per turn, one job after the other against a stable ring`, async () => {
		const queue: (() => void)[] = []
		const { det } = detector(run => queue.push(run))
		const runAll = async (): Promise<number[]> => {
			const perTurn: number[] = []
			for (let i = 0; i < 1_000 && queue.length > 0; i++) {
				const before = det.status().copyCompared
				queue.shift()!()
				for (let j = 0; j < 20; j++) await Promise.resolve()
				perTurn.push(det.status().copyCompared - before)
			}
			return perTurn
		}
		const fillers = Array.from({ length: 10 }, (_, i) =>
			fingerprint(talk(200 + i, 8)),
		)
		for (const f of fillers) det.kept(f, finalized(f))
		await Promise.resolve()
		await Promise.resolve()
		await runAll()
		// The original and its ghost kept together: the ghost's job runs after the original's
		// joined the ring, so it is compared with it.
		const voice = talk(11, 8)
		const orig = fingerprint(voice, { snrDb: 40 })
		const ghost = fingerprint(heardAgain(voice, 91), {
			snrDb: 9,
			raster: "off",
		})
		det.kept(orig, finalized(orig))
		det.kept(ghost, finalized(ghost))
		await Promise.resolve()
		await Promise.resolve()
		const perTurn = await runAll()
		expect(Math.max(...perTurn)).toBeLessThanOrEqual(COPY_COMPARE_PER_TICK)
		expect(det.stateOf(keyOf(ghost))).toEqual({ kind: "copy", of: keyOf(orig) })
	})

	it(`drops the oldest job past COPY_QUEUE_MAX (${COPY_QUEUE_MAX}) and counts it`, () => {
		const queue: (() => void)[] = []
		const { det } = detector(run => queue.push(run))
		for (let i = 0; i < COPY_QUEUE_MAX; i++) det.forget(`op-${i}`)
		expect(det.status().copyQueueDropped).toBe(0)
		det.forget("one-more")
		expect(det.status().copyQueueDropped).toBe(1)
	})

	it("compares only files of one source and epoch", async () => {
		const { det, writes } = detector()
		const v = talk(12, 10)
		await keep(
			det,
			fingerprint(v, { snrDb: 40 }),
			fingerprint(heardAgain(v, 92), {
				snrDb: 9,
				raster: "off",
				sourceId: "src-b",
			}),
			fingerprint(heardAgain(v, 93), { snrDb: 9, raster: "off", epoch: 2 }),
		)
		expect(writes).toEqual([])
	})
})

describe("copy detector: a failed job", () => {
	it("logs the cause from closed sets only (class name, errno code), never its message", async () => {
		const lines: string[] = []
		const det = new CopyDetector({
			write: () => {
				throw Object.assign(new TypeError("/private/path value=x"), {
					code: "EACCES",
				})
			},
			logger: pino(
				{ level: "warn" },
				{ write: (line: string) => void lines.push(line) },
			),
		})
		const voice = talk(13, 10)
		const orig = fingerprint(voice, { snrDb: 40 })
		const ghost = fingerprint(heardAgain(voice, 94), {
			snrDb: 9,
			raster: "off",
		})
		await keep(det, orig, ghost)
		const failed = lines
			.map(l => JSON.parse(l) as Record<string, unknown>)
			.filter(l => l["msg"] === "Copy detection job failed")
		expect(failed).toHaveLength(1)
		expect(failed[0]).toMatchObject({
			job: "kept",
			errorName: "TypeError",
			errorCode: "EACCES",
		})
		expect(lines.join("\n")).not.toContain("/private/path")
		expect(safeErrorFields({ code: "value from outside" })).toEqual({
			errorName: "other",
		})
		const custom = new Error("x")
		custom.name = "value from outside"
		expect(safeErrorFields(custom)).toEqual({ errorName: "other" })
	})
})

describe("copy detector: intermod evidence must name the root", () => {
	const voice = talk(14, 12)
	// Two unrelated strong carriers 300 and 500 kHz up: their product 2·f1 − f2 lands on the file.
	const unrelated: CopyFingerprint["intermod"] = {
		rule: "2f1-f2",
		parents: [{ hz: 1_300_000 }, { hz: 1_500_000 }],
		roots: [1_300_000, 1_500_000],
		tolHz: 4_000,
	}

	it("a simulcast pair whose weaker file lands on a product of unrelated carriers is never marked", async () => {
		const { det, writes } = detector()
		const strong = fingerprint(voice, { snrDb: 35, hz: 1_000_000 })
		const weak = fingerprint(heardAgain(voice, 95), {
			snrDb: 20,
			hz: 1_100_000,
			intermod: unrelated,
		})
		await keep(det, strong, weak)
		expect(det.stateOf(keyOf(weak))).toEqual({ kind: "root" })
		expect(writes).toEqual([])
		expect(det.status().copySameAudioNoEvidence).toBe(1)
	})

	it("a true ghost of the root (the root is a parent) still is, at the tolerance; 1 Hz past it is not", async () => {
		for (const [rootHz, marked] of [
			[1_300_000 + 4_000, true],
			[1_300_000 + 4_001, false],
		] as const) {
			const { det } = detector()
			const root = fingerprint(voice, { snrDb: 35, hz: rootHz })
			const ghost = fingerprint(heardAgain(voice, 96), {
				snrDb: 9,
				hz: 1_100_000,
				intermod: unrelated,
			})
			await keep(det, root, ghost)
			expect(det.stateOf(keyOf(ghost))).toEqual(
				marked ? { kind: "copy", of: keyOf(root) } : { kind: "root" },
			)
		}
	})

	it("rule B ties fa and the mirror (fa's mixing partner fb): a ghost whose twin is fb is marked", async () => {
		const mirror: CopyFingerprint["intermod"] = {
			rule: "symmetric",
			parents: [{ hz: 1_300_000 }, { hz: 1_500_000 }],
			roots: [1_300_000, 1_500_000],
			tolHz: 4_000,
		}
		const { det } = detector()
		const atMirror = fingerprint(voice, { snrDb: 35, hz: 1_500_000 })
		const ghost = fingerprint(heardAgain(voice, 97), {
			snrDb: 9,
			hz: 1_100_000,
			intermod: mirror,
		})
		await keep(det, atMirror, ghost)
		expect(det.stateOf(keyOf(ghost))).toEqual({
			kind: "copy",
			of: keyOf(atMirror),
		})
	})
})

describe("copy detector: a mark the store does not accept", () => {
	const voice = talk(15, 10)

	function refusing(outcome: () => Promise<unknown>) {
		const writes: Write[] = []
		const det = new CopyDetector({
			write: (operationId, copy) => {
				writes.push({ operationId, copy })
				return outcome()
			},
			logger: pino({ level: "silent" }),
		})
		return { det, writes }
	}

	it("a skipped mark turns the file back into a root, counted", async () => {
		const { det, writes } = refusing(() => Promise.resolve("skipped"))
		const root = fingerprint(voice, { snrDb: 35 })
		const ghost = fingerprint(heardAgain(voice, 98), {
			snrDb: 9,
			raster: "off",
		})
		await keep(det, root, ghost)
		await turn()
		expect(writes).toHaveLength(1)
		expect(det.stateOf(keyOf(ghost))).toEqual({ kind: "root" })
		expect(det.status().copyWriteSkipped).toBe(1)
		expect(det.status().copyMarked).toBe(1)
	})

	it("a failed (rejected) mark is reverted too; an accepted one stays", async () => {
		const failed = refusing(() => Promise.reject(new Error("disk")))
		const accepted = refusing(() => Promise.resolve("written"))
		for (const { det } of [failed, accepted]) {
			const root = fingerprint(voice, { snrDb: 35 })
			const ghost = fingerprint(heardAgain(voice, 99), {
				snrDb: 9,
				raster: "off",
			})
			await keep(det, root, ghost)
			await turn()
			const reverted = det === failed.det
			expect(det.stateOf(keyOf(ghost))).toEqual(
				reverted ? { kind: "root" } : { kind: "copy", of: keyOf(root) },
			)
			expect(det.status().copyWriteSkipped).toBe(reverted ? 1 : 0)
		}
	})

	it("a skip that answers after a later job changed the file's state leaves that state", async () => {
		// The first mark (ghost → root) answers late; every later write is accepted.
		let release: (v: string) => void = () => undefined
		let calls = 0
		const { det } = refusing(() =>
			calls++ === 0
				? new Promise<unknown>(resolve => (release = resolve))
				: Promise.resolve("written"),
		)
		const long = talk(16, 30)
		const root = fingerprint(heardAgain(slice(long, 0, sec(20)), 101, -15), {
			snrDb: 20,
			raster: "off",
		})
		const ghost = fingerprint(heardAgain(slice(long, 0, sec(20)), 102, -25), {
			snrDb: 8,
			raster: "off",
		})
		await keep(det, root, ghost)
		expect(det.stateOf(keyOf(ghost))).toEqual({ kind: "copy", of: keyOf(root) })
		// A stronger newcomer: the root becomes its copy and the ghost re-points to it.
		const n = fingerprint(slice(long, 0, sec(20)), { snrDb: 40 })
		await keep(det, n)
		expect(det.stateOf(keyOf(ghost))).toEqual({ kind: "copy", of: keyOf(n) })
		release("skipped")
		await turn()
		expect(det.status().copyWriteSkipped).toBe(1)
		expect(det.stateOf(keyOf(ghost))).toEqual({ kind: "copy", of: keyOf(n) })
	})

	it("a skipped re-point restores the member's previous state, as on disk", async () => {
		const long = talk(17, 30)
		const files = () => ({
			root: fingerprint(heardAgain(slice(long, 0, sec(20)), 103, -15), {
				snrDb: 20,
				raster: "off",
			}),
			ghost: fingerprint(heardAgain(slice(long, 0, sec(20)), 104, -25), {
				snrDb: 8,
				raster: "off",
			}),
			n: fingerprint(slice(long, 0, sec(20)), { snrDb: 40 }),
		})
		// Writes: 1 ghost → root, 2 root → n, 3 ghost → n. `skip` lists the skipped ones.
		for (const [skip, ghostAfter, rootAfter] of [
			// Both re-marks skipped: on disk the ghost still names the root, which is still a root.
			[[2, 3], "root", "root"],
			// Only the ghost's: on disk it names the root, which is now n's copy (no copy).
			[[3], "none", "n"],
		] as const) {
			let calls = 0
			const { det } = refusing(() =>
				Promise.resolve(
					(skip as readonly number[]).includes(++calls) ? "skipped" : "written",
				),
			)
			const { root, ghost, n } = files()
			await keep(det, root, ghost)
			expect(det.stateOf(keyOf(ghost))).toEqual({
				kind: "copy",
				of: keyOf(root),
			})
			await keep(det, n)
			await turn()
			expect(calls).toBe(3)
			expect(det.status().copyWriteSkipped).toBe(skip.length)
			expect(det.stateOf(keyOf(ghost))).toEqual(
				ghostAfter === "root"
					? { kind: "copy", of: keyOf(root) }
					: { kind: "root" },
			)
			expect(det.stateOf(keyOf(root))).toEqual(
				rootAfter === "root"
					? { kind: "root" }
					: { kind: "copy", of: keyOf(n) },
			)
		}
	})
})
