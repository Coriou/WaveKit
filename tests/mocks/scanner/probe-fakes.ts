import { EventEmitter } from "node:events"
import type { Readable } from "node:stream"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import type { DsdFmeLinkLine } from "../../../src/decoders/builtin/dsd-fme-link.js"
import type { DecoderOutputLike } from "../../../src/core/scanner/probes/confirm/double-match.js"
import {
	ProbePool,
	offsetTransport,
	type ProbeEngineView,
	type ProbePoolDeps,
	type ProbeRequest,
	type TransportStrategy,
} from "../../../src/core/scanner/probes/probe-pool.js"
import type { EngineEpoch } from "../../../src/core/spectrum/spectrum-engine.js"
import type {
	DecodeEvidence,
	ScannerSettings,
} from "../../../src/core/scanner/types.js"
import type { IqFormat } from "../../../src/core/spectrum/types.js"
import { testSettings } from "./engine-fakes.js"

export class FakeProbeDecoder extends EventEmitter {
	bytesIn = 0
	readonly chunks: Buffer[] = []
	constructor(
		readonly config: DecoderConfig,
		public input: Readable | null,
	) {
		super()
		input?.on("data", (chunk: Buffer) => {
			this.bytesIn += chunk.length
			this.chunks.push(chunk)
		})
	}
	get id(): string {
		return this.config.id
	}
	received(): Buffer {
		return Buffer.concat(this.chunks)
	}
}

export class FakeDecoderManager extends EventEmitter {
	readonly created = new Map<string, FakeProbeDecoder>()
	readonly removed: string[] = []
	/** Removed decoders stay reachable so tests can emit late lines on them. */
	readonly retired = new Map<string, FakeProbeDecoder>()
	failNext: Error | null = null

	createEphemeralDecoder(
		config: DecoderConfig,
		opts: { owner: "scanner"; jobId: string; input?: Readable },
	): Promise<FakeProbeDecoder> {
		if (this.failNext) {
			const err = this.failNext
			this.failNext = null
			return Promise.reject(err)
		}
		const decoder = new FakeProbeDecoder(config, opts.input ?? null)
		this.created.set(config.id, decoder)
		this.emit("decoder:created", config.id)
		return Promise.resolve(decoder)
	}

	removeEphemeralDecoder(id: string): Promise<void> {
		const decoder = this.created.get(id)
		if (decoder && this.created.delete(id)) {
			this.retired.set(id, decoder)
			this.removed.push(id)
			this.emit("decoder:removed", id)
		}
		return Promise.resolve()
	}

	getDecoder(id: string): FakeProbeDecoder | undefined {
		return this.created.get(id)
	}

	emitOutput(id: string, out: DecoderOutputLike): void {
		this.emit("decoder:output", id, out)
	}

	emitLink(id: string, line: DsdFmeLinkLine): void {
		;(this.created.get(id) ?? this.retired.get(id))?.emit("link", line)
	}
}

export class FakeEngineView extends EventEmitter implements ProbeEngineView {
	readonly sourceId: string
	format: IqFormat = "U8_IQ"
	epoch: EngineEpoch
	edge = 0
	/** The engine's own stream counter; `epoch.stream` lags it after newStream() until setEpoch. */
	stream = 0
	private ring: number[] = []
	private readonly taps = new Set<
		(startSample: number, bytes: Uint8Array) => void
	>()

	constructor(
		opts: {
			sourceId?: string
			centreHz?: number
			sampleRateHz?: number
			epoch?: number
		} = {},
	) {
		super()
		this.sourceId = opts.sourceId ?? "rtl"
		this.epoch = {
			stream: 0,
			epoch: opts.epoch ?? 1,
			startSample: 0,
			centreHz: opts.centreHz ?? 446_100_000,
			sampleRateHz: opts.sampleRateHz ?? 2_048_000,
			gainKey: "m:296",
			tuningTrust: "commanded",
			settleMode: "marker",
		}
	}
	currentEpoch(): EngineEpoch {
		return { ...this.epoch }
	}
	liveEdge(): number {
		return this.edge
	}
	readRing(
		from: number,
		to: number,
	): { startSample: number; bytes: Uint8Array } | null {
		const start = Math.max(0, from)
		if (start >= to) return null
		return {
			startSample: start,
			bytes: Uint8Array.from(this.ring.slice(start * 2, to * 2)),
		}
	}
	tap(fn: (startSample: number, bytes: Uint8Array) => void): () => void {
		this.taps.add(fn)
		return () => this.taps.delete(fn)
	}
	/** Appends `samples` CU8 samples whose bytes encode their own index (mod 256). */
	push(samples: number): void {
		const bytes = new Uint8Array(samples * 2)
		for (let i = 0; i < samples; i++) {
			bytes[2 * i] = (this.edge + i) & 255
			bytes[2 * i + 1] = ((this.edge + i) >> 8) & 255
		}
		for (const b of bytes) this.ring.push(b)
		const start = this.edge
		this.edge += samples
		for (const t of this.taps) t(start, bytes)
	}
	setEpoch(epoch: number, centreHz: number, stream = this.epoch.stream): void {
		this.epoch = { ...this.epoch, epoch, centreHz, stream }
	}
	/**
	 * A reconnect boundary as SpectrumEngine.beginStream makes it: a fresh ring
	 * whose sample indices restart at 0, then `"stream"(stream, "restart")`.
	 * `currentEpoch()` keeps the old stream (a thread host's lag) until setEpoch.
	 */
	newStream(): void {
		this.stream += 1
		this.ring = []
		this.edge = 0
		this.emit("stream", this.stream, "restart")
	}
}

export function probeRequest(
	overrides: Partial<ProbeRequest> = {},
): ProbeRequest {
	return {
		jobId: "job-a",
		priority: 50,
		sourceId: "rtl",
		trackId: "t1",
		observationId: "o1",
		discoveryId: null,
		targetHz: 446_125_000,
		epoch: 1,
		cls: "tdma-ms",
		protocols: [],
		preRollFromSample: null,
		holdMs: 600,
		record: false,
		admission: { kind: "undecoded", snrDb: 20 },
		...overrides,
	}
}

export function poolHarness(
	opts: {
		settings?: ScannerSettings
		cpuPercent?: number | null
		transports?: readonly TransportStrategy[]
		engines?: FakeEngineView[]
		digitalVoice?: ProbePoolDeps["digitalVoice"]
	} = {},
) {
	const decoders = new FakeDecoderManager()
	const engines = opts.engines ?? [new FakeEngineView()]
	const settings = opts.settings ?? testSettings()
	const clock = { now: 1_000_000 }
	const cpu = { normalisedPercent: opts.cpuPercent ?? null }
	let port = 40_000
	const pool = new ProbePool({
		decoders: decoders as never,
		digitalVoice: opts.digitalVoice ?? null,
		engines: id => engines.find(e => e.sourceId === id),
		settings: () => settings,
		transports: opts.transports ?? [offsetTransport],
		cpu,
		engineCount: () => engines.length,
		storageDir: `/tmp/wk-probes-${process.pid}`,
		allocatePort: () => Promise.resolve(port++),
		logger: pino({ level: "silent" }),
		now: () => clock.now,
	})
	const evidence: { probeId: string; req: ProbeRequest; ev: DecodeEvidence }[] =
		[]
	const states: { probeId: string; state: string }[] = []
	pool.on(
		"evidence",
		(probeId: string, req: ProbeRequest, ev: DecodeEvidence) =>
			evidence.push({ probeId, req, ev }),
	)
	pool.on("probe-state", (probeId: string, state: string) =>
		states.push({ probeId, state }),
	)
	return {
		pool,
		decoders,
		engine: engines[0]!,
		settings,
		clock,
		cpu,
		evidence,
		states,
	}
}

export function linkLine(
	cc: number,
	at: number,
	crcErr = false,
): DsdFmeLinkLine {
	return { protocol: "dmr", cc, tg: "9", src: "2060945", slot: 1, crcErr, at }
}

export const flushAsync = (): Promise<void> =>
	new Promise(resolve => setImmediate(resolve))
