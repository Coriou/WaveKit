import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import {
	FREQ_DIGITS,
	FREQ_FIELD_MAX,
	FREQ_MAX,
	FREQ_MIN,
	GAIN_MAX,
	PPM_LIMIT,
	SEND_ORDER,
	VALID_SAMPLE_RATES,
	applyEditKey,
	canReview,
	digitAt,
	editWindow,
	outOfRange,
	pendingChanges,
	pendingCommands,
	startEdit,
	turnsBiasTeeOn,
} from "../../../cli/source/ui/tuner-edit.js"
import type { EditKey } from "../../../cli/source/ui/actions.js"

const tuner: TunerState = {
	sourceId: "pi-iq",
	frequency: 445_970_700,
	sampleRate: 2_048_000,
	gainMode: "manual",
	gain: 0,
	ppm: 0,
	agcMode: false,
	biasTee: false,
	directSampling: "off",
	offsetTuning: false,
	ifGain: 0,
	tunerIfGain: null,
	testMode: false,
	controlMode: "internal",
	commandCount: 0,
}
const press = (keys: EditKey[], s = startEdit(tuner)) =>
	keys.reduce(applyEditKey, s)
const tabs = (n: number): EditKey[] =>
	Array.from({ length: n }, () => "tab" as const)

describe("tuner edit", () => {
	it("sends nothing until something changed", () => {
		expect(pendingCommands(startEdit(tuner))).toEqual([])
	})
	it("moves a digit cursor, changes digits and types over them", () => {
		let s = press(["up"])
		expect(s.draft.frequency).toBe(445_971_700)
		s = press(["left", "left", "5"])
		expect(s.draft.frequency).toBe(445_570_700)
		expect(s.digit).toBe(4)
		s = press(["right", "backspace"])
		expect(s.draft.frequency).toBe(445_970_000)
		expect(s.digit).toBe(3)
	})
	it("lets the frequency leave the server range while editing and holds the review (R42)", () => {
		const s = press(Array<EditKey>(12).fill("left").concat(["up", "up", "up"]))
		expect(s.draft.frequency).toBe(3_445_970_700)
		expect(s.draft.frequency).toBeGreaterThan(FREQ_MAX)
		expect(outOfRange(s)).toEqual(["frequency"])
		expect(canReview(s)).toBe(false)
		expect(canReview(press(["down", "down"], s))).toBe(true)
		expect(canReview(startEdit(tuner))).toBe(false)
	})
	it("typing a leading 0 keeps the lower digits (no clamp per keystroke)", () => {
		// Cursor on the 100 MHz digit: 445 970 700 → 045 970 700, lower digits kept.
		let s = press(["left", "left", "left", "left", "left", "0"])
		expect(s.draft.frequency).toBe(45_970_700)
		expect(outOfRange(s)).toEqual([])
		// From the 1 GHz digit, 0 0 0 → 005 970 700: below the range but nothing rewritten.
		s = press(["left", "left", "left", "left", "left", "left", "0", "0", "0"])
		expect(s.draft.frequency).toBe(5_970_700)
		expect(outOfRange(s)).toEqual(["frequency"])
		expect(press(["9"], s).draft.frequency).toBe(9_970_700)
	})
	it("cycles fields and edits sample rate, gain and toggles", () => {
		let s = press(["tab", "up"])
		expect(s.field).toBe("sampleRate")
		expect(s.draft.sampleRate).toBe(2_160_000)
		s = press(["tab", "up"], s)
		expect(s.field).toBe("gain")
		expect(s.draft.gainTenthsDb).toBe(1)
		s = press(["tab", "tab", "space"], s)
		expect(s.field).toBe("gainMode")
		expect(s.draft.gainMode).toBe("agc")
	})
	it("orders commands frequency → sample rate → gain mode → gain → … and skips gain under AGC", () => {
		let s = press(["up", "tab", "up", "tab", "up"])
		expect(pendingCommands(s).map(c => c.setting)).toEqual([
			"frequency",
			"sample-rate",
			"gain",
		])
		expect(pendingCommands(s)[2]?.body).toEqual({ tenthsDb: 1 })
		s = press(["tab", "tab", "space"], s)
		expect(pendingCommands(s).map(c => c.setting)).toEqual([
			"frequency",
			"sample-rate",
			"gain-mode",
		])
		expect(pendingChanges(s).find(c => c.field === "gainMode")).toEqual({
			field: "gainMode",
			from: "manual",
			to: "agc",
		})
	})
	it("flags turning bias-t on", () => {
		const s = press(["tab", "tab", "tab", "tab", "tab", "tab", "space"])
		expect(s.field).toBe("biasTee")
		expect(turnsBiasTeeOn(s)).toBe(true)
	})

	it("sends gain mode before gain when switching to manual and changing gain", () => {
		const agc = startEdit({ ...tuner, gainMode: "agc" })
		// frequency → sampleRate → (gain skipped under AGC) → ppm → gainMode
		let s = press(tabs(3), agc)
		expect(s.field).toBe("gainMode")
		s = press(
			["space", "tab", "tab", "tab", "tab", "tab", "tab", "tab", "up", "up"],
			s,
		)
		expect(s.field).toBe("gain")
		expect(pendingCommands(s)).toEqual([
			{ setting: "gain-mode", body: { mode: "manual" }, label: "gain mode" },
			{ setting: "gain", body: { tenthsDb: 2 }, label: "gain" },
		])
	})
	it("cycles direct sampling off → i → q → off and toggles booleans with arrows too", () => {
		let s = press(tabs(7))
		expect(s.field).toBe("directSampling")
		s = press(["space"], s)
		expect(s.draft.directSampling).toBe("i")
		expect(press(["down"], s).draft.directSampling).toBe("off")
		s = press(["up", "up"], s)
		expect(s.draft.directSampling).toBe("off")
		s = press(["tab", "up"], s)
		expect(s.field).toBe("offsetTuning")
		expect(s.draft.offsetTuning).toBe(true)
		expect(press(["tab"], s).field).toBe("frequency")
		expect(pendingCommands(s).map(c => [c.setting, c.body])).toEqual([
			["offset-tuning", { enabled: true }],
		])
	})
	it("ignores keys that do not apply to the field", () => {
		const onRate = press(["tab"])
		for (const k of ["left", "right", "backspace", "5", "space"] as const)
			expect(applyEditKey(onRate, k)).toEqual(onRate)
		const s = press(["right", "right", "right", "right"])
		expect(s.digit).toBe(0)
		expect(press(Array<EditKey>(20).fill("left")).digit).toBe(FREQ_DIGITS - 1)
	})
	it("moves an off-list sample rate to the next valid rate in the key's direction (R42)", () => {
		const off = startEdit({ ...tuner, sampleRate: 2_000_000 })
		expect(press(["tab", "up"], off).draft.sampleRate).toBe(2_048_000)
		expect(press(["tab", "down"], off).draft.sampleRate).toBe(1_920_000)
		const below = startEdit({ ...tuner, sampleRate: 230_000 })
		expect(press(["tab", "down"], below).draft.sampleRate).toBe(250_000)
		expect(press(["tab", "up"], below).draft.sampleRate).toBe(250_000)
		expect(
			press(["tab", ...Array<EditKey>(20).fill("up")]).draft.sampleRate,
		).toBe(3_200_000)
		expect(
			press(["tab", ...Array<EditKey>(20).fill("down")]).draft.sampleRate,
		).toBe(250_000)
	})
	it("clamps ppm and gain and keeps the frequency field non-negative", () => {
		const ppm = press([
			...tabs(3),
			...Array<EditKey>(PPM_LIMIT + 5).fill("down"),
		])
		expect(ppm.draft.ppm).toBe(-PPM_LIMIT)
		const gain = press(["tab", "tab", "down"])
		expect(gain.draft.gainTenthsDb).toBe(0)
		const low = press(["down"], startEdit({ ...tuner, frequency: FREQ_MIN }))
		expect(low.draft.frequency).toBe(FREQ_MIN - 1000)
		const zero = press(
			Array<EditKey>(9).fill("down"),
			startEdit({ ...tuner, frequency: 5000 }),
		)
		expect(zero.draft.frequency).toBe(0)
		const top = press(
			Array<EditKey>(12).fill("left").concat(Array<EditKey>(12).fill("up")),
		)
		expect(top.draft.frequency).toBe(FREQ_FIELD_MAX)
	})
	it("reports the pending window and reads digits", () => {
		const s = press(["tab", "up"])
		expect(editWindow(s)).toEqual({
			centreHz: 445_970_700,
			sampleRate: 2_160_000,
		})
		expect(digitAt(445_970_700, 5)).toBe(9)
		expect(digitAt(445_970_700, 0)).toBe(0)
		expect(digitAt(445_970_700, 8)).toBe(4)
	})

	// Feature: cli-dashboard-overhaul, Property —: tuner edit invariants
	// Validates: spec §6.4, plan assumption 7
	it("keeps the draft in range and commands in send order for any key sequence", () => {
		const key = fc.constantFrom<EditKey>(
			"left",
			"right",
			"up",
			"down",
			"tab",
			"space",
			"backspace",
			"0",
			"1",
			"5",
			"9",
		)
		fc.assert(
			fc.property(fc.array(key, { maxLength: 60 }), keys => {
				const s = press(keys)
				const f = s.draft.frequency
				expect(f).toBeGreaterThanOrEqual(0)
				expect(f).toBeLessThanOrEqual(FREQ_FIELD_MAX)
				expect(Number.isInteger(f)).toBe(true)
				expect(outOfRange(s).length === 0).toBe(f >= FREQ_MIN && f <= FREQ_MAX)
				if (canReview(s)) expect(pendingCommands(s).length).toBeGreaterThan(0)
				expect(VALID_SAMPLE_RATES).toContain(s.draft.sampleRate)
				expect(s.draft.gainTenthsDb).toBeGreaterThanOrEqual(0)
				expect(s.draft.gainTenthsDb).toBeLessThanOrEqual(GAIN_MAX)
				expect(Math.abs(s.draft.ppm)).toBeLessThanOrEqual(PPM_LIMIT)
				expect(s.digit).toBeGreaterThanOrEqual(0)
				expect(s.digit).toBeLessThan(FREQ_DIGITS)
				const order = pendingChanges(s).map(c => SEND_ORDER.indexOf(c.field))
				expect(order).toEqual([...order].sort((a, b) => a - b))
				expect(new Set(order).size).toBe(order.length)
				if (s.draft.gainMode === "agc")
					expect(pendingCommands(s).some(c => c.setting === "gain")).toBe(false)
			}),
			{ numRuns: 100 },
		)
	})
})
