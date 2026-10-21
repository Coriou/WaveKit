import { ChildProcess } from "node:child_process"
import pino from "pino"
import { afterEach, expect, it, vi } from "vitest"
import { BaseDecoder } from "../../../../src/decoders/base-decoder.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type { DecoderCaps } from "../../../../src/decoders/types.js"
import type {
	EfficiencyGate,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { placementKey } from "../../../../src/decoders/enablement/contract.js"
import { FakeSources, iqCaps } from "../../../mocks/rate-fakes.js"

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

it.each([
	"stop",
	"concurrent",
	"pending stop",
	"pending concurrent",
	"pending timeout stop",
	"pending timeout destroy",
	"restart",
	"queued restart",
	"scanner hold",
	"probation",
	"exit only",
])("%s retains live accounting and shares worker escalation", async path => {
	vi.useFakeTimers()
	const logger = pino({ level: "silent" })
	const children = new Map<number, ChildProcess>()
	let nextPid = 1_000_000
	let releaseStart!: () => void
	const pendingStart = new Promise<void>(resolve => {
		releaseStart = resolve
	})
	class FakeDecoder extends BaseDecoder {
		failStop = false
		protected getCommand() {
			return "unused"
		}
		protected getArgs() {
			return []
		}
		protected parseOutput() {
			return null
		}
		protected getCaps(): DecoderCaps {
			return {
				input: "iq",
				output: "text",
				integrationPattern: "pure_consumer",
			}
		}
		override async start() {
			if (this.config.id !== "dec" && path.startsWith("pending"))
				await pendingStart
			const child = new ChildProcess()
			Object.defineProperty(child, "pid", { value: ++nextPid })
			children.set(nextPid, child)
			this.process = child
			child.on("exit", (code, signal) => {
				if (this.process === child) this.process = null
				this.emit("exit", code, signal)
			})
			this.emit("started")
		}
		override async stop() {
			if (this.failStop) throw new Error("worker stop failed")
			await super.stop()
		}
	}
	const instances = new Map<string, FakeDecoder>()
	const registry = new DecoderRegistry()
	registry.register(
		"fake",
		config => {
			const decoder = new FakeDecoder(config, logger)
			instances.set(config.id, decoder)
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	const sources = new FakeSources()
	sources.caps.set("rtl", iqCaps(2_400_000))
	const place = (primary: boolean): WantedPlacement => ({
		key: placementKey(
			"dec",
			"rtl",
			primary ? "raw" : "channel",
			primary ? null : 162_025_000,
		),
		decoderId: "dec",
		sourceId: "rtl",
		reach: "raw",
		channelHz: primary ? null : 162_025_000,
		primary,
		origin: "configured",
		costCores: 0.14,
		sampleRateHz: 2_400_000,
	})
	const primary = place(true)
	const worker = place(false)
	const view = vi.fn<EfficiencyGate["view"]>(() => ({
		budgetCores: 1,
		cpuGuardPercent: 90,
		sources: [],
	}))
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: () => ({ admit: true }),
		probation: () =>
			path === "probation" && instances.get(worker.key)?.failStop
				? [
						{
							key: worker.key,
							detail: "drops" as const,
							retryAtMs: Date.now() + 60_000,
						},
					]
				: [],
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view,
	}
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner: () => ({ wanted: [primary, worker], unplaced: new Map() }),
			resolveMode: () => ({ mode: "always", source: "default" }),
			isCatalogue: () => false,
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
			gate,
		},
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.createDecoder({
		id: "dec",
		type: "fake",
		enabled: true,
		options: {},
	})
	const starting = manager.startAll()
	await vi.advanceTimersByTimeAsync(1)
	if (!path.startsWith("pending")) await starting
	const decoder = instances.get(worker.key)!
	decoder.failStop = true
	const workerPid = path.startsWith("pending")
		? nextPid + 1
		: decoder.getStatus().pid!
	const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		const child = children.get(Math.abs(pid))
		if (!child) throw new Error("unexpected pid")
		if (
			Math.abs(pid) !== workerPid ||
			(signal === "SIGKILL" && path !== "exit only")
		) {
			Object.defineProperty(child, "signalCode", { value: signal })
			child.emit("exit", null, signal)
		}
		return true
	})

	const attempts = vi.spyOn(decoder, "stop")
	const operations =
		path === "pending timeout destroy"
			? [manager.destroy()]
			: path === "scanner hold"
				? [manager.holdSource("rtl", "tuner-scanning", "scan")]
				: path === "probation" && instances.get(worker.key)?.failStop
					? []
					: path === "concurrent" || path === "pending concurrent"
						? [
								manager.stopDecoder("dec"),
								manager.removeDecoder(worker.key),
								manager.destroy(),
							]
						: [
								manager.stopDecoder(
									path.includes("restart") ? worker.key : "dec",
								),
							]
	let settled = false
	const stopping = Promise.allSettled(operations).then(results => {
		settled = true
		return results
	})
	let restarting: Promise<void> | undefined
	if (path === "queued restart") {
		restarting = manager.startDecoder(worker.key)
		await vi.advanceTimersByTimeAsync(1)
		expect(decoder.getStatus().pid).toBe(workerPid)
	}
	if (path.startsWith("pending")) {
		await vi.advanceTimersByTimeAsync(1)
		expect(settled).toBe(false)
		expect(attempts).not.toHaveBeenCalled()
		expect(manager.getDecoder(worker.key)).toBe(decoder)
		expect(decoder.listenerCount("exit")).toBeGreaterThan(0)
		if (path.includes("timeout")) {
			await vi.advanceTimersByTimeAsync(5000)
			expect(settled).toBe(true)
			expect(manager.getDecoder(worker.key)).toBe(decoder)
			expect(decoder.listenerCount("exit")).toBeGreaterThan(0)
			expect(
				(
					manager as unknown as {
						decoders: Map<string, { stopping?: boolean }>
					}
				).decoders.get(worker.key)?.stopping,
			).toBe(true)
		}
		releaseStart()
		await vi.advanceTimersByTimeAsync(1)
	}
	if (path === "probation") await vi.advanceTimersByTimeAsync(2500)
	await vi.advanceTimersByTimeAsync(1)
	expect(kill).toHaveBeenCalledWith(-workerPid, "SIGTERM")
	expect(decoder.getStatus().running).toBe(true)
	expect(manager.getDecoder(worker.key)).toBe(decoder)
	expect(decoder.listenerCount("exit")).toBeGreaterThan(0)
	manager.efficiencyView()
	expect(view.mock.calls.at(-1)?.[0].map(item => item.key)).toContain(
		worker.key,
	)
	await vi.advanceTimersByTimeAsync(5000)
	await stopping
	await starting
	if (path === "queued restart") {
		await restarting
		const newPid = decoder.getStatus().pid!
		expect(newPid).not.toBe(workerPid)
		expect(kill.mock.calls.some(([pid]) => pid === -newPid)).toBe(false)
		decoder.failStop = false
		await manager.stopDecoder(worker.key)
	}
	if (path === "exit only") {
		expect(manager.getDecoder(worker.key)).toBe(decoder)
		const child = children.get(workerPid)!
		Object.defineProperty(child, "signalCode", { value: "SIGKILL" })
		// The adapter confirms exit after the signal did not stop its process.
		Object.defineProperty(decoder, "process", { value: null, writable: true })
		decoder.emit("exit", null, "SIGKILL")
	}
	if (path !== "exit only")
		expect(kill).toHaveBeenCalledWith(-workerPid, "SIGKILL")
	expect(decoder.getStatus().running).toBe(false)
	if (
		path !== "scanner hold" &&
		path !== "probation" &&
		!path.includes("restart")
	)
		expect(manager.getDecoder(worker.key)).toBeUndefined()
	for (let evaluation = 0; evaluation < 3; evaluation++) {
		manager.notifyBandplansChanged()
		await vi.advanceTimersByTimeAsync(1)
	}
	await vi.advanceTimersByTimeAsync(5000)
	expect(attempts).toHaveBeenCalledTimes(path === "queued restart" ? 2 : 1)
	expect(
		kill.mock.calls.filter(
			([pid, signal]) => pid === -workerPid && signal === "SIGTERM",
		),
	).toHaveLength(1)
	expect(
		kill.mock.calls.filter(
			([pid, signal]) => pid === -workerPid && signal === "SIGKILL",
		),
	).toHaveLength(1)
	if (path === "restart") {
		decoder.failStop = false
		await manager.startDecoder(worker.key)
		expect(decoder.getStatus().running).toBe(true)
		const stopped = manager.stopDecoder(worker.key)
		await vi.advanceTimersByTimeAsync(1)
		await stopped
		expect(attempts).toHaveBeenCalledTimes(2)
		expect(decoder.getStatus().running).toBe(false)
	}
})
