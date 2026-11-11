import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../../src/config.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { blockSamplesOf } from "../../../../src/core/spectrum/retune-settle.js"
import {
	SpectrumEngine,
	type EngineLedger,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	BlockSummary,
	EngineState,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import type { TrustVerdict } from "../../../../src/core/tuning-ledger.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import { startStampedRtlTcp } from "../../../mocks/stamped-rtl-tcp.js"

const logger = createLogger({ level: "error" })
const cleanups: (() => unknown)[] = []

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 102.4 ksps U8 IQ: 204.8 kB/s; a 64 KiB in-flight estimate is 320 ms, above the 50 ms settle. */
const RATE = 102_400
const F0 = 100_000_000
const F1 = 101_000_000
const F2 = 102_000_000

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

/**
 * A pipeline host that keeps every sample the engine hands it (per stream, by sample index) and
 * answers with a block summary at each block boundary, like the worker would.
 */
class RecordingHost implements PipelineHost {
	readonly samples = new Map<number, Buffer>()
	private stream = -1
	private reached = 0
	private emitted = 0
	constructor(
		readonly handlers: PipelineHostHandlers,
		private readonly block: number,
		private readonly onBlock: (stream: number, endSample: number) => void,
	) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		if (input.kind === "new-stream") {
			this.stream = input.stream
			this.reached = 0
			this.emitted = 0
			this.samples.set(input.stream, Buffer.alloc(0))
			const stream = input.stream
			setImmediate(() =>
				this.handlers.events([
					{
						kind: "epoch-started",
						epoch: stream + 1,
						startSample: 0,
						settleMode: "none",
					},
				]),
			)
		} else if (input.kind === "bytes" || input.kind === "gap") {
			const n = input.kind === "bytes" ? input.bytes.length / 2 : input.samples
			const end = input.startSample + n
			const old = this.samples.get(this.stream) ?? Buffer.alloc(0)
			const grown = Buffer.alloc(Math.max(old.length, end * 2))
			old.copy(grown)
			// Gap samples stay 0: no stamp.
			if (input.kind === "bytes")
				Buffer.from(input.bytes).copy(grown, input.startSample * 2)
			this.samples.set(this.stream, grown)
			this.reached = Math.max(this.reached, end)
			const stream = this.stream
			while ((this.emitted + 1) * this.block <= this.reached) {
				this.emitted += 1
				const endSample = this.emitted * this.block
				setImmediate(() => this.onBlock(stream, endSample))
			}
		}
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

function summary(
	stream: number,
	epoch: number,
	endSample: number,
): BlockSummary {
	return {
		sourceId: "rtl",
		stream,
		epoch,
		endSample,
		centreHz: F0,
		sampleRateHz: RATE,
		binHz: 100,
		startHz: F0 - RATE / 2,
		bins: [],
		floorDbfs: -90,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: F0, dcGuardHz: 0, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

describe("SpectrumEngine tuning-ledger shadow (real SourceManager, FanoutManager, stamped fake rtl_tcp)", () => {
	it("never labels a block trusted whose stamps disagree with the ledger's centre or rate", async () => {
		const fake = await startStampedRtlTcp({ initialHz: F0, initialRate: RATE })
		cleanups.push(() => fake.close())
		// A small configured settle; the 64 KiB in-flight estimate binds (320 ms at this rate).
		const manager = new SourceManager(logger, {
			tuningSettleMs: () => 50,
			tuningInFlightBytes: 64 * 1024,
		})
		cleanups.push(() => manager.disconnectAll())
		await manager.connect({
			id: "rtl",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: fake.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: RATE,
				centerFreq: F0,
				exclusive: false,
			},
		} as SourceConfig)
		const ledger = manager.tuningLedger
		await until(() => (ledger.position("rtl")?.pos ?? 0) > 0)
		const fanout = new FanoutManager(logger)
		fanout.attachSource(manager.getStream("rtl")!)
		cleanups.push(() => fanout.destroy())

		// The engine reads the real ledger; the spy keeps the verdict of each block it labels.
		let lastVerdict: TrustVerdict | null = null
		const spy: EngineLedger = {
			trustAt: (id, session, a, b) => {
				lastVerdict = ledger.trustAt(id, session, a, b)
				return lastVerdict
			},
			position: id => ledger.position(id),
			raiseDoubt: (...args) => ledger.raiseDoubt(...args),
		}
		const settings = testSettings()
		let block = 0
		let host: RecordingHost | null = null
		const counts = { blocks: 0, trusted: 0, foreign: 0 }
		const trustedAt = new Map<number, number>()
		const engine = new SpectrumEngine({
			sourceId: "rtl",
			sources: manager,
			routing: {
				getFanout: () => fanout,
				releaseUnused: () => undefined,
			},
			tuner: null,
			ledger: spy,
			settings: () => settings,
			logger: pino({ level: "silent" }),
			createHost: (cfg, handlers) => {
				block = blockSamplesOf(cfg.integrationMs, cfg.sampleRateHz, cfg.fftSize)
				host = new RecordingHost(handlers, block, (stream, endSample) => {
					lastVerdict = null
					handlers.events([
						{
							kind: "block-summary",
							summary: summary(stream, engine.currentEpoch().epoch, endSample),
						},
					])
					counts.blocks += 1
					const v = lastVerdict as TrustVerdict | null
					if (!v || v.trust === "unverified") return
					counts.trusted += 1
					trustedAt.set(v.frequency!, (trustedAt.get(v.frequency!) ?? 0) + 1)
					const bytes = host!.samples.get(stream)!
					for (let i = endSample - block; i < endSample; i++) {
						const c = bytes[i * 2]!
						const r = bytes[i * 2 + 1]!
						if (c === 0) continue
						if (
							fake.centreOf(c) !== v.frequency ||
							fake.rateOf(r) !== v.sampleRate
						) {
							counts.foreign += 1
							break
						}
					}
				})
				return host
			},
		})
		cleanups.push(() => engine.stop())
		await engine.start()
		expect(engine.config()!.sampleRateHz).toBe(RATE)

		// Nothing proved yet: every block so far is unverified.
		await wait(300)
		expect(counts.blocks).toBeGreaterThan(0)
		expect(counts.trusted).toBe(0)
		// Operator tuning, then a retune mid-run; trust only comes from the real flow (time).
		manager.writeToSource(
			"rtl",
			Buffer.concat([frame(0x01, F1), frame(0x02, RATE)]),
			{ writer: "operator" },
		)
		await until(() => (trustedAt.get(F1) ?? 0) >= 3, 8000)
		manager.writeToSource("rtl", frame(0x01, F2), { writer: "operator" })
		await until(() => (trustedAt.get(F2) ?? 0) >= 3, 8000)
		await engine.stop()

		// Counts: blocks labelled, trusted, and trusted with a foreign stamp (must be 0).
		expect(counts.foreign).toBe(0)
		expect(counts.trusted).toBeGreaterThanOrEqual(6)
		const shadow = engine.trustShadow()!
		// Without a tuner the engine labels everything unverified: every trusted ledger block is
		// a looser disagreement, the rest agree.
		expect(shadow.ledgerLooser).toBe(counts.trusted)
		expect(shadow.agree + shadow.ledgerLooser).toBe(counts.blocks)
	}, 30_000)
})
