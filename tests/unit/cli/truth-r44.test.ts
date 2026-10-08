import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import { bandLabel } from "../../../cli/source/data/nominal-bands.js"
import type { FormattedMessage } from "../../../cli/source/data/types.js"
import { windowFor } from "../../../cli/source/data/window.js"
import {
	formatAcars,
	formatVdl2,
} from "../../../cli/source/ui/messages/acars.js"
import { formatAis } from "../../../cli/source/ui/messages/ais.js"
import { formatAprs } from "../../../cli/source/ui/messages/aprs.js"

const field = (m: FormattedMessage, label: string): string | undefined =>
	m.fields.find(f => f.label === label)?.value
const summary = (m: FormattedMessage): string =>
	m.segments.map(s => s.text).join(" ")

describe("R44: dumpvdl2 / acarsdec frequency", () => {
	it("frequency 0 falls back to vdl2.freq", () => {
		const m = formatVdl2(
			{ icao: "4ca9d2", frequency: 0, vdl2: { freq: 136975000 } },
			"dumpvdl2",
			"vdl2",
		)
		expect(field(m, "frequency")).toBe("136.975 MHz")
		expect(summary(m)).toContain("136.975 MHz")
	})
	it("frequency 0 with no fallback is unknown, never 0.000 MHz", () => {
		for (const m of [
			formatVdl2({ icao: "4ca9d2", frequency: 0 }, "dumpvdl2", "vdl2"),
			formatAcars({ tail: "EI-ABC", frequency: 0 }, "acarsdec", "acars"),
		]) {
			expect(field(m, "frequency")).toBe("?")
			expect(summary(m)).not.toContain("MHz")
		}
	})
	it("absent frequency stays absent", () => {
		expect(
			field(formatVdl2({ icao: "4ca9d2" }, "dumpvdl2", "vdl2"), "frequency"),
		).toBeUndefined()
	})
})

describe("R44: server default strings", () => {
	it('vdl2 msgType "unknown"/"Unknown" renders ?', () => {
		for (const msgType of ["unknown", "Unknown"]) {
			const m = formatVdl2({ icao: "4ca9d2", msgType }, "dumpvdl2", "vdl2")
			expect(field(m, "type")).toBe("?")
			expect(summary(m).toLowerCase()).not.toContain("unknown")
		}
		expect(
			field(
				formatVdl2({ icao: "4ca9d2", msgType: "xid" }, "dumpvdl2", "vdl2"),
				"type",
			),
		).toBe("xid")
	})
	it('aprs dataType "Unknown" renders ?', () => {
		const m = formatAprs(
			{ source: "N0CALL", dataType: "Unknown" },
			"direwolf",
			"aprs",
		)
		expect(field(m, "type")).toBe("?")
		expect(summary(m).toLowerCase()).not.toContain("unknown")
	})
})

describe("R44: AIS sentinels are unknown", () => {
	const ship = {
		mmsi: 235009802,
		name: "SEA SPRITE",
		imo: 0,
		draught: 0,
		sog: 102.3,
		lat: 91,
		lon: 181,
		cog: 360,
		heading: 511,
	}
	const m = formatAis(ship, "ais-catcher", "ship")
	it("shows ? in the detail fields", () => {
		expect(field(m, "imo")).toBe("?")
		expect(field(m, "draught")).toBe("?")
		expect(field(m, "speed")).toBe("?")
		expect(field(m, "position")).toBe("?")
		expect(field(m, "course")).toBe("?")
	})
	it("never prints a sentinel number", () => {
		const all = `${summary(m)} ${m.fields.map(f => f.value).join(" ")}`
		for (const n of ["102.3", "91.0", "181.0", "360", "511", "0 m"])
			expect(all).not.toContain(n)
	})
	it("keeps real values", () => {
		const real = formatAis(
			{
				mmsi: 1,
				imo: 9074729,
				draught: 5.2,
				sog: 12.4,
				lat: 51.5,
				lon: -0.1,
				cog: 359.9,
			},
			"ais-catcher",
			"ship",
		)
		expect(field(real, "imo")).toBe("9074729")
		expect(field(real, "draught")).toBe("5.2 m")
		expect(field(real, "speed")).toBe("12.4 kn")
		expect(field(real, "position")).toBe("51.5000, -0.1000")
		expect(summary(real)).toContain("12.4 kn")
	})
})

describe("R44: band and window", () => {
	it("a band with zero channels is ?", () => {
		expect(
			bandLabel({ kind: "channels", channelsMHz: [], join: "span" }, "–"),
		).toBe("?")
	})
	it("windowFor falls back to caps.centerFreq when the tuner frequency is 0", () => {
		const tuner = {
			sourceId: "s",
			frequency: 0,
			sampleRate: 2_048_000,
		} as TunerState
		const source = {
			id: "s",
			caps: {
				kind: "iq",
				sampleRate: 2_048_000,
				format: "U8_IQ",
				exclusive: false,
				centerFreq: 446_000_000,
			},
		} as ExtendedSourceStatus
		expect(windowFor("s", [tuner], [source], undefined)).toMatchObject({
			centreHz: 446_000_000,
		})
		const zeroRate = {
			...tuner,
			frequency: 446_000_000,
			sampleRate: 0,
		} as TunerState
		expect(windowFor("s", [zeroRate], [source], undefined)).toMatchObject({
			sampleRate: 2_048_000,
		})
	})
})
