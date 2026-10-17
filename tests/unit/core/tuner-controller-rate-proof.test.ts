/**
 * WG10 req 2.8: `proveSampleRateForFrequency` writes the held sample rate once per
 * connection epoch, only in internal control, only when the rate is known and unproven.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

const SET_FREQUENCY = 0x01
const SET_SAMPLE_RATE = 0x02
const REST = { origin: "rest" as const }

function make(options: { caps?: Partial<SourceCaps>; noRate?: boolean } = {}) {
	const caps: SourceCaps = {
		kind: "iq",
		...(options.noRate ? {} : { sampleRate: 2_048_000 }),
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
		...options.caps,
	} as SourceCaps
	const frames: Buffer[] = []
	const fail = { cmd: null as number | null }
	const transport = {
		writeToSource: (_id: string, frame: Buffer) => {
			if (fail.cmd !== null && frame[0] === fail.cmd) throw new Error("closed")
			frames.push(Buffer.from(frame))
			return true
		},
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
	controller.on("error", () => undefined)
	const origins: unknown[] = []
	controller.on("command-sent", (...args: unknown[]) => origins.push(args[3]))
	const rateWrites = () => frames.filter(f => f[0] === SET_SAMPLE_RATE)
	return { controller, frames, fail, origins, rateWrites }
}

describe("proveSampleRateForFrequency (WG10 req 2.8)", () => {
	it("internal, declared-only: written once with the held value, then never", async () => {
		const t = make()
		const before = t.controller.getState("rtl-1")!.commandCount
		expect(await t.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			true,
		)
		expect(t.rateWrites().map(f => f.readUInt32BE(1))).toEqual([2_048_000])
		expect(t.origins).toEqual(["rest"])
		expect(t.controller.getState("rtl-1")!.sampleRate).toBe(2_048_000)
		expect(t.controller.getState("rtl-1")!.commandCount).toBe(before + 1)
		for (let k = 0; k < 5; k++)
			expect(
				await t.controller.proveSampleRateForFrequency("rtl-1", REST),
			).toBe(false)
		expect(t.rateWrites()).toHaveLength(1)
		expect(t.controller.getState("rtl-1")!.commandCount).toBe(before + 1)
	})

	it("internal, rate already written on this connection: never", async () => {
		const t = make()
		t.controller.synchronizeOnConnect("rtl-1")
		await t.controller.setSampleRate("rtl-1", 2_400_000, REST)
		const n = t.frames.length
		expect(await t.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			false,
		)
		expect(t.frames).toHaveLength(n)
	})

	it("unknown rate (no declared value): never", async () => {
		const t = make({ noRate: true })
		expect(await t.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			false,
		)
		expect(t.frames).toEqual([])
	})

	it("ignored relay rate (unknown): never", async () => {
		const t = make()
		// A relay client's rate the controller ignored makes the rate unknown (WG5).
		const ignored = (
			t.controller as unknown as {
				ignoredRelayFields: Map<string, Set<string>>
			}
		).ignoredRelayFields
		ignored.set("rtl-1", new Set(["sampleRate"]))
		expect(await t.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			false,
		)
		expect(t.frames).toEqual([])
	})

	it("external and relay control: never", async () => {
		for (const origin of ["user", "relay"] as const) {
			const t = make()
			t.controller.setControlMode("rtl-1", "external", origin)
			expect(
				await t.controller.proveSampleRateForFrequency("rtl-1", REST),
			).toBe(false)
			expect(t.frames).toEqual([])
		}
	})

	it("unknown source: never, no throw", async () => {
		const t = make()
		expect(await t.controller.proveSampleRateForFrequency("nope", REST)).toBe(
			false,
		)
	})

	it("out-of-range frequency: nothing written", async () => {
		const t = make()
		for (const hz of [23_999_999, 1_900_000_001, 1.5e8 + 0.5, Number.NaN])
			expect(
				await t.controller.proveSampleRateForFrequency("rtl-1", REST, hz),
			).toBe(false)
		expect(t.frames).toEqual([])
	})

	it("reconnect starts a new epoch: written once more", async () => {
		const t = make()
		await t.controller.proveSampleRateForFrequency("rtl-1", REST)
		t.controller.synchronizeOnConnect("rtl-1")
		const replayed = t.rateWrites().length
		// The restore replay re-sent the accepted rate: already proven, no extra write.
		expect(await t.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			false,
		)
		expect(t.rateWrites()).toHaveLength(replayed)
		// A connection without a replay (reset policy) needs one more write.
		const r = make()
		;(
			r.controller as unknown as { config: { reconnectPolicy: string } }
		).config.reconnectPolicy = "reset"
		await r.controller.proveSampleRateForFrequency("rtl-1", REST)
		r.controller.synchronizeOnConnect("rtl-1")
		expect(await r.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			true,
		)
		expect(await r.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			false,
		)
		expect(r.rateWrites()).toHaveLength(2)
	})

	it("failed write throws, writes nothing, stays unproven", async () => {
		const t = make()
		t.fail.cmd = SET_SAMPLE_RATE
		await expect(
			t.controller.proveSampleRateForFrequency("rtl-1", REST),
		).rejects.toThrow("closed")
		expect(t.frames).toEqual([])
		expect(t.controller.getState("rtl-1")!.sampleRate).toBe(2_048_000)
		t.fail.cmd = null
		expect(await t.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			true,
		)
	})

	it("configure with frequency only proves first; failed proof writes no frequency", async () => {
		const t = make()
		t.fail.cmd = SET_SAMPLE_RATE
		await expect(
			t.controller.configure("rtl-1", { frequency: 145_000_000 }, REST),
		).rejects.toThrow()
		expect(t.frames).toEqual([])
		t.fail.cmd = null
		await t.controller.configure("rtl-1", { frequency: 145_000_000 }, REST)
		expect(t.frames.map(f => f[0])).toEqual([SET_SAMPLE_RATE, SET_FREQUENCY])
	})

	it("two concurrent calls on a fresh connection write exactly one rate command", async () => {
		const t = make()
		const results = await Promise.all([
			t.controller.proveSampleRateForFrequency("rtl-1", REST),
			t.controller.proveSampleRateForFrequency("rtl-1", REST),
		])
		expect(results.sort()).toEqual([false, true])
		expect(t.rateWrites()).toHaveLength(1)
	})

	it("concurrent callers share a failure; a later request retries", async () => {
		const t = make()
		t.fail.cmd = SET_SAMPLE_RATE
		const results = await Promise.allSettled([
			t.controller.proveSampleRateForFrequency("rtl-1", REST),
			t.controller.proveSampleRateForFrequency("rtl-1", REST),
		])
		expect(results.map(r => r.status)).toEqual(["rejected", "rejected"])
		expect(t.frames).toEqual([])
		t.fail.cmd = null
		expect(await t.controller.proveSampleRateForFrequency("rtl-1", REST)).toBe(
			true,
		)
		expect(t.rateWrites()).toHaveLength(1)
	})

	it("scanner path (setFrequency directly) is unchanged: no rate write", async () => {
		const t = make()
		await t.controller.setFrequency("rtl-1", 162_000_000, { origin: "scanner" })
		expect(t.frames.map(f => f[0])).toEqual([SET_FREQUENCY])
		expect(t.controller.tuningWrittenOnConnection("rtl-1")).toBe(false)
	})
})

describe("Property 7", () => {
	// Feature: web-gaps-10, Property 7: Rate written once, only when unproven
	// Validates: Requirements 2.8
	it("helper writes at most once per epoch, only internal, never changes the value", async () => {
		type Op =
			| "prove"
			| "reconnect"
			| "external"
			| "relay"
			| "internal"
			| "fail"
			| "heal"
		const opArb = fc.constantFrom<Op>(
			"prove",
			"prove",
			"prove",
			"reconnect",
			"external",
			"relay",
			"internal",
			"fail",
			"heal",
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 30 }),
				fc.boolean(),
				async (ops, noRate) => {
					const t = make({ noRate })
					;(
						t.controller as unknown as { config: { reconnectPolicy: string } }
					).config.reconnectPolicy = "reset"
					const held = t.controller.getState("rtl-1")!.sampleRate
					let epochWrites = 0
					for (const op of ops) {
						if (op === "reconnect") {
							t.controller.synchronizeOnConnect("rtl-1")
							epochWrites = 0
						} else if (op === "external")
							t.controller.setControlMode("rtl-1", "external")
						else if (op === "relay")
							t.controller.setControlMode("rtl-1", "external", "relay")
						else if (op === "internal")
							t.controller.setControlMode("rtl-1", "internal")
						else if (op === "fail") t.fail.cmd = SET_SAMPLE_RATE
						else if (op === "heal") t.fail.cmd = null
						else {
							const internal =
								t.controller.getState("rtl-1")!.controlMode === "internal"
							const n = t.rateWrites().length
							let wrote = false
							try {
								wrote = await t.controller.proveSampleRateForFrequency(
									"rtl-1",
									REST,
								)
							} catch {
								expect(t.fail.cmd).toBe(SET_SAMPLE_RATE)
							}
							expect(t.rateWrites().length - n).toBe(wrote ? 1 : 0)
							if (wrote) {
								expect(internal).toBe(true)
								expect(noRate).toBe(false)
								epochWrites++
							}
							expect(epochWrites).toBeLessThanOrEqual(1)
						}
						for (const f of t.rateWrites()) expect(f.readUInt32BE(1)).toBe(held)
						expect(t.controller.getState("rtl-1")!.sampleRate).toBe(held)
					}
					expect(t.frames.every(f => f[0] === SET_SAMPLE_RATE)).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("configure validates every field before the first write (review WG10 R1 m2)", () => {
	it("an invalid field writes nothing: no rate proof, no frequency, no mode change", async () => {
		const t = make()
		await expect(
			t.controller.configure(
				"rtl-1",
				{ frequency: 145_000_000, gain: 9999 },
				REST,
			),
		).rejects.toMatchObject({ name: "TunerValidationError" })
		await expect(
			t.controller.configure(
				"rtl-1",
				{ sampleRate: 2_400_000, tunerIfGain: { stage: 70_000, gain: 1 } },
				REST,
			),
		).rejects.toMatchObject({ name: "TunerValidationError" })
		await expect(
			t.controller.configure(
				"rtl-1",
				{ frequency: 145_000_000, sampleRate: 1_000 },
				REST,
			),
		).rejects.toMatchObject({ name: "TunerValidationError" })
		expect(t.frames).toEqual([])
		expect(t.controller.getState("rtl-1")!.frequency).toBe(100_000_000)

		t.controller.setControlMode("rtl-1", "external")
		await expect(
			t.controller.configure(
				"rtl-1",
				{ controlMode: "internal", frequency: 145_000_000, ppm: 9999 },
				REST,
			),
		).rejects.toMatchObject({ name: "TunerValidationError" })
		expect(t.frames).toEqual([])
		expect(t.controller.getState("rtl-1")!.controlMode).toBe("external")

		// A valid bulk update still proves the rate, then writes the frequency.
		t.controller.setControlMode("rtl-1", "internal")
		await t.controller.configure(
			"rtl-1",
			{ frequency: 145_000_000, gain: 200 },
			REST,
		)
		expect(t.frames.map(f => f[0])).toEqual([
			SET_SAMPLE_RATE,
			SET_FREQUENCY,
			0x04,
		])
	})
})
