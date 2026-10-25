/**
 * rtl_433 on the whole capture, end to end: a fake rtl_tcp (ephemeral port)
 * streams a synthetic OOK remote at 960 ksps placed just past the ISM band
 * plan's upper edge but inside the capture. The real planner gives the
 * catalogue rtl433 decoder window reach (the raw stream, no channel), a PATH
 * shim tees the exact bytes rtl_433 reads on stdin into a file, and the same
 * capture through the old band-clipped channel of the real wavekit-chan
 * process decodes nothing.
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
import { ChannelizerProcess } from "../../src/core/channelizer/channelizer-process.js"
import type { ChannelizerEvent } from "../../src/core/channelizer/protocol.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../src/core/source-fanout-router.js"
import { SourceManager } from "../../src/core/source-manager.js"
import { resolveBandRegion } from "../../src/decoders/band-region.js"
import {
	RTL433_CAPS,
	createRtl433Decoder,
} from "../../src/decoders/builtin/rtl433.js"
import {
	planPlacements,
	rtl433ChannelCandidate,
} from "../../src/decoders/enablement/placement.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import type { DecoderOutput } from "../../src/decoders/types.js"
import {
	pickChannelObservation,
	rtl433FreqHz,
} from "../../src/core/scanner/probes/ambient-channel.js"
import { ookPwmCu8 } from "../mocks/ook-pwm.js"

const FS = 960_000
const CENTRE = 434_600_000
/**
 * The burst sits 250 kHz above the capture centre: 434.85 MHz, 60 kHz past the
 * EU band plan's 434.79 MHz edge, inside the usable window (+/- 384 kHz).
 */
const OFFSET = 250_000
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
	for (let hz = -400_000; hz <= 400_000; hz += 1_000) {
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

/** `capture` through one cu8 channel of the real wavekit-chan process. */
async function throughChannel(
	capture: Buffer,
	channel: { hz: number; rateHz: number },
): Promise<Buffer> {
	const socketDir = join("/tmp", `wkr-old-${process.pid}`)
	execFileSync("/bin/mkdir", ["-p", socketDir])
	const p = new ChannelizerProcess(
		{
			binaryPath: resolve(chanBin!),
			generation: 1,
			inputRateHz: FS,
			inputCenterHz: CENTRE,
			usableFraction: 0.8,
			blockSamples: 16384,
			socketDir,
			readyTimeoutMs: 5000,
			stopTimeoutMs: 2000,
		},
		pino({ level: "silent" }),
	)
	const events: ChannelizerEvent[] = []
	p.on("event", (e: ChannelizerEvent) => events.push(e))
	await p.start()
	try {
		const t = 0.05
		p.send({
			v: 1,
			type: "open",
			id: "old",
			centerHz: channel.hz,
			bandwidthHz: channel.rateHz * (1 - t),
			transitionHz: (channel.rateHz * t) / 2,
			outputRateHz: channel.rateHz,
			format: "cu8",
			queueBytes: 1 << 24,
		})
		const deadline = Date.now() + 5_000
		let opened: Extract<ChannelizerEvent, { type: "opened" }> | undefined
		while (!opened && Date.now() < deadline) {
			opened = events.find(
				(e): e is Extract<ChannelizerEvent, { type: "opened" }> =>
					e.type === "opened",
			)
			await new Promise(r => setTimeout(r, 10))
		}
		if (!opened) throw new Error("old channel did not open")
		const socket = net.createConnection(opened.socket)
		const chunks: Buffer[] = []
		socket.on("data", (b: Buffer) => chunks.push(b))
		const closed = new Promise(r => socket.once("close", r))
		await new Promise(r => setTimeout(r, 100))
		p.input.end(capture)
		await closed
		return Buffer.concat(chunks)
	} finally {
		await p.stop()
		rmSync(socketDir, { recursive: true, force: true })
	}
}

describe.skipIf(!chanBin || !rtl433)("rtl433 on the whole capture", () => {
	it("decodes a remote past the band-plan edge only with window reach", async () => {
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

		// The old policy: one channel clipped to the band plan and the window.
		// h = 384 kHz, overlap 434.216-434.79 MHz, centre 434.503 MHz, rate
		// floor(2 * (384 - 97) kHz) = 574 kHz, passband +/- 272.65 kHz.
		const old = rtl433ChannelCandidate(
			{ centreHz: CENTRE, sampleRateHz: FS, usableFraction: 0.8 },
			[{ minHz: 433_050_000, maxHz: 434_790_000 }],
		)
		if (!("hz" in old)) throw new Error("no old channel")
		expect(old).toEqual({ hz: 434_503_000, rateHz: 574_000 })
		const oldFile = join(dir, "old-channel.cu8")
		writeFileSync(oldFile, await throughChannel(capture, old))
		const oldDecodes = rtl433Json(oldFile, old.rateHz, ["-Y", "autolevel"])

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
			oldChannel: oldDecodes.length,
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
		// The band-clipped channel filters the device out.
		expect(oldDecodes).toHaveLength(0)
		// Window reach: the raw capture at its own rate, centre passed as -f.
		expect(args).toEqual([
			"-r",
			"cu8:-",
			"-s",
			"960000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-f",
			"434600000",
			"-M",
			"level",
		])
		// The burst stays at +250 kHz: the stream is the capture itself.
		expect(Math.abs(channelOffset - OFFSET)).toBeLessThanOrEqual(1_000)
		// Bytes: exactly what the fake sent (LOOPS copies), the raw stream 1:1.
		expect(tap.length).toBe(LOOPS * capture.length)
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

	it("decodes an emitter at 0.93 of Nyquist only from the raw window, with no wrong identity", async () => {
		// +446.4 kHz = 0.93 * 480 kHz: outside the usable window (+/- 384 kHz),
		// so no channel can carry it. The raw window stream is the capture
		// itself (the test above shows rtl_433's stdin equals what was sent).
		const edgeOffset = 446_400
		const capture = ookPwmCu8({
			fs: FS,
			offsetHz: edgeOffset,
			amp: 0.3,
			noise: 0.02,
			leadS: 0.5,
			tailS: 0.5,
			seed: 11,
		})
		const raw = join(dir, "edge.cu8")
		writeFileSync(raw, capture)
		const decodes = rtl433Json(raw, FS, [
			"-Y",
			"autolevel",
			"-f",
			String(CENTRE),
			"-M",
			"level",
		])
		expect(decodes.length).toBeGreaterThan(0)
		// The widest channel the capture allows: the whole usable window,
		// 768 kHz at the centre (h = 384 kHz = bw/2 + tr).
		const widest = join(dir, "edge-channel.cu8")
		writeFileSync(
			widest,
			await throughChannel(capture, { hz: CENTRE, rateHz: 768_000 }),
		)
		expect(rtl433Json(widest, 768_000, ["-Y", "autolevel"])).toHaveLength(0)
		// Association over the window passband: an inner track and the edge
		// track are both in view; whatever rtl_433 estimates, the inner one is
		// never named.
		const window = { centreHz: CENTRE, halfHz: FS / 2 }
		const track = (id: string, hz: number) => ({
			observationId: id,
			sourceId: "rtl",
			startedAt: 0,
			endedAt: 10,
			lastTrack: { centreHz: hz, obwHz: 10_000 },
		})
		const inner = track("inner", CENTRE - 100_000)
		const edge = track("edge", CENTRE + edgeOffset)
		for (const d of decodes) {
			const freqHz = rtl433FreqHz(d, window)
			const pick = (list: (typeof inner)[]) =>
				pickChannelObservation(
					list,
					{ sourceId: "rtl", passband: window, at: 5, freqHz },
					10,
					0,
				)
			expect(pick([inner, edge])).toBeNull()
			expect(pick([edge])?.observationId).toBe("edge")
		}
	}, 40_000)
})
