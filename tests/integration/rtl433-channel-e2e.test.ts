/**
 * rtl_433 on a core channel, end to end: a fake rtl_tcp (ephemeral port)
 * streams a synthetic OOK remote at 960 ksps, the catalogue rtl433 decoder
 * is placed by the real planner on a resampled channel of the real
 * wavekit-chan process, and a PATH shim tees the exact bytes rtl_433 reads
 * on stdin into a file.
 *
 * Opt in against a host build of the channelizer (`make chan-build`):
 * WAVEKIT_CHAN_BIN=native/wavekit-chan/target/release/wavekit-chan
 * Skips when that is not an executable file or rtl_433 is not on PATH.
 */
import { execFileSync } from "node:child_process"
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	statSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pino from "pino"
import { afterAll, describe, expect, it } from "vitest"
import { ChannelizerConfigSchema } from "../../src/config.js"
import { ChannelizerManager } from "../../src/core/channelizer/channelizer-manager.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../src/core/source-fanout-router.js"
import { SourceManager } from "../../src/core/source-manager.js"
import { resolveBandRegion } from "../../src/decoders/band-region.js"
import {
	RTL433_CAPS,
	createRtl433Decoder,
} from "../../src/decoders/builtin/rtl433.js"
import { planPlacements } from "../../src/decoders/enablement/placement.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import type { DecoderOutput } from "../../src/decoders/types.js"
import { ookPwmCu8 } from "../mocks/ook-pwm.js"

const FS = 960_000
const CENTRE = 434_600_000
/** The burst sits 40 kHz below the capture centre, inside the planned channel. */
const OFFSET = -40_000
/** Copies of the capture the fake sends once rtl_433 has started. */
const LOOPS = 3

function which(cmd: string): string | null {
	try {
		return (
			execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], {
				encoding: "utf8",
			}).trim() || null
		)
	} catch {
		return null
	}
}
function executable(file: string | undefined): string | null {
	if (!file) return null
	try {
		accessSync(file, constants.X_OK)
		return statSync(file).isFile() ? file : null
	} catch {
		return null
	}
}
const chanBin = executable(process.env["WAVEKIT_CHAN_BIN"])
const rtl433 = executable(which("rtl_433") ?? undefined)
const dir = mkdtempSync(join(tmpdir(), "wk-r433-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function rtl433Json(
	file: string,
	rate: number,
	extra: string[] = [],
): Record<string, unknown>[] {
	const out = execFileSync(
		rtl433!,
		["-r", `cu8:${file}`, "-s", String(rate), "-F", "json", ...extra],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	)
	return out
		.split("\n")
		.filter(l => l.startsWith("{"))
		.map(l => JSON.parse(l) as Record<string, unknown>)
}

/**
 * Paced rtl_tcp: 12-byte RTL0 header, then, once `open()` holds, exactly
 * LOOPS copies of `capture` in 20 ms chunks, then silence.
 */
async function fakeRtlTcp(capture: Buffer, open: () => boolean) {
	const chunk = Math.round(FS * 0.02) * 2
	const sockets = new Set<net.Socket>()
	const server = net.createServer(socket => {
		sockets.add(socket)
		socket.on("error", () => undefined)
		socket.on("data", () => undefined)
		socket.on("close", () => sockets.delete(socket))
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
	})
	let at = 0
	let loops = 0
	const timer = setInterval(() => {
		if (loops >= LOOPS || !open()) return
		const end = Math.min(at + chunk, capture.length)
		const bytes = capture.subarray(at, end)
		at = end >= capture.length ? 0 : end
		if (at === 0) loops++
		for (const s of sockets) if (!s.destroyed) s.write(bytes)
	}, 20)
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
	const address = server.address() as net.AddressInfo
	return {
		port: address.port,
		done: () => loops >= LOOPS,
		close: async () => {
			clearInterval(timer)
			for (const s of sockets) s.destroy()
			await new Promise<void>(r => server.close(() => r()))
		},
	}
}

function stats(tap: Buffer) {
	let sum = 0
	let power = 0
	for (let k = 0; k < tap.length; k++) sum += tap[k]!
	const mean = sum / tap.length
	for (let k = 0; k < tap.length; k++)
		power = Math.max(power, Math.abs(tap[k]! - mean))
	return { mean, peak: power }
}

/** Strongest frequency (Hz) of the bursts in `tap`, by a coarse DFT over the loud samples. */
function burstFrequency(tap: Buffer, rate: number): number {
	const n = tap.length / 2
	const loud: number[] = []
	for (let i = 0; i < n && loud.length < 4096; i++) {
		const re = tap[2 * i]! - 127.5
		const im = tap[2 * i + 1]! - 127.5
		if (re * re + im * im > 9 * 9) loud.push(i)
	}
	let best = 0
	let bestHz = 0
	for (let hz = -150_000; hz <= 150_000; hz += 500) {
		let sr = 0
		let si = 0
		for (const i of loud) {
			const re = tap[2 * i]! - 127.5
			const im = tap[2 * i + 1]! - 127.5
			const ph = (-2 * Math.PI * hz * i) / rate
			sr += re * Math.cos(ph) - im * Math.sin(ph)
			si += re * Math.sin(ph) + im * Math.cos(ph)
		}
		const m = sr * sr + si * si
		if (m > best) {
			best = m
			bestHz = hz
		}
	}
	return bestHz
}

describe.skipIf(!chanBin || !rtl433)("rtl433 on a core channel", () => {
	it("decodes an OOK remote through the planned, resampled channel", async () => {
		// Lead and tail noise make 1.5 s of capture.
		const capture = ookPwmCu8({
			fs: FS,
			offsetHz: OFFSET,
			amp: 0.1,
			noise: 0.02,
			leadS: 0.5,
			tailS: 0.7,
			seed: 7,
		})
		const original = join(dir, "original.cu8")
		writeFileSync(original, capture)
		const defaultLevel = rtl433Json(original, FS)
		const before = rtl433Json(original, FS, ["-Y", "autolevel"])

		const tapFile = join(dir, "stdin.cu8")
		const argsFile = join(dir, "args.txt")
		const shim = join(dir, "bin")
		execFileSync("/bin/mkdir", ["-p", shim])
		writeFileSync(
			join(shim, "rtl_433"),
			`#!/bin/sh\nprintf '%s\\n' "$*" > '${argsFile}'\ntee '${tapFile}' | exec '${rtl433}' "$@"\n`,
		)
		chmodSync(join(shim, "rtl_433"), 0o755)
		const path = process.env["PATH"]
		process.env["PATH"] = `${shim}:${path ?? ""}`

		const logger = pino({ level: "silent" })
		const rtl = await fakeRtlTcp(capture, () => existsSync(argsFile))
		const sources = new SourceManager(logger)
		const fanout = new FanoutManager(logger)
		const routing = new SourceFanoutRouter(sources, fanout, logger, "rtl")
		const channelizer = new ChannelizerManager({
			sourceManager: sources,
			routing,
			logger,
			config: ChannelizerConfigSchema.parse({
				enabled: true,
				binaryPath: resolve(chanBin!),
				socketDir: join("/tmp", `wkr-${process.pid}`),
			}),
		})
		const registry = new DecoderRegistry()
		registry.register("rtl433", createRtl433Decoder, RTL433_CAPS)
		const manager = new DecoderManager(registry, fanout, logger, {
			validateVersions: false,
			bandRegion: resolveBandRegion({ configured: "EU", env: {} }),
			enablement: {
				planner: planPlacements,
				resolveMode: () => ({ mode: "auto", source: "default" }),
				isCatalogue: c => c.id === "rtl433",
				unavailable: () => false,
				recheckAvailable: async () => true,
				vfo: () => null,
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
			},
		})
		const outputs: DecoderOutput[] = []
		manager.on("decoder:output", (_id: string, o: DecoderOutput) =>
			outputs.push(o),
		)
		try {
			await sources.connect({
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: rtl.port,
				delivery: "auto",
				loop: false,
				playbackSpeed: 1,
				caps: {
					kind: "iq",
					sampleRate: FS,
					format: "U8_IQ",
					centerFreq: CENTRE,
					exclusive: false,
				},
			} as Parameters<SourceManager["connect"]>[0])
			manager.setSourceManager(sources, routing)
			manager.setChannelizer(channelizer)
			manager.createDecoder({
				id: "rtl433",
				type: "rtl433",
				enabled: true,
				options: {},
				useChannelizer: false,
			})
			await manager.startAll()
			const deadline = Date.now() + 25_000
			while (!rtl.done() && Date.now() < deadline)
				await new Promise(r => setTimeout(r, 100))
			// Let the channel and rtl_433 drain the last chunk.
			await new Promise(r => setTimeout(r, 1_500))
		} finally {
			await manager.destroy()
			await channelizer.destroy()
			routing.destroy()
			fanout.destroy()
			await sources.disconnectAll()
			await rtl.close()
			process.env["PATH"] = path
		}
		const args = readFileSync(argsFile, "utf8").trim().split(" ")
		const rate = Number(args[args.indexOf("-s") + 1])
		const tap = readFileSync(tapFile)
		const after = rtl433Json(tapFile, rate, args.slice(6))
		const { mean, peak } = stats(tap)
		const channelOffset = burstFrequency(tap, rate)
		const report = {
			args,
			tapBytes: tap.length,
			mean,
			peak,
			channelOffset,
			defaultLevel: defaultLevel.map(e => e["model"]),
			before: before.map(e => e["model"]),
			after: after.map(e => e["model"]),
			live: outputs.length,
		}
		const reportFile = process.env["WAVEKIT_E2E_REPORT"]
		if (reportFile) writeFileSync(reportFile, JSON.stringify(report))
		const model = "Waveman-Switch"
		// rtl_433's fixed default level misses a -20 dBFS burst; autolevel finds it.
		expect(defaultLevel).toHaveLength(0)
		expect(before.length).toBeGreaterThan(0)
		expect(before.every(e => e["model"] === model)).toBe(true)
		// Planner: half window h = 960 kHz * 0.8 / 2 = 384 kHz, so 434.216-434.984
		// MHz; the EU range 433.05-434.79 MHz clips it to 434.216-434.79 MHz,
		// centre 434.503 MHz (-97 kHz); rate = floor(2 * (384 - 97) kHz) = 574 kHz.
		expect(args).toEqual([
			"-r",
			"cu8:-",
			"-s",
			"574000",
			"-F",
			"json",
			"-Y",
			"autolevel",
		])
		// The -40 kHz burst sits +57 kHz from the channel centre: no inversion.
		expect(Math.abs(channelOffset - 57_000)).toBeLessThanOrEqual(1_000)
		// Bytes: LOOPS * capture samples * 574/960 output samples, 2 bytes each.
		// 1% covers the filter's group delay still held in the channel (well
		// under 1% of the ~2.6 M output samples) and per-block rounding.
		const expected = ((LOOPS * capture.length) / 2) * (574_000 / FS) * 2
		expect(Math.abs(tap.length - expected) / expected).toBeLessThan(0.01)
		expect(Math.abs(mean - 127.5)).toBeLessThan(2)
		// 0.1 of full scale is 12.75 counts; noise adds up to a few more.
		expect(peak).toBeGreaterThan(10)
		expect(peak).toBeLessThan(40)
		expect(after.length).toBeGreaterThan(0)
		expect(after.every(e => e["model"] === model)).toBe(true)
		expect(outputs.length).toBeGreaterThan(0)
		expect(
			outputs.every(
				o => (o.data as Record<string, unknown>)["model"] === model,
			),
		).toBe(true)
	}, 40_000)
})
