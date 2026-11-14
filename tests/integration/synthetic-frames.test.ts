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
import { dstarFrequency } from "../../scripts/fixtures/dstar-gmsk.mjs"
import { flexFrequency } from "../../scripts/fixtures/flex-fsk.mjs"
import { fmCu8 } from "../../scripts/fixtures/fsk-iq.mjs"
import { p25Frequency } from "../../scripts/fixtures/p25-c4fm.mjs"
import { ysfFrequency } from "../../scripts/fixtures/ysf-c4fm.mjs"
import { presentDecoderOutput } from "../../src/core/activity/presentation/registry.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import { createInterpreterState } from "../../src/core/scanner/probes/confirm/double-match.js"
import { interpretDsdFme } from "../../src/core/scanner/probes/confirm/dsd-fme.js"
import { interpretMultimon } from "../../src/core/scanner/probes/confirm/multimon.js"
import type { DecodeEvidence } from "../../src/core/scanner/types.js"
import {
	DirewolfDecoder,
	extractKissFrames,
	parseKissFrame,
} from "../../src/decoders/builtin/direwolf.js"
import { DsdFmeDecoder } from "../../src/decoders/builtin/dsd-fme.js"
import type { DsdFmeLinkLine } from "../../src/decoders/builtin/dsd-fme-link.js"
import { MultimonDecoder } from "../../src/decoders/builtin/multimon-ng.js"
import type { DecoderOutput } from "../../src/decoders/types.js"
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
/** Spacing of replayed decoder lines: about one frame each. */
const LINE_MS = 100
/** DsdFmeDecoder's call timer period (CALL_TIMEOUT_CHECK_INTERVAL_MS). */
const TIMER_MS = 500

const CRATE = resolve(__dirname, "../../native/wavekit-chan")
const chanUnavailable =
	process.env["WAVEKIT_CHAN_BIN"] === undefined
		? wavekitChanBuildUnavailable(CRATE)
		: undefined
let CHAN = process.env["WAVEKIT_CHAN_BIN"] ?? ""
let TARGET = ""
let ROOT = ""

const silent = pino({ level: "silent" })
type Feed = (line: string) => void
const feeder = (decoder: object): Feed => line =>
	(decoder as { handleOutputLine(line: string): void }).handleOutputLine(line)

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

interface Replay {
	outputs: DecoderOutput[]
	links: DsdFmeLinkLine[]
	evidence: DecodeEvidence[]
	lines: string[]
}

/** Feeds decoder lines on a fake clock, then idles past the call timeout. */
function replay(
	lines: string[],
	decoder: DsdFmeDecoder | MultimonDecoder,
	interpret: (out: DecoderOutput, link?: DsdFmeLinkLine) => DecodeEvidence[],
): Replay {
	const outputs: DecoderOutput[] = []
	const links: DsdFmeLinkLine[] = []
	const evidence: DecodeEvidence[] = []
	decoder.on("output", (out: DecoderOutput) => {
		outputs.push(out)
		evidence.push(...interpret(out))
	})
	decoder.on("link", (line: DsdFmeLinkLine) => {
		links.push(line)
		evidence.push(...interpret(undefined as unknown as DecoderOutput, line))
	})
	const feed = feeder(decoder)
	// dsd-fme's call_start/call_end timer (every 500 ms once started).
	const timer = (
		decoder as unknown as { checkCallTimeoutAsync?: () => void }
	).checkCallTimeoutAsync?.bind(decoder)
	let at = T0
	let tick = T0 + TIMER_MS
	const advance = (to: number) => {
		for (; tick <= to; tick += TIMER_MS) {
			vi.setSystemTime(tick)
			timer?.()
		}
		vi.setSystemTime(to)
	}
	for (const line of lines) {
		if (line.trim() === "") continue
		at += LINE_MS
		advance(at)
		feed(line)
	}
	advance(at + 10_000)
	return { outputs, links, evidence, lines }
}

function dsdInterpreter() {
	const state = createInterpreterState({ epoch: 1, origin: "probe" })
	return (out: DecoderOutput, link?: DsdFmeLinkLine) => {
		if (link) return interpretDsdFme({ kind: "link", line: link }, state)
		if (out.type !== "call_start" && out.type !== "call_end") return []
		return interpretDsdFme(
			{
				kind: out.type,
				at: out.timestamp.getTime(),
				call: out.data as never,
			},
			state,
		)
	}
}

function multimonInterpreter() {
	const state = createInterpreterState({ epoch: 1, origin: "probe" })
	return (out: DecoderOutput) => (out ? interpretMultimon(out, state) : [])
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
	interpreter: () => (
		out: DecoderOutput,
		link?: DsdFmeLinkLine,
	) => DecodeEvidence[]
	check: (result: Replay) => void
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
					: { mode, inputSampleRate: capture.rateHz, offsetHz: capture.offsetHz },
		},
		silent,
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

/** The decoder lines worth showing in a failure message. */
const transcript = (r: Replay) =>
	r.lines
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.filter(line => /Sync:|FLEX|Group|Source|SRC/.test(line))
		.concat(
			r.outputs.map(o => `output ${o.type} ${JSON.stringify(o.data)}`),
			r.links.map(l => `link ${JSON.stringify(l)}`),
		)
		.join("\n")

const firstCall = (r: Replay) =>
	r.outputs.find(o => o.type === "call_start")?.data as
		| Record<string, unknown>
		| undefined

const CASES: ChainCase[] = [
	{
		name: "D-STAR (dsd-fme auto, the catalogue default)",
		tool: "dsd-fme",
		freq: () =>
			dstarFrequency({
				rpt2: "DIRECT",
				rpt1: "DIRECT",
				ur: "CQCQCQ",
				my: "N0CALL",
				suffix: "TEST",
			}),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: r => {
			const call = firstCall(r)
			expect(call, transcript(r)).toMatchObject({
				protocol: "dstar",
				dstar: { my: "N0CALL", ur: "CQCQCQ", rpt1: "DIRECT", rpt2: "DIRECT" },
			})
			expect(r.links).toContainEqual(
				expect.objectContaining({
					protocol: "dstar",
					callsign: "N0CALL",
					verified: true,
				}),
			)
			expect(r.evidence).toContainEqual(
				expect.objectContaining({
					protocol: "dstar",
					identity: { kind: "dstar-call", value: "N0CALL" },
				}),
			)
			const row = presentDecoderOutput(
				r.outputs.find(o => o.type === "call_start")!,
				"dsd-fme",
			)
			expect(row?.title).toContain("N0CALL")
		},
	},
	{
		name: "YSF (dsd-fme auto, the catalogue default)",
		tool: "dsd-fme",
		freq: () => ysfFrequency({ dest: "ALL", src: "N0CALL", dgid: 21 }),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: r => {
			const call = firstCall(r)
			expect(call, transcript(r)).toMatchObject({
				protocol: "ysf",
				ysf: { callsign: "N0CALL" },
			})
			expect(r.links).toContainEqual(
				expect.objectContaining({
					protocol: "ysf",
					callsign: "N0CALL",
					verified: true,
				}),
			)
			expect(r.evidence).toContainEqual(
				expect.objectContaining({
					protocol: "ysf",
					metadata: expect.objectContaining({ callsigns: ["N0CALL"] }),
				}),
			)
			const row = presentDecoderOutput(
				r.outputs.find(o => o.type === "call_start")!,
				"dsd-fme",
			)
			expect(row?.title).toContain("N0CALL")
		},
	},
	{
		name: "P25 phase 1 (dsd-fme auto, the catalogue default)",
		tool: "dsd-fme",
		freq: () => p25Frequency({ nac: 0x2a5, talkgroup: 4321, source: 1_234_567 }),
		adapter: (path, capture) => dsd(path, capture, "auto"),
		channelHead: DSD_HEAD,
		interpreter: dsdInterpreter,
		check: r => {
			const call = firstCall(r)
			expect(call, transcript(r)).toMatchObject({
				protocol: "p25p1",
				talkgroup: 4321,
				source: 1_234_567,
				p25: { nac: "2A5" },
			})
			expect(r.links).toContainEqual(
				expect.objectContaining({
					protocol: "p25",
					tg: "4321",
					src: "1234567",
					verified: true,
				}),
			)
			expect(r.evidence).toContainEqual(
				expect.objectContaining({
					protocol: "p25p1",
					metadata: expect.objectContaining({
						talkgroups: ["4321"],
						sources: ["1234567"],
					}),
				}),
			)
			const row = presentDecoderOutput(
				r.outputs.find(o => o.type === "call_start")!,
				"dsd-fme",
			)
			expect(row).toMatchObject({ title: "P25P1 TG 4321 from 1234567" })
		},
	},
	{
		name: "FLEX (multimon-ng)",
		tool: "multimon-ng",
		freq: () =>
			flexFrequency({ capcode: 1_234_567, message: "SYNTHETIC FLEX PAGE 42" }),
		adapter: (path, capture) =>
			new MultimonProbe(
				{
					id: "pager",
					type: "multimon-ng",
					enabled: true,
					options:
						path === "channel"
							? { modes: ["FLEX"], inputSampleRate: 48_000, inputIqFormat: "cf32" }
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
		check: r => {
			const page = r.outputs.find(o => o.type === "message")
			expect(page?.data, transcript(r)).toMatchObject({
				protocol: "FLEX",
				capcode: "001234567",
				messageType: "ALN",
				message: "SYNTHETIC FLEX PAGE 42",
			})
			expect(r.evidence).toContainEqual(
				expect.objectContaining({ protocol: "flex" }),
			)
			const row = presentDecoderOutput(page!, "multimon-ng")
			expect(row?.title).toContain("SYNTHETIC FLEX PAGE 42")
		},
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
			it.skipIf(!toolAvailable(c.tool, ["-h"]) || chanUnavailable !== undefined)(
				`${label}: channel path decodes`,
				async () => {
					const iq = fmCu8(c.freq(), {
						sampleRateHz: capture.rateHz,
						offsetHz: capture.offsetHz,
						seed: capture.rateHz,
					})
					// The production adapter (raw options, offsetHz) asks for its channel;
					// the manager then feeds it channel IQ (inputIqFormat cf32).
					const request = c
						.adapter("raw", capture)
						.getChannelRequest({
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
					expect(cf32!.length).toBeGreaterThan(8 * 48_000)
					const stages = probe.pipeline().split(" | ")
					const soxAt = stages.findIndex(s => s.startsWith("sox "))
					expect(stages.slice(0, soxAt)).toEqual(c.channelHead.stages)
					const dir = workDir(ROOT, "chan")
					const file = join(dir, "in")
					writeFileSync(file, HAS_CSDR ? cf32! : csdrFmHead(cf32!, c.channelHead.gain))
					const command = HAS_CSDR
						? stages.join(" | ")
						: stages.slice(soxAt).join(" | ")
					const { lines } = runShell(command, file, dir)
					rmSync(dir, { recursive: true, force: true })
					c.check(replay(lines, c.adapter("channel", capture), c.interpreter()))
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
					c.check(replay(lines, c.adapter("raw", capture), c.interpreter()))
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
					options: { inputSampleRate: capture.rateHz, offsetHz: capture.offsetHz },
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
			const client = [
				"const net=require('net'),fs=require('fs');const out=[];let t=0;",
				"const go=()=>{const s=net.connect(" + kissPort + ",'127.0.0.1');",
				"s.on('data',d=>out.push(d));s.on('close',()=>{fs.writeFileSync(" +
					JSON.stringify(kiss) +
					",Buffer.concat(out));process.exit(0)});",
				"s.on('error',()=>{if(++t<100)setTimeout(go,100);else process.exit(1)})};go()",
			].join("")
			// direwolf binds KISS at start; the audio waits until the client is in.
			const command = `(sleep 3; cat) | (${probe.pipeline()}) & node -e "${client}"; wait`
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
