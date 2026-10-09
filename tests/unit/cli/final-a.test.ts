import { describe, expect, it } from "vitest"
import {
	isFailing,
	procRole,
	processState,
} from "../../../cli/source/data/decoder-state.js"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { guardDecoder } from "../../../cli/source/data/guards.js"
import { initialState, reduce } from "../../../cli/source/data/reducers.js"
import type {
	BandAssessment,
	DecoderRow,
	Inbound,
	RestInbound,
} from "../../../cli/source/data/types.js"
import {
	retuneImpact,
	windowFor,
	type TunedWindow,
} from "../../../cli/source/data/window.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { stripInput } from "../../../cli/source/view-models/chrome.js"
import {
	decoderCells,
	decoderFacts,
	processWords,
} from "../../../cli/source/view-models/decoder-rows.js"

const NOW = Date.parse("2026-10-08T18:07:52Z")
const base = scenarioState("live")
const row = (over: Partial<DecoderRow> = {}): DecoderRow => ({
	id: "readsb",
	type: "readsb",
	running: true,
	health: "running",
	uptime: 51,
	stats: { bytesIn: 1, eventsOut: 3, errors: 0 },
	restartCount: 0,
	...over,
})
const withRows = (rows: DecoderRow[]) => ({
	...base,
	now: NOW,
	decoders: laneOk(rows, NOW - 1000, "rest"),
})

describe("final I1: core's resume path is not a fault", () => {
	// src/decoders/manager.ts resume: running false, desiredRunning true, health running.
	const resuming = row({
		running: false,
		desiredRunning: true,
		transition: "resuming",
	})
	it("reads resuming, neutral, not failing", () => {
		const p = processState(resuming, 0, false, NOW)
		expect(p).toBe("resuming")
		expect(procRole(p)).toBe("neutral")
		expect(isFailing(p)).toBe(false)
		const st = withRows([resuming])
		const f = decoderFacts(st)[0]!
		expect(processWords(f)).toBe("resuming")
		expect(
			(decoderCells(f, NOW)["process"]?.variants ?? []).map(lineText),
		).toEqual(["resuming"])
		expect(stripInput(st).decoders?.failing).toBe(0)
	})
	it("an unrecognised transition while not running reads ?", () => {
		const r = row({
			running: false,
			desiredRunning: true,
			transition: "unknown",
		})
		expect(processState(r, 0, false, NOW)).toBe("unknown")
		expect(stripInput(withRows([r])).decoders?.failing).toBe(0)
	})
	it("a decoder that is down with no transition is still a fault", () => {
		expect(
			processState(
				row({ running: false, desiredRunning: true }),
				0,
				false,
				NOW,
			),
		).toBe("down")
	})
})

describe("final M1: a capture-limited half-width never scales up", () => {
	const from = windowFor(
		"pi-iq",
		base.tuner.value,
		base.sources.value,
		base.relay.value,
	)!
	const at = (centreHz: number, sampleRate: number): TunedWindow => ({
		sourceId: "pi-iq",
		centreHz,
		sampleRate,
		loHz: centreHz - sampleRate / 2,
		hiHz: centreHz + sampleRate / 2,
	})
	const readsb = {
		id: "readsb",
		type: "readsb",
		bandAssessment: {
			verdict: "out-of-band",
			targetsHz: [1_090_000_000],
			windowHalfWidthHz: 0.4 * from.sampleRate,
		} satisfies BandAssessment,
	}
	it("a higher rate is unknown: core caps it by a frontend the API does not send", () => {
		const up = retuneImpact([readsb], from, at(1_089_000_000, 3_200_000))
		expect(up.enters).toEqual([])
		expect(up.unknown).toEqual(["readsb"])
	})
	it("a lower rate scales down", () => {
		// 0.4 × 1.024 MS/s = 409.6 kHz.
		expect(
			retuneImpact([readsb], from, at(1_089_700_000, 1_024_000)).enters,
		).toEqual(["readsb"])
		const off = retuneImpact([readsb], from, at(1_089_500_000, 1_024_000))
		expect(off.enters).toEqual([])
		expect(off.unknown).toEqual([])
	})
})

