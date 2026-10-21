import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { parse } from "yaml"
import { describe, expect, it, vi } from "vitest"
import { ConfigSchema, DigitalVoiceConfigSchema } from "../../../src/config.js"
import {
	composeDecoderModes,
	decoderLinkReporter,
	prepareDecoderVoice,
	composeDecoderChannelizer,
	composeDecoderEfficiencyGate,
	prepareDecoderCatalogue,
	wireDecoderLinkFeed,
	composeDecoderRatePolicyLifetime,
	decoderPolicyTimer,
	decoderSettingsPort,
} from "../../../src/index.js"
import { openDecoderSettingsService } from "../../../src/decoders/settings/service.js"
import { configExportRoutes } from "../../../src/api/routes/config-export.js"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import {
	channelizerComposition,
	channelizerAutoAccepted,
	CATALOGUE_TYPES,
} from "../../../src/decoders/enablement/contract.js"
import type {
	RatePolicy,
	LinkAdvisor,
} from "../../../src/core/rate-policy-contract.js"
import {
	ChannelizerManager,
	type ChannelizerManagerDeps,
} from "../../../src/core/channelizer/channelizer-manager.js"
import {
	checkAllDecodersHealth,
	isReady,
} from "../../../src/utils/health-check.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { TunerController } from "../../../src/core/tuner-controller.js"

import { DigitalVoiceService } from "../../../src/core/digital-voice.js"
import { AudioHttpServer } from "../../../src/core/audio-stream-server.js"
import { wireTunerRatePolicyBroadcast } from "../../../src/api/server.js"

class VoiceSocket extends EventEmitter {
	bind(_port: number, _host: string, callback: () => void) {
		callback()
	}
	address() {
		return { port: 42000 }
	}
	close() {}
}
const sockets = vi.hoisted(() => ({ bind: vi.fn() }))
vi.mock("node:dgram", () => ({
	createSocket: () => {
		sockets.bind()
		return new VoiceSocket()
	},
}))

const entry = () =>
	readFile(new URL("../../../src/index.ts", import.meta.url), "utf8")
const shipped = async () =>
	ConfigSchema.parse(
		parse(
			await readFile(
				new URL("../../../config/default.yaml", import.meta.url),
				"utf8",
			),
		),
	)
const logger = pino({ level: "silent" })

describe("decoder enablement composition", () => {
	it("builds nine catalogue decoders before settings and preserves GET config export", async () => {
		const config = await shipped()
		const before = structuredClone(config)
		const resolver = vi.fn(async () => ({ available: false }))
		const prepared = await prepareDecoderCatalogue(config, "EU", resolver)
		expect(prepared.catalogue.map(c => c.id)).toEqual(CATALOGUE_TYPES)
		expect(prepared.unavailable.size).toBe(9)
		expect(resolver).toHaveBeenCalledTimes(9)
		const directory = await mkdtemp(join(tmpdir(), "decoder-composition-"))
		const settings = await openDecoderSettingsService({
			configs: prepared.catalogue,
			stateDir: directory,
			logger,
		})
		const app = Fastify()
		await app.register(configExportRoutes, {
			getConfig: () => config,
			authorize: () => undefined,
			version: "test",
			now: () => new Date(0),
		})
		const baseApp = Fastify()
		await baseApp.register(configExportRoutes, {
			getConfig: () => before,
			authorize: () => undefined,
			version: "test",
			now: () => new Date(0),
		})
		try {
			for (const id of CATALOGUE_TYPES) expect(settings.view(id)).toBeDefined()
			expect((await app.inject("/api/config/export")).body).toBe(
				(await baseApp.inject("/api/config/export")).body,
			)
			expect(config).toEqual(before)
			const source = await entry()
			expect(source.indexOf("await prepareDecoderCatalogue(")).toBeLessThan(
				source.indexOf(
					"const decoderSettings = await openDecoderSettingsService(",
				),
			)
		} finally {
			await app.close()
			await baseApp.close()
			await settings.close()
			await rm(directory, { recursive: true, force: true })
		}
	})
	it.each([false, true])(
		"catalogue voice availability %s controls socket setup and service startup",
		async available => {
			sockets.bind.mockClear()
			const start = vi
				.spyOn(AudioHttpServer.prototype, "start")
				.mockResolvedValue()
			const config = await shipped()
			const prepared = await prepareDecoderCatalogue(
				config,
				"EU",
				async () => ({ available }),
			)
			const voice = new DigitalVoiceService(
				logger,
				DigitalVoiceConfigSchema.parse(config.digitalVoice),
			)
			const base = new DigitalVoiceService(
				logger,
				DigitalVoiceConfigSchema.parse(config.digitalVoice),
			)
			try {
				await prepareDecoderVoice(base, [], new Set(), new Set())
				const baseline = base.getStatus()
				await prepareDecoderVoice(
					voice,
					prepared.catalogue,
					prepared.catalogueIds,
					prepared.unavailable,
				)
				if (voice.getStatus().decoders.length) await voice.start()
				expect(sockets.bind).toHaveBeenCalledTimes(available ? 1 : 0)
				expect(start).toHaveBeenCalledTimes(available ? 1 : 0)
				if (!available) expect(voice.getStatus()).toEqual(baseline)
			} finally {
				await voice.destroy()
				await base.destroy()
				start.mockRestore()
			}
		},
	)
	it("forwards link advice through the composed aggregator callback", () => {
		const reportLinkAdvisory = vi.fn()
		const report = decoderLinkReporter(() => ({ reportLinkAdvisory }))
		const advisory: Parameters<typeof report>[1] = {
			level: "unproven",
			transport: "network",
			payloadBytesPerSecond: 4800000,
			sustainedBytesPerSecond: null,
			shortfallPercent: null,
			upstreamDropBytesPerSecond: null,
		}
		report("s1", advisory)
		expect(reportLinkAdvisory).toHaveBeenCalledExactlyOnceWith("s1", advisory)
	})
	it.each([
		{
			running: false,
			desiredRunning: false,
			suspended: false,
			health: "stopped",
			excluded: true,
		},
		{
			running: false,
			desiredRunning: true,
			suspended: true,
			health: "stopped",
			excluded: true,
		},
		{
			running: true,
			desiredRunning: true,
			suspended: true,
			transition: "suspending",
			health: "faulted",
			excluded: false,
		},
		{
			running: true,
			desiredRunning: false,
			suspended: false,
			health: "faulted",
			excluded: false,
		},
		{
			running: false,
			desiredRunning: false,
			suspended: false,
			health: "faulted",
			excluded: false,
		},
		{
			running: false,
			desiredRunning: true,
			suspended: true,
			pid: 123,
			health: "stopped",
			excluded: false,
		},
	])("keeps failed stop/suspend states in health: %j", value => {
		const status = { id: "dsd-fme", origin: "catalogue", ...value }
		const manager = {
			isDecoderConfirmedStopped: () => true,
			getAllHealth: () => new Map([["dsd-fme", value.health]]),
			getAllStatus: () => [status],
		} as unknown as DecoderManager
		expect(Object.keys(checkAllDecodersHealth(manager))).toEqual(
			value.excluded ? [] : ["dsd-fme"],
		)
		const sources = { getAllStatus: () => [] } as unknown as SourceManager
		expect(isReady(manager, sources)).toBe(value.excluded || value.running)
	})

	it("catalogue false yields no derived decoders or binary checks", async () => {
		const config = await shipped()
		config.decoderPolicy = { catalogue: false }
		const resolver = vi.fn(async () => ({ available: false }))
		expect(
			(await prepareDecoderCatalogue(config, "EU", resolver)).catalogue,
		).toEqual([])
		expect(resolver).not.toHaveBeenCalled()
	})
	it("enablement recheckAvailable resolves the binary again", async () => {
		let available = false
		const resolver = vi.fn(async () => ({ available }))
		const prepared = await prepareDecoderCatalogue(
			await shipped(),
			"EU",
			resolver,
		)
		available = true
		expect(await prepared.recheckAvailable("readsb")).toBe(true)
		expect(prepared.unavailable.has("readsb")).toBe(false)
		expect(resolver).toHaveBeenLastCalledWith("readsb", process.env)
	})
	it("settings mode applies live through the composition manager binding", async () => {
		const { catalogue } = await prepareDecoderCatalogue(
			await shipped(),
			"EU",
			async () => ({ available: false }),
		)
		const directory = await mkdtemp(join(tmpdir(), "decoder-composition-mode-"))
		const manager = {
			getStatus: () => undefined,
			stageDecoderOptions: () => false,
			isRestartPending: () => false,
			applyDecoderMode: vi.fn(async (_id: string, _mode: string) => {}),
		}
		const binding = composeDecoderModes(
			() => id => ({
				mode: settings.view(id)?.mode?.value ?? "auto",
				source: "settings",
			}),
			() => manager,
		)
		const settings = await openDecoderSettingsService({
			configs: catalogue,
			stateDir: directory,
			logger,
			applyDecoderMode: binding.applyDecoderMode,
		})
		settings.setManager(decoderSettingsPort(manager))
		try {
			await settings.update("readsb", { mode: "off" })
			expect(manager.applyDecoderMode).toHaveBeenCalledExactlyOnceWith(
				"readsb",
				"off",
			)
			expect(binding.resolvedModes.get("readsb")).toEqual({
				mode: "off",
				source: "settings",
			})
			await settings.update("readsb", { mode: "always" })
			expect(binding.resolvedModes.get("readsb")).toEqual({
				mode: "always",
				source: "settings",
			})
		} finally {
			await settings.close()
			await rm(directory, { recursive: true, force: true })
		}
	})
	it("metrics event feeds observe and connected resets", () => {
		const sources = new EventEmitter()
		const tuner = {
			getState: vi.fn(() => ({ sampleRate: 2_400_000 })),
		} as unknown as Pick<TunerController, "getState">
		const link = { observe: vi.fn(), reset: vi.fn() } as unknown as LinkAdvisor
		const policy = { reset: vi.fn() }
		const close = wireDecoderLinkFeed(
			sources as unknown as Pick<SourceManager, "on" | "off">,
			tuner,
			link,
			policy,
			() => 42,
		)
		sources.emit("metrics", "s1", { bytesReceived: 1, dataRate: 4_000 })
		expect(link.observe).toHaveBeenCalledExactlyOnceWith(
			"s1",
			4_096_000,
			2_400_000,
			42,
		)
		sources.emit("connected", "s1")
		expect(link.reset).toHaveBeenCalledExactlyOnceWith("s1")
		expect(policy.reset).toHaveBeenCalledExactlyOnceWith("s1")
		close()
		expect(sources.listenerCount("metrics")).toBe(0)
		expect(sources.listenerCount("connected")).toBe(0)
	})
	it("relay retunes and operator writes reach the policy; shutdown disposes and detaches", async () => {
		const policy: RatePolicy = {
			beforeOperatorRetune: vi.fn(async () => {}),
			onOperatorSampleRate: vi.fn(),
			onRelayRetune: vi.fn(),
			recordFor: vi.fn(() => undefined),
			reset: vi.fn(),
			dispose: vi.fn(),
		}
		let before: RatePolicy["beforeOperatorRetune"] | null = null
		let relay: RatePolicy["onRelayRetune"] | null = null
		let rate: RatePolicy["onOperatorSampleRate"] | null = null
		let record: RatePolicy["recordFor"] | null = null
		const sources = new EventEmitter()
		const close = composeDecoderRatePolicyLifetime(
			sources as unknown as Pick<SourceManager, "on" | "off">,
			{
				getState: () => undefined,
				setBeforeOperatorRetune: hook => {
					before = hook
				},
				setOnRelayRetune: hook => {
					relay = hook
				},
				setOnOperatorSampleRate: hook => {
					rate = hook
				},
				setRatePolicyRecordFor: hook => {
					record = hook
				},
			},
			{ observe: vi.fn(), reset: vi.fn() } as unknown as LinkAdvisor,
			policy,
		)
		// Setters capture hooks synchronously.
		await (before as unknown as RatePolicy["beforeOperatorRetune"])(
			"s1",
			1_090_000_000,
			{ origin: "rest" },
		)
		;(relay as unknown as RatePolicy["onRelayRetune"])("s1", 1_090_000_000)
		;(rate as unknown as RatePolicy["onOperatorSampleRate"])("s1")
		;(record as unknown as RatePolicy["recordFor"])("s1")
		expect(policy.beforeOperatorRetune).toHaveBeenCalledWith(
			"s1",
			1_090_000_000,
			{ origin: "rest" },
		)
		expect(policy.onRelayRetune).toHaveBeenCalledExactlyOnceWith(
			"s1",
			1_090_000_000,
		)
		expect(policy.onOperatorSampleRate).toHaveBeenCalledExactlyOnceWith("s1")
		expect(policy.recordFor).toHaveBeenCalledExactlyOnceWith("s1")
		close()
		expect(policy.dispose).toHaveBeenCalledOnce()
		expect(sources.listenerCount("metrics")).toBe(0)
		expect(sources.listenerCount("connected")).toBe(0)
		expect([before, relay, rate, record]).toEqual([null, null, null, null])
	})
	it("gate CPU and retry decisions use monotonic time across wall clock changes", () => {
		let mono = 100_000
		const drops = {
			monoNow: () => mono,
			sources: () => ["s1"],
			dropState: () => ({ state: "ok" as const, dropBytesPerSecond: 0 }),
			droppedSinceMono: () => false,
			droppedWithinMs: () => false,
		}
		const gate = composeDecoderEfficiencyGate(
			{ budgetCores: 1.5, cpuGuardPercent: 90 },
			drops,
		)
		const placement = {
			key: "readsb#raw@s1",
			decoderId: "readsb",
			sourceId: "s1",
			channelHz: null,
			reach: "raw" as const,
			costCores: 0.25,
			sampleRateHz: 2_400_000,
			primary: true,
			origin: "configured" as const,
		}
		gate.record({ atMs: Date.now(), cpuPercent: 95, sources: new Map() })
		const decision = gate.admit(placement, [], mono)
		expect(decision.admit).toBe(false)
		if (!decision.admit) {
			expect(decision.detail).toBe("cpu")
			expect(decision.retryAtMs).toBe(mono + 300_000)
		}
		mono += 2000
		expect(
			gate.view([], [{ placement, decision }], mono).sources[0]?.cpu.percent,
		).toBe(95)
		const retry = gate.admit(placement, [], mono)
		expect(retry.admit).toBe(false)
		if (!retry.admit) expect(retry.retryAtMs).toBe(mono + 298_000)
		mono += 300_000
		gate.record({ atMs: -1, cpuPercent: 1, sources: new Map() })
		expect(gate.admit(placement, [], mono)).toEqual({ admit: true })
	})
	it("policy timers are unreferenced and cancellable", () => {
		const timeout = vi.spyOn(globalThis, "setTimeout")
		const callback = vi.fn()
		const timer = decoderPolicyTimer(callback, 60_000)
		const native = timeout.mock.results[0]?.value as NodeJS.Timeout
		expect(native.hasRef()).toBe(false)
		timer.cancel()
		timeout.mockRestore()
	})
	it.each(["disabled", "auto", "enabled"] as const)(
		"%s channelizer constructs observation only when needed and never spawns eagerly",
		async mode => {
			const config = await shipped()
			if (mode === "enabled") config.channelizer.enabled = true
			const sources = Object.assign(new EventEmitter(), {
				getCaps: () => undefined,
			})
			const createProcess =
				vi.fn<NonNullable<ChannelizerManagerDeps["createProcess"]>>()
			const retune = vi.fn(
				async (_source: string, _channel: string, _hz: number) =>
					"retuned" as const,
			)
			const factory = vi.fn((deps: ChannelizerManagerDeps) => {
				const manager = new ChannelizerManager({ ...deps, createProcess })
				vi.spyOn(manager, "retuneChannel").mockImplementation(retune)
				return manager
			})
			const composed = composeDecoderChannelizer(
				{
					sourceManager:
						sources as unknown as ChannelizerManagerDeps["sourceManager"],
					routing: {} as ChannelizerManagerDeps["routing"],
					config: config.channelizer,
					logger,
				},
				async () => ({ ok: true }),
				mode === "auto",
				factory,
			)
			if (mode === "disabled") {
				expect(factory).not.toHaveBeenCalled()
				expect(composed).toEqual({
					channelizer: null,
					channels: null,
					observer: undefined,
					lifetime: undefined,
				})
			} else {
				expect(factory).toHaveBeenCalledOnce()
				expect(composed.observer).toBeDefined()
				const deps = factory.mock.calls[0]![0]
				if (mode === "auto") expect(deps.idleStopMs).toBe(60_000)
				else expect(Object.hasOwn(deps, "idleStopMs")).toBe(false)
				const retarget = composed.channels as unknown as {
					retuneChannel: ChannelizerManager["retuneChannel"]
				}
				expect(await retarget.retuneChannel("s1", "vfo", 162_025_000)).toBe(
					"retuned",
				)
				expect(retune).toHaveBeenCalledExactlyOnceWith("s1", "vfo", 162_025_000)
				await composed.channelizer!.destroy()
			}
			expect(createProcess).not.toHaveBeenCalled()
		},
	)
	it("unavailable catalogue instances preserve empty-runtime health and readiness", () => {
		const manager = {
			isDecoderConfirmedStopped: () => true,
			getAllHealth: () => new Map(),
			getAllStatus: () => [
				{
					id: "readsb",
					origin: "catalogue",
					running: false,
					desiredRunning: true,
					suspended: true,
				},
			],
		} as unknown as DecoderManager
		const sources = { getAllStatus: () => [] } as unknown as SourceManager
		expect(checkAllDecodersHealth(manager)).toEqual({})
		expect(isReady(manager, sources)).toBe(true)
	})
	it("uses gated lazy channelizer composition and auto-only idle linger", async () => {
		const config = await shipped()
		// Shipped config: auto (lazy, idle-linger) on x86-64; nothing on arm64.
		expect(
			channelizerComposition(
				config.channelizer,
				channelizerAutoAccepted("x64"),
			),
		).toBe("auto")
		expect(
			channelizerComposition(
				config.channelizer,
				channelizerAutoAccepted("arm64"),
			),
		).toBeNull()
		expect(
			channelizerComposition({ ...config.channelizer, enabled: true }, false),
		).toBe("enabled")
		const source = await entry()
		expect(source.includes("if (chanMode === null)")).toBe(true)
		// The composition passes the host architecture to the acceptance.
		expect(source.includes("channelizerAutoAccepted(arch())")).toBe(true)
		expect(source.includes('chanMode === "auto"')).toBe(true)
		expect(source.includes("idleStopMs: CHANNELIZER_IDLE_STOP_MS")).toBe(true)
		expect(source.includes("decoderManager.setChannelizer(channels)")).toBe(
			true,
		)
	})
	it("registers GET decoders efficiency and forwards rate policy on the tuner channel", async () => {
		const app = Fastify()
		const view = { budgetCores: 1.5, cpuGuardPercent: 90, sources: [] }
		await app.register(decoderRoutes, {
			decoderManager: {
				efficiencyView: () => view,
			} as unknown as DecoderRoutesOptions["decoderManager"],
		})
		try {
			expect((await app.inject("/api/decoders/efficiency")).json()).toEqual(
				view,
			)
		} finally {
			await app.close()
		}
		const tuner = new EventEmitter()
		const broadcast = vi.fn()
		wireTunerRatePolicyBroadcast(
			tuner as unknown as Pick<TunerController, "on">,
			{ broadcast },
		)
		const event = { sourceId: "s1", action: "raise" }
		tuner.emit("rate-policy", event)
		expect(broadcast).toHaveBeenCalledExactlyOnceWith("tuner", {
			type: "tuner:rate-policy",
			data: event,
		})
	})
	it("connects planner, monotonic drop reader, link alerts and shutdown in main", async () => {
		const source = await entry()
		for (const seam of [
			"bandplanRangeContains",
			"getResolved: () => bandPlanService?.resolved()",
			"onSettled: value => decoderManager.notifyVfoSettled(value)",
			"sourceRouting.branchDropCounters(id)",
			"sourceRouting.branchTopology(id)",
			"composeDecoderEfficiencyGate(",
			"decoderManager.notifyBandplansChanged()",
			"closeRatePolicy()",
			"monitor.stop()",
		])
			expect(source.includes(seam), seam).toBe(true)
	})
})
