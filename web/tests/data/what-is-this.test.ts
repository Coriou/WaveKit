// Band inspection UX req 1.3: "what is this" (protocol slot, muted hint, next step from coverage).
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Discovery } from "@wavekit/api-types"

import {
	hintText,
	likelyText,
	nextStepText,
	protocolSlotText,
	whatIsThis,
} from "../../src/data/scanner-format.ts"
import { discoveryRow } from "../../src/features/scanner/drawer/rows.ts"

function disc(over: Record<string, unknown> = {}): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	return {
		id: "d",
		frequencyHz: 433_920_000,
		frequencyKey: "433920000",
		measuredOffsetHz: 0,
		bandwidthHz: 12_500,
		protocol: "unknown",
		family: "unknown",
		class: "unknown",
		confidence: "activity",
		encrypted: false,
		coChannel: [],
		firstSeenAt: "2026-10-25T07:00:00.000Z",
		lastSeenAt: "2026-10-25T08:00:00.000Z",
		observationCount: 1,
		airtimeMs: 100,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["pi"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: false, iq: false },
		...over,
	} as Discovery
}
const cov = (state: string, reason?: string) => ({
	decoderId: "rtl433",
	state,
	...(reason ? { suspensionReason: reason } : {}),
})

describe("hint text", () => {
	it("names every hint and reads anything else as unclassified", () => {
		expect(hintText("ism-device")).toBe("ISM device")
		expect(hintText("analog-voice")).toBe("analog voice")
		expect(hintText("lora")).toBe("LoRa")
		expect(hintText("ook-burst")).toBe("OOK bursts")
		expect(hintText("unknown")).toBe("unclassified")
		expect(hintText("sub-ghz-warble")).toBe("unclassified")
		expect(hintText(42)).toBe("unclassified")
		expect(hintText("__proto__")).toBe("unclassified")
		expect(hintText(undefined)).toBeNull()
	})

	it("is muted and never the protocol: tentative keeps its qualifier, verified drops the hint", () => {
		const weak = disc({ hint: "ism-device" })
		expect(protocolSlotText(weak)).toBe("Heard")
		expect(likelyText(weak)).toBe("likely ISM device")
		const maybe = disc({
			protocol: "dmr",
			confidence: "candidate",
			hint: "lora",
		})
		expect(protocolSlotText(maybe)).toBe("Maybe DMR")
		const proven = disc({
			protocol: "dmr",
			confidence: "classified",
			evidenceLevel: "proven",
			hint: "lora",
		})
		expect(protocolSlotText(proven)).toBe("DMR")
		expect(likelyText(proven)).toBeNull()
		expect(
			protocolSlotText(disc({ protocol: "dmr", confidence: "decoded" })),
		).toBe("DMR")
	})
})

describe("next step (req 1.3 table)", () => {
	const cases: [string, Record<string, unknown>, string][] = [
		["absent", {}, "Run identify"],
		[
			"[] + analog voice",
			{ coverage: [], hint: "analog-voice" },
			"Listen to check",
		],
		["[]", { coverage: [] }, "No decoder covers this frequency; run identify"],
		[
			"running",
			{ coverage: [cov("running")] },
			"rtl433 is listening; wait for a transmission",
		],
		[
			"out of band",
			{ coverage: [cov("suspended", "frequency-out-of-band")] },
			"rtl433 covers this band only when tuned to it",
		],
		[
			"too narrow",
			{ coverage: [cov("suspended", "capture-too-narrow")] },
			"Widen the capture so rtl433 fits",
		],
		[
			"no channel",
			{ coverage: [cov("suspended", "no-channel-selected")] },
			"Select a channel for rtl433",
		],
		[
			"known other reason",
			{ coverage: [cov("suspended", "tuner-scanning")] },
			"rtl433 is suspended",
		],
		[
			"unknown reason",
			{ coverage: [cov("suspended", "warp-drive")] },
			"rtl433 is suspended",
		],
		["stopped", { coverage: [cov("stopped")] }, "Start rtl433 to identify"],
		[
			"unknown state",
			{ coverage: [cov("hibernating")] },
			"rtl433 may cover this; run identify",
		],
		[
			"running + voice",
			{ coverage: [cov("running")], hint: "analog-voice" },
			"rtl433 is listening; wait for a transmission · Listen to check",
		],
		[
			"running wins over suspended",
			{ coverage: [cov("suspended", "capture-too-narrow"), cov("running")] },
			"rtl433 is listening; wait for a transmission",
		],
		["malformed entries only", { coverage: [{ nope: 1 }] }, "Run identify"],
	]
	it.each(cases)("%s", (_, over, text) => {
		expect(nextStepText(disc(over))).toBe(text)
	})

	it("a drawer row carries it for unverified discoveries only", () => {
		const row = discoveryRow(
			disc({ hint: "ism-device", coverage: [] }),
			Date.now(),
		)
		expect(row.likely).toBe("likely ISM device")
		expect(row.next).toBe("No decoder covers this frequency; run identify")
		expect(
			discoveryRow(disc({ protocol: "dmr", confidence: "decoded" }), Date.now())
				.next,
		).toBeNull()
	})

	// Feature: band-inspection-ux, Property 4: the protocol slot never comes from the hint; "listening" only when running
	// Validates: Requirements 1.3
	it("never fills the protocol from the hint and never says listening without a running entry", () => {
		const state = fc.oneof(
			fc.constantFrom("running", "suspended", "stopped"),
			fc.string({ maxLength: 12 }),
		)
		const entry = fc.record({
			decoderId: fc.string({ minLength: 1, maxLength: 64 }),
			state,
			suspensionReason: fc.oneof(
				fc.constantFrom(
					"frequency-out-of-band",
					"capture-too-narrow",
					"no-channel-selected",
				),
				fc.string({ maxLength: 20 }),
			),
		})
		fc.assert(
			fc.property(
				fc.oneof(fc.constant(undefined), fc.array(entry, { maxLength: 4 })),
				fc.oneof(
					fc.constant(undefined),
					fc.constantFrom("ism-device", "analog-voice", "lora", "fsk2-wide"),
					fc.string({ maxLength: 12 }),
				),
				fc.constantFrom("activity", "candidate", "classified", "decoded"),
				(coverage, hint, confidence) => {
					const d = disc({
						confidence,
						protocol: confidence === "activity" ? "unknown" : "ism",
						...(coverage !== undefined ? { coverage } : {}),
						...(hint !== undefined ? { hint } : {}),
					})
					const w = whatIsThis(d)
					const words = hintText(hint)
					if (words !== null) expect(w.protocol).not.toContain(words)
					expect(w.protocol.toLowerCase()).not.toContain("likely ism device")
					const running = (coverage ?? []).some(e => e.state === "running")
					if (!running) expect(w.next).not.toContain("listening")
				},
			),
			{ numRuns: 200 },
		)
	})
})
