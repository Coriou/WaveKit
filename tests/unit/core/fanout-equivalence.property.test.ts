import { PassThrough } from "node:stream"
import * as fc from "fast-check"
import { afterEach, expect, it, vi } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { AbsorberFanoutPort } from "../../../src/core/link-burst/contract.js"
import { createLogger } from "../../../src/utils/logger.js"
import { createFanoutOracle } from "./fanout-oracle.js"

const logger = createLogger({ level: "error" })
const configs = [
	{ id: "normal", highWaterMark: 512 },
	{
		id: "startup",
		highWaterMark: 512,
		startup: { highWaterMark: 4096, durationMs: 1000 },
	},
	{ id: "inactive", highWaterMark: 512, deferred: true },
]
const opsArb = fc.array(
	fc.record({
		kind: fc.constantFrom("write", "read", "expire", "resume", "pause"),
		id: fc.constantFrom("normal", "startup", "inactive"),
		n: fc.oneof(
			{ weight: 9, arbitrary: fc.integer({ min: 1, max: 1024 }) },
			{ weight: 1, arbitrary: fc.integer({ min: 1, max: 70000 }) },
		),
	}),
	{ minLength: 1, maxLength: 12 },
)

function harness() {
	const fanout = new FanoutManager(logger)
	const port: AbsorberFanoutPort = fanout
	const branches = configs.map(config => {
		const stream = fanout.addBranch({
			id: config.id,
			highWaterMark: config.highWaterMark,
			deferred: config.deferred === true || config.startup !== undefined,
		})
		if (config.startup) fanout.activateBranch(config.id, config.startup)
		const output: Buffer[] = []
		const transitions: ("bp" | "drain")[] = []
		stream.on("data", (chunk: Buffer) => {
			output.push(chunk)
		})
		stream.pause()
		fanout.on("backpressure", id => {
			if (id === config.id) transitions.push("bp")
		})
		fanout.on("drain", id => {
			if (id === config.id) transitions.push("drain")
		})
		return { id: config.id, stream, output, transitions }
	})
	return { fanout, port, branches }
}

afterEach(() => vi.useRealTimers())

// Feature: link-burst-resilience, Property 1: Fanout backpressure equivalence
// Validates: Requirements 1.7
it("distribute matches the oracle per branch", async () => {
	await fc.assert(
		fc.asyncProperty(opsArb, async ops => {
			vi.useFakeTimers()
			const real = harness()
			const oracle = createFanoutOracle(configs)
			try {
				for (const [index, op] of ops.entries()) {
					const stream = real.branches.find(
						branch => branch.id === op.id,
					)!.stream
					const reference = oracle.branches.find(
						branch => branch.id === op.id,
					)!.stream
					if (op.kind === "write") {
						const chunk = Buffer.alloc(op.n, index)
						real.port.distribute(chunk)
						oracle.distribute(chunk)
					} else if (op.kind === "read") {
						stream.read(op.n)
						oracle.consume(op.id, op.n)
					} else if (op.kind === "expire") vi.advanceTimersByTime(1000)
					else if (op.kind === "resume") {
						stream.resume()
						reference.resume()
					} else {
						stream.pause()
						reference.pause()
					}
					await new Promise<void>(resolve => process.nextTick(resolve))
				}
				for (const branch of real.branches) branch.stream.resume()
				for (const branch of oracle.branches) branch.stream.resume()
				await new Promise<void>(resolve => process.nextTick(resolve))
				for (const branch of real.branches) {
					const telemetry = real.fanout.getBranchTelemetry(branch.id)!
					const expected = oracle.branches.find(
						item => item.id === branch.id,
					)!.result
					expect(
						Buffer.concat(branch.output).equals(Buffer.from(expected.output)),
					).toBe(true)
					expect({
						transitions: branch.transitions,
						droppedBytesTotal: telemetry.droppedBytesTotal,
						droppedChunksTotal: telemetry.droppedChunksTotal,
						totalBytesWritten: telemetry.totalBytesWritten,
					}).toEqual({
						transitions: expected.transitions,
						droppedBytesTotal: expected.droppedBytesTotal,
						droppedChunksTotal: expected.droppedChunksTotal,
						totalBytesWritten: expected.totalBytesWritten,
					})
				}
			} finally {
				real.fanout.destroy()
				oracle.dispose()
			}
		}),
		{ numRuns: 200 },
	)
})

it("attachSource and distribute are indistinguishable", async () => {
	await fc.assert(
		fc.asyncProperty(opsArb, async ops => {
			vi.useFakeTimers()
			const attached = harness()
			const direct = harness()
			const source = new PassThrough()
			attached.fanout.attachSource(source)
			try {
				for (const [index, op] of ops.entries()) {
					if (op.kind === "write") {
						const chunk = Buffer.alloc(op.n, index)
						source.write(chunk)
						direct.port.distribute(chunk)
					} else if (op.kind === "expire") vi.advanceTimersByTime(1000)
					else
						for (const target of [attached, direct]) {
							const stream = target.branches.find(
								branch => branch.id === op.id,
							)!.stream
							if (op.kind === "read") stream.read(op.n)
							else if (op.kind === "resume") stream.resume()
							else stream.pause()
						}
					await new Promise<void>(resolve => process.nextTick(resolve))
					expect(attached.fanout.getTelemetrySnapshot()).toEqual(
						direct.fanout.getTelemetrySnapshot(),
					)
				}
				for (const target of [attached, direct]) {
					for (const branch of target.branches) branch.stream.resume()
				}
				await new Promise<void>(resolve => process.nextTick(resolve))
				for (const branch of attached.branches) {
					const expected = direct.branches.find(item => item.id === branch.id)!
					expect(
						Buffer.concat(branch.output).equals(Buffer.concat(expected.output)),
					).toBe(true)
					expect(branch.transitions).toEqual(expected.transitions)
				}
			} finally {
				attached.fanout.destroy()
				direct.fanout.destroy()
				source.destroy()
			}
		}),
		{ numRuns: 200 },
	)
})

it("startup-draining branch below its mark is not congested", async () => {
	vi.useFakeTimers()
	const fanout = new FanoutManager(logger)
	try {
		const branch = fanout.addBranch({
			id: "b",
			highWaterMark: 512,
			deferred: true,
		})
		fanout.activateBranch("b", { highWaterMark: 4096, durationMs: 1000 })
		fanout.distribute(Buffer.alloc(512))
		await vi.advanceTimersByTimeAsync(1000)
		const out = new Set(["stale"])
		fanout.congestedBranchIds(out)
		expect([...out]).toEqual(["b"])
		branch.resume()
		await new Promise<void>(resolve => process.nextTick(resolve))
		const before = fanout.getTelemetrySnapshot()
		fanout.congestedBranchIds(out)
		expect([...out]).toEqual([])
		expect(fanout.getTelemetrySnapshot()).toEqual(before)
	} finally {
		fanout.destroy()
	}
})

it("congestedBranchIds lists backpressured active branches only", () => {
	vi.useFakeTimers()
	const { fanout } = harness()
	try {
		fanout.distribute(Buffer.alloc(70000))
		const out = new Set(["stale"])
		fanout.congestedBranchIds(out)
		expect([...out]).toEqual(["normal", "startup"])
		fanout.activeBranchIds(out)
		expect([...out]).toEqual(["normal", "startup"])
		expect(fanout.isBranchActive("inactive")).toBe(false)
		expect(fanout.isBranchActive("missing")).toBe(false)
		expect(fanout.isBranchActive("normal")).toBe(true)
	} finally {
		fanout.destroy()
	}
})

it("attachIngest replaces and detaches the source handlers", () => {
	vi.useFakeTimers()
	const fanout = new FanoutManager(logger)
	const first = new PassThrough()
	const second = new PassThrough()
	const ingest = vi.fn()
	try {
		fanout.attachSource(first)
		fanout.attachIngest(second, ingest)
		for (const event of ["data", "error", "end"])
			expect(first.listenerCount(event)).toBe(0)
		const chunk = Buffer.from([1, 2])
		second.write(chunk)
		expect(ingest).toHaveBeenCalledExactlyOnceWith(chunk)
		fanout.detachSource()
		for (const event of ["data", "error", "end"])
			expect(second.listenerCount(event)).toBe(0)
		second.write(chunk)
		expect(ingest).toHaveBeenCalledTimes(1)
	} finally {
		fanout.destroy()
		first.destroy()
		second.destroy()
	}
})
