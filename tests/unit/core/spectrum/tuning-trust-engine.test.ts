/**
 * WG9 lane TT (requirements 3.1-3.3): spectrum engine trust labels and retune epochs
 * against the real TunerController (caps changes emitted synchronously, as SourceManager does).
 */
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { SourceCaps } from "../../../../src/config.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	EngineState,
	PendingEpoch,
	PipelineInput,
	TuningTrust,
} from "../../../../src/core/spectrum/types.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import { TunerController } from "../../../../src/core/tuner-controller.js"
import {
	FakeFanout,
	FakeSources,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })
/** rtl_tcp opcodes (protocol constants). */
const SET_FREQUENCY = 0x01
const SET_SAMPLE_RATE = 0x02
const BASE_HZ = 446_100_000
const RATE = 1_024_000

class RecordingHost implements PipelineHost {
	readonly inputs: PipelineInput[] = []
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		this.inputs.push(input)
		if (transfer) this.handlers.buffer(transfer)
	}
	exportState(): Promise<EngineState> {
		return Promise.resolve({
			version: 1,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		})
	}
	utilization(): number | null {
		return null
	}
	close(): Promise<void> {
		return Promise.resolve()
	}
}

function setup(reconnectPolicy: "restore" | "reset" = "restore") {
	const sources = new FakeSources("rtl", {
		centerFreq: BASE_HZ,
		sampleRate: RATE,
	})
	const fanout = new FakeFanout()
	let failWrites = false
	const manager = Object.assign(sources, {
		writeToSource: () => {
			if (failWrites) throw new Error("socket closed")
			return true
		},
		isRtlTcpSource: () => true,
		updateSourceCaps: (id: string, patch: Partial<SourceCaps>) => {
			sources.setCaps(id, patch)
			return sources.getCaps(id)
		},
		setTuningCaps: (id: string, patch: Partial<SourceCaps>) => {
			sources.setCaps(id, patch)
			return sources.getCaps(id)
		},
	})
	const tuner = new TunerController(
		logger,
		manager as unknown as SourceManager,
		{ reconnectPolicy },
	)
	tuner.on("error", () => undefined)
	tuner.initializeSource("rtl", sources.getCaps("rtl"))
	const hosts: RecordingHost[] = []
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner,
		settings: () =>
			testSettings(s => {
				s.sweep.settleMs.network = 100
			}),
		logger,
		createHost: (_cfg, handlers) => {
			const host = new RecordingHost(handlers)
			hosts.push(host)
			return host
		},
		batchBytes: 4096,
	})
	const all = () => hosts.flatMap(h => h.inputs)
	const streams = (): TuningTrust[] =>
		all().flatMap(i => (i.kind === "new-stream" ? [i.tuningTrust] : []))
	const epochs = (): PendingEpoch[] =>
		all().flatMap(i => (i.kind === "pending-epoch" ? [i.pending] : []))
	return {
		sources,
		fanout,
		tuner,
		engine,
		hosts,
		streams,
		epochs,
		failWrites: (on: boolean) => {
			failWrites = on
		},
	}
}

/** Waits for a background pipeline restart (sample-rate change) to post its stream. */
async function settleRestart(): Promise<void> {
	for (let i = 0; i < 5; i++) await settle()
}

describe("spectrum engine tuning trust (WG9 req 3.1, 3.2)", () => {
	it("labels the first stream unverified while frequency and sample rate are declared only", async () => {
		const t = setup()
		await t.engine.start()
		expect(t.streams()).toEqual(["unverified"])
		await t.engine.stop()
	})

	it("labels the first stream unverified with only the sample rate declared", async () => {
		const t = setup()
		await t.tuner.setFrequency("rtl", 446_200_000)
		await t.engine.start()
		expect(t.streams()).toEqual(["unverified"])
		await t.engine.stop()
	})

	it("labels the first stream commanded after this core wrote frequency and sample rate", async () => {
		const t = setup()
		await t.tuner.setSampleRate("rtl", RATE)
		await t.tuner.setFrequency("rtl", 446_200_000)
		await t.engine.start()
		expect(t.streams()).toEqual(["commanded"])
		await t.engine.stop()
	})

	it("labels a retune commanded, or unverified while the sample rate is only declared", async () => {
		const t = setup()
		await t.engine.start()
		await t.tuner.setFrequency("rtl", 446_200_000)
		await settle()
		expect(t.epochs().map(e => e.tuningTrust)).toEqual(["unverified"])
		await t.tuner.setSampleRate("rtl", RATE)
		await t.tuner.setFrequency("rtl", 446_300_000)
		await settle()
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_300_000,
			tuningTrust: "commanded",
		})
		await t.engine.stop()
	})

	it("labels accepted relay commands under external control relay", async () => {
		const t = setup()
		await t.engine.start()
		t.tuner.applyExternalCommand("rtl", SET_SAMPLE_RATE, RATE)
		await settle()
		t.tuner.applyExternalCommand("rtl", SET_FREQUENCY, 446_400_000)
		await settle()
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_400_000,
			tuningTrust: "relay",
		})
		await t.engine.stop()
	})

	it("labels a relay frequency command unverified while the sample rate is only declared", async () => {
		const t = setup()
		await t.engine.start()
		t.tuner.applyExternalCommand("rtl", SET_FREQUENCY, 446_400_000)
		await settle()
		expect(t.epochs().map(e => e.tuningTrust)).toEqual(["unverified"])
		await t.engine.stop()
	})

	it("labels the reset-reconnect caps change unverified until this core commands again", async () => {
		const t = setup("reset")
		await t.tuner.setSampleRate("rtl", RATE)
		await t.tuner.setFrequency("rtl", 446_200_000)
		await t.engine.start()
		expect(t.streams()).toEqual(["commanded"])
		t.sources.emit("disconnected", "rtl")
		t.sources.emit("payload-started", "rtl")
		t.tuner.synchronizeOnConnect("rtl") // caps back to the baseline centre
		await settle()
		expect(t.streams()).toEqual(["commanded", "unverified"])
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: BASE_HZ,
			tuningTrust: "unverified",
		})
		await t.tuner.setSampleRate("rtl", RATE)
		await t.tuner.setFrequency("rtl", 446_250_000)
		await settle()
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_250_000,
			tuningTrust: "commanded",
		})
		await t.engine.stop()
	})

	it("labels an accepted replay commanded", async () => {
		const t = setup("restore")
		await t.tuner.setSampleRate("rtl", RATE)
		await t.tuner.setFrequency("rtl", 446_200_000)
		await t.engine.start()
		t.sources.emit("disconnected", "rtl")
		t.sources.emit("payload-started", "rtl")
		// The receiver came back elsewhere: caps drifted; reconciliation restores them.
		t.sources.caps.set("rtl", { ...t.sources.getCaps("rtl")!, centerFreq: 1 })
		const before = t.epochs().length
		t.tuner.synchronizeOnConnect("rtl")
		await settle()
		const posted = t.epochs().slice(before)
		expect(posted).toHaveLength(1)
		expect(posted[0]).toMatchObject({
			centreHz: 446_200_000,
			tuningTrust: "commanded",
		})
		await t.engine.stop()
	})

	it("labels a reconciliation caps change unverified when the replay failed on the new connection", async () => {
		const t = setup("restore")
		await t.tuner.setSampleRate("rtl", RATE)
		await t.tuner.setFrequency("rtl", 446_200_000)
		// Stale caps metadata before the drop, so reconciliation moves the centre.
		t.sources.caps.set("rtl", { ...t.sources.getCaps("rtl")!, centerFreq: 1 })
		await t.engine.start()
		t.sources.emit("disconnected", "rtl")
		t.sources.emit("payload-started", "rtl")
		t.failWrites(true)
		const before = t.epochs().length
		t.tuner.synchronizeOnConnect("rtl")
		await settle()
		const posted = t.epochs().slice(before)
		expect(posted).toHaveLength(1)
		expect(posted[0]).toMatchObject({
			centreHz: 446_200_000,
			tuningTrust: "unverified",
		})
		expect(t.streams().at(-1)).toBe("unverified")
		await t.engine.stop()
	})

	it("labels a sample-rate restart by the same rule", async () => {
		const t = setup()
		await t.tuner.setFrequency("rtl", 446_200_000)
		await t.engine.start()
		await t.tuner.setSampleRate("rtl", 2_048_000)
		await settleRestart()
		expect(t.streams()).toEqual(["unverified", "commanded"])
		await t.engine.stop()

		const r = setup("reset")
		await r.tuner.setSampleRate("rtl", 2_048_000)
		await r.tuner.setFrequency("rtl", 446_200_000)
		await r.engine.start()
		r.tuner.synchronizeOnConnect("rtl") // baseline rate comes back
		await settleRestart()
		expect(r.streams()).toEqual(["commanded", "unverified"])
		await r.engine.stop()
	})

	it("labels the suppressed-centre epoch by the same rule", async () => {
		for (const proven of [false, true]) {
			const t = setup()
			if (proven) await t.tuner.setSampleRate("rtl", RATE)
			await t.engine.start()
			t.engine.suppressExternal(true)
			await t.tuner.setFrequency("rtl", 433_920_000, { origin: "rest" })
			t.engine.suppressExternal(false)
			await settle()
			expect(t.epochs().at(-1)).toMatchObject({
				centreHz: 433_920_000,
				tuningTrust: proven ? "commanded" : "unverified",
			})
			await t.engine.stop()
		}
	})
})

describe("one epoch per retune (WG9 req 3.3)", () => {
	it("posts one epoch with the command's centre for a REST retune", async () => {
		const t = setup()
		await t.tuner.setSampleRate("rtl", RATE)
		await t.engine.start()
		await t.tuner.setFrequency("rtl", 446_300_000, { origin: "rest" })
		await settle()
		expect(t.epochs()).toHaveLength(1)
		expect(t.epochs()[0]).toMatchObject({
			centreHz: 446_300_000,
			centreChanged: true,
			tuningTrust: "commanded",
		})
		await t.engine.stop()
	})

	it("Property 7 holds for any sequence of operator retunes", async () => {
		// Feature: web-gaps-9, Property 7: One epoch per retune
		// Validates: Requirements 3.3
		const t = setup()
		await t.tuner.setSampleRate("rtl", RATE)
		await t.engine.start()
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 400_000_000, max: 470_000_000 }), {
					minLength: 1,
					maxLength: 4,
				}),
				async targets => {
					for (const hz of targets) {
						const caps = t.sources.getCaps("rtl")!.centerFreq
						const before = t.epochs().length
						await t.tuner.setFrequency("rtl", hz, { origin: "rest" })
						await settle()
						const posted = t.epochs().slice(before)
						expect(posted).toHaveLength(1)
						expect(posted[0]).toMatchObject({
							centreHz: hz,
							tuningTrust: "commanded",
						})
						if (hz !== caps)
							expect(t.sources.getCaps("rtl")!.centerFreq).toBe(hz)
					}
				},
			),
			{ numRuns: 100 },
		)
		await t.engine.stop()
	})
})
