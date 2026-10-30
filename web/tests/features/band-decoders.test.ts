import { afterEach, describe, expect, it, vi } from "vitest"
import type { DecoderInfo } from "@wavekit/api-types"

import { ApiError } from "../../src/data/api-client.ts"
import {
	actionFor,
	bandDecoders,
	onBand,
	parseVerdict,
	primaryAction,
	raisedBudget,
	verdictsById,
	type BandVerdict,
} from "../../src/features/tuned/band-decoders.ts"
import {
	DecoderVerdictsFeed,
	VERDICTS_SETTLE_MS,
} from "../../src/features/tuned/verdicts.ts"

const decoder = (over: Partial<DecoderInfo> & { id: string }): DecoderInfo => ({
	type: over.id,
	running: true,
	health: "running",
	uptime: 10,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
	suspended: false,
	...over,
})

const ADSB = decoder({
	id: "readsb",
	type: "readsb",
	targetFrequenciesHz: [1_090_000_000],
})
const ACARS = decoder({
	id: "acarsdec",
	type: "acarsdec",
	targetFrequenciesHz: [131_525_000, 131_725_000],
})
const PAGER = decoder({
	id: "pager",
	type: "multimon-ng",
	running: false,
	suspended: true,
	bandAssessment: {
		verdict: "out-of-band",
		rangesHz: [{ minHz: 466_000_000, maxHz: 466_300_000 }],
	},
})
const PROBE = decoder({
	id: "probe-1",
	type: "readsb",
	owner: "scanner",
	targetFrequenciesHz: [1_090_000_000],
})

const verdict = (over: Partial<BandVerdict> = {}): BandVerdict => ({
	code: "decoding",
	text: "ADS-B decoding",
	actions: [],
	...over,
})
const NO_SCAN = { scanJobId: null }

describe("decoders on the tuned band", () => {
	it("takes targets within 200 kHz and band ranges, never scanner probes", () => {
		expect(onBand(ADSB, 1_090_150_000)).toBe(true)
		expect(onBand(ADSB, 1_090_250_000)).toBe(false)
		expect(onBand(ACARS, 131_600_000)).toBe(true)
		expect(onBand(PAGER, 466_200_000)).toBe(true)
		expect(onBand(PAGER, 466_600_000)).toBe(false)
		expect(onBand(PROBE, 1_090_000_000)).toBe(false)
	})

	it("lists only the tuned band's decoders, listening ones first", () => {
		const other = decoder({
			id: "readsb-2",
			type: "readsb",
			targetFrequenciesHz: [1_090_100_000],
		})
		const verdicts = new Map([
			[
				"readsb",
				verdict({
					code: "efficiency-budget",
					text: "ADS-B paused: CPU budget full",
					actions: ["raise-budget", "turn-off-others"],
				}),
			],
			["readsb-2", verdict({ code: "listening", text: "ADS-B listening" })],
		])
		const rows = bandDecoders(
			[ACARS, ADSB, other, PAGER, PROBE],
			verdicts,
			1_090_000_000,
			NO_SCAN,
		)
		expect(rows.map(r => r.id)).toEqual(["readsb-2", "readsb"])
		expect(rows[0]).toMatchObject({
			listening: true,
			text: "ADS-B listening",
			action: null,
		})
		expect(rows[1]).toMatchObject({
			listening: false,
			text: "ADS-B paused: CPU budget full",
			action: { kind: "raise-budget", label: "Raise CPU budget" },
		})
	})

	it("reads statuses without verdicts (an older core) and offers no action", () => {
		const rows = bandDecoders([PAGER], null, 466_100_000, NO_SCAN)
		expect(rows).toEqual([
			{
				id: "pager",
				name: "Pager",
				listening: false,
				text: "Pager paused",
				action: null,
			},
		])
	})
})

describe("verdict line and action", () => {
	it("maps each action to a call, a tune, or a link", () => {
		expect(actionFor("start", ADSB, NO_SCAN)).toMatchObject({
			kind: "decoder",
			op: "start",
		})
		expect(actionFor("restart", ADSB, NO_SCAN)).toMatchObject({
			kind: "decoder",
			op: "restart",
		})
		expect(actionFor("tune-to-band", ADSB, NO_SCAN)).toMatchObject({
			kind: "tune",
			hz: 1_090_000_000,
			label: "Tune to 1090.000",
		})
		expect(actionFor("tune-to-band", PAGER, NO_SCAN)).toBeNull()
		expect(actionFor("pause-scanner", ADSB, NO_SCAN)).toBeNull()
		expect(
			actionFor("pause-scanner", ADSB, { scanJobId: "job-1" }),
		).toMatchObject({ kind: "pause-scan", jobId: "job-1" })
		for (const a of ["install-decoder", "enable-channelizer"] as const)
			expect(actionFor(a, ADSB, NO_SCAN)).toMatchObject({
				kind: "settings",
				settingId: "dec.readsb",
			})
		for (const a of [
			"raise-sample-rate",
			"lower-sample-rate",
			"change-sample-rate",
			"check-source",
		] as const)
			expect(actionFor(a, ADSB, NO_SCAN)?.kind).toBe("receiver")
	})

	it("takes the first action it can carry out", () => {
		const v = verdict({
			code: "efficiency-cpu",
			text: "ADS-B paused: the CPU is busy",
			actions: ["pause-scanner", "turn-off-others"],
		})
		expect(primaryAction(v, ADSB, NO_SCAN)).toMatchObject({
			kind: "settings",
			label: "Decoders in Settings",
		})
		expect(primaryAction(v, ADSB, { scanJobId: "job-1" })?.kind).toBe(
			"pause-scan",
		)
	})

	it("shows a decoder off in Settings as off, with a link to Settings, not a start button", () => {
		const v = parseVerdict({
			code: "off",
			text: "ADS-B off in Settings",
			actions: ["turn-on"],
		})
		expect(v).not.toBeNull()
		const [row] = bandDecoders(
			[{ ...ADSB, running: false, mode: "off" }],
			new Map([["readsb", v!]]),
			1_090_000_000,
			NO_SCAN,
		)
		expect(row).toMatchObject({
			listening: false,
			text: "ADS-B off in Settings",
			action: {
				kind: "settings",
				settingId: "dec.readsb",
				label: "Turn on in Settings",
			},
		})
	})
})

describe("unknown verdicts", () => {
	it("keeps the text of an unknown code with no action", () => {
		const v = parseVerdict({
			code: "warp-drive",
			text: "ADS-B waits for something new",
			actions: ["start"],
		})
		expect(v).toEqual({
			code: "unknown",
			text: "ADS-B waits for something new",
			actions: [],
		})
		expect(primaryAction(v!, ADSB, NO_SCAN)).toBeNull()
	})

	it("drops unknown actions and falls back to plain text when none is left", () => {
		const v = parseVerdict({
			code: "stopped",
			text: "ADS-B stopped",
			actions: ["reticulate", "start"],
		})
		expect(v?.actions).toEqual(["start"])
		const only = parseVerdict({
			code: "stopped",
			text: "ADS-B stopped",
			actions: ["reticulate"],
		})
		expect(primaryAction(only!, ADSB, NO_SCAN)).toBeNull()
	})

	it("ignores items without a usable verdict", () => {
		expect(parseVerdict(null)).toBeNull()
		expect(parseVerdict({ code: "decoding", text: " " })).toBeNull()
		const byId = verdictsById([
			{ id: "a", verdict: { code: "decoding", text: "ISM decoding" } },
			{ id: "b" },
			{ verdict: { code: "decoding", text: "x" } },
		])
		expect([...byId.keys()]).toEqual(["a"])
		expect(verdictsById({ not: "a list" }).size).toBe(0)
	})
})

describe("raise the CPU budget by one core", () => {
	it("adds a core up to the host's CPUs or 64", () => {
		expect(raisedBudget({ mode: "auto", cpus: 8, cores: 4 })).toBe(5)
		expect(raisedBudget({ mode: "auto", cpus: 4, cores: 4 })).toBeNull()
		expect(raisedBudget({ mode: "configured", cores: 1.5 })).toBe(2)
		expect(raisedBudget({ mode: "configured", cores: 64 })).toBeNull()
	})
})

describe("verdicts feed", () => {
	afterEach(() => vi.useRealTimers())

	const fakeData = (get: (path: string) => Promise<unknown>) => {
		const handlers = new Map<string, () => void>()
		return {
			handlers,
			data: {
				api: { get },
				events: {
					subscribe: () => () => undefined,
					on: (type: string, fn: () => void) => {
						handlers.set(type, fn)
						return () => handlers.delete(type)
					},
					onReconnected: () => () => undefined,
				},
			} as unknown as ConstructorParameters<typeof DecoderVerdictsFeed>[0],
		}
	}

	it("reads the summary on attach and after a decoder status", async () => {
		vi.useFakeTimers()
		let text = "ADS-B listening: nothing decoded in the last minute"
		const get = vi.fn(async () => [
			{ id: "readsb", verdict: { code: "listening", text, actions: [] } },
		])
		const { data, handlers } = fakeData(get)
		const feed = new DecoderVerdictsFeed(data)
		const detach = feed.attach()
		await vi.waitFor(() => expect(feed.get().verdicts?.size).toBe(1))
		text = "ADS-B decoding"
		handlers.get("decoder:status")?.()
		await vi.advanceTimersByTimeAsync(VERDICTS_SETTLE_MS)
		expect(feed.get().verdicts?.get("readsb")?.text).toBe("ADS-B decoding")
		expect(get).toHaveBeenCalledWith("/api/decoders/summary")
		detach()
		expect(handlers.size).toBe(0)
	})

	it("stops asking a core without the summary route", async () => {
		const get = vi.fn(async () => {
			throw new ApiError({
				status: 404,
				code: null,
				message: "Not found",
				body: null,
				method: "GET",
				path: "/api/decoders/summary",
			})
		})
		const { data } = fakeData(get)
		const feed = new DecoderVerdictsFeed(data)
		const detach = feed.attach()
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
		await feed.load()
		expect(get).toHaveBeenCalledTimes(1)
		expect(feed.get().verdicts).toBeNull()
		detach()
	})
})
