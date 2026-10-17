import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	IQ_TOOL_MAX_QUEUED_BYTES,
	IQ_TOOL_READY_TIMEOUT_MS,
	IqToolProcess,
	realTimers,
} from "../../../../src/core/iq-capture/process.js"
import type { IqToolEvent } from "../../../../src/core/iq-capture/protocol.js"
import { fakeSpawner, flush, type FakeChild } from "./helpers.js"

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e"

function make(drainStdin = true) {
	const sp = fakeSpawner({ drainStdin })
	const proc = new IqToolProcess({
		binaryPath: "/opt/wavekit-iqcap",
		sampleRateHz: 2_048_000,
		ringMs: 2000,
		outDir: "/state/iq-captures",
		maxMs: 4000,
		bandwidthHz: 12_500,
		spawn: sp.spawn,
		env: {},
		timers: realTimers,
	})
	const events: IqToolEvent[] = []
	proc.on("event", (e: IqToolEvent) => events.push(e))
	proc.start()
	const child = sp.children[0] as FakeChild
	return { proc, child, sp, events }
}

async function ready(child: FakeChild) {
	child.event({ type: "ready" })
	await flush()
}

describe("IqToolProcess", () => {
	it("spawns run with fd 3 control, detached, the fixed argv", () => {
		const { sp } = make()
		const [cmd, args, opts] = sp.spawn.mock.calls[0] ?? []
		expect(cmd).toBe("/opt/wavekit-iqcap")
		expect(args).toEqual([
			"run",
			"--sample-rate",
			"2048000",
			"--ring-ms",
			"2000",
			"--out-dir",
			"/state/iq-captures",
			"--max-ms",
			"4000",
			"--bandwidth",
			"12500",
		])
		expect(opts?.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"])
		expect(opts?.detached).toBe(process.platform !== "win32")
	})

	it("ignores feed before ready and events before ready", async () => {
		const { proc, child, events } = make()
		proc.feed(0, new Uint8Array(100))
		child.event({ type: "captured", id: ID, samples: 1, gapSamples: 0 })
		await flush()
		expect(child.stdinBytes).toHaveLength(0)
		expect(events).toHaveLength(0)
		expect(proc.counters.invalidLines).toBe(1)
	})

	it("maps engine samples to tool counts and declares upstream gaps", async () => {
		const { proc, child } = make()
		await ready(child)
		proc.feed(1000, new Uint8Array(200)) // 100 samples
		expect(proc.toTool(1000)).toBe(0)
		proc.feed(1100, new Uint8Array(20))
		proc.feed(1200, new Uint8Array(20)) // 90 samples missing upstream
		await flush()
		expect(proc.submittedSamples()).toBe(100 + 10 + 90 + 10)
		expect(child.commands()).toEqual([{ type: "gap", samples: 90 }])
		// Overlap keeps only the new part.
		proc.feed(1205, new Uint8Array(20))
		expect(proc.submittedSamples()).toBe(215)
	})

	it("drops above 1 MiB queued, counts it and declares one gap before the next write", async () => {
		const { proc, child } = make(false)
		await ready(child)
		const chunk = new Uint8Array(64 * 1024)
		let sample = 0
		// Fill past the bound: stdin is never read.
		while (proc.queuedBytes() <= IQ_TOOL_MAX_QUEUED_BYTES) {
			proc.feed(sample, chunk)
			sample += chunk.length / 2
		}
		const queued = proc.queuedBytes()
		expect(queued).toBeLessThanOrEqual(IQ_TOOL_MAX_QUEUED_BYTES + chunk.length)
		proc.feed(sample, chunk)
		sample += chunk.length / 2
		proc.feed(sample, chunk)
		sample += chunk.length / 2
		expect(proc.counters.droppedBytes).toBe(2 * chunk.length)
		expect(proc.queuedBytes()).toBe(queued)
		// The consumer drains: the next accepted chunk is preceded by one gap command.
		child.stdin.resume()
		await flush(20)
		proc.feed(sample, chunk)
		await flush()
		expect(child.commands()).toEqual([{ type: "gap", samples: chunk.length }])
		expect(proc.submittedSamples()).toBe(sample + chunk.length / 2)
	})

	it("passes tap bytes as views (no copy)", async () => {
		const { proc, child } = make(false)
		await ready(child)
		const spy = vi.spyOn(child.stdin, "write")
		const buf = new Uint8Array(64)
		proc.feed(0, buf)
		const written = spy.mock.calls[0]?.[0] as Buffer
		expect(written.buffer).toBe(buf.buffer)
	})

	it("counts oversize and invalid lines without emitting", async () => {
		const { proc, child, events } = make()
		await ready(child)
		child.emitLine("x".repeat(5000))
		child.emitLine("{bad")
		child.event({ type: "nope" })
		child.event({ type: "ready" })
		await flush()
		expect(events).toEqual([])
		expect(proc.counters.oversizeLines).toBe(1)
		expect(proc.counters.invalidLines).toBe(3)
	})

	it("stops with shutdown and reports a clean exit", async () => {
		const { proc, child } = make()
		await ready(child)
		const exits: unknown[] = []
		proc.on("exit", (failed: boolean) => exits.push(failed))
		await proc.stop()
		expect(child.commands().at(-1)).toEqual({ type: "shutdown" })
		expect(exits).toEqual([false])
	})

	it("reports a crash as failed", async () => {
		const { proc, child } = make()
		await ready(child)
		const exits: unknown[] = []
		proc.on("exit", (failed: boolean) => exits.push(failed))
		child.exit(101)
		expect(exits).toEqual([true])
		expect(proc.ready).toBe(false)
	})

	it("reports ENOENT", async () => {
		const sp = fakeSpawner({ enoent: true })
		const proc = new IqToolProcess({
			binaryPath: "missing",
			sampleRateHz: 1,
			ringMs: 1,
			outDir: "/x",
			maxMs: 500,
			bandwidthHz: 1,
			spawn: sp.spawn,
			env: {},
			timers: realTimers,
		})
		const exits: unknown[] = []
		proc.on("exit", (failed: boolean, code: string | null) =>
			exits.push([failed, code]),
		)
		proc.start()
		await flush()
		expect(exits).toEqual([[true, "ENOENT"]])
	})
})

describe("IqToolProcess ready timeout", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())
	it("stops a tool that never says ready", async () => {
		const { proc, child } = make()
		const exits: unknown[] = []
		proc.on("exit", (failed: boolean) => exits.push(failed))
		child.autoExit = false
		await vi.advanceTimersByTimeAsync(IQ_TOOL_READY_TIMEOUT_MS + 10)
		expect(child.commands()).toEqual([{ type: "shutdown" }])
		child.exit(0)
		expect(exits).toEqual([true])
	})
})
