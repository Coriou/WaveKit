/**
 * Rate model B2: reversible suspension in DecoderManager.
 * Spec: docs/superpowers/specs/2026-10-08-rate-model-instances-and-suspension.md §4, §6 (B2)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"
import {
	FakeSources,
	MIN_HZ,
	RateDecoder,
	deferred,
	iqCaps,
} from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const DEBOUNCE = 350
let sources: FakeSources
let manager: DecoderManager
let decoders: Map<string, RateDecoder>
let statusEvents: string[]
let restarting: string[]

function create(id: string, input: DecoderCaps["input"] = "iq") {
	manager.createDecoder({
		id,
		type: "rate-test",
		enabled: true,
		options: { input },
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
	sources.caps.set("rtl", iqCaps(2_400_000))
	decoders = new Map()
	const registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => {
			const decoder = new RateDecoder(config.id, {
				input: config.options["input"] as DecoderCaps["input"],
				output: "text",
				integrationPattern: "pure_consumer",
			})
			decoders.set(config.id, decoder)
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	statusEvents = []
	restarting = []
	manager.on("decoder:status-changed", (id: string) => statusEvents.push(id))
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
})
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("start on an unusable rate", () => {
	it("records intent and the reservation without spawning or throwing", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({
			running: false,
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "insufficient-sample-rate" },
			rateAssessment: { verdict: "unusable", requiredMinimumHz: MIN_HZ },
			sourceId: "rtl",
		})
		expect(status().suspension?.since).toBeInstanceOf(Date)
		expect(sources.assignments.get("dec")).toBe("rtl")
		expect(decoder.input).toBeNull()
	})

	it("is a no-op when started again while still unusable", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		const since = status().suspension?.since
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(0)
		expect(status().suspension?.since).toBe(since)
	})

	it("an operator start (pin) is still a no-op; the pin holds when the rate recovers", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		await manager.startDecoder("dec", { startMode: "operator" })
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "insufficient-sample-rate" },
			startMode: "operator",
		})
		sources.setRate("rtl", 2_400_000)
		await settle()
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({ suspended: false, startMode: "operator" })
	})

	it("a pinned running decoder still rate-suspends and keeps its mode", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec", { startMode: "operator" })
		expect(decoder.running).toBe(true)
		sources.setRate("rtl", 20_000)
		await settle()
		expect(decoder.running).toBe(false)
		expect(status()).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "insufficient-sample-rate" },
			startMode: "operator",
		})
	})
})

describe("caps-driven suspension", () => {
	it("suspends and resumes without consuming restart budget", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(1)

		sources.setRate("rtl", 20_000)
		await settle()
		expect(decoder.running).toBe(false)
		expect(decoder.input).toBeNull()
		expect(status()).toMatchObject({
			running: false,
			desiredRunning: true,
			suspended: true,
			health: "running",
			restartCount: 0,
			sourceId: "rtl",
		})
		expect(status().lastError).toBeUndefined()
		expect(status().transition).toBeUndefined()
		expect(sources.assignments.get("dec")).toBe("rtl")

		sources.setRate("rtl", 2_400_000)
		await settle()
		expect(decoder.starts).toBe(2)
		expect(decoder.input).not.toBeNull()
		expect(status()).toMatchObject({
			running: true,
			suspended: false,
			restartCount: 0,
			rateAssessment: { verdict: "best" },
		})
		expect(status().suspension).toBeUndefined()
		expect(restarting).toEqual([])
	})

	it("ignores repeated identical caps: no transition and no status event", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		const before = statusEvents.length
		sources.emit("caps-changed", "rtl", iqCaps(20_000))
		await settle()
		sources.emit("caps-changed", "rtl", iqCaps(20_000))
		await settle()
		expect(statusEvents.length).toBe(before)
		expect(decoder.starts).toBe(0)
	})

	it("applies the newest plan with one spawn when caps change during a pending stop", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		decoder.stopGate = deferred()
		const gate = decoder.stopGate
		sources.setRate("rtl", 20_000)
		await settle()
		expect(status().transition).toBe("suspending")
		sources.setRate("rtl", 10_000)
		await settle()
		sources.setRate("rtl", 2_048_000)
		await settle()
		gate.resolve()
		await settle()
		await settle()
		expect(decoder.starts).toBe(2)
		expect(status()).toMatchObject({
			running: true,
			suspended: false,
			rateAssessment: { verdict: "acceptable", sourceRateHz: 2_048_000 },
		})
		expect(status().transition).toBeUndefined()
	})

	it("keeps suspending visible when stop fails and retries on the next event", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		decoder.failStop = true
		sources.setRate("rtl", 20_000)
		await settle()
		expect(status()).toMatchObject({
			suspended: true,
			transition: "suspending",
			running: true,
		})
		decoder.failStop = false
		sources.setRate("rtl", 10_000)
		await settle()
		expect(decoder.running).toBe(false)
		expect(status()).toMatchObject({ suspended: true, running: false })
		expect(status().transition).toBeUndefined()
	})

	it("replaces a process that survived a failed suspension stop on resume", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		decoder.failStop = true
		sources.setRate("rtl", 20_000)
		await settle()
		expect(status()).toMatchObject({ transition: "suspending", running: true })
		decoder.failStop = false
		sources.setRate("rtl", 2_400_000)
		await settle()
		expect(decoder.starts).toBe(2)
		expect(status()).toMatchObject({ running: true, suspended: false })
		expect(status().transition).toBeUndefined()
		expect(status().restartCount).toBe(0)
	})

	it("uses the normal backoff when the resume spawn fails", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		decoder.failStart = true
		sources.setRate("rtl", 2_400_000)
		// Exactly the debounce: the 10 ms retry has not fired yet.
		await vi.advanceTimersByTimeAsync(300)
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({
			suspended: false,
			health: "restarting",
			restartCount: 1,
			lastError: { kind: "error", message: "spawn failed" },
		})
		expect(status().nextRestartAt).toBeDefined()
		decoder.failStart = false
		await vi.advanceTimersByTimeAsync(10)
		expect(decoder.running).toBe(true)
	})

	it("suspends a decoder that is waiting in restart backoff", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		// Retries keep failing, so the decoder sits in backoff (10/20/40 ms).
		decoder.failStart = true
		decoder.crash()
		expect(status().health).toBe("restarting")
		sources.setRate("rtl", 20_000)
		await settle()
		const attempts = decoder.starts
		await vi.advanceTimersByTimeAsync(200)
		expect(decoder.starts).toBe(attempts)
		expect(status()).toMatchObject({ suspended: true, running: false })
		expect(status().nextRestartAt).toBeUndefined()
		expect(sources.assignments.get("dec")).toBe("rtl")
	})
})

describe("operator actions racing transitions", () => {
	it("a stop during resume ends with no process", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		decoder.startGate = deferred()
		const gate = decoder.startGate
		sources.setRate("rtl", 2_400_000)
		await settle()
		expect(status().transition).toBe("resuming")
		const stopping = manager.stopDecoder("dec")
		gate.resolve()
		await stopping
		await settle()
		expect(decoder.running).toBe(false)
		expect(status()).toMatchObject({ desiredRunning: false, suspended: false })
		expect(status().transition).toBeUndefined()
		expect(sources.assignments.has("dec")).toBe(false)
	})

	it("a start during suspend ends suspended", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		decoder.stopGate = deferred()
		const gate = decoder.stopGate
		sources.setRate("rtl", 20_000)
		await settle()
		await manager.startDecoder("dec")
		gate.resolve()
		await settle()
		expect(decoder.running).toBe(false)
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({ suspended: true, desiredRunning: true })
	})

	it("stop while suspended clears intent and releases the reservation", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		create("dec")
		await manager.startDecoder("dec")
		await manager.stopDecoder("dec")
		expect(status()).toMatchObject({ desiredRunning: false, suspended: false })
		expect(status().rateAssessment?.verdict).toBe("unusable")
		expect(sources.assignments.has("dec")).toBe(false)
		sources.setRate("rtl", 2_400_000)
		await settle()
		expect(decoders.get("dec")!.starts).toBe(0)
	})

	it("remove during a transition deletes cleanly and later caps do nothing", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		decoder.stopGate = deferred()
		const gate = decoder.stopGate
		sources.setRate("rtl", 20_000)
		await settle()
		const removing = manager.removeDecoder("dec")
		gate.resolve()
		await removing
		await settle()
		sources.setRate("rtl", 2_400_000)
		await settle()
		expect(manager.getStatus("dec")).toBeUndefined()
		expect(decoder.starts).toBe(1)
		expect(sources.assignments.has("dec")).toBe(false)
	})

	it("an explicit restart on an unusable rate ends suspended, not spawned", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		sources.caps.set("rtl", iqCaps(20_000))
		await manager.restartDecoder("dec")
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({ suspended: true, running: false })
	})
})

describe("source removal and reconnect", () => {
	it("keeps a suspended decoder suspended and never moves it to another source", async () => {
		sources.caps.set("other", iqCaps(2_400_000))
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		sources.remove("rtl")
		await settle()
		expect(status()).toMatchObject({
			suspended: true,
			rateAssessment: { verdict: "unknown", reasonCode: "source-rate-unknown" },
		})
		expect(sources.assignments.get("dec")).not.toBe("other")
		expect(decoder.starts).toBe(0)

		sources.reconnect("rtl", 2_400_000)
		await settle()
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({ running: true, suspended: false })
		expect(sources.assignments.get("dec")).toBe("rtl")
	})

	it("restores the reservation when the source returns at a still-unusable rate", async () => {
		sources.caps.set("rtl", iqCaps(20_000))
		const decoder = create("dec")
		await manager.startDecoder("dec")
		sources.remove("rtl")
		await settle()
		expect(sources.assignments.has("dec")).toBe(false)
		sources.reconnect("rtl", 20_000)
		await settle()
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({ suspended: true, sourceId: "rtl" })
		expect(sources.assignments.get("dec")).toBe("rtl")
	})

	it("keeps a running decoder running when its source is removed", async () => {
		const decoder = create("dec")
		await manager.startDecoder("dec")
		sources.remove("rtl")
		await settle()
		expect(decoder.running).toBe(true)
		expect(status()).toMatchObject({
			suspended: false,
			rateAssessment: { reasonCode: "source-rate-unknown" },
		})
	})
})

describe("external input", () => {
	it("is never suspended or restarted by caps changes", async () => {
		const decoder = create("ext", "external")
		await manager.startDecoder("ext")
		sources.setRate("rtl", 20_000)
		await settle()
		expect(decoder.starts).toBe(1)
		expect(decoder.running).toBe(true)
		expect(status("ext")).toMatchObject({
			suspended: false,
			rateAssessment: { reasonCode: "external-input" },
		})
	})
})
