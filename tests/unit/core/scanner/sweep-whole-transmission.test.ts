/**
 * A transmission caught by a sweep is one WAV from the catch to its end, through the production
 * composition (sweep-qualification-harness.ts): a visit landing on it mid-way holds its hop until it
 * ends, then every other hop gets a coarse visit. Holds are per transmission, whatever another hop's
 * long hold left behind. Synthetic signals only.
 */
import { Writable } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	qualificationWorld,
	synthWorld,
	type Emitter,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const SIGNAL_HOP = HOPS[1]!
const LAST_HOP = HOPS[2]!
const SIGNAL_HZ = SIGNAL_HOP + 100_437
/** Inside the range on the last hop only. */
const OTHER_HZ = LAST_HOP - 300_437
/**
 * From a voice's end to the hop's leave: the engine closes a track 500 ms after it went quiet, read
 * to two 50 ms blocks; a voice hold is re-checked every 250 ms; two 25 ms chunks to see the tune.
 */
const LEAVE_MS = 500 + 2 * 50 + 250 + 2 * 25
/** Decisions wait 1 s for late reports; the finish takes some turns of the store. */
const SETTLED_MS = 3_000

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

async function sweep(
	emitters: Emitter[],
	logger?: Parameters<typeof qualificationWorld>[0]["logger"],
) {
	const w = qualificationWorld({
		centreHz: CENTRE_HZ,
		world: synthWorld(emitters),
		...(logger ? { logger } : {}),
	})
	stops.push(() => w.stop())
	await w.service.start()
	const job = await w.service.createJob({
		sourceId: "rtl",
		mode: "sweep",
		bandplans: [],
		ranges: [RANGE],
		priority: 50,
		takeover: true,
		resume: { autoAfterIdleMs: null },
	} as never)
	expect(job.plan.hops.map(h => h.centreHz)).toEqual(HOPS)
	return w
}
type World = Awaited<ReturnType<typeof sweep>>

/** Visits of `hz` that outlasted a coarse visit (with its qualification). */
const longVisits = (w: World, hz: number) =>
	w.visits.filter(
		v => v.centreHz === hz && (v.endMs ?? w.nowMs()) - v.atMs > 1_000,
	)

interface Internals {
	widebandAnalog: {
		diagnostics(): {
			recent: {
				code: string
				receipt?: { outcome: string; errorCode: string | null }
			}[]
		}
	}
	store: { recordingAssociation(...args: unknown[]): unknown }
}
const decisions = (w: World) =>
	(w.service as unknown as Internals).widebandAnalog.diagnostics().recent

describe("a sweep records a transmission whole", () => {
	it("a voice on air at the visit's arrival: one WAV from the catch to its end, its hop held, then a coarse sweep", async () => {
		const END_MS = 12_000
		const w = await sweep([
			{ hz: SIGNAL_HZ, kind: "voice", fromMs: 0, toMs: END_MS },
		])
		await w.advance(END_MS + SETTLED_MS)
		const [held] = longVisits(w, SIGNAL_HOP)
		expect(held).toBeDefined()
		expect(held!.endMs).toBeGreaterThanOrEqual(END_MS)
		expect(held!.endMs).toBeLessThanOrEqual(END_MS + LEAVE_MS)
		const wavs = w.wavSeconds()
		expect(wavs).toHaveLength(1)
		// From the catch (the settle and the first block are the visit's) to the visit's end.
		const heldS = (held!.endMs! - held!.atMs) / 1000
		expect(wavs[0]).toBeGreaterThan(heldS - 0.5)
		expect(wavs[0]).toBeLessThanOrEqual(heldS)
		// Every other hop gets a coarse visit before the hop is held again (a revisit stays short).
		const after = w.visits.filter(v => v.atMs >= held!.endMs!)
		const swept = Math.max(
			after.findIndex(v => v.centreHz === HOPS[0]),
			after.findIndex(v => v.centreHz === LAST_HOP),
		)
		expect(after.findIndex(v => v.centreHz === HOPS[0])).toBeGreaterThanOrEqual(
			0,
		)
		expect(
			after.findIndex(v => v.centreHz === LAST_HOP),
		).toBeGreaterThanOrEqual(0)
		for (const v of after.slice(0, swept))
			expect((v.endMs ?? w.nowMs()) - v.atMs).toBeLessThan(1_000)
	}, 120_000)

	it("a voice caught while another hop's watch holds the long-hold lock is held the same", async () => {
		const END_MS = 24_000
		const w = await sweep([
			// Watched 8 s from the first sweep: longer than a coarse sweep, so it sets the lock.
			{ hz: OTHER_HZ, kind: "carrier", fromMs: 0, toMs: 60_000 },
			{ hz: SIGNAL_HZ, kind: "voice", fromMs: 4_000, toMs: END_MS },
		])
		await w.advance(END_MS + SETTLED_MS)
		const [watch] = longVisits(w, LAST_HOP)
		expect(watch).toBeDefined()
		expect(watch!.endMs! - watch!.atMs).toBeGreaterThan(7_000)
		const [held] = longVisits(w, SIGNAL_HOP)
		expect(held).toBeDefined()
		expect(held!.atMs).toBeGreaterThanOrEqual(watch!.endMs!)
		// The sweep came back to it right after the watch, with the lock still set.
		expect(held!.atMs - watch!.endMs!).toBeLessThan(2_000)
		expect(held!.endMs).toBeGreaterThanOrEqual(END_MS)
		expect(held!.endMs).toBeLessThanOrEqual(END_MS + LEAVE_MS)
		const wavs = w.wavSeconds()
		expect(wavs).toHaveLength(1)
		expect(wavs[0]).toBeGreaterThan((held!.endMs! - held!.atMs) / 1000 - 0.5)
	}, 180_000)

	it("a QSO's two overs: each held per transmission, the second caught after the forced sweep", async () => {
		const FIRST_END_MS = 11_000
		const SECOND_MS = 13_000
		const SECOND_END_MS = 28_000
		const w = await sweep([
			{ hz: SIGNAL_HZ, kind: "voice", fromMs: 0, toMs: FIRST_END_MS },
			{ hz: SIGNAL_HZ, kind: "voice", fromMs: SECOND_MS, toMs: SECOND_END_MS },
		])
		await w.advance(SECOND_END_MS + SETTLED_MS)
		const held = longVisits(w, SIGNAL_HOP)
		expect(held).toHaveLength(2)
		expect(held[0]!.endMs).toBeGreaterThanOrEqual(FIRST_END_MS)
		expect(held[0]!.endMs).toBeLessThanOrEqual(FIRST_END_MS + LEAVE_MS)
		expect(held[1]!.atMs).toBeGreaterThanOrEqual(SECOND_MS - 1_000)
		expect(held[1]!.endMs).toBeGreaterThanOrEqual(SECOND_END_MS)
		expect(held[1]!.endMs).toBeLessThanOrEqual(SECOND_END_MS + LEAVE_MS)
		// The other hops got their visits between the two.
		const between = w.visits.filter(
			v => v.atMs >= held[0]!.endMs! && v.atMs < held[1]!.atMs,
		)
		for (const hop of [HOPS[0], LAST_HOP])
			expect(between.some(v => v.centreHz === hop)).toBe(true)
		const wavs = w.wavSeconds().sort((a, b) => a - b)
		expect(wavs).toHaveLength(2)
		expect(wavs[0]).toBeGreaterThan(
			(held[0]!.endMs! - held[0]!.atMs) / 1000 - 0.5,
		)
		expect(wavs[1]).toBeGreaterThan(
			(held[1]!.endMs! - held[1]!.atMs) / 1000 - 1,
		)
	}, 180_000)

	it("a carrier gets no held recording and leaves no file", async () => {
		const w = await sweep([
			{ hz: SIGNAL_HZ, kind: "carrier", fromMs: 0, toMs: 60_000 },
		])
		await w.advance(14_000)
		expect(w.wavSeconds()).toEqual([])
		for (const v of longVisits(w, SIGNAL_HOP))
			expect((v.endMs ?? w.nowMs()) - v.atMs).toBeLessThanOrEqual(9_000)
		// Nothing on it ever answered voice.
		expect(decisions(w).map(d => d.code)).not.toContain("voiced")
	}, 120_000)
})

describe("a voiced file discarded after its finish says why", () => {
	const captureLog = () => {
		const lines: Record<string, unknown>[] = []
		const stream = new Writable({
			write(chunk: Buffer, _enc, done) {
				for (const l of chunk.toString().split("\n"))
					if (l.length > 0) lines.push(JSON.parse(l) as Record<string, unknown>)
				done()
			},
		})
		return { lines, logger: pino({ level: "info" }, stream) }
	}

	it("the observation lost its association while the file was written", async () => {
		const END_MS = 6_000
		const { lines, logger } = captureLog()
		const w = await sweep(
			[{ hz: SIGNAL_HZ, kind: "voice", fromMs: 0, toMs: END_MS }],
			logger,
		)
		await w.advance(3_000)
		expect(decisions(w).map(d => d.code)).toContain("voiced")
		const store = (w.service as unknown as Internals).store
		store.recordingAssociation = () => null
		// A follow's hold runs 2 s of hang past the voice's end, its file 1 s behind the air.
		await w.advance(END_MS - 3_000 + 2_000 + SETTLED_MS)
		const discarded = decisions(w).find(d => d.code === "discarded:aborted")
		expect(discarded?.receipt).toEqual({
			outcome: "failed",
			errorCode: "admission-denied",
			cutReason: "completed",
			failure: "association-lost",
		})
		expect(w.wavSeconds()).toEqual([])
		const line = lines.find(l => l["decision"] === "discarded:aborted")
		expect(line).toMatchObject({
			receiptOutcome: "failed",
			receiptErrorCode: "admission-denied",
			receiptFailure: "association-lost",
		})
	}, 120_000)

	it("the discovery was deleted while the file was written", async () => {
		const { lines, logger } = captureLog()
		const w = await sweep(
			[{ hz: SIGNAL_HZ, kind: "voice", fromMs: 0, toMs: 20_000 }],
			logger,
		)
		await w.advance(3_000)
		const [discovery] = w.service.listDiscoveries({}).items
		expect(discovery).toBeDefined()
		await w.service.deleteDiscovery(discovery!.id)
		await w.advance(SETTLED_MS)
		// aborted, or write-failed for a push the cancel caught: the receipt tells the same either way.
		const line = lines.find(l => String(l["decision"]).startsWith("discarded:"))
		expect(["discarded:aborted", "discarded:write-failed"]).toContain(
			line?.["decision"],
		)
		expect(line).toMatchObject({
			receiptOutcome: "aborted",
			receiptCut: "discovery-deleted",
			receiptFailure: "cancelled",
		})
	}, 120_000)
})
