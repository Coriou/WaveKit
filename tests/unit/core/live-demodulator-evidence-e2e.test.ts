/**
 * Evidence squelch end to end on the default (real) gate and pre-roll (docs/specs/evidence-squelch,
 * plan W.3, requirement 8.1): 25 kHz s16le PCM out of the fake csdr back stage, stage 1 scripted,
 * one measured 10 ms block per 10 ms chunk. Every config sets `squelchMode` explicitly.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import http from "node:http"
import { LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS } from "@wavekit/api-types"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { wavStreamHeader } from "../../../src/core/live-demodulator.js"
import {
	createDemodHarness,
	waitFor,
} from "./live-demodulator-continuity-fakes.js"
import {
	carrierSilence,
	clicks,
	ctcssMix,
	dcsMix,
	fskBursts,
	impulseNoise,
	mix,
	toPcm,
	voiceLike,
	whiteNoise,
} from "./evidence-squelch/synthetic.js"

type Harness = Awaited<ReturnType<typeof createDemodHarness>>

interface E2eRun {
	squelch: object
	stream: { rate: number; format: "s16le" | "f32le" }
	noiseFloorDbfs: number | null
}

interface E2eInternals {
	run: E2eRun | null
	handleAudioData(chunk: Buffer): void
	measureRun(run: unknown): void
}

const RATE = 25_000
/** One 10 ms level block per chunk: 250 samples × 2 bytes. */
const BLOCK_BYTES = 500
const LEAD_SECONDS = 0.5
const OVER_SECONDS = 3
const TAIL_SECONDS = 2
const AM_FLOOR_DBFS = -60

/** An 8 kHz s16le evidence-squelch fixture, linearly upsampled to the harness rate. */
function fixtureAt25k(name: string): Float32Array {
	const bytes = readFileSync(
		new URL(
			`../../mocks/fixtures/evidence-squelch/${name}.audio.s16le`,
			import.meta.url,
		),
	)
	const src = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
	const out = new Float32Array(Math.floor((src.length * RATE) / 8_000))
	for (let i = 0; i < out.length; i++) {
		const pos = (i * 8_000) / RATE
		const k = Math.floor(pos)
		const a = src[k] ?? 0
		const b = src[k + 1] ?? a
		out[i] = (a + (b - a) * (pos - k)) / 32_768
	}
	return out
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function overVoice(seed: number): Float32Array {
	return voiceLike({ rate: RATE, seconds: OVER_SECONDS, seed })
}

interface Segment {
	pcm: Buffer
	/** Stage 1 open for this segment. */
	open: boolean
	/** Blocks noted as quieted (csdr `blockQuieted()`); AM uses power over the floor instead. */
	quieted: boolean
}

interface Driven {
	received: Buffer
	/** Seconds of stage-1-open audio fed before the status first reported `open`, or null. */
	openAfterSeconds: number | null
	everOpen: boolean
}

describe("live demodulator evidence squelch end to end (real gate and pre-roll)", () => {
	let h: Harness | null = null
	afterEach(async () => {
		await h?.dispose()
		h = null
	})

	async function drive(
		modulation: "nfm" | "am",
		segments: Segment[],
		wav = false,
		/** Cut offsets (bytes, inside the block) at which each 10 ms block is split into chunks. */
		split?: (block: number) => number[],
	): Promise<
		Driven & { wavBody: Buffer | null; states: Set<string>; pcm: Buffer }
	> {
		h = await createDemodHarness({
			config: {
				modulation,
				squelchMode: "auto",
			},
		})
		const internals = h.demod as unknown as E2eInternals
		await h.demod.start()
		const pcmChunks: Buffer[] = []
		h.demod.on("pcm", (chunk: Buffer) => pcmChunks.push(Buffer.from(chunk)))
		const run = internals.run
		if (run === null) throw new Error("no run")
		expect(run.stream).toEqual({ rate: RATE, format: "s16le" })
		const control = { open: false, quieted: false }
		Object.defineProperty(run.squelch, "open", {
			configurable: true,
			get: () => control.open,
		})
		Object.defineProperty(run.squelch, "blockQuieted", {
			configurable: true,
			value: () => control.quieted,
		})
		// AM carrier evidence: block power 20 dB over a pinned floor while stage 1 is open.
		Object.defineProperty(run.squelch, "powerDbfs", {
			configurable: true,
			get: () =>
				control.open && control.quieted ? AM_FLOOR_DBFS + 20 : AM_FLOOR_DBFS,
		})
		const wavBody = wav ? await openWavClient(h, RATE) : null
		const { transport } = h.addClient()
		let fed = 0
		let blockIndex = 0
		let openFed = 0
		let openAfterSeconds: number | null = null
		let everOpen = false
		const states = new Set<string>()
		for (const segment of segments) {
			control.open = segment.open
			control.quieted = segment.quieted
			for (let at = 0; at < segment.pcm.length; at += BLOCK_BYTES) {
				const blockEnd = Math.min(segment.pcm.length, at + BLOCK_BYTES)
				const cuts = (split?.(blockIndex) ?? [])
					.map(c => at + c)
					.filter(c => c > at && c < blockEnd)
				blockIndex += 1
				let from = at
				for (const to of [...cuts, blockEnd]) {
					const chunk = Buffer.from(segment.pcm.subarray(from, to))
					from = to
					internals.handleAudioData(chunk)
					// A real socket drains between chunks (the registry drops a lagging client).
					if (wav) await new Promise(resolve => setImmediate(resolve))
					fed += chunk.length
					// Property 7 at the wiring level: every fed byte reaches the client, per chunk.
					expect(transport.received().length).toBe(fed)
				}
				run.noiseFloorDbfs = AM_FLOOR_DBFS
				internals.measureRun(run)
				if (segment.open) openFed += blockEnd - at
				const state = h.demod.getStatus().autoSquelch?.state
				states.add(state ?? "absent")
				if (state === "open") {
					everOpen = true
					openAfterSeconds ??= openFed / 2 / RATE
				}
			}
		}
		return {
			received: transport.received(),
			openAfterSeconds,
			everOpen,
			states,
			pcm: Buffer.concat(pcmChunks),
			wavBody: wavBody === null ? null : await wavBody.done(fed),
		}
	}

	function overScript(over: Float32Array, overQuieted = true): Segment[] {
		return [
			{
				pcm: toPcm(
					whiteNoise({ rate: RATE, seconds: LEAD_SECONDS, seed: 3 }),
					"s16le",
				),
				open: false,
				quieted: false,
			},
			{ pcm: toPcm(over, "s16le"), open: true, quieted: overQuieted },
			{
				pcm: toPcm(
					whiteNoise({ rate: RATE, seconds: TAIL_SECONDS, seed: 5 }),
					"s16le",
				),
				open: false,
				quieted: false,
			},
		]
	}

	const OPENS: Array<[string, "nfm" | "am", () => Float32Array]> = [
		[
			"NFM CTCSS 67.0 Hz + voice",
			"nfm",
			() =>
				mix(
					overVoice(21),
					ctcssMix({ rate: RATE, seconds: OVER_SECONDS, hz: 67 }),
				),
		],
		[
			"NFM DCS 023N + voice",
			"nfm",
			() =>
				mix(
					overVoice(22),
					dcsMix({
						rate: RATE,
						seconds: OVER_SECONDS,
						code: 0o23,
						polarity: "normal",
					}),
				),
		],
		["NFM voice", "nfm", () => overVoice(23)],
	]

	// Amendment A8: the AM half of this known limitation no longer applies (AM is not gated).
	for (const modulation of ["nfm"] as const) {
		// Known limitation (req 8.1, pending): seed 24's voice sits just under the pinned voice
		// audio level (frame audioDb medians about -31 dB against -30 dB), so the gate latches
		// about 1.85 s after stage 1 opens, past the 1.5 s pre-roll, and the over's first
		// ~350 ms are lost. A design change is expected to flip this test (latch within 1.5 s,
		// audio from the over's first sample); update it then.
		// Amendment A13 (2026-10-24): on a 12.5 kHz channel (the default bandwidth) the meter
		// normalises the ±2.5 kHz plan onto its 5 kHz reference, so this over latches as soon as
		// its first window is full and plays from its first sample.
		it(`A13: marginal-level voice latches with its first window on a 12.5 kHz channel (${modulation})`, async () => {
			const over = overVoice(24)
			const overPcm = toPcm(over, "s16le")
			const result = await drive(modulation, overScript(over))
			// The status is read once per 10 ms chunk: the latch falls in (0.99 s, 1.00 s].
			expect(result.openAfterSeconds).toBe(1)
			// Played from over sample 0, behind the 1 s wait held in the pre-roll.
			const at = result.received.indexOf(overPcm.subarray(0, RATE))
			expect(at).toBe((LEAD_SECONDS + 1) * RATE * 2)
			expect(result.received.subarray(0, at).every(b => b === 0)).toBe(true)
			expect(result.received.subarray(at, at + overPcm.length)).toEqual(overPcm)
		})
	}

	// Amendment A14 (2026-10-24), live run2: weak interference re-opens stage 1 every 0.5 s after
	// a CTCSS over. Only carrier evidence keeps the latch; the flicker plays nothing once the hang
	// after the over's last quieted block has run out.
	it("A14: interference flicker after a tone over is muted once the hang runs out", async () => {
		const over = mix(
			ctcssMix({ rate: RATE, seconds: OVER_SECONDS, hz: 67 }),
			voiceLike({ rate: RATE, seconds: OVER_SECONDS, seed: 41, level: 0.4 }),
		)
		const overPcm = toPcm(over, "s16le")
		const segments: Segment[] = [
			{ pcm: overPcm, open: true, quieted: true },
			{ pcm: Buffer.alloc(0.3 * RATE * 2), open: false, quieted: false },
		]
		for (let i = 0; i < 20; i++)
			segments.push(
				{
					pcm: toPcm(
						whiteNoise({ rate: RATE, seconds: 0.2, seed: 60 + i, level: 0.9 }),
						"s16le",
					),
					open: true,
					quieted: false,
				},
				{ pcm: Buffer.alloc(0.3 * RATE * 2), open: false, quieted: false },
			)
		const result = await drive("nfm", segments)
		// The over plays (behind its pre-roll delay of at most 1.5 s).
		const at = result.received.indexOf(overPcm.subarray(0, RATE))
		expect(at).toBeGreaterThanOrEqual(0)
		// From over end + hang (1.5 s) + the largest pre-roll delay (1.5 s) on, only zeros.
		const quietFrom = overPcm.length + 3 * RATE * 2
		expect(result.received.subarray(quietFrom).every(b => b === 0)).toBe(true)
		expect(result.states.has("waiting")).toBe(true)
	})

	for (const [name, modulation, make] of OPENS) {
		// Validates: Requirements 8.1, 1.2, 2.1
		it(`${name}: opens within the pre-roll and plays the over from its first sample`, async () => {
			const over = make()
			const overPcm = toPcm(over, "s16le")
			const result = await drive(modulation, overScript(over))
			expect(result.openAfterSeconds).not.toBeNull()
			expect(result.openAfterSeconds ?? Infinity).toBeLessThanOrEqual(
				LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS / 1_000,
			)
			const at = result.received.indexOf(overPcm.subarray(0, RATE))
			expect(at).toBeGreaterThanOrEqual(LEAD_SECONDS * RATE * 2)
			expect(result.received.subarray(0, at).every(b => b === 0)).toBe(true)
		})
	}

	/**
	 * Consecutive overs (window-reset amendment 2026-10-23): over 1 latches; 10 s of closed
	 * silence (the gate hangs out and resets itself inside `closed()`); then stage 1 opens on
	 * 250 ms of unquieted noise before over 2. The gate is the only onset tracker: its
	 * `noteBlock` reports the reset and the wiring abandons the held noise, so over 2 plays from
	 * its first sample and no lead-in noise reaches the client.
	 */
	function consecutiveOvers(): {
		segments: Segment[]
		lead: Buffer
		over2: Buffer
	} {
		const over1 = toPcm(overVoice(21), "s16le")
		const lead = toPcm(
			whiteNoise({ rate: RATE, seconds: 0.25, seed: 9, level: 0.9 }),
			"s16le",
		)
		const over2 = toPcm(overVoice(23), "s16le")
		return {
			lead,
			over2,
			segments: [
				{ pcm: over1, open: true, quieted: true },
				{ pcm: Buffer.alloc(10 * RATE * 2), open: false, quieted: false },
				{ pcm: lead, open: true, quieted: false },
				{ pcm: over2, open: true, quieted: true },
				{
					pcm: toPcm(whiteNoise({ rate: RATE, seconds: 2, seed: 5 }), "s16le"),
					open: false,
					quieted: false,
				},
			],
		}
	}

	function expectOver2FromFirstSample(
		received: Buffer,
		lead: Buffer,
		over2: Buffer,
	): void {
		// This harness measures each block after its PCM, so the onset block itself (the first
		// 10 ms of over 2) is already held when the reset abandons the lead-in: at most one block
		// (10 ms, inside the 20 ms onset tolerance) is lost; the rest plays from there.
		const at = received.indexOf(over2.subarray(BLOCK_BYTES, BLOCK_BYTES + RATE))
		expect(at).toBeGreaterThan(0)
		const tail = over2.length - BLOCK_BYTES - RATE * 2
		expect(received.subarray(at, at + tail)).toEqual(
			over2.subarray(BLOCK_BYTES, BLOCK_BYTES + tail),
		)
		// Nothing of the lead-in noise reaches the client: zeros right before over 2.
		expect(
			received.subarray(at - lead.length - BLOCK_BYTES, at).every(b => b === 0),
		).toBe(true)
		expect(received.indexOf(lead.subarray(0, 200))).toBe(-1)
	}

	it("consecutive overs: noisy lead-in before the second over is dropped (gate-owned onset)", async () => {
		const { segments, lead, over2 } = consecutiveOvers()
		const result = await drive("nfm", segments)
		expectOver2FromFirstSample(result.received, lead, over2)
	}, 60_000)

	// Feature: evidence-squelch, Property 6: Chunk-split invariance
	// Validates: Requirements 2.1, 2.3
	it("consecutive overs: invariant under chunk splits inside each block", async () => {
		const { segments, lead, over2 } = consecutiveOvers()
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 1, max: 0x7fffffff }), async seed => {
				let x = seed
				const split = (): number[] => {
					x = (Math.imul(x, 1_103_515_245) + 12_345) & 0x7fffffff
					const n = x % 3
					const cuts: number[] = []
					for (let i = 0; i < n; i++) {
						x = (Math.imul(x, 1_103_515_245) + 12_345) & 0x7fffffff
						// Sample-aligned cuts: the per-chunk byte check above assumes whole samples
						// (odd splits are covered by the wiring's odd-chunk test).
						cuts.push(2 * (1 + (x % (BLOCK_BYTES / 2 - 1))))
					}
					return cuts.sort((a, b) => a - b)
				}
				const result = await drive("nfm", segments, false, split)
				expectOver2FromFirstSample(result.received, lead, over2)
				await h?.dispose()
				h = null
			}),
			{ numRuns: 100 },
		)
	}, 600_000)

	const NEVER: Array<[string, "nfm" | "am", Segment[]]> = [
		[
			"bare NFM carrier",
			"nfm",
			[
				{
					pcm: toPcm(carrierSilence({ rate: RATE, seconds: 4 }), "s16le"),
					open: true,
					quieted: true,
				},
			],
		],
		[
			"DMR-like 4FSK (30 ms TDMA bursts)",
			"nfm",
			[
				{
					pcm: toPcm(
						fskBursts({
							rate: RATE,
							seconds: 4,
							levels: 4,
							baud: 4_800,
							burstMs: 30,
							gapMs: 30,
							seed: 31,
						}),
						"s16le",
					),
					open: true,
					quieted: true,
				},
			],
		],
		[
			// Continuous, as real POCSAG; syllable-timed bursts are a known limitation (req 1.4 note).
			"POCSAG-like continuous 2FSK",
			"nfm",
			[
				{
					pcm: toPcm(
						fskBursts({
							rate: RATE,
							seconds: 4,
							levels: 2,
							baud: 1_200,
							burstMs: 4_000,
							gapMs: 0,
							seed: 32,
						}),
						"s16le",
					),
					open: true,
					quieted: true,
				},
			],
		],
		[
			"clicks",
			"nfm",
			[
				{
					pcm: toPcm(
						clicks({ rate: RATE, seconds: 4, perSecond: 8, seed: 33 }),
						"s16le",
					),
					open: true,
					quieted: true,
				},
			],
		],
		[
			"impulse noise",
			"nfm",
			[
				{
					pcm: toPcm(
						impulseNoise({ rate: RATE, seconds: 4, seed: 34 }),
						"s16le",
					),
					open: true,
					quieted: true,
				},
			],
		],
		[
			"unquieted noise",
			"nfm",
			[
				{
					pcm: toPcm(whiteNoise({ rate: RATE, seconds: 4, seed: 35 }), "s16le"),
					open: true,
					quieted: false,
				},
			],
		],
		[
			"voice on unquieted noise",
			"nfm",
			[
				{
					pcm: toPcm(
						mix(
							voiceLike({ rate: RATE, seconds: 4, seed: 36 }),
							whiteNoise({ rate: RATE, seconds: 4, seed: 37, level: 0.3 }),
						),
						"s16le",
					),
					open: true,
					quieted: false,
				},
			],
		],
	]

	for (const [name, modulation, segments] of NEVER) {
		// Validates: Requirements 8.1, 1.3, 1.4
		it(`${name}: never opens and the client receives only zeros`, async () => {
			const result = await drive(modulation, segments)
			expect(result.everOpen).toBe(false)
			expect(result.received.length).toBe(
				segments.reduce((sum, s) => sum + s.pcm.length, 0),
			)
			expect(result.received.every(b => b === 0)).toBe(true)
		})
	}

	// Amendment A8 (2026-10-23): AM is outside the evidence path. A bare AM carrier key-up latched
	// voice 1.65 s after onset under the gate (the AM chain's fast AGC raises the carrier noise
	// envelope), so AM auto keeps the frozen stage-1 auto squelch with `autoSquelch` `off`.
	// SHA-256 of the complete client byte stream and of the `pcm` event stream for each input
	// below, recorded with this same harness from the pre-evidence-squelch code (commit
	// d9eee19a). The frozen path passes every byte, so the two streams are equal there.
	const AM_FROZEN: Array<[string, string, () => Segment[]]> = [
		[
			"am-carrier regression: AM stays ungated by evidence",
			"e4a4223024756fe5b48758efb1eaeda82d24182ff0dc6780826cf501d62aff9b",
			() => {
				const audio = fixtureAt25k("am-carrier")
				const onset = Math.round(0.25 * RATE)
				return [
					{
						pcm: toPcm(audio.subarray(0, onset), "s16le"),
						open: false,
						quieted: false,
					},
					{
						pcm: toPcm(audio.subarray(onset), "s16le"),
						open: true,
						quieted: true,
					},
				]
			},
		],
		[
			"AM voice: stage-1 auto squelch, ungated by evidence",
			"e46e1a36d3fb3dc4703868f4b58248574e48a787b268f6638aa3203ce7742560",
			() => overScript(overVoice(26)),
		],
		[
			"bare AM carrier: stage-1 auto squelch, ungated by evidence",
			"77a5ec96e2c231d5d1cc158e1977d9dfeff128ddec3363629e591e5ae52a736e",
			() => [
				{
					pcm: toPcm(carrierSilence({ rate: RATE, seconds: 4 }), "s16le"),
					open: true,
					quieted: true,
				},
			],
		],
	]

	for (const [name, frozenSha256, script] of AM_FROZEN) {
		// Validates: Requirements 1.7 (amendment A8)
		it(name, async () => {
			const segments = script()
			const result = await drive("am", segments)
			expect(sha256(result.received)).toBe(frozenSha256)
			expect(sha256(result.pcm)).toBe(frozenSha256)
			expect([...result.states]).toEqual(["off"])
			// Stage 1 open passes every byte; closed segments are the frozen path's zeros.
			let at = 0
			for (const segment of segments) {
				const got = result.received.subarray(at, at + segment.pcm.length)
				if (segment.open) expect(got).toEqual(segment.pcm)
				at += segment.pcm.length
			}
		})
	}

	// Validates: Requirements 2.1, 1.6
	it("a WAV client receives the unchanged header once, then the gated audio", async () => {
		const over = overVoice(41)
		const result = await drive("nfm", overScript(over), true)
		const body = result.wavBody
		if (body === null) throw new Error("no wav body")
		const header = wavStreamHeader({ rate: RATE, format: "s16le" })
		expect(body.subarray(0, header.length)).toEqual(header)
		expect(body.indexOf(Buffer.from("RIFF"), 1)).toBe(-1)
		expect(body.subarray(header.length)).toEqual(result.received)
	})
})

/** An HTTP client on the harness's own (free, loopback) port; resolves once `bytes` of audio arrive. */
async function openWavClient(
	h: Harness,
	rate: number,
): Promise<{ done(bytes: number): Promise<Buffer> }> {
	const port = h.demod.getStatus().config.httpPort
	const chunks: Buffer[] = []
	let length = 0
	let res: http.IncomingMessage | null = null
	await new Promise<void>((resolve, reject) => {
		const req = http.get(
			{ host: "127.0.0.1", port, path: "/stream.wav" },
			response => {
				res = response
				response.on("data", (chunk: Buffer) => {
					chunks.push(chunk)
					length += chunk.length
				})
				resolve()
			},
		)
		req.on("error", reject)
	})
	const headerBytes = wavStreamHeader({ rate, format: "s16le" }).length
	await waitFor(() => h.demod.getStatus().clientCount >= 1)
	return {
		async done(bytes: number) {
			await waitFor(() => length >= headerBytes + bytes)
			;(res as http.IncomingMessage | null)?.destroy()
			return Buffer.concat(chunks)
		},
	}
}
