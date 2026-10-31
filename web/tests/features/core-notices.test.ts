import { describe, expect, it, vi } from "vitest"
import type {
	DecoderInfo,
	ResourceAlert,
	ScannerIqCaptureStatus,
	TunerRatePolicyEventData,
	TunerState,
} from "@wavekit/api-types"
import type { EventsClient } from "../../src/data/events-client.ts"
import {
	LINK_LOSS_TEXT,
	linkAlertToast,
	linkText,
	ratePolicyNote,
	ratePolicyToast,
	watchReceiverNotices,
} from "../../src/features/receiver/notices.ts"
import {
	decoderStatusText,
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

	it("words raises, restores and skips", () => {
		expect(ratePolicyToast(policy({}))).toEqual({
			text: "Sample rate raised to 2.4 MS/s for ADS-B (1090 MHz)",
			warn: false,
		})
		expect(
			ratePolicyToast(policy({ action: "restored", toHz: 2_048_000 }))?.text,
		).toBe("Sample rate back to 2.048 MS/s")
		expect(
			ratePolicyToast(
				policy({ action: "skipped", skipped: "external-control" }),
			),
		).toMatchObject({ warn: true })
		expect(
			ratePolicyToast(policy({ action: "skipped", skipped: "rate-above" })),
		).toBeNull()
	})

	it("adds the link advisory to a raise only for loss on the receiver link", () => {
		const link = {
			level: "dropping" as const,
			transport: "network" as const,
			payloadBytesPerSecond: 4_800_000,
			sustainedBytesPerSecond: 3_600_000,
			shortfallPercent: 25,
			upstreamDropBytesPerSecond: 1000,
			lossReason: "source" as const,
		}
		expect(linkText(link)).toBe(
			"Receiver link dropping samples — lower the sample rate",
		)
		expect(linkText(link)).toBe(LINK_LOSS_TEXT)
		// a core before lossReason: `dropping` is source loss by the core's rule
		const { lossReason: _, ...legacy } = link
		expect(linkText(legacy)).toBe(LINK_LOSS_TEXT)
		expect(linkText({ ...link, level: "none" })).toBeNull()
		// unproven: nothing was lost
		expect(
			linkText({ ...legacy, level: "unproven", shortfallPercent: null }),
		).toBeNull()
		// a core branch dropped them after an arrival gap: not the link's fault, no notice
		expect(
			linkText({ ...link, level: "unproven", lossReason: "branch-congestion" }),
		).toBeNull()
		expect(linkText({ ...link, lossReason: "branch-congestion" })).toBeNull()
		// an unknown reason from a newer core is not shown as source loss
		expect(
			linkText({ ...link, lossReason: "elsewhere" as unknown as "source" }),
		).toBeNull()
		expect(ratePolicyToast(policy({ link }))).toEqual({
			text: `Sample rate raised to 2.4 MS/s for ADS-B (1090 MHz). ${LINK_LOSS_TEXT}`,
			warn: true,
		})
		expect(
			ratePolicyToast(
				policy({ link: { ...link, lossReason: "branch-congestion" } }),
			),
		).toMatchObject({ warn: false })
	})

	it("keeps the loss notice short enough for one toast line", () => {
		// the 560 px toast cap at about 7.5 px a character (14 px text): under 75 characters is one line
		expect(LINK_LOSS_TEXT.length).toBeLessThan(75)
	})
})

describe("link-capacity alert", () => {
	const alert = (severity: ResourceAlert["severity"]): ResourceAlert => ({
		type: "link-capacity",
		severity,
		message: "Link capacity: …",
		timestamp: "2026-10-22T10:00:00Z",
	})
	it("speaks only of loss: critical (dropping) only, link-capacity only", () => {
		expect(linkAlertToast(alert("critical"))).toBe(LINK_LOSS_TEXT)
		expect(linkAlertToast(alert("warning"))).toBeNull()
		expect(
			linkAlertToast({ ...alert("critical"), type: "upstream-drops" }),
		).toBeNull()
	})

	it("follows lossReason when the core sends it: source loss only", () => {
		for (const sev of ["critical", "warning"] as const) {
			expect(linkAlertToast({ ...alert(sev), lossReason: "source" })).toBe(
				LINK_LOSS_TEXT,
			)
			expect(
				linkAlertToast({ ...alert(sev), lossReason: "branch-congestion" }),
			).toBeNull()
		}
		expect(
			linkAlertToast({
				...alert("critical"),
				type: "upstream-drops",
				lossReason: "source",
			}),
		).toBeNull()
	})

	it("stays quiet right after a raise that already spoke of the link", () => {
		const handlers = new Map<string, (d: unknown) => void>()
		const events = {
			subscribe: () => () => {},
			on: (type: string, h: (d: unknown) => void) => {
				handlers.set(type, h)
				return () => handlers.delete(type)
			},
		} as unknown as EventsClient
		const toast = vi.fn()
		let t = 0
		const off = watchReceiverNotices(events, toast, () => t)
		handlers.get("tuner:rate-policy")?.(
			policy({
				link: {
					level: "dropping",
					transport: "network",
					payloadBytesPerSecond: 1,
					sustainedBytesPerSecond: null,
					shortfallPercent: null,
					upstreamDropBytesPerSecond: 1000,
					lossReason: "source",
				},
			}),
		)
		handlers.get("resources:alert")?.(alert("critical"))
		expect(toast).toHaveBeenCalledTimes(1)
		// an unproven link (warning) never toasts
		t = 10_000
		handlers.get("resources:alert")?.(alert("warning"))
		expect(toast).toHaveBeenCalledTimes(1)
		t = 10_000
		handlers.get("resources:alert")?.(alert("critical"))
		expect(toast).toHaveBeenCalledTimes(2)
		expect(toast.mock.calls[1]?.[1]).toEqual({ tone: "warn" })
		off()
		expect(handlers.size).toBe(0)
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
		expect(iqCaptureText(iq({}))?.text).toBe("IQ capture on")
		expect(
			iqCaptureText(
				iq({
					trialCaptures: { started: 5, completed: 4, failed: 1, swept: 2 },
				}),
			)?.text,
		).toBe("IQ capture on · 4 captured · 1 failed")
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
