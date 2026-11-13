/**
 * WG9 lane TT (requirement 3.3): one DSP epoch per retune against the real TunerController (caps
 * changes emitted synchronously, as SourceManager does). The labels the WG9 3.1/3.2 state rule
 * gave are gone: the tuning ledger labels samples (tuning-ledger-engine-labels.test.ts).
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
		assertTunerCommandActive: () => {},
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
	const epochs = (): PendingEpoch[] =>
		all().flatMap(i => (i.kind === "pending-epoch" ? [i.pending] : []))
	return {
		sources,
		fanout,
		tuner,
		engine,
		hosts,
		epochs,
		failWrites: (on: boolean) => {
			failWrites = on
		},
	}
}

describe("one epoch per retune (WG9 req 3.3)", () => {
	it("posts one epoch with the command's centre for a REST retune", async () => {
		const t = setup()
		await t.tuner.setSampleRate("rtl", RATE)
		await t.engine.start()
		await t.tuner.setFrequency("rtl", 446_300_000, { origin: "rest" })
		await settle()
		expect(t.epochs()).toHaveLength(1)
		// A DSP epoch: its label is never the poster's (the ledger labels its samples).
		expect(t.epochs()[0]).toMatchObject({
			centreHz: 446_300_000,
			centreChanged: true,
			tuningTrust: "unverified",
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
							tuningTrust: "unverified",
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
