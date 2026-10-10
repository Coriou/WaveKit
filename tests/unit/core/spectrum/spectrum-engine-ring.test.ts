/**
 * SpectrumEngine.setRingSeconds (Task 34a): the burst-capture floor on the IQ ring length.
 */
import { describe, expect, it } from "vitest"
import pino from "pino"
import { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
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

const FS = 1_024_000
/** ringSeconds 0.5 at 1.024 Msps. */
const BASE = FS / 2

class NullHost implements PipelineHost {
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(_input: PipelineInput, transfer?: ArrayBuffer): void {
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

async function makeEngine() {
	const sources = new FakeSources("rtl", { sampleRate: FS })
	const fanout = new FakeFanout()
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner: new FakeTuner(),
		settings: () =>
			testSettings(s => {
				s.ringSeconds = 0.5
			}),
		logger: pino({ level: "silent" }),
		createHost: (_cfg, handlers) => new NullHost(handlers),
		batchBytes: 65_536,
	})
	await engine.start()
	/** Writes `samples` CU8 samples whose byte pair encodes (index mod 65536). */
	const feed = async (samples: number) => {
		const target = engine.liveEdge() + samples
		for (let s = engine.liveEdge(); s < target; ) {
			const n = Math.min(32_768, target - s)
			const chunk = Buffer.alloc(n * 2)
			for (let i = 0; i < n; i++) chunk.writeUInt16LE((s + i) & 0xffff, 2 * i)
			fanout.write(chunk)
			s += n
			await settle()
		}
		for (let i = 0; i < 100 && engine.liveEdge() < target; i++) await settle()
		expect(engine.liveEdge()).toBe(target)
	}
	const held = () => engine.readRing(0, Number.MAX_SAFE_INTEGER)
	return { engine, sources, fanout, feed, held }
}

const ringOf = (engine: SpectrumEngine) =>
	(engine as unknown as { ring: unknown }).ring

describe("SpectrumEngine.setRingSeconds", () => {
	it("grows and shrinks in place, keeping the newest samples", async () => {
		const { engine, feed, held } = await makeEngine()
		await feed(600_000)
		expect(held()?.startSample).toBe(600_000 - BASE)
		engine.setRingSeconds(1)
		// Growing keeps what the old ring held, then fills to 1 s.
		expect(held()?.startSample).toBe(600_000 - BASE)
		await feed(600_000)
		expect(held()?.startSample).toBe(1_200_000 - FS)
		engine.setRingSeconds(0)
		const after = held()!
		expect(after.startSample).toBe(1_200_000 - BASE)
		expect(after.bytes.length).toBe(BASE * 2)
		expect(after.bytes[0]! | (after.bytes[1]! << 8)).toBe(
			(1_200_000 - BASE) & 0xffff,
		)
		await engine.stop()
	})

	it("drops the ring at stop (S1-B final review, finding 9)", async () => {
		const { engine, feed, held } = await makeEngine()
		await feed(100_000)
		expect(held()).not.toBeNull()
		await engine.stop()
		expect(ringOf(engine)).toBeNull()
		expect(held()).toBeNull()
	})

	it("is a no-op when the capacity does not change", async () => {
		const { engine, feed } = await makeEngine()
		await feed(10_000)
		const before = ringOf(engine)
		engine.setRingSeconds(0.25) // below ringSeconds 0.5: the same capacity
		expect(ringOf(engine)).toBe(before)
		engine.setRingSeconds(0)
		expect(ringOf(engine)).toBe(before)
		await engine.stop()
	})

	it("empties the ring when its newest samples are a gap, and refills it after", async () => {
		const { engine, fanout, feed, held } = await makeEngine()
		await feed(10_000)
		fanout.congest("scanner-rtl")
		fanout.write(Buffer.alloc(4_000))
		fanout.drain("scanner-rtl")
		await settle()
		expect(engine.liveEdge()).toBe(12_000)
		engine.setRingSeconds(1)
		expect(held()).toBeNull()
		await feed(1_000)
		expect(held()?.startSample).toBe(12_000)
		await engine.stop()
	})

	it("applies the floor to the next stream's ring", async () => {
		const { engine, sources, feed, held } = await makeEngine()
		engine.setRingSeconds(1)
		sources.emit("disconnected", "rtl")
		sources.emit("payload-started", "rtl")
		await settle()
		expect(engine.accounting().stream).toBe(1)
		await feed(1_200_000)
		expect(held()?.startSample).toBe(1_200_000 - FS)
		await engine.stop()
	})
})
