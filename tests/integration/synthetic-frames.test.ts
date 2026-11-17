/**
 * Synthetic transmissions through the real decoder chains (no on-air capture).
 *
 * Each protocol's generator (scripts/fixtures/*-{afsk,fsk,gmsk,c4fm}.mjs)
 * builds a valid transmission at the bit level (sync, framing, CRC/FEC,
 * modulation) with made-up identities, FM-modulated as cu8 IQ at an offset
 * inside a 1.024 or 2.4 Msps capture. Then:
 *
 * - channel path: wavekit-chan (built from native/ into a tmp target, as in
 *   paging-raster-wavekit-chan.test.ts) with the adapter's own channel
 *   request, then the adapter's production command line for channel IQ;
 * - raw path (csdr installed, i.e. in the core image): the adapter's
 *   production command line for the raw cu8 capture with offsetHz.
 * Without csdr the channel path's csdr FM head is done in-process
 * (synthetic-chain.ts) and the exact tail from sox on runs. The decoder's
 * output lines then go through the adapter's parser on a fake clock, and
 * the test checks the decoded fields, the scanner's link/evidence and the
 * Activity row presentation.
 *
 * Binaries missing on this host skip their cases with the reason. To run
 * every case in the core image: WAVEKIT_SYNTH_IMAGE=<image> (see
 * synthetic-chain.ts; the host still builds wavekit-chan).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pino from "pino"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { aprsFrequency } from "../../scripts/fixtures/aprs-afsk.mjs"
import { dmrFrequency } from "../../scripts/fixtures/dmr-4fsk.mjs"
import { dpmrFrequency } from "../../scripts/fixtures/dpmr-4fsk.mjs"
import {
	dstarFrequency,
	dstarOversFrequency,
	dstarSpecFrequency,
} from "../../scripts/fixtures/dstar-gmsk.mjs"
import { flexFrequency } from "../../scripts/fixtures/flex-fsk.mjs"
import {
	AIR_SHAPES,
	EASY_SHAPE,
	fmCu8,
} from "../../scripts/fixtures/fsk-iq.mjs"
import {
	nxdnCallsFrequency,
	nxdnFrequency,
} from "../../scripts/fixtures/nxdn-4fsk.mjs"
import { p25Frequency } from "../../scripts/fixtures/p25-c4fm.mjs"
import {
	ysfFrequency,
	ysfOversFrequency,
} from "../../scripts/fixtures/ysf-c4fm.mjs"
import { presentDecoderOutput } from "../../src/core/activity/presentation/registry.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import {
	DirewolfDecoder,
	extractKissFrames,
	parseKissFrame,
} from "../../src/decoders/builtin/direwolf.js"
import { DsdFmeDecoder } from "../../src/decoders/builtin/dsd-fme.js"
import { MultimonDecoder } from "../../src/decoders/builtin/multimon-ng.js"
import {
	DSTAR_LINE_MS,
	SYNTHETIC,
	checkDmr,
	checkDpmr,
	checkDstar,
	checkDstarOvers,
	checkDstarSpec,
	checkFlex,
	checkNxdn,
	checkNxdnAB,
	checkP25,
	checkP25Rekey,
	checkYsf,
	checkYsfOvers,
	dsdInterpreter,
	multimonInterpreter,
	replay,
} from "../helpers/synthetic-decodes.js"
import type { Interpreter, Replay } from "../helpers/synthetic-decodes.js"
import {
	HAS_CSDR,
	SYNTH_IMAGE,
	channelize,
	csdrFmHead,
	runShell,
	toolAvailable,
	workDir,
} from "./synthetic-chain.js"
import {
	buildWavekitChan,
	wavekitChanBuildUnavailable,
} from "./wavekit-chan-build.js"

const CENTRE_HZ = 433_000_000
/** Capture rates and channel offsets, inside the channelizer's 0.8 usable fraction. */
const CAPTURES = [
	{ rateHz: 1_024_000, offsetHz: 162_500 },
	{ rateHz: 2_400_000, offsetHz: -287_500 },
] as const
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
/** One DMR burst per printed line (30 ms; both slots print). */
const DMR_LINE_MS = 30

const CRATE = resolve(__dirname, "../../native/wavekit-chan")
const chanUnavailable =
	process.env["WAVEKIT_CHAN_BIN"] === undefined
		? wavekitChanBuildUnavailable(CRATE)
		: undefined
let CHAN = process.env["WAVEKIT_CHAN_BIN"] ?? ""
let TARGET = ""
let ROOT = ""

const silent = pino({ level: "silent" })

class DsdProbe extends DsdFmeDecoder {
	pipeline(): string {
		return this.buildPipelineCommand()
	}
}
class MultimonProbe extends MultimonDecoder {
	pipeline(): string {
		return this.buildPipelineCommand()
	}
}
class DirewolfProbe extends DirewolfDecoder {
	pipeline(): string {
		return this.buildPipelineCommand()
	}
	async writeConfig(root: string): Promise<void> {
		this.configRoot = root
		this.baseConfigPath = join(root, "no-base.conf")
		await this.writeInstanceConfig()
	}
}

type Path = "channel" | "raw"

interface ChainCase {
	name: string
	tool: string
	freq: () => Float64Array
	/** Adapter for a path: channel IQ (cf32 at 48 kHz) or the raw capture. */
	adapter: (
		path: Path,
		capture: (typeof CAPTURES)[number],
	) => DsdProbe | MultimonProbe
	/** The csdr head stages of the channel command, with the gain the JS head applies. */
	channelHead: { stages: string[]; gain: number }
	interpreter: () => Interpreter
	check: (result: Replay) => void
	/** Replay spacing of the decoder's lines (default one frame, 100 ms). */
	lineMs?: number
}

const dsd = (path: Path, capture: (typeof CAPTURES)[number], mode: string) =>
	new DsdProbe(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options:
				path === "channel"
					? { mode, inputSampleRate: 48_000, inputIqFormat: "cf32" }
					: {
							mode,
							inputSampleRate: capture.rateHz,
							offsetHz: capture.offsetHz,
						},
		},
		silent,
		// Elapsed time follows the fake Date (vi.setSystemTime).
		{ mono: () => Date.now(), wall: () => Date.now() },
	)
const DSD_HEAD = {
	stages: [
		"csdr fmdemod",
		"csdr gain 2",
		"csdr limit",
		"csdr convert -i float -o s16",
	],
	gain: 2,
}

const CASES: ChainCase[] = [
	{
		name: "DMR repeater downlink (dsd-fme auto, the catalogue default)",
		tool: "dsd-fme",
		freq: () => dmrFrequency(SYNTHETIC.dmr),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkDmr,
		lineMs: DMR_LINE_MS,
	},
	{
		name: "D-STAR (dsd-fme auto, the catalogue default)",
		tool: "dsd-fme",
		freq: () => dstarFrequency(SYNTHETIC.dstar),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkDstar,
		lineMs: DSTAR_LINE_MS,
	},
	{
		name: "YSF (dsd-fme auto, the catalogue default)",
		tool: "dsd-fme",
		// Four V/D2 superframes: the checked SRC comes in six frames (HC, each
		// FN 2/7, TC). dsd-fme loses up to a quarter of YSF frames at some symbol
		// clock phases even without noise (dsd-fme-margin.test.ts), and each
		// capture rate fixes one phase, so one superframe can miss them all.
		freq: () =>
			ysfFrequency(
				{ ...SYNTHETIC.ysf, superframes: 4 },
				{ shape: AIR_SHAPES.ysf },
			),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkYsf,
	},
	{
		name: "P25 phase 1 (dsd-fme auto, the catalogue default)",
		tool: "dsd-fme",
		freq: () => p25Frequency(SYNTHETIC.p25, { shape: AIR_SHAPES.p25 }),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkP25,
	},
	...(["nxdn48", "nxdn96"] as const).map(
		(variant): ChainCase => ({
			name: `${variant.toUpperCase()} (dsd-fme mode ${variant === "nxdn96" ? "nxdn" : variant})`,
			tool: "dsd-fme",
			// NXDN48 with its standard transmit filter (root raised cosine 0.2
			// times x / sin x), which the adapter's NXDN receive filter matches.
			// NXDN96 keeps the raised cosine 0.5: dsd-fme's NXDN96 frame sync did
			// not lock on a roll-off below 0.5 with any input filter (measured on
			// the host build; dsd-fme-margin.test.ts).
			freq: () =>
				nxdnFrequency(SYNTHETIC.nxdn, {
					variant,
					shape: variant === "nxdn48" ? AIR_SHAPES.nxdn : EASY_SHAPE,
				}),
			adapter: (path, capture) =>
				dsd(path, capture, variant === "nxdn96" ? "nxdn" : variant),
			channelHead: DSD_HEAD,
			interpreter: dsdInterpreter,
			check: checkNxdn(variant),
		}),
	),
	{
		name: "P25 phase 1 keyed up twice (HDU/LDU1/LDU2/TDU each)",
		tool: "dsd-fme",
		freq: () =>
			p25Frequency({ ...SYNTHETIC.p25, rekeys: 1 }, { shape: AIR_SHAPES.p25 }),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkP25Rekey,
	},
	{
		name: "D-STAR back to back, the second slow-data header failed",
		tool: "dsd-fme",
		freq: () =>
			dstarOversFrequency([
				{ header: SYNTHETIC.dstar },
				{ header: SYNTHETIC.dstar, badFirstSlowData: true },
			]),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkDstarOvers,
		lineMs: DSTAR_LINE_MS,
	},
	{
		name: "D-STAR spec-shaped (sync in frame 0, text before the header)",
		tool: "dsd-fme",
		freq: () => dstarSpecFrequency(SYNTHETIC.dstar),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkDstarSpec,
		lineMs: DSTAR_LINE_MS,
	},
	{
		name: "YSF back to back, the second header's CSD1 failed",
		tool: "dsd-fme",
		freq: () =>
			ysfOversFrequency([SYNTHETIC.ysf, { ...SYNTHETIC.ysf, badCsd1: true }], {
				shape: AIR_SHAPES.ysf,
			}),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkYsfOvers,
	},
	...([true, false] as const).map(
		(release): ChainCase => ({
			name: `NXDN48 A then B ${release ? "with" : "without"} TX_REL`,
			tool: "dsd-fme",
			freq: () =>
				nxdnCallsFrequency(
					[
						{ ...SYNTHETIC.nxdn, release },
						{ ...SYNTHETIC.nxdnB, release },
					],
					{ shape: AIR_SHAPES.nxdn },
				),
			adapter: (path, capture) => dsd(path, capture, "nxdn48"),
			channelHead: DSD_HEAD,
			interpreter: dsdInterpreter,
			check: checkNxdnAB(release),
		}),
	),
	{
		name: "dPMR (dsd-fme mode dpmr)",
		tool: "dsd-fme",
		freq: () => dpmrFrequency(SYNTHETIC.dpmr, { shape: AIR_SHAPES.dpmr }),
		adapter: (path, capture) => dsd(path, capture, "dpmr"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: checkDpmr,
	},
	{
		name: "FLEX (multimon-ng)",
		tool: "multimon-ng",
		freq: () => flexFrequency(SYNTHETIC.flex),
		adapter: (path, capture) =>
			new MultimonProbe(
				{
					id: "pager",
					type: "multimon-ng",
					enabled: true,
					options:
						path === "channel"
							? {
									modes: ["FLEX"],
									inputSampleRate: 48_000,
									inputIqFormat: "cf32",
								}
							: {
									modes: ["FLEX"],
									inputSampleRate: capture.rateHz,
									offsetHz: capture.offsetHz,
								},
				},
				silent,
			),
		channelHead: {
			stages: [
				"csdr agc -f complex -p slow -r 0.7",
				"csdr fmdemod",
				"csdr gain 3",
				"csdr limit",
				"csdr convert -i float -o s16",
			],
			gain: 3,
		},
		interpreter: multimonInterpreter,
		check: checkFlex,
	},
]

describe("synthetic frames through the production decoder chains", () => {
	beforeAll(async () => {
		ROOT = mkdtempSync(join(tmpdir(), "wk-synth-"))
		if (CHAN === "" && chanUnavailable === undefined) {
			TARGET = mkdtempSync(join(tmpdir(), "wavekit-chan-target-"))
			CHAN = await buildWavekitChan(CRATE, TARGET)
		}
	}, 600_000)
	afterAll(() => {
		vi.useRealTimers()
		if (TARGET) rmSync(TARGET, { recursive: true, force: true })
		if (ROOT) rmSync(ROOT, { recursive: true, force: true })
	})

	for (const c of CASES)
		for (const capture of CAPTURES) {
			const label = `${c.name} at ${capture.rateHz / 1e6} Msps, ${capture.offsetHz} Hz`
			it.skipIf(
				!toolAvailable(c.tool, ["-h"]) || chanUnavailable !== undefined,
			)(
				`${label}: channel path decodes`,
				async () => {
					const freq = c.freq()
					const iq = fmCu8(freq, {
						sampleRateHz: capture.rateHz,
						offsetHz: capture.offsetHz,
						seed: capture.rateHz,
					})
					// The production adapter (raw options, offsetHz) asks for its channel;
					// the manager then feeds it channel IQ (inputIqFormat cf32).
					const request = c.adapter("raw", capture).getChannelRequest({
						sampleRateHz: capture.rateHz,
						centerHz: CENTRE_HZ,
					}) as DecoderChannelRequest
					expect(request.centerHz).toBe(CENTRE_HZ + capture.offsetHz)
					expect(request.outputRateHz).toBe(48_000)
					const [cf32] = await channelize(
						CHAN,
						iq,
						{ rateHz: capture.rateHz, centerHz: CENTRE_HZ },
						[request],
					)
					const probe = c.adapter("channel", capture)
					// The whole transmission comes out (cf32: 8 bytes a sample at 48 kHz).
					expect(cf32!.length).toBeGreaterThan(8 * freq.length * 0.9)
					const stages = probe.pipeline().split(" | ")
					const soxAt = stages.findIndex(s => s.startsWith("sox "))
					expect(stages.slice(0, soxAt)).toEqual(c.channelHead.stages)
					const dir = workDir(ROOT, "chan")
					const file = join(dir, "in")
					writeFileSync(
						file,
						HAS_CSDR ? cf32! : csdrFmHead(cf32!, c.channelHead.gain),
					)
					const command = HAS_CSDR
						? stages.join(" | ")
						: stages.slice(soxAt).join(" | ")
					const { lines } = runShell(command, file, dir)
					rmSync(dir, { recursive: true, force: true })
					c.check(
						replay(
							lines,
							c.adapter("channel", capture),
							c.interpreter(),
							c.lineMs,
						),
					)
				},
				120_000,
			)
			it.skipIf(!HAS_CSDR || !toolAvailable(c.tool, ["-h"]))(
				`${label}: raw capture path decodes`,
				() => {
					const iq = fmCu8(c.freq(), {
						sampleRateHz: capture.rateHz,
						offsetHz: capture.offsetHz,
						seed: capture.rateHz + 1,
					})
					const probe = c.adapter("raw", capture)
					const dir = workDir(ROOT, "raw")
					const file = join(dir, "in.cu8")
					writeFileSync(file, iq)
					const { lines } = runShell(probe.pipeline(), file, dir)
					rmSync(dir, { recursive: true, force: true })
					c.check(
						replay(lines, c.adapter("raw", capture), c.interpreter(), c.lineMs),
					)
				},
				120_000,
			)
		}

	// direwolf publishes frames on its KISS port only. In the image the KISS
	// client is node inside the same --network none container; the bytes go
	// through the adapter's own KISS and AX.25 parsers here.
	it.skipIf(SYNTH_IMAGE === "" || chanUnavailable !== undefined)(
		"APRS through direwolf (channel path, KISS) decodes the AX.25 source",
		async () => {
			const capture = CAPTURES[0]
			const iq = fmCu8(
				aprsFrequency({
					source: "N0CALL-7",
					destination: "APRS",
					path: ["WIDE1-1"],
					info: "!4903.50N/07201.75W-synthetic",
				}),
				{ sampleRateHz: capture.rateHz, offsetHz: capture.offsetHz },
			)
			const dir = workDir(ROOT, "aprs")
			const kissPort = 38_001
			const probe = new DirewolfProbe(
				{
					id: "aprs",
					type: "direwolf",
					enabled: true,
					options: { inputSampleRate: 48_000, inputIqFormat: "cf32", kissPort },
				},
				silent,
			)
			await probe.writeConfig(dir)
			const request = new DirewolfProbe(
				{
					id: "aprs-raw",
					type: "direwolf",
					enabled: true,
					options: {
						inputSampleRate: capture.rateHz,
						offsetHz: capture.offsetHz,
					},
				},
				silent,
			).getChannelRequest({
				sampleRateHz: capture.rateHz,
				centerHz: CENTRE_HZ,
			}) as DecoderChannelRequest
			const [cf32] = await channelize(
				CHAN,
				iq,
				{ rateHz: capture.rateHz, centerHz: CENTRE_HZ },
				[request],
			)
			const file = join(dir, "in")
			writeFileSync(file, cf32!)
			const kiss = join(dir, "kiss.bin")
			// The KISS client, a file (no shell quoting): appends every chunk and
			// exits when direwolf closes the port or 20 s after connecting.
			const client = join(dir, "kiss-client.cjs")
			writeFileSync(
				client,
				[
					"const net = require('net'), fs = require('fs')",
					`const out = ${JSON.stringify(kiss)}`,
					"fs.writeFileSync(out, Buffer.alloc(0))",
					"let tries = 0",
					"const go = () => {",
					`  const s = net.connect(${kissPort}, '127.0.0.1')`,
					"  s.on('connect', () => setTimeout(() => process.exit(0), 20000))",
					"  s.on('data', d => fs.appendFileSync(out, d))",
					"  s.on('close', () => { if (s.bytesRead > 0 || tries >= 100) process.exit(0) })",
					"  s.on('error', () => { if (++tries < 100) setTimeout(go, 100) })",
					"}",
					"go()",
				].join("\n"),
			)
			// dash gives a background list /dev/null as stdin: the audio is read
			// from the file explicitly, 3 s after direwolf starts binding KISS.
			const command = `(sleep 3; cat "${file}") | (${probe.pipeline()}) & P=$!; node "${client}"; kill $P 2>/dev/null; wait`
			const { lines } = runShell(command, file, dir, 90_000)
			const bytes = readFileSync(kiss)
			rmSync(dir, { recursive: true, force: true })
			const frames = extractKissFrames(bytes).frames.map(parseKissFrame)
			expect(frames, lines.join("\n")).toContainEqual(
				expect.objectContaining({ source: "N0CALL-7", destination: "APRS" }),
			)
			const row = presentDecoderOutput(
				{
					timestamp: new Date(T0),
					decoder: "aprs",
					type: "aprs",
					data: frames.find(f => f?.source === "N0CALL-7")!,
				},
				"direwolf",
			)
			expect(row?.title).toContain("N0CALL-7")
		},
		120_000,
	)
})
