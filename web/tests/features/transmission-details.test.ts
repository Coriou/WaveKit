import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { TransmissionDto } from "../../src/features/transmission/contract.ts"
import {
	Details,
	detailFacts,
	detailIds,
} from "../../src/features/transmission/TransmissionView.tsx"
import {
	admissionRows,
	codeText,
	dateTimeText,
	dbfsText,
	dbText,
	FLAG_WORDS,
	humanCode,
	idSegments,
	KEPT_BY_WORDS,
	shareText,
	utcText,
} from "../../src/features/transmission/words.ts"

function dto(over: Partial<TransmissionDto>): TransmissionDto {
	return {
		id: "tx_20261123_173021_446006250",
		refs: {
			recordingKeys: ["scan:d_0123456789abcdef~analog-20261123-173021.wav"],
			eventIds: ["evt_01JDXYZABCDEF0123456789"],
			observationId: "o_0123456789abcdef0123",
			discoveryId: "d_0123456789abcdef",
			ownerDiscoveryId: "d_0123456789abcdef",
			operationId: "00000000-0000-4000-8000-000000000042",
		},
		kind: "voice-analog",
		recordingKind: "scanner-analog",
		protocol: "analog-fm",
		sourceId: "rx-1",
		channel: { hz: 446_006_250, measuredHz: 446_047_637, name: null },
		startedAt: "2026-11-23T17:30:21.000Z",
		endedAt: "2026-11-23T17:30:29.400Z",
		durationMs: 8400,
		close: { reason: "completed", complete: true },
		part: null,
		tone: {
			ctcssHz: null,
			dcs: null,
			dcsChecked: false,
			from: "recorder",
			state: "not-measured",
			why: "undetermined",
		},
		identity: null,
		signal: { snrDb: 24.4567, peakDbfs: -12.345, flags: ["offRaster"] },
		verdict: { speech: "not-heard", keptBy: "prior-none", itemCut: null },
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

const byTerm = (t: TransmissionDto) =>
	Object.fromEntries(detailFacts(t).map(f => [f.term, f]))

describe("Details: codes as words", () => {
	it("maps known codes to their sentence", () => {
		const f = byTerm(dto({}))
		expect(f["How it ended"]?.value).toBe("The transmission ended")
		expect(f["Why kept"]?.value).toBe(KEPT_BY_WORDS["prior-none"])
		expect(f["Speech"]?.value).toBe("No speech found")
		expect(f["Tone"]?.value).toBe("Not measured")
		expect(f["Flags"]?.value).toBe(FLAG_WORDS["offRaster"])
	})

	it("never shows a raw code: an unknown one reads in a safe readable form", () => {
		expect(humanCode("offRaster")).toBe("Off raster")
		expect(humanCode("prior-none")).toBe("Prior none")
		expect(humanCode("duration_limit")).toBe("Duration limit")
		expect(humanCode("<script>alert(1)</script>")).toBe("Script alert 1 script")
		expect(humanCode("---")).toBe("Unknown")
		expect(humanCode("x".repeat(500)).length).toBeLessThanOrEqual(60)
		expect(codeText("brand-new-rule", KEPT_BY_WORDS)).toBe("Brand new rule")
		expect(codeText(null, KEPT_BY_WORDS)).toBeNull()
		const f = byTerm(
			dto({
				close: { reason: "solar-flare", complete: false },
				verdict: { speech: "heard", keptBy: "newRule", itemCut: null },
				signal: { snrDb: null, peakDbfs: null, flags: ["newFlag"] },
			}),
		)
		expect(f["How it ended"]?.value).toBe("Solar flare")
		expect(f["Why kept"]?.value).toBe("New rule")
		expect(f["Flags"]?.value).toBe("New flag")
		for (const fact of detailFacts(dto({})))
			expect(fact.value).not.toMatch(/^[a-z]+[A-Z-]/)
	})

	it("puts the important facts first", () => {
		const terms = detailFacts(
			dto({
				copy: {
					of: { recordingKey: "k", hz: 156_800_000 },
					copies: [],
					copiesTotal: 0,
				},
			}),
		).map(f => f.term)
		expect(terms.slice(0, 9)).toEqual([
			"Started",
			"Ended",
			"Channel",
			"Measured",
			"Duration",
			"Speech",
			"Tone",
			"Why kept",
			"Copy of",
		])
		expect(terms).not.toContain("Transmission")
		expect(terms).not.toContain("Observation")
	})
})

describe("Details: numbers, frequencies and times", () => {
	it("rounds dB to one decimal with a true minus", () => {
		expect(dbText(24.4567)).toBe("24.5 dB")
		expect(dbfsText(-12.345)).toBe("−12.3 dBFS")
		expect(dbText(Number.NaN)).toBeNull()
		expect(shareText(0.123)).toBe("12 %")
		const f = byTerm(dto({}))
		expect(f["Signal"]?.value).toBe("24.5 dB")
		expect(f["Peak level"]?.value).toBe("−12.3 dBFS")
	})

	it("writes frequencies in MHz, the measured one once, with its offset", () => {
		const f = byTerm(dto({}))
		expect(f["Channel"]?.value).toBe("446.0063 MHz")
		expect(f["Measured"]?.value).toBe("446.047637 MHz (+41.4 kHz)")
		expect(f["Measured"]?.value).not.toMatch(/measured/i)
	})

	it("gives local times with the UTC instant under them", () => {
		const f = byTerm(dto({}))
		expect(f["Started"]?.value).toBe(dateTimeText("2026-11-23T17:30:21.000Z"))
		expect(f["Started"]?.value).toMatch(/2026, \d/)
		expect(f["Started"]?.hint).toBe("2026-11-23 17:30:21 UTC")
		expect(f["Started"]?.iso).toBe("2026-11-23T17:30:21.000Z")
		expect(utcText("nope")).toBe("")
		expect(dateTimeText(null)).toBe("")
	})

	it("labels and rounds the admission numbers", () => {
		const rows = admissionRows({
			frequencyHz: 446_006_430,
			reason: null,
			strength: "strong",
			levelFrames: 42,
			spreadDb: 18.44,
			p10Dbfs: -61.23,
			periodicShare: 0.12,
			burstFrames: 7,
		})
		const by = Object.fromEntries(rows.map(r => [r.term, r.value]))
		expect(by).toEqual({
			Strength: "Strong",
			Frequency: "446.00643 MHz",
			"Level spread": "18.4 dB",
			"Quiet level (10th percentile)": "−61.2 dBFS",
			"Periodic share": "12 %",
			"Level frames": "42",
			"Burst frames": "7",
		})
	})
})

describe("Details: identifiers", () => {
	it("lists every id, cut only between its tokens", () => {
		const ids = detailIds(dto({}))
		expect(ids.map(i => i.term)).toEqual([
			"Transmission",
			"Recording key",
			"Observation",
			"Discovery",
			"Activity event",
			"Operation",
			"Receiver",
		])
		expect(idSegments("scan:d_A~a-1.wav")).toEqual([
			"scan:",
			"d_",
			"A~",
			"a-",
			"1.",
			"wav",
		])
		expect(idSegments("scan:d_A~a-1.wav").join("")).toBe("scan:d_A~a-1.wav")
	})

	it("are collapsed by default, each with a fixed-width copy icon button", () => {
		const html = renderToStaticMarkup(
			createElement(Details, { t: dto({}), fileUrl: null }),
		)
		expect(html).toMatch(/<details class="wkt-idents">/)
		expect(html).not.toMatch(/<details class="wkt-idents" open/)
		expect(html).toContain("Identifiers · 7")
		expect(html).toContain('aria-label="Copy observation"')
		expect(html).toContain("wkt-copy")
		expect(html).toContain("<wbr/>")
		// no raw code anywhere in the facts
		expect(html).not.toContain(">prior-none<")
		expect(html).not.toContain(">completed<")
		expect(html).not.toContain("measured 446")
	})
})
