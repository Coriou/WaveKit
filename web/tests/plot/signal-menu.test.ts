import { describe, expect, it } from "vitest"
import type { ResolvedBandPlanView, SavedFrequency } from "@wavekit/api-types"

import {
	decodeAsRows,
	signalMenuHead,
	signalMenuRows,
	type SignalMenuContext,
} from "../../src/plot/signal-menu.ts"

const PMR = {
	bands: [
		{
			key: "eu/pmr",
			layer: 0,
			segments: [{ startHz: 446_000_000, endHz: 446_200_000 }],
			band: {
				name: "PMR446",
				group: "marine",
				mode: "nfm",
				startHz: 446_000_000,
				endHz: 446_200_000,
				bandwidthHz: 12_500,
				channels: [
					{
						id: "p3",
						name: "PMR446 ch 3",
						frequencyHz: 446_031_250,
						aliases: [],
						registryRef: null,
					},
				],
			},
		},
	],
} as unknown as ResolvedBandPlanView

const ctx = (over: Partial<SignalMenuContext> = {}): SignalMenuContext => ({
	hz: 446_031_250,
	tunedHz: 145_500_000,
	readOnly: false,
	listening: false,
	plan: PMR,
	saved: [],
	...over,
})

const ids = (c: SignalMenuContext) => signalMenuRows(c).map(r => r.id)

describe("spectrum signal menu", () => {
	it("puts Identify first and tunes to the signal before acting on it", () => {
		const rows = signalMenuRows(ctx())
		expect(rows.map(r => r.id)).toEqual([
			"identify",
			"decode",
			"listen",
			"save",
			"activity",
			"copy",
		])
		expect(rows[0]?.steps.map(s => s.action.kind)).toEqual(["tune", "identify"])
		expect(rows[0]?.steps[0]?.action).toEqual({ kind: "tune", hz: 446_031_250 })
		const listen = rows.find(r => r.id === "listen")
		expect(listen?.label).toBe("Listen here")
		expect(listen?.steps.map(s => s.action.kind)).toEqual(["tune", "listen"])
	})

	it("acts in place on the tuned frequency", () => {
		const rows = signalMenuRows(ctx({ tunedHz: 446_031_250, listening: true }))
		expect(rows.map(r => r.id)).not.toContain("listen")
		expect(rows[0]?.steps.map(s => s.action.kind)).toEqual(["identify"])
		const save = rows.find(r => r.id === "save")?.steps[0]?.action
		expect(save).toEqual({
			kind: "save",
			hz: 446_031_250,
			name: "PMR446 ch 3",
			group: "Marine",
		})
		expect(
			signalMenuRows(ctx({ tunedHz: 446_031_250 })).find(r => r.id === "listen")
				?.steps,
		).toEqual([{ action: { kind: "listen", on: true }, done: null }])
	})

	it("saves another frequency with the band's mode, not the live one", () => {
		const save = signalMenuRows(ctx()).find(r => r.id === "save")
		expect(save?.steps[0]?.action).toMatchObject({ fromBand: true })
		expect(save?.hint).toBe("Marine")
	})

	it("only tunes when already listening elsewhere", () => {
		const listen = signalMenuRows(ctx({ listening: true })).find(
			r => r.id === "listen",
		)
		expect(listen?.label).toBe("Tune here")
		expect(listen?.steps.map(s => s.action.kind)).toEqual(["tune"])
	})

	it("offers only looking when read-only", () => {
		expect(ids(ctx({ readOnly: true }))).toEqual(["activity", "copy"])
		expect(ids(ctx({ readOnly: true, tunedHz: 446_031_250 }))).toEqual([
			"listen",
			"activity",
			"copy",
		])
	})

	it("names the signal from the saved list, then the plan", () => {
		const saved = {
			id: "s1",
			name: "Club net",
			frequencyHz: 446_031_250,
		} as SavedFrequency
		expect(signalMenuHead(ctx())).toBe("446.03125 MHz · PMR446 ch 3")
		expect(signalMenuHead(ctx({ saved: [saved] }))).toBe(
			"446.03125 MHz · Club net",
		)
		expect(ids(ctx({ saved: [saved] }))).not.toContain("save")
		expect(signalMenuHead(ctx({ hz: 100_000_000 }))).toBe("100.000 MHz")
	})

	it("Decode as… tries one protocol on the signal", () => {
		const rows = decodeAsRows(ctx())
		const dmr = rows.find(r => r.id === "decode:dmr")
		expect(dmr?.hint).toBe("dsd-fme")
		expect(dmr?.steps.map(s => s.action)).toEqual([
			{ kind: "tune", hz: 446_031_250 },
			{ kind: "identify", hz: 446_031_250, protocols: ["dmr"] },
		])
		expect(
			decodeAsRows(ctx({ tunedHz: 446_031_250 }))[0]?.steps.map(
				s => s.action.kind,
			),
		).toEqual(["identify"])
	})
})
