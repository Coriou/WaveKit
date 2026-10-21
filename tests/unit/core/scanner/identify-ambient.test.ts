import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type {
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
} from "@wavekit/api-types"
import { IDENTIFY_AMBIENT_MAX_TRIALS } from "@wavekit/api-types"
import {
	IDENTIFY_PROTOCOLS,
	IdentifyRunner,
	normaliseIdentify,
	planAmbientTrials,
	type AmbientCoverageLike,
	type IdentifyAmbientLookup,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type {
	DecodeEvidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
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

const AIS: AmbientCoverageLike = {
	decoderId: "ais-1",
	type: "ais-catcher",
	protocol: "ais",
}
const dmrTrack = () => trackOf({ acf30: -0.94, acf60: 0.99 })

function harness(
	opts: {
		request?: Partial<ScannerIdentifyRequest>
		ambient?: IdentifyAmbientLookup
		channelizer?: boolean
		/** Use the runner without ambient coverage as the inertness oracle. */
		oracle?: boolean
		logger?: pino.Logger
	} = {},
) {
	const settings = testSettings()
	const pool = poolHarness({ settings, cpuPercent: null })
	const record = identifyRecord()
	const inner = fakeInner(record, () => pool.clock.now)
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const calls: [string, number, number][] = []
	const ambient = opts.ambient
	const Runner = IdentifyRunner
	const runner = new Runner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			timeoutMs: 5000,
			...opts.request,
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
		channelizer: () => opts.channelizer ?? false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: opts.logger ?? pino({ level: "silent" }),
		now: () => pool.clock.now,
		...(ambient
			? {
					ambient: (s: string, hz: number, tol: number) => {
						calls.push([s, hz, tol])
						return ambient(s, hz, tol)
					},
				}
			: {}),
	})
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const last = () => events.at(-1)
	const outcomes = () =>
		Object.fromEntries((last()?.trials ?? []).map(t => [t.protocol, t.outcome]))
	return {
		...pool,
		record,
		tracks,
		events,
		runner,
		advance,
		last,
		outcomes,
		calls,
	}
}

function aisEvidence(over: Partial<DecodeEvidence> = {}): DecodeEvidence {
	return {
		protocol: "ais",
		identity: { kind: "ais-mmsi", value: "227006760" },
		metadata: {},
		crcClean: true,
		at: 0,
		epoch: 1,
		origin: "ambient",
		decoderId: "ais-1",
		...over,
	}
}

/** Starts the runner, resolves a track and plans (two ticks). */
async function resolved(h: ReturnType<typeof harness>, track = trackOf()) {
	await h.runner.start()
	h.tracks.push(viewOf(track))
	await h.advance(100)
	await h.advance(100)
}

describe("identify ambient trials (WG7 req 1.5-1.7)", () => {
	it("lists the four ambient protocols in IDENTIFY_PROTOCOLS", () => {
		expect(IDENTIFY_PROTOCOLS).toEqual(
			expect.arrayContaining(["ais", "acars", "vdl2", "lora"]),
		)
	})

	it("decodes a covering AIS decoder's ambient identity: identified, protocol ais, identity ais-mmsi", async () => {
		const h = harness({ ambient: () => [AIS], request: { protocols: ["ais"] } })
		await resolved(h)
		expect(h.calls).toEqual([["rtl", TARGET_HZ, 1000]])
		expect(h.last()?.trials).toEqual([
			{
				protocol: "ais",
				decoder: "ais-catcher",
				mode: "ais-catcher",
				transport: "ambient",
				outcome: "running",
			},
		])
		expect(h.decoders.created.size).toBe(0)
		h.runner.onAmbientEvidence("o_t1", aisEvidence())
		await h.advance(100)
		expect(h.last()).toMatchObject({
			state: "identified",
			trials: [{ protocol: "ais", outcome: "decoded" }],
			result: {
				protocol: "ais",
				identity: { kind: "ais-mmsi", value: "227006760" },
				observationId: "o_t1",
			},
		})
		await h.advance(100)
		expect(h.record.state).toBe("completed")
	})

	it.each([
		["another observation", "o_other", aisEvidence()],
		["evidence of another epoch", "o_t1", aisEvidence({ epoch: 2 })],
		[
			"evidence without identity",
			"o_t1",
			aisEvidence({ identity: undefined as never }),
		],
		["another protocol", "o_t1", aisEvidence({ protocol: "acars" })],
		["a CRC failure", "o_t1", aisEvidence({ crcClean: false })],
		["probe origin", "o_t1", aisEvidence({ origin: "probe" })],
	] as const)(
		"ignores %s, then times out at the deadline",
		async (_n, obs, ev) => {
			const h = harness({
				ambient: () => [AIS],
				request: { protocols: ["ais"] },
			})
			const e = { ...ev } as DecodeEvidence
			if (e.identity === undefined) delete e.identity
			await resolved(h)
			h.runner.onAmbientEvidence(obs, e)
			await h.advance(100)
			expect(h.outcomes()).toEqual({ ais: "running" })
			expect(h.last()?.state).toBe("trying")
			for (let i = 0; i < 60 && h.record.state === "running"; i++)
				await h.advance(100)
			expect(h.outcomes()).toEqual({ ais: "timeout" })
			expect(h.last()?.state).not.toBe("identified")
		},
	)

	it("ignores evidence after the ambient deadline; the next tick ends the trial timeout", async () => {
		const h = harness({ ambient: () => [AIS], request: { protocols: ["ais"] } })
		await resolved(h)
		h.clock.now += 10_000
		h.runner.onAmbientEvidence("o_t1", aisEvidence())
		await h.advance(1)
		expect(h.outcomes()).toEqual({ ais: "timeout" })
		expect(h.last()?.state).not.toBe("identified")
	})

	it("logs a throwing ambient lookup once with a fixed message and no exception payload", async () => {
		const lines: string[] = []
		const logger = pino(
			{ level: "debug" },
			{ write: (s: string) => void lines.push(s) },
		)
		const h = harness({
			logger,
			ambient: () => {
				throw new Error("secret-lookup-detail")
			},
		})
		await resolved(h)
		for (let i = 0; i < 4; i++) await h.advance(500)
		const warns = lines.filter(l => l.includes("Ambient coverage unavailable"))
		expect(warns).toHaveLength(1)
		expect(lines.join("")).not.toContain("secret-lookup-detail")
		expect(warns[0]).not.toContain('"err"')
	})

	it("non-exhaustive: an ambient decode makes the probe trials not-needed and releases the probe", async () => {
		const h = harness({
			ambient: () => [AIS],
			request: { protocols: ["dmr", "ais"] },
		})
		await resolved(h, dmrTrack())
		await flushAsync()
		expect(h.outcomes()).toEqual({ dmr: "running", ais: "running" })
		h.runner.onAmbientEvidence("o_t1", aisEvidence())
		await h.advance(100)
		await h.advance(100)
		expect(h.outcomes()).toEqual({ dmr: "not-needed", ais: "decoded" })
		expect(h.last()?.state).toBe("identified")
		expect(h.decoders.created.size).toBe(0)
	})

	it("non-exhaustive: a probe-less target ends an ambient trial not-needed after another ambient decode", async () => {
		const h = harness({
			ambient: () => [
				AIS,
				{ decoderId: "acars-1", type: "acarsdec", protocol: "acars" },
			],
			request: { protocols: ["ais", "acars"] },
		})
		await resolved(h)
		h.runner.onAmbientEvidence("o_t1", aisEvidence())
		await h.advance(100)
		expect(h.outcomes()).toEqual({ ais: "decoded", acars: "not-needed" })
	})

	it("exhaustive: probe trials continue after an ambient decode and the other ambient trial waits", async () => {
		const h = harness({
			ambient: () => [
				AIS,
				{ decoderId: "acars-1", type: "acarsdec", protocol: "acars" },
			],
			request: { protocols: ["dmr", "ais", "acars"], exhaustive: true },
		})
		await resolved(h, dmrTrack())
		h.runner.onAmbientEvidence("o_t1", aisEvidence())
		await h.advance(100)
		expect(h.outcomes()).toEqual({
			dmr: "running",
			ais: "decoded",
			acars: "running",
		})
		for (let i = 0; i < 80 && h.record.state === "running"; i++)
			await h.advance(100)
		expect(h.outcomes()).toEqual({
			dmr: "no-sync",
			ais: "decoded",
			acars: "timeout",
		})
		expect(h.last()).toMatchObject({
			state: "identified",
			result: { protocol: "ais" },
		})
	})

	it("cancels running ambient trials on a window move", async () => {
		const h = harness({ ambient: () => [AIS], request: { protocols: ["ais"] } })
		await resolved(h)
		h.engine.setEpoch(2, 447_500_000)
		await h.advance(100)
		expect(h.outcomes()).toEqual({ ais: "cancelled" })
		expect(h.last()?.result?.ended).toBe("window-moved")
	})

	it("an explicit ambient protocol without coverage is unsupported/no-ambient-decoder", async () => {
		const h = harness({
			ambient: () => [AIS],
			request: { protocols: ["vdl2"] },
		})
		await resolved(h)
		await h.advance(100)
		expect(h.last()?.trials).toEqual([
			{
				protocol: "vdl2",
				decoder: "dumpvdl2",
				mode: null,
				transport: null,
				outcome: "unsupported",
				reason: "no-ambient-decoder",
			},
		])
		expect(h.last()?.state).not.toBe("trying")
	})

	it("a throwing ambient lookup is no coverage", async () => {
		const h = harness({
			ambient: () => {
				throw new Error("boom")
			},
			request: { protocols: ["ais"] },
		})
		await resolved(h)
		expect(h.last()?.trials).toEqual([
			expect.objectContaining({
				protocol: "ais",
				outcome: "unsupported",
				reason: "no-ambient-decoder",
			}),
		])
	})
})

describe("planAmbientTrials", () => {
	const types = [
		"ais-catcher",
		"acarsdec",
		"dumpvdl2",
		"lora-meshtastic",
	] as const
	const protocolOf = {
		"ais-catcher": "ais",
		acarsdec: "acars",
		dumpvdl2: "vdl2",
		"lora-meshtastic": "lora",
	} as const
	const covering = (n: number): AmbientCoverageLike[] =>
		Array.from({ length: n }, (_, i) => {
			const type = types[i % 4]!
			return { decoderId: `d${9 - i}`, type, protocol: protocolOf[type] }
		})
	const target = { sourceId: "rtl", hz: TARGET_HZ, toleranceHz: 4500 }

	it("plans one trial per protocol, ordered by decoder id, passing the target tolerance", () => {
		const seen: number[] = []
		const trials = planAmbientTrials(
			target,
			(_s, _hz, tol) => {
				seen.push(tol)
				return covering(9)
			},
			[],
		)
		expect(seen).toEqual([4500])
		// Decoder ids d1 (ais), d2 (lora), d3 (vdl2), d4 (acars) come first; later duplicates are dropped.
		expect(trials.map(t => t.protocol)).toEqual([
			"ais",
			"lora",
			"vdl2",
			"acars",
		])
		expect(trials.every(t => t.transport === "ambient" && t.run === null)).toBe(
			true,
		)
	})

	it("never queries below SCANNER_AMBIENT_TARGET_TOLERANCE_HZ", () => {
		const seen: number[] = []
		planAmbientTrials(
			{ ...target, toleranceHz: 10 },
			(_s, _hz, tol) => {
				seen.push(tol)
				return []
			},
			[],
		)
		expect(seen).toEqual([1000])
	})

	it("dedupes per protocol: 9 or 8 covering decoders give one trial per protocol, never more than 8", () => {
		for (const n of [9, 8]) {
			const trials = planAmbientTrials(target, () => covering(n), [])
			expect(trials).toHaveLength(4)
			expect(trials.length).toBeLessThanOrEqual(IDENTIFY_AMBIENT_MAX_TRIALS)
			expect(new Set(trials.map(t => t.protocol)).size).toBe(4)
		}
	})

	it("ignores coverage whose type does not name its protocol", () => {
		const bad = [
			{
				decoderId: "x",
				type: "ais-catcher" as const,
				protocol: "dmr" as ScannerProtocol,
			},
		]
		expect(planAmbientTrials(target, () => bad, [])).toEqual([])
	})

	it("restricts to the request's protocols", () => {
		expect(
			planAmbientTrials(target, () => covering(4), ["acars", "dmr"]).map(
				t => t.protocol,
			),
		).toEqual(["acars"])
	})
})

const finished = (h: ReturnType<typeof harness>): boolean =>
	!["pending", "starting", "running", "holding"].includes(h.record.state)

describe("identify ambient inertness", () => {
	const NON_AMBIENT = IDENTIFY_PROTOCOLS.filter(
		p => !["ais", "acars", "vdl2", "lora"].includes(p),
	)
	// Feature: web-gaps-7, Property 4: Ambient identify inert without coverage
	// Validates: Requirements 1.5, 1.6
	it("without coverage and without ambient protocols, events equal the runner without coverage (run to completion)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(6000, 9000, 12_000, 20_000),
				fc.subarray([...NON_AMBIENT], { maxLength: 4 }),
				fc.boolean(),
				fc.constantFrom<"empty" | "throw" | "other-only">(
					"empty",
					"throw",
					"other-only",
				),
				async (obwHz, protocols, exhaustive, mode) => {
					// "other-only": coverage exists, but the request names only probe protocols.
					const ambient: IdentifyAmbientLookup = () => {
						if (mode === "throw") throw new Error("x")
						return mode === "other-only" && protocols.length > 0 ? [AIS] : []
					}
					const request = { protocols, exhaustive }
					const run = async (
						h: ReturnType<typeof harness>,
						oracle: boolean,
					) => {
						await resolved(h, trackOf({ obwHz }))
						if (!oracle) h.runner.onAmbientEvidence("o_t1", aisEvidence())
						// Through completion: until the job reports its result.
						for (let i = 0; i < 80 && !finished(h); i++) await h.advance(500)
						expect(finished(h)).toBe(true)
						return h.events
					}
					const a = await run(harness({ request, oracle: true }), true)
					const b = await run(harness({ request, ambient }), false)
					expect(b).toEqual(a)
				},
			),
			{ numRuns: 100 },
		)
	}, 5_000)
})
