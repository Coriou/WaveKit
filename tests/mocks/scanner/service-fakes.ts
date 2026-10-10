import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import type {
	DecoderConfig,
	DecoderStatus,
} from "../../../src/decoders/types.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import type { ScannerSettings } from "../../../src/core/scanner/types.js"
import { ArbiterFakeTuner } from "./arbiter-fakes.js"
import { FakeFanout, FakeSources, testSettings } from "./engine-fakes.js"
import { FakeDecoderManager } from "./probe-fakes.js"
import { addInto, gaussianNoise, mulberry32, packCu8, tone } from "./signals.js"

export class ServiceFakeDecoders extends FakeDecoderManager {
	/** sourceId → holder ids (the real manager's contract, Task 29). */
	readonly held = new Map<string, Set<string>>()
	holdSource(
		sourceId: string,
		_reason: "tuner-scanning",
		holderId: string,
	): Promise<void> {
		const holders = this.held.get(sourceId) ?? new Set<string>()
		holders.add(holderId)
		this.held.set(sourceId, holders)
		return Promise.resolve()
	}
	releaseSource(sourceId: string, holderId: string): Promise<void> {
		const holders = this.held.get(sourceId)
		holders?.delete(holderId)
		if (holders?.size === 0) this.held.delete(sourceId)
		return Promise.resolve()
	}
	isSourceHeld(sourceId: string): boolean {
		return (this.held.get(sourceId)?.size ?? 0) > 0
	}
	getAllStatus(): DecoderStatus[] {
		return []
	}
	getStatus(): DecoderStatus | undefined {
		return undefined
	}
}

export const FS = 1_024_000
export const CENTRE = 446_100_000

export function serviceHarness(
	opts: {
		dir?: string
		patch?: (s: ScannerSettings) => void
		liveCaps?: boolean
		decoderConfigs?: DecoderConfig[]
	} = {},
) {
	const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "wk-scan-"))
	const sources = new FakeSources("rtl", {
		sampleRate: FS,
		centerFreq: CENTRE,
	})
	const configCaps = sources.getCaps("rtl")!
	// liveCaps: false = boot before SourceManager.connect(): getCaps() is undefined until "connected"
	if (opts.liveCaps === false) sources.caps.delete("rtl")
	sources.rtlTcp.add("rtl")
	const fanout = new FakeFanout()
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl")
	tuner.states.get("rtl")!.sampleRate = FS
	tuner.states.get("rtl")!.frequency = CENTRE
	// Like TunerController: a successful frequency or rate write updates the source caps before it resolves.
	tuner.setFrequency = async (sourceId, hz, writeOpts) => {
		await ArbiterFakeTuner.prototype.setFrequency.call(
			tuner,
			sourceId,
			hz,
			writeOpts,
		)
		if (sources.getCaps(sourceId)) sources.setCaps(sourceId, { centerFreq: hz })
	}
	tuner.setSampleRate = async (sourceId, hz, writeOpts) => {
		await ArbiterFakeTuner.prototype.setSampleRate.call(
			tuner,
			sourceId,
			hz,
			writeOpts,
		)
		if (sources.getCaps(sourceId)) sources.setCaps(sourceId, { sampleRate: hz })
	}
	const decoders = new ServiceFakeDecoders()
	const settings = testSettings(s => {
		s.sweep.markers = false
		s.sweep.settleMs.local = 50
		s.sweep.settleMs.network = 50
		opts.patch?.(s)
	}, dir)
	const service = new ScannerService({
		settings,
		sourceConfigs: [
			{
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: 1234,
				loop: false,
				playbackSpeed: 1,
				caps: configCaps,
			},
		],
		decoderConfigs: opts.decoderConfigs ?? [],
		region: "EU",
		stateDir: dir,
		sources: sources as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
		} as never,
		tuner: tuner as never,
		decoders: decoders as never,
		digitalVoice: null,
		liveDemod: null,
		logger: pino({ level: "silent" }),
		engineHost: "inline",
		tickMs: 20,
	})
	return {
		service,
		sources,
		fanout,
		tuner,
		decoders,
		dir,
		settings,
		configCaps,
	}
}

/** Writes `seconds` of CU8 noise plus a tone of amplitude `amp` at `offsetHz`, in 50 ms chunks. */
export function feedTone(
	fanout: FakeFanout,
	seconds: number,
	offsetHz: number,
	amp = 0.5,
	seed = 11,
): void {
	const rng = mulberry32(seed)
	const n = FS / 20
	for (let i = 0; i < seconds * 20; i++) {
		const iq = addInto(gaussianNoise(rng, n, 0.05), tone(n, FS, offsetHz, amp))
		fanout.write(Buffer.from(packCu8(iq.re, iq.im)))
	}
}

/** Like feedTone with several simultaneous tones (amplitudes relative to full scale). */
export function feedTones(
	fanout: FakeFanout,
	seconds: number,
	tones: readonly { offsetHz: number; amp: number }[],
	seed = 13,
): void {
	const rng = mulberry32(seed)
	const n = FS / 20
	for (let i = 0; i < seconds * 20; i++) {
		let iq = gaussianNoise(rng, n, 0.05)
		for (const t of tones) iq = addInto(iq, tone(n, FS, t.offsetHz, t.amp))
		fanout.write(Buffer.from(packCu8(iq.re, iq.im)))
	}
}

export const tick = (ms = 0): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms))

/**
 * Waits until every job's queued dispatches and actions (teardown included) and every queued lease
 * arbitration have run, instead of a fixed sleep (Task 37a re-review, finding 9). Repeats until a
 * round queues nothing new: a dispatch can queue an arbitration, and an arbitration a dispatch.
 */
export async function settled(service: ScannerService): Promise<void> {
	const internals = service as unknown as {
		drivers: Map<string, { idle(): Promise<void> }>
		arbitrations: Map<string, Promise<void>>
	}
	const snapshot = (): unknown[] => [
		...internals.arbitrations.values(),
		...[...internals.drivers.values()].map(
			d => (d as unknown as { chain?: unknown }).chain,
		),
	]
	for (let round = 0; round < 50; round++) {
		const before = snapshot()
		await Promise.all([
			...[...internals.drivers.values()].map(d => d.idle()),
			...internals.arbitrations.values(),
		])
		// job events queued with queueMicrotask, arbitrations queued from callbacks
		await new Promise<void>(resolve => setImmediate(resolve))
		const after = snapshot()
		if (
			after.length === before.length &&
			after.every((x, i) => x === before[i])
		)
			return
	}
}
