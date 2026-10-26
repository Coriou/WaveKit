import { makeTmpDir } from "../../helpers/tmp-dir.js"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type {
	BranchConfig,
	BranchTelemetry,
} from "../../../src/core/fanout-manager.js"
import type { SourceCaps } from "../../../src/config.js"
import type { TunerState } from "@wavekit/api-types"
import { ScannerConfigSchema } from "../../../src/config.js"
import type { ScannerSettings } from "../../../src/core/scanner/types.js"

const storageDir = makeTmpDir("wk-scanner-")

/** Scanner settings from the config schema defaults, with test overrides. */
export function testSettings(
	patch: (s: ScannerSettings) => void = () => undefined,
	dir = storageDir,
): ScannerSettings {
	const parsed = ScannerConfigSchema.parse({
		storage: { dir },
	}) as ScannerSettings
	const settings = structuredClone(parsed)
	patch(settings)
	return settings
}

/** FanoutManager double with the same drop-on-congestion accounting (fanout-manager.ts :249-323). */
export class FakeFanout extends EventEmitter {
	readonly branches = new Map<
		string,
		{
			stream: PassThrough
			total: number
			dropped: number
			bp: boolean
			hwm: number
		}
	>()

	addBranch(config: BranchConfig): PassThrough {
		const hwm = config.highWaterMark ?? 262_144
		const stream = new PassThrough({ highWaterMark: hwm })
		stream.on("error", () => undefined)
		this.branches.set(config.id, {
			stream,
			total: 0,
			dropped: 0,
			bp: false,
			hwm,
		})
		return stream
	}

	removeBranch(id: string): void {
		const branch = this.branches.get(id)
		if (!branch) return
		branch.stream.destroy()
		this.branches.delete(id)
	}

	getBranchTelemetry(id: string): BranchTelemetry | undefined {
		const b = this.branches.get(id)
		if (!b) return undefined
		return {
			id,
			backpressureActive: b.bp,
			backpressureEnterCount: 0,
			droppedBytesTotal: b.dropped,
			droppedChunksTotal: 0,
			bufferBytes: b.stream.readableLength + b.stream.writableLength,
			highWaterMark: b.hwm,
			totalBytesWritten: b.total,
		}
	}

	/** Distributes one source chunk to every branch (dropped while congested). */
	write(chunk: Buffer): void {
		for (const b of this.branches.values()) {
			b.total += chunk.length
			if (b.bp) {
				b.dropped += chunk.length
				continue
			}
			b.stream.write(chunk)
		}
	}

	congest(id: string): void {
		const b = this.branches.get(id)
		if (!b) return
		b.bp = true
		this.emit("backpressure", id, b.stream.readableLength)
	}

	drain(id: string): void {
		const b = this.branches.get(id)
		if (!b) return
		b.bp = false
		this.emit("drain", id, 0)
	}
}

export class FakeSources extends EventEmitter {
	readonly caps = new Map<string, SourceCaps>()
	readonly streams = new Map<string, PassThrough>()
	rtlTcp = new Set<string>()

	constructor(sourceId = "rtl", caps?: Partial<SourceCaps>) {
		super()
		this.caps.set(sourceId, {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 1_024_000,
			centerFreq: 446_100_000,
			exclusive: false,
			...caps,
		})
		this.streams.set(sourceId, new PassThrough())
	}

	getCaps(id: string): SourceCaps | undefined {
		return this.caps.get(id)
	}

	getStream(id: string): PassThrough | undefined {
		return this.streams.get(id)
	}

	isRtlTcpSource(id: string): boolean {
		return this.rtlTcp.has(id)
	}

	setCaps(id: string, patch: Partial<SourceCaps>): void {
		const next = { ...this.caps.get(id)!, ...patch }
		this.caps.set(id, next)
		this.emit("caps-changed", id, next)
	}
}

export class FakeTuner extends EventEmitter {
	readonly states = new Map<string, TunerState>()

	constructor(sourceId = "rtl", frequency = 446_100_000) {
		super()
		this.states.set(sourceId, {
			sourceId,
			frequency,
			sampleRate: 1_024_000,
			gainMode: "manual",
			gain: 296,
			ppm: 0,
			agcMode: false,
			biasTee: false,
			directSampling: "off",
			offsetTuning: false,
			ifGain: 0,
			tunerIfGain: null,
			testMode: false,
			controlMode: "internal",
			commandCount: 0,
		})
	}

	getState(id: string): TunerState | undefined {
		const s = this.states.get(id)
		return s ? { ...s } : undefined
	}
}

/** Lets queued stream callbacks and microtasks run. */
export function settle(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve))
}
