import { describe, expect, it } from "vitest"
import type { AccessState } from "../../src/data/index.ts"
import type {
	DecoderInfo,
	ExtendedSourceStatus,
	ResolvedBandPlanView,
	TunerState,
} from "@wavekit/api-types"
import { isReadOnly } from "../../src/app/context.ts"
import { connectionNotice } from "../../src/features/connection/notice.ts"
import {
	gainText,
	receiverSummary,
	sourceTitle,
} from "../../src/features/receiver/summary.ts"
import { decodersAt } from "../../src/features/tuned/decoders.ts"
import { decoderLabel, signalBars } from "../../src/features/tuned/signal.ts"
import { channelSuggestions } from "../../src/features/tuner/band.ts"
import { modulationOf } from "../../src/features/tuner/modes.ts"

const tuner = (over: Partial<TunerState> = {}): TunerState =>
	({
		sourceId: "pi-receiver",
		frequency: 161_500_000,
		sampleRate: 2_400_000,
		gainMode: "manual",
		gain: 297,
		agcMode: false,
		...over,
	}) as TunerState

describe("receiver summary", () => {
	it("shows gain in dB from tenths, or auto, or unknown", () => {
		expect(gainText(tuner())).toBe("29.7 dB")
		expect(gainText(tuner({ gainMode: "agc" }))).toBe("Auto gain")
		expect(gainText(tuner({ unknownFields: ["gain"] }))).toBe("Gain unknown")
	})

	it("summarises rate, gain and AGC in one line", () => {
		const source = {
			id: "pi-receiver",
			connected: true,
		} as ExtendedSourceStatus
		expect(receiverSummary(tuner(), source)).toBe("2.4 MS/s · 29.7 dB")
		expect(receiverSummary(tuner({ agcMode: true }), source)).toBe(
			"2.4 MS/s · 29.7 dB · AGC",
		)
		expect(receiverSummary(tuner(), { ...source, connected: false })).toBe(
			"Offline · 2.4 MS/s · 29.7 dB",
		)
		expect(receiverSummary(undefined, undefined)).toBe("No receiver")
		expect(sourceTitle(source, undefined)).toBe("Pi receiver")
	})
})

describe("tuned card helpers", () => {
	const dec = (id: string, targets: number[]) =>
		({
			id,
			type: id,
			running: true,
			targetFrequenciesHz: targets,
		}) as DecoderInfo
	it("finds decoders listening on the tuned channel, nearest first", () => {
		const list = [
			dec("ais", [161_975_000, 162_025_000]),
			dec("aprs", [144_800_000]),
			dec("none", []),
		]
		expect(decodersAt(list, 161_975_000, 6250).map(d => d.id)).toEqual(["ais"])
		expect(decodersAt(list, 161_980_000, 6250).map(d => d.id)).toEqual(["ais"])
		expect(decodersAt(list, 161_150_000, 6250)).toEqual([])
	})

	it("lights signal bars by SNR and names decoders", () => {
		expect([null, 0, 3, 10, 18, 25, 40].map(signalBars)).toEqual([
			0, 0, 1, 2, 3, 4, 5,
		])
		expect(decoderLabel("ais-catcher")).toBe("AIS")
		expect(decoderLabel("mystery")).toBe("mystery")
		expect(modulationOf("FM")).toBe("nfm")
		expect(modulationOf("am")).toBe("am")
		expect(modulationOf("dmr")).toBeNull()
	})

	it("suggests plan channels for typed names", () => {
		const view = {
			bands: [
				{
					key: "eu/marine",
					band: {
						name: "Marine VHF",
						group: "marine",
						channels: [
							{
								id: "c16",
								name: "ch 16",
								frequencyHz: 156_800_000,
								aliases: ["guard"],
								registryRef: null,
							},
							{
								id: "c6",
								name: "ch 6",
								frequencyHz: 156_300_000,
								aliases: [],
								registryRef: null,
							},
						],
					},
				},
				{
					key: "eu/pmr",
					band: {
						name: "PMR446",
						group: "personal-radio",
						channels: [
							{
								id: "p3",
								name: "PMR446 ch 3",
								frequencyHz: 446_031_250,
								aliases: ["pmr 3"],
								registryRef: null,
							},
						],
					},
				},
			],
		} as unknown as ResolvedBandPlanView
		expect(channelSuggestions(view, "ch 16").map(s => s.hz)).toEqual([
			156_800_000,
		])
		expect(channelSuggestions(view, "guard")[0]?.label).toBe("ch 16")
		expect(channelSuggestions(view, "pmr 3")[0]?.hz).toBe(446_031_250)
		expect(channelSuggestions(view, "ch").length).toBe(3)
		expect(channelSuggestions(view, "161.15")).toEqual([])
		expect(channelSuggestions(null, "ch 16")).toEqual([])
	})
})

describe("connection and access", () => {
	const legacy = { access: { mode: "legacy" } as AccessState, error: null }
	const protectedNoSession = {
		access: {
			mode: "protected",
			bootstrap: {
				access: {
					mode: "protected",
					sessionAvailable: false,
					pairingAvailable: true,
				},
			},
		} as unknown as AccessState,
		error: null,
	}
	it("is read-only on a protected core without a session", () => {
		expect(isReadOnly(legacy)).toBe(false)
		expect(isReadOnly(protectedNoSession)).toBe(true)
		expect(isReadOnly({ access: null, error: null })).toBe(false)
	})

	it("stays quiet while connected and says why otherwise", () => {
		expect(connectionNotice("open", legacy, false)).toBeNull()
		expect(connectionNotice("idle", legacy, false)).toBeNull()
		expect(connectionNotice("closed", legacy, false)?.title).toBe(
			"Reconnecting…",
		)
		expect(connectionNotice("connecting", legacy, false)?.title).toBe(
			"Connecting…",
		)
		expect(
			connectionNotice(
				"closed",
				{ access: null, error: "Network error" },
				false,
			)?.title,
		).toBe("Can’t reach the receiver")
		expect(connectionNotice("open", protectedNoSession, true)).toMatchObject({
			title: "Pair this browser",
			tone: "amber",
		})
	})
})
