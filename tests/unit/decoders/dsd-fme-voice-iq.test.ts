import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { buildChannelizerArgs } from "../../../src/core/channelizer/channelizer-process.js"
import { encodeRequest } from "../../../src/core/channelizer/protocol.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"
import { writeExecutable } from "../../mocks/executables.js"
import { FAKE_WAVEKIT_CHAN } from "../../mocks/fake-wavekit-chan.js"

interface IqOptions {
	iq: string
	rate: number
	offset: number
	front: "csdr" | "chan"
	chanBin: string
}
interface FeedResult {
	discontinuities: number
	error: string | null
}
/** scripts/dsd-fme-voice-iq.mjs (plain JS, no declarations). */
interface VoiceIq {
	NOMINAL_CENTER_HZ: number
	ambeTolerance(csdr: number): number
	parseIqArgs(argv: string[]): IqOptions | null
	csdrFeedStages(rate: number, offset: number, chain: string): string[]
	chanFeedStages(chain: string): string[]
	chanArgs(rate: number, socketDir: string): string[]
	openRequest(offset: number): ChannelizerRequest
	chanFeed(options: IqOptions, sink: PassThrough): Promise<FeedResult>
	linkLines(decoded: string): Set<string>
}
const scriptUrl = (name: string) =>
	new URL(`../../../scripts/${name}`, import.meta.url)
const iq = (await import(scriptUrl("dsd-fme-voice-iq.mjs").href)) as VoiceIq
const BACK_CHAIN = /export const BACK_CHAIN = "([^"]+)"/.exec(
	readFileSync(fileURLToPath(scriptUrl("dsd-fme-voice-ab.mjs")), "utf8"),
)?.[1]
if (BACK_CHAIN === undefined) throw new Error("BACK_CHAIN not found")

const logger = pino({ level: "silent" })
const dsdFme = (options: Record<string, unknown>) =>
	new DsdFmeDecoder(
		{ id: "dsd", type: "dsd-fme", enabled: true, options },
		logger,
	)
const pipelineOf = (decoder: DsdFmeDecoder) =>
	(
		decoder as unknown as { buildPipelineCommand(): string }
	).buildPipelineCommand()

const root = mkdtempSync(join(tmpdir(), "voice-iq-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => vi.unstubAllEnvs())

// Core channelizer delta §5: the IQ mode of scripts/dsd-fme-voice-ab.mjs.
describe("dsd-fme voice A/B IQ mode", () => {
	it("parses --iq/--rate/--offset/--front and leaves the default mode alone", () => {
		expect(iq.parseIqArgs(["--chain", "csdr limit"])).toBeNull()
		expect(
			iq.parseIqArgs([
				"--iq",
				"run8.cu8",
				"--rate",
				"2048000",
				"--offset",
				"6000",
				"--front",
				"chan",
			]),
		).toEqual({
			iq: "run8.cu8",
			rate: 2_048_000,
			offset: 6000,
			front: "chan",
			chanBin: "wavekit-chan",
		})
		expect(
			iq.parseIqArgs([
				"--iq",
				"a.cu8",
				"--rate",
				"2400000",
				"--front",
				"csdr",
				"--chan-bin",
				"/opt/wavekit-chan",
			]),
		).toMatchObject({ offset: 0, front: "csdr", chanBin: "/opt/wavekit-chan" })
		const base = ["--iq", "a.cu8", "--rate", "2048000"]
		expect(() => iq.parseIqArgs(base)).toThrow(/--front/)
		expect(() => iq.parseIqArgs([...base, "--front", "sdr"])).toThrow(/--front/)
		expect(() =>
			iq.parseIqArgs(["--iq", "a.cu8", "--rate", "2.4e6x", "--front", "csdr"]),
		).toThrow(/--rate/)
		// The raw front's own range check: |offset| <= fs/2 - 6 250 Hz.
		expect(() =>
			iq.parseIqArgs([...base, "--front", "csdr", "--offset", "1017751"]),
		).toThrow(/--offset/)
	})

	it("pins the csdr front to DsdFmeDecoder's raw pipeline", () => {
		for (const [rate, offset] of [
			[2_048_000, 6000],
			[2_048_000, 0],
			[2_400_000, -12_000],
			[1_024_000, 250_000],
			[250_000, 0],
		] as const) {
			const stages = iq.csdrFeedStages(rate, offset, BACK_CHAIN)
			const pipeline = pipelineOf(
				dsdFme({ inputSampleRate: rate, offsetHz: offset }),
			)
			expect(pipeline.startsWith(`${stages.join(" | ")} | dsd-fme`)).toBe(true)
		}
		// Run 8: dongle 6 kHz below, matched 12.5 kHz filter.
		expect(iq.csdrFeedStages(2_048_000, 6000, BACK_CHAIN)).toContain(
			"csdr firdecimate 43 0.003052 --cutoff 0.1968",
		)
	})

	it("pins the chan front to DsdFmeDecoder's channelised pipeline", () => {
		const stages = iq.chanFeedStages(BACK_CHAIN)
		expect(stages[0]).toBe("csdr fmdemod")
		const pipeline = pipelineOf(
			dsdFme({ inputSampleRate: 48_000, inputIqFormat: "cf32" }),
		)
		expect(pipeline.startsWith(`${stages.join(" | ")} | dsd-fme`)).toBe(true)
	})

	it("opens the channel DsdFmeDecoder requests, with the spawn line the core uses", () => {
		const req = iq.openRequest(6000)
		expect(() => encodeRequest(req)).not.toThrow()
		const want = dsdFme({ offsetHz: 6000 }).getChannelRequest({
			sampleRateHz: 2_048_000,
			centerHz: iq.NOMINAL_CENTER_HZ,
		})
		expect(req).toMatchObject({ type: "open", ...want })
		expect(iq.chanArgs(2_048_000, "/tmp/s")).toEqual(
			buildChannelizerArgs({
				binaryPath: "wavekit-chan",
				generation: 1,
				inputRateHz: 2_048_000,
				inputCenterHz: iq.NOMINAL_CENTER_HZ,
				usableFraction: 0.9,
				blockSamples: 16384,
				socketDir: "/tmp/s",
			}),
		)
	})

	it("uses the provisional AMBE tolerance max(1.25 x csdr, csdr + 20) (PF16)", () => {
		expect(iq.ambeTolerance(0)).toBe(20)
		expect(iq.ambeTolerance(80)).toBe(100)
		expect(iq.ambeTolerance(200)).toBe(250)
	})

	it("compares the TGT/SRC lines only", () => {
		const decoded = [
			"Sync: +DMR  [slot1]  slot2  | Color Code=01 | CSBK",
			" SLOT 1 TGT=9 SRC=2060945 FLCO=0x00 FID=0x10 SVC=0x00 Group Call",
			" SLOT 1 TGT=9 SRC=2060945 FLCO=0x00 FID=0x10 SVC=0x00 Group Call",
		].join("\n")
		expect([...iq.linkLines(decoded)]).toEqual([
			" SLOT 1 TGT=9 SRC=2060945 FLCO=0x00 FID=0x10 SVC=0x00 Group Call",
		])
	})

	it("streams the capture through one opened channel into the sink", async () => {
		const bin = join(root, "wavekit-chan")
		writeExecutable(bin, FAKE_WAVEKIT_CHAN)
		// The real process queues output until its client is accepted; the fake
		// drops input until it registers the client, so hold its stdin briefly.
		vi.stubEnv("FAKE_CHAN_MODE", "stall-input")
		vi.stubEnv("FAKE_CHAN_STALL_MS", "300")
		const capture = join(root, "capture.cu8")
		const bytes = randomBytes(64 * 1024)
		writeFileSync(capture, bytes)
		const run = async (offset: number) => {
			const sink = new PassThrough()
			const chunks: Buffer[] = []
			sink.on("data", (c: Buffer) => chunks.push(c))
			const ended = new Promise(resolve => sink.on("end", resolve))
			const result = await iq.chanFeed(
				{ iq: capture, rate: 2_048_000, offset, front: "chan", chanBin: bin },
				sink,
			)
			await ended
			return { result, out: Buffer.concat(chunks) }
		}
		// The fake channel is identity pass-through: every byte, after the open.
		const ok = await run(6000)
		expect(ok.result).toEqual({ discontinuities: 0, error: null })
		expect(ok.out.equals(bytes)).toBe(true)
		// The fake rejects a centre above 1 THz; the sink still ends.
		const rejected = await run(2e12)
		expect(rejected.result.error).toMatch(
			/channel rejected: channel-outside-capture/,
		)
		expect(rejected.out.length).toBe(0)
	}, 20_000)

	it("reports a missing wavekit-chan instead of hanging", async () => {
		const sink = new PassThrough().resume()
		const result = await iq.chanFeed(
			{
				iq: "/nonexistent.cu8",
				rate: 2_048_000,
				offset: 0,
				front: "chan",
				chanBin: join(root, "no-such-wavekit-chan"),
			},
			sink,
		)
		expect(result.error).toMatch(/spawn .*no-such-wavekit-chan/)
		expect(sink.writableEnded).toBe(true)
	})
})
