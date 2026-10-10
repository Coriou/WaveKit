import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "node:fs"
import pino from "pino"
import {
	ChannelizerProcess,
	buildChannelizerArgs,
} from "../../../src/core/channelizer/channelizer-process.js"
import type { ChannelizerEvent } from "../../../src/core/channelizer/protocol.js"
import { writeExecutable } from "../../mocks/executables.js"
import { FAKE_WAVEKIT_CHAN } from "../../mocks/fake-wavekit-chan.js"

const logger = pino({ level: "silent" })
// Short and under /tmp: macOS caps a Unix socket path at ~104 bytes.
const root = `/tmp/wkc-test-${process.pid}`
const bin = `${root}/wavekit-chan`
const socketDir = `${root}/s`
beforeAll(() => {
	mkdirSync(socketDir, { recursive: true })
	writeExecutable(bin, FAKE_WAVEKIT_CHAN)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
	delete process.env["FAKE_CHAN_MODE"]
})

const opts = (
	extra: Partial<Parameters<typeof buildChannelizerArgs>[0]> = {},
) => ({
	binaryPath: bin,
	generation: 4,
	inputRateHz: 2_048_000,
	inputCenterHz: 162e6,
	usableFraction: 0.8,
	blockSamples: 16384,
	socketDir,
	readyTimeoutMs: 3000,
	stopTimeoutMs: 1000,
	...extra,
})
const openA = {
	v: 1,
	type: "open",
	id: "a",
	centerHz: 162e6,
	bandwidthHz: 45_600,
	transitionHz: 1_200,
	outputRateHz: 48_000,
	format: "cf32",
	queueBytes: 96_000,
} as const

/** Records events and the exit in arrival order. */
function record(p: ChannelizerProcess) {
	const log: string[] = []
	const protocolErrors: string[] = []
	const exit = new Promise<[number | null, string | null]>(resolve =>
		p.once("exit", (code: number | null, signal: string | null) => {
			log.push("exit")
			resolve([code, signal])
		}),
	)
	p.on("event", (e: ChannelizerEvent) =>
		log.push("id" in e ? `${e.type}:${e.id}` : e.type),
	)
	p.on("protocol-error", (line: string) => protocolErrors.push(line))
	return { log, protocolErrors, exit }
}

describe("ChannelizerProcess", { timeout: 15_000 }, () => {
	it("builds the addendum §11 spawn line plus --control-fd 3", () => {
		expect(buildChannelizerArgs(opts())).toEqual([
			"--generation",
			"4",
			"--input-format",
			"cu8",
			"--input-rate",
			"2048000",
			"--input-center",
			"162000000",
			"--usable-fraction",
			"0.8",
			"--block-samples",
			"16384",
			"--socket-dir",
			socketDir,
			"--control-fd",
			"3",
		])
	})

	it("starts on ready, relays events and stops cleanly", async () => {
		const p = new ChannelizerProcess(opts(), logger)
		const r = record(p)
		await p.start()
		const opened = new Promise(resolve =>
			p.on("event", (e: ChannelizerEvent) => {
				if (e.type === "opened") resolve(e)
			}),
		)
		p.send(openA)
		expect(await opened).toMatchObject({ id: "a", generation: 4 })
		await p.stop()
		expect(await r.exit).toEqual([0, null])
		// stop() writes shutdown, then ends stdin and control: the child sees whichever arrives first (runtime.rs
		// races them on one channel too). Shutdown closes every open channel; input EOF reports input-eof.
		expect([
			["ready", "opened:a", "closed:a", "exit"],
			["ready", "opened:a", "input-eof", "exit"],
		]).toContainEqual(r.log)
		// Every line passed the v1 schema.
		expect(r.protocolErrors).toEqual([])
	})

	it("rejects with CHANNELIZER_UNAVAILABLE when the binary is missing or never ready", async () => {
		const missing = new ChannelizerProcess(
			opts({ binaryPath: "/nonexistent/wavekit-chan" }),
			logger,
		)
		const exits: unknown[] = []
		missing.on("exit", (...args: unknown[]) => exits.push(args))
		await expect(missing.start()).rejects.toMatchObject({
			code: "CHANNELIZER_UNAVAILABLE",
		})
		// No process ever existed, so Node's trailing `close` (code -2) is not reported as an exit.
		await new Promise(resolve => setTimeout(resolve, 100))
		expect(exits).toEqual([])
		process.env["FAKE_CHAN_MODE"] = "no-ready"
		const p = new ChannelizerProcess(opts({ readyTimeoutMs: 300 }), logger)
		const r = record(p)
		await expect(p.start()).rejects.toMatchObject({
			code: "CHANNELIZER_UNAVAILABLE",
		})
		// The timed-out process is stopped, not leaked.
		expect(await r.exit).toEqual([0, null])
	})

	it("reports malformed stdout lines as protocol-error without crashing", async () => {
		process.env["FAKE_CHAN_MODE"] = "garbage"
		const p = new ChannelizerProcess(opts(), logger)
		const bad = new Promise(resolve => p.once("protocol-error", resolve))
		await p.start()
		expect(await bad).toBe("not json")
		await p.stop()
	})

	it("stops a process whose stdout runs past 64 KiB without a newline", async () => {
		process.env["FAKE_CHAN_MODE"] = "runaway-line"
		const p = new ChannelizerProcess(opts(), logger)
		const r = record(p)
		const errors: [string, string][] = []
		p.on("protocol-error", (line: string, error: string) =>
			errors.push([line, error]),
		)
		await p.start()
		// The process is stopped (shutdown, then signals) instead of growing a line without bound.
		await r.exit
		expect(errors).toHaveLength(1)
		const [line, error] = errors[0]!
		expect(error).toMatch(/no newline within 65536 bytes/)
		// Only a prefix of the runaway line is reported.
		expect(line.length).toBeLessThanOrEqual(256)
		expect(line.startsWith("xxxx")).toBe(true)
		expect(r.log).toEqual(["ready", "exit"])
		await p.stop()
	})

	it("reports the exit after the last event line, so input-eof precedes an exit 0", async () => {
		const p = new ChannelizerProcess(opts(), logger)
		const r = record(p)
		await p.start()
		p.input.end(Buffer.from([1, 2, 3]))
		expect(await r.exit).toEqual([0, null])
		expect(r.log).toEqual(["ready", "input-eof", "exit"])
		await p.stop()
	})

	it("swallows writes to stdin and control after the child died", async () => {
		process.env["FAKE_CHAN_MODE"] = "crash-after-open"
		const p = new ChannelizerProcess(opts(), logger)
		const r = record(p)
		await p.start()
		const input = p.input
		p.send(openA)
		expect(await r.exit).toEqual([1, null])
		// Neither throws nor surfaces an unhandled EPIPE (vitest fails the run on one).
		p.send({ v: 1, type: "close", id: "a" })
		input.write(Buffer.alloc(4096))
		await new Promise(resolve => setTimeout(resolve, 100))
		await p.stop()
	})

	it("escalates to SIGTERM when the process ignores shutdown", async () => {
		process.env["FAKE_CHAN_MODE"] = "ignore-shutdown"
		const p = new ChannelizerProcess(opts({ stopTimeoutMs: 200 }), logger)
		const r = record(p)
		await p.start()
		const started = Date.now()
		await Promise.all([p.stop(), p.stop()])
		expect(await r.exit).toEqual([null, "SIGTERM"])
		expect(Date.now() - started).toBeGreaterThanOrEqual(150)
	})

	it("refuses a second start", async () => {
		const p = new ChannelizerProcess(opts(), logger)
		await p.start()
		await expect(p.start()).rejects.toMatchObject({
			code: "CHANNELIZER_UNAVAILABLE",
		})
		await p.stop()
	})
})
