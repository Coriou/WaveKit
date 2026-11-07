/** `lastChange`: who made a tuner's last change; bounded to one entry per source. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TUNER_CHANGE_FIELDS, type TunerChangeField } from "@wavekit/api-types"
import {
	TUNER_CHANGE_MERGE_MS,
	TunerController,
} from "../../../src/core/tuner-controller.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

function harness() {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const transport = {
		assertTunerCommandActive: () => {},
		writeToSource: () => true,
		isRtlTcpSource: () => true,
		updateSourceCaps: (_id: string, updates: Partial<SourceCaps>) =>
			Object.assign(caps, updates),
		getCaps: () => ({ ...caps }),
		setTuningCaps: () => caps,
	}
	const controller = new TunerController(
		createLogger({ level: "fatal" }),
		transport as unknown as SourceManager,
	)
	controller.initializeSource("rtl-1", { ...caps }, "rtl_tcp")
	return controller
}

const REST = { origin: "rest", actor: "agent" } as const

describe("TunerController lastChange", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("is absent until the first change", () => {
		expect(harness().getState("rtl-1")).not.toHaveProperty("lastChange")
	})

	it("extends fields under the merge window and starts afresh at it", async () => {
		const c = harness()
		await c.setGain("rtl-1", 300, REST)
		vi.advanceTimersByTime(TUNER_CHANGE_MERGE_MS - 1)
		await c.setPpm("rtl-1", 2, REST)
		const merged = c.getState("rtl-1")?.lastChange
		expect(merged?.fields).toEqual(["gain", "ppm"])
		expect(merged?.at).toBe(new Date(Date.now()).toISOString())
		vi.advanceTimersByTime(TUNER_CHANGE_MERGE_MS)
		await c.setPpm("rtl-1", 3, REST)
		expect(c.getState("rtl-1")?.lastChange?.fields).toEqual(["ppm"])
	})

	it("a different actor or job replaces the change instead of merging", async () => {
		const c = harness()
		await c.setGain("rtl-1", 300, REST)
		await c.setPpm("rtl-1", 2, { origin: "rest", actor: "web" })
		expect(c.getState("rtl-1")?.lastChange).toMatchObject({
			actor: "web",
			fields: ["ppm"],
		})
		await c.setGain("rtl-1", 310, { origin: "scanner", jobId: "j_a" })
		await c.setPpm("rtl-1", 3, { origin: "scanner", jobId: "j_b" })
		expect(c.getState("rtl-1")?.lastChange).toMatchObject({
			actor: "scanner-job",
			jobId: "j_b",
			fields: ["ppm"],
		})
	})

	it("holds each field at most once however many writes merge", async () => {
		const c = harness()
		for (let i = 0; i < 100; i++) await c.setPpm("rtl-1", i % 5, REST)
		expect(c.getState("rtl-1")?.lastChange?.fields).toEqual(["ppm"])
		// Every relay command with a field, repeated: never past the closed list.
		for (let round = 0; round < 3; round++)
			for (let command = 0x01; command <= 0x0f; command++)
				c.applyExternalCommand("rtl-1", command, 1)
		const fields = c.getState("rtl-1")?.lastChange?.fields ?? []
		expect(new Set(fields).size).toBe(fields.length)
		expect(fields.length).toBeLessThanOrEqual(TUNER_CHANGE_FIELDS.length)
		expect([...fields].sort()).toEqual(
			[...TUNER_CHANGE_FIELDS].sort() as TunerChangeField[],
		)
	})

	it.each([
		[{ origin: "decoder-rate" }, "decoder-rate", "decoder-rate"],
		[{}, "unknown", "unknown"],
		[{ origin: "rest" }, "unknown", "rest-command"],
	] as const)("maps %j", async (opts, actor, reason) => {
		const c = harness()
		await c.setPpm("rtl-1", 2, opts)
		expect(c.getState("rtl-1")?.lastChange).toMatchObject({ actor, reason })
	})

	describe("across a reconnect", () => {
		it("a replay of the accepted values moves nothing: the mover, time and fields stay", async () => {
			const c = harness()
			await c.setFrequency("rtl-1", 145_000_000, {
				origin: "rest",
				actor: "web",
			})
			await c.setGain("rtl-1", 300, { origin: "rest", actor: "web" })
			const before = c.getState("rtl-1")?.lastChange
			vi.advanceTimersByTime(TUNER_CHANGE_MERGE_MS * 5)
			expect(c.synchronizeOnConnect("rtl-1").commands.length).toBeGreaterThan(0)
			expect(c.getState("rtl-1")?.lastChange).toEqual(before)
		})

		it("a replay of a value other than the last frame's is a change, by the core", () => {
			const c = harness()
			// Accepted, then a value the controller ignores goes out through the relay.
			c.applyExternalCommand("rtl-1", 0x01, 145_000_000)
			c.applyExternalCommand("rtl-1", 0x01, 0xffffffff)
			vi.advanceTimersByTime(TUNER_CHANGE_MERGE_MS)
			c.synchronizeOnConnect("rtl-1")
			expect(c.getState("rtl-1")?.lastChange).toMatchObject({
				actor: "restore",
				reason: "reconnect-replay",
				fields: ["frequency"],
			})
		})

		it("takes a relay's negative value and its replay as the same value", async () => {
			const c = harness()
			c.applyExternalCommand("rtl-1", 0x05, -3 >>> 0)
			const before = c.getState("rtl-1")?.lastChange
			vi.advanceTimersByTime(TUNER_CHANGE_MERGE_MS)
			c.synchronizeOnConnect("rtl-1")
			expect(c.getState("rtl-1")?.lastChange).toEqual(before)
		})

		it("a plain resume that replays a relay's command moves nothing either", () => {
			const c = harness()
			c.noteFeedPaused("rtl-1")
			c.applyExternalCommand("rtl-1", 0x01, 145_000_000)
			const before = c.getState("rtl-1")?.lastChange
			vi.advanceTimersByTime(TUNER_CHANGE_MERGE_MS)
			expect(
				c.synchronizeOnConnect("rtl-1", { resume: "plain" }).commands,
			).toEqual(["set-frequency"])
			expect(c.getState("rtl-1")?.lastChange).toEqual(before)
		})

		it("the configured tuning reads config once, and not again on each reconnect", async () => {
			const c = harness()
			c.syncConfiguredTuning("rtl-1", { gain: 30 } as never)
			c.noteSourceConnected("rtl-1")
			c.synchronizeOnConnect("rtl-1")
			expect(c.getState("rtl-1")?.lastChange).toMatchObject({
				actor: "config",
				reason: "source-config",
			})
			await c.setFrequency("rtl-1", 145_000_000, {
				origin: "rest",
				actor: "web",
			})
			const mover = c.getState("rtl-1")?.lastChange
			vi.advanceTimersByTime(TUNER_CHANGE_MERGE_MS)
			c.noteSourceConnected("rtl-1")
			expect(c.synchronizeOnConnect("rtl-1").commands.length).toBeGreaterThan(1)
			expect(c.getState("rtl-1")?.lastChange).toEqual(mover)
		})
	})

	it("a relay command reads relay, even one the controller ignores", () => {
		const c = harness()
		c.applyExternalCommand("rtl-1", 0x01, 0xffffffff)
		expect(c.getState("rtl-1")?.lastChange).toMatchObject({
			actor: "relay",
			reason: "relay-command",
			fields: ["frequency"],
		})
	})

	it("an unhandled relay command is no change", () => {
		const c = harness()
		c.applyExternalCommand("rtl-1", 0x7f, 1)
		expect(c.getState("rtl-1")).not.toHaveProperty("lastChange")
	})

	it("a scanner settle marker is no change, an operator's test mode is", async () => {
		const c = harness()
		await c.setTestMode("rtl-1", true, { origin: "scanner", accept: false })
		expect(c.getState("rtl-1")).not.toHaveProperty("lastChange")
		await c.setTestMode("rtl-1", false, REST)
		expect(c.getState("rtl-1")?.lastChange?.fields).toEqual(["testMode"])
	})

	it("a failed write records nothing", async () => {
		const c = harness()
		const transport = (c as unknown as { sourceManager: SourceManager })
			.sourceManager
		transport.writeToSource = () => {
			throw new Error("down")
		}
		c.on("error", () => {})
		await expect(c.setPpm("rtl-1", 2, REST)).rejects.toThrow()
		expect(c.getState("rtl-1")).not.toHaveProperty("lastChange")
	})

	it("forgets the entry with the source, and hands out copies", async () => {
		const c = harness()
		await c.setPpm("rtl-1", 2, REST)
		c.getState("rtl-1")?.lastChange?.fields.push("gain")
		expect(c.getState("rtl-1")?.lastChange?.fields).toEqual(["ppm"])
		c.removeSource("rtl-1")
		const map = (c as unknown as { lastChanges: Map<string, unknown> })
			.lastChanges
		expect(map.size).toBe(0)
	})
})
