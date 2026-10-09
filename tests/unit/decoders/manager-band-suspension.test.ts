/**
 * Band-aware suspension in DecoderManager (roadmap item 8): the reversible
 * rate-suspension contract, with reason "frequency-out-of-band".
 * The fake decoder's frontend is ~48 kHz, so its window is ±19.2 kHz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import type { DecoderManagerConfig } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps, DecoderConfig } from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const DEBOUNCE = 350
const POCSAG = 466_075_000
const ELSEWHERE = 1_090_000_000
let sources: FakeSources
let manager: DecoderManager
let decoders: Map<string, RateDecoder>
let statusEvents: string[]
let restarting: string[]

function setup(config: Partial<DecoderManagerConfig> = {}) {
	decoders = new Map()
	const registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		decoderConfig => {
			const decoder = new RateDecoder(decoderConfig.id, {
				input: decoderConfig.options["input"] as DecoderCaps["input"],
				output: "text",
				integrationPattern: "pure_consumer",
			})
			const targets = decoderConfig.options["targets"] as number[] | undefined
			if (targets) decoder.band = { targetsHz: targets, basis: "configured" }
			decoders.set(decoderConfig.id, decoder)
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
		...config,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	statusEvents = []
	restarting = []
	manager.on("decoder:status-changed", (id: string) => statusEvents.push(id))
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
}

/** targets null = no band declaration (unknown). */
function create(
	id: string,
	targets: number[] | null = [POCSAG],
	input: DecoderCaps["input"] = "iq",
	extra: Partial<DecoderConfig> = {},
) {
	manager.createDecoder({
		id,
		type: "rate-test",
		enabled: true,
		options: { input, ...(targets ? { targets } : {}) },
		...extra,
	})
	return decoders.get(id)!
}
function status(id = "dec") {
	return manager.getStatus(id)!
}
async function settle() {
	await vi.advanceTimersByTimeAsync(DEBOUNCE)
}

beforeEach(() => {
	vi.useFakeTimers()
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: POCSAG })
})
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("start", () => {
	beforeEach(() => setup())

	it("records intent and suspends without spawning when no target is in band", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({
			running: false,
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
			bandAssessment: {
				verdict: "out-of-band",
				reasonCode: "frequency-out-of-band",
				targetsHz: [POCSAG],
				captureCenterHz: ELSEWHERE,
			},
			rateAssessment: { verdict: "best" },
			sourceId: "rtl",
		})
		expect(sources.assignments.get("dec")).toBe("rtl")
	})

	it("runs normally in band and reports the window", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			running: true,
			suspended: false,
			bandAssessment: {
				verdict: "in-band",
				captureCenterHz: POCSAG,
				windowHalfWidthHz: 19_200,
			},
		})
	})

	it("never suspends an instance whose band is unknown", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec", null)
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			suspended: false,
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
		})
	})

	it("never suspends when the source centre is unknown", async () => {
		sources.caps.set("rtl", iqCaps(2_400_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(1)
		expect(status().bandAssessment).toMatchObject({
			verdict: "unknown",
			reasonCode: "source-center-unknown",
		})
	})

	it("never evaluates external-input decoders", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec", [POCSAG], "external")
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			suspended: false,
			bandAssessment: { verdict: "unknown", reasonCode: "external-input" },
		})
	})
})

describe("retunes", () => {
	beforeEach(() => setup())

	it("suspends on a retune away and resumes on a retune back, without restart budget", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		const before = statusEvents.length

		sources.setCenter("rtl", ELSEWHERE)
		await settle()
		expect(decoder.running).toBe(false)
		expect(decoder.input).toBeNull()
		expect(status()).toMatchObject({
			running: false,
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
			health: "running",
			restartCount: 0,
			sourceId: "rtl",
		})
		expect(status().lastError).toBeUndefined()
		expect(statusEvents.length).toBeGreaterThan(before)

		sources.setCenter("rtl", POCSAG + 10_000)
		await settle()
		expect(decoder.starts).toBe(2)
		expect(decoder.input).not.toBeNull()
		expect(status()).toMatchObject({
			running: true,
			suspended: false,
			restartCount: 0,
			bandAssessment: { verdict: "in-band", captureCenterHz: POCSAG + 10_000 },
		})
		expect(status().suspension).toBeUndefined()
		expect(restarting).toEqual([])
	})

	it("serializes retunes through the caps worker: a quick away-and-back never suspends", async () => {
		create("dec")
		await manager.startDecoder("dec")
		const seen: boolean[] = []
		manager.on("decoder:status-changed", (id: string) =>
			seen.push(manager.getStatus(id)?.suspended ?? false),
		)
		sources.setCenter("rtl", ELSEWHERE)
		await vi.advanceTimersByTimeAsync(100)
		expect(status().suspended).toBe(false) // nothing evaluated inline
		sources.setCenter("rtl", POCSAG)
		await settle()
		expect(seen).not.toContain(true)
		expect(status()).toMatchObject({ suspended: false, running: true })
	})

	it("keeps a rate suspension ahead of the band, then switches the reason", async () => {
		sources.caps.set("rtl", { ...iqCaps(20_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(status().suspension?.reasonCode).toBe("insufficient-sample-rate")
		const since = status().suspension?.since

		sources.setRate("rtl", 2_400_000)
		await settle()
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
		})
		expect(status().suspension?.since).toBe(since)

		sources.setCenter("rtl", POCSAG)
		await settle()
		expect(decoder.starts).toBe(1)
		expect(status().suspended).toBe(false)
	})

	it("re-evaluates idle decoders on a retune without spawning them", async () => {
		const decoder = create("dec")
		sources.setCenter("rtl", ELSEWHERE)
		await settle()
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({
			suspended: false,
			desiredRunning: false,
			bandAssessment: { verdict: "out-of-band" },
		})
	})

	it("a stop while band-suspended clears intent and releases the source", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec")
		await manager.stopDecoder("dec")
		expect(status()).toMatchObject({ suspended: false, desiredRunning: false })
		expect(sources.assignments.has("dec")).toBe(false)
		sources.setCenter("rtl", POCSAG)
		await settle()
		expect(decoder.starts).toBe(0)
	})
})

describe("opt-out", () => {
	it("bandSuspension: false reports the band but never suspends for it", async () => {
		setup({ bandSuspension: false })
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			suspended: false,
			bandAssessment: { verdict: "out-of-band" },
		})
		sources.setCenter("rtl", POCSAG)
		await settle()
		sources.setCenter("rtl", ELSEWHERE)
		await settle()
		expect(decoder.running).toBe(true)
		expect(status().suspended).toBe(false)
	})
})

describe("operator start (pin)", () => {
	beforeEach(() => setup())

	it("an operator start runs out of band and reports the assessment", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec", { startMode: "operator" })
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			running: true,
			suspended: false,
			startMode: "operator",
			bandAssessment: { verdict: "out-of-band" },
		})
	})

	it("run anyway: an operator start resumes a band-suspended decoder", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec", { startMode: "auto" })
		expect(status()).toMatchObject({ suspended: true, startMode: "auto" })
		await manager.startDecoder("dec", { startMode: "operator" })
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			running: true,
			suspended: false,
			startMode: "operator",
		})
		// A later retune keeps it running, out of band.
		sources.setCenter("rtl", ELSEWHERE + 5_000_000)
		await settle()
		expect(decoder.running).toBe(true)
		expect(status()).toMatchObject({
			suspended: false,
			bandAssessment: { verdict: "out-of-band" },
		})
	})

	it("returning a running pinned decoder to auto suspends it via the worker", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec", { startMode: "operator" })
		const before = statusEvents.length
		expect(manager.setStartMode("dec", "auto")).toBe(true)
		// Published at once, suspended only by the serial worker.
		expect(statusEvents.length).toBeGreaterThan(before)
		expect(status()).toMatchObject({ running: true, startMode: "auto" })
		await settle()
		expect(decoder.running).toBe(false)
		expect(status()).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
			startMode: "auto",
		})
		expect(manager.setStartMode("missing", "auto")).toBe(false)
	})

	it("pinning a band-suspended decoder through setStartMode resumes it", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec")
		manager.setStartMode("dec", "operator")
		await settle()
		expect(decoder.running).toBe(true)
		expect(status().suspended).toBe(false)
	})

	it("restart keeps the mode, stop clears it, startAll starts as auto", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec", { startMode: "operator" })
		await manager.restartDecoder("dec")
		expect(decoder.running).toBe(true)
		expect(status().startMode).toBe("operator")

		await manager.stopDecoder("dec")
		expect(status().startMode).toBeUndefined() // not sent while unwanted
		await manager.startDecoder("dec")
		expect(status()).toMatchObject({ suspended: true, startMode: "auto" })

		await manager.stopDecoder("dec")
		await manager.startAll()
		expect(status()).toMatchObject({ suspended: true, startMode: "auto" })
	})

	it("a crash restart keeps the pin", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec", { startMode: "operator" })
		decoder.crash()
		await vi.advanceTimersByTimeAsync(50)
		expect(decoder.starts).toBe(2)
		expect(status()).toMatchObject({ startMode: "operator", suspended: false })
	})

	it("pin never band-suspends; an unusable rate still suspends; auto behaves as before", async () => {
		// Feature: decoder-band-defaults, Property 6: Pin never band-suspends
		// Validates: §1
		const centers = [POCSAG, POCSAG + 5_000, ELSEWHERE, 162_000_000]
		const rates = [2_400_000, 1_024_000, 20_000]
		const step = fc.record({
			center: fc.constantFrom(...centers),
			rate: fc.constantFrom(...rates),
		})
		await fc.assert(
			fc.asyncProperty(
				fc.array(step, { minLength: 1, maxLength: 4 }),
				async steps => {
					await manager.destroy()
					setup()
					sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: POCSAG })
					create("pinned")
					create("auto")
					await manager.startDecoder("pinned", { startMode: "operator" })
					await manager.startDecoder("auto", { startMode: "auto" })
					for (const { center, rate } of steps) {
						sources.caps.set("rtl", {
							...iqCaps(rate),
							centerFreq: center,
						})
						sources.emit("caps-changed", "rtl", sources.caps.get("rtl"))
						await settle()
						const pinned = status("pinned")
						const auto = status("auto")
						const rateUnusable = rate < 48_000
						const outOfBand = Math.abs(center - POCSAG) > 19_200
						expect(pinned.suspension?.reasonCode).not.toBe(
							"frequency-out-of-band",
						)
						expect(pinned.suspended).toBe(rateUnusable)
						expect(auto.suspended).toBe(rateUnusable || outOfBand)
						if (!rateUnusable && outOfBand)
							expect(auto.suspension?.reasonCode).toBe("frequency-out-of-band")
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("per-decoder band opt-out and overrides", () => {
	beforeEach(() => setup())

	it("config band.bandSuspension: false reports the band but never suspends", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec", [POCSAG], "iq", {
			band: { bandSuspension: false },
		})
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			suspended: false,
			bandAssessment: { verdict: "out-of-band", basis: "configured" },
		})
	})

	it("an API override re-evaluates: in band resumes, DELETE suspends again", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(status().suspended).toBe(true)

		const settings = await manager.setBandOverride("dec", {
			rangesHz: [
				{ minHz: ELSEWHERE - 1_000_000, maxHz: ELSEWHERE + 1_000_000 },
			],
		})
		expect(settings).toMatchObject({
			decoderId: "dec",
			override: {
				rangesHz: [
					{ minHz: ELSEWHERE - 1_000_000, maxHz: ELSEWHERE + 1_000_000 },
				],
			},
			configOverride: null,
			persisted: false,
			region: { code: "EU", source: "default" },
			bandAssessment: {
				verdict: "in-band",
				basis: "override",
				overrideSource: "api",
			},
		})
		await settle()
		expect(decoder.running).toBe(true)

		const cleared = await manager.deleteBandOverride("dec")
		expect(cleared).toMatchObject({
			override: null,
			bandAssessment: { verdict: "out-of-band", basis: "configured" },
		})
		await settle()
		expect(decoder.running).toBe(false)
		expect(status().suspension?.reasonCode).toBe("frequency-out-of-band")
		expect(await manager.setBandOverride("missing", { targetsHz: [1] })).toBe(
			undefined,
		)
	})

	it("an API bandSuspension: false outranks the config layer", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		const decoder = create("dec", [POCSAG], "iq", {
			band: { bandSuspension: true, region: "US" },
		})
		await manager.startDecoder("dec")
		expect(status().suspended).toBe(true)
		const settings = await manager.setBandOverride("dec", {
			bandSuspension: false,
		})
		expect(settings).toMatchObject({
			configOverride: { bandSuspension: true, region: "US" },
			region: { code: "US", source: "decoder" },
		})
		await settle()
		expect(decoder.running).toBe(true)
	})
})
