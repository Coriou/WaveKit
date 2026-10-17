/**
 * WG10 req 3.5 (identify side): the probe pool's unavailable memo is consumed at planning (trials
 * `unsupported`/`decoder-unavailable`, never requested) and `decodersUnavailable` lists the memo
 * types used plus the types that reported unavailable in this job (sorted, unique, absent when none).
 */
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type {
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
	ScannerProbeDecoderType,
} from "@wavekit/api-types"
import {
	IdentifyRunner,
	applyUnavailableMemo,
	identifyScores,
	normaliseIdentify,
	planIdentifyTrials,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { DecoderSpawnError } from "../../../../src/utils/errors.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, poolHarness } from "../../../mocks/scanner/probe-fakes.js"

const ENDED = ["completed", "cancelled", "failed"]

function harness(
	memo: ((now: number) => ReadonlySet<ScannerProbeDecoderType>) | undefined,
	request: Partial<ScannerIdentifyRequest> = {},
) {
	const settings = testSettings()
	const pool = poolHarness({ settings, cpuPercent: null })
	const calls: number[] = []
	if (memo)
		Object.assign(pool.pool, {
			unavailableTypes: (now: number) => {
				calls.push(now)
				return memo(now)
			},
		})
	const record = identifyRecord()
	const inner = fakeInner(record, () => pool.clock.now)
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			...request,
		}),
		inner,
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: () => undefined,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
	})
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const run = async (track: TrackSnapshot = trackOf({ obwHz: 12_000 })) => {
		await runner.start()
		tracks.push(viewOf(track))
		await advance(100)
		await advance(100)
		await flushAsync()
		for (let i = 0; i < 60 && !ENDED.includes(record.state); i++)
			await advance(1000)
	}
	const created: string[] = []
	pool.decoders.on("decoder:created", (id: string) => {
		created.push(pool.decoders.created.get(id)!.config.type)
	})
	const trials = () =>
		Object.fromEntries(
			(events.at(-1)?.trials ?? []).map(t => [
				t.protocol,
				t.reason ? `${t.outcome}/${t.reason}` : t.outcome,
			]),
		)
	return { ...pool, calls, events, run, created, trials, record }
}

/** Frozen outcomes of the wide 12 kHz track when nothing decodes (identify-runner golden). */
const ALL_NO_SYNC = {
	pocsag: "no-sync",
	flex: "no-sync",
	aprs: "no-sync",
	"analog-fm": "unsupported/no-decoder",
	dmr: "no-sync",
	ysf: "no-sync",
	p25p1: "no-sync",
	nxdn96: "no-sync",
}

describe("identify unavailable memo (WG10 3.5)", () => {
	it("a remembered type is planned unsupported without a spawn and listed", async () => {
		const h = harness(() => new Set(["multimon-ng"] as const))
		await h.run()
		expect(h.trials()).toEqual({
			...ALL_NO_SYNC,
			pocsag: "unsupported/decoder-unavailable",
			flex: "unsupported/decoder-unavailable",
		})
		expect(h.created).not.toContain("multimon-ng")
		expect(h.created.length).toBeGreaterThan(0)
		const pocsag = h.events.at(-1)?.trials.find(t => t.protocol === "pocsag")
		expect(pocsag).toMatchObject({
			decoder: "multimon-ng",
			mode: null,
			transport: null,
		})
		expect(h.events.at(-1)?.result?.decodersUnavailable).toEqual([
			"multimon-ng",
		])
		// The memo is read with the injected clock.
		expect(h.calls.length).toBeGreaterThan(0)
		expect(h.calls.every(c => c >= 1_000_000 && c <= h.clock.now)).toBe(true)
	})

	it("every type remembered: nothing spawned, all listed sorted", async () => {
		const h = harness(
			() => new Set(["multimon-ng", "dsd-fme", "direwolf"] as const),
		)
		await h.run()
		expect(h.created).toEqual([])
		expect(h.events.at(-1)?.result?.decodersUnavailable).toEqual([
			"direwolf",
			"dsd-fme",
			"multimon-ng",
		])
	})

	it("memo plus an in-job unavailable report: sorted unique union", async () => {
		const h = harness(() => new Set(["dsd-fme"] as const))
		const cause = new Error("spawn failed") as NodeJS.ErrnoException
		cause.code = "ENOENT"
		h.decoders.failNext = new DecoderSpawnError("probe", "/bin/sh", cause)
		await h.run()
		expect(h.events.at(-1)?.result?.decodersUnavailable).toEqual([
			"dsd-fme",
			"multimon-ng",
		])
	})

	it("a remembered type the plan does not use is not listed", async () => {
		const h = harness(() => new Set(["rtl433"] as const))
		await h.run()
		expect(h.trials()).toEqual(ALL_NO_SYNC)
		expect(h.events.at(-1)?.result).not.toHaveProperty("decodersUnavailable")
	})

	it("a genuine no-sync stays no-sync and is not listed (empty memo)", async () => {
		const h = harness(() => new Set())
		await h.run()
		expect(h.trials()).toEqual(ALL_NO_SYNC)
		expect(h.events.at(-1)?.result).not.toHaveProperty("decodersUnavailable")
	})

	for (const [label, memo] of [
		[
			"throws",
			() => {
				throw new Error("x")
			},
		],
		["returns garbage", () => ["multimon-ng"] as unknown as Set<never>],
		[
			"returns unknown types",
			() => new Set(["../bin/sh", 7]) as unknown as Set<never>,
		],
	] as const) {
		it(`a memo that ${label} is an empty memo`, async () => {
			const h = harness(memo)
			await h.run()
			expect(h.trials()).toEqual(ALL_NO_SYNC)
			expect(h.events.at(-1)?.result).not.toHaveProperty("decodersUnavailable")
		})
	}

	it("a pool without the method behaves as before", async () => {
		const h = harness(undefined)
		await h.run()
		expect(h.trials()).toEqual(ALL_NO_SYNC)
	})
})

const TYPES: ScannerProbeDecoderType[] = [
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"rtl433",
]

describe("property 10 (identify side)", () => {
	// Feature: web-gaps-10, Property 10: Memo is honest
	// Validates: Requirements 3.5
	it("a trial is decoder-unavailable at planning only for a type in the memo, and every such run is skipped", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3000, max: 20_000 }),
				fc.boolean(),
				fc.subarray(TYPES),
				(obwHz, burst, memoTypes) => {
					const track = trackOf({ obwHz, flags: { ...trackOf().flags, burst } })
					const plan = planIdentifyTrials(
						identifyScores(track, { priors: {}, protocols: [] }),
						{ format: "U8_IQ", channelizer: false },
					)
					const memo = new Set<string>(memoTypes)
					const out = applyUnavailableMemo(plan, memo)
					expect(out.trials).toHaveLength(plan.trials.length)
					out.trials.forEach((t, i) => {
						const before = plan.trials[i]!
						const type =
							before.run === null
								? null
								: plan.runs[before.run]!.mode.decoderType
						if (t.reason === "decoder-unavailable") {
							expect(type).not.toBeNull()
							expect(memo.has(type!)).toBe(true)
							expect(t.run).toBeNull()
						} else {
							expect(t).toEqual(before)
							if (type !== null) expect(memo.has(type)).toBe(false)
						}
					})
					for (const i of out.skip)
						expect(memo.has(plan.runs[i]!.mode.decoderType)).toBe(true)
					expect(out.used).toEqual([...new Set(out.used)].sort())
					for (const u of out.used) expect(memo.has(u)).toBe(true)
					// An empty memo changes nothing.
					expect(applyUnavailableMemo(plan, new Set()).trials).toEqual(
						plan.trials,
					)
				},
			),
			{ numRuns: 150 },
		)
	})
})
