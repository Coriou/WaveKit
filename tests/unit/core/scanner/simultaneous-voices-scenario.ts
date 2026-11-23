/**
 * Simultaneous traffic in one span, through the production scanner composition: the real
 * ScannerService (serviceHarness: in-process fake source and fanout, no network), the inline
 * spectrum engine, the real wideband analog recorder and evidence store, WAV files on disk.
 *
 * `modelled` (synthetic, standing in for a busy live span of walkie-talkie channels with digital
 * voice beside them): several narrow FM voices on different channels keyed one after another so
 * they overlap, an unmodulated analog carrier, and a 4FSK burst (a digital-voice-like signal).
 * Every signal is summed into one CU8 stream; frequencies are neutral offsets from a neutral
 * centre, no real channel or label.
 */
import { readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { FS, serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import type { WidebandAnalogRecorder } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { FskSource, NfmSource, wavDurationMs } from "./wideband-nfm-fixtures.js"

/** A neutral centre no band plan of the harness covers (the recorder shadows freely there). */
export const SCENARIO_CENTRE_HZ = 300_000_000
/** 25 ms of IQ per write, like a live source's chunking. */
export const SCENARIO_CHUNK = FS / 40
/** Per-signal amplitude: six signals sum to 0.72 of full scale, never clipping the CU8 range. */
const AMP = 0.12

export interface ScenarioVoice {
	/** Offset from the centre (Hz). */
	offsetHz: number
	/** Key-up and key-down, seconds from the start of the stream. */
	onS: number
	offS: number
}

export interface ScenarioPlan {
	voices: readonly ScenarioVoice[]
	/** An unmodulated carrier (no voice, no tone) over this window, or none. */
	carrier: ScenarioVoice | null
	/** A 4FSK burst (4800 Bd, ±648 / ±1944 Hz) over this window, or none. */
	fsk: ScenarioVoice | null
	/** Total stream length (s). */
	totalS: number
}

/**
 * The default plan: four FM voices 75 kHz or more apart, keyed 0.5 s apart for 6 s each (all four
 * on the air together from 2.5 to 7 s), a carrier and a 4FSK burst through the same window. The
 * first second is noise only (the startup epoch's settle window records nothing).
 */
export function defaultPlan(voices = 4): ScenarioPlan {
	const offsets = [-300_000, -187_500, -75_000, 100_000, 212_500, 325_000]
	return {
		voices: offsets.slice(0, voices).map((offsetHz, i) => ({
			offsetHz,
			onS: 1 + 0.5 * i,
			offS: 7 + 0.5 * i,
		})),
		carrier: { offsetHz: -412_500, onS: 1.2, offS: 7.5 },
		fsk: { offsetHz: 412_500, onS: 1.4, offS: 6.4 },
		totalS: 7 + 0.5 * voices + 4,
	}
}

/**
 * The plan's whole stream as CU8 chunks of SCENARIO_CHUNK pairs, precomputed so a measurement
 * of the pipeline does not count the synthesis. Each source is quantized on its own and the
 * sum re-centred: the quantization noise of six sources (±0.5 LSB each) is below the noise floor.
 */
export function synthesize(plan: ScenarioPlan): Uint8Array[] {
	type Gen = {
		next(n: number, on: boolean): Uint8Array
		onS: number
		offS: number
	}
	const gens: Gen[] = []
	plan.voices.forEach((v, i) => {
		const src = new NfmSource({
			fs: FS,
			offsetHz: v.offsetHz,
			amp: AMP,
			// Only the first source carries the receiver noise; the others add none.
			noiseSigma: i === 0 ? 0.02 : 0,
			syllables: true,
			seed: 11 + i,
		})
		gens.push({ next: (n, on) => src.next(n, on), onS: v.onS, offS: v.offS })
	})
	if (plan.carrier) {
		const src = new NfmSource({
			fs: FS,
			offsetHz: plan.carrier.offsetHz,
			amp: AMP,
			noiseSigma: 0,
			voice: false,
			ctcssHz: null,
			seed: 41,
		})
		gens.push({
			next: (n, on) => src.next(n, on),
			onS: plan.carrier.onS,
			offS: plan.carrier.offS,
		})
	}
	if (plan.fsk) {
		const src = new FskSource({
			fs: FS,
			offsetHz: plan.fsk.offsetHz,
			amp: AMP,
			noiseSigma: 0,
			levelsHz: [-1944, -648, 648, 1944],
			seed: 43,
		})
		gens.push({
			next: (n, on) => src.next(n, on),
			onS: plan.fsk.onS,
			offS: plan.fsk.offS,
		})
	}
	const chunks: Uint8Array[] = []
	const total = Math.round((plan.totalS * FS) / SCENARIO_CHUNK)
	for (let c = 0; c < total; c++) {
		const t = (c * SCENARIO_CHUNK) / FS
		const sum = new Float32Array(2 * SCENARIO_CHUNK)
		for (const g of gens) {
			const part = g.next(SCENARIO_CHUNK, t >= g.onS && t < g.offS)
			for (let i = 0; i < part.length; i++) sum[i]! += part[i]! - 127.5
		}
		const out = new Uint8Array(2 * SCENARIO_CHUNK)
		for (let i = 0; i < sum.length; i++) {
			const v = Math.round(sum[i]! + 127.5)
			out[i] = v < 0 ? 0 : v > 255 ? 255 : v
		}
		chunks.push(out)
	}
	return chunks
}

export type ScenarioHarness = ReturnType<typeof serviceHarness>

/**
 * The real service at the neutral centre. The CPU reading the recorder's limit follows reaches
 * the service the way the core passes it: a ScannerServiceDeps.recordingCpu constructor dep
 * (simultaneous-voices.test.ts wraps the constructor to add it; the harness has no option).
 */
export function scenarioHarness(): ScenarioHarness {
	return serviceHarness({ centreHz: SCENARIO_CENTRE_HZ })
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Feeds precomputed chunks with two event-loop turns between writes, like a live source. */
export async function feedChunks(
	h: ScenarioHarness,
	chunks: readonly Uint8Array[],
	onChunk?: (index: number) => void | Promise<void>,
): Promise<void> {
	for (let i = 0; i < chunks.length; i++) {
		h.fanout.write(Buffer.from(chunks[i]!))
		await onChunk?.(i)
		await turn()
		await turn()
	}
}

/** Waits for every analog operation the recorder began to settle. */
export async function settleRecorder(h: ScenarioHarness): Promise<void> {
	await recorderOf(h).idle()
}

export function recorderOf(h: ScenarioHarness): WidebandAnalogRecorder {
	return (h.service as unknown as { widebandAnalog: WidebandAnalogRecorder })
		.widebandAnalog
}

export interface RecordedFile {
	path: string
	discoveryId: string
	durationMs: number
}

export async function recordedFiles(dir: string): Promise<RecordedFile[]> {
	const root = join(dir, "recordings", "analog")
	let discoveries: string[]
	try {
		discoveries = await readdir(root)
	} catch {
		return []
	}
	const out: RecordedFile[] = []
	for (const d of discoveries)
		for (const name of await readdir(join(root, d)))
			if (name.endsWith(".wav")) {
				const path = join(root, d, name)
				out.push({
					path,
					discoveryId: d,
					durationMs: wavDurationMs(await readFile(path)),
				})
			}
	return out
}

export type VoiceOutcome = "whole" | "partial" | "missed"

/**
 * Each voice's outcome: the file(s) on the discovery nearest its offset (within 6.25 kHz), whole
 * when one file covers at least the voice's air time (the pre-roll and hang only add), partial
 * when shorter, missed when none.
 */
export function voiceOutcomes(
	h: ScenarioHarness,
	plan: ScenarioPlan,
	files: readonly RecordedFile[],
): VoiceOutcome[] {
	return plan.voices.map(v => {
		const hz = SCENARIO_CENTRE_HZ + v.offsetHz
		const mine = files.filter(f => {
			const d = h.service.getDiscovery(f.discoveryId)
			return d !== undefined && Math.abs(d.frequencyHz - hz) <= 6_250
		})
		if (mine.length === 0) return "missed"
		const air = (v.offS - v.onS) * 1000
		return mine.some(f => f.durationMs >= air - 100) ? "whole" : "partial"
	})
}

/** Files on no voice's channel (the carrier's or the 4FSK burst's: neither should be kept). */
export function strayFiles(
	h: ScenarioHarness,
	plan: ScenarioPlan,
	files: readonly RecordedFile[],
): RecordedFile[] {
	return files.filter(f => {
		const d = h.service.getDiscovery(f.discoveryId)
		if (d === undefined) return true
		return !plan.voices.some(
			v => Math.abs(d.frequencyHz - (SCENARIO_CENTRE_HZ + v.offsetHz)) <= 6_250,
		)
	})
}

export async function disposeScenario(h: ScenarioHarness): Promise<void> {
	await h.service.stop()
	await rm(h.dir, { recursive: true, force: true })
}
