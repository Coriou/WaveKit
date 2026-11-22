import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
	abortableSleep,
	accountStages,
	type ApiEdge,
	buildStages,
	checkQosOptions,
	coreQosLateArgs,
	coreQosPrefix,
	counterDelta,
	counterDeltaOf,
	deltaById,
	expectedNice,
	fakeBehindOf,
	type HogHandle,
	HogPool,
	hogWindowLine,
	noKnownLoss,
	parseHogCount,
	qosOfPri,
	type StageCount,
	stageLoss,
	utcStamp,
} from "../../../scripts/bench/budget-manifest.js"
import { hogExitReason, parseHogArgs } from "../../../scripts/bench/cpu-hog.mjs"

/** A fake hog child: records the signals it got; exits on the signals it honours. */
function fakeHog(
	pid: number | undefined,
	honours: readonly NodeJS.Signals[],
): HogHandle & { signals: NodeJS.Signals[] } {
	let alive = true
	let done: () => void = () => undefined
	const exited = new Promise<void>(r => {
		done = r
	})
	const signals: NodeJS.Signals[] = []
	return {
		pid,
		signals,
		exited,
		isAlive: () => alive,
		kill(signal) {
			signals.push(signal)
			if (alive && honours.includes(signal)) {
				alive = false
				done()
			}
		},
	}
}

const instant = (): Promise<void> => Promise.resolve()

describe("HogPool", () => {
	it("starts N children, records their PIDs and stops each by SIGTERM", async () => {
		const made: ReturnType<typeof fakeHog>[] = []
		const pool = new HogPool(
			i => {
				const h = fakeHog(1000 + i, ["SIGTERM", "SIGKILL"])
				made.push(h)
				return h
			},
			{ sleep: instant },
		)
		const started = await pool.start(3)
		expect(started.startedPids).toEqual([1000, 1001, 1002])
		const rec = await pool.stop()
		expect(rec.count).toBe(3)
		expect(rec.stoppedPids.sort()).toEqual([1000, 1001, 1002])
		expect(rec.killedPids).toEqual([])
		expect(rec.survivorPids).toEqual([])
		for (const h of made) expect(h.signals).toEqual(["SIGTERM"])
	})

	it("sends SIGKILL to a child that ignores SIGTERM for the grace time", async () => {
		const stubborn = fakeHog(2000, ["SIGKILL"])
		const pool = new HogPool(() => stubborn, { sleep: instant, graceMs: 2000 })
		await pool.start(1)
		const rec = await pool.stop()
		expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"])
		expect(rec.killedPids).toEqual([2000])
		expect(rec.stoppedPids).toEqual([2000])
	})

	it("reports a child that survives SIGKILL", async () => {
		const zombie = fakeHog(2100, [])
		const pool = new HogPool(() => zombie, { sleep: instant })
		await pool.start(1)
		const rec = await pool.stop()
		expect(rec.survivorPids).toEqual([2100])
		expect(rec.stoppedPids).toEqual([])
	})

	it("stops the children already started when a spawn throws (error path)", async () => {
		const made: ReturnType<typeof fakeHog>[] = []
		const pool = new HogPool(
			i => {
				if (i === 2) throw new Error("spawn EAGAIN")
				const h = fakeHog(3000 + i, ["SIGTERM"])
				made.push(h)
				return h
			},
			{ sleep: instant },
		)
		await expect(pool.start(4)).rejects.toThrow("spawn EAGAIN")
		expect(made).toHaveLength(2)
		for (const h of made) {
			expect(h.isAlive()).toBe(false)
			expect(h.signals).toEqual(["SIGTERM"])
		}
		expect(pool.record.stoppedPids.sort()).toEqual([3000, 3001])
	})

	it("stops every started child when one comes back without a PID", async () => {
		const first = fakeHog(4000, ["SIGTERM"])
		const pool = new HogPool(i => (i === 0 ? first : fakeHog(undefined, [])), {
			sleep: instant,
		})
		await expect(pool.start(2)).rejects.toThrow("no PID")
		expect(first.isAlive()).toBe(false)
		expect(pool.record.startedPids).toEqual([4000])
	})

	it("stop is idempotent: a second call signals nobody again", async () => {
		const h = fakeHog(5000, ["SIGTERM"])
		const pool = new HogPool(() => h, { sleep: instant })
		await pool.start(1)
		const [a, b] = await Promise.all([pool.stop(), pool.stop()])
		await pool.stop()
		expect(a).toEqual(b)
		expect(h.signals).toEqual(["SIGTERM"])
	})

	it("stopNow sends SIGKILL synchronously to the live children only", async () => {
		const live = fakeHog(6000, ["SIGKILL"])
		const gone = fakeHog(6001, ["SIGTERM", "SIGKILL"])
		let i = 0
		const pool = new HogPool(() => (i++ === 0 ? live : gone), {
			sleep: instant,
		})
		await pool.start(2)
		gone.kill("SIGTERM")
		pool.stopNow()
		expect(live.signals).toEqual(["SIGKILL"])
		expect(gone.signals).toEqual(["SIGTERM"])
	})

	it("checkAlive records the hogs that exited before the close (m2)", async () => {
		const made: ReturnType<typeof fakeHog>[] = []
		const pool = new HogPool(
			i => {
				const h = fakeHog(3000 + i, ["SIGTERM", "SIGKILL"])
				made.push(h)
				return h
			},
			{ sleep: instant },
		)
		await pool.start(3)
		expect(pool.record.effectiveCount).toBeNull()
		made[1]?.kill("SIGTERM")
		const rec = pool.checkAlive()
		expect(rec.exitedEarlyPids).toEqual([3001])
		expect(rec.effectiveCount).toBe(2)
		const end = await pool.stop()
		expect(end.exitedEarlyPids).toEqual([3001])
		expect(end.effectiveCount).toBe(2)
	})

	it("refuses a second start", async () => {
		const pool = new HogPool(() => fakeHog(7000, ["SIGTERM"]), {
			sleep: instant,
		})
		await pool.start(1)
		await expect(pool.start(1)).rejects.toThrow("already used")
		await pool.stop()
	})
})

describe("hog options and the progress line", () => {
	it("parses --hog", () => {
		expect(parseHogCount(undefined, 8)).toBe(0)
		expect(parseHogCount("0", 8)).toBe(0)
		expect(parseHogCount("3", 8)).toBe(3)
		expect(parseHogCount("auto", 8)).toBe(8)
		expect(parseHogCount("auto", 0)).toBe(1)
		expect(parseHogCount("-1", 8)).toBeNull()
		expect(parseHogCount("2.5", 8)).toBeNull()
		expect(parseHogCount("999", 8)).toBeNull()
	})

	it("stamps UTC to the second like date -u +%FT%TZ", () => {
		expect(utcStamp(Date.UTC(2026, 10, 22, 9, 8, 7, 654))).toBe(
			"2026-11-22T09:08:07Z",
		)
	})

	it("formats the hog-window line", () => {
		expect(
			hogWindowLine({
				startUtc: "2026-11-22T09:00:00Z",
				stopUtc: "2026-11-22T09:01:12Z",
				count: 8,
				label: "hog-auto",
				load1Start: 12.345,
				load1End: null,
			}),
		).toBe(
			"2026-11-22T09:00:00Z .. 2026-11-22T09:01:12Z hog window N=8 label=hog-auto load1=12.35/n/a",
		)
	})
})

function stage(over: Partial<StageCount> & { id: string }): StageCount {
	return {
		label: over.id,
		order: 0,
		inSamples: 1000,
		outSamples: 1000,
		droppedSamples: null,
		toleranceSamples: 0,
		source: "test",
		reset: false,
		...over,
	}
}

describe("stage loss", () => {
	it("is not losing at zero loss", () => {
		const r = stageLoss(stage({ id: "s" }))
		expect(r.lostSamples).toBe(0)
		expect(r.lossShare).toBe(0)
		expect(r.losing).toBe(false)
	})

	it("is not losing before zero (out above in: counter skew)", () => {
		const r = stageLoss(stage({ id: "s", outSamples: 1010 }))
		expect(r.lostSamples).toBe(-10)
		expect(r.losing).toBe(false)
	})

	it("is losing past zero with no tolerance", () => {
		const r = stageLoss(stage({ id: "s", outSamples: 999 }))
		expect(r.lostSamples).toBe(1)
		expect(r.lossShare).toBeCloseTo(0.001)
		expect(r.losing).toBe(true)
	})

	it("is not losing at the tolerance and losing past it", () => {
		expect(
			stageLoss(stage({ id: "s", outSamples: 900, toleranceSamples: 100 }))
				.losing,
		).toBe(false)
		expect(
			stageLoss(stage({ id: "s", outSamples: 899, toleranceSamples: 100 }))
				.losing,
		).toBe(true)
	})

	it("prefers an explicit drop counter to in − out", () => {
		const r = stageLoss(stage({ id: "s", outSamples: 500, droppedSamples: 0 }))
		expect(r.lostSamples).toBe(0)
		expect(r.losing).toBe(false)
		expect(
			stageLoss(stage({ id: "s", inSamples: null, droppedSamples: 3 })),
		).toMatchObject({ lostSamples: 3, lossShare: null, losing: true })
	})

	it("is unknown after a counter reset, even with a drop counter", () => {
		expect(
			stageLoss(stage({ id: "s", droppedSamples: 0, reset: true })),
		).toMatchObject({ lostSamples: null, losing: null })
	})

	it("is unknown without a counter", () => {
		expect(stageLoss(stage({ id: "s", outSamples: null }))).toMatchObject({
			lostSamples: null,
			lossShare: null,
			losing: null,
		})
	})
})

describe("first losing stage", () => {
	const path = (lost: [number, number, number]): StageCount[] => [
		stage({ id: "c", order: 2, outSamples: 1000 - lost[2] }),
		stage({ id: "a", order: 0, outSamples: 1000 - lost[0] }),
		stage({ id: "b", order: 1, outSamples: 1000 - lost[1] }),
	]

	it("is null when every stage is at or before zero loss", () => {
		const acc = accountStages(path([0, -5, 0]))
		expect(acc.firstLosing).toBeNull()
		expect(acc.stages.map(s => s.id)).toEqual(["a", "b", "c"])
		expect(acc.unknownBefore).toEqual([])
	})

	it("names the earliest stage along the path, not the largest loss", () => {
		const acc = accountStages(path([0, 1, 500]))
		expect(acc.firstLosing).toEqual({
			id: "b",
			label: "b",
			lostSamples: 1,
			lossShare: 0.001,
		})
	})

	it("lists the stages of unknown loss before the first losing one", () => {
		const acc = accountStages([
			stage({ id: "a", order: 0, outSamples: null }),
			stage({ id: "b", order: 1, outSamples: 990 }),
			stage({ id: "c", order: 2, outSamples: null }),
		])
		expect(acc.firstLosing?.id).toBe("b")
		expect(acc.unknownBefore).toEqual(["a"])
	})

	it("counts an unknown parallel consumer of the losing stage, never the losing stage itself", () => {
		const acc = accountStages([
			stage({ id: "fanout:a", order: 3, droppedSamples: 9 }),
			stage({ id: "fanout:b", order: 3, outSamples: null }),
			stage({ id: "channel:x", order: 4, outSamples: null }),
		])
		expect(acc.firstLosing?.id).toBe("fanout:a")
		expect(acc.unknownBefore).toEqual(["fanout:b"])
	})

	it("lists every unknown stage when none lost", () => {
		const acc = accountStages([
			stage({ id: "a", order: 0 }),
			stage({ id: "b", order: 5, outSamples: null }),
		])
		expect(acc.firstLosing).toBeNull()
		expect(acc.unknownBefore).toEqual(["b"])
	})

	it("treats parallel consumers (same order) alike and picks by id", () => {
		const acc = accountStages([
			stage({ id: "fanout:z", order: 3, droppedSamples: 4 }),
			stage({ id: "fanout:a", order: 3, droppedSamples: 2 }),
		])
		expect(acc.firstLosing?.id).toBe("fanout:a")
	})
})

describe("counterDelta", () => {
	it("is b − a, or null when either side is unknown", () => {
		expect(counterDelta(10, 25)).toBe(15)
		expect(counterDelta(null, 25)).toBeNull()
		expect(counterDelta(10, undefined)).toBeNull()
		expect(counterDelta(Number.NaN, 1)).toBeNull()
	})

	it("is unknown with a reset flag when the counter went back (never a negative loss)", () => {
		expect(counterDelta(100, 40)).toBeNull()
		expect(counterDeltaOf(100, 40)).toEqual({ delta: null, reset: true })
		expect(counterDeltaOf(40, 40)).toEqual({ delta: 0, reset: false })
	})
})

describe("deltaById", () => {
	type Row = { id: string; v: number | null }
	const v = (x: Row) => x.v

	it("is unknown for every row when edge A failed (cumulative is not a window delta)", () => {
		expect(deltaById<Row>(null, [{ id: "x", v: 5000 }], v)).toEqual([
			{
				id: "x",
				delta: null,
				openedInWindow: false,
				closedInWindow: false,
				reset: false,
			},
		])
	})

	it("lists edge A's ids as unknown when edge B failed", () => {
		expect(deltaById<Row>([{ id: "x", v: 1 }], null, v)).toEqual([
			{
				id: "x",
				delta: null,
				openedInWindow: false,
				closedInWindow: false,
				reset: false,
			},
		])
	})

	it("treats an id only at B (A parsed) as opened in the window", () => {
		expect(deltaById<Row>([], [{ id: "y", v: 70 }], v)).toEqual([
			{
				id: "y",
				delta: 70,
				openedInWindow: true,
				closedInWindow: false,
				reset: false,
			},
		])
	})

	it("lists an id of A missing at a parsed B as closed in the window, unknown (MA2)", () => {
		expect(
			deltaById<Row>(
				[
					{ id: "b1", v: 1 },
					{ id: "b2", v: 5 },
				],
				[{ id: "b1", v: 9 }],
				v,
			),
		).toEqual([
			{
				id: "b1",
				delta: 8,
				openedInWindow: false,
				closedInWindow: false,
				reset: false,
			},
			{
				id: "b2",
				delta: null,
				openedInWindow: false,
				closedInWindow: true,
				reset: false,
			},
		])
	})

	it("flags a reset and an unknown value", () => {
		expect(
			deltaById<Row>(
				[
					{ id: "r", v: 900 },
					{ id: "n", v: null },
				],
				[
					{ id: "r", v: 10 },
					{ id: "n", v: 50 },
				],
				v,
			),
		).toEqual([
			{
				id: "r",
				delta: null,
				openedInWindow: false,
				closedInWindow: false,
				reset: true,
			},
			{
				id: "n",
				delta: null,
				openedInWindow: false,
				closedInWindow: false,
				reset: false,
			},
		])
	})
})

describe("buildStages", () => {
	const RATE = 2_400_000
	const edge = (over: Partial<ApiEdge>): ApiEdge => ({
		signalMs: 0,
		doneMs: 100,
		sources: [{ id: "src", bytesReceived: 0 }],
		fanout: {
			branches: [{ id: "b1", droppedBytesTotal: 0, totalBytesWritten: 0 }],
		},
		diagnostics: { channels: null },
		decoders: [{ id: "dec", stats: { bytesIn: 0 } }],
		liveAudio: {
			autoRoute: {
				underruns: 0,
				zeroFilledSamples: 0,
				droppedMs: 0,
				clientCount: 1,
			},
		},
		standins: { "tool-1.json": { name: "tool", pid: 1, bytes: 0 } },
		...over,
	})
	const later = (scale: number): ApiEdge =>
		edge({
			sources: [{ id: "src", bytesReceived: 2 * RATE * scale }],
			fanout: {
				branches: [
					{
						id: "b1",
						droppedBytesTotal: 0,
						totalBytesWritten: 2 * RATE * scale,
					},
				],
			},
			decoders: [{ id: "dec", stats: { bytesIn: 2 * RATE * scale } }],
			standins: {
				"tool-1.json": { name: "tool", pid: 1, bytes: 2 * RATE * scale },
			},
		})
	const inputs = (edgeA: ApiEdge | null, edgeB: ApiEdge | null) => ({
		rateHz: RATE,
		windowSeconds: 10,
		sourceId: "src",
		socketBytes: 2 * RATE * 10,
		fakeA: { bytes: 0, skippedSeconds: 0 },
		fakeB: { bytes: 2 * RATE * 10, skippedSeconds: 0 },
		edgeA,
		edgeB,
		autoA: { ms: 0, bytes: 0 },
		autoB: { ms: 10_000, bytes: 2 * 48_000 * 10 },
	})
	const byId = (stages: StageCount[], id: string) => {
		const r = accountStages(stages).stages.find(s => s.id === id)
		if (r === undefined) throw new Error(`no stage ${id}`)
		return r
	}

	it("accounts a clean window as no loss", () => {
		const acc = accountStages(buildStages(inputs(edge({}), later(10))))
		expect(acc.firstLosing).toBeNull()
		expect(acc.unknownBefore).toEqual([])
		expect(acc.stages.every(s => s.losing === false)).toBe(true)
	})

	it("edge A null: the core's stages are unknown, never ok", () => {
		const stages = buildStages(inputs(null, later(10)))
		for (const id of ["source-manager", "fanout:b1", "decoder-stdin"])
			expect(byId(stages, id).losing).toBeNull()
		expect(byId(stages, "auto-route-dropped").losing).toBeNull()
	})

	it("edge B null: the core's stages are unknown and edge A's branches stay listed", () => {
		const stages = buildStages(inputs(edge({}), null))
		expect(byId(stages, "fanout:b1").losing).toBeNull()
		expect(byId(stages, "source-manager").losing).toBeNull()
		expect(byId(stages, "decoder-stdin").losing).toBeNull()
	})

	it("decoder input is unknown when only the decoders read failed at one edge", () => {
		const stages = buildStages(
			inputs(edge({ decoders: null, standins: {} }), later(0)),
		)
		expect(byId(stages, "decoder-stdin").inSamples).toBeNull()
		expect(byId(stages, "decoder-stdin").losing).toBeNull()
	})

	it("a branch only at B counts from zero (opened in the window)", () => {
		const b = later(10)
		const stages = buildStages(
			inputs(
				edge({}),
				edge({
					...b,
					fanout: {
						branches: [
							{
								id: "b1",
								droppedBytesTotal: 0,
								totalBytesWritten: 2 * RATE * 10,
							},
							{ id: "b2", droppedBytesTotal: 400, totalBytesWritten: 1000 },
						],
					},
				}),
			),
		)
		const b2 = byId(stages, "fanout:b2")
		expect(b2.droppedSamples).toBe(200)
		expect(b2.losing).toBe(true)
		expect(b2.source).toContain("added in the window")
	})

	it("a counter reset reads as unknown with the reset flag, not as a negative loss", () => {
		const a = edge({
			fanout: {
				branches: [
					{
						id: "b1",
						droppedBytesTotal: 5000,
						totalBytesWritten: 9 * RATE * 10,
					},
				],
			},
			liveAudio: {
				autoRoute: {
					underruns: 9,
					zeroFilledSamples: 900,
					droppedMs: 50,
					clientCount: 1,
				},
			},
		})
		const stages = buildStages(inputs(a, later(10)))
		const fan = byId(stages, "fanout:b1")
		expect(fan.reset).toBe(true)
		expect(fan.losing).toBeNull()
		expect(byId(stages, "auto-route-dropped")).toMatchObject({
			reset: true,
			losing: null,
		})
		expect(byId(stages, "auto-route-zero-fill")).toMatchObject({
			reset: true,
			losing: null,
		})
	})

	it("a stand-in count file listed but unparsable at edge A makes the stage unknown", () => {
		const stages = buildStages(
			inputs(edge({ standins: { "tool-1.json": null } }), later(10)),
		)
		expect(byId(stages, "decoder-stdin").outSamples).toBeNull()
		expect(byId(stages, "decoder-stdin").losing).toBeNull()
	})

	it("an unlisted stand-in dir at an edge makes the stage unknown", () => {
		const stages = buildStages(inputs(edge({ standins: null }), later(10)))
		expect(byId(stages, "decoder-stdin").losing).toBeNull()
	})

	it("a stand-in started in the window counts from zero", () => {
		const stages = buildStages(inputs(edge({ standins: {} }), later(10)))
		expect(byId(stages, "decoder-stdin").losing).toBe(false)
	})

	it("a channel whose stats are null at edge A is unknown", () => {
		const row = (
			stats: { outputSamples: number; droppedSamples: number } | null,
		) => ({
			channels: {
				rows: [{ id: "c1", decoderId: "dmr", format: "cu8", stats }],
			},
		})
		const stages = buildStages(
			inputs(
				edge({ diagnostics: row(null) }),
				edge({
					...later(10),
					diagnostics: row({ outputSamples: 1000, droppedSamples: 0 }),
				}),
			),
		)
		expect(byId(stages, "channel:dmr").losing).toBeNull()
	})

	it("a core that stopped reading for 60 s: the backlog past 2 s at B is lost", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: { bytes: 5000, skippedSeconds: 8, monoMs: 1000, behindMs: 0 },
			fakeB: {
				bytes: 5000,
				skippedSeconds: 8,
				monoMs: 61_000,
				behindMs: 60_000,
				blocked: true,
			},
		})
		expect(byId(stages, "fake-schedule")).toMatchObject({
			inSamples: 60 * RATE,
			outSamples: 0,
			droppedSamples: 60 * RATE,
			losing: true,
		})
	})

	it("older marks without a lag: a lag grown past 2 s counts as lost (a lower bound), never ok", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: { bytes: 5000, skippedSeconds: 8, monoMs: 1000 },
			fakeB: { bytes: 5000, skippedSeconds: 8, monoMs: 61_000 },
		})
		expect(byId(stages, "fake-schedule")).toMatchObject({
			droppedSamples: 60 * RATE,
			losing: true,
		})
		expect(byId(stages, "fake-schedule").source).toContain("lower bound")
	})

	it("repro A (MA1): 1.5 s behind at A, caught up, 1 s skipped reads as 1 s lost", () => {
		const fakeA = { bytes: 0, skippedSeconds: 0, monoMs: 0 }
		const fakeB = { bytes: 2 * RATE * 10.5, skippedSeconds: 1, monoMs: 10_000 }
		for (const [a, b] of [
			[fakeA, fakeB],
			[
				{ ...fakeA, behindMs: 1500, blocked: false },
				{ ...fakeB, behindMs: 0, blocked: false },
			],
		] as const) {
			const stages = buildStages({
				...inputs(edge({}), later(10)),
				fakeA: a,
				fakeB: b,
			})
			expect(byId(stages, "fake-schedule")).toMatchObject({
				droppedSamples: RATE,
				lostSamples: RATE,
				losing: true,
			})
			expect(accountStages(stages).firstLosing?.id).toBe("fake-schedule")
		}
	})

	it("repro B (MA1): a 1 s stall right before close is late signal, not loss", () => {
		const fakeA = {
			bytes: 0,
			skippedSeconds: 0,
			monoMs: 0,
			behindMs: 0,
			blocked: false,
		}
		const fakeB = {
			bytes: 2 * RATE * 9,
			skippedSeconds: 0,
			monoMs: 10_000,
			behindMs: 1000,
			blocked: true,
		}
		const stages = buildStages({
			...inputs(edge({}), later(9)),
			socketBytes: 2 * RATE * 9,
			fakeA,
			fakeB,
		})
		expect(byId(stages, "fake-schedule")).toMatchObject({
			droppedSamples: 0,
			losing: false,
		})
		expect(byId(stages, "fake-schedule").source).toContain(
			"at B 1.00 s (blocked)",
		)
		expect(accountStages(stages).firstLosing).toBeNull()
		expect(fakeBehindOf(fakeA, fakeB)).toEqual({
			aS: 0,
			bS: 1,
			blockedA: false,
			blockedB: true,
		})
	})

	it("older marks without a lag: a lag grown under 2 s is late, not lost", () => {
		const stages = buildStages({
			...inputs(edge({}), later(9)),
			socketBytes: 2 * RATE * 9,
			fakeA: { bytes: 0, skippedSeconds: 0, monoMs: 0 },
			fakeB: { bytes: 2 * RATE * 9, skippedSeconds: 0, monoMs: 10_000 },
		})
		expect(byId(stages, "fake-schedule")).toMatchObject({
			droppedSamples: 0,
			losing: false,
		})
	})

	it("a backlog already past 2 s at A is not counted twice", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: { bytes: 0, skippedSeconds: 0, monoMs: 0, behindMs: 3000 },
			fakeB: {
				bytes: 2 * RATE * 10,
				skippedSeconds: 3,
				monoMs: 13_000,
				behindMs: 0,
			},
		})
		expect(byId(stages, "fake-schedule")).toMatchObject({
			droppedSamples: 0,
			losing: false,
		})
	})

	it("a reconnect in the window makes the fake stage unknown, not a negative loss", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: {
				bytes: 0,
				skippedSeconds: 0,
				monoMs: 0,
				behindMs: 3000,
				blocked: true,
				clients: 1,
			},
			fakeB: {
				bytes: 2 * RATE * 10,
				skippedSeconds: 2.5,
				monoMs: 10_000,
				behindMs: 0,
				clients: 2,
			},
		})
		const fake = byId(stages, "fake-schedule")
		expect(fake.droppedSamples).toBeNull()
		expect(fake.losing).toBeNull()
	})

	it("a pending backlog that never became a skip is unknown, never a negative loss", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: { bytes: 0, skippedSeconds: 0, monoMs: 0, behindMs: 3000 },
			fakeB: {
				bytes: 2 * RATE * 10,
				skippedSeconds: 0,
				monoMs: 13_000,
				behindMs: 0,
			},
		})
		const fake = byId(stages, "fake-schedule")
		expect(fake.droppedSamples).toBeNull()
		expect(fake.losing).toBeNull()
	})

	it("the same client at both edges keeps the fake stage known", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: {
				bytes: 0,
				skippedSeconds: 0,
				monoMs: 0,
				behindMs: 0,
				clients: 1,
			},
			fakeB: {
				bytes: 2 * RATE * 9,
				skippedSeconds: 1,
				monoMs: 10_000,
				behindMs: 0,
				clients: 1,
			},
		})
		expect(byId(stages, "fake-schedule")).toMatchObject({
			droppedSamples: RATE,
			losing: true,
		})
	})

	it("a branch and a decoder closed in the window are unknown, not no loss (MA2)", () => {
		const b = later(10)
		const stages = buildStages(
			inputs(
				edge({
					fanout: {
						branches: [
							{ id: "b1", droppedBytesTotal: 0, totalBytesWritten: 0 },
							{ id: "b2", droppedBytesTotal: 0, totalBytesWritten: 0 },
						],
					},
					decoders: [
						{ id: "dec", stats: { bytesIn: 0 } },
						{ id: "gone", stats: { bytesIn: 0 } },
					],
				}),
				b,
			),
		)
		const b2 = byId(stages, "fanout:b2")
		expect(b2.losing).toBeNull()
		expect(b2.source).toContain("closed in the window")
		expect(byId(stages, "fanout:b1").losing).toBe(false)
		expect(byId(stages, "decoder-stdin").inSamples).toBeNull()
		expect(byId(stages, "decoder-stdin").losing).toBeNull()
		expect(accountStages(stages).unknownBefore).toContain("fanout:b2")
	})

	it("a fake that kept its schedule over its clock is not losing", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: { bytes: 0, skippedSeconds: 0, monoMs: 0 },
			fakeB: { bytes: 2 * RATE * 10, skippedSeconds: 0, monoMs: 10_100 },
		})
		expect(byId(stages, "fake-schedule").losing).toBe(false)
	})

	it("the fake's own counter reset is unknown, not a negative schedule", () => {
		const stages = buildStages({
			...inputs(edge({}), later(10)),
			fakeA: { bytes: 2 * RATE * 20, skippedSeconds: 0 },
		})
		expect(byId(stages, "fake-schedule")).toMatchObject({
			reset: true,
			losing: null,
		})
	})
})

describe("cpu-hog lifetime (B1)", () => {
	it("ends when its parent changed or is PID 1, or at its cap", () => {
		const base = {
			expectedParent: 500,
			currentParent: 500,
			startMs: 0,
			nowMs: 1000,
			maxMs: 5000,
		}
		expect(hogExitReason(base)).toBeNull()
		expect(hogExitReason({ ...base, currentParent: 1 })).toBe("parent")
		expect(hogExitReason({ ...base, currentParent: 777 })).toBe("parent")
		expect(
			hogExitReason({ ...base, expectedParent: 1, currentParent: 1 }),
		).toBe("parent")
		expect(hogExitReason({ ...base, nowMs: 5000 })).toBe("lifetime")
	})

	it("parses --parent and --max-seconds", () => {
		expect(parseHogArgs([], 42)).toEqual({ expectedParent: 42, maxMs: 300_000 })
		expect(parseHogArgs(["--parent", "7", "--max-seconds", "1.5"], 42)).toEqual(
			{ expectedParent: 7, maxMs: 1500 },
		)
		expect(parseHogArgs(["--max-seconds", "0"], 42)).toBeNull()
		expect(parseHogArgs(["--bogus", "1"], 42)).toBeNull()
		expect(parseHogArgs(["--parent"], 42)).toBeNull()
	})

	it("a real hog child with a short lifetime exits by itself", async () => {
		const hog = fileURLToPath(
			new URL("../../../scripts/bench/cpu-hog.mjs", import.meta.url),
		)
		const child = spawn(
			process.execPath,
			[hog, "--parent", String(process.pid), "--max-seconds", "0.5"],
			{ stdio: "ignore" },
		)
		const pid = child.pid
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				const t = setTimeout(
					() => reject(new Error("hog did not exit by itself")),
					15_000,
				)
				child.once("exit", c => {
					clearTimeout(t)
					resolve(c)
				})
			})
			expect(code).toBe(0)
		} finally {
			// Only the PID this test started, and only if it is still running.
			if (
				pid !== undefined &&
				child.exitCode === null &&
				child.signalCode === null
			)
				process.kill(pid, "SIGKILL")
		}
	}, 20_000)

	it("a real hog told a parent it does not have exits at once (reparent path)", async () => {
		const hog = fileURLToPath(
			new URL("../../../scripts/bench/cpu-hog.mjs", import.meta.url),
		)
		const child = spawn(
			process.execPath,
			[hog, "--parent", "1", "--max-seconds", "30"],
			{ stdio: "ignore" },
		)
		const pid = child.pid
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				const t = setTimeout(
					() => reject(new Error("hog did not exit")),
					15_000,
				)
				child.once("exit", c => {
					clearTimeout(t)
					resolve(c)
				})
			})
			expect(code).toBe(3)
		} finally {
			if (
				pid !== undefined &&
				child.exitCode === null &&
				child.signalCode === null
			)
				process.kill(pid, "SIGKILL")
		}
	}, 20_000)
})

describe("HogPool race timers (m4)", () => {
	it("clears the race sleep once the child exited", async () => {
		const aborted: boolean[] = []
		const h = fakeHog(8000, ["SIGTERM"])
		const pool = new HogPool(() => h, {
			sleep: (_ms, signal) =>
				new Promise<void>(r => {
					signal.addEventListener("abort", () => {
						aborted.push(true)
						r()
					})
				}),
		})
		await pool.start(1)
		await pool.stop()
		expect(aborted).toEqual([true])
	})

	it("abortableSleep resolves on abort without waiting for its timer", async () => {
		const ac = new AbortController()
		const t0 = Date.now()
		const p = abortableSleep(60_000, ac.signal)
		ac.abort()
		await p
		expect(Date.now() - t0).toBeLessThan(1000)
		await abortableSleep(10, new AbortController().signal)
	})
})

describe("core QoS and nice", () => {
	it("maps --core-qos to the taskpolicy prefix", () => {
		expect(coreQosPrefix("default", "/usr/sbin/taskpolicy")).toEqual([])
		expect(coreQosPrefix("utility", "/usr/sbin/taskpolicy")).toEqual([
			"/usr/sbin/taskpolicy",
			"-c",
			"utility",
		])
		expect(coreQosPrefix("background", "tp")).toEqual(["tp", "-b"])
	})

	it("maps --core-qos-late to taskpolicy -p arguments and back", () => {
		expect(coreQosLateArgs("background")).toEqual({
			apply: ["-b"],
			remove: ["-B"],
		})
		expect(coreQosLateArgs("utility")).toEqual({
			apply: ["-t", "2", "-l", "3"],
			remove: ["-t", "0", "-l", "0"],
		})
	})

	it("refuses --core-qos with --core-qos-late", () => {
		expect(() => checkQosOptions("utility", "background")).toThrow(
			/mutually exclusive/,
		)
		expect(() => checkQosOptions(undefined, "background")).not.toThrow()
		expect(() => checkQosOptions("background", undefined)).not.toThrow()
	})

	it("says none only when no stage is unknown (m1)", () => {
		expect(noKnownLoss([])).toBe("none")
		expect(noKnownLoss(["fanout:b2", "decoder-stdin"])).toBe(
			"no known stage lost; unknown: fanout:b2, decoder-stdin",
		)
	})

	it("infers the class from ps pri", () => {
		expect(qosOfPri(null)).toBeNull()
		expect(qosOfPri(4)).toBe("background")
		expect(qosOfPri(20)).toBe("utility")
		expect(qosOfPri(31)).toBe("default")
	})

	it("clamps the expected nice to [-20, 19] (m3)", () => {
		expect(expectedNice(5, 10)).toBe(15)
		expect(expectedNice(15, 10)).toBe(19)
		expect(expectedNice(0, -25)).toBe(-20)
	})
})
