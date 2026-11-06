/**
 * A sweep through the production composition: an in-process fake source (no network), the inline
 * spectrum engine and pipeline, the real channel gate, ScannerService, JobRunner, SweepScheduler and
 * wideband recorder. The world is synthesised per chunk from the tuned centre, so a signal is on air
 * whatever the sweep does; the clock is the count of samples fed (no wall clock, no alignment with
 * the visits). Timers of the service are replaced by one tick per chunk.
 */
import { readdirSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import pino, { type Logger } from "pino"
import { ScannerService } from "../../../../src/core/scanner/scanner-service.js"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import { makeTmpDir } from "../../../helpers/tmp-dir.js"
import { ArbiterFakeTuner } from "../../../mocks/scanner/arbiter-fakes.js"
import {
	FakeFanout,
	FakeSources,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import { ServiceFakeDecoders } from "../../../mocks/scanner/service-fakes.js"
import { NfmSource } from "./wideband-nfm-fixtures.js"

export const FS = 1_024_000
const CHUNK = FS / 40
const CHUNK_MS = 25
const T0 = 1_000_000

/** Maker of `n` CU8 IQ pairs for what a receiver tuned to `centreHz` hears from `atMs` of the world. */
export type World = (n: number, centreHz: number, atMs: number) => Uint8Array

export interface Emitter {
	hz: number
	fromMs: number
	toMs: number
	/** Voice tones and a CTCSS tone over speech syllables; or an unmodulated carrier. */
	kind: "voice" | "carrier"
	amp?: number
}

/**
 * FM at `offsetHz` modulated by several tones at once under a 4 Hz syllable envelope, with a 67 Hz
 * sub-tone: within one 50 ms block its spectrum fills about 12 kHz, as speech through an NFM
 * transmitter does (a single tone at a time reads as a narrow line in each block).
 */
function fmVoice(
	offsetHz: number,
	amp: number,
): (n: number, startSample: number) => Uint8Array {
	const TONES = [
		{ hz: 410, dev: 1900 },
		{ hz: 730, dev: 1500 },
		{ hz: 1170, dev: 1100 },
		{ hz: 1930, dev: 800 },
		{ hz: 2710, dev: 500 },
	]
	let phase = 0
	return (n, startSample) => {
		const out = new Uint8Array(2 * n)
		for (let i = 0; i < n; i++) {
			const t = (startSample + i) / FS
			const envelope =
				t % 1.7 > 1.4 ? 0.15 : 0.55 - 0.45 * Math.cos(2 * Math.PI * 4 * t)
			let dev = 350 * Math.sin(2 * Math.PI * 67 * t)
			for (const tone of TONES)
				dev += envelope * tone.dev * Math.sin(2 * Math.PI * tone.hz * t)
			phase = (phase + (2 * Math.PI * (offsetHz + dev)) / FS) % (2 * Math.PI)
			out[2 * i] = Math.round(127.5 + 127.5 * amp * Math.cos(phase))
			out[2 * i + 1] = Math.round(127.5 + 127.5 * amp * Math.sin(phase))
		}
		return out
	}
}

/** Noise everywhere, plus each emitter on air in its time span while inside the tuned window. */
export function synthWorld(emitters: readonly Emitter[]): World {
	const noise = new NfmSource({ fs: FS, offsetHz: 0, seed: 5 })
	const sources = new Map<string, (n: number, at: number) => Uint8Array>()
	const sourceOf = (e: Emitter, i: number, centreHz: number) => {
		const key = `${i}:${centreHz}`
		let s = sources.get(key)
		if (s === undefined) {
			const offsetHz = e.hz - centreHz
			const amp = e.amp ?? 0.25
			if (e.kind === "voice") s = fmVoice(offsetHz, amp)
			else {
				const carrier = new NfmSource({
					fs: FS,
					offsetHz,
					noiseSigma: 0,
					amp,
					voice: false,
					ctcssHz: null,
				})
				s = n => carrier.next(n, true)
			}
			sources.set(key, s)
		}
		return s
	}
	return (n, centreHz, atMs) => {
		const out = noise.next(n, false)
		emitters.forEach((e, i) => {
			if (atMs < e.fromMs || atMs >= e.toMs) return
			if (Math.abs(e.hz - centreHz) > FS / 2) return
			const part = sourceOf(e, i, centreHz)(n, Math.round((atMs * FS) / 1000))
			for (let k = 0; k < out.length; k++)
				out[k] = Math.max(
					0,
					Math.min(255, Math.round(out[k]! + part[k]! - 127.5)),
				)
		})
		return out
	}
}

/** One visit as the tuner saw it: a frequency write until the next one. */
export interface VisitLog {
	centreHz: number
	atMs: number
	endMs: number | null
}

export interface TrackLog {
	trackId: string
	centreHz: number
	atMs: number
	kind: string
	gate: string | undefined
	blocks: number
	centreOfVisit: number
}

interface Internals {
	tick(): void
	drivers: Map<
		string,
		{
			scheduler?: {
				progress(): { holdingOn: string | null; hopIndex: number }
				hopStats(): {
					hopIndex: number
					visits: number
					timeMs: number
					holdMs: number
				}[]
			}
		}
	>
}

export function qualificationWorld(opts: {
	world: World
	centreHz: number
	patch?: (s: ScannerSettings) => void
	logger?: Logger
}) {
	const dir = makeTmpDir("wk-qualify-")
	const sources = new FakeSources("rtl", {
		sampleRate: FS,
		centerFreq: opts.centreHz,
	})
	const configCaps = sources.getCaps("rtl")!
	sources.rtlTcp.add("rtl")
	const fanout = new FakeFanout()
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl")
	tuner.states.get("rtl")!.sampleRate = FS
	tuner.states.get("rtl")!.frequency = opts.centreHz
	// Like TunerController: a successful write updates the source caps before it resolves.
	tuner.setFrequency = async (sourceId, hz, writeOpts) => {
		await ArbiterFakeTuner.prototype.setFrequency.call(
			tuner,
			sourceId,
			hz,
			writeOpts,
		)
		if (sources.getCaps(sourceId)) sources.setCaps(sourceId, { centerFreq: hz })
	}
	let samples = 0
	const clock = (): number => T0 + (samples * 1000) / FS
	const settings = testSettings(s => {
		s.sweep.markers = false
		s.sweep.settleMs.local = 50
		s.sweep.settleMs.network = 50
		s.passive.enabled = false
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
		decoderConfigs: [],
		region: "EU",
		stateDir: dir,
		sources: sources as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
		} as never,
		tuner: tuner as never,
		decoders: new ServiceFakeDecoders() as never,
		digitalVoice: null,
		liveDemod: null,
		logger: opts.logger ?? pino({ level: "silent" }),
		engineHost: "inline",
		// One tick per chunk (advance): the interval never fires inside a test.
		tickMs: 3_600_000,
		now: clock,
	})
	const internals = service as unknown as Internals
	const visits: VisitLog[] = []
	const tracks: TrackLog[] = []
	/** Every chunk's held track of the sweep, as [ms, trackId or null]. */
	const holds: { atMs: number; trackId: string | null; centreHz: number }[] = []
	const tunedHz = (): number => tuner.states.get("rtl")!.frequency
	service.spectrum.on("pipeline", (_sourceId: string, ev: PipelineEvent) => {
		if (
			ev.kind !== "track-open" &&
			ev.kind !== "track-update" &&
			ev.kind !== "track-close"
		)
			return
		tracks.push({
			trackId: ev.track.trackId,
			centreHz: ev.track.centreHz,
			atMs: clock() - T0,
			kind: ev.kind,
			gate: ev.track.gate,
			blocks: ev.track.blocks,
			centreOfVisit: tunedHz(),
		})
	})
	const turn = (): Promise<void> =>
		new Promise(resolve => setImmediate(resolve))
	const driver = () => [...internals.drivers.values()][0]
	const noteVisit = (): void => {
		const hz = tunedHz()
		const last = visits[visits.length - 1]
		if (last?.centreHz === hz) return
		const at = clock() - T0
		if (last !== undefined) last.endMs = at
		visits.push({ centreHz: hz, atMs: at, endMs: null })
	}
	return {
		service,
		tuner,
		fanout,
		dir,
		visits,
		tracks,
		holds,
		nowMs: (): number => clock() - T0,
		scheduler: () => driver()?.scheduler,
		/** Seconds of each finalized analog WAV (8 kHz, 16 bit, a 44 byte header). */
		wavSeconds(): number[] {
			const root = join(dir, "recordings", "analog")
			let discoveries: string[]
			try {
				discoveries = readdirSync(root)
			} catch {
				return []
			}
			return discoveries.flatMap(d =>
				readdirSync(join(root, d))
					.filter(f => f.endsWith(".wav"))
					.map(f => (statSync(join(root, d, f)).size - 44) / 2 / 8000),
			)
		},
		/** Feeds `ms` of the world, one chunk and one tick at a time, with event-loop turns between. */
		async advance(ms: number): Promise<void> {
			const chunks = Math.round(ms / CHUNK_MS)
			for (let i = 0; i < chunks; i++) {
				noteVisit()
				const iq = opts.world(CHUNK, tunedHz(), clock() - T0)
				samples += CHUNK
				fanout.write(Buffer.from(iq))
				internals.tick()
				await turn()
				await turn()
				await turn()
				noteVisit()
				holds.push({
					atMs: clock() - T0,
					trackId: driver()?.scheduler?.progress().holdingOn ?? null,
					centreHz: tunedHz(),
				})
			}
		},
		async stop(): Promise<void> {
			await service.stop()
			await rm(dir, { recursive: true, force: true })
		},
	}
}
