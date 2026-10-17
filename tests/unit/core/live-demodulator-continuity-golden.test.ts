/**
 * WG10 req 2.5 goldens, recorded from the frozen code (1e5b4c1f) before the
 * continuity work: planned argv of both stages, start/stop/full-restart
 * logs, the status DTO, the stream headers and the close-on-rate/format
 * behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { MockInstance } from "vitest"
import * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import {
	streamHeaders,
	wavStreamHeader,
} from "../../../src/core/audio-stream-server.js"
import {
	ClientTransport,
	FakeProcess,
	capturingLogger,
	createFakeFanout,
	createFakeSourceManager,
	delay,
	type CapturedLog,
} from "./live-demodulator-continuity-fakes.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>
const PORT = 45_678

type Internals = {
	registerClient(
		response: http.ServerResponse,
		remoteAddress: string,
	): { id: string }
}

/** Log lines without volatile fields (pids, errors), in order. */
function normalise(lines: CapturedLog[]): unknown[] {
	return lines.map(line => {
		const copy: Record<string, unknown> = { ...line }
		delete copy["pid"]
		return copy
	})
}

describe("LiveDemodulator WG10 goldens (frozen behaviour)", () => {
	let processes: FakeProcess[]
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	let liveDemod: LiveDemodulatorType
	let lines: CapturedLog[]
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType

	function create(overrides: Record<string, unknown> = {}) {
		const captured = capturingLogger()
		lines = captured.lines
		const config = LiveDemodConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: PORT,
			...overrides,
		})
		liveDemod = new LiveDemodulatorClass(
			captured.logger,
			createFakeSourceManager(),
			createFakeFanout(),
			config,
			{ httpHost: "127.0.0.1" },
		)
		return liveDemod
	}

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		processes = []
		spawnMock.mockImplementation((_cmd: string, args: string[]) => {
			const proc = new FakeProcess(args[1] ?? "")
			processes.push(proc)
			return proc as unknown as ChildProcess
		})
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const proc = processes.find(p => p.pid === Math.abs(pid))
				if (!proc) {
					const err = new Error("ESRCH") as NodeJS.ErrnoException
					err.code = "ESRCH"
					throw err
				}
				proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
				return true
			})
	})

	afterEach(async () => {
		try {
			await liveDemod.stop()
		} catch {
			// cleanup only
		}
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	const variants: Array<[string, Record<string, unknown>]> = [
		["default", {}],
		["offset", { offsetHz: 6000 }],
		["wfm f32le", { modulation: "wfm", audioFormat: "f32le" }],
		["am bandwidth", { modulation: "am", bandwidth: 10_000 }],
		["usb gain", { modulation: "usb", gain: 5 }],
	]
	for (const [name, overrides] of variants) {
		it(`planned argv of both stages: ${name}`, async () => {
			await create(overrides).start()
			const calls = spawnMock.mock.calls.map(call => {
				const opts = call[2] as { stdio: unknown; detached: unknown }
				return [call[0], call[1], opts.stdio, opts.detached]
			})
			expect(calls).toMatchSnapshot()
		})
	}

	it("start, full restart and stop logs", async () => {
		await create().start()
		const start = normalise(lines.splice(0))
		await liveDemod.reconfigure({ gain: 5 })
		const restart = normalise(lines.splice(0))
		await liveDemod.stop()
		const stop = normalise(lines.splice(0))
		expect({ start, restart, stop }).toMatchSnapshot()
	})

	it("status DTO while running and after stop", async () => {
		await create().start()
		const running = liveDemod.getStatus()
		await liveDemod.reconfigure({ offsetHz: 6000 })
		const afterOffset = liveDemod.getStatus()
		await liveDemod.stop()
		expect({
			running,
			afterOffset,
			stopped: liveDemod.getStatus(),
		}).toMatchSnapshot()
	})

	it("stream headers and WAV header", () => {
		for (const stream of [
			{ rate: 25_000, format: "s16le" as const },
			{ rate: 48_000, format: "f32le" as const },
		]) {
			expect({
				headers: streamHeaders(stream),
				wav: wavStreamHeader(stream).toString("hex"),
			}).toMatchSnapshot()
		}
	})

	it("served stream headers on /stream and /stream.wav", async () => {
		await create().start()
		const get = (path: string) =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const req = http.get({ host: "127.0.0.1", port: PORT, path }, res => {
					const headers = { ...res.headers }
					delete headers["date"]
					resolve({ status: res.statusCode, headers })
					res.destroy()
				})
				req.on("error", reject)
			})
		expect({
			raw: await get("/stream"),
			wav: await get("/stream.wav"),
		}).toMatchSnapshot()
	})

	it("keeps clients on an offset, gain or squelch change and closes them on a rate or format change", async () => {
		await create().start()
		const internals = liveDemod as unknown as Internals
		const events: string[] = []
		liveDemod.on("client-disconnected", id => events.push(`closed ${id}`))
		const a = new ClientTransport()
		internals.registerClient(a as unknown as http.ServerResponse, "a")
		await liveDemod.reconfigure({ offsetHz: 6000 })
		await liveDemod.reconfigure({ gain: 5 })
		await liveDemod.reconfigure({ squelch: -40 })
		events.push(`after keep-changes ${liveDemod.getStatus().clientCount}`)
		await liveDemod.reconfigure({ audioFormat: "f32le" })
		events.push(
			`after format ${liveDemod.getStatus().clientCount} ended=${a.writableEnded}`,
		)
		const b = new ClientTransport()
		internals.registerClient(b as unknown as http.ServerResponse, "b")
		await liveDemod.reconfigure({ bandwidth: 50_000 })
		await delay(5)
		events.push(
			`after rate ${liveDemod.getStatus().clientCount} ended=${b.writableEnded}`,
		)
		expect(events).toMatchSnapshot()
	})
})
