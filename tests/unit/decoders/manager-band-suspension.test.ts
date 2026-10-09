/**
 * Band-aware suspension in DecoderManager (roadmap item 8): the reversible
 * rate-suspension contract, with reason "frequency-out-of-band".
 * The fake decoder's frontend is ~48 kHz, so its window is ±19.2 kHz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import type { DecoderManagerConfig } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"
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
) {
	manager.createDecoder({
		id,
		type: "rate-test",
		enabled: true,
		options: { input, ...(targets ? { targets } : {}) },
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
