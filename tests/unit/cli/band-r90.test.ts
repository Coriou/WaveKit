import { beforeAll, describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import type {
	BandAssessment,
	DecoderRow,
} from "../../../cli/source/data/types.js"
import {
	decoderMembership,
	retuneImpact,
	windowFor,
	type TunedWindow,
} from "../../../cli/source/data/window.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import {
	stripInput,
	windowCount,
} from "../../../cli/source/view-models/chrome.js"
import {
	decoderCells,
	decoderFacts,
} from "../../../cli/source/view-models/decoder-rows.js"
import { decoderDetail } from "../../../cli/source/view-models/decoders.js"
import { emptyFeedGroups } from "../../../cli/source/view-models/feed-state.js"
import { receiverLines } from "../../../cli/source/view-models/receiver.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

// The live scenario tunes pi-iq to 445.9707 MHz at 2.048 MS/s.
const NOW = Date.parse("2026-10-08T18:07:52Z")
const CENTRE = 445_970_700
const base = scenarioState("live")
const liveRow = (id: string): DecoderRow =>
	base.decoders.value!.find(d => d.id === id)!
const withRows = (rows: DecoderRow[]) => ({
	...base,
	now: NOW,
	decoders: laneOk(rows, NOW - 1000, "rest"),
})
const replace = (over: Record<string, Partial<DecoderRow>>) =>
	withRows(base.decoders.value!.map(d => ({ ...d, ...(over[d.id] ?? {}) })))

const from = windowFor(
	"pi-iq",
	base.tuner.value,
	base.sources.value,
	base.relay.value,
)!
const at = (centreHz: number, sampleRate = from.sampleRate): TunedWindow => ({
	sourceId: "pi-iq",
	centreHz,
	sampleRate,
	loHz: centreHz - sampleRate / 2,
	hiHz: centreHz + sampleRate / 2,
})

describe("R90 I1: a ? never counts as not in", () => {
	it("leaves ? out of both counts and reports how many are unknown", () => {
		expect(
			windowCount([
				{ membership: "in", followsCentre: false },
				{ membership: "out", followsCentre: false },
				{ membership: "?", followsCentre: false },
				{ membership: "—", followsCentre: false },
			]),
		).toEqual({ inWindow: 1, counted: 2, unknown: 1 })
	})
	it("is null when nothing but centre-following decoders is known", () => {
		expect(
			windowCount([
				{ membership: "in", followsCentre: true },
				{ membership: "?", followsCentre: false },
			]),
		).toBeNull()
	})
	it("strip and Overview agree when core reports a tuned decoder unknown", () => {
		const st = replace({
			"dsd-fme": {
				bandAssessment: {
					verdict: "unknown",
					reasonCode: "no-target-frequency",
				},
			},
		})
		// multimon-ng follows the centre (no assessment, R40 fallback); dsd-fme is ?.
		expect(stripInput(st).decoders?.inWindow).toBe(1)
		const empty = {
			...st,
			messages: { ...st.messages, items: [], total: 0 },
		}
		const text = emptyFeedGroups(empty)
			.map(g => g.variants[0]?.map(s => s.text).join("") ?? "")
			.join(" · ")
		expect(text).toMatch(/1 of 8 (decoders )?in window · 1 unknown/)
		expect(findBanned(text)).toEqual([])
	})
})

describe("R90 I2: core's verdict for tuned types, in every consumer", () => {
	// dsd-fme configured at 446.525 MHz, 554 kHz off the centre; audio frontend ±19.2 kHz.
	const DSD: BandAssessment = {
		verdict: "out-of-band",
		reasonCode: "frequency-out-of-band",
		targetsHz: [446_525_000],
		basis: "configured",
		captureCenterHz: CENTRE,
		windowHalfWidthHz: 19_200,
	}
	const dsd: Partial<DecoderRow> = {
		running: false,
		desiredRunning: true,
		suspended: true,
		suspension: {
			reasonCode: "frequency-out-of-band",
			since: "2026-10-08T18:00:00.000Z",
		},
		targetFrequenciesHz: [446_525_000],
		bandAssessment: DSD,
	}
	const st = replace({ "dsd-fme": dsd })
	const f = decoderFacts(st).find(x => x.row.id === "dsd-fme")!
	const row = f.row
	it("membership and the window cell read out", () => {
		expect(
			decoderMembership(row, st.sources.value, st.tuner.value, st.relay.value),
		).toBe("out")
		expect(
			(decoderCells(f, NOW)["window"]?.variants ?? []).map(lineText),
		).toEqual(["out"])
	})
	it("the band is core's configured target, with no R40 note and no tuned wording", () => {
		expect(
			(decoderCells(f, NOW)["nominal"]?.variants ?? []).map(lineText),
		).toEqual(["446.525*"])
		const text = decoderDetail(st, f, 120, NOW).map(lineText).join("\n")
		expect(text).toContain("446.525 MHz configured")
		expect(text).not.toContain("not applied by this decoder")
		expect(text).not.toContain("follows the receiver")
		expect(text).toContain(
			"suspended since 18:00:00 · resumes on retune to 446.525 MHz",
		)
	})
	it("the Receiver lists it out of window, not as tuned", () => {
		const text = receiverLines(st, initialUi("receiver"), 119, 35, true).map(
			lineText,
		)
		expect(text).toContain("in window multimon-ng (tuned)")
		expect(text.find(l => l.startsWith("out "))).toContain("dsd-fme")
	})
	it("retune impact: a retune to its target enters, by core's half-width", () => {
		const impact = retuneImpact([row], from, at(446_520_000))
		expect(impact.tuned).toEqual([])
		expect(impact.enters).toEqual(["dsd-fme"])
		// 30 kHz off the target is outside the ±19.2 kHz audio frontend.
		expect(retuneImpact([row], from, at(446_555_000)).enters).toEqual([])
	})
	it("without an assessment (older core) R40 still holds", () => {
		const old = liveRow("dsd-fme")
		expect(retuneImpact([old], from, at(100_000_000)).tuned).toEqual([
			"dsd-fme",
		])
	})
})

describe("R90 I3: a rate change never claims enters from ±rate/2", () => {
	const subject = (type: string, a: BandAssessment) => ({
		id: type,
		type,
		bandAssessment: a,
	})
	it("scales a capture-limited half-width with the rate", () => {
		// readsb: 0.4 × 2.048 MS/s; 1.1 MHz off at 2.4 MS/s is outside 0.4 × 2.4 MS/s.
		const readsb = subject("readsb", {
			verdict: "out-of-band",
			targetsHz: [1_090_000_000],
			windowHalfWidthHz: 0.4 * from.sampleRate,
		})
		const off = retuneImpact([readsb], from, at(1_088_900_000, 2_400_000))
		expect(off.enters).toEqual([])
		expect(off.unknown).toEqual([])
		expect(
			retuneImpact([readsb], from, at(1_089_100_000, 2_400_000)).enters,
		).toEqual(["readsb"])
	})
	it("keeps a frontend-limited half-width", () => {
		const direwolf = subject("direwolf", {
			verdict: "out-of-band",
			targetsHz: [144_390_000],
			windowHalfWidthHz: 19_200,
		})
		expect(
			retuneImpact([direwolf], from, at(144_400_000, 2_400_000)).enters,
		).toEqual(["direwolf"])
		expect(
			retuneImpact([direwolf], from, at(144_450_000, 2_400_000)).enters,
		).toEqual([])
	})
	it("is unknown when the half-width cannot be placed or is missing", () => {
		const odd = subject("readsb", {
			verdict: "out-of-band",
			targetsHz: [1_090_000_000],
			windowHalfWidthHz: 950_000,
		})
		expect(
			retuneImpact([odd], from, at(1_090_000_000, 2_400_000)).unknown,
		).toEqual(["readsb"])
		const noHalf = subject("readsb", {
			verdict: "out-of-band",
			targetsHz: [1_090_000_000],
		})
		expect(retuneImpact([noHalf], from, at(1_090_000_000)).unknown).toEqual([
			"readsb",
		])
	})
})
