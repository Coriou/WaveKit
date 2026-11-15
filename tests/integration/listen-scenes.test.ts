/**
 * Listen scenes, tier A (2026-11-15): one synthetic channel scene through the LiveDemodulator
 * (real stage 1, evidence gate, pre-roll and `/auto` router; fake csdr stages) with an injected
 * pacer clock and the router's FIFO trace, under every squelch column and listen mode.
 *
 * Scenes (channel time, ms). `mixed-1` as specified: noise 2 s, NFM voice 3 s, gap 0.5 s, DMR
 * 3 s, gap 0.3 s, NFM voice 0.6 s with CTCSS 88.5 Hz, POCSAG 1.2 s, carrier 2 s, noise 2 s. Its
 * gaps are shorter than the evidence latch hang and the transmission merge gap (both 1.5 s), and
 * its last three signals share one carrier, so it is one transmission. `mixed-1-spaced` puts the
 * same signals 2 s apart, so every signal is its own transmission and the design table applies
 * per row; the table and the numbers are asserted on it.
 *
 * IQ: 25 kHz complex float32, a carrier of amplitude 1 FM-modulated by the segment's deviation
 * (speech-shaped audio, the DMR call of scripts/fixtures/dmr-4fsk.mjs, POCSAG 2-FSK ±4.5 kHz at
 * 1200 baud from scripts/fixtures/pocsag-iq.mjs, or none for the carrier), plus channel noise
 * at 20 dB CNR. The fake back stage plays the clean discriminator of the transmitted deviation
 * (0.8 full scale = 5 kHz, the voice meter's reference) while a carrier is on and the
 * discriminator of the noise otherwise, and zeros for an IQ block stage 1 replaced (closed).
 *
 * Decoded voice comes from a voice-tap double with DV-harness timings: call start once the
 * second Voice LC header is decoded (340 ms after the DMR start), then three 20 ms frames at the
 * end of every 60 ms slot-1 burst, the first at 460 ms, and the call end at the DMR end.
 */
import type * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import type {
	AnalogTransmissionEventData,
	LiveAudioAutoRoute,
} from "@wavekit/api-types"
import { dmrFrequency } from "../../scripts/fixtures/dmr-4fsk.mjs"
import { pocsagBits } from "../../scripts/fixtures/pocsag-iq.mjs"
import { LiveDemodConfigSchema } from "../../src/config.js"
import { wireAnalogTransmissions } from "../../src/core/analog-transmission.js"
import { AUTO_ROUTE_STREAM } from "../../src/core/auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceCoverage,
	VoiceCoveragePort,
	VoiceTap,
	VoiceTapCall,
	VoiceTapSource,
} from "../../src/core/auto-listen/contract.js"
import type { AutoRouteTrace } from "../../src/core/auto-listen/inputs.js"
import type { AutoListenRouter } from "../../src/core/auto-listen/router.js"
import { LiveDemodulator } from "../../src/core/live-demodulator.js"
import { createLogger } from "../../src/utils/logger.js"
import {
	ClientTransport,
	FakeProcess,
	ManualClock,
	createFakeFanout,
	createFakeSourceManager,
	findFreePort,
} from "../unit/core/live-demodulator-continuity-fakes.js"
import { FastChannelNoise } from "../unit/core/fm-synth.js"
import {
	ctcssMix,
	mix,
	voiceLike,
	whiteNoise,
} from "../unit/core/evidence-squelch/synthetic.js"

const RATE = 25_000
const BLOCK_MS = 10
/** 25 000 × 10 / 1 000 = 250 samples per 10 ms block (one stage-1 block). */
const BLOCK = (RATE * BLOCK_MS) / 1000
/** 0.8 full scale = 5 kHz (the voice meter's reference): 6 250 Hz per full-scale unit. */
const HZ_PER_UNIT = 5_000 / 0.8
/** 20 dB CNR in 12.5 kHz: complex noise variance 25 000 / (12 500 × 100) = 0.02. */
const NOISE_SIGMA = Math.sqrt(RATE / (12_500 * 10 ** (20 / 10)))
/** -60 dBFS on s16: 32 767 × 10^(-60/20) = 32.77. */
const MINUS_60_DBFS = 32_767 * 10 ** (-60 / 20)
/** 48 output samples per ms. */
const OUT_PER_MS = 48
/** Voice-tap double timings (ms after the DMR start), see the header. */
const DV_CALL_START_MS = 340
const DV_FIRST_FRAME_MS = 460
const DV_BURST_MS = 60

type Kind = "noise" | "voice" | "toned" | "dmr" | "pager" | "carrier"

interface Segment {
	kind: Kind
	from: number
	to: number
}

/** Segments laid end to end from 0 ms: [kind, duration ms]. */
function layout(parts: ReadonlyArray<readonly [Kind, number]>): Segment[] {
	const out: Segment[] = []
	let at = 0
	for (const [kind, ms] of parts) {
		out.push({ kind, from: at, to: at + ms })
		at += ms
	}
	return out
}

type SceneName = "mixed-1" | "mixed-1-spaced"

const LAYOUTS: Record<SceneName, Segment[]> = {
	// As specified: the toned over, the pager and the carrier on one continuous carrier.
	"mixed-1": layout([
		["noise", 2000],
		["voice", 3000],
		["noise", 500],
		["dmr", 3000],
		["noise", 300],
		["toned", 600],
		["pager", 1200],
		["carrier", 2000],
		["noise", 2000],
	]),
	// The same signals 2 s apart: past the evidence latch hang and the transmission merge gap
	// (both 1.5 s), so every signal is its own transmission and the table applies per row.
	"mixed-1-spaced": layout([
		["noise", 2000],
		["voice", 3000],
		["noise", 2000],
		["dmr", 3000],
		["noise", 2000],
		["toned", 600],
		["noise", 2000],
		["pager", 1200],
		["noise", 2000],
		["carrier", 2000],
		["noise", 2000],
	]),
}

interface Scene {
	name: SceneName
	segments: Segment[]
	blocks: number
	dmr: Segment
	iq: Buffer[]
	pcm: Buffer[]
}

function only(segments: Segment[], kind: Kind): Segment {
	const found = segments.find(s => s.kind === kind)
	if (found === undefined) throw new Error(`no ${kind}`)
	return found
}

/** The scene's IQ and clean PCM, one buffer per 10 ms block (deterministic). */
function buildScene(name: SceneName): Scene {
	const SCENE = LAYOUTS[name]
	const SCENE_BLOCKS = (SCENE.at(-1)?.to ?? 0) / BLOCK_MS
	const n = SCENE_BLOCKS * BLOCK
	const freq = new Float64Array(n)
	const on = new Uint8Array(n)
	const residual = new Float32Array(n)
	const put = (seg: Segment, hz: ArrayLike<number>) => {
		const start = (seg.from * RATE) / 1000
		const end = (seg.to * RATE) / 1000
		for (let i = start; i < end; i++) {
			freq[i] = hz[i - start] ?? 0
			on[i] = 1
		}
	}
	const scaled = (pcm: Float32Array) => Array.from(pcm, v => v * HZ_PER_UNIT)
	for (const seg of SCENE) {
		const seconds = (seg.to - seg.from) / 1000
		if (seg.kind === "voice")
			put(seg, scaled(voiceLike({ rate: RATE, seconds, seed: 23 })))
		else if (seg.kind === "toned")
			put(
				seg,
				scaled(
					mix(
						voiceLike({ rate: RATE, seconds, seed: 21 }),
						ctcssMix({ rate: RATE, seconds, hz: 88.5 }),
					),
				),
			)
		else if (seg.kind === "dmr")
			put(
				seg,
				dmrFrequency(
					{ talkgroup: 9, source: 2_000_001, superframes: 7 },
					{ rateHz: RATE },
				),
			)
		else if (seg.kind === "pager") {
			const bits = pocsagBits({ address: 1_234_567, message: "12345" })
			const hz: number[] = []
			for (let i = 0; i < seconds * RATE; i++) {
				const bit = bits[Math.floor((i * 1200) / RATE) % bits.length] ?? 0
				hz.push(bit === 1 ? -4_500 : 4_500)
			}
			put(seg, hz)
		} else if (seg.kind === "carrier") {
			put(seg, new Float64Array(seconds * RATE))
			const start = (seg.from * RATE) / 1000
			residual.set(
				whiteNoise({ rate: RATE, seconds, seed: 9, level: 0.003 }),
				start,
			)
		}
	}
	const noise = new FastChannelNoise(RATE, 12_500, 0x5ce7e)
	const scratch = new Float32Array(BLOCK * 2)
	const iq: Buffer[] = []
	const pcm: Buffer[] = []
	let phase = 0
	let prevI = 0
	let prevQ = 0
	for (let b = 0; b < SCENE_BLOCKS; b++) {
		noise.fill(scratch)
		const iqBlock = Buffer.alloc(BLOCK * 8)
		const pcmBlock = Buffer.alloc(BLOCK * 2)
		for (let s = 0; s < BLOCK; s++) {
			const k = b * BLOCK + s
			// A 300 Hz carrier offset, inside the channel.
			phase += (2 * Math.PI * (300 + (freq[k] ?? 0))) / RATE
			if (phase > Math.PI) phase -= 2 * Math.PI
			const carrier = on[k] === 1 ? 1 : 0
			const i = carrier * Math.cos(phase) + NOISE_SIGMA * (scratch[2 * s] ?? 0)
			const q =
				carrier * Math.sin(phase) + NOISE_SIGMA * (scratch[2 * s + 1] ?? 0)
			iqBlock.writeFloatLE(i, s * 8)
			iqBlock.writeFloatLE(q, s * 8 + 4)
			let v: number
			if (carrier === 1) v = (freq[k] ?? 0) / HZ_PER_UNIT + (residual[k] ?? 0)
			else {
				// Discriminator of the noise: angle(x[n]·conj(x[n-1])) in Hz.
				const dPhi = Math.atan2(q * prevI - i * prevQ, i * prevI + q * prevQ)
				v = (dPhi * RATE) / (2 * Math.PI) / HZ_PER_UNIT
			}
			prevI = i
			prevQ = q
			const s16 = Math.round(Math.max(-1, Math.min(1, v)) * 32_767)
			pcmBlock.writeInt16LE(s16, s * 2)
		}
		iq.push(iqBlock)
		pcm.push(pcmBlock)
	}
	return {
		name,
		segments: SCENE,
		blocks: SCENE_BLOCKS,
		dmr: only(SCENE, "dmr"),
		iq,
		pcm,
	}
}

/** Mean |z|² of complex float32 IQ (0 for an empty buffer). */
function meanPower(iqBytes: Buffer): number {
	const n = Math.floor(iqBytes.length / 8)
	if (n === 0) return 0
	let sum = 0
	for (let k = 0; k < n; k++) {
		const i = iqBytes.readFloatLE(k * 8)
		const q = iqBytes.readFloatLE(k * 8 + 4)
		sum += i * i + q * q
	}
	return sum / n
}

const sceneCache = new Map<SceneName, Scene>()
function scene(name: SceneName): Scene {
	let hit = sceneCache.get(name)
	if (hit === undefined) {
		hit = buildScene(name)
		sceneCache.set(name, hit)
	}
	return hit
}

/** An injected `/auto` pacer clock: `tick` advances time and runs the pacer once. */
class RouteClock implements AutoRouteClock {
	t = 0
	private fn: (() => void) | null = null
	now(): number {
		return this.t
	}
	setInterval(fn: () => void): unknown {
		this.fn = fn
		return 1
	}
	clearInterval(): void {
		this.fn = null
	}
	tick(ms: number): void {
		this.t += ms
		this.fn?.()
	}
}

/** Voice taps and coverage of a digital voice service with one DMR decoder ("dmr-1"). */
class VoiceDouble implements VoiceTapSource, VoiceCoveragePort {
	readonly voiceSampleRate = 8_000
	readonly generation = 1
	tap: VoiceTap | null = null
	constructor(
		/** False: the decoder does not cover the tuned channel (and decodes nothing). */
		readonly covering: boolean,
	) {}
	addVoiceTap(tap: VoiceTap): () => void {
		this.tap = tap
		return () => {
			if (this.tap === tap) this.tap = null
		}
	}
	voiceDecoderIds(): readonly string[] {
		return ["dmr-1"]
	}
	covers(): VoiceCoverage {
		return this.covering ? "yes" : "no"
	}
}

/** The double's events of the DMR over, by channel time (ms). */
function dvSchedule(
	DMR: Segment,
	encrypted: boolean,
): Array<{ at: number; run: (tap: VoiceTap) => void }> {
	const call = (active: boolean): VoiceTapCall => ({
		callId: "dmr-call-1",
		active,
		encrypted,
		protocol: "DMR",
		slot: 1,
	})
	// dsd-fme mutes encrypted voice: the frames carry zeros.
	const speech = encrypted
		? new Float32Array(3 * 8_000)
		: voiceLike({ rate: 8_000, seconds: 3, seed: 31, level: 0.5 })
	const events: Array<{ at: number; run: (tap: VoiceTap) => void }> = []
	events.push({
		at: DMR.from + DV_CALL_START_MS,
		run: tap => tap.call("dmr-1", call(true)),
	})
	// Seven superframes of six bursts from 400 ms; bursts ending inside the over carry voice.
	let frame = 0
	for (
		let end = DMR.from + DV_FIRST_FRAME_MS;
		end <= DMR.to - DV_BURST_MS + 20;
		end += DV_BURST_MS
	) {
		const frames: Buffer[] = []
		for (let f = 0; f < 3; f++, frame++) {
			const buf = Buffer.alloc(320)
			for (let s = 0; s < 160; s++) {
				const v = speech[frame * 160 + s] ?? 0
				buf.writeInt16LE(Math.round(v * 32_767), s * 2)
			}
			frames.push(buf)
		}
		events.push({
			at: end,
			run: tap => {
				for (const buf of frames) tap.frame("dmr-1", buf, call(true))
			},
		})
	}
	events.push({ at: DMR.to, run: tap => tap.call("dmr-1", call(false)) })
	return events
}

interface Column {
	name: string
	config: Record<string, unknown>
	/** The double covers the channel (default true). */
	covering?: boolean
	encrypted?: boolean
	/** A runtime reconfigure at this channel time (ms), awaited before that block. */
	reconfigure?: { at: number; updates: Record<string, unknown> }
}

interface SegStats {
	seg: Segment
	analog: number
	analogLoud: number
	voice: number
	firstAnalogOut: number | null
	firstAnalogWrite: number | null
	firstVoiceOut: number | null
	/** Source changes among the output blocks carrying this segment's audio. */
	switches: number
}

interface RunResult {
	stats: SegStats[]
	droppedMs: number
	transmissions: number
	routeStatus: LiveAudioAutoRoute | undefined
	reasons: Set<string>
	modes: Set<string>
	/** Stage-1 squelch edges (opens and closes). */
	edges: number
	/** Fake stages spawned (2 per pipeline start). */
	spawned: number
	/** The listen mode in force at each block. */
	modeAt: string[]
}

type Internals = {
	handleAudioData(chunk: Buffer): void
	autoRoute: AutoListenRouter
	run: {
		front: FakeProcess
		back: FakeProcess
		stream: { rate: number; format: string }
		evidence?: { active: boolean; preRoll: { delaySamples: number } } | null
	} | null
}

let disposers: Array<() => Promise<void>> = []

/** Runs the scene through one LiveDemodulator configured as `column`. */
async function runScene(column: Column, name: SceneName): Promise<RunResult> {
	const { iq, pcm, blocks: SCENE_BLOCKS, segments: SCENE, dmr } = scene(name)
	const clock = new RouteClock()
	/** Per source: FIFO position of each write and the channel time (ms) of its first sample. */
	const writes = new Map<string, { from: number[]; at: number[] }>()
	/** Channel time (ms) of the analog span being pushed (see the pushAnalog wrapper). */
	let analogAt = Number.NaN
	const reads: Array<{
		source: string
		from: number
		count: number
		block: number
	}> = []
	const blocks: Buffer[] = []
	const blockAt: number[] = []
	const trace = (t: Readonly<AutoRouteTrace>) => {
		if (t.kind === "write") {
			let w = writes.get(t.source)
			if (w === undefined) {
				w = { from: [], at: [] }
				writes.set(t.source, w)
			}
			w.from.push(t.from)
			w.at.push(t.source === "analog" ? analogAt : clock.t)
		} else if (t.kind === "read")
			reads.push({
				source: t.source,
				from: t.from,
				count: t.count,
				block: blocks.length,
			})
	}
	const processes: FakeProcess[] = []
	const realKill = process.kill.bind(process)
	process.kill = ((pid: number, signal?: string | number): true => {
		const proc = processes.find(p => p.pid === Math.abs(pid))
		if (!proc) {
			const err = new Error("ESRCH") as NodeJS.ErrnoException
			err.code = "ESRCH"
			throw err
		}
		proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
		return true
	}) as typeof process.kill
	const config = LiveDemodConfigSchema.parse({
		engine: "csdr",
		enabled: true,
		sourceId: "rtl-pi",
		httpPort: await findFreePort(),
		modulation: "nfm",
		...column.config,
	})
	const demod = new LiveDemodulator(
		createLogger({ level: "fatal" }),
		createFakeSourceManager() as never,
		createFakeFanout() as never,
		config,
		{
			httpHost: "127.0.0.1",
			clock: new ManualClock(),
			restartBaseDelayMs: 1,
			autoRouteClock: clock,
			autoRouteTrace: trace,
			spawnStage: (command: string) => {
				const proc = new FakeProcess(command)
				processes.push(proc)
				return proc as unknown as ChildProcess
			},
		},
	)
	disposers.push(async () => {
		try {
			await demod.stop()
		} finally {
			process.kill = realKill
		}
	})
	const internals = demod as unknown as Internals
	const t0Wall = Date.parse("2026-11-15T10:00:00.000Z")
	let transmissions = 0
	const tracker = wireAnalogTransmissions({
		source: demod,
		frequencyAt: () => null,
		broadcast: (event: AnalogTransmissionEventData) => {
			if (event.state === "open") transmissions++
		},
		sink: () => null,
		now: () => t0Wall + clock.t,
	})
	await demod.start()
	const voice = new VoiceDouble(column.covering ?? true)
	demod.attachAutoRouteVoice(voice, voice)
	const router = internals.autoRoute
	const registry = router.registry
	const write = registry.write.bind(registry)
	registry.write = (chunk: Buffer) => {
		blocks.push(chunk)
		blockAt.push(clock.t)
		write(chunk)
	}
	registry.register(
		new ClientTransport() as unknown as http.ServerResponse,
		"auto",
		AUTO_ROUTE_STREAM,
	)
	expect(router.wanted).toBe(true)
	const run = internals.run
	if (run === null) throw new Error("no run")
	expect(run.stream).toEqual({ rate: RATE, format: "s16le" })
	// Channel time of pushed analog: the pre-roll delays the client bytes by `delaySamples`, so
	// byte k of the PCM block b pushed now is channel sample b·250 + k/2 − delay.
	let block = 0
	const pushAnalog = router.pushAnalog.bind(router)
	router.pushAnalog = (chunk, start, end, audible, stream) => {
		const delay = run.evidence?.active ? run.evidence.preRoll.delaySamples : 0
		analogAt = ((block * BLOCK + start / 2 - delay) * 1000) / RATE
		pushAnalog(chunk, start, end, audible, stream)
	}
	let backBytes: Buffer[] = []
	run.back.stdin.on("data", (chunk: Buffer) => backBytes.push(chunk))
	const schedule =
		column.covering === false ? [] : dvSchedule(dmr, column.encrypted === true)
	const reasons = new Set<string>()
	const modes = new Set<string>()
	const modeAt: string[] = []
	let edges = 0
	demod.on("squelch-changed", () => {
		edges++
	})
	let next = 0
	for (let b = 0; b < SCENE_BLOCKS; b++) {
		block = b
		const at = b * BLOCK_MS
		if (column.reconfigure?.at === at)
			await demod.reconfigure(column.reconfigure.updates)
		const iqBlock = iq[b] as Buffer
		await new Promise<void>(resolve =>
			run.front.stdout.write(Buffer.from(iqBlock), () => resolve()),
		)
		const passed = Buffer.concat(backBytes)
		backBytes = []
		// The fake back stage: zeros for a block stage 1 replaced (its -80 dBFS hold vector), the
		// scene's PCM otherwise (stage 1 rotates passed IQ by a constant, which FM ignores).
		const closed = meanPower(passed) < 1e-6
		internals.handleAudioData(
			closed ? Buffer.alloc(BLOCK * 2) : Buffer.from(pcm[b] as Buffer),
		)
		for (; next < schedule.length; next++) {
			const event = schedule[next]
			if (event === undefined || event.at >= at + BLOCK_MS) break
			if (voice.tap !== null) event.run(voice.tap)
		}
		clock.tick(BLOCK_MS)
		const level = router.level()
		if (level.reason !== undefined) reasons.add(level.reason)
		modes.add(router.listenMode)
		modeAt.push(router.listenMode)
	}
	tracker.stop()
	const routeStatus = demod.getStatus().autoRoute

	// Attribute every played sample to its segment by the time it was written (channel time).
	const writeAt = (source: string, pos: number): number => {
		const w = writes.get(source)
		if (w === undefined) return Number.NaN
		let lo = 0
		let hi = w.from.length - 1
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1
			if ((w.from[mid] ?? 0) <= pos) lo = mid
			else hi = mid - 1
		}
		const from = w.from[lo] ?? 0
		const at = w.at[lo] ?? Number.NaN
		// Analog: 48 FIFO samples per ms of channel time inside one write.
		return source === "analog" ? at + (pos - from) / OUT_PER_MS : at
	}
	const stats: SegStats[] = SCENE.map(seg => ({
		seg,
		analog: 0,
		analogLoud: 0,
		voice: 0,
		firstAnalogOut: null,
		firstAnalogWrite: null,
		firstVoiceOut: null,
		switches: 0,
	}))
	const lastSource = new Map<SegStats, string>()
	const segOf = (ms: number, source: string): SegStats | undefined => {
		// Decoded voice belongs to the DMR over (its tail flush lands up to the 300 ms hold after).
		if (source !== "analog") return stats.find(s => s.seg.kind === "dmr")
		return stats.find(s => ms >= s.seg.from && ms < s.seg.to)
	}
	for (const r of reads) {
		const block = blocks[r.block]
		const outAt = blockAt[r.block] ?? Number.NaN
		for (let k = 0; k < r.count; k++) {
			const ms = writeAt(r.source, r.from + k)
			const st = segOf(ms, r.source)
			if (st === undefined) continue
			const value = block?.readInt16LE(2 * k) ?? 0
			if (r.source === "analog") {
				st.analog++
				if (Math.abs(value) > MINUS_60_DBFS) st.analogLoud++
				st.firstAnalogOut ??= outAt
				st.firstAnalogWrite ??= ms
			} else {
				st.voice++
				st.firstVoiceOut ??= outAt
			}
			const prev = lastSource.get(st)
			if (prev !== undefined && prev !== r.source) st.switches++
			lastSource.set(st, r.source)
		}
	}
	const result: RunResult = {
		stats,
		droppedMs: router.droppedSamples / OUT_PER_MS,
		transmissions,
		routeStatus,
		reasons,
		modes,
		edges,
		spawned: processes.length,
		modeAt,
	}
	await demod.stop()
	process.kill = realKill
	disposers = disposers.slice(0, -1)
	return result
}

function seg(result: RunResult, kind: Kind, nth = 0): SegStats {
	const found = result.stats.filter(s => s.seg.kind === kind)[nth]
	if (found === undefined) throw new Error(`no ${kind} segment`)
	return found
}

/** Output samples a segment spans at 48 kHz. */
function spanSamples(s: Segment): number {
	return (s.to - s.from) * OUT_PER_MS
}

type Verdict = "silence" | "plays" | "raw" | "decoded"

/** What a column did with one segment, as the table says it. */
function verdict(st: SegStats): Verdict {
	if (st.voice > 0 && st.analogLoud === 0) return "decoded"
	if (st.analogLoud === 0 && st.voice === 0) return "silence"
	// Analog played: "raw" for data, "plays" for the rest (the table's words).
	return st.seg.kind === "dmr" || st.seg.kind === "pager" ? "raw" : "plays"
}

const COLUMNS: Record<string, Column> = {
	autoVoiceOnly: { name: "Auto + Voice only", config: { squelchMode: "auto" } },
	auto: { name: "Auto", config: { squelchMode: "auto", voiceOnly: false } },
	manual: {
		name: "Manual (above line)",
		// Channel noise at 20 dB CNR measures about -18.5 dBFS, a carrier 0 dBFS: the line between.
		config: { squelchMode: "manual", squelch: -8 },
	},
	open: { name: "Open", config: { squelchMode: "open" } },
}

const results = new Map<string, RunResult>()
/** One run per scene and column, shared by the tests that read it. */
async function cached(
	key: string,
	column: Column,
	name: SceneName = "mixed-1-spaced",
): Promise<RunResult> {
	const hit = results.get(`${name}/${key}`)
	if (hit !== undefined) return hit
	const result = await runScene(column, name)
	results.set(`${name}/${key}`, result)
	return result
}

afterEach(async () => {
	for (const dispose of disposers) await dispose().catch(() => undefined)
	disposers = []
})

/**
 * The router's resampler edge: the first 32 output samples at 48 kHz (0.67 ms) of an over that
 * follows silence are discarded with the silent span (measured identically in every column but
 * Open, where the noise before the over is audible too). Bound for the head-cut checks.
 */
const ROUTER_EDGE_SAMPLES = 32
/** 32 / 48 = 0.667 ms, plus 1 µs for the floating-point channel-time arithmetic. */
const ROUTER_EDGE_MS = ROUTER_EDGE_SAMPLES / OUT_PER_MS + 0.001

function ttaMs(st: SegStats): number {
	return st.firstAnalogOut === null
		? Number.POSITIVE_INFINITY
		: st.firstAnalogOut - st.seg.from
}

function headCutMs(st: SegStats): number {
	return st.firstAnalogWrite === null
		? Number.POSITIVE_INFINITY
		: st.firstAnalogWrite - st.seg.from
}

/** Decoded voice's time to audio after the double's first frame. */
function ttvMs(st: SegStats): number {
	return st.firstVoiceOut === null
		? Number.POSITIVE_INFINITY
		: st.firstVoiceOut - (st.seg.from + DV_FIRST_FRAME_MS)
}

/** Analog above -60 dBFS played from the segment, ms. */
function buzzMs(st: SegStats): number {
	return st.analogLoud / OUT_PER_MS
}

type Row =
	| "noise"
	| "carrier"
	| "voice"
	| "toned"
	| "pager"
	| "dmr"
	| "encrypted"
type ColumnKey = "autoVoiceOnly" | "auto" | "manual" | "open"

/** The design table (Listen, section D), per column; the toned over is the analog voice row too. */
const TABLE: Record<ColumnKey, Record<Row, Verdict>> = {
	autoVoiceOnly: {
		noise: "silence",
		carrier: "silence",
		voice: "plays",
		toned: "plays",
		pager: "silence",
		dmr: "decoded",
		encrypted: "silence",
	},
	auto: {
		noise: "silence",
		carrier: "plays",
		voice: "plays",
		toned: "plays",
		pager: "raw",
		dmr: "decoded",
		encrypted: "raw",
	},
	manual: {
		noise: "silence",
		carrier: "plays",
		voice: "plays",
		toned: "plays",
		pager: "raw",
		dmr: "decoded",
		encrypted: "raw",
	},
	open: {
		noise: "plays",
		carrier: "plays",
		voice: "plays",
		toned: "plays",
		pager: "raw",
		dmr: "raw",
		encrypted: "raw",
	},
}

/**
 * Cells the current code does not meet, with what it does (mixed-1-spaced, measured). Each is an
 * `it.todo` below, not a weakened assertion; they belong to later rounds.
 */
const PENDING: Partial<Record<`${ColumnKey}.${Row}`, string>> = {
	"autoVoiceOnly.toned":
		"the 0.6 s toned over is never latched: tone evidence needs 750 ms of audio (LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS) and the voice window 1 s, so it is silence, not plays",
	"auto.dmr":
		"pending the 200 ms takeover: analog buzz plays 1 960 ms (first frame 460 ms + the 1 500 ms preemption bound), then decoded, then the buzz queued during the call (raw, 2 switches, 20 ms dropped)",
	"manual.dmr":
		"pending the 200 ms takeover: as Auto with Voice only off (buzz 1 960 ms, then decoded, then the queued buzz)",
}

function rowStats(clear: RunResult, enc: RunResult, row: Row): SegStats {
	if (row === "encrypted") return seg(enc, "dmr")
	return seg(clear, row)
}

const COLUMN_KEYS: ColumnKey[] = ["autoVoiceOnly", "auto", "manual", "open"]

async function column(
	key: ColumnKey,
	name: SceneName = "mixed-1-spaced",
): Promise<{ clear: RunResult; enc: RunResult }> {
	const col = COLUMNS[key] as Column
	return {
		clear: await cached(key, col, name),
		enc: await cached(`${key}:enc`, { ...col, encrypted: true }, name),
	}
}

describe("listen scenes, tier A: mixed-1-spaced", () => {
	describe("the table", () => {
		for (const key of COLUMN_KEYS) {
			const name = (COLUMNS[key] as Column).name
			it(`${name}: every signal as the table says`, async () => {
				const { clear, enc } = await column(key)
				const rows = Object.keys(TABLE[key]) as Row[]
				for (const row of rows) {
					if (PENDING[`${key}.${row}`] !== undefined) continue
					expect({ row, verdict: verdict(rowStats(clear, enc, row)) }).toEqual({
						row,
						verdict: TABLE[key][row],
					})
				}
			}, 60_000)
			for (const row of Object.keys(TABLE[key]) as Row[]) {
				const pending = PENDING[`${key}.${row}`]
				if (pending !== undefined)
					it.todo(`${name}: ${row} ${TABLE[key][row]} (${pending})`)
			}
		}
	})

	describe("numbers", () => {
		it("time to audio: carrier squelch <= 150 ms (Auto, Manual), Voice only <= 1 300 ms", async () => {
			for (const key of ["auto", "manual"] as const) {
				const { clear } = await column(key)
				expect(ttaMs(seg(clear, "voice"))).toBeLessThanOrEqual(150)
				expect(ttaMs(seg(clear, "carrier"))).toBeLessThanOrEqual(150)
				expect(ttaMs(seg(clear, "pager"))).toBeLessThanOrEqual(150)
			}
			const { clear } = await column("autoVoiceOnly")
			const late = ttaMs(seg(clear, "voice"))
			// Measured 1 020 ms: the voice window (1 s) plus one 20 ms block.
			expect(late).toBeGreaterThan(150)
			expect(late).toBeLessThanOrEqual(1_300)
		}, 120_000)

		it("time to audio: decoded voice <= first frame + 300 ms (Auto + Voice only)", async () => {
			const { clear } = await column("autoVoiceOnly")
			// Measured 200 ms: the 200 ms start buffer.
			expect(ttvMs(seg(clear, "dmr"))).toBeLessThanOrEqual(300)
		}, 60_000)

		it.todo(
			"time to audio: decoded voice <= first frame + 300 ms with Voice only off (Auto, Manual): measured 1 500 ms, the preemption bound, until the 200 ms takeover round",
		)

		it("analog head cut: 0 ms beyond the router's resampler edge; overs play whole", async () => {
			for (const key of COLUMN_KEYS) {
				const { clear } = await column(key)
				const voice = seg(clear, "voice")
				expect(headCutMs(voice)).toBeLessThanOrEqual(ROUTER_EDGE_MS)
				expect(spanSamples(voice.seg) - voice.analog).toBeLessThanOrEqual(
					ROUTER_EDGE_SAMPLES,
				)
				if (key === "autoVoiceOnly") continue
				// The 0.6 s toned over plays whole (Auto + Voice only: pending above).
				const toned = seg(clear, "toned")
				expect(headCutMs(toned)).toBeLessThanOrEqual(ROUTER_EDGE_MS)
				expect(spanSamples(toned.seg) - toned.analog).toBeLessThanOrEqual(
					ROUTER_EDGE_SAMPLES,
				)
			}
		}, 120_000)

		it("autoRoute.droppedMs is 0 over the scene (Auto + Voice only, Open; encrypted in every column)", async () => {
			for (const key of COLUMN_KEYS) {
				const { clear, enc } = await column(key)
				expect(enc.droppedMs).toBe(0)
				expect(enc.routeStatus?.droppedMs).toBe(0)
				if (key === "auto" || key === "manual") continue
				expect(clear.droppedMs).toBe(0)
				expect(clear.routeStatus?.droppedMs).toBe(0)
			}
		}, 120_000)

		it.todo(
			"autoRoute.droppedMs 0 with Voice only off on a clear DMR over (Auto, Manual): measured 20 ms, analog's queue dropped at the 1.5 s preemption, until the takeover round",
		)

		it("one source per transmission: 0 mid-over switches (Auto + Voice only, Open; every analog over)", async () => {
			for (const key of COLUMN_KEYS) {
				const { clear, enc } = await column(key)
				for (const st of [...clear.stats, ...enc.stats]) {
					if (st.seg.kind === "dmr" && (key === "auto" || key === "manual"))
						continue
					expect({ kind: st.seg.kind, switches: st.switches }).toEqual({
						kind: st.seg.kind,
						switches: 0,
					})
				}
			}
		}, 120_000)

		it.todo(
			"0 mid-over switches on a clear DMR over with Voice only off (Auto, Manual): measured 2 (buzz, decoded, queued buzz) until the takeover and pending-buffer rounds",
		)

		it("buzz with Voice only on: 0 analog samples above -60 dBFS during the DMR over", async () => {
			const { clear, enc } = await column("autoVoiceOnly")
			expect(buzzMs(seg(clear, "dmr"))).toBe(0)
			expect(buzzMs(seg(enc, "dmr"))).toBe(0)
			// The same scene with Voice only off plays buzz (the pending item below): the measure
			// sees it.
			const { clear: off } = await column("auto")
			expect(buzzMs(seg(off, "dmr"))).toBeGreaterThan(400)
		}, 60_000)

		it.todo(
			"buzz with Voice only off <= 400 ms before a clear call (Auto, Manual): measured 1 960 ms before the preemption (2 973 ms with the queued buzz after the call), until the takeover round",
		)

		it("Open: transmission events and stage-1 edges equal Auto's on the same scene", async () => {
			const open = await column("open")
			const auto = await column("autoVoiceOnly")
			expect(open.clear.transmissions).toBe(5)
			expect(open.clear.transmissions).toBe(auto.clear.transmissions)
			expect(open.enc.transmissions).toBe(auto.enc.transmissions)
			expect(open.clear.edges).toBe(auto.clear.edges)
		}, 60_000)

		it("is deterministic: a second run measures the same", async () => {
			const again = await runScene(
				COLUMNS["autoVoiceOnly"] as Column,
				"mixed-1-spaced",
			)
			const { clear } = await column("autoVoiceOnly")
			expect(again.stats).toEqual(clear.stats)
			expect(again.droppedMs).toBe(clear.droppedMs)
		}, 60_000)
	})

	describe("listen mode (Auto + Voice only squelch)", () => {
		const base = { squelchMode: "auto" }

		it("analog: demodulated audio only, decoded voice never plays", async () => {
			const r = await cached("listen:analog", {
				name: "analog",
				config: { ...base, listenMode: "analog" },
			})
			expect(verdict(seg(r, "voice"))).toBe("plays")
			for (const kind of ["noise", "dmr", "pager", "carrier"] as const)
				expect({ kind, verdict: verdict(seg(r, kind)) }).toEqual({
					kind,
					verdict: "silence",
				})
			expect(seg(r, "dmr").voice).toBe(0)
			expect(r.modes).toEqual(new Set(["analog"]))
			expect(r.reasons.size).toBe(0)
			expect(r.droppedMs).toBe(0)
			expect(r.routeStatus?.listenMode).toBe("analog")
		}, 60_000)

		it("digital: decoded voice only, silence otherwise (never analog)", async () => {
			const r = await cached("listen:digital", {
				name: "digital",
				config: { ...base, listenMode: "digital" },
			})
			for (const st of r.stats) expect(st.analog).toBe(0)
			expect(verdict(seg(r, "dmr"))).toBe("decoded")
			expect(ttvMs(seg(r, "dmr"))).toBeLessThanOrEqual(300)
			expect(r.modes).toEqual(new Set(["digital"]))
			expect(r.reasons.size).toBe(0)
			expect(r.droppedMs).toBe(0)
		}, 60_000)

		it("digital with no decoder on the channel: silence throughout, reason no-decoder", async () => {
			const r = await cached("listen:digital:none", {
				name: "digital, no decoder",
				config: { ...base, listenMode: "digital" },
				covering: false,
			})
			for (const st of r.stats) {
				expect(st.analog).toBe(0)
				expect(st.voice).toBe(0)
			}
			expect(r.reasons).toEqual(new Set(["no-decoder"]))
			expect(r.routeStatus?.reason).toBe("no-decoder")
			expect(r.routeStatus?.listenMode).toBe("digital")
		}, 60_000)

		it("the open squelch forces analog over digital (reason squelch-open)", async () => {
			const r = await cached("listen:digital:open", {
				name: "digital, open squelch",
				config: { squelchMode: "open", listenMode: "digital" },
			})
			for (const kind of ["noise", "voice", "dmr", "pager", "carrier"] as const)
				expect(verdict(seg(r, kind))).not.toBe("silence")
			expect(seg(r, "dmr").voice).toBe(0)
			expect(r.modes).toEqual(new Set(["analog"]))
			expect(r.reasons).toEqual(new Set(["squelch-open"]))
			expect(r.routeStatus?.listenMode).toBe("analog")
		}, 60_000)

		it("a runtime change mid-over waits for the over's end: no restart, the over plays whole", async () => {
			const baseline = await column("autoVoiceOnly")
			// auto -> digital at 3.5 s, while voice A (2-5 s) is playing.
			const r = await cached("listen:switch", {
				name: "auto then digital",
				config: base,
				reconfigure: { at: 3_500, updates: { listenMode: "digital" } },
			})
			expect(r.spawned).toBe(2)
			const voice = seg(r, "voice")
			expect(voice.analog).toBe(seg(baseline.clear, "voice").analog)
			expect(voice.switches).toBe(0)
			// Still auto at the change; digital only after voice A released.
			expect(r.modeAt[3_500 / BLOCK_MS]).toBe("auto")
			const firstDigital = r.modeAt.indexOf("digital") * BLOCK_MS
			expect(firstDigital).toBeGreaterThanOrEqual(voice.seg.to)
			expect(firstDigital).toBeLessThan(seg(r, "dmr").seg.from)
			expect(verdict(seg(r, "dmr"))).toBe("decoded")
			expect(r.droppedMs).toBe(0)
		}, 60_000)

		it("open set mid analog over, then a DMR call: analog in force at once, nothing pending, nothing dropped", async () => {
			// Auto + Voice only, the squelch set to open at 3.5 s while voice A (2-5 s) plays. The open
			// squelch passes the noise too, so analog never releases afterwards.
			const r = await cached("listen:open-mid-over", {
				name: "auto then open",
				config: base,
				reconfigure: { at: 3_500, updates: { squelchMode: "open" } },
			})
			const voice = seg(r, "voice")
			expect(voice.switches).toBe(0)
			// Analog plays analog: the change needs no switch, so it is in force in that block.
			expect(r.modeAt[3_500 / BLOCK_MS - 1]).toBe("auto")
			expect(r.modeAt[3_500 / BLOCK_MS]).toBe("analog")
			expect(new Set(r.modeAt.slice(3_500 / BLOCK_MS))).toEqual(
				new Set(["analog"]),
			)
			expect(r.routeStatus?.listenMode).toBe("analog")
			expect(r.routeStatus?.pendingListenMode).toBeUndefined()
			expect(r.routeStatus?.reason).toBe("squelch-open")
			// The DMR call is heard raw from analog; decoded voice is never queued, so it never
			// ages out: nothing is counted dropped.
			const dmr = seg(r, "dmr")
			expect(dmr.voice).toBe(0)
			expect(verdict(dmr)).toBe("raw")
			expect(dmr.switches).toBe(0)
			expect(r.droppedMs).toBe(0)
			expect(r.routeStatus?.droppedMs).toBe(0)
		}, 60_000)
	})
})

describe("listen scenes, tier A: mixed-1 (as specified, 0.3-0.5 s gaps)", () => {
	it("Auto + Voice only: the first over plays late and whole; Open's events equal Auto's", async () => {
		const auto = await column("autoVoiceOnly", "mixed-1")
		const open = await column("open", "mixed-1")
		const voice = seg(auto.clear, "voice")
		expect(ttaMs(voice)).toBeLessThanOrEqual(1_300)
		expect(headCutMs(voice)).toBeLessThanOrEqual(ROUTER_EDGE_MS)
		expect(seg(auto.clear, "noise").analog).toBe(0)
		// Gaps under the 1.5 s merge gap: the whole scene is one transmission in both.
		expect(open.clear.transmissions).toBe(auto.clear.transmissions)
		expect(open.clear.edges).toBe(auto.clear.edges)
		for (const st of open.clear.stats) expect(verdict(st)).not.toBe("silence")
	}, 60_000)

	it.todo(
		"Auto + Voice only, DMR 0.5 s after a latched over: 0 buzz above -60 dBFS (measured: the 1.5 s evidence latch hang carries the voice latch over the gap, so the buzz plays and decoded preempts at 1 960 ms; the toned over, pager and carrier on one carrier then play as one latched transmission)",
	)
})
