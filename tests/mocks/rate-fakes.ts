/**
 * Fakes for rate-model tests: a decoder with scripted rate declarations and
 * controllable start/stop, and a minimal SourceManager stand-in.
 */
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import type { SourceCaps } from "../../src/core/source-manager.js"
import type {
	Decoder,
	DecoderBandDeclaration,
	DecoderBandRequirements,
	DecoderCaps,
	DecoderRateAdapter,
	DecoderRateRequirements,
	DecoderStatus,
} from "../../src/decoders/types.js"

export const MIN_HZ = 48_000

const requirements: DecoderRateRequirements = {
	version: 1,
	sourceKind: "iq",
	capture: {
		accepted: [{ kind: "range", minHz: MIN_HZ }],
		preferredHz: [2_400_000],
		minimum: { hz: MIN_HZ, basis: "implementation", evidence: "test" },
	},
	decoderInput: {
		kind: "audio_pcm",
		format: "s16le",
		preferredHz: 48_000,
		accepted: [{ kind: "discrete", valuesHz: [48_000] }],
	},
}

export function deferred() {
	let resolve!: () => void
	let reject!: (err: Error) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

export class RateDecoder extends EventEmitter implements Decoder {
	readonly type = "rate-test"
	running = false
	starts = 0
	stops = 0
	input: Readable | null = null
	/** When set, start()/stop() wait for it (then clear it). */
	startGate: ReturnType<typeof deferred> | null = null
	stopGate: ReturnType<typeof deferred> | null = null
	failStart = false
	failStop = false
	/** Scripted configured band; undefined = unknown. */
	band: DecoderBandRequirements | undefined = undefined
	/** Full scripted declaration; wins over `band` when set. */
	bandDeclaration: DecoderBandDeclaration | undefined = undefined
	readonly output = new PassThrough({ objectMode: true })
	constructor(
		readonly id: string,
		readonly caps: DecoderCaps,
	) {
		super()
	}
	async start() {
		this.starts++
		const gate = this.startGate
		this.startGate = null
		if (gate) await gate.promise
		if (this.failStart) throw new Error("spawn failed")
		this.running = true
		this.emit("started")
	}
	async stop() {
		this.stops++
		const gate = this.stopGate
		this.stopGate = null
		if (gate) await gate.promise
		if (this.failStop) throw new Error("stop failed")
		const wasRunning = this.running
		this.running = false
		this.emit("stopped")
		if (wasRunning) this.emit("exit", null, "SIGTERM")
	}
	async restart() {
		await this.stop()
		await this.start()
	}
	attachInput(input: Readable) {
		this.input = input
	}
	detachInput() {
		this.input = null
	}
	updateOptions(_updates: Record<string, unknown>) {}
	getOutput() {
		return this.output
	}
	getAudioOutput() {
		return null
	}
	getHealth() {
		return "running" as const
	}
	getStatus(): DecoderStatus {
		return {
			id: this.id,
			type: this.type,
			running: this.running,
			health: "running",
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
	}
	getRateRequirements(): DecoderRateRequirements | undefined {
		return this.caps.input === "external"
			? {
					version: 1,
					sourceKind: "external",
					decoderInput: { kind: "external" },
				}
			: requirements
	}
	getRateAdapter(input: { sampleRateHz: number }): DecoderRateAdapter {
		const k = Math.max(1, Math.round(input.sampleRateHz / 48_000))
		return {
			adaptation: "integer-decimation",
			frontendRateHz: input.sampleRateHz / k,
			decoderInputKind: "audio_pcm",
			decoderInputRateHz: 48_000,
			decoderInputFormat: "s16le",
		}
	}
	getBandDeclaration(): DecoderBandDeclaration {
		if (this.bandDeclaration) return this.bandDeclaration
		return this.band ? { configured: this.band } : {}
	}
	crash() {
		this.running = false
		this.emit("exit", 1, null)
	}
}

export class FakeSources extends EventEmitter {
	readonly caps = new Map<string, SourceCaps>()
	readonly assignments = new Map<string, string>()
	readonly rtlTcp = new Set<string>()
	isRtlTcpSource(id: string) {
		return this.rtlTcp.has(id)
	}
	getAllStatus() {
		return [...this.caps.keys()].map(id => ({ id, connected: true }))
	}
	getStatus(id: string) {
		return this.caps.has(id) ? { id, connected: true } : undefined
	}
	getCaps(id: string) {
		return this.caps.get(id)
	}
	getStream() {
		return new PassThrough()
	}
	assignDecoder(decoderId: string, sourceId: string) {
		if (!this.caps.has(sourceId))
			throw new Error(`Source ${sourceId} not found`)
		this.assignments.set(decoderId, sourceId)
	}
	getAssignedSource(decoderId: string) {
		return this.assignments.get(decoderId)
	}
	unassignDecoder(decoderId: string) {
		this.assignments.delete(decoderId)
	}
	setRate(id: string, sampleRate: number) {
		const caps = { ...this.caps.get(id)!, sampleRate }
		this.caps.set(id, caps)
		this.emit("caps-changed", id, caps)
	}
	setCenter(id: string, centerFreq: number | undefined) {
		const { centerFreq: _old, ...rest } = this.caps.get(id)!
		const caps: SourceCaps =
			centerFreq === undefined ? rest : { ...rest, centerFreq }
		this.caps.set(id, caps)
		this.emit("caps-changed", id, caps)
	}
	remove(id: string) {
		this.caps.delete(id)
		for (const [decoder, source] of this.assignments)
			if (source === id) this.assignments.delete(decoder)
		this.emit("removed", id)
	}
	reconnect(id: string, sampleRate: number) {
		this.caps.set(id, iqCaps(sampleRate))
		this.emit("connected", id)
	}
}

export function iqCaps(sampleRate: number): SourceCaps {
	return { kind: "iq", format: "U8_IQ", sampleRate, exclusive: false }
}
