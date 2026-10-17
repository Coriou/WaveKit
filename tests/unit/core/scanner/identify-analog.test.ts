/**
 * WG10 req 3.1-3.4: identify for analog voice from the live demodulator's transmissions. The fake
 * port returns every transmission it holds unfiltered (a naive or hostile port), so these tests also
 * prove identify's own fail-closed re-check of source, tolerance, window and modulation.
 */
import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import type {
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
	TuningTrust,
} from "@wavekit/api-types"
import { IDENTIFY_ANALOG_LOOKBACK_MS } from "@wavekit/api-types"
import { createAnalogEvidenceLog } from "../../../../src/core/scanner/analog-evidence.js"
import {
	IDENTIFY_ANALOG_SETTLE_MS,
	IdentifyRunner,
	analogMatches,
	analogResultOf,
	analogVerdictOf,
	identifyVerdict,
	normaliseIdentify,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type {
	AnalogEvidenceTransmission,
	IdentifyAnalogEvidence,
} from "../../../../src/core/scanner/identify-analog-contract.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import type { Logger } from "../../../../src/utils/logger.js"
import {
	feedAnalogEvidence,
	identifyAnalogEvidence,
} from "../../../../src/index.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import { hygieneHarness } from "../analog-transmission-hygiene-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import {
	flushAsync,
	linkLine,
	poolHarness,
} from "../../../mocks/scanner/probe-fakes.js"

const ENDED = ["completed", "cancelled", "failed"]
/** The harness clock starts here; the job starts running on the first tick at this time. */
const START = 1_000_000

class FakePort implements IdentifyAnalogEvidence {
	list: AnalogEvidenceTransmission[] = []
	live = true
	throwNear = false
	throwMonitoring = false
	nearCalls: [string, number, number, number][] = []
	transmissionsNear(
		sourceId: string,
		hz: number,
		tol: number,
		since: number,
	): readonly AnalogEvidenceTransmission[] {
		this.nearCalls.push([sourceId, hz, tol, since])
		if (this.throwNear) throw new Error("boom")
		return this.list
	}
	monitoring(): boolean {
		if (this.throwMonitoring) throw new Error("boom")
		return this.live
	}
	/** WG10 R2: the tracker's held, not yet published opening (unfiltered, like `list`). */
	pendingList: AnalogEvidenceTransmission[] = []
	pendingNear(): readonly AnalogEvidenceTransmission[] {
		return this.pendingList
	}
}

function tx(
	over: Partial<AnalogEvidenceTransmission> = {},
): AnalogEvidenceTransmission {
	return {
		transmissionId: "tx1",
		sourceId: "rtl",
		startedAtMs: START - 3000,
		endedAtMs: START - 1000,
		hz: TARGET_HZ,
		tuningTrust: "commanded",
		modulation: "nfm",
		ctcssHz: 88.5,
		dcs: null,
		...over,
	}
}

function harness(
	opts: {
		request?: Partial<ScannerIdentifyRequest>
		port?: IdentifyAnalogEvidence | null
		logger?: Logger
		discovery?: Discovery
	} = {},
) {
	const settings = testSettings()
	const pool = poolHarness({ settings, cpuPercent: null })
	const record = identifyRecord()
	const inner = fakeInner(record, () => pool.clock.now)
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const port = opts.port === undefined ? new FakePort() : opts.port
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			protocols: ["analog-fm", "analog-am"],
			...opts.request,
		}),
		inner,
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: () => opts.discovery,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: opts.logger ?? pino({ level: "silent" }),
		now: () => pool.clock.now,
		...(port ? { analogEvidence: port } : {}),
	})
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const settle = async (stepMs = 1000, steps = 40): Promise<void> => {
		for (let i = 0; i < steps && !ENDED.includes(record.state); i++)
			await advance(stepMs)
	}
	const start = async (track: TrackSnapshot = trackOf({ obwHz: 11_000 })) => {
		await runner.start()
		tracks.push(viewOf(track))
		await advance(100)
		await advance(100)
		await flushAsync()
	}
	const last = () => events.at(-1)
	const trials = () =>
		Object.fromEntries(
			(last()?.trials ?? []).map(t => [
				t.protocol,
				t.reason ? `${t.outcome}/${t.reason}` : t.outcome,
			]),
		)
	return {
		...pool,
		port: port as FakePort,
		record,
		tracks,
		events,
		runner,
		advance,
		settle,
		start,
		last,
		trials,
	}
}

describe("identify analog trials (WG10 3.2)", () => {
	it("plans analog-fm and analog-am as ambient live-audio trials", async () => {
		const h = harness()
		h.port.list = []
		await h.start()
		const trying = h.events.find(e => e.state === "trying")
		expect(trying?.trials).toEqual([
			{
				protocol: "analog-fm",
				decoder: "live-audio",
				mode: null,
				transport: "ambient",
				outcome: "running",
			},
			{
				protocol: "analog-am",
				decoder: "live-audio",
				mode: null,
				transport: "ambient",
				outcome: "running",
			},
		])
		// sinceMs = job start − 30 s; target tolerance max(1 kHz, bw/2).
		expect(h.port.nearCalls[0]).toEqual([
			"rtl",
			TARGET_HZ,
			1000,
			START - IDENTIFY_ANALOG_LOOKBACK_MS,
		])
	})

	it("CTCSS on a commanded frequency: identified, classified, analog filled, metadata ctcssHz", async () => {
		const h = harness()
		h.port.list = [tx()]
		await h.start()
		await h.settle()
		const e = h.last()!
		expect(e.state).toBe("identified")
		expect(h.trials()).toEqual({
			"analog-fm": "decoded",
			"analog-am": "not-needed",
		})
		expect(e.trials[0]?.mode).toBe("nfm")
		expect(e.result).toMatchObject({
			protocol: "analog-fm",
			confidence: "classified",
			analog: {
				source: "live-audio",
				modulation: "nfm",
				transmissions: 1,
				transmissionId: "tx1",
				ctcssHz: 88.5,
				dcs: null,
				tuningTrust: "commanded",
			},
		})
		expect(e.result?.metadata.ctcssHz).toBe(88.5)
		expect(h.record.state).toBe("completed")
	})

	it("DCS on a relay frequency: identified, no ctcssHz metadata", async () => {
		const h = harness()
		h.port.list = [
			tx({
				ctcssHz: null,
				dcs: { code: "023", polarity: "inverted" },
				tuningTrust: "relay",
			}),
		]
		await h.start()
		await h.settle()
		const e = h.last()!
		expect(e.state).toBe("identified")
		expect(e.result?.analog?.dcs).toEqual({
			code: "023",
			polarity: "inverted",
		})
		expect(e.result?.metadata).not.toHaveProperty("ctcssHz")
	})

	it("an unverified frequency is at most candidate", async () => {
		const h = harness()
		h.port.list = [tx({ tuningTrust: "unverified" })]
		await h.start()
		await h.settle()
		expect(h.last()?.state).toBe("candidate")
		expect(h.last()?.result).toMatchObject({
			protocol: "analog-fm",
			analog: { tuningTrust: "unverified", ctcssHz: 88.5 },
		})
		expect(h.last()?.result?.confidence).not.toBe("classified")
	})

	it("no tone is at most candidate, and never a tone in metadata", async () => {
		const h = harness()
		h.port.list = [tx({ ctcssHz: null })]
		await h.start()
		await h.settle()
		expect(h.last()?.state).toBe("candidate")
		expect(h.last()?.result?.analog).toMatchObject({
			ctcssHz: null,
			dcs: null,
		})
		expect(h.last()?.result?.metadata).not.toHaveProperty("ctcssHz")
	})

	it("am answers analog-am", async () => {
		const h = harness()
		h.port.list = [tx({ modulation: "am", ctcssHz: null })]
		await h.start()
		await h.settle()
		expect(h.trials()).toEqual({
			"analog-fm": "not-needed",
			"analog-am": "decoded",
		})
		expect(h.last()?.result?.protocol).toBe("analog-am")
	})

	for (const [label, t] of [
		["outside the tolerance", tx({ hz: TARGET_HZ + 1001 })],
		["on another source", tx({ sourceId: "sdrpp" })],
		[
			"ended before the lookback",
			tx({ endedAtMs: START - IDENTIFY_ANALOG_LOOKBACK_MS - 1 }),
		],
		["with a null frequency", tx({ hz: null as unknown as number })],
		["with a NaN frequency", tx({ hz: Number.NaN })],
		["on usb", tx({ modulation: "usb" })],
	] as const) {
		it(`a transmission ${label} is no evidence (no-sync while monitoring)`, async () => {
			const h = harness()
			h.port.list = [t]
			await h.start()
			await h.settle()
			expect(h.trials()).toEqual({
				"analog-fm": "no-sync",
				"analog-am": "no-sync",
			})
			expect(h.last()?.result).not.toHaveProperty("analog")
			expect(h.last()?.result?.metadata).not.toHaveProperty("ctcssHz")
		})
	}

	it("ended exactly at the lookback edge still counts", async () => {
		const h = harness()
		h.port.list = [tx({ endedAtMs: START - IDENTIFY_ANALOG_LOOKBACK_MS })]
		await h.start()
		await h.settle()
		expect(h.trials()["analog-fm"]).toBe("decoded")
	})

	it("only an open match at the deadline: timeout", async () => {
		const h = harness()
		h.port.list = [tx({ endedAtMs: null, ctcssHz: null })]
		await h.start()
		await h.settle()
		expect(h.trials()).toEqual({
			"analog-fm": "timeout",
			"analog-am": "no-sync",
		})
		expect(h.last()?.result).not.toHaveProperty("analog")
		// The deadline is the wait timeout from the job start.
		expect(h.clock.now).toBeGreaterThanOrEqual(START + 15_000)
	})

	it("review WG10 R2 m3: an open match at the deadline that closes by the deadline within the settle wait decodes", async () => {
		const h = harness()
		h.port.list = [tx({ endedAtMs: null })]
		await h.start()
		const deadline = (h.record.startedAt ?? START) + 15_000
		while (h.clock.now < deadline) await h.advance(500)
		expect(h.trials()).toEqual({
			"analog-fm": "running",
			"analog-am": "no-sync",
		})
		// The closed event arrives a merge gap after the audio end (just before the deadline).
		h.port.list = [tx({ endedAtMs: deadline - 100 })]
		await h.advance(500)
		expect(h.trials()["analog-fm"]).toBe("decoded")
		expect(h.last()?.result?.analog).toMatchObject({ ctcssHz: 88.5 })
	})

	it("review WG10 R2 m3: the settle wait is bounded: a match still open ends timeout IDENTIFY_ANALOG_SETTLE_MS past the deadline", async () => {
		expect(IDENTIFY_ANALOG_SETTLE_MS).toBe(1_500 + 250)
		const h = harness()
		h.port.list = [tx({ endedAtMs: null, ctcssHz: null })]
		await h.start()
		const deadline = (h.record.startedAt ?? START) + 15_000
		let decidedAt: number | null = null
		for (let i = 0; i < 200 && !ENDED.includes(h.record.state); i++) {
			await h.advance(100)
			if (decidedAt === null && h.trials()["analog-fm"] === "timeout")
				decidedAt = h.clock.now
		}
		expect(decidedAt).not.toBeNull()
		expect(decidedAt!).toBeGreaterThanOrEqual(
			deadline + IDENTIFY_ANALOG_SETTLE_MS,
		)
		expect(decidedAt!).toBeLessThanOrEqual(
			deadline + IDENTIFY_ANALOG_SETTLE_MS + 100,
		)
		expect(ENDED).toContain(h.record.state)
	})

	it("review WG10 R2 m3: a pending opening started near the deadline is timeout, not no-sync", async () => {
		const h = harness()
		await h.start()
		const deadline = (h.record.startedAt ?? START) + 15_000
		h.port.pendingList = [
			tx({ endedAtMs: null, startedAtMs: deadline - 300, ctcssHz: null }),
		]
		await h.settle(500, 80)
		expect(h.trials()).toEqual({
			"analog-fm": "timeout",
			"analog-am": "no-sync",
		})
		// An opening that started after the deadline is not this job's evidence.
		const late = harness()
		await late.start()
		const lateDeadline = (late.record.startedAt ?? START) + 15_000
		late.port.pendingList = [
			tx({ endedAtMs: null, startedAtMs: lateDeadline + 10, ctcssHz: null }),
		]
		await late.settle(500, 80)
		expect(late.trials()["analog-fm"]).toBe("no-sync")
	})

	it("a transmission closing mid-window decodes on the next tick", async () => {
		const h = harness()
		h.port.list = [tx({ endedAtMs: null })]
		await h.start()
		await h.advance(1000)
		h.port.list = [tx({ endedAtMs: h.clock.now })]
		await h.settle()
		expect(h.trials()["analog-fm"]).toBe("decoded")
		expect(h.clock.now).toBeLessThan(START + 15_000)
	})

	it("a transmission closing just before the deadline, first seen on the deadline tick, decodes", async () => {
		const h = harness()
		h.port.list = [tx({ endedAtMs: null })]
		await h.start()
		while (h.clock.now < START + 14_000) await h.advance(1000)
		expect(h.trials()["analog-fm"]).toBe("running")
		h.port.list = [tx({ endedAtMs: START + 14_900 })]
		await h.advance(2000)
		// The deadline was processed on this tick (the unmatched trial ended) and the closed match still decoded.
		expect(h.trials()).toEqual({
			"analog-fm": "decoded",
			"analog-am": "no-sync",
		})
		expect(h.last()?.result?.analog).toMatchObject({ ctcssHz: 88.5 })
	})

	it("a closed match that ended after the job/ambient end is no evidence", () => {
		const target = {
			sourceId: "rtl",
			hz: TARGET_HZ,
			toleranceHz: 5000,
			sinceMs: START - IDENTIFY_ANALOG_LOOKBACK_MS,
			untilMs: START + 15_000,
		}
		expect(
			analogMatches([tx({ endedAtMs: START + 15_001 })], target, "analog-fm")
				.closed,
		).toEqual([])
		expect(
			analogMatches([tx({ endedAtMs: START + 15_000 })], target, "analog-fm")
				.closed,
		).toHaveLength(1)
	})

	it("a non-standard DCS code or CTCSS tone from the port is treated as no tone", async () => {
		const h = harness()
		h.port.list = [
			tx({ ctcssHz: 123.4, dcs: { code: "999", polarity: "normal" } }),
		]
		await h.start()
		await h.settle()
		expect(h.trials()["analog-fm"]).toBe("decoded")
		expect(h.last()?.state).toBe("candidate")
		expect(h.last()?.result?.analog).toMatchObject({ ctcssHz: null, dcs: null })
		expect(h.last()?.result?.metadata).not.toHaveProperty("ctcssHz")
	})

	it("live audio never on the target: unsupported/no-live-audio", async () => {
		const h = harness()
		h.port.live = false
		await h.start()
		await h.settle()
		expect(h.trials()).toEqual({
			"analog-fm": "unsupported/no-live-audio",
			"analog-am": "unsupported/no-live-audio",
		})
		expect(h.last()?.trials[0]).toMatchObject({ mode: null, transport: null })
	})

	it("live audio on the target for part of the window: no-sync", async () => {
		const h = harness()
		h.port.live = false
		await h.start()
		h.port.live = true
		await h.advance(1000)
		h.port.live = false
		await h.settle()
		expect(h.trials()["analog-fm"]).toBe("no-sync")
	})

	it("a throwing port is no evidence and not monitoring, with one fixed warn", async () => {
		const warn = vi.fn()
		const logger = {
			warn,
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
			child: () => logger,
		} as unknown as Logger
		const h = harness({ logger })
		h.port.list = [tx()]
		h.port.throwNear = true
		h.port.throwMonitoring = true
		await h.start()
		await h.settle()
		expect(h.trials()).toEqual({
			"analog-fm": "unsupported/no-live-audio",
			"analog-am": "unsupported/no-live-audio",
		})
		expect(h.last()?.result).not.toHaveProperty("analog")
		const analogWarns = warn.mock.calls.filter(c =>
			String(c.at(-1)).startsWith("Analog evidence"),
		)
		expect(analogWarns).toEqual([
			["Analog evidence unavailable; no analog trials evidence"],
		])
	})

	it("only monitoring throwing: evidence still decodes", async () => {
		const h = harness()
		h.port.list = [tx()]
		h.port.throwMonitoring = true
		await h.start()
		await h.settle()
		expect(h.trials()["analog-fm"]).toBe("decoded")
	})

	it("exhaustive keeps running after a match until the deadline", async () => {
		const h = harness({ request: { exhaustive: true } })
		h.port.list = [tx()]
		await h.start()
		await h.advance(1000)
		expect(h.last()?.state).toBe("trying")
		await h.settle()
		expect(h.trials()).toEqual({
			"analog-fm": "decoded",
			"analog-am": "no-sync",
		})
		expect(h.last()?.state).toBe("identified")
		expect(h.clock.now).toBeGreaterThanOrEqual(START + 15_000)
	})

	it("the latest match is reported; the count is every closed match", async () => {
		const h = harness()
		h.port.list = [
			tx({ transmissionId: "old", endedAtMs: START - 5000, ctcssHz: 88.5 }),
			tx({
				transmissionId: "new",
				endedAtMs: START - 1000,
				ctcssHz: null,
				tuningTrust: "relay",
			}),
		]
		await h.start()
		await h.settle()
		expect(h.last()?.result?.analog).toMatchObject({
			transmissionId: "new",
			transmissions: 2,
			ctcssHz: null,
			tuningTrust: "relay",
		})
		// Fail closed: the reported transmission has no tone, so not identified.
		expect(h.last()?.state).toBe("candidate")
	})

	it("works with the real evidence log", async () => {
		const log = createAnalogEvidenceLog({ monitoring: () => true })
		const h = harness({ port: log })
		const at = (ms: number) => new Date(ms).toISOString()
		log.record({
			transmissionId: "r1",
			sourceId: "rtl",
			state: "closed",
			startedAt: at(START - 4000),
			endedAt: at(START - 2000),
			durationMs: 2000,
			frequency: { hz: TARGET_HZ + 500, tuningTrust: "commanded" },
			modulation: "nfm",
			bandwidthHz: 12_500,
			squelchMode: "manual",
			thresholdDbfs: -40,
			peakChannelPowerDbfs: -30,
			meanChannelPowerDbfs: -31,
			closeReason: "squelch",
			tone: { ctcssHz: 67, dtmf: null, dcs: null },
		})
		await h.start()
		await h.settle()
		expect(h.last()?.state).toBe("identified")
		expect(h.last()?.result?.metadata.ctcssHz).toBe(67)
	})
})

describe("digital decode keeps priority (WG10 3.3)", () => {
	const dmrTrack = () => trackOf({ acf30: -0.94, acf60: 0.99 })
	for (const exhaustive of [false, true]) {
		it(`a DMR decode wins over analog evidence (exhaustive ${exhaustive})`, async () => {
			const h = harness({ request: { protocols: [], exhaustive } })
			h.port.list = [tx()]
			h.engine.push(1_100_000)
			await h.start(dmrTrack())
			const id = [...h.decoders.created.values()][0]?.id ?? ""
			h.decoders.emitLink(id, linkLine(1, h.clock.now))
			h.decoders.emitLink(id, linkLine(1, h.clock.now + 30))
			await flushAsync()
			await h.settle(1000, 80)
			const e = h.last()!
			expect(e.state).toBe("identified")
			expect(e.result?.protocol).toBe("dmr")
			expect(e.result?.confidence).toBe("decoded")
			expect(e.result?.metadata).not.toHaveProperty("ctcssHz")
			// The digital decode won: no analog evidence in the result, even after an earlier analog decode.
			expect(e.result).not.toHaveProperty("analog")
			expect(e.trials.find(t => t.protocol === "dmr")?.outcome).toBe("decoded")
		})
	}

	it("review WG10 R1 m3: analog evidence never replaces a classified DMR discovery without a decode (golden: the result without analog evidence)", async () => {
		// The founding identify case: DMR classified on the waterfall, no decode this time, and the
		// NFM squelch heard the bursts (with a tone, on a commanded frequency).
		const dmr = {
			id: "d_dmr",
			protocol: "dmr",
			confidence: "classified",
			identity: { colorCode: 1 },
			metadata: { colorCode: 1 },
		} as unknown as Discovery
		const run = async (port: FakePort | null) => {
			const h = harness({
				request: { protocols: [] },
				port,
				discovery: dmr,
			})
			if (port) port.list = [tx()]
			h.engine.push(1_100_000)
			await h.start(dmrTrack())
			await h.settle(1000, 80)
			return h.last()!
		}
		const withAnalog = await run(new FakePort())
		const golden = await run(null)
		// Golden (no analog evidence, as before WG10): the classified digital candidate.
		expect(golden.state).toBe("candidate")
		expect(golden.result).toMatchObject({
			protocol: "dmr",
			confidence: "classified",
			identity: { colorCode: 1 },
			metadata: { colorCode: 1 },
			discoveryId: "d_dmr",
		})
		expect(withAnalog.state).toBe(golden.state)
		const { analog, ...rest } = withAnalog.result!
		const { analog: none, ...goldenRest } = golden.result!
		expect(none).toBeUndefined()
		expect(rest).toEqual(goldenRest)
		// Analog only as supplementary evidence.
		expect(analog).toMatchObject({
			source: "live-audio",
			modulation: "nfm",
			ctcssHz: 88.5,
		})
		expect(rest.metadata).not.toHaveProperty("ctcssHz")
		expect(
			withAnalog.trials.find(t => t.protocol === "analog-fm")?.outcome,
		).toBe("decoded")
	})

	it("a digital-only target gets no analog trials", async () => {
		const h = harness({ request: { protocols: ["dmr"] } })
		h.engine.push(1_100_000)
		await h.start(trackOf({ acf30: -0.94, acf60: 0.99 }))
		expect(
			h.events.flatMap(e => e.trials).some(t => t.decoder === "live-audio"),
		).toBe(false)
	})
})

describe("analog verdict (pure)", () => {
	const base = {
		artefact: null,
		decoded: false,
		heardIdentity: false,
		discoveryConfidence: null,
		topScore: 0,
	}
	it("orders digital, capped digital, analog tone+trust, analog", () => {
		const yes = { tone: true, trusted: true }
		expect(identifyVerdict({ ...base, analog: yes })).toBe("identified")
		expect(
			identifyVerdict({ ...base, analog: { tone: true, trusted: false } }),
		).toBe("candidate")
		expect(
			identifyVerdict({ ...base, analog: { tone: false, trusted: true } }),
		).toBe("candidate")
		expect(identifyVerdict({ ...base, artefact: "dc", analog: yes })).toBe(
			"unidentified",
		)
		expect(identifyVerdict({ ...base, heardIdentity: true, analog: yes })).toBe(
			"candidate",
		)
		expect(identifyVerdict({ ...base, analog: null })).toBe("unidentified")
	})
})

const TRUSTS: TuningTrust[] = ["commanded", "relay", "unverified"]
const MODS: AnalogEvidenceTransmission["modulation"][] = [
	"nfm",
	"wfm",
	"am",
	"usb",
	"lsb",
	"dsb",
	"cw",
	"raw",
]
const FM = new Set(["nfm", "wfm"])
const AM = new Set(["am", "dsb"])

describe("property 9", () => {
	// Feature: web-gaps-10, Property 9: Analog evidence fails closed
	// Validates: Requirements 3.1, 3.2, 3.3, 3.4
	it("names analog only from a matching transmission; identified only with a reported tone and trust", () => {
		const txArb = fc.record({
			transmissionId: fc.string({ minLength: 1, maxLength: 4 }),
			sourceId: fc.constantFrom("rtl", "sdrpp"),
			startedAtMs: fc.constant(0),
			endedAtMs: fc.option(fc.integer({ min: -100_000, max: 100_000 }), {
				nil: null,
			}),
			hz: fc.oneof(
				fc.integer({ min: TARGET_HZ - 5000, max: TARGET_HZ + 5000 }),
				fc.constant(Number.NaN),
				fc.constant(null as unknown as number),
			),
			tuningTrust: fc.constantFrom(...TRUSTS),
			modulation: fc.constantFrom(...MODS),
			ctcssHz: fc.option(fc.constantFrom(67, 88.5, 254.1), { nil: null }),
			dcs: fc.option(
				fc.record({
					code: fc.constantFrom("023", "754"),
					polarity: fc.constantFrom("normal" as const, "inverted" as const),
				}),
				{ nil: null },
			),
		})
		fc.assert(
			fc.property(
				fc.array(txArb, { maxLength: 12 }),
				fc.integer({ min: 1000, max: 4000 }),
				fc.integer({ min: -50_000, max: 50_000 }),
				fc.constantFrom("analog-fm" as const, "analog-am" as const),
				(list, tol, sinceMs, protocol) => {
					const target = {
						sourceId: "rtl",
						hz: TARGET_HZ,
						toleranceHz: tol,
						sinceMs,
					}
					const m = analogMatches(list, target, protocol)
					const fam = protocol === "analog-fm" ? FM : AM
					const legit = (x: AnalogEvidenceTransmission) =>
						x.sourceId === "rtl" &&
						Number.isFinite(x.hz) &&
						Math.abs(x.hz - TARGET_HZ) <= tol &&
						fam.has(x.modulation)
					for (const x of m.closed) {
						expect(legit(x)).toBe(true)
						expect(x.endedAtMs).not.toBeNull()
						expect(x.endedAtMs!).toBeGreaterThanOrEqual(sinceMs)
					}
					expect(m.closed.length).toBe(
						list.filter(
							x => legit(x) && x.endedAtMs !== null && x.endedAtMs >= sinceMs,
						).length,
					)
					const analog = analogResultOf(m.closed)
					if (m.closed.length === 0) expect(analog).toBeNull()
					else {
						const latest = m.closed[0]!
						expect(analog).toMatchObject({
							transmissionId: latest.transmissionId,
							ctcssHz: latest.ctcssHz,
							dcs: latest.dcs,
							tuningTrust: latest.tuningTrust,
							transmissions: m.closed.length,
						})
						for (const x of m.closed)
							expect(x.endedAtMs!).toBeLessThanOrEqual(latest.endedAtMs!)
					}
					const state = identifyVerdict({
						artefact: null,
						decoded: false,
						heardIdentity: false,
						discoveryConfidence: null,
						topScore: 0,
						analog: analogVerdictOf(analog),
					})
					if (state === "identified") {
						expect(analog).not.toBeNull()
						expect(analog!.ctcssHz !== null || analog!.dcs !== null).toBe(true)
						expect(["commanded", "relay"]).toContain(analog!.tuningTrust)
					}
					// A digital decode always wins.
					expect(
						identifyVerdict({
							artefact: null,
							decoded: true,
							heardIdentity: true,
							discoveryConfidence: null,
							topScore: 0,
							analog: analogVerdictOf(analog),
						}),
					).toBe("identified")
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("Main wiring: live demodulator transmissions feed identify (WG10 MA.1)", () => {
	const at = (ms: number) => new Date(ms).toISOString()
	function wired(opts: {
		liveSource?: string
		running?: boolean
		frequencyUnknown?: boolean
	}) {
		const liveDemod = {
			getStatus: () => ({
				running: opts.running ?? true,
				sourceConnected: true,
				sourceId: opts.liveSource ?? "rtl",
				config: { offsetHz: 0 },
			}),
		} as unknown as Parameters<typeof identifyAnalogEvidence>[0]["liveDemod"]
		const tuner = {
			getState: () => ({
				frequency: TARGET_HZ,
				unknownFields: opts.frequencyUnknown ? ["frequency"] : [],
			}),
		} as unknown as Parameters<typeof identifyAnalogEvidence>[0]["tuner"]
		const log = identifyAnalogEvidence({ liveDemod, tuner })
		const tracker = new EventEmitter()
		feedAnalogEvidence(
			tracker as unknown as Parameters<typeof feedAnalogEvidence>[0],
			log,
		)
		return { log, tracker }
	}

	it("review WG10 R2 m3: feedAnalogEvidence binds the tracker's pending opening", () => {
		const h = hygieneHarness()
		const log = createAnalogEvidenceLog({ monitoring: () => true })
		feedAnalogEvidence(h.tracker, log)
		h.source.gate(true)
		h.source.carrier! += 10
		h.advance(300)
		expect(log.pendingNear("rtl0", 446_000_000, 1000)).toHaveLength(1)
		h.advance(500)
		h.source.level()
		expect(log.pendingNear("rtl0", 446_000_000, 1000)).toEqual([])
		expect(log.transmissionsNear("rtl0", 446_000_000, 1000, 0)).toHaveLength(1)
	})

	it("a closed transmission near the target with CTCSS names analog-fm", async () => {
		const { log, tracker } = wired({})
		tracker.emit("transmission", {
			transmissionId: "w1",
			sourceId: "rtl",
			state: "closed",
			startedAt: at(START - 4000),
			endedAt: at(START - 2000),
			durationMs: 2000,
			frequency: { hz: TARGET_HZ + 300, tuningTrust: "commanded" },
			modulation: "nfm",
			bandwidthHz: 12_500,
			squelchMode: "auto",
			thresholdDbfs: -40,
			peakChannelPowerDbfs: -30,
			meanChannelPowerDbfs: -31,
			closeReason: "squelch",
			tone: { ctcssHz: 88.5, dtmf: null, dcs: null },
		})
		const h = harness({ port: log })
		await h.start()
		await h.settle()
		expect(h.last()?.state).toBe("identified")
		expect(h.last()?.result).toMatchObject({
			protocol: "analog-fm",
			analog: { transmissionId: "w1", ctcssHz: 88.5 },
		})
	})

	it("live audio on the target without a transmission: no-sync", async () => {
		const { log } = wired({})
		const h = harness({ port: log })
		await h.start()
		await h.settle()
		expect(h.trials()["analog-fm"]).toBe("no-sync")
	})

	for (const [label, opts] of [
		["on another source", { liveSource: "other" }],
		["stopped", { running: false }],
		["with an unknown tuner frequency", { frequencyUnknown: true }],
	] as const) {
		it(`live audio ${label} is not monitoring: no-live-audio`, async () => {
			const { log } = wired(opts)
			const h = harness({ port: log })
			await h.start()
			await h.settle()
			expect(h.trials()["analog-fm"]).toBe("unsupported/no-live-audio")
		})
	}
})
