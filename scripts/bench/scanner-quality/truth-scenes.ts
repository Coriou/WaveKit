/**
 * Scanner truth scorecard: synthetic cases with known truth (no captured RF). Each is a seeded
 * scene (scene.ts) on a UHF land-mobile band (455 MHz, 1.024 Msps; the built-in plan lists
 * analog FM, DMR and the other land-mobile modes there, so the recorder may shadow anything),
 * its labels taken from the generator, and the decodes a live system would see, at the time
 * they would reach the scanner:
 *
 * - pager-late: two 4 s POCSAG messages (preamble, then codewords). Their decode comes from the
 *   identify replay of the scanner's capture (truth-run.ts, the replay oracle): the capture ends
 *   with the burst, the replay answers 2 s later plus 1 s per trial, after the recorder asked for
 *   the file's finish (the burst's end, its hang and the recorder's 1 s holdback).
 * - pager-twin and pager-analog: the live pager shape, bursts whose spectrum reads analog FM, two
 *   capcodes on one channel, on a quiet band (a co-channel twin) and on a busy one (decoded late)
 *   (pagerAnalog).
 * - pager-new-twin: a new capcode's first pages on a paging channel already decoded
 *   (pagerNewTwin).
 * - dmr: a DMR repeater keyed for 20 s (both slots, continuous 4FSK) with an always-on dsd-fme
 *   decode every 2 s from 1.5 s after its onset, and a direct-mode handheld conversation (TDMA
 *   bursts, seven overs of 3 to 4 s) that only identify's replays decode.
 * - noise-fm: an FM carrier whose audio is noise keyed like speech, and a steady carrier.
 * - voice: speech-like NFM with an 88.5 Hz CTCSS tone, four overs on one channel and two weaker
 *   ones on another.
 * - repeater-id: one 28 s speech-like NFM over with CTCSS (a repeater's voice ID).
 */
import {
	SPEECH_CTCSS_HZ,
	buildScene,
	nominalOf,
	type Scene,
	type SignalClass,
} from "./scene.js"
import type { TruthDecode, TruthInterval, TruthLabel } from "./truth-labels.js"
import { syntheticCase, type TruthCase } from "./truth-run.js"

const CENTRE_HZ = 455_000_000
const RATE_HZ = 1_024_000
const NOISE_SIGMA = 0.03
/** An always-on dsd-fme reports a keyed DMR channel this long after its onset, then every 2 s. */
const DMR_FIRST_DECODE_MS = 1_500
const DMR_DECODE_EVERY_MS = 2_000

/** The voice classes whose generator adds the SPEECH_CTCSS_HZ tone (scene.ts). */
const TONED: readonly SignalClass[] = ["nfm-voice", "nfm-ptt", "nfm-speech"]

const LABEL_OF: Partial<Record<SignalClass, TruthLabel>> = {
	"nfm-voice": "analog-voice",
	"nfm-ptt": "analog-voice",
	"nfm-speech": "analog-voice",
	dmr: "dmr",
	"dmr-bs": "dmr",
	pocsag: "pocsag",
	"pocsag-msg": "pocsag",
	"pocsag-2400": "pocsag",
	"pocsag-shaped": "pocsag",
	carrier: "carrier",
	"fm-noise": "noise",
}

/** The scene's labels: one interval per on-air interval of each signal. */
export function truthOf(scene: Scene): TruthInterval[] {
	const out: TruthInterval[] = []
	for (const t of scene.truth)
		for (const iv of t.intervals)
			out.push({
				frequencyHz: t.centreHz,
				startMs: iv.startMs,
				endMs: Math.min(iv.endMs, scene.durationMs),
				label: LABEL_OF[t.class] ?? "unknown",
				source: "synthetic",
				confirmed: true,
				bandwidthHz: nominalOf(t.class).bandwidthHz,
				...(TONED.includes(t.class) ? { ctcssHz: SPEECH_CTCSS_HZ } : {}),
			})
	return out
}

const scene = (
	name: string,
	durationMs: number,
	seed: number,
	signals: Parameters<typeof buildScene>[0]["signals"],
): Scene =>
	buildScene({
		name,
		rateHz: RATE_HZ,
		centreHz: CENTRE_HZ,
		durationMs,
		seed,
		noiseSigma: NOISE_SIGMA,
		signals,
	})

function pagerLate(): TruthCase {
	const offsetHz = 106_250
	const bursts = [
		{ startMs: 2_000, endMs: 6_000 },
		{ startMs: 16_000, endMs: 20_000 },
	]
	const s = scene("pager-late", 32_000, 20_261_201, [
		{ class: "pocsag-msg", offsetHz, snrDb: 20, intervals: bursts },
	])
	return syntheticCase(s, truthOf(s), [])
}

function dmr(): TruthCase {
	const repeater = { offsetHz: -193_750, on: { startMs: 1_000, endMs: 21_000 } }
	const s = scene("dmr", 40_000, 20_261_202, [
		{
			class: "dmr-bs",
			offsetHz: repeater.offsetHz,
			snrDb: 20,
			intervals: [repeater.on],
		},
		{
			class: "dmr",
			offsetHz: 256_250,
			snrDb: 18,
			// A direct-mode conversation: seven overs of 3 to 4 s, 2 s apart.
			intervals: [
				{ startMs: 2_000, endMs: 6_000 },
				{ startMs: 8_000, endMs: 11_000 },
				{ startMs: 13_000, endMs: 17_000 },
				{ startMs: 19_000, endMs: 22_000 },
				{ startMs: 24_000, endMs: 28_000 },
				{ startMs: 30_000, endMs: 33_000 },
				{ startMs: 35_000, endMs: 38_000 },
			],
		},
	])
	const decodes: TruthDecode[] = []
	for (
		let at = repeater.on.startMs + DMR_FIRST_DECODE_MS;
		at < repeater.on.endMs;
		at += DMR_DECODE_EVERY_MS
	)
		decodes.push({
			atMs: at,
			frequencyHz: CENTRE_HZ + repeater.offsetHz,
			protocol: "dmr",
			via: "ambient",
		})
	return syntheticCase(s, truthOf(s), decodes)
}

function noiseFm(): TruthCase {
	const s = scene("noise-fm", 20_000, 20_261_203, [
		{
			class: "fm-noise",
			offsetHz: 56_250,
			snrDb: 20,
			intervals: [{ startMs: 1_000, endMs: 19_000 }],
		},
		{
			class: "carrier",
			offsetHz: -306_250,
			snrDb: 25,
			intervals: [{ startMs: 0, endMs: 20_000 }],
		},
	])
	return syntheticCase(s, truthOf(s), [])
}

function voice(): TruthCase {
	const s = scene("voice", 40_000, 20_261_204, [
		{
			class: "nfm-speech",
			offsetHz: -93_750,
			snrDb: 20,
			intervals: [
				{ startMs: 1_000, endMs: 7_000 },
				{ startMs: 12_000, endMs: 22_000 },
				{ startMs: 27_000, endMs: 31_000 },
				{ startMs: 35_000, endMs: 39_000 },
			],
		},
		{
			class: "nfm-speech",
			offsetHz: 343_750,
			snrDb: 12,
			intervals: [
				{ startMs: 3_000, endMs: 11_000 },
				{ startMs: 20_000, endMs: 26_000 },
			],
		},
	])
	return syntheticCase(s, truthOf(s), [])
}

function repeaterId(): TruthCase {
	const s = scene("repeater-id", 31_000, 20_261_205, [
		{
			class: "nfm-speech",
			offsetHz: 156_250,
			snrDb: 20,
			intervals: [{ startMs: 1_000, endMs: 29_000 }],
		},
	])
	return syntheticCase(s, truthOf(s), [])
}

/**
 * The live pager shape: a paging channel whose bursts read analog FM (pocsag-shaped: the
 * transmitter's premodulation filter fills the valley between the tones), five 4 s messages
 * 15 s apart for two capcodes in turn, each decoded only by identify's replay of the scanner's
 * own capture. `busy`: the band also carries two two-tone pagers and a DMR handheld
 * conversation, which keep the replay queue (one capture at a time) and the capture budget in
 * use, so a page's decode lands after the recorder asked for its file's finish (pager-analog).
 * Quiet (pager-twin): the replay answers within the burst, and a page of the other capcode lands
 * on a co-channel twin discovery, not on the one the recorder records for.
 */
export const PAGER_ANALOG_CAPCODES = ["1234567", "1234568"] as const
const PAGER_ANALOG_OFFSET_HZ = -168_750

function pagerAnalog(busy: boolean): TruthCase {
	const bursts = [2_000, 17_000, 32_000, 47_000, 62_000].map(startMs => ({
		startMs,
		endMs: startMs + 4_000,
	}))
	// A busy band, as the live one: two more pagers (two-tone) and a DMR handheld conversation
	// keep identify's replay queue (one capture at a time) and the capture budget in use.
	const every = (first: number, period: number, length: number) =>
		Array.from(
			{ length: Math.floor((70_000 - first - length) / period) + 1 },
			(_, k) => ({
				startMs: first + k * period,
				endMs: first + k * period + length,
			}),
		)
	const pager = {
		class: "pocsag-shaped" as const,
		offsetHz: PAGER_ANALOG_OFFSET_HZ,
		snrDb: 20,
		intervals: bursts,
	}
	const traffic = [
		{
			class: "pocsag-msg" as const,
			offsetHz: 31_250,
			snrDb: 20,
			intervals: every(1_000, 9_000, 3_000),
		},
		{
			class: "pocsag-msg" as const,
			offsetHz: 231_250,
			snrDb: 20,
			intervals: every(5_500, 11_000, 3_000),
		},
		{
			class: "dmr" as const,
			offsetHz: -293_750,
			snrDb: 18,
			intervals: every(3_000, 8_000, 4_000),
		},
	] as const
	const s = scene(
		busy ? "pager-analog" : "pager-twin",
		70_000,
		20_261_206,
		busy ? [pager, ...traffic] : [pager],
	)
	// The shaped pager's messages alternate two capcodes.
	let n = 0
	const intervals = truthOf(s).map(iv =>
		iv.frequencyHz === CENTRE_HZ + PAGER_ANALOG_OFFSET_HZ
			? {
					...iv,
					identity: PAGER_ANALOG_CAPCODES[n++ % PAGER_ANALOG_CAPCODES.length]!,
				}
			: iv,
	)
	return syntheticCase(s, intervals, [])
}

/**
 * A new capcode on a known paging channel (pager-new-twin): capcode A pages three times at
 * 20 dB, each read by an always-on pager decoder, then capcode B, never paged before, pages twice at
 * 14 dB, under the create SNR (DQ_CREATE_SNR_DB 18), so its first observation may wait for
 * admission (pending) and the recorder can see it before its discovery exists: B's bursts are
 * the fresh twin's, and the channel's pages say they are not voice.
 */
export const PAGER_NEW_TWIN_CAPCODES = ["2345671", "2345672"] as const
const PAGER_NEW_TWIN_OFFSET_HZ = 118_750

function pagerNewTwin(): TruthCase {
	const at = (startMs: number) => ({ startMs, endMs: startMs + 4_000 })
	const s = scene("pager-new-twin", 70_000, 20_261_207, [
		{
			class: "pocsag-shaped",
			offsetHz: PAGER_NEW_TWIN_OFFSET_HZ,
			snrDb: 20,
			intervals: [at(2_000), at(14_000), at(26_000)],
		},
		{
			class: "pocsag-shaped",
			offsetHz: PAGER_NEW_TWIN_OFFSET_HZ,
			snrDb: 14,
			intervals: [at(40_000), at(55_000)],
		},
	])
	const intervals = truthOf(s).map(iv =>
		iv.frequencyHz === CENTRE_HZ + PAGER_NEW_TWIN_OFFSET_HZ
			? {
					...iv,
					identity: PAGER_NEW_TWIN_CAPCODES[iv.startMs < 40_000 ? 0 : 1]!,
				}
			: iv,
	)
	// An always-on pager decoder (ambient) reads capcode A's pages 1.5 s into each: the
	// channel's pager evidence, before capcode B's twin exists.
	const decodes: TruthDecode[] = [2_000, 14_000, 26_000].map(startMs => ({
		atMs: startMs + 1_500,
		frequencyHz: CENTRE_HZ + PAGER_NEW_TWIN_OFFSET_HZ,
		protocol: "pocsag",
		via: "ambient",
		identity: PAGER_NEW_TWIN_CAPCODES[0],
	}))
	return syntheticCase(s, intervals, decodes)
}

/** Every synthetic case, in a fixed order. */
export function syntheticCases(): TruthCase[] {
	return [
		pagerLate(),
		pagerAnalog(false),
		pagerAnalog(true),
		pagerNewTwin(),
		dmr(),
		noiseFm(),
		voice(),
		repeaterId(),
	]
}
