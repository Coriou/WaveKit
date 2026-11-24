/**
 * Copy (ghost) detection criterion tests on MODELLED IQ (copy-fixtures.ts): one shared 96 kS/s
 * stream per scene with a cubic front-end nonlinearity, every channel demodulated by the
 * recorder's WidebandNfmChain and measured by SpeechContentMeter on one sample clock.
 *
 * 1. Both third-order ghosts of a voice mixed with a strong carrier (2·f1 − f2 and 2·f2 − f1,
 *    35 and 29 dB under the voice, off raster) are marked copies of the voice; at a ghost CNR of
 *    6 dB a ghost may also stay unmarked (no-compare), never marked as anything else.
 * 2. An unrelated voice in the same stream is never marked.
 * 3. Property: two different voices of one shared stream (one noise floor, one nonlinearity, a
 *    keyed strong blocker in half the runs, source gaps in half) never read as the same audio,
 *    over 5 to 60 s files overlapping by 80 % or more. Pass bar: max z < Z_COPY − 1.5 and
 *    max r* < R_COPY_MIN. Neff corrects only each file's own smoothness; this shared-stream
 *    property is the real guard against a common-mode pattern (a keyed blocker's desense).
 *    Explicit cases: both silent carriers keyed alike, both noise only, the same CTCSS tone with
 *    no voice on both: each no-compare or not the same audio.
 *
 * Frequencies are made-up offsets inside the synthetic capture. The chain is slow (about half a
 * second per channel and 12 s), so every channel is demodulated once and shared.
 */
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	CopyDetector,
	type CopyFingerprint,
	type CopySettled,
} from "../../../../src/core/scanner/channel/copy-detector.js"
import {
	R_COPY_MIN,
	Z_COPY,
	compareEnvelopes,
	excludeGapFrames,
	overlapAllowed,
	sameAudio,
	type CopyEnvelope,
	type CopyPlacement,
} from "../../../../src/core/scanner/channel/copy-fingerprint.js"
import {
	intermodEvidenceOf,
	type RasterFit,
} from "../../../../src/core/scanner/channel/copy-intermod.js"
import {
	MIX_FS,
	MIX_SAMPLES_PER_FRAME,
	channelAudio,
	envelopeOf,
	envelopeWindow,
	mixedStream,
	seededGaps,
	sigmaFor,
	talker,
	withGaps,
	type StreamVoice,
} from "./copy-fixtures.js"

const FPS = 1000 / 32
const yieldToLoop = (): Promise<void> => new Promise(r => setImmediate(r))
const silent = pino({ level: "silent" })

const place = (e: CopyEnvelope, atFrame = 0): CopyPlacement => ({
	...e,
	startSample: atFrame * MIX_SAMPLES_PER_FRAME,
	samplesPerFrame: MIX_SAMPLES_PER_FRAME,
})

let nextOp = 0
function fingerprintOf(
	e: CopyEnvelope,
	o: {
		hz: number
		snrDb: number
		raster: RasterFit
		intermod?: CopyFingerprint["intermod"]
	},
): CopyFingerprint {
	nextOp++
	return {
		...place(e),
		operationId: `00000000-0000-4000-8000-${nextOp.toString(16).padStart(12, "0")}`,
		sourceId: "modelled",
		epoch: 1,
		rateHz: MIX_FS,
		hz: o.hz,
		snrDb: o.snrDb,
		raster: o.raster,
		intermod: o.intermod ?? null,
	}
}

const keyOf = (fp: CopyFingerprint): string =>
	`scan:d_model~analog-${fp.operationId}.wav`

async function detect(fps: readonly CopyFingerprint[]): Promise<CopyDetector> {
	const det = new CopyDetector({
		write: () => Promise.resolve("written"),
		logger: silent,
	})
	for (const fp of fps) {
		const settled: Promise<CopySettled> = Promise.resolve({
			outcome: "finalized",
			alias: keyOf(fp).slice("scan:".length),
		})
		det.kept(fp, settled)
		await yieldToLoop()
		await det.idle()
	}
	return det
}

describe("copy detection criteria: third-order ghosts", () => {
	const SECONDS = 12
	const V1 = 10_000
	const F2 = 25_000
	const G1 = 2 * V1 - F2 // −5 kHz: 2·f1 − f2
	const G2 = 2 * F2 - V1 // +40 kHz: 2·f2 − f1
	const V2 = -30_000
	const A1 = 0.3
	const A2 = 0.6
	// a3 so the 2·f1 − f2 product (amplitude a3·A1²·A2) sits 35 dB under the voice (A1).
	const A3 = -(10 ** (-35 / 20)) / (A1 * A2)
	const ghostAmp = A1 * 10 ** (-35 / 20)

	interface Scene {
		readonly name: string
		readonly cnrDb: number
		readonly peakHz?: number
		readonly preEmphasis?: boolean
		readonly gaps?: boolean
	}
	const scenes: Scene[] = [
		{ name: "ghost CNR 6 dB", cnrDb: 6 },
		{ name: "ghost CNR 10 dB", cnrDb: 10 },
		{ name: "ghost CNR 15 dB", cnrDb: 15 },
		{
			name: "25 kHz channel (5 kHz deviation), CNR 10 dB",
			cnrDb: 10,
			peakHz: 5_000,
		},
		{ name: "pre-emphasised voice, CNR 10 dB", cnrDb: 10, preEmphasis: true },
		{ name: "source gaps in the ghosts, CNR 10 dB", cnrDb: 10, gaps: true },
	]

	for (const scene of scenes)
		it(`${scene.name}: both ghosts are copies of the voice, the unrelated voice is not`, async () => {
			await yieldToLoop()
			const voices: StreamVoice[] = [
				{
					offsetHz: V1,
					amp: A1,
					deviation: talker({
						seed: 11,
						seconds: SECONDS,
						...(scene.peakHz !== undefined ? { peakHz: scene.peakHz } : {}),
						...(scene.preEmphasis === true ? { preEmphasis: true } : {}),
					}),
				},
				{ offsetHz: F2, amp: A2, deviation: null },
				{
					offsetHz: V2,
					amp: A1,
					deviation: talker({ seed: 12, seconds: SECONDS }),
				},
			]
			const stream = mixedStream({
				seconds: SECONDS,
				seed: 3,
				noiseSigma: sigmaFor(ghostAmp, scene.cnrDb),
				a3: A3,
				voices,
			})
			const env = (offset: number, gapSeed?: number): CopyEnvelope => {
				const audio = channelAudio(stream, offset)
				if (gapSeed === undefined) return envelopeOf(audio)
				const gaps = seededGaps(gapSeed, audio.length)
				const e = envelopeOf(withGaps(audio, gaps))
				excludeGapFrames(e.env, e.frames, gaps)
				return e
			}
			const eV1 = env(V1)
			await yieldToLoop()
			const eG1 = env(G1, scene.gaps === true ? 101 : undefined)
			await yieldToLoop()
			const eG2 = env(G2, scene.gaps === true ? 102 : undefined)
			await yieldToLoop()
			const eV2 = env(V2)
			const end = SECONDS * MIX_FS
			const spans = [
				{
					hz: V1,
					startSample: 0,
					lastSample: end,
					snrDb: 41,
					peakDbfs: -10,
					binHz: null,
				},
				{
					hz: F2,
					startSample: 0,
					lastSample: end,
					snrDb: 47,
					peakDbfs: -4,
					binHz: null,
				},
				{
					hz: V2,
					startSample: 0,
					lastSample: end,
					snrDb: 41,
					peakDbfs: -10,
					binHz: null,
				},
			]
			const ghostEvidence = (hz: number, peak: number) =>
				intermodEvidenceOf(
					{ hz, startSample: 0, endSample: end, peakDbfs: peak, binHz: null },
					spans,
					() => "off",
				)
			const ev1 = ghostEvidence(G1, -45)
			const ev2 = ghostEvidence(G2, -39)
			expect(ev1?.rule).toBe("2f1-f2")
			expect(ev2?.rule).toBe("2f1-f2")
			const fV1 = fingerprintOf(eV1, { hz: V1, snrDb: 41, raster: "on" })
			const fG1 = fingerprintOf(eG1, {
				hz: G1,
				snrDb: scene.cnrDb,
				raster: "off",
				intermod: ev1,
			})
			const fG2 = fingerprintOf(eG2, {
				hz: G2,
				snrDb: scene.cnrDb + 6,
				raster: "off",
				intermod: ev2,
			})
			const fV2 = fingerprintOf(eV2, { hz: V2, snrDb: 41, raster: "on" })
			const scores = [fG1, fG2].map(g => compareEnvelopes(fV1, g))
			process.stdout.write(
				`copy criterion ${scene.name}: ${scores
					.map(s =>
						"noCompare" in s
							? s.noCompare
							: `r* ${s.r.toFixed(3)} z ${s.z.toFixed(1)} Neff ${s.neff.toFixed(0)}`,
					)
					.join(" | ")}\n`,
			)
			// Every order the files may be kept in.
			for (const order of [
				[fV1, fG1, fG2, fV2],
				[fG1, fV2, fG2, fV1],
				[fG2, fG1, fV1, fV2],
			]) {
				const det = await detect(order)
				expect(det.stateOf(keyOf(fV1))).toEqual({ kind: "root" })
				expect(det.stateOf(keyOf(fV2))).toEqual({ kind: "root" })
				for (const [g, s] of [
					[fG1, scores[0]!],
					[fG2, scores[1]!],
				] as const) {
					const state = det.stateOf(keyOf(g))
					if (scene.cnrDb <= 6 && "noCompare" in s)
						expect(state).toEqual({ kind: "root" })
					else expect(state).toEqual({ kind: "copy", of: keyOf(fV1) })
				}
			}
			if (scene.cnrDb >= 10)
				for (const s of scores) {
					if ("noCompare" in s) throw new Error("ghost not compared")
					expect(s.r).toBeGreaterThanOrEqual(0.8)
				}
			// The unrelated voice never reads as the same audio as any of them.
			for (const other of [fV1, fG1, fG2])
				expect(sameAudio(compareEnvelopes(fV2, other))).toBe(false)
		}, 300_000)
})

describe("copy detection criteria: different voices of one shared stream", () => {
	const SECONDS = 62
	/** Made-up offsets where every strong 2·blocker − voice product lands ≥ 10 kHz off a voice. */
	const OFFSETS = [-34_000, -14_000, 6_000, 26_000]
	const BLOCKER = 39_000

	interface Pool {
		readonly blocker: boolean
		/** Per voice: the clean envelope and one with seeded source gaps. */
		readonly envs: { clean: CopyEnvelope; gapped: CopyEnvelope }[]
	}

	let pools: Pool[] | null = null
	async function buildPools(): Promise<Pool[]> {
		if (pools !== null) return pools
		const out: Pool[] = []
		for (const blocker of [false, true]) {
			// Without the blocker: voice CNRs of 30, 22, 14 and 6 dB in one noise floor. With it
			// (+26 dB over the strongest voice, keyed at 0.2 to 2 s), the 8-bit front end's own
			// quantisation sets the floor: about 26 down to 8 dB.
			const strongest = blocker ? 0.03 : 0.2
			const amps = [0, 8, 16, 24].map(d => strongest * 10 ** (-d / 20))
			const voices: StreamVoice[] = OFFSETS.map((offsetHz, i) => ({
				offsetHz,
				amp: amps[i]!,
				deviation: talker({
					seed: 300 + i + (blocker ? 10 : 0),
					seconds: SECONDS,
				}),
			}))
			await yieldToLoop()
			const stream = mixedStream({
				seconds: SECONDS,
				seed: blocker ? 41 : 42,
				noiseSigma: sigmaFor(strongest, 30),
				// Compressive: about 1 dB of gain compression under the blocker.
				a3: -0.15,
				voices,
				...(blocker ? { blocker: { offsetHz: BLOCKER, amp: 0.6 } } : {}),
			})
			const envs: Pool["envs"] = []
			for (const [i, offset] of OFFSETS.entries()) {
				await yieldToLoop()
				const audio = channelAudio(stream, offset)
				const gaps = seededGaps(500 + i + (blocker ? 10 : 0), audio.length)
				const gapped = envelopeOf(withGaps(audio, gaps))
				excludeGapFrames(gapped.env, gapped.frames, gaps)
				envs.push({ clean: envelopeOf(audio), gapped })
			}
			out.push({ blocker, envs })
		}
		pools = out
		return out
	}

	// Feature: ghost-copies, Property 1: different voices never copy
	// Validates: Requirements 1, 4
	it("two different voices of one shared stream never read as the same audio (2 000 runs)", async () => {
		const p = await buildPools()
		let maxZ = Number.NEGATIVE_INFINITY
		let maxR = Number.NEGATIVE_INFINITY
		const zs: number[] = []
		const rs: number[] = []
		let compared = 0
		let noCompare = 0
		let totalMs = 0
		let maxMs = 0
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.integer({ min: 0, max: 3 }),
				fc.integer({ min: 1, max: 3 }),
				fc.boolean(),
				fc.boolean(),
				fc.double({ min: 5, max: 58, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: -1, max: 1, noNaN: true }),
				(blocker, i, step, gapA, gapB, dA, uLen, uStart, uShift) => {
					const pool = p[blocker ? 1 : 0]!
					const j = (i + step) % 4
					const a = pool.envs[i]!
					const b = pool.envs[j]!
					// B's length within [0.8, 1.25] of A's (and 5 to 60 s), its start shifted by up to
					// 20 % of the shorter one: the overlap stays at least 80 % of the shorter file.
					const lo = Math.max(5, 0.8 * dA)
					const hi = Math.min(60, dA / 0.8)
					const dB = lo + uLen * (hi - lo)
					const fa = Math.round(dA * FPS)
					const fb = Math.round(dB * FPS)
					const shorter = Math.min(fa, fb)
					const shift = Math.round(
						uShift * 0.2 * (shorter - Math.abs(fa - fb)) * 0.5,
					)
					const total = Math.floor(SECONDS * FPS) - 2
					const startA = Math.round(
						uStart * Math.max(0, total - Math.max(fa, fb + Math.abs(shift))),
					)
					const startB = Math.max(0, startA + shift)
					const pa = place(
						envelopeWindow(gapA ? a.gapped : a.clean, startA, fa),
						startA,
					)
					const pb = place(
						envelopeWindow(gapB ? b.gapped : b.clean, startB, fb),
						startB,
					)
					if (!overlapAllowed(pa, pb, MIX_FS)) return
					const t0 = performance.now()
					const c = compareEnvelopes(pa, pb)
					const ms = performance.now() - t0
					totalMs += ms
					maxMs = Math.max(maxMs, ms)
					compared++
					if ("noCompare" in c) {
						noCompare++
						return
					}
					zs.push(c.z)
					rs.push(c.r)
					maxZ = Math.max(maxZ, c.z)
					maxR = Math.max(maxR, c.r)
					expect(sameAudio(c)).toBe(false)
				},
			),
			{ numRuns: 2_000, seed: 20_261_124 },
		)
		const p999 = (v: number[]): number => {
			const s = [...v].sort((x, y) => x - y)
			return (
				s[Math.min(s.length - 1, Math.floor(0.999 * (s.length - 1)))] ??
				Number.NaN
			)
		}
		const meanMs = totalMs / Math.max(1, compared)
		// Non-gating timing: per comparison, and the cores at 480 kept files an hour × 3 roots.
		process.stdout.write(
			`copy criterion property: ${compared} pairs compared (${noCompare} no-compare), ` +
				`p99.9 z ${p999(zs).toFixed(2)} max z ${maxZ.toFixed(2)}, p99.9 r* ${p999(rs).toFixed(3)} ` +
				`max r* ${maxR.toFixed(3)}; comparison mean ${meanMs.toFixed(3)} ms max ${maxMs.toFixed(3)} ms ` +
				`(${((meanMs * 480 * 3) / 3_600_000).toExponential(2)} cores at 480 files/h × 3)\n`,
		)
		expect(compared).toBeGreaterThan(1_500)
		expect(zs.length).toBeGreaterThan(500)
		expect(maxZ).toBeLessThan(Z_COPY - 1.5)
		expect(maxR).toBeLessThan(R_COPY_MIN)
	}, 600_000)

	it("explicit cases: silent carriers keyed alike, noise only, the same CTCSS tone with no voice", async () => {
		const seconds = 12
		await yieldToLoop()
		const keyed: [number, number][] = []
		for (let t = 0.3; t < seconds; t += 1.7) keyed.push([t, t + 1.1])
		const stream = mixedStream({
			seconds,
			seed: 77,
			noiseSigma: sigmaFor(0.2, 20),
			a3: -0.15,
			voices: [
				{ offsetHz: -30_000, amp: 0.2, deviation: null, keyed },
				{ offsetHz: -10_000, amp: 0.2, deviation: null, keyed },
				{ offsetHz: 10_000, amp: 0.2, deviation: null, ctcssHz: 88.5 },
				{ offsetHz: 30_000, amp: 0.2, deviation: null, ctcssHz: 88.5 },
			],
		})
		const env = (offset: number): CopyPlacement =>
			place(envelopeOf(channelAudio(stream, offset)))
		const cases: [string, CopyPlacement, CopyPlacement][] = []
		const carriers = [env(-30_000), env(-10_000)]
		await yieldToLoop()
		const tones = [env(10_000), env(30_000)]
		await yieldToLoop()
		// Noise only: two channels of a stream with no carrier at all (an open squelch).
		const empty = mixedStream({
			seconds,
			seed: 78,
			noiseSigma: sigmaFor(0.2, 20),
			a3: -0.15,
			voices: [],
		})
		const noise = [-20_000, 20_000].map(o =>
			place(envelopeOf(channelAudio(empty, o))),
		)
		cases.push(["silent carriers keyed alike", carriers[0]!, carriers[1]!])
		cases.push(["the same CTCSS tone, no voice", tones[0]!, tones[1]!])
		cases.push(["noise only", noise[0]!, noise[1]!])
		for (const [name, a, b] of cases) {
			const c = compareEnvelopes(a, b)
			expect(sameAudio(c), name).toBe(false)
			expect("noCompare" in c ? c.noCompare : "compared", name).toBe(
				"ineligible",
			)
		}
	}, 300_000)
})
