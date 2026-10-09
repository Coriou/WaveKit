import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest"
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
	paced: boolean
}
interface FeedResult {
	discontinuities: number
	error: string | null
}
interface Clock {
	now(): number
	sleep(ms: number): Promise<void>
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
	pace(
		bytesPerSecond: number | null,
		clock?: Clock,
	): (source: AsyncIterable<Buffer>) => AsyncGenerator<Buffer>
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
			paced: true,
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
		expect(
			iq.parseIqArgs([...base, "--front", "chan", "--unpaced"]),
		).toMatchObject({ paced: false })
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
		// drops input until it registers the client, so hold its stdin for the
		// stall mode's default 1 500 ms (a wide margin on a loaded host).
		vi.stubEnv("FAKE_CHAN_MODE", "stall-input")
		const capture = join(root, "capture.cu8")
		const bytes = randomBytes(64 * 1024)
		writeFileSync(capture, bytes)
		const run = async (offset: number) => {
			const sink = new PassThrough()
			const chunks: Buffer[] = []
			sink.on("data", (c: Buffer) => chunks.push(c))
			const ended = new Promise(resolve => sink.on("end", resolve))
			const result = await iq.chanFeed(
				{
					iq: capture,
					rate: 2_048_000,
					offset,
					front: "chan",
					chanBin: bin,
					paced: true,
				},
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
				paced: true,
			},
			sink,
		)
		expect(result.error).toMatch(/spawn .*no-such-wavekit-chan/)
		expect(sink.writableEnded).toBe(true)
	})

	it("paces the feed at the given byte rate, or not at all when unpaced", async () => {
		const chunks = Array.from({ length: 5 }, () => Buffer.alloc(1000))
		const run = async (bytesPerSecond: number | null) => {
			let t = 0
			const sleeps: number[] = []
			const clock: Clock = {
				now: () => t,
				sleep: async ms => {
					sleeps.push(ms)
					t += ms
				},
			}
			const out: Buffer[] = []
			for await (const c of iq.pace(
				bytesPerSecond,
				clock,
			)(
				(async function* () {
					yield* chunks
				})(),
			))
				out.push(c)
			expect(Buffer.concat(out).length).toBe(5000)
			return { t, sleeps }
		}
		// 5 000 bytes at 10 000 B/s take 500 ms of wall time, every byte on time.
		expect((await run(10_000)).t).toBe(500)
		expect(await run(null)).toEqual({ t: 0, sleeps: [] })
	})

	describe("against a minimal wavekit-chan", () => {
		// Opens one channel, counts stdin and ends like runtime.rs (input-eof with
		// inputSamples / discardedBytes, exit 0) unless MINI_CHAN_MODE says otherwise.
		const MINI = `#!/usr/bin/env node
const fs = require("node:fs"), net = require("node:net"), path = require("node:path"), readline = require("node:readline")
const argv = process.argv.slice(2), dir = argv[argv.indexOf("--socket-dir") + 1], mode = process.env.MINI_CHAN_MODE || "normal"
const emit = e => process.stdout.write(JSON.stringify({ v: 1, generation: 1, ...e }) + "\\n")
const quit = () => process.stdout.write("", () => process.exit(0))
let n = 0, client = null
if (mode === "epipe") { fs.closeSync(3); emit({ type: "ready", pid: process.pid }); setTimeout(() => {}, 500) }
else {
  emit({ type: "ready", pid: process.pid })
  readline.createInterface({ input: new net.Socket({ fd: 3, readable: true, writable: false }) }).on("line", line => {
    const r = JSON.parse(line), sock = path.join(dir, r.id + ".sock")
    const server = net.createServer(c => {
      client = c; server.close()
      if (mode === "closed-early") { emit({ type: "closed", id: r.id, reason: "client-gone" }); c.end(); setTimeout(quit, 200) }
    })
    server.listen(sock, () => emit({ type: "opened", id: r.id, socket: sock, outputRateHz: 48000, format: "cf32", filterTaps: 11, groupDelaySamples: 5 }))
  })
  process.stdin.on("data", b => { n += b.length })
  process.stdin.on("end", () => {
    if (mode !== "no-eof") emit({ type: "input-eof", inputSamples: Math.floor(n / 2) - (mode === "short-count" ? 1 : 0), discardedBytes: n % 2 })
    client?.end(); quit()
  })
}
`
		const bin = join(root, "mini-wavekit-chan")
		beforeAll(() => writeExecutable(bin, MINI))
		const feed = async (mode: string, size: number, rate = 2_048_000) => {
			vi.stubEnv("MINI_CHAN_MODE", mode)
			const capture = join(root, `mini-${size}.cu8`)
			if (size >= 0) writeFileSync(capture, Buffer.alloc(size))
			const sink = new PassThrough().resume()
			const started = performance.now()
			const result = await iq.chanFeed(
				{
					iq: size >= 0 ? capture : join(root, "missing.cu8"),
					rate,
					offset: 0,
					front: "chan",
					chanBin: bin,
					paced: true,
				},
				sink,
			)
			return { result, ms: performance.now() - started }
		}

		it("passes a run that ends with a matching input-eof", async () => {
			expect((await feed("normal", 4096)).result).toEqual({
				discontinuities: 0,
				error: null,
			})
		})

		it("paces the capture at 2 bytes per sample in real time by default", async () => {
			// 48 000 bytes at 48 000 samples/s: half a second of capture.
			const { result, ms } = await feed("normal", 48_000, 48_000)
			expect(result.error).toBeNull()
			expect(ms).toBeGreaterThanOrEqual(450)
		})

		it("fails on a capture read error instead of throwing", async () => {
			expect((await feed("normal", -1)).result.error).toMatch(
				/capture: .*ENOENT/,
			)
		})

		it("fails on a control fd write error instead of throwing", async () => {
			expect((await feed("epipe", 4096)).result.error).toMatch(/control fd: /)
		})

		it("fails when the channel closes before input-eof", async () => {
			expect((await feed("closed-early", 4096)).result.error).toMatch(
				/closed before input-eof: client-gone/,
			)
		})

		it("fails when wavekit-chan exits without input-eof", async () => {
			expect((await feed("no-eof", 4096)).result.error).toMatch(
				/without input-eof/,
			)
		})

		it("fails when input-eof discards bytes or misses samples", async () => {
			expect((await feed("normal", 4097)).result.error).toMatch(
				/discarded 1 byte/,
			)
			expect((await feed("short-count", 4096)).result.error).toMatch(
				/input-eof counted 2047 samples, 2048 fed/,
			)
		})
	})
})
