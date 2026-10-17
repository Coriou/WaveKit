import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	SpectrumEngine,
	type HostCentreReader,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import type {
	EngineState,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

class Host implements PipelineHost {
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
	close(): Promise<void> {
		return Promise.resolve()
	}
	utilization(): number | null {
		return null
	}
}

function make(hostCentre?: HostCentreReader) {
	const sources = new FakeSources()
	const fanout = new FakeFanout()
	let host: Host | null = null
	const tuner = new FakeTuner()
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner,
		settings: () => testSettings(),
		logger: pino({ level: "silent" }),
		createHost: (_cfg, handlers) => (host = new Host(handlers)),
		...(hostCentre ? { hostCentre, hostCentrePollMs: 20 } : {}),
	})
	return { engine, fanout, tuner, host: () => host! }
}

describe("SpectrumEngine trust", () => {
	it("starts an unverified epoch at the host-reported centre when it disagrees with caps by more than 1 kHz", async () => {
		let reported: number | null = 446_100_400
		const { engine, host } = make({ read: () => Promise.resolve(reported) })
		await engine.start()
		await new Promise(resolve => setTimeout(resolve, 60))
		await settle()
		expect(host().inputs.filter(i => i.kind === "pending-epoch")).toEqual([])
		reported = 446_250_000
		await new Promise(resolve => setTimeout(resolve, 60))
		await settle()
		const pendings = host().inputs.filter(
			(i): i is Extract<PipelineInput, { kind: "pending-epoch" }> =>
				i.kind === "pending-epoch",
		)
		expect(pendings).toHaveLength(1)
		expect(pendings[0]!.pending).toMatchObject({
			centreHz: 446_250_000,
			tuningTrust: "unverified",
			expectMarker: false,
		})
		expect(engine.warnings().map(w => [w.code, w.deltaHz])).toEqual([
			["host-centre-mismatch", 150_000],
		])
		await engine.stop()
	})

	it("keeps an operator retune unverified while the host-reported centre override is active", async () => {
		const { engine, tuner, host } = make({
			read: () => Promise.resolve(446_250_000),
		})
		await engine.start()
		await new Promise(resolve => setTimeout(resolve, 60))
		await settle()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		await settle()
		const pendings = host()
			.inputs.filter(
				(i): i is Extract<PipelineInput, { kind: "pending-epoch" }> =>
					i.kind === "pending-epoch",
			)
			.map(i => i.pending)
		expect(pendings.length).toBeGreaterThan(0)
		expect(pendings.at(-1)).toMatchObject({ tuningTrust: "unverified" })
		for (const p of pendings) expect(p.tuningTrust).toBe("unverified")
		await engine.stop()
	})
})
