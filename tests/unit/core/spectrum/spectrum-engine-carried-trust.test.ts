/**
 * Commands kept across a pipeline restart: the newest one decides the trust and the centre, and
 * entries from a connection that is gone are dropped (spectrum engine, real TunerController).
 */
import fc from "fast-check"
import pino from "pino"
import { expect, it } from "vitest"
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

async function heldRestart(t: ReturnType<typeof setup>) {
	let release!: (state: EngineState) => void
	const old = t.hosts[0]!
	const snapshot = await old.exportState()
	old.exportState = () =>
		new Promise(resolve => {
			release = resolve
		})
	const done = t.engine.reconfigure()
	return async () => {
		release(snapshot)
		await done
		await settle()
	}
}
async function ready() {
	const t = setup()
	await t.tuner.setSampleRate("rtl", RATE)
	await t.tuner.setFrequency("rtl", 446_100_000)
	await t.engine.start()
	return t
}
function carried(t: ReturnType<typeof setup>) {
	return (t.engine as unknown as { carried: object[] }).carried.length
}
it("relay centre supersedes the carried explicit centre", async () => {
	const t = await ready()
	const finish = await heldRestart(t)
	try {
		await t.tuner.setFrequency("rtl", 446_200_000)
		await settle()
		t.tuner.applyExternalCommand("rtl", SET_FREQUENCY, 446_400_000)
		await settle()
		await finish()
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_400_000,
			tuningTrust: "relay",
		})
	} finally {
		await t.engine.stop()
	}
})
it("internal control plus gain retains the relay-moved centre", async () => {
	const t = await ready()
	const finish = await heldRestart(t)
	try {
		await t.tuner.setFrequency("rtl", 446_200_000)
		await settle()
		t.tuner.applyExternalCommand("rtl", SET_FREQUENCY, 446_400_000)
		await settle()
		t.tuner.setControlMode("rtl", "internal")
		await t.tuner.setGain("rtl", 200)
		await settle()
		await finish()
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_400_000,
			tuningTrust: "commanded",
		})
	} finally {
		await t.engine.stop()
	}
})
it("1000 disconnect/replay pairs keep at most one carried command", async () => {
	const t = await ready()
	const finish = await heldRestart(t)
	let maximum = 0
	try {
		for (let i = 0; i < 1000; i++) {
			t.sources.emit("disconnected", "rtl")
			t.sources.emit("payload-started", "rtl")
			t.tuner.synchronizeOnConnect("rtl")
			await settle()
			maximum = Math.max(maximum, carried(t))
		}
		expect(maximum).toBe(1)
		await finish()
		expect(carried(t)).toBe(0)
		expect(t.streams().at(-1)).toBe("unverified")
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_100_000,
			tuningTrust: "commanded",
		})
	} finally {
		await t.engine.stop()
	}
})
it("proven relay trust survives a held restart and reconnect", async () => {
	const t = await ready()
	const finish = await heldRestart(t)
	try {
		t.sources.emit("disconnected", "rtl")
		t.sources.emit("payload-started", "rtl")
		t.tuner.applyExternalCommand("rtl", SET_SAMPLE_RATE, RATE)
		t.tuner.applyExternalCommand("rtl", SET_FREQUENCY, 446_400_000)
		await settle()
		await finish()
		expect(t.streams().at(-1)).toBe("unverified")
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_400_000,
			tuningTrust: "relay",
		})
	} finally {
		await t.engine.stop()
	}
})
it("unknown frequency or rate at posting fails closed, then recovers", async () => {
	for (const field of ["frequency", "sampleRate"] as const) {
		const t = await ready()
		const finish = await heldRestart(t)
		const getState = t.tuner.getState.bind(t.tuner)
		let unknown = false
		t.tuner.getState = id => {
			const state = getState(id)
			return state && unknown ? { ...state, unknownFields: [field] } : state
		}
		try {
			await t.tuner.setFrequency("rtl", 446_200_000)
			await settle()
			unknown = true
			await finish()
			expect(t.epochs().at(-1)?.tuningTrust).toBe("unverified")
			unknown = false
			await t.tuner.setGain("rtl", 200)
			await settle()
			expect(t.epochs().at(-1)).toMatchObject({
				centreHz: 446_200_000,
				tuningTrust: "commanded",
			})
		} finally {
			await t.engine.stop()
		}
	}
})

it("replay waits for buffered old-connection bytes to cross the boundary", async () => {
	const t = await ready()
	const branch = t.fanout.branches.get("scanner-rtl")!.stream
	try {
		branch.pause()
		t.fanout.write(Buffer.alloc(2048))
		await t.tuner.setFrequency("rtl", 446_200_000)
		t.sources.emit("disconnected", "rtl")
		t.sources.emit("payload-started", "rtl")
		t.tuner.applyExternalCommand("rtl", SET_SAMPLE_RATE, RATE)
		t.tuner.applyExternalCommand("rtl", SET_FREQUENCY, 446_400_000)
		await settle()
		expect(t.epochs().some(e => e.centreHz === 446_400_000)).toBe(false)
		branch.resume()
		await settle()
		expect(t.streams()).toEqual(["commanded", "unverified"])
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_400_000,
			tuningTrust: "relay",
		})
	} finally {
		branch.resume()
		await t.engine.stop()
	}
})
it("both tuning fields becoming proven during a restart recover commanded", async () => {
	const t = setup()
	await t.engine.start()
	const finish = await heldRestart(t)
	try {
		await t.tuner.setSampleRate("rtl", RATE)
		await settle()
		await t.tuner.setFrequency("rtl", 446_200_000)
		await settle()
		await finish()
		expect(t.epochs().at(-1)).toMatchObject({
			centreHz: 446_200_000,
			tuningTrust: "commanded",
		})
	} finally {
		await t.engine.stop()
	}
})
