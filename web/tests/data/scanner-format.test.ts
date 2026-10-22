import { describe, expect, it } from "vitest"
import type { ScanJob, ScannerProtocol } from "@wavekit/api-types"
import {
	confidenceText,
	discoveryTitle,
	formatWait,
	heldFrequencyHz,
	identityText,
	jobStateLine,
	jobTone,
	protocolName,
	scanPhaseText,
	sweepProgress,
	trialOutcomeText,
	undecodedReasonText,
} from "../../src/data/scanner-format.ts"

const NOW = Date.parse("2026-10-17T08:00:00.000Z")

type JobLine = Parameters<typeof jobStateLine>[0]
const paused = (over: Partial<JobLine>): JobLine => ({
	state: "paused",
	resumeAt: null,
	resumeHeldBy: null,
	...over,
})

describe("scanner-format", () => {
	it("names every protocol without raw ids", () => {
		const all: ScannerProtocol[] = [
			"analog-fm",
			"analog-am",
			"dmr",
			"p25p1",
			"p25p2",
			"nxdn48",
			"nxdn96",
			"ysf",
			"dstar",
			"dpmr",
			"pocsag",
			"flex",
			"aprs",
			"ism",
			"digital-unknown",
			"carrier",
			"unknown",
			"ais",
			"acars",
			"vdl2",
			"lora",
		]
		const names = all.map(protocolName)
		expect(names).toEqual([
			"FM voice",
			"AM voice",
			"DMR",
			"P25",
			"P25",
			"NXDN",
			"NXDN",
			"YSF",
			"D-STAR",
			"dPMR",
			"POCSAG",
			"FLEX",
			"APRS",
			"ISM",
			"Digital",
			"Carrier",
			"Unknown",
			"AIS",
			"ACARS",
			"VDL2",
			"LoRa",
		])
		expect(protocolName("something-new")).toBe("Unknown")
	})

	it("says confidence in words", () => {
		expect(confidenceText({ confidence: "activity", protocol: "dmr" })).toBe(
			"Heard",
		)
		expect(confidenceText({ confidence: "candidate", protocol: "dmr" })).toBe(
			"Maybe DMR",
		)
		expect(confidenceText({ confidence: "classified", protocol: "dmr" })).toBe(
			"Likely DMR",
		)
		expect(confidenceText({ confidence: "decoded", protocol: "dmr" })).toBe(
			"DMR",
		)
		expect(
			confidenceText({ confidence: "candidate", protocol: "analog-fm" }),
		).toBe("Maybe FM voice")
		expect(
			confidenceText({ confidence: "candidate", protocol: "unknown" }),
		).toBe("Heard")
	})

	it("shows identities", () => {
		expect(identityText({ kind: "dmr-cc", value: "1" })).toBe("CC 1")
		expect(identityText({ kind: "p25-nac", value: "293" })).toBe("NAC 293")
		expect(identityText({ kind: "pocsag-capcode", value: "1234567" })).toBe(
			"Capcode 1234567",
		)
		expect(identityText({ kind: "aprs-call", value: "F4ABC-9" })).toBe(
			"F4ABC-9",
		)
		expect(identityText(undefined)).toBe("")
		expect(
			discoveryTitle({
				confidence: "decoded",
				protocol: "dmr",
				identity: { kind: "dmr-cc", value: "1" },
			} as Parameters<typeof discoveryTitle>[0]),
		).toBe("DMR · CC 1")
	})

	it("says why a decode failed", () => {
		expect(undecodedReasonText("no-sync")).toBe("No sync")
		expect(undecodedReasonText("crc-errors")).toBe("CRC errors")
		expect(undecodedReasonText("timeout")).toBe("Timed out")
		expect(undecodedReasonText(undefined)).toBeNull()
		expect(trialOutcomeText("skipped-budget")).toBe("Skipped (busy)")
	})

	it("writes job state lines", () => {
		const opts = { now: NOW }
		expect(jobStateLine(paused({ state: "running" }), opts)).toBe("Scanning")
		expect(
			jobStateLine(paused({ state: "holding" }), { heldHz: 146_962_500 }),
		).toBe("Held on 146.9625")
		expect(jobStateLine(paused({ reason: "operator" }), opts)).toBe("Paused")
		expect(
			jobStateLine(
				paused({
					reason: "preempted-operator",
					resumeAt: new Date(NOW + 57_200).toISOString(),
				}),
				opts,
			),
		).toBe("Scan paused · you tuned · resumes in 58 s")
		expect(
			jobStateLine(
				paused({
					reason: "preempted-job",
					preemptedBy: { jobId: "j2", name: "Marine VHF" },
				}),
				opts,
			),
		).toBe("Paused by Marine VHF")
		expect(jobStateLine(paused({ reason: "source-down" }), opts)).toBe(
			"Source down",
		)
		expect(
			jobStateLine(
				paused({ reason: "resume-blocked", resumeHeldBy: "audio" }),
				opts,
			),
		).toBe("Paused · resumes after live audio")
		expect(
			jobStateLine(paused({ state: "failed", reason: "source-removed" }), opts),
		).toBe("Failed · source removed")
		expect(jobTone({ state: "paused" })).toBe("paused")
		expect(jobTone({ state: "holding" })).toBe("live")
		expect(formatWait(150_000)).toBe("3 min")
	})

	it("finds the held frequency", () => {
		const job = {
			id: "j1",
			progress: {
				holdingOn: "t1",
				probes: [{ trackId: "t1", targetHz: 146_962_500 }],
			},
		} as unknown as Pick<ScanJob, "id" | "progress">
		expect(heldFrequencyHz(job, undefined)).toBe(146_962_500)
		const noProbe = {
			id: "j1",
			progress: { holdingOn: "t9", probes: [] },
		} as unknown as Pick<ScanJob, "id" | "progress">
		expect(
			heldFrequencyHz(noProbe, "t9", [
				{ jobIds: ["j1"], frequencyHz: 1, peakDbfs: -50, active: true },
				{ jobIds: ["j1"], frequencyHz: 2, peakDbfs: -20, active: true },
				{ jobIds: ["x"], frequencyHz: 3, peakDbfs: 0, active: true },
			]),
		).toBe(2)
	})

	it("computes sweep progress", () => {
		expect(sweepProgress({ sweepIndex: 1, hopIndex: 6, hopCount: 44 })).toEqual(
			{
				pass: 2,
				hop: 7,
				hopCount: 44,
				fraction: 7 / 44,
				percent: 16,
				text: "Pass 2 · hop 7/44",
			},
		)
		expect(
			sweepProgress({ sweepIndex: 0, hopIndex: 0, hopCount: 0 }),
		).toMatchObject({ pass: 1, percent: 0, text: "Pass 1" })
	})

	it("says what a running scan is doing (WG12 phase)", () => {
		expect(scanPhaseText({})).toBeNull()
		expect(scanPhaseText({ phase: "settling" })).toBe("Settling")
		expect(
			scanPhaseText({
				phase: "holding",
				holding: { discoveryId: null, frequencyHz: 446_006_250, trackId: "t" },
			}),
		).toBe("Holding 446.00625")
		expect(
			scanPhaseText({
				phase: "trialing",
				trial: {
					protocol: "dmr",
					decoder: "dsd-fme",
					transport: "replay",
					discoveryId: null,
				},
			}),
		).toBe("Trying DMR from capture")
		expect(scanPhaseText({ phase: "replaying", replayQueueDepth: 3 })).toBe(
			"Replaying a capture · 2 queued",
		)
		expect(scanPhaseText({ phase: "watching" })).toBe("Watching")
	})

	it("never shows a heard trial as decoded", () => {
		expect(trialOutcomeText("heard")).toBe("Heard")
		expect(trialOutcomeText("carrier-only")).toBe("Carrier only")
	})
})
