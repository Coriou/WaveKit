import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	RECORDING_CUTS,
	RECORDING_SPEECH,
	type RecordingInventoryItem,
} from "@wavekit/api-types"

import {
	parseFacts,
	readTone,
} from "../../src/features/transmission/contract.ts"
import type {
	TransmissionDto,
	TransmissionTone,
} from "../../src/features/transmission/contract.ts"
import { knownRows } from "../../src/features/transmission/TransmissionView.tsx"
import { recorderTone } from "../../src/features/transmission/load.ts"
import {
	CLOSE_WORDS,
	FINISH_CUT_WORDS,
	ITEM_CUT_WORDS,
	KEPT_BY_WORDS,
	SPEECH_WORDS,
	channelText,
	durationWords,
	measuredText,
	signalText,
	startText,
	toneRow,
	toneText,
	wordsFor,
} from "../../src/features/transmission/words.ts"
import { recordedAt } from "../../src/features/recordings/model.ts"

describe("tone words", () => {
	it("words every tone state", () => {
		expect(toneText({ kind: "ctcss", hz: 88.5 })).toBe("CTCSS 88.5 Hz")
		expect(toneText({ kind: "ctcss", hz: 67 })).toBe("CTCSS 67.0 Hz")
		expect(toneText({ kind: "dcs", code: "023" })).toBe("DCS 023")
		expect(toneText({ kind: "dcs", code: "23" })).toBe("DCS 023")
		expect(toneText({ kind: "dcs", code: "7" })).toBe("DCS 007")
		expect(toneText(null)).toBe("No tone heard")
		expect(toneText(undefined)).toBe("Not measured")
	})

	it("reads a malformed tone as not measured, never as no tone", () => {
		for (const bad of [
			{ kind: "ctcss", hz: 12 },
			{ kind: "ctcss", hz: Number.NaN },
			{ kind: "ctcss" },
			{ kind: "dcs", code: "089" },
			{ kind: "dcs", code: 23 },
			{ kind: "dcs", code: "1234" },
			{ kind: "other" },
			"88.5",
			88.5,
			0,
			false,
			[],
		])
			expect(toneText(bad)).toBe("Not measured")
	})

	// Feature: transmission-view, Property 1: "No tone heard" only for a measured absence
	// Validates: Requirements 3 (Tone row states)
	it('says "No tone heard" iff the tone is null', () => {
		const anyTone = fc.oneof(
			fc.constant(null),
			fc.constant(undefined),
			fc.record({ kind: fc.constant("ctcss"), hz: fc.double() }),
			fc.record({
				kind: fc.constant("ctcss"),
				hz: fc.double({ min: 67, max: 254.1, noNaN: true }),
			}),
			fc.record({
				kind: fc.constant("dcs"),
				code: fc.string({ maxLength: 4 }),
			}),
			fc.record({
				kind: fc.constant("dcs"),
				code: fc.stringMatching(/^[0-7]{1,3}$/),
			}),
			fc.anything(),
		)
		fc.assert(
			fc.property(anyTone, tone => {
				expect(toneText(tone) === "No tone heard").toBe(tone === null)
			}),
			{ numRuns: 300 },
		)
	})

	it("gives the Tone row a hint whenever it is not a plain value", () => {
		const base: TransmissionTone = {
			state: "heard",
			ctcssHz: 88.5,
			dcs: null,
			dcsChecked: false,
			from: "recorder",
			why: null,
		}
		expect(toneRow(base)).toEqual({ value: "CTCSS 88.5 Hz", hint: null })
		expect(
			toneRow({ ...base, ctcssHz: null, dcs: { code: "023", polarity: null } }),
		).toEqual({ value: "DCS 023", hint: null })
		expect(toneRow({ ...base, state: "none", ctcssHz: null }).value).toBe(
			"No tone heard",
		)
		expect(toneRow({ ...base, state: "none", ctcssHz: null }).hint).toMatch(
			/DCS/,
		)
		const notMeasured = {
			...base,
			state: "not-measured" as const,
			ctcssHz: null,
		}
		for (const why of ["no-facts", "undetermined", "malformed"] as const) {
			const row = toneRow({ ...notMeasured, why })
			expect(row.value).toBe("Not measured")
			expect(row.hint).not.toBeNull()
		}
	})

	it("maps the facts tone to the three honest states", () => {
		const facts = (tone: unknown) =>
			parseFacts({ ...FACTS, ...(tone === "absent" ? {} : { tone }) })
		expect(recorderTone(null)).toMatchObject({
			state: "not-measured",
			why: "no-facts",
		})
		expect(recorderTone(facts("absent"))).toMatchObject({
			state: "not-measured",
			why: "undetermined",
		})
		expect(recorderTone(facts(null))).toMatchObject({ state: "none" })
		expect(recorderTone(facts({ kind: "ctcss", hz: 88.5 }))).toMatchObject({
			state: "heard",
			ctcssHz: 88.5,
		})
		expect(recorderTone(facts({ kind: "dcs", code: "23" }))).toMatchObject({
			state: "heard",
			dcs: { code: "023" },
		})
		expect(recorderTone(facts({ kind: "ctcss", hz: "x" }))).toMatchObject({
			state: "not-measured",
			why: "malformed",
		})
	})

	it("keeps the other facts when only the tone is unreadable", () => {
		const f = parseFacts({ ...FACTS, tone: { kind: "dcs", code: "999" } })
		expect(f?.finish.cut).toBe("completed")
		expect(f?.toneMalformed).toBe(true)
		expect(f?.tone).toBeUndefined()
		expect(readTone({ kind: "dcs", code: "999" })).toBe("malformed")
		expect(parseFacts(null)).toBeNull()
		expect(parseFacts({ version: 2 })).toBeNull()
	})
})

describe("the codes table", () => {
	it("has a sentence for every code of the api-types unions", () => {
		for (const cut of RECORDING_CUTS)
			expect(wordsFor(ITEM_CUT_WORDS, cut)).not.toBeNull()
		for (const s of RECORDING_SPEECH)
			expect(wordsFor(SPEECH_WORDS, s)).not.toBeNull()
	})

	it("words every store cut and every keep reason of a kept file", () => {
		for (const cut of [
			"completed",
			"duration-limit",
			"track-ended",
			"cancelled",
			"discovery-deleted",
			"source-lost",
			"epoch-changed",
			"stream-changed",
			"channel-invalidated",
			"engine-failed",
			"shutdown",
		])
			expect(wordsFor(FINISH_CUT_WORDS, cut)).not.toBeNull()
		for (const k of ["own-tone", "final", "prior-none", "joined-decode"])
			expect(wordsFor(KEPT_BY_WORDS, k)).not.toBeNull()
		for (const c of ["squelch", "retune", "config", "stopped", "max-duration"])
			expect(wordsFor(CLOSE_WORDS, c)).not.toBeNull()
		expect(FINISH_CUT_WORDS["completed"]).toBe("The transmission ended")
		expect(KEPT_BY_WORDS["own-tone"]).toBe("Speech heard over a tone")
	})

	it("shows nothing for a code it lacks", () => {
		expect(wordsFor(KEPT_BY_WORDS, "brand-new-code")).toBeNull()
		expect(wordsFor(KEPT_BY_WORDS, null)).toBeNull()
		expect(wordsFor(KEPT_BY_WORDS, "toString")).toBeNull()
	})
})

describe("formatting", () => {
	it("says durations in seconds, never milliseconds", () => {
		expect(durationWords(8181)).toBe("8 s")
		expect(durationWords(72_000)).toBe("1 min 12 s")
		expect(durationWords(3_720_000)).toBe("1 h 2 min")
		expect(durationWords(null)).toBeNull()
		expect(durationWords(-1)).toBeNull()
	})

	it("names the channel on its raster in MHz", () => {
		expect(channelText(145_562_800)).toBe("145.5625 MHz")
		expect(channelText(null)).toBeNull()
		expect(channelText(Number.NaN)).toBeNull()
	})

	it("adds the date only when it is not today", () => {
		const now = new Date(2026, 10, 23, 18, 0, 0)
		const today = new Date(2026, 10, 23, 17, 30, 21).toISOString()
		const earlier = new Date(2026, 10, 12, 9, 5, 0).toISOString()
		expect(startText(today, now)).toMatch(/^\d/)
		expect(startText(today, now)).not.toContain(",")
		expect(startText(earlier, now)).toContain("12 Nov, ")
	})

	it("states one rounded number with what it is relative to", () => {
		expect(signalText(24.4)).toBe("Strong, 24 dB over the noise")
		expect(signalText(12)).toBe("Clear, 12 dB over the noise")
		expect(signalText(4.6)).toBe("Weak, 5 dB over the noise")
		expect(signalText(null)).toBeNull()
	})

	it("gives the measured centre in whole Hz as an offset", () => {
		expect(measuredText(145_562_753.4, 145_562_500)).toBe(
			"measured 145 562 753 Hz (+253 Hz)",
		)
		expect(measuredText(145_562_300, 145_562_500)).toBe(
			"measured 145 562 300 Hz (−200 Hz)",
		)
	})

	it("dates a recording row by the start of its audio, not its keep time", () => {
		const r = {
			startedAt: "2026-11-23T17:30:21.000Z",
			startedAtLocal: null,
			modifiedAt: "2026-11-23T17:32:00.000Z",
		} as RecordingInventoryItem
		expect(recordedAt(r).toISOString()).toBe("2026-11-23T17:30:21.000Z")
		expect(recordedAt({ ...r, startedAt: null }).toISOString()).toBe(
			"2026-11-23T17:32:00.000Z",
		)
	})
})

describe("What we know", () => {
	it("always shows Tone for analog FM, and only there", () => {
		const t = dto({ tone: recorderTone(null) })
		expect(knownRows(t).find(r => r.term === "Tone")?.value).toBe(
			"Not measured",
		)
		expect(
			knownRows(dto({ tone: null, kind: "voice-digital" })).some(
				r => r.term === "Tone",
			),
		).toBe(false)
		const none = dto({
			tone: recorderTone(parseFacts({ ...FACTS, tone: null })),
		})
		expect(knownRows(none).find(r => r.term === "Tone")?.value).toBe(
			"No tone heard",
		)
	})

	it("words the codes and omits what has no entry", () => {
		const rows = knownRows(
			dto({
				close: { reason: "completed", complete: true },
				verdict: { speech: "heard", keptBy: "own-tone", itemCut: null },
				signal: { snrDb: 24, peakDbfs: -20, flags: [] },
			}),
		)
		expect(rows.map(r => [r.term, r.value])).toEqual([
			["Tone", "Not measured"],
			["Signal", "Strong, 24 dB over the noise"],
			["Ended", "The transmission ended"],
			["Kept", "Speech heard over a tone"],
		])
		const unknown = knownRows(
			dto({
				close: { reason: "new-code", complete: false },
				verdict: { speech: "unchecked", keptBy: "new-code", itemCut: null },
			}),
		)
		expect(unknown.map(r => r.term)).toEqual(["Tone"])
	})
})

const FACTS = {
	version: 1,
	operationId: "00000000-0000-4000-8000-000000000001",
	discoveryId: "d_A",
	observationId: "o_A",
	frequencyHz: 145_562_700,
	startedAt: "2026-11-23T17:30:21.000Z",
	endedAt: "2026-11-23T17:30:29.000Z",
	keptAt: "2026-11-23T17:30:40.000Z",
	durationMs: 8000,
	finish: {
		cut: "completed",
		keptBy: "own-tone",
		speechHeard: true,
		cutActive: null,
	},
	admission: null,
}

function dto(over: Partial<TransmissionDto>): TransmissionDto {
	return {
		id: null,
		refs: {
			recordingKeys: [],
			eventIds: [],
			observationId: null,
			discoveryId: null,
			ownerDiscoveryId: null,
			operationId: null,
		},
		kind: "voice-analog",
		protocol: "analog-fm",
		sourceId: null,
		channel: { hz: 145_562_500, measuredHz: null, name: null },
		startedAt: "2026-11-23T17:30:21.000Z",
		endedAt: null,
		durationMs: 8000,
		close: null,
		part: null,
		tone: recorderTone(null),
		identity: null,
		signal: null,
		verdict: { speech: "unchecked", keptBy: null, itemCut: null },
		admission: null,
		artefacts: [],
		noAudioReason: null,
		group: null,
		sameTime: null,
		channelSummary: null,
		gone: [],
		raw: { recording: null, activity: null, facts: null, observation: null },
		...over,
	}
}
