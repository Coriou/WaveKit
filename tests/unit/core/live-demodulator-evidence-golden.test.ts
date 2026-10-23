/**
 * Evidence squelch goldens (docs/specs/evidence-squelch, requirements 1.6-1.9, 3.2), recorded
 * from the frozen code at d9eee19a before `src/core/live-demodulator.ts` changed: SHA-256 of the
 * bytes a client receives (the registry) and of the concatenated `pcm` event bytes for a fixed
 * 3 s PCM script out of the fake back stage, with stage 1 scripted open/closed per chunk.
 * `auto` × `nfm`/`am` pins the `pcm` event only (its client bytes change by design).
 */
import { createHash } from "node:crypto"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import type { EvidenceSquelchFactory } from "../../../src/core/evidence-squelch/contract.js"
import { WaveKitError } from "../../../src/utils/errors.js"
import {
	createDemodHarness,
	writeAndSettle,
} from "./live-demodulator-continuity-fakes.js"
import { fskBursts, toPcm, voiceLike } from "./evidence-squelch/synthetic.js"

type Harness = Awaited<ReturnType<typeof createDemodHarness>>

interface GoldenCase {
	name: string
	config: Record<string, unknown>
	pcmOnly?: boolean
}

const MODULATIONS = ["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"]
const CHUNK_SIZES = [1, 333, 4_096, 65_536]
const CTCSS = { kind: "ctcss", frequencyTenthsHz: 670 }
const DCS = { kind: "dcs", code: "023", polarity: "normal" }

const CASES: GoldenCase[] = [
	...MODULATIONS.map(modulation => ({
		name: `manual ${modulation}`,
		config: { modulation, squelchMode: "manual" },
	})),
	...["nfm", "wfm"].map(modulation => ({
		name: `noise ${modulation}`,
		config: { modulation, squelchMode: "noise" },
	})),
	...(["auto", "manual"] as const).flatMap(squelchMode => [
		{
			name: `ctcss 67.0 nfm ${squelchMode}`,
			config: { modulation: "nfm", squelchMode, toneSquelch: CTCSS },
		},
		{
			name: `dcs 023N nfm ${squelchMode}`,
			config: { modulation: "nfm", squelchMode, toneSquelch: DCS },
		},
	]),
	// Amendment A8: AM is outside the evidence path (stage-1 auto squelch, frozen).
	...["wfm", "am", "usb", "lsb", "dsb", "cw", "raw"].map(modulation => ({
		name: `auto ${modulation}`,
		config: { modulation, squelchMode: "auto" },
	})),
	...["nfm"].map(modulation => ({
		name: `auto ${modulation} pcm`,
		config: { modulation, squelchMode: "auto" },
		pcmOnly: true,
	})),
]

/** 1 s voice, 1 s silence, 1 s 2-FSK at the run's rate, s16le. */
function goldenScript(rate: number): Buffer {
	const voice = voiceLike({ rate, seconds: 1, seed: 7 })
	const silence = new Float32Array(Math.round(rate))
	const fsk = fskBursts({
		rate,
		seconds: 1,
		levels: 2,
		baud: 1_200,
		burstMs: 300,
		gapMs: 100,
		seed: 11,
	})
	return Buffer.concat([
		toPcm(voice, "s16le"),
		toPcm(silence, "s16le"),
		toPcm(fsk, "s16le"),
	])
}

/** Stage 1 open for script seconds [0.2, 1.4) and [2.0, 2.8), judged at each chunk's start. */
function goldenStageOpen(byteOffset: number, rate: number): boolean {
	const seconds = byteOffset / 2 / rate
	return (seconds >= 0.2 && seconds < 1.4) || (seconds >= 2 && seconds < 2.8)
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex")
}

/** Scripts stage 1 through the fake squelch's `open` getter. */
function scriptStageOne(h: Harness): { open: boolean } {
	const control = { open: false }
	const run = h.internals.run
	if (run === null) throw new Error("no run")
	Object.defineProperty(run.squelch, "open", {
		configurable: true,
		get: () => control.open,
	})
	return control
}

async function runGoldenScript(
	h: Harness,
): Promise<{ registry: Buffer; pcm: Buffer }> {
	const pcmChunks: Buffer[] = []
	h.demod.on("pcm", (chunk: Buffer) => pcmChunks.push(Buffer.from(chunk)))
	const { transport } = h.addClient()
	const control = scriptStageOne(h)
	const run = h.internals.run
	if (run === null) throw new Error("no run")
	const rate = run.stream.rate
	const script = goldenScript(rate)
	const { back } = h.current()
	let offset = 0
	for (let i = 0; offset < script.length; i++) {
		const size = CHUNK_SIZES[i % CHUNK_SIZES.length] ?? 1
		const end = Math.min(script.length, offset + size)
		control.open = goldenStageOpen(offset, rate)
		await writeAndSettle(back.stdout, Buffer.from(script.subarray(offset, end)))
		offset = end
	}
	return { registry: transport.received(), pcm: Buffer.concat(pcmChunks) }
}

/** Unchanged script bytes (frozen: every client byte equals the `pcm` byte). */
const PASS = "387f4b5c11d62308ac33b528e3b53005c69caeaf244e94b55a49d52d86b838a2"
/** All zeros: the tone gate never qualifies the script (no tone in it). */
const MUTED = "dd3df6b01f055a24175224d8bd5cc6f2e9b5b29e7c027a1b137cdda762aee179"

const GOLDENS: Record<string, { registry?: string; pcm: string }> = {
	...Object.fromEntries(
		[
			...MODULATIONS.map(m => `manual ${m}`),
			"noise nfm",
			"noise wfm",
			...["wfm", "am", "usb", "lsb", "dsb", "cw", "raw"].map(m => `auto ${m}`),
		].map(name => [name, { registry: PASS, pcm: PASS }]),
	),
	...Object.fromEntries(
		[
			"ctcss 67.0 nfm auto",
			"dcs 023N nfm auto",
			"ctcss 67.0 nfm manual",
			"dcs 023N nfm manual",
		].map(name => [name, { registry: MUTED, pcm: PASS }]),
	),
	"auto nfm pcm": { pcm: PASS },
}

describe("live demodulator evidence goldens (frozen behaviour)", () => {
	let h: Harness | null = null
	afterEach(async () => {
		await h?.dispose()
		h = null
	})

	for (const testCase of CASES) {
		it(testCase.name, async () => {
			h = await createDemodHarness({ config: testCase.config })
			await h.demod.start()
			const { registry, pcm } = await runGoldenScript(h)
			const actual = {
				...(testCase.pcmOnly === true ? {} : { registry: sha256(registry) }),
				pcm: sha256(pcm),
			}
			if (process.env["RECORD_GOLDENS"] === "1")
				process.stdout.write(
					`GOLDEN ${JSON.stringify(testCase.name)}: ${JSON.stringify(actual)},\n`,
				)
			else expect(actual).toEqual(GOLDENS[testCase.name])
		})
	}
})

/** A5: a factory that throws leaves every run on the frozen stage-1 path (the oracle). */
const FROZEN_PATH: EvidenceSquelchFactory = {
	createGate() {
		throw new WaveKitError("frozen-path oracle", "TEST_ORACLE")
	},
	createPreRoll() {
		throw new WaveKitError("frozen-path oracle", "TEST_ORACLE")
	},
}

/** Configs outside the evidence path (requirements 1.7-1.9). */
const OUTSIDE: Record<string, unknown>[] = [
	...MODULATIONS.map(modulation => ({ modulation, squelchMode: "manual" })),
	...["nfm", "wfm"].map(modulation => ({
		modulation,
		squelchMode: "noise",
	})),
	// Amendment A8: AM auto is outside the evidence path.
	...["wfm", "am", "usb", "lsb", "dsb", "cw", "raw"].map(modulation => ({
		modulation,
		squelchMode: "auto",
	})),
	...(["auto", "manual"] as const).flatMap(squelchMode => [
		{ modulation: "nfm", squelchMode, toneSquelch: CTCSS },
		{ modulation: "nfm", squelchMode, toneSquelch: DCS },
	]),
	{
		modulation: "nfm",
		squelchMode: "auto",
		audioFormat: "f32le" as const,
		toneSquelch: CTCSS,
	},
	{ modulation: "am", squelchMode: "manual", audioFormat: "f32le" as const },
]

interface FeedInternals {
	options: { evidenceSquelch?: EvidenceSquelchFactory }
	run: { squelch: object } | null
	handleAudioData(chunk: Buffer): void
}

async function digests(
	config: Record<string, unknown>,
	chunks: ReadonlyArray<{ bytes: Uint8Array; open: boolean }>,
	factory: EvidenceSquelchFactory | undefined,
): Promise<{ registry: string; pcm: string }> {
	const harness = await createDemodHarness({ config })
	try {
		const internals = harness.demod as unknown as FeedInternals
		if (factory !== undefined) internals.options.evidenceSquelch = factory
		await harness.demod.start()
		const pcm: Buffer[] = []
		harness.demod.on("pcm", (chunk: Buffer) => pcm.push(Buffer.from(chunk)))
		const { transport } = harness.addClient()
		const control = scriptStageOne(harness)
		for (const chunk of chunks) {
			control.open = chunk.open
			internals.handleAudioData(Buffer.from(chunk.bytes))
		}
		return {
			registry: sha256(transport.received()),
			pcm: sha256(Buffer.concat(pcm)),
		}
	} finally {
		await harness.dispose()
	}
}

describe("evidence squelch byte-identical elsewhere (Property 12)", () => {
	// Feature: evidence-squelch, Property 12: Byte-identical elsewhere
	// Validates: Requirements 1.6, 1.7, 1.8, 1.9
	it("registry and pcm digests equal the frozen-path oracle", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...OUTSIDE),
				fc.array(
					fc.record({
						bytes: fc.uint8Array({ minLength: 1, maxLength: 2_000 }),
						open: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				async (config, chunks) => {
					const actual = await digests(config, chunks, undefined)
					const oracle = await digests(config, chunks, FROZEN_PATH)
					expect(actual).toEqual(oracle)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	it("the oracle discriminates: auto nfm (in the evidence path) differs", async () => {
		const chunks = [{ bytes: new Uint8Array(2_000).fill(7), open: true }]
		const config = { modulation: "nfm", squelchMode: "auto" }
		const actual = await digests(config, chunks, undefined)
		const oracle = await digests(config, chunks, FROZEN_PATH)
		expect(actual.pcm).toBe(oracle.pcm)
		expect(actual.registry).not.toBe(oracle.registry)
	})
})
