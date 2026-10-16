import { describe, expect, it } from "vitest"
import {
	clampHz,
	clickDirection,
	frequencyDigits,
	parseFrequency,
	startsEntry,
	stepPlace,
	TUNER_RANGE,
	wheelDirection,
} from "../../src/features/tuner/frequency.ts"
import {
	formatMHz,
	formatStep,
	formatWidth,
} from "../../src/features/format.ts"

const HERE = 161_150_000

describe("parseFrequency", () => {
	const ok = (q: string) => {
		const p = parseFrequency(q, HERE)
		if (p.kind !== "ok") throw new Error(`${q}: ${p.kind}`)
		return p
	}

	it("reads MHz, kHz, GHz and Hz with explicit units", () => {
		expect(ok("161.15").hz).toBe(161_150_000)
		expect(ok("161.15 MHz").hz).toBe(161_150_000)
		expect(ok("161.15m").hz).toBe(161_150_000)
		expect(ok("161150k").hz).toBe(161_150_000)
		expect(ok("161150 kHz").hz).toBe(161_150_000)
		expect(ok("1.09g").hz).toBe(1_090_000_000)
		expect(ok("1.09 GHz").hz).toBe(1_090_000_000)
		expect(ok("446006250 Hz").hz).toBe(446_006_250)
	})

	it("picks the unit of a bare number by its size", () => {
		expect(ok("161150000").hz).toBe(161_150_000) // ≥ 24e6: Hz
		expect(ok("161150").hz).toBe(161_150_000) // ≥ 24000: kHz
		expect(ok("446.00625").hz).toBe(446_006_250) // ≥ 24: MHz
		expect(ok("1.09").hz).toBe(1_090_000_000) // < 2: GHz
		expect(ok(".5").hz).toBe(500_000_000)
	})

	it("accepts a comma decimal and the display's grouped digits", () => {
		expect(ok("161,15").hz).toBe(161_150_000)
		expect(ok("0.161.150.000").hz).toBe(161_150_000)
		expect(ok("161.150.000").hz).toBe(161_150_000)
	})

	it("steps from the current frequency; a bare step is kHz", () => {
		const up = ok("+25k")
		expect(up).toMatchObject({ hz: HERE + 25_000, relative: true })
		expect(up.hint).toBe("Up 25 kHz from here")
		expect(ok("-12.5").hz).toBe(HERE - 12_500)
		expect(ok("- 1 MHz").hz).toBe(HERE - 1_000_000)
		expect(ok("+500hz").hint).toBe("Up 500 Hz from here")
	})

	it("says why a frequency cannot be tuned", () => {
		const below = parseFrequency("10", HERE)
		expect(below.kind).toBe("error")
		if (below.kind === "error") expect(below.message).toMatch(/Below 24 MHz/)
		expect(parseFrequency("2.5 GHz", HERE).kind).toBe("error")
		expect(parseFrequency("10 MHz", HERE).kind).toBe("error")
		expect(parseFrequency("-200m", HERE).kind).toBe("error")
		const custom = parseFrequency("1.8g", HERE, { minHz: 24e6, maxHz: 1.766e9 })
		expect(custom.kind).toBe("error")
		if (custom.kind === "error")
			expect(custom.message).toMatch(/24 MHz to 1.766 GHz/)
	})

	it("returns empty or unknown for text that is not a frequency", () => {
		expect(parseFrequency("  ", HERE).kind).toBe("empty")
		expect(parseFrequency("ch 16", HERE).kind).toBe("unknown")
		expect(parseFrequency("1.2.3", HERE).kind).toBe("unknown")
		expect(parseFrequency("12 parsecs", HERE).kind).toBe("unknown")
	})

	it("round-trips every displayed frequency (seeded)", () => {
		let seed = 7
		const rand = () =>
			(seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31
		for (let i = 0; i < 200; i++) {
			const hz =
				Math.round(
					(TUNER_RANGE.minHz +
						rand() * (TUNER_RANGE.maxHz - TUNER_RANGE.minHz)) /
						5,
				) * 5
			expect(ok(formatMHz(hz)).hz).toBe(hz)
			expect(ok(`${formatMHz(hz)} MHz`).hz).toBe(hz)
		}
	})
})

describe("place-value digits", () => {
	it("lays out ten digits with group separators and dim leading zeros", () => {
		const d = frequencyDigits(161_150_000)
		expect(d.map(x => x.char).join("")).toBe("0161150000")
		expect(d.map(x => (x.sepAfter ? `${x.char}.` : x.char)).join("")).toBe(
			"0.161.150.000",
		)
		expect(d.filter(x => x.leading).map(x => x.index)).toEqual([0])
		expect(d.filter(x => x.fine).map(x => x.index)).toEqual([7, 8, 9])
		expect(d[0]?.place).toBe(1e9)
		expect(d[4]?.place).toBe(1e5)
		expect(d[9]?.place).toBe(1)
		expect(frequencyDigits(1_090_000_000)[0]).toMatchObject({
			char: "1",
			leading: false,
		})
	})

	it("steps by the digit's place, carrying across digits", () => {
		expect(stepPlace(161_150_000, 1e5, 1)).toBe(161_250_000)
		expect(stepPlace(161_950_000, 1e5, 1)).toBe(162_050_000)
		expect(stepPlace(161_150_000, 1e6, -1)).toBe(160_150_000)
		expect(stepPlace(161_150_000, 1000, 3)).toBe(161_151_000) // one notch, whatever the delta
		expect(stepPlace(161_150_000, 1000, 0)).toBe(161_150_000)
	})

	it("clamps at the tuner range", () => {
		expect(stepPlace(24_500_000, 1e6, -1)).toBe(24_000_000)
		expect(stepPlace(1_850_000_000, 1e8, 1)).toBe(1_900_000_000)
		expect(clampHz(10)).toBe(TUNER_RANGE.minHz)
	})

	it("maps clicks, wheels and keys to directions", () => {
		expect(clickDirection(105, 100, 40)).toBe(1)
		expect(clickDirection(130, 100, 40)).toBe(-1)
		expect(wheelDirection(-3)).toBe(1)
		expect(wheelDirection(12)).toBe(-1)
		expect(wheelDirection(0)).toBe(0)
		expect(["1", "+", "-", ".", ","].every(startsEntry)).toBe(true)
		expect(["a", "Enter", "ArrowUp"].some(startsEntry)).toBe(false)
	})
})

describe("format", () => {
	it("formats frequencies, widths and steps", () => {
		expect(formatMHz(161_150_000)).toBe("161.150")
		expect(formatMHz(446_006_250)).toBe("446.00625")
		expect(formatMHz(161_975_500)).toBe("161.9755")
		expect(formatWidth(12_500)).toBe("12.5 kHz")
		expect(formatWidth(25_000)).toBe("25 kHz")
		expect(formatWidth(500)).toBe("500 Hz")
		expect(formatWidth(1_000_000)).toBe("1 MHz")
		expect(formatStep(6250)).toBe("6.25k")
		expect(formatStep(8330)).toBe("8.33k")
	})
})
