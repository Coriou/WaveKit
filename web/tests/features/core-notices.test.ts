import { describe, expect, it } from "vitest"
import type {
	DecoderInfo,
	ScannerIqCaptureStatus,
	TunerRatePolicyEventData,
	TunerState,
} from "@wavekit/api-types"
import {
	CORE_BUSY_TEXT,
	LINK_LOSS_TEXT,
	UNKNOWN_LOSS_TEXT,
	linkConditionText,
	parseLinkSnapshot,
	ratePolicyNote,
	ratePolicyNotice,
} from "../../src/features/receiver/notices.ts"
import {
	decoderStatusText,
	decoderTone,
	efficiencyText,
	placementsText,
} from "../../src/features/settings/decoder-rows.ts"
import { iqCaptureText } from "../../src/features/scanner/drawer/rows.ts"

const policy = (
	over: Partial<TunerRatePolicyEventData>,
): TunerRatePolicyEventData => ({
	sourceId: "rx",
	action: "raised",
	reason: "adsb-1090",
	fromHz: 2_048_000,
	toHz: 2_400_000,
	...over,
})

describe("1090 MHz rate policy", () => {
	it("notes a held raise under Sample rate", () => {
		expect(ratePolicyNote(undefined)).toBeNull()
		const tuner = {
			ratePolicy: { raisedFromHz: 2_048_000, since: "2026-10-22T10:00:00Z" },
		} as TunerState
		expect(ratePolicyNote(tuner)).toContain("Raised from 2.048 MS/s")
		expect(ratePolicyNote(tuner)).toContain("1090 MHz rate policy")
	})

	it("words raises and restores as receipts, skips as conditions", () => {
		expect(ratePolicyNotice(policy({}))).toEqual({
			kind: "receipt",
			text: "Sample rate raised to 2.4 MS/s for ADS-B (1090 MHz)",
		})
		expect(
			ratePolicyNotice(policy({ action: "restored", toHz: 2_048_000 })),
		).toEqual({ kind: "receipt", text: "Sample rate back to 2.048 MS/s" })
		expect(
			ratePolicyNotice(
				policy({ action: "skipped", skipped: "external-control" }),
			),
		).toMatchObject({ kind: "condition" })
		expect(
			ratePolicyNotice(policy({ action: "skipped", skipped: "rate-above" })),
		).toBeNull()
	})

	it("never carries link text on a raise, whatever the link said", () => {
		const link = {
			level: "dropping" as const,
			transport: "network" as const,
			payloadBytesPerSecond: 4_800_000,
			sustainedBytesPerSecond: 3_600_000,
			shortfallPercent: 25,
			upstreamDropBytesPerSecond: 1000,
			lossReason: "source" as const,
		}
		expect(ratePolicyNotice(policy({ link }))?.text).toBe(
			"Sample rate raised to 2.4 MS/s for ADS-B (1090 MHz)",
		)
	})
})

describe("link condition text", () => {
	it("speaks of the link only for loss on it, and of lowering the rate only then", () => {
		const d = (lossReason?: string) => ({
			level: "dropping",
			...(lossReason !== undefined ? { lossReason } : {}),
		})
		expect(linkConditionText(d("source"), undefined)).toBe(LINK_LOSS_TEXT)
		expect(LINK_LOSS_TEXT).toBe(
			"Receiver link dropping samples — lower the sample rate",
		)
		// a dropping entry without a cause is not blamed on the link
		expect(linkConditionText(d(), undefined)).toBe(UNKNOWN_LOSS_TEXT)
		expect(linkConditionText(d("core-busy"), undefined)).toBe(CORE_BUSY_TEXT)
		expect(CORE_BUSY_TEXT).toBe("Samples lost: WaveKit is too busy to keep up")
		expect(linkConditionText(d("unknown"), undefined)).toBe(UNKNOWN_LOSS_TEXT)
		expect(UNKNOWN_LOSS_TEXT).toBe("Receiver samples lost")
		// a cause a newer core names reads as unknown, never as link loss
		expect(linkConditionText(d("elsewhere"), undefined)).toBe(UNKNOWN_LOSS_TEXT)
		expect(linkConditionText(d("branch-congestion"), undefined)).toBeNull()
		expect(linkConditionText({ level: "unproven" }, undefined)).toBeNull()
		expect(linkConditionText({ level: "none" }, undefined)).toBeNull()
		const held = {
			sampleRate: 2_400_000,
			ratePolicy: { raisedFromHz: 2_048_000, since: "2026-10-22T10:00:00Z" },
		} as TunerState
		expect(linkConditionText(d("source"), held)).toBe(
			"Receiver link dropping samples at 2.4 MS/s (raised for ADS-B)",
		)
		expect(linkConditionText(d("core-busy"), held)).toBe(CORE_BUSY_TEXT)
	})

	it("keeps every text short enough for one toast line", () => {
		// the 560 px toast cap at about 7.5 px a character (14 px text): under 75 characters is one line
		for (const t of [LINK_LOSS_TEXT, CORE_BUSY_TEXT, UNKNOWN_LOSS_TEXT])
			expect(t.length).toBeLessThan(75)
	})

	it("reads snapshots at the boundary: bad entries dropped, absent field as none", () => {
		expect(parseLinkSnapshot(null)).toBeNull()
		expect(parseLinkSnapshot({ timestamp: "never" })).toBeNull()
		expect(
			parseLinkSnapshot({ timestamp: "2026-10-22T10:00:00Z" })?.entries,
		).toEqual([])
		const parsed = parseLinkSnapshot({
			timestamp: "2026-10-22T10:00:00Z",
			linkAdvisories: [
				{ sourceId: "rx", level: "dropping", since: "2026-10-22T09:59:00Z" },
				{ sourceId: "", level: "dropping", since: "2026-10-22T09:59:00Z" },
				{ sourceId: "ry", level: "dropping", since: "later" },
				"junk",
			],
		})
		expect(parsed?.entries.map(e => e.sourceId)).toEqual(["rx"])
	})
})

describe("decoder enablement in Settings", () => {
	const base = {
		id: "ais",
		type: "ais",
		running: true,
		health: "healthy",
	} as unknown as DecoderInfo

	it("says why it waits", () => {
		const d = {
			...base,
			suspended: true,
			suspension: { reasonCode: "efficiency-budget" },
			efficiency: { detail: "budget" },
		} as unknown as DecoderInfo
		expect(decoderStatusText(d)).toBe("Paused · over the efficiency budget")
		const gate = (detail?: string) =>
			decoderStatusText({
				...base,
				suspended: true,
				suspension: { reasonCode: "efficiency-budget" },
				...(detail ? { efficiency: { detail } } : {}),
			} as unknown as DecoderInfo)
		expect(gate()).toBe("Paused · waiting for the source to settle")
		expect(gate("unknown")).toBe("Paused · waiting for the source to settle")
		expect(gate("cpu")).toBe("Paused · the CPU is busy")
		expect(gate("drops")).toBe("Paused · the source was dropping samples")
		expect(gate("late-drops")).toBe(
			"Paused · samples were dropped while it ran",
		)
		const paused = (reasonCode: string) =>
			decoderStatusText({
				...base,
				suspended: true,
				suspension: { reasonCode },
			} as unknown as DecoderInfo)
		expect(paused("capture-too-narrow")).toBe(
			"Paused · the capture is too narrow here",
		)
		expect(paused("no-channel-selected")).toBe(
			"Paused · no channel selected yet",
		)
		expect(efficiencyText(base)).toBeNull()
		expect(efficiencyText({ ...base, efficiency: { detail: "drops" } })).toBe(
			"Waiting: it dropped samples",
		)
		expect(
			efficiencyText({
				...base,
				efficiency: { detail: "budget", retryAt: "2026-10-22T10:05:00Z" },
			}),
		).toMatch(/^Waiting: over the CPU budget · tries again at /)
	})

	it("reads a receiver pause as paused, not as a fault or not running", () => {
		const held = {
			...base,
			running: false,
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "source-paused" },
		} as unknown as DecoderInfo
		expect(decoderStatusText(held)).toBe("Paused · the receiver is paused")
		expect(decoderTone(held)).toBe("idle")
		// an operator stop still reads stopped, a crash loop still a fault
		const stopped = { ...held, desiredRunning: false } as DecoderInfo
		expect(decoderStatusText(stopped)).toBe("Stopped")
		expect(decoderTone(stopped)).toBe("off")
		const faulted = { ...held, health: "faulted" } as DecoderInfo
		expect(decoderTone(faulted)).toBe("fault")
	})

	it("lists its placements", () => {
		expect(placementsText(base)).toBeNull()
		const placement = {
			sourceId: "rx",
			reach: "channel" as const,
			primary: true,
			running: true,
			costCores: 0.1,
		}
		expect(
			placementsText({
				...base,
				placements: [
					{ ...placement, channelHz: 161_975_000, origin: "band" },
					{ ...placement, reach: "raw", origin: "vfo", running: false },
				],
			}),
		).toBe("161.975 MHz (its band), the whole capture (tuned, stopped)")
	})
})

describe("IQ capture in the Scanner footer", () => {
	const iq = (
		over: Partial<ScannerIqCaptureStatus>,
	): ScannerIqCaptureStatus => ({
		toolFailures: 0,
		lastToolFailure: null,
		...over,
	})
	it("is absent while capture is off", () => {
		expect(iqCaptureText(undefined)).toBeNull()
	})
	it("counts captures", () => {
		expect(
			iqCaptureText(
				iq({
					trialCaptures: { started: 2, completed: 0, failed: 2, swept: 0 },
				}),
			)?.text,
		).toBe("IQ analyses: 0 done · 2 unfinished")
		expect(iqCaptureText(iq({}))?.text).toBe("IQ analyses on")
		expect(
			iqCaptureText(
				iq({
					trialCaptures: { started: 5, completed: 4, failed: 1, swept: 2 },
				}),
			)?.text,
		).toBe("IQ analyses: 4 done · 1 unfinished")
	})
	it("turns amber when the capture tool fails", () => {
		const v = iqCaptureText(
			iq({
				toolFailures: 2,
				lastToolFailure: {
					exitCode: 1,
					signal: null,
					phase: "exit-before-ready",
					reason: "sample-rate",
				},
			}),
		)
		expect(v).toMatchObject({
			text: "IQ capture failing · the sample rate",
			amber: true,
		})
		expect(v?.title).toContain("failed 2 times")
	})
})
