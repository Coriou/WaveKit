import { afterEach, describe, expect, it, vi } from "vitest"
import type { DecoderInfo } from "@wavekit/api-types"

import { ApiError } from "../../src/data/api-client.ts"
import { CpuBudgetSchema } from "../../../src/decoders/enablement/cpu-budget.ts"
import {
	actionFor,
	BUDGET_MAX_CORES,
	onBand,
	parseVerdict,
	raisedBudget,
	scanHoldingDecoders,
	verdictsById,
	type BandVerdict,
} from "../../src/features/tuned/band-decoders.ts"
import { rowAction } from "../../src/features/tuned/band-table.ts"
import {
	DecoderVerdictsFeed,
	itemsFor,
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
		rangesHz: [{ minHz: 431_000_000, maxHz: 431_300_000 }],
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
const NO_SCAN = { scanJobId: null, budget: null }
const SCAN = { scanJobId: "job-1", budget: null }

describe("decoders on the tuned band", () => {
	it("takes targets within 200 kHz and band ranges, never scanner probes", () => {
		expect(onBand(ADSB, 1_090_150_000)).toBe(true)
		expect(onBand(ADSB, 1_090_250_000)).toBe(false)
		expect(onBand(ACARS, 131_600_000)).toBe(true)
		expect(onBand(PAGER, 431_200_000)).toBe(true)
		expect(onBand(PAGER, 431_600_000)).toBe(false)
		expect(onBand(PROBE, 1_090_000_000)).toBe(false)
	})

	it("reads the band assessment, not targets a channel following the tuner adds", () => {
		const vfo = decoder({
			id: "pager-vfo",
			type: "multimon-ng",
			targetFrequenciesHz: [1_090_062_000],
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
		})
		expect(onBand(vfo, 1_090_062_000)).toBe(false)
		const configured = decoder({
			id: "pager-cfg",
			type: "multimon-ng",
			targetFrequenciesHz: [1_090_062_000],
			bandAssessment: { verdict: "in-band", targetsHz: [466_000_000] },
		})
		expect(onBand(configured, 466_100_000)).toBe(true)
		expect(onBand(configured, 1_090_062_000)).toBe(false)
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
		expect(actionFor("pause-scanner", ADSB, SCAN)).toMatchObject({
			kind: "stop-scan",
			jobId: "job-1",
			label: "Stop the scan",
		})
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

	it("takes the first action it can carry out, never a Settings link in a row", () => {
		const v = verdict({
			code: "efficiency-cpu",
			text: "ADS-B paused: the CPU is busy",
			actions: ["pause-scanner", "turn-off-others"],
		})
		expect(rowAction(v, ADSB, NO_SCAN)).toBeNull()
		expect(rowAction(v, ADSB, SCAN)?.kind).toBe("stop-scan")
	})

	it("offers stopping the scan in every state where the sweep holds the decoders", () => {
		const job = (state: string, reason?: string) =>
			({ id: "job-1", state, ...(reason ? { reason } : {}) }) as Parameters<
				typeof scanHoldingDecoders
			>[0]
		for (const held of [
			job("starting"),
			job("running"),
			job("holding"),
			job("paused", "operator"),
			job("paused", "source-down"),
		])
			expect(scanHoldingDecoders(held)).toBe("job-1")
		for (const free of [
			null,
			job("pending"),
			job("paused", "preempted-operator"),
			job("paused", "preempted-relay"),
			job("paused", "preempted-job"),
			job("paused", "resume-blocked"),
			job("paused", "core-restart"),
			job("completed"),
			job("cancelled"),
			job("failed", "tuner-unavailable"),
		])
			expect(scanHoldingDecoders(free)).toBeNull()
		const busy = verdict({
			code: "scanner-busy",
			text: "ADS-B paused: the scanner holds the tuner",
			actions: ["pause-scanner"],
		})
		const scanId = scanHoldingDecoders(job("holding"))
		expect(
			rowAction(busy, ADSB, { scanJobId: scanId, budget: null }),
		).toMatchObject({ kind: "stop-scan", jobId: "job-1" })
	})

	it("skips the budget raise at the API's maximum and offers the next action", () => {
		const full = verdict({
			code: "efficiency-budget",
			text: "ADS-B paused: CPU budget full",
			actions: ["raise-budget", "turn-off-others", "pause-scanner"],
		})
		const at = (cores: number) => ({
			scanJobId: null,
			budget: { mode: "configured" as const, cores },
		})
		expect(rowAction(full, ADSB, at(4))?.kind).toBe("raise-budget")
		expect(rowAction(full, ADSB, NO_SCAN)?.kind).toBe("raise-budget")
		// at the cap: "turn off others" is a Settings link (the foot's), then the scan when one holds the tuner
		expect(rowAction(full, ADSB, at(BUDGET_MAX_CORES))).toBeNull()
		expect(
			rowAction(full, ADSB, { ...at(BUDGET_MAX_CORES), scanJobId: "job-1" })
				?.kind,
		).toBe("stop-scan")
		expect(
			rowAction(full, ADSB, {
				scanJobId: null,
				budget: { mode: "auto", cpus: 4, cores: 4 },
			}),
		).toBeNull()
	})

	it("offers no row action for a decoder off in Settings, whatever its older verdict", () => {
		const off = { ...ADSB, running: false, mode: "off" as const }
		const stale = parseVerdict({
			code: "failed",
			text: "ADS-B failed to run",
			actions: ["restart"],
		})
		expect(rowAction(stale!, off, SCAN)).toBeNull()
		const v = parseVerdict({
			code: "off",
			text: "ADS-B off in Settings",
			actions: ["turn-on"],
		})
		expect(rowAction(v!, off, NO_SCAN)).toBeNull()
	})

	it("never offers Restart or Start to a decoder that is starting, waiting or failing over", () => {
		for (const code of [
			"starting",
			"efficiency-waiting",
			"out-of-band",
			"listening",
		] as const)
			for (const a of ["restart", "start"] as const)
				expect(
					rowAction(verdict({ code, actions: [a] }), ADSB, NO_SCAN),
				).toBeNull()
		// the core drops the restart while it restarts the decoder on its own
		expect(
			rowAction(
				verdict({
					code: "failed",
					text: "ADS-B failed: restarting on its own",
				}),
				ADSB,
				NO_SCAN,
			),
		).toBeNull()
		expect(
			rowAction(
				verdict({ code: "failed", actions: ["restart"] }),
				ADSB,
				NO_SCAN,
			),
		).toMatchObject({ kind: "decoder", op: "restart" })
		expect(
			rowAction(
				verdict({ code: "stopped", actions: ["start"] }),
				ADSB,
				NO_SCAN,
			),
		).toMatchObject({ kind: "decoder", op: "start" })
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
		expect(rowAction(v!, ADSB, NO_SCAN)).toBeNull()
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
		expect(rowAction(v!, ADSB, NO_SCAN)).toMatchObject({ op: "start" })
		expect(rowAction(only!, ADSB, NO_SCAN)).toBeNull()
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
	it("adds exactly one core, up to the host's CPUs (auto) and the API's maximum", () => {
		expect(raisedBudget({ mode: "auto", cpus: 8, cores: 4 })).toBe(5)
		expect(raisedBudget({ mode: "auto", cpus: 4, cores: 4 })).toBeNull()
		expect(raisedBudget({ mode: "configured", cores: 1.5 })).toBe(2.5)
		expect(raisedBudget({ mode: "configured", cores: 1.1 })).toBe(2.1)
		expect(raisedBudget({ mode: "configured", cores: 0.75 })).toBe(1.75)
		expect(raisedBudget({ mode: "configured", cores: 63 })).toBe(64)
		expect(raisedBudget({ mode: "configured", cores: 63.5 })).toBe(64)
		expect(raisedBudget({ mode: "configured", cores: 64 })).toBeNull()
		expect(raisedBudget({ mode: "configured", cores: 70 })).toBeNull()
		expect(raisedBudget({ mode: "auto", cpus: 128, cores: 64 })).toBeNull()
	})

	it("caps at the bound the core's budget PUT accepts", () => {
		expect(CpuBudgetSchema.safeParse(BUDGET_MAX_CORES).success).toBe(true)
		expect(CpuBudgetSchema.safeParse(BUDGET_MAX_CORES + 0.01).success).toBe(
			false,
		)
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

	it("asks for the followed frequency and never shows another frequency's answer", async () => {
		const paths: string[] = []
		const get = vi.fn(async (path: string) => {
			paths.push(path)
			return [
				{
					id: "readsb",
					protocol: "readsb",
					verdict: { code: "decoding", text: "ADS-B decoding", actions: [] },
					coversHz: path.endsWith("=1090062000"),
				},
			]
		})
		const { data } = fakeData(get)
		const feed = new DecoderVerdictsFeed(data)
		feed.follow(1_090_062_000)
		const detach = feed.attach()
		await vi.waitFor(() => expect(feed.get().hz).toBe(1_090_062_000))
		expect(paths[0]).toBe("/api/decoders/summary?hz=1090062000")
		expect(itemsFor(feed.get(), 1_090_062_000)?.[0]?.coversHz).toBe(true)
		// a new frequency: nothing listed until its own answer arrives
		expect(itemsFor(feed.get(), 466_000_000)).toEqual([])
		feed.follow(466_000_000)
		await vi.waitFor(() => expect(feed.get().hz).toBe(466_000_000))
		expect(itemsFor(feed.get(), 466_000_000)?.[0]?.coversHz).toBe(false)
		// malformed frequencies ask without one
		feed.follow(Number.NaN)
		await vi.waitFor(() => expect(paths.at(-1)).toBe("/api/decoders/summary"))
		detach()
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
		// statuses only from now on
		expect(itemsFor(feed.get(), 1_090_000_000)).toBeNull()
		detach()
	})
})
