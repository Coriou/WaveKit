/**
 * A sweep through the production composition: an in-process fake source (no network), the inline
 * spectrum engine and pipeline, the real channel gate, ScannerService, JobRunner, SweepScheduler and
 * wideband recorder. The world is synthesised per chunk from the tuned centre, so a signal is on air
 * whatever the sweep does; the clock is the count of samples fed (no wall clock, no alignment with
 * the visits). Timers of the service are replaced by one tick per chunk.
 *
 * runScene is the reusable form: hops, ranges (so a burst or a non-burst gate), settle, synthetic
 * voice with speech pauses, carriers, QSOs simplex or through a repeater's hang (qso), other-hop IDs
 * (ids), or any IQ a caller feeds (`iqSource`); it returns a structured SceneReport.
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
/** One look for finalized WAVs per second of the world. */
const WAV_SCAN_CHUNKS = 40

/** Maker of `n` CU8 IQ pairs for what a receiver tuned to `centreHz` hears from `atMs` of the world. */
export type World = (n: number, centreHz: number, atMs: number) => Uint8Array

export interface Emitter {
	hz: number
	fromMs: number
	toMs: number
	/**
	 * Voice tones and a CTCSS tone over speech syllables; an unmodulated carrier; or random 4FSK
	 * data (fmData), a flat-topped spectrum.
	 */
	kind: "voice" | "carrier" | "data"
	amp?: number
	/**
	 * Spans of a voice's time with no speech: the carrier and its sub-tone stay on air (a pause
	 * between phrases, or a repeater's hang). Sorted, absolute ms of the world.
	 */
	pauses?: readonly Span[]
	/** How the voice speaks (Speech); absent: the default speaker. */
	speech?: Speech
}

/**
 * A speaker's rhythm: syllables at `syllableHz` (4), and every `phraseMs` (1700) a dip of `dipMs`
 * (300) to a low level, where speech runs between two words without stopping. Pauses with no speech
 * at all are the emitter's `pauses`.
 */
export interface Speech {
	syllableHz?: number
	phraseMs?: number
	dipMs?: number
	/** Scales every voice tone's deviation (1): 6 spreads it past a 25 kHz channel, as broadcast FM. */
	deviationScale?: number
}

/** From `fromMs` to `toMs` of the world. */
export interface Span {
	fromMs: number
	toMs: number
}

/**
 * FM at `offsetHz` modulated by several tones at once under a 4 Hz syllable envelope, with a 67 Hz
 * sub-tone: within one 50 ms block its spectrum fills about 12 kHz, as speech through an NFM
 * transmitter does (a single tone at a time reads as a narrow line in each block).
 */
function fmVoice(
	offsetHz: number,
	amp: number,
	pauses: readonly Span[] = [],
	speech: Speech = {},
): (n: number, startSample: number) => Uint8Array {
	const syllableHz = speech.syllableHz ?? 4
	const phraseS = (speech.phraseMs ?? 1_700) / 1000
	const dipS = (speech.dipMs ?? 300) / 1000
	const scale = speech.deviationScale ?? 1
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
		const fromMs = (startSample * 1000) / FS
		const toMs = ((startSample + n) * 1000) / FS
		const silent = pauses.filter(p => p.fromMs < toMs && p.toMs > fromMs)
		for (let i = 0; i < n; i++) {
			const t = (startSample + i) / FS
			const ms = t * 1000
			const envelope = silent.some(p => ms >= p.fromMs && ms < p.toMs)
				? 0
				: t % phraseS > phraseS - dipS
					? 0.15
					: 0.55 - 0.45 * Math.cos(2 * Math.PI * syllableHz * t)
			let dev = 350 * Math.sin(2 * Math.PI * 67 * t)
			for (const tone of TONES)
				dev += envelope * scale * tone.dev * Math.sin(2 * Math.PI * tone.hz * t)
			phase = (phase + (2 * Math.PI * (offsetHz + dev)) / FS) % (2 * Math.PI)
			out[2 * i] = Math.round(127.5 + 127.5 * amp * Math.cos(phase))
			out[2 * i + 1] = Math.round(127.5 + 127.5 * amp * Math.sin(phase))
		}
		return out
	}
}

/**
 * Random 4FSK at `offsetHz`, 4800 symbols/s at ±2 and ±6 kHz deviation: a flat top about 20 kHz wide
 * at -20 dB (a wideband data signal within one 25 kHz channel). Symbols follow the absolute sample,
 * so every hop hears the same data.
 */
function fmData(
	offsetHz: number,
	amp: number,
): (n: number, startSample: number) => Uint8Array {
	const LEVELS = [-6_000, -2_000, 2_000, 6_000]
	const SYMBOL = FS / 4_800
	let phase = 0
	return (n, startSample) => {
		const out = new Uint8Array(2 * n)
		for (let i = 0; i < n; i++) {
			const symbol = Math.floor((startSample + i) / SYMBOL)
			// A hashed seed per symbol (Knuth's multiplier) and one draw discarded: nearby seeds of
			// xorshift start alike.
			const r = rng(Math.imul(symbol + 1, 2_654_435_761) >>> 0)
			r()
			const dev = LEVELS[Math.floor(r() * 4)]!
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
			if (e.kind === "voice") s = fmVoice(offsetHz, amp, e.pauses, e.speech)
			else if (e.kind === "data") s = fmData(offsetHz, amp)
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

/** A finalized WAV: its length, when it first showed, and its discovery's frequency if still known. */
export interface WavLog {
	seconds: number
	seenAtMs: number
	hz: number | null
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
	/** Called before each chunk with the world's time and the tuned centre (a test's own clock). */
	onChunk?: (atMs: number, centreHz: number) => void
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
	let chunksFed = 0
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
	const wavs = new Map<string, WavLog>()
	/** Notes each finalized WAV when it first shows, while its discovery is still in the store. */
	const scanWavs = (): void => {
		const root = join(dir, "recordings", "analog")
		let discoveries: string[]
		try {
			discoveries = readdirSync(root)
		} catch {
			return
		}
		for (const d of discoveries)
			for (const f of readdirSync(join(root, d))) {
				if (!f.endsWith(".wav") || wavs.has(f)) continue
				const found = service
					.listDiscoveries({})
					.items.find(item => item.id === d)
				wavs.set(f, {
					seconds: (statSync(join(root, d, f)).size - 44) / 2 / 8000,
					seenAtMs: clock() - T0,
					hz: found?.frequencyHz ?? null,
				})
			}
	}
	return {
		service,
		tuner,
		fanout,
		dir,
		visits,
		tracks,
		holds,
		wavs,
		scanWavs,
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
				opts.onChunk?.(clock() - T0, tunedHz())
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
				if (++chunksFed % WAV_SCAN_CHUNKS === 0) scanWavs()
			}
		},
		async stop(): Promise<void> {
			await service.stop()
			await rm(dir, { recursive: true, force: true })
		},
	}
}

/** xorshift32 (seed 0 → 1), so a scene is the same on every run. */
function rng(seed: number): () => number {
	let s = seed >>> 0 || 1
	return () => {
		s ^= s << 13
		s >>>= 0
		s ^= s >>> 17
		s ^= s << 5
		s >>>= 0
		return s / 2 ** 32
	}
}

const between = (r: () => number, [a, b]: readonly [number, number]): number =>
	Math.round(a + r() * (b - a))

/** Pauses between phrases of the speech in `span`: every `everyMs`, each `pauseMs` long. */
export function phrasePauses(
	span: Span,
	opts: {
		seed: number
		everyMs: readonly [number, number]
		pauseMs: readonly [number, number]
	},
): Span[] {
	const r = rng(opts.seed)
	const out: Span[] = []
	let t = span.fromMs + between(r, opts.everyMs)
	while (t < span.toMs) {
		const toMs = t + between(r, opts.pauseMs)
		if (toMs >= span.toMs) break
		out.push({ fromMs: t, toMs })
		t = toMs + between(r, opts.everyMs)
	}
	return out
}

export interface QsoOptions {
	hz: number
	fromMs: number
	toMs: number
	seed: number
	/** One over's speech. */
	overMs: readonly [number, number]
	/** From an over's last word to the next over's first. */
	replyMs: readonly [number, number]
	/**
	 * A repeater's hang after each over, its carrier on air without speech; a reply inside the hang
	 * keeps one carrier across the turnaround. Absent (simplex): the carrier ends with the over.
	 */
	hangMs?: number
	/** Pauses between phrases inside each over (phrasePauses). */
	phrases?: {
		everyMs: readonly [number, number]
		pauseMs: readonly [number, number]
	}
	amp?: number
}

/** A QSO as emitters and its overs (each over's speech, the transmissions a scene scores). */
export function qso(opts: QsoOptions): { emitters: Emitter[]; overs: Span[] } {
	const r = rng(opts.seed)
	const overs: Span[] = []
	const emitters: Emitter[] = []
	const hang = opts.hangMs ?? 0
	let carrier: { fromMs: number; pauses: Span[] } | null = null
	const pushCarrier = (toMs: number): void => {
		if (carrier === null) return
		emitters.push({
			hz: opts.hz,
			kind: "voice",
			fromMs: carrier.fromMs,
			toMs,
			pauses: carrier.pauses,
			...(opts.amp === undefined ? {} : { amp: opts.amp }),
		})
		carrier = null
	}
	let t = opts.fromMs
	while (t < opts.toMs) {
		const end = Math.min(opts.toMs, t + between(r, opts.overMs))
		overs.push({ fromMs: t, toMs: end })
		carrier ??= { fromMs: t, pauses: [] }
		if (opts.phrases !== undefined)
			carrier.pauses.push(
				...phrasePauses(
					{ fromMs: t, toMs: end },
					{ seed: between(r, [1, 1_000_000]), ...opts.phrases },
				),
			)
		const next = end + between(r, opts.replyMs)
		if (next - end <= hang && next < opts.toMs)
			carrier.pauses.push({ fromMs: end, toMs: next })
		else {
			if (hang > 0) carrier.pauses.push({ fromMs: end, toMs: end + hang })
			pushCarrier(end + hang)
		}
		t = next
	}
	pushCarrier(opts.toMs + hang)
	return { emitters, overs }
}

/** `count` IDs of `idMs` on `hz`, one every `everyMs` from `fromMs`. */
export function ids(opts: {
	hz: number
	fromMs: number
	everyMs: number
	count: number
	idMs?: number
	amp?: number
	pauses?: (span: Span) => Span[]
}): Emitter[] {
	const idMs = opts.idMs ?? 28_000
	return Array.from({ length: opts.count }, (_, i) => {
		const span = {
			fromMs: opts.fromMs + i * opts.everyMs,
			toMs: opts.fromMs + i * opts.everyMs + idMs,
		}
		return {
			hz: opts.hz,
			kind: "voice" as const,
			...span,
			...(opts.amp === undefined ? {} : { amp: opts.amp }),
			...(opts.pauses ? { pauses: opts.pauses(span) } : {}),
		}
	})
}

export interface SceneConfig {
	/** Where the source starts tuned. */
	centreHz: number
	/** Ranges of the job; a burst or a non-burst gate is chosen by `protocols`. */
	ranges: readonly { startHz: number; endHz: number; protocols?: string[] }[]
	durationMs: number
	/** Settle of a hop, ms. */
	settleMs?: number
	/** Synthetic signals (noise under them). Ignored when `iqSource` is given. */
	emitters?: readonly Emitter[]
	/** Where the IQ comes from instead: a scratch script may feed a capture from outside the repo. */
	iqSource?: World
	/** The transmissions the report scores, by frequency and time. */
	targets: readonly SceneTarget[]
	/** More fields of the job's spec (`hold`, `record`, `revisit`, `dwellMs`...). */
	job?: Record<string, unknown>
	patch?: (s: ScannerSettings) => void
	logger?: Logger
	/** Called before each chunk with the world's time and the tuned centre (qualificationWorld). */
	onChunk?: (atMs: number, centreHz: number) => void
	/** Called once the world is built, before the service starts (a test's own probes). */
	onWorld?: (w: ReturnType<typeof qualificationWorld>) => void
}

export interface SceneTarget extends Span {
	hz: number
	label?: string
}

/** A hop stayed on past a coarse visit. */
export interface SceneHold {
	hopIndex: number
	atMs: number
	/** Tune to tune, the settle left out. */
	ms: number
}

export interface TargetReport extends SceneTarget {
	hopIndex: number | null
	/** Visits of its hop that listened while it was on air. */
	landings: number
	/** Landings that heard at most SHORT_LANDING_MS with over LEFT_ON_AIR_MS of it left. */
	shortLandings: number
	/** Ms the sweep listened to its hop while it was on air. */
	heardMs: number
	/** Longest listen to it in one visit. */
	longestHeldMs: number
	/** Seconds of each WAV attributed to it (WavLog, the longest overlap in time on its frequency). */
	wavSeconds: number[]
}

export interface SceneReport {
	hops: number[]
	targets: TargetReport[]
	holds: SceneHold[]
	wavSeconds: number[]
	/** WAVs no target's frequency and time matched. */
	unattributedWavSeconds: number[]
	/** Every finalized WAV, with its discovery's frequency when that discovery is in the store. */
	wavFiles: WavLog[]
	/** The recorder's recent decisions at the scene's end (ScannerStatus.recorder.recent). */
	decisions: { code: string; receipt?: unknown }[]
	/** Per hop: the median and the longest time between two starts of a visit. */
	period: { medianMs: number | null; longestMs: number | null }[]
	/**
	 * Holds past a watch (LONG_HOLD_MS) with some other hop not visited since the hop's last such
	 * hold: the forced sweep unpaid. A shorter hold may be a follow within L, which owes no sweep.
	 */
	unpaidSweeps: number
}

/** A landing this short leaves before anyone could tell voice. */
const SHORT_LANDING_MS = 300
const LEFT_ON_AIR_MS = 2_000
/** Listening past this is a hold (a coarse visit with its qualification is under 1 s). */
const HOLD_MIN_MS = 1_000
/** Past a carrier watch and its gap: 8000 + 1050 ms. Only a voice hold or a decode runs longer. */
const LONG_HOLD_MS = 9_050
/** A file's end shows within this of the air: 1 s behind, the 2 s hang, the 1 s between looks. */
const FILE_LATE_MS = 5_000
/** Same frequency as a target: half a 25 kHz channel. */
const SAME_CHANNEL_HZ = 12_500

const overlapMs = (a: Span, b: Span): number =>
	Math.max(0, Math.min(a.toMs, b.toMs) - Math.max(a.fromMs, b.fromMs))

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]!
}

/** Runs a scene through the production composition and reports it (no assertion, no wall clock). */
export async function runScene(config: SceneConfig): Promise<SceneReport> {
	const settleMs = config.settleMs ?? 50
	const w = qualificationWorld({
		centreHz: config.centreHz,
		world: config.iqSource ?? synthWorld(config.emitters ?? []),
		patch: s => {
			s.sweep.settleMs.local = settleMs
			s.sweep.settleMs.network = settleMs
			config.patch?.(s)
		},
		...(config.logger ? { logger: config.logger } : {}),
		...(config.onChunk ? { onChunk: config.onChunk } : {}),
	})
	config.onWorld?.(w)
	try {
		await w.service.start()
		const job = await w.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			bandplans: [],
			ranges: config.ranges,
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
			...config.job,
		} as never)
		await w.advance(config.durationMs)
		w.scanWavs()
		const decisions = (w.service.status().recorder?.recent ?? []).map(d => ({
			code: d.code,
			...(d.receipt === undefined ? {} : { receipt: d.receipt }),
		}))
		return { ...sceneReport(w, config, job.plan.hops, settleMs), decisions }
	} finally {
		await w.stop()
	}
}

function sceneReport(
	w: ReturnType<typeof qualificationWorld>,
	config: SceneConfig,
	hops: readonly {
		centreHz: number
		covered: { startHz: number; endHz: number }
	}[],
	settleMs: number,
): Omit<SceneReport, "decisions"> {
	const hopOf = (hz: number): number | null => {
		const i = hops.findIndex(
			h => hz >= h.covered.startHz && hz <= h.covered.endHz,
		)
		return i < 0 ? null : i
	}
	const heard = w.visits.map(v => ({
		hopIndex: hops.findIndex(h => h.centreHz === v.centreHz),
		fromMs: v.atMs + settleMs,
		toMs: v.endMs ?? w.nowMs(),
		atMs: v.atMs,
	}))
	const wavs = [...w.wavs.values()]
	const owner = new Map<WavLog, SceneTarget>()
	for (const f of wavs) {
		const span = {
			fromMs: f.seenAtMs - FILE_LATE_MS - 1000 * f.seconds,
			toMs: f.seenAtMs,
		}
		let best: SceneTarget | undefined
		let most = 0
		for (const t of config.targets) {
			if (f.hz !== null && Math.abs(f.hz - t.hz) > SAME_CHANNEL_HZ) continue
			const ms = overlapMs(span, t)
			if (ms > most) {
				best = t
				most = ms
			}
		}
		if (best !== undefined) owner.set(f, best)
	}
	const targets = config.targets.map((t): TargetReport => {
		const hopIndex = hopOf(t.hz)
		const landed = heard.filter(
			v => v.hopIndex === hopIndex && overlapMs(v, t) > 0,
		)
		return {
			...t,
			hopIndex,
			landings: landed.length,
			shortLandings: landed.filter(
				v =>
					overlapMs(v, t) <= SHORT_LANDING_MS &&
					t.toMs - v.toMs > LEFT_ON_AIR_MS,
			).length,
			heardMs: landed.reduce((sum, v) => sum + overlapMs(v, t), 0),
			longestHeldMs: Math.max(0, ...landed.map(v => overlapMs(v, t))),
			wavSeconds: wavs.filter(f => owner.get(f) === t).map(f => f.seconds),
		}
	})
	const holds: SceneHold[] = heard
		.filter(v => v.toMs - v.fromMs > HOLD_MIN_MS)
		.map(v => ({ hopIndex: v.hopIndex, atMs: v.atMs, ms: v.toMs - v.fromMs }))
	let unpaidSweeps = 0
	hops.forEach((_, i) => {
		const mine = holds.filter(h => h.hopIndex === i && h.ms > LONG_HOLD_MS)
		for (let k = 1; k < mine.length; k++) {
			const seen = new Set(
				heard
					.filter(v => v.atMs > mine[k - 1]!.atMs && v.atMs < mine[k]!.atMs)
					.map(v => v.hopIndex),
			)
			if (hops.some((_h, other) => other !== i && !seen.has(other)))
				unpaidSweeps++
		}
	})
	const period = hops.map((_, i) => {
		const starts = heard.filter(v => v.hopIndex === i).map(v => v.atMs)
		const gaps = starts.slice(1).map((at, k) => at - starts[k]!)
		return {
			medianMs: median(gaps),
			longestMs: gaps.length > 0 ? Math.max(...gaps) : null,
		}
	})
	return {
		hops: hops.map(h => h.centreHz),
		targets,
		holds,
		wavSeconds: wavs.map(f => f.seconds),
		unattributedWavSeconds: wavs.filter(f => !owner.has(f)).map(f => f.seconds),
		wavFiles: wavs,
		period,
		unpaidSweeps,
	}
}
