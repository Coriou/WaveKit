/**
 * Core channelizer: DecoderManager channel integration.
 * Spec: docs/superpowers/specs/2026-10-09-core-channelizer-prototype-addendum.md §4, §5, §12.11;
 * plan A3, A14, Review Focus 3, 4, 5; delta E10.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Readable } from "node:stream"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	DecoderChannelRequestResult,
	DecoderConfig,
} from "../../../src/decoders/types.js"
import {
	FakeSources,
	RateDecoder,
	deferred,
	iqCaps,
} from "../../mocks/rate-fakes.js"
import { FakeChannelProvider } from "../../mocks/channel-fakes.js"

const DEBOUNCE = 350
const CENTER = 162e6

class ChannelDecoder extends RateDecoder {
	request: DecoderChannelRequestResult | undefined = {
		centerHz: CENTER,
		bandwidthHz: 364_800,
		transitionHz: 9_600,
		outputRateHz: 384_000,
		format: "cu8",
	}
	attached: Readable[] = []
	detachedAt: string[] = []
	/** RateDecoder.updateOptions is a no-op; record what the manager injects. */
	options: Record<string, unknown> = {}
	requestInputs: Array<{ sampleRateHz: number; centerHz?: number }> = []
	getChannelRequest(input: { sampleRateHz: number; centerHz?: number }) {
		this.requestInputs.push(input)
		return this.request
	}
	override updateOptions(updates: Record<string, unknown>) {
		Object.assign(this.options, updates)
	}
	override attachInput(s: Readable) {
		this.attached.push(s)
		super.attachInput(s)
	}
	override detachInput() {
		if (this.input)
			this.detachedAt.push(
				this.input.destroyed ? "after-destroy" : "before-destroy",
			)
		super.detachInput()
	}
}

let sources: FakeSources
let fanout: FanoutManager
let provider: FakeChannelProvider
let manager: DecoderManager
let decoders: Map<string, ChannelDecoder>
let configs: Map<string, DecoderConfig>
let statusEvents: string[]
let restarting: string[]
let logLines: Array<Record<string, unknown>>

function create(
	id: string,
	opts: {
		useChannelizer?: boolean
		band?: number[]
		bandSuspension?: boolean
	} = {},
) {
	const config: DecoderConfig = {
		id,
		type: "chan-test",
		enabled: true,
		options: { band: opts.band },
		...(opts.useChannelizer ? { useChannelizer: true } : {}),
	}
	configs.set(id, config)
	manager.createDecoder(config)
	return decoders.get(id)!
}
function status(id = "dec") {
	return manager.getStatus(id)!
}
async function settle() {
	await vi.advanceTimersByTimeAsync(DEBOUNCE)
}
function setup(bandSuspension = true) {
	vi.useFakeTimers()
	logLines = []
	const logger = pino(
		{ level: "info" },
		{ write: (line: string) => void logLines.push(JSON.parse(line)) },
	)
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
	decoders = new Map()
	configs = new Map()
	const registry = new DecoderRegistry()
	registry.register(
		"chan-test",
		config => {
			const decoder = new ChannelDecoder(config.id, {
				input: "iq",
				output: "text",
				integrationPattern: "pure_consumer",
			})
			const targets = config.options["band"] as number[] | undefined
			if (targets) decoder.band = { targetsHz: targets, basis: "configured" }
			decoders.set(config.id, decoder)
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	fanout = new FanoutManager(logger)
	manager = new DecoderManager(registry, fanout, logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
		bandSuspension,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	provider = new FakeChannelProvider()
	manager.setChannelizer(provider)
	statusEvents = []
	restarting = []
	manager.on("decoder:status-changed", (id: string) => statusEvents.push(id))
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
}

beforeEach(() => setup())
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("DecoderManager + channelizer (addendum §4, §5)", () => {
	it("wires a channel instead of a fanout branch and injects the realised rate", async () => {
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		expect(provider.calls).toHaveLength(1)
		expect(provider.calls[0]).toMatchObject({
			sourceId: "rtl",
			decoderId: "dec",
			inputCaps: { sampleRate: 2_048_000, centerFreq: CENTER },
		})
		expect(decoder.requestInputs.at(-1)).toEqual({
			sampleRateHz: 2_048_000,
			centerHz: CENTER,
		})
		expect(fanout.getBranchIds()).not.toContain("decoder-dec")
		expect(decoder.attached).toEqual([provider.streams.get("dec-g1")])
		expect(decoder.options).toMatchObject({
			inputSampleRate: 384_000,
			inputCenterFreq: CENTER,
			inputIqFormat: "cu8",
		})
		expect(decoder.running).toBe(true)
		expect(status().rateAssessment).toMatchObject({
			adaptation: "resample",
			frontendRateHz: 384_000,
		})
		expect(sources.assignments.get("dec")).toBe("rtl")
	})

	it("injects cf32 and the channel's realised rate for a cf32 tail", async () => {
		const decoder = create("dec", { useChannelizer: true })
		decoder.request = {
			centerHz: CENTER + 25_000,
			bandwidthHz: 12_500,
			transitionHz: 6_250,
			outputRateHz: 48_000,
			format: "cf32",
		}
		await manager.startDecoder("dec")
		expect(decoder.options).toMatchObject({
			inputSampleRate: 48_000,
			inputCenterFreq: CENTER + 25_000,
			inputIqFormat: "cf32",
		})
	})

	it("omits centerHz from the request input while the capture centre is unknown", async () => {
		sources.caps.set("rtl", iqCaps(2_048_000))
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		expect(decoder.requestInputs.at(-1)).toEqual({ sampleRateHz: 2_048_000 })
		expect(Object.keys(decoder.requestInputs.at(-1)!)).not.toContain("centerHz")
	})

	// Feature: core-channelizer, Property 11: Rejection is a suspension
	// Validates: addendum §5, §12.11
	it("turns every rejection into a suspension without failure accounting", async () => {
		for (const reasonCode of [
			"channel-outside-capture",
			"channel-request-invalid",
			"channelizer-unavailable",
		] as const) {
			provider.results.push({ ok: false, reasonCode, detail: "x" })
			const id = `dec-${reasonCode}`
			create(id, { useChannelizer: true })
			await manager.startDecoder(id)
			const s = manager.getStatus(id)!
			expect(s).toMatchObject({
				suspended: true,
				desiredRunning: true,
				restartCount: 0,
				health: "running",
			})
			// DecoderStatus has no `enabled`; state.config is the DecoderConfig passed to createDecoder.
			expect(configs.get(id)!.enabled).toBe(true)
			expect(s.suspension).toBeUndefined() // plan A3: no false rate code in the DTO
			expect("suspension" in s).toBe(false)
			expect(s.lastError ?? null).toBeNull()
			expect(decoders.get(id)!.starts).toBe(0)
			expect(decoders.get(id)!.attached).toEqual([])
			// Suspension keeps the source reservation (rate-model §4.2).
			expect(sources.assignments.get(id)).toBe("rtl")
		}
		expect(restarting).toEqual([])
	})

	it("an invalid request from the decoder is a channel-request-invalid suspension with no request sent", async () => {
		const decoder = create("dec", { useChannelizer: true })
		decoder.request = { invalid: "two frequencies and no channelHz" }
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([])
		expect(status()).toMatchObject({ suspended: true, desiredRunning: true })
		expect(decoder.starts).toBe(0)
		expect(
			logLines.some(
				l =>
					l["reasonCode"] === "channel-request-invalid" &&
					l["detail"] === "two frequencies and no channelHz",
			),
		).toBe(true)
	})

	it("a throwing getChannelRequest is a channel-request-invalid suspension, not a crash", async () => {
		const decoder = create("dec", { useChannelizer: true })
		decoder.getChannelRequest = () => {
			throw new Error("bad options")
		}
		await expect(manager.startDecoder("dec")).resolves.toBeUndefined()
		expect(provider.calls).toEqual([])
		expect(status()).toMatchObject({ suspended: true })
		expect(status().lastError ?? null).toBeNull()
	})

	it("logs channelizer-unavailable once across decoders", async () => {
		// Review Focus 4
		provider.results.push(
			{ ok: false, reasonCode: "channelizer-unavailable", detail: "ENOENT" },
			{ ok: false, reasonCode: "channelizer-unavailable", detail: "ENOENT" },
		)
		create("a", { useChannelizer: true })
		create("b", { useChannelizer: true })
		create("raw")
		await manager.startDecoder("a")
		await manager.startDecoder("b")
		await manager.startDecoder("raw")
		const errors = logLines.filter(
			l =>
				l["level"] === 50 &&
				JSON.stringify(l).includes("channelizer-unavailable"),
		)
		expect(errors).toHaveLength(1)
		expect(status("a").suspended).toBe(true)
		expect(status("b").suspended).toBe(true)
		expect(status("raw").running).toBe(true)
		expect(fanout.getBranchIds()).toContain("decoder-raw")
	})

	it("keeps retrying channelizer-unavailable on identical caps (A14, PF6)", async () => {
		provider.results.push({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "ENOENT",
		})
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		expect(status().suspended).toBe(true)
		sources.setCenter("rtl", CENTER)
		await settle()
		expect(provider.calls).toHaveLength(2)
		expect(status()).toMatchObject({ suspended: false, running: true })
		expect(decoder.starts).toBe(1)
	})

	it("detaches synchronously on invalidation and restarts through the worker without budget", async () => {
		// Review Focus 3; delta E10e
		const decoder = create("dec", { useChannelizer: true })
		const onVoice = () => {}
		decoder.on("voice-call", onVoice)
		await manager.startDecoder("dec")
		const voiceListeners = decoder.listenerCount("voice-call")
		provider.invalidate("rtl", ["dec-g1"])
		expect(decoder.detachedAt).toEqual(["before-destroy"])
		expect(decoder.input).toBeNull()
		await settle()
		expect(provider.calls).toHaveLength(2)
		expect(decoder.attached.at(-1)).toBe(provider.streams.get("dec-g2"))
		expect(decoder.input).toBe(provider.streams.get("dec-g2"))
		expect(status()).toMatchObject({
			running: true,
			suspended: false,
			restartCount: 0,
		})
		expect(restarting).toEqual([])
		expect(status().lastError ?? null).toBeNull()
		// Digital-voice wiring survives: same instance, same listeners.
		expect(manager.getDecoder("dec")).toBe(decoder)
		expect(decoders.get("dec")).toBe(decoder)
		expect(decoder.listenerCount("voice-call")).toBe(voiceListeners)
	})

	it("ignores invalidations for channels it does not hold", async () => {
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		provider.invalidate("rtl", ["other-g1"])
		await settle()
		expect(decoder.detachedAt).toEqual([])
		expect(provider.calls).toHaveLength(1)
		expect(decoder.starts).toBe(1)
	})

	it("retries a request whose generation was invalidated while pending", async () => {
		// Review Focus 3: a request pending at invalidation is retried, not parked.
		const decoder = create("dec", { useChannelizer: true })
		provider.beforeResult = () => provider.invalidate("rtl", [])
		await manager.startDecoder("dec")
		expect(provider.calls).toHaveLength(2)
		expect(provider.released).toEqual(["dec-g1"])
		expect(decoder.attached).toEqual([provider.streams.get("dec-g2")])
		expect(status()).toMatchObject({ running: true, suspended: false })
		expect(restarting).toEqual([])
	})

	it("restarts a decoder whose channel was invalidated while its start was in flight", async () => {
		const decoder = create("dec", { useChannelizer: true })
		const gate = deferred()
		decoder.startGate = gate
		const starting = manager.startDecoder("dec")
		await vi.advanceTimersByTimeAsync(0)
		provider.invalidate("rtl", ["dec-g1"])
		await settle() // the worker sees a decoder that is not running yet
		gate.resolve()
		await starting
		await settle()
		expect(provider.calls).toHaveLength(2)
		expect(decoder.input).toBe(provider.streams.get("dec-g2"))
		expect(status()).toMatchObject({ running: true, restartCount: 0 })
	})

	it("suspends when a retune moves the channel out, resumes when it fits again", async () => {
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		provider.results.push({
			ok: false,
			reasonCode: "channel-outside-capture",
			detail: "x",
		})
		sources.setCenter("rtl", 170e6)
		provider.invalidate("rtl", ["dec-g1"])
		await settle()
		expect(status()).toMatchObject({ suspended: true, running: false })
		expect(status().suspension).toBeUndefined()
		expect(restarting).toEqual([])
		sources.setCenter("rtl", CENTER)
		await settle()
		expect(status()).toMatchObject({ suspended: false, running: true })
		expect(provider.calls).toHaveLength(3)
		expect(decoder.input).toBe(provider.streams.get("dec-g2"))
	})

	for (const reasonCode of [
		"channel-request-invalid",
		"channel-outside-capture",
	] as const) {
		it(`does not churn status for identical caps while suspended for ${reasonCode}`, async () => {
			// Review Focus 5; PF6
			provider.results.push({ ok: false, reasonCode, detail: "x" })
			create("dec", { useChannelizer: true })
			await manager.startDecoder("dec")
			statusEvents.length = 0
			sources.setCenter("rtl", CENTER)
			await settle()
			sources.setCenter("rtl", CENTER)
			await settle()
			expect(statusEvents).toEqual([])
			expect(provider.calls).toHaveLength(1)
			expect(status().suspended).toBe(true)
		})
	}

	it("a rate block overwrites a channel reason and recovery re-requests the channel (E10b)", async () => {
		provider.results.push({
			ok: false,
			reasonCode: "channel-outside-capture",
			detail: "x",
		})
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		sources.setRate("rtl", 20_000)
		await settle()
		expect(status()).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "insufficient-sample-rate" },
		})
		sources.setRate("rtl", 2_048_000)
		await settle()
		expect(provider.calls).toHaveLength(2)
		expect(status()).toMatchObject({ suspended: false, running: true })
		expect(decoder.starts).toBe(1)
	})

	it("a resume whose channel is rejected stays suspended with the channel reason", async () => {
		sources.caps.set("rtl", { ...iqCaps(20_000), centerFreq: CENTER })
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		expect(status().suspension?.reasonCode).toBe("insufficient-sample-rate")
		provider.results.push({
			ok: false,
			reasonCode: "channel-outside-capture",
			detail: "x",
		})
		sources.setRate("rtl", 2_048_000)
		await settle()
		expect(status()).toMatchObject({ suspended: true, running: false })
		expect(status().suspension).toBeUndefined()
		expect(status().transition).toBeUndefined()
		expect(decoder.starts).toBe(0)
		expect(restarting).toEqual([])
	})

	it("a stop during a pending request attaches nothing and releases the channel", async () => {
		let open!: () => void
		provider.gate = new Promise(r => {
			open = r
		})
		create("dec", { useChannelizer: true })
		const starting = manager.startDecoder("dec")
		await Promise.resolve()
		await manager.stopDecoder("dec")
		open()
		await starting
		expect(decoders.get("dec")!.attached).toEqual([])
		expect(provider.released).toEqual(["dec-g1"])
		expect(status().suspended).toBe(false)
		expect(decoders.get("dec")!.starts).toBe(0)
	})

	it("a stop during a pending request that is then rejected does not suspend", async () => {
		let open!: () => void
		provider.gate = new Promise(r => {
			open = r
		})
		provider.results.push({
			ok: false,
			reasonCode: "channel-outside-capture",
			detail: "x",
		})
		create("dec", { useChannelizer: true })
		const starting = manager.startDecoder("dec")
		await Promise.resolve()
		await manager.stopDecoder("dec")
		open()
		await starting
		expect(status()).toMatchObject({ suspended: false, desiredRunning: false })
	})

	it("stop detaches before releasing the channel", async () => {
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		await manager.stopDecoder("dec")
		expect(decoder.detachedAt).toEqual(["before-destroy"])
		expect(provider.released).toEqual(["dec-g1"])
		expect(sources.assignments.has("dec")).toBe(false)
	})

	it("a crash releases the channel and the budgeted restart requests a new one", async () => {
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		decoder.crash()
		expect(provider.released).toEqual(["dec-g1"])
		await vi.advanceTimersByTimeAsync(20)
		expect(provider.calls).toHaveLength(2)
		expect(status()).toMatchObject({ running: true, restartCount: 1 })
		expect(restarting).toEqual(["dec"])
	})

	it("a restart whose channel is rejected suspends instead of retrying", async () => {
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		provider.results.push({
			ok: false,
			reasonCode: "channel-outside-capture",
			detail: "x",
		})
		decoder.crash()
		await vi.advanceTimersByTimeAsync(100)
		expect(provider.calls).toHaveLength(2)
		expect(status()).toMatchObject({
			suspended: true,
			running: false,
			health: "running",
		})
		expect(decoder.starts).toBe(1)
		expect(restarting).toEqual(["dec"])
	})

	it("a rate suspension of a channelised decoder releases the channel and keeps the reservation", async () => {
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		sources.setRate("rtl", 20_000)
		await settle()
		expect(decoder.detachedAt).toEqual(["before-destroy"])
		expect(provider.released).toEqual(["dec-g1"])
		expect(sources.assignments.get("dec")).toBe("rtl")
	})

	it("useChannelizer false keeps the raw branch", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([])
		expect(decoder.requestInputs).toEqual([])
		expect(fanout.getBranchIds()).toContain("decoder-dec")
		expect(decoder.options).not.toHaveProperty("inputIqFormat")
	})

	it("without a channelizer, useChannelizer keeps the raw branch", async () => {
		manager.setChannelizer(null)
		const decoder = create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([])
		expect(fanout.getBranchIds()).toContain("decoder-dec")
		expect(provider.listenerCount("channel-invalidated")).toBe(0)
		expect(decoder.running).toBe(true)
	})

	it("a decoder without a channel request keeps the raw branch", async () => {
		const decoder = create("dec", { useChannelizer: true })
		decoder.request = undefined
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([])
		expect(fanout.getBranchIds()).toContain("decoder-dec")
	})

	it("destroy unsubscribes from the provider", async () => {
		expect(provider.listenerCount("channel-invalidated")).toBe(1)
		await manager.destroy()
		expect(provider.listenerCount("channel-invalidated")).toBe(0)
		setup() // afterEach destroys a fresh manager
	})
})

describe("band at the channel centre (delta E10c, PF13)", () => {
	// Raw: the RateDecoder window at 2.048 Msps is ±19 kHz around the capture centre.
	const OFF = 100_000

	it("a channelised instance is band-assessed at its channel centre", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER + OFF })
		create("dec", { useChannelizer: true, band: [CENTER] })
		create("raw", { band: [CENTER] })
		await manager.startDecoder("dec")
		await manager.startDecoder("raw")
		expect(status("dec")).toMatchObject({
			running: true,
			suspended: false,
			bandAssessment: {
				verdict: "in-band",
				captureCenterHz: CENTER,
				windowHalfWidthHz: (384_000 * 0.8) / 2,
			},
		})
		expect(status("raw")).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
		})
	})

	it("is assessed at the channel centre while channel-suspended (no open channel)", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER + OFF })
		provider.results.push({
			ok: false,
			reasonCode: "channel-outside-capture",
			detail: "x",
		})
		create("dec", { useChannelizer: true, band: [CENTER] })
		await manager.startDecoder("dec")
		expect(status("dec").suspended).toBe(true)
		expect(status("dec").bandAssessment).toMatchObject({
			verdict: "in-band",
			captureCenterHz: CENTER,
		})
	})

	it("a channel centre out of band band-suspends before any request", async () => {
		const decoder = create("dec", { useChannelizer: true, band: [CENTER] })
		decoder.request = {
			centerHz: CENTER + 500_000,
			bandwidthHz: 12_500,
			transitionHz: 6_250,
			outputRateHz: 48_000,
			format: "cf32",
		}
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([])
		expect(status("dec")).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
			bandAssessment: { captureCenterHz: CENTER + 500_000 },
		})
	})

	it("an invalid request keeps the raw band assessment", async () => {
		const decoder = create("dec", { useChannelizer: true, band: [CENTER] })
		decoder.request = { invalid: "x" }
		await manager.startDecoder("dec")
		expect(status("dec").bandAssessment).toMatchObject({
			verdict: "in-band",
			windowHalfWidthHz: ((2_048_000 / 43) * 0.8) / 2,
		})
	})

	it("a centre-relative request with the capture centre unknown stays centre-unknown", async () => {
		sources.caps.set("rtl", iqCaps(2_048_000))
		const decoder = create("dec", { useChannelizer: true, band: [CENTER] })
		// Centre-relative, like iqChannelRequest: offset 0 from an unknown centre is 0 Hz.
		decoder.getChannelRequest = input => ({
			centerHz: input.centerHz ?? 0,
			bandwidthHz: 364_800,
			transitionHz: 9_600,
			outputRateHz: 384_000,
			format: "cu8",
		})
		await manager.startDecoder("dec")
		expect(status("dec").bandAssessment).toMatchObject({
			verdict: "unknown",
			reasonCode: "source-center-unknown",
		})
	})

	it("a pinned channel is band-assessed at its centre even with the capture centre unknown", async () => {
		sources.caps.set("rtl", iqCaps(2_048_000))
		create("in", { useChannelizer: true, band: [CENTER] })
		const out = create("out", { useChannelizer: true, band: [CENTER] })
		out.request = {
			centerHz: CENTER + 500_000,
			bandwidthHz: 12_500,
			transitionHz: 6_250,
			outputRateHz: 48_000,
			format: "cf32",
		}
		await manager.startDecoder("in")
		await manager.startDecoder("out")
		expect(status("in")).toMatchObject({
			running: true,
			bandAssessment: { verdict: "in-band", captureCenterHz: CENTER },
		})
		expect(status("out")).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
		})
	})

	it("useChannelizer false keeps the raw band assessment", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER + OFF })
		create("dec", { band: [CENTER] })
		await manager.startDecoder("dec")
		expect(status("dec").bandAssessment).toMatchObject({
			verdict: "out-of-band",
			captureCenterHz: CENTER + OFF,
		})
	})
})
