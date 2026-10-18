import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MockInstance } from "vitest"
import * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import { RUST_FALLBACK_LOG } from "../../../src/core/live-demod/select-engine.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import {
	FakeProcess,
	capturingLogger,
	createFakeFanout,
	createFakeSourceManager,
	type CapturedLog,
} from "./live-demodulator-continuity-fakes.js"
import {
	ChannelFake,
	VersionFake,
	controlMessages,
	demodEvent,
} from "./live-demod/rust-fakes.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = http.createServer()
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				server.close()
				reject(new Error("no port"))
				return
			}
			const port = address.port
			server.close(err => (err ? reject(err) : resolve(port)))
		})
	})
}

describe("live demod rust fallback and retune", () => {
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType
	let demod: LiveDemodulatorType | undefined
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	let versionMode: "current" | "old" | "enoent"
	let channelSpawn: "ok" | "enoent"
	let rejectOpen: boolean
	let autoExitAfter: number
	let channelCount: number
	let format: "U8_IQ" | "S16_IQ"
	let centerFreq: number | undefined
	const versions: VersionFake[] = []
	const channels: ChannelFake[] = []
	const shells: FakeProcess[] = []

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		versionMode = "current"
		channelSpawn = "ok"
		rejectOpen = false
		autoExitAfter = 99
		channelCount = 0
		format = "U8_IQ"
		centerFreq = undefined
		versions.length = 0
		channels.length = 0
		shells.length = 0
		spawnMock.mockImplementation((command: string, args: string[]) => {
			if (args[0] === "--version") {
				const proc = new VersionFake(versionMode)
				versions.push(proc)
				return proc as unknown as ChildProcess
			}
			if (command === "/bin/sh") {
				const proc = new FakeProcess(args[1] ?? "")
				shells.push(proc)
				return proc as unknown as ChildProcess
			}
			channelCount += 1
			const proc = new ChannelFake({
				exitOnShutdown: true,
				autoExit: channelCount > autoExitAfter,
				rejectOpen,
				emitReady: channelSpawn !== "enoent",
			})
			channels.push(proc)
			if (channelSpawn === "enoent") {
				process.nextTick(() => {
					const error = new Error("spawn ENOENT") as NodeJS.ErrnoException
					error.code = "ENOENT"
					error.errno = -2
					error.syscall = "spawn"
					const loose = proc as unknown as { pid: number | undefined }
					loose.pid = undefined
					proc.emit("error", error)
					proc.exit(-2, null)
				})
			}
			return proc as unknown as ChildProcess
		})
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const id = Math.abs(pid)
				const proc =
					channels.find(item => item.pid === id) ??
					versions.find(item => item.pid === id) ??
					shells.find(item => item.pid === id)
				if (!proc) {
					const error = new Error("ESRCH") as NodeJS.ErrnoException
					error.code = "ESRCH"
					throw error
				}
				proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
				return true
			})
	})

	afterEach(async () => {
		try {
			await demod?.stop()
		} catch {
			// cleanup only
		}
		demod = undefined
		for (const channel of channels) await channel.dispose()
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	function source() {
		const base = createFakeSourceManager()
		return {
			...base,
			getCaps: () => ({
				...base.getCaps(),
				format,
				...(centerFreq !== undefined ? { centerFreq } : {}),
			}),
			moveCenter(hz: number) {
				centerFreq = hz
				base.emitCaps({ centerFreq: hz })
			},
		}
	}

	async function boot(
		overrides: Record<string, unknown> = {},
		options: Record<string, unknown> = {},
	): Promise<{
		lines: CapturedLog[]
		port: number
		source: ReturnType<typeof source>
	}> {
		const port = await freePort()
		const config = LiveDemodConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: port,
			engine: "rust",
			chanBinaryPath: "do-not-log-binary",
			...overrides,
		})
		const captured = capturingLogger()
		const src = source()
		demod = new LiveDemodulatorClass(
			captured.logger,
			src,
			createFakeFanout(),
			config,
			{
				httpHost: "127.0.0.1",
				restartBaseDelayMs: 1,
				restartMaxDelayMs: 8,
				...options,
			},
		)
		await demod.start()
		return { lines: captured.lines, port, source: src }
	}

	function fallbacks(lines: CapturedLog[]): CapturedLog[] {
		return lines.filter(line => line["msg"] === RUST_FALLBACK_LOG)
	}

	function loggedText(lines: CapturedLog[]): string {
		return JSON.stringify(lines)
	}

	it("falls back once when the binary is missing", async () => {
		versionMode = "enoent"
		const { lines } = await boot()
		expect(channels).toHaveLength(0)
		expect(shells.length).toBeGreaterThanOrEqual(2)
		expect(fallbacks(lines)).toHaveLength(1)
		expect(fallbacks(lines)[0]).toMatchObject({
			reason: "binary-unavailable",
			err: { code: "ENOENT" },
		})
		expect(loggedText(lines)).not.toContain("do-not-log-binary")
		expect(demod?.getStatus().engine).toBe("csdr")
		expect(demod?.getStatus().engineFallback).toBe("binary-unavailable")
	})

	it("falls back when the probed protocol is older than 2", async () => {
		versionMode = "old"
		const { lines } = await boot()
		expect(channels).toHaveLength(0)
		expect(shells.length).toBeGreaterThanOrEqual(2)
		expect(fallbacks(lines)).toEqual([
			expect.objectContaining({
				msg: RUST_FALLBACK_LOG,
				reason: "protocol-unsupported",
			}),
		])
		expect(demod?.getStatus().engineFallback).toBe("protocol-unsupported")
	})

	it("falls back on an s16 source without probing", async () => {
		format = "S16_IQ"
		const { lines } = await boot()
		expect(versions).toHaveLength(0)
		expect(channels).toHaveLength(0)
		expect(shells.length).toBeGreaterThanOrEqual(2)
		expect(fallbacks(lines)[0]?.["reason"]).toBe("input-format-unsupported")
	})

	it("falls back on wfm without probing", async () => {
		const { lines } = await boot({ modulation: "wfm" })
		expect(versions).toHaveLength(0)
		expect(channels).toHaveLength(0)
		expect(fallbacks(lines)[0]?.["reason"]).toBe("modulation-unsupported")
	})

	it("falls back when bandwidth is outside 2500..40000", async () => {
		const { lines } = await boot({ bandwidth: 1000 })
		expect(versions).toHaveLength(0)
		expect(fallbacks(lines)[0]?.["reason"]).toBe("open-rejected")
	})

	it("falls back when open is rejected and does not log the detail", async () => {
		rejectOpen = true
		const { lines } = await boot()
		expect(channels).toHaveLength(1)
		expect(shells.length).toBeGreaterThanOrEqual(2)
		expect(fallbacks(lines)).toHaveLength(1)
		expect(fallbacks(lines)[0]?.["reason"]).toBe("open-rejected")
		expect(loggedText(lines)).not.toContain("secret-detail")
		expect(loggedText(lines)).not.toContain("do-not-log-binary")
	})

	it("does not log the rust process stderr", async () => {
		const { lines } = await boot()
		channels[0]?.stderr.write("SECRET-STDERR /tmp/hidden-tool-output\n")
		await new Promise(resolve => setTimeout(resolve, 10))
		expect(loggedText(lines)).not.toContain("SECRET-STDERR")
		expect(loggedText(lines)).not.toContain("hidden-tool-output")
	})

	it("routes offset, modulation, gain and filters to one retune", async () => {
		const { port } = await boot()
		expect(demod?.getStatus()).toMatchObject({
			engine: "rust",
			effectiveSampleRate: 48000,
		})
		const headers = await new Promise<http.IncomingHttpHeaders>(
			(resolve, reject) => {
				const req = http.get(
					{ host: "127.0.0.1", port, path: "/stream" },
					res => {
						resolve(res.headers)
						res.destroy()
					},
				)
				req.on("error", reject)
			},
		)
		expect(headers["x-sample-rate"]).toBe("48000")
		const closes: Array<"stopped" | "config" | null> = []
		const edges: boolean[] = []
		demod?.on("squelch-changed", open => {
			edges.push(open)
			closes.push(demod?.transmissionCloseOverride() ?? null)
		})
		const calls = spawnMock.mock.calls.length
		await demod?.reconfigure({ offsetHz: 6000 })
		await demod?.reconfigure({ modulation: "am" })
		await demod?.reconfigure({ gain: 4 })
		await demod?.reconfigure({ lowPass: 3000 })
		expect(spawnMock.mock.calls).toHaveLength(calls)
		expect(shells).toHaveLength(0)
		const retunes = controlMessages(channels[0]?.controlText ?? "").filter(
			message => message["type"] === "retune",
		)
		expect(retunes).toHaveLength(4)
		expect(retunes[0]).toMatchObject({ centerHz: 6000 })
		expect(retunes[1]).toMatchObject({ modulation: "am" })
		expect(retunes[2]).toMatchObject({ audio: { gain: 4 } })
		expect(retunes[3]).toMatchObject({ audio: { lowPassHz: 3000 } })
		expect(edges).toEqual([false])
		expect(closes).toEqual(["config"])
	})

	it("keeps an HTTP client across a rust retune", async () => {
		const { port } = await boot()
		await new Promise<void>((resolve, reject) => {
			const req = http.get(
				{ host: "127.0.0.1", port, path: "/stream" },
				res => {
					expect(res.statusCode).toBe(200)
					expect(demod?.getStatus().clientCount).toBe(1)
					void demod?.reconfigure({ offsetHz: 1500 }).then(() => {
						expect(demod?.getStatus().clientCount).toBe(1)
						expect(shells).toHaveLength(0)
						res.destroy()
						resolve()
					}, reject)
				},
			)
			req.on("error", reject)
		})
	})

	it("mirrors gate events into squelch-changed", async () => {
		await boot({ squelch: -40 })
		const edges: boolean[] = []
		demod?.on("squelch-changed", open => edges.push(open))
		expect(demod?.getStatus().squelchOpen).toBe(false)
		channels[0]?.emitLine(demodEvent("gate", { open: true, atOutputSample: 0 }))
		expect(edges).toEqual([true])
		expect(demod?.getStatus().squelchOpen).toBe(true)
		expect(demod?.isSquelchOpen()).toBe(true)
		channels[0]?.emitLine(
			demodEvent("gate", { open: false, atOutputSample: 480 }),
		)
		expect(edges).toEqual([true, false])
		expect(demod?.isSquelchOpen()).toBe(false)
	})

	it("feeds metrics power into the auto floor and sends one squelch update", async () => {
		await boot({ squelchMode: "auto", autoMarginDb: 6 })
		channels[0]?.emitLine(
			demodEvent("metrics", {
				atOutputSample: 480,
				powerDbfs: [-80],
				quietingDb: [null],
			}),
		)
		const squelch = controlMessages(channels[0]?.controlText ?? "").filter(
			message => message["type"] === "squelch",
		)
		expect(squelch).toEqual([
			expect.objectContaining({
				mode: "power",
				thresholdDbfs: -74,
				hysteresisDb: 2,
				hangMs: 250,
			}),
		])
		expect(demod?.getStatus().noiseFloorDbfs).toBe(-80)
		expect(demod?.getStatus().thresholdDbfs).toBe(-74)
		expect(demod?.getStatus().channelPowerDbfs).toBe(-80)
		channels[0]?.emitLine(
			demodEvent("metrics", {
				atOutputSample: 960,
				powerDbfs: [-80],
				quietingDb: [null],
			}),
		)
		const again = controlMessages(channels[0]?.controlText ?? "").filter(
			message => message["type"] === "squelch",
		)
		expect(again.length).toBeGreaterThanOrEqual(1)
		expect(again[0]).toMatchObject({ thresholdDbfs: -74 })
	})

	it("latches csdr after three rust crashes", async () => {
		autoExitAfter = 1
		const { lines } = await boot()
		expect(demod?.getStatus().engine).toBe("rust")
		channels[0]?.exit(1, null)
		await vi.waitFor(
			() => {
				expect(demod?.getStatus().engine).toBe("csdr")
				expect(demod?.getStatus().engineFallback).toBe("process-unstable")
				expect(shells.length).toBeGreaterThanOrEqual(2)
			},
			{ timeout: 3000 },
		)
		expect(channelCount).toBe(3)
		expect(fallbacks(lines)).toHaveLength(1)
		expect(fallbacks(lines)[0]?.["reason"]).toBe("process-unstable")
	})

	it("delivers channel-socket audio to the pcm listeners", async () => {
		const chunks: Buffer[] = []
		await boot()
		demod?.on("pcm", chunk => chunks.push(Buffer.from(chunk)))
		await vi.waitFor(() => expect(channels[0]?.audio).toBeTruthy(), {
			timeout: 1000,
		})
		const pcm = Buffer.from([1, 2, 3, 4])
		channels[0]?.audio?.write(pcm)
		await vi.waitFor(() => expect(Buffer.concat(chunks)).toEqual(pcm), {
			timeout: 1000,
		})
	})

	it("falls back when channel spawn fails after a successful version probe", async () => {
		channelSpawn = "enoent"
		const { lines } = await boot()
		expect(versions).toHaveLength(1)
		expect(channels.length).toBeGreaterThanOrEqual(1)
		expect(shells.length).toBeGreaterThanOrEqual(2)
		expect(fallbacks(lines)).toHaveLength(1)
		expect(fallbacks(lines)[0]).toMatchObject({
			reason: "binary-unavailable",
			err: { code: "ENOENT" },
		})
		expect(demod?.getStatus().engine).toBe("csdr")
		expect(demod?.getStatus().engineFallback).toBe("binary-unavailable")
	})

	it("applies offsetHz against the input center captured at process start", async () => {
		centerFreq = 100_000_000
		const { source: src } = await boot()
		const open = controlMessages(channels[0]?.controlText ?? "").find(
			message => message["type"] === "open",
		)
		expect(open?.["centerHz"]).toBe(100_000_000)
		src.moveCenter(101_000_000)
		await demod?.reconfigure({ offsetHz: 1_000 })
		const retunes = controlMessages(channels[0]?.controlText ?? "").filter(
			message => message["type"] === "retune",
		)
		expect(retunes).toEqual([
			expect.objectContaining({ centerHz: 100_001_000 }),
		])
	})

	it("keeps the transmission closed until the retuned event", async () => {
		await boot({ squelch: 0 })
		expect(demod?.isSquelchOpen()).toBe(true)
		await demod?.reconfigure({ offsetHz: 2_500 })
		expect(demod?.isSquelchOpen()).toBe(false)
		channels[0]?.emitLine(
			demodEvent("gate", { open: true, atOutputSample: 480 }),
		)
		expect(demod?.isSquelchOpen()).toBe(false)
		channels[0]?.emitLine(demodEvent("retuned", { atOutputSample: 960 }))
		expect(demod?.isSquelchOpen()).toBe(true)
	})

	it("does not seed the auto floor from a quieted carrier and sends the floor", async () => {
		await boot({ squelchMode: "auto", autoMarginDb: 6, modulation: "nfm" })
		expect(demod?.carrierBlocks()).toBe(0)
		channels[0]?.emitLine(
			demodEvent("metrics", {
				atOutputSample: 480,
				powerDbfs: [-20],
				quietingDb: [30],
			}),
		)
		expect(demod?.getStatus().noiseFloorDbfs).toBeUndefined()
		expect(demod?.getStatus().thresholdDbfs).toBeCloseTo(-0.001)
		expect(demod?.carrierBlocks()).toBe(1)
		channels[0]?.emitLine(
			demodEvent("metrics", {
				atOutputSample: 960,
				powerDbfs: [-80],
				quietingDb: [1],
			}),
		)
		expect(demod?.getStatus().noiseFloorDbfs).toBe(-80)
		expect(demod?.getStatus().thresholdDbfs).toBe(-74)
		expect(demod?.carrierBlocks()).toBe(1)
		const squelch = controlMessages(channels[0]?.controlText ?? "").filter(
			message => message["type"] === "squelch",
		)
		expect(squelch.at(-1)).toMatchObject({
			mode: "power",
			thresholdDbfs: -74,
			noiseFloorDbfs: -80,
		})
		await demod?.reconfigure({ offsetHz: 1_000 })
		const cleared = controlMessages(channels[0]?.controlText ?? "").filter(
			message => message["type"] === "squelch",
		)
		expect(cleared.at(-1)?.["noiseFloorDbfs"]).toBeNull()
		expect(demod?.getStatus().noiseFloorDbfs).toBeUndefined()
	})

	it("counts rust carrier blocks with the channel-squelch rule", async () => {
		await boot({
			squelchMode: "noise",
			noiseQuietingDb: 12,
			modulation: "nfm",
			squelch: -40,
		})
		expect(demod?.carrierBlocks()).toBe(0)
		channels[0]?.emitLine(
			demodEvent("metrics", {
				atOutputSample: 480,
				powerDbfs: [-20],
				quietingDb: [10],
			}),
		)
		expect(demod?.carrierBlocks()).toBe(0)
		channels[0]?.emitLine(
			demodEvent("metrics", {
				atOutputSample: 960,
				powerDbfs: [-20],
				quietingDb: [12],
			}),
		)
		expect(demod?.carrierBlocks()).toBe(1)
	})

	it("counts a manual rust carrier at the default quieting threshold", async () => {
		await boot({
			squelchMode: "manual",
			modulation: "nfm",
			squelch: -40,
			noiseQuietingDb: 20,
		})
		channels[0]?.emitLine(
			demodEvent("metrics", {
				atOutputSample: 480,
				powerDbfs: [-20],
				quietingDb: [6],
			}),
		)
		expect(demod?.carrierBlocks()).toBe(1)
	})
})
