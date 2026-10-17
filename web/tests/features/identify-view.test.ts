import { describe, expect, it } from "vitest"
import type {
	ScanJob,
	ScannerIdentifyEventData,
	ScannerIdentifyResult,
	ScannerIdentifyTrial,
} from "@wavekit/api-types"
import type { IdentifyState } from "../../src/data/index.ts"
import {
	identifyView,
	measuredLine,
	resultDetails,
	trialRow,
} from "../../src/features/tuned/identify-view.ts"

const T0 = Date.parse("2026-10-16T12:00:00.000Z")
const HZ = 167_512_500

const job = {
	id: "j1",
	createdAt: "2026-10-16T12:00:00.000Z",
	startedAt: "2026-10-16T12:00:00.000Z",
	identify: { timeoutMs: 15_000 },
} as unknown as ScanJob

const trial = (
	protocol: ScannerIdentifyTrial["protocol"],
	outcome: ScannerIdentifyTrial["outcome"],
	extra: Partial<ScannerIdentifyTrial> = {},
): ScannerIdentifyTrial => ({
	protocol,
	decoder: "dsd-fme",
	mode: "auto",
	transport: "offset",
	outcome,
	...extra,
})

const result = (
	over: Partial<ScannerIdentifyResult> = {},
): ScannerIdentifyResult => ({
	confidence: "candidate",
	metadata: {
		talkgroups: [],
		sources: [],
		slots: [],
		callsigns: [],
		capcodes: [],
		ismModels: [],
	},
	measurements: {
		source: "track",
		centreHz: HZ,
		obwHz: 6250,
		peakDbfs: -62,
		snrDb: 18,
		floorDbfs: -80,
		dutyCycle: 0.4,
		class: "fsk4-6k25",
	},
	...over,
})

const state = (
	event: Partial<ScannerIdentifyEventData> | null,
	over: Partial<IdentifyState> = {},
): IdentifyState => ({
	targetHz: HZ,
	job,
	event:
		event === null
			? null
			: {
					jobId: "j1",
					targetHz: HZ,
					state: "waiting-for-signal",
					trials: [],
					...event,
				},
	starting: false,
	error: null,
	errorCode: null,
	...over,
})

const IDLE: IdentifyState = {
	targetHz: null,
	job: null,
	event: null,
	starting: false,
	error: null,
	errorCode: null,
}

describe("identifyView", () => {
	it("is idle before identify starts", () => {
		expect(identifyView(IDLE, T0)).toMatchObject({
			phase: "idle",
			running: false,
			title: "",
		})
	})

	it("shows starting while the POST is in flight", () => {
		expect(
			identifyView({ ...IDLE, targetHz: HZ, starting: true }, T0),
		).toMatchObject({ phase: "starting", running: true })
	})

	it("waits for a transmission with a countdown to the timeout", () => {
		const v = identifyView(state({ state: "waiting-for-signal" }), T0 + 3200)
		expect(v).toMatchObject({
			phase: "waiting",
			running: true,
			title: "Waiting for a transmission",
			secs: " · 12 s",
		})
		expect(v.bar).toEqual({
			fraction: (15_000 - 3200) / 15_000,
			leftS: 12,
			windowS: 15,
		})
		expect(v.trials).toEqual([])
		expect(
			identifyView(state({ state: "waiting-for-signal" }), T0 + 60_000).bar
				?.leftS,
		).toBe(0)
	})

	it("treats a job without progress yet as waiting", () => {
		expect(identifyView(state(null), T0).phase).toBe("waiting")
	})

	it("lists one row per decoder while trying, counting the current one", () => {
		const v = identifyView(
			state({
				state: "trying",
				trials: [
					trial("dmr", "no-sync"),
					trial("p25p1", "running"),
					trial("nxdn48", "pending"),
					trial("pocsag", "pending", { decoder: "multimon-ng" }),
				],
				result: result(),
			}),
			T0 + 5000,
		)
		expect(v).toMatchObject({
			phase: "trying",
			title: "Trying decoders",
			secs: " · 2 of 4",
			running: true,
		})
		expect(v.trials.map(r => [r.protocol, r.word, r.tone])).toEqual([
			["DMR", "No sync", "fail"],
			["P25", "Trying", "busy"],
			["NXDN", "Queued", "queued"],
			["POCSAG", "Queued", "queued"],
		])
		expect(v.measured).toBe(
			"6.25 kHz wide · SNR 18 dB · peak −62 dBFS · 40 % duty",
		)
		expect(v.bar).not.toBeNull()
	})

	it("answers identified with the protocol and identity", () => {
		const v = identifyView(
			state({
				state: "identified",
				trials: [
					trial("pocsag", "no-sync", { decoder: "multimon-ng" }),
					trial("p25p1", "crc-errors"),
					trial("dmr", "decoded"),
				],
				result: result({
					protocol: "dmr",
					confidence: "decoded",
					identity: { kind: "dmr-cc", value: "1" },
					discoveryId: "d1",
					metadata: {
						talkgroups: ["2081"],
						sources: ["2081107"],
						slots: [1],
						callsigns: [],
						capcodes: [],
						ismModels: [],
					},
				}),
			}),
			T0 + 9000,
		)
		expect(v).toMatchObject({
			phase: "identified",
			title: "DMR",
			big: true,
			running: false,
			bar: null,
			note: "Added to discoveries",
		})
		expect(v.line).toBe("CC 1 · TG 2081 · radio 2081107")
		expect(v.trials.map(r => r.tone)).toEqual(["fail", "fail", "ok"])
	})

	it("answers a candidate as Maybe, with the telling failure as its tag", () => {
		const v = identifyView(
			state({
				state: "candidate",
				trials: [
					trial("dmr", "no-sync"),
					trial("p25p1", "crc-errors"),
					trial("analog-fm", "unsupported", {
						decoder: null,
						mode: null,
						transport: null,
						reason: "needs-channelizer",
					}),
				],
				result: result({ protocol: "nxdn48" }),
			}),
			T0 + 15_000,
		)
		expect(v).toMatchObject({
			phase: "candidate",
			title: "Maybe NXDN",
			big: true,
			reason: "CRC errors",
			running: false,
		})
		expect(v.line).toBe("Looks like 4FSK 6.25 kHz · no decoder synced")
		expect(v.trials[2]).toMatchObject({
			word: "Not available yet",
			tag: true,
			decoder: "no decoder",
		})
		expect(v.trials[2]?.title).toMatch(/needs the channelizer/)
	})

	it("says Maybe alone when no protocol is guessed, with the CTCSS tone when heard", () => {
		const v = identifyView(
			state({
				state: "candidate",
				trials: [],
				result: result({
					protocol: "unknown",
					measurements: { ...result().measurements, class: "analog-fm" },
					metadata: { ...result().metadata, ctcssHz: 88.5 },
				}),
			}),
			T0,
		)
		expect(v.title).toBe("Maybe")
		expect(v.line).toBe("Looks like analog FM · CTCSS 88.5 Hz")
		expect(v.reason).toBe("")
	})

	it("answers unidentified, keeping what was measured", () => {
		const v = identifyView(
			state({
				state: "unidentified",
				trials: [trial("dmr", "no-sync"), trial("p25p1", "timeout")],
				result: result({
					confidence: "activity",
					measurements: {
						...result().measurements,
						class: "carrier",
						dutyCycle: 1,
					},
				}),
			}),
			T0 + 15_000,
		)
		expect(v).toMatchObject({
			phase: "unidentified",
			title: "Not identified",
			big: true,
		})
		expect(v.line).toBe(
			"Looks like a steady carrier. No decoder synced in 15 s.",
		)
		expect(v.measured).toMatch(/steady$/)
	})

	it("answers an artefact at once from the receiver's settings", () => {
		const v = identifyView(
			state({ state: "unidentified", result: result({ artefact: "dc" }) }),
			T0,
		)
		expect(v).toMatchObject({
			phase: "artefact",
			title: "This is the receiver’s own centre spike",
		})
	})

	it("says when the receiver moved away mid-run", () => {
		const v = identifyView(
			state({
				state: "unidentified",
				trials: [
					trial("dmr", "no-sync"),
					trial("p25p1", "cancelled"),
					trial("nxdn48", "pending"),
				],
				result: result({ ended: "window-moved" }),
			}),
			T0 + 4000,
		)
		expect(v).toMatchObject({
			phase: "interrupted",
			title: "Stopped · you tuned away",
		})
		expect(v.line).toBe(
			"Tried 2 of 3 decoders before the receiver moved. Nothing was kept.",
		)
		expect(v.trials.map(r => r.word)).toEqual(["No sync", "Stopped"])
	})

	it("explains a refused start", () => {
		expect(
			identifyView(
				{
					...IDLE,
					targetHz: HZ,
					error: "The target is outside the tuned window; tune first",
					errorCode: "OUT_OF_WINDOW",
				},
				T0,
			),
		).toMatchObject({
			phase: "error",
			title: "Could not identify",
			line: "This frequency is outside the receiver’s window. Tune to it first.",
		})
		expect(
			identifyView(
				{ ...IDLE, targetHz: HZ, error: "boom", errorCode: null },
				T0,
			).line,
		).toBe("boom")
	})

	it("covers every outcome word", () => {
		const outcomes: ScannerIdentifyTrial["outcome"][] = [
			"pending",
			"running",
			"decoded",
			"no-sync",
			"crc-errors",
			"timeout",
			"skipped-budget",
			"unsupported",
			"not-needed",
			"cancelled",
		]
		expect(outcomes.map(o => trialRow(trial("dmr", o), 0).word)).toEqual([
			"Queued",
			"Trying",
			"Decoded",
			"No sync",
			"CRC errors",
			"Timed out",
			"Skipped (busy)",
			"Not available yet",
			"Not needed",
			"Stopped",
		])
	})

	it("names WG7 ambient trials and identities (AIS, ACARS, VDL2, LoRa)", () => {
		const ais = trialRow(
			trial("ais", "decoded", {
				decoder: "ais-catcher",
				transport: "ambient",
				mode: null,
			}),
			0,
		)
		expect(ais.protocol).toBe("AIS")
		expect(ais.decoder).toBe("running ais-catcher")
		expect(ais.title).toBe("AIS with running ais-catcher: Decoded")
		const none = trialRow(
			trial("lora", "unsupported", {
				decoder: null,
				transport: null,
				mode: null,
				reason: "no-ambient-decoder",
			}),
			1,
		)
		expect(none.protocol).toBe("LoRa")
		expect(none.title).toBe(
			"LoRa with no decoder: Not available yet (no decoder running here)",
		)
		expect(trialRow(trial("acars", "timeout"), 2).protocol).toBe("ACARS")
		expect(trialRow(trial("vdl2", "no-sync"), 3).protocol).toBe("VDL2")
		expect(
			resultDetails(
				result({ identity: { kind: "ais-mmsi", value: "227006760" } }),
			),
		).toBe("MMSI 227006760")
		expect(
			resultDetails(
				result({ identity: { kind: "acars-reg", value: "F-GKXA" } }),
			),
		).toBe("F-GKXA")
		expect(
			resultDetails(
				result({ identity: { kind: "lora-node", value: "!a1b2c3d4" } }),
			),
		).toBe("node !a1b2c3d4")
	})

	it("formats measurements and details defensively", () => {
		expect(
			measuredLine({
				source: "spectrum",
				centreHz: HZ,
				obwHz: null,
				peakDbfs: null,
				snrDb: null,
				floorDbfs: null,
				dutyCycle: null,
				class: "unknown",
			}),
		).toBeNull()
		expect(
			resultDetails(
				result({ identity: { kind: "pocsag-capcode", value: "1234567" } }),
			),
		).toBe("capcode 1234567")
	})
})
