import { afterEach, describe, expect, it, vi } from "vitest"
import type { DecoderInfo } from "@wavekit/api-types"

import { ApiError } from "../../src/data/api-client.ts"
import { CpuBudgetSchema } from "../../../src/decoders/enablement/cpu-budget.ts"
import {
	actionFor,
	BUDGET_MAX_CORES,
	onBand,
	parseVerdict,
	planRangesOf,
	raisedBudget,
	scanHoldingDecoders,
	verdictsById,
	type BandVerdict,
} from "../../src/features/tuned/band-decoders.ts"
import {
	bandTable,
	itemsFromStatus,
	rowAction,
} from "../../src/features/tuned/band-table.ts"
import { mockCoversHz } from "../../mock/decoder-summary.ts"
import { SCANNER_BANDPLANS } from "../../mock/data.ts"
import {
	DecoderVerdictsFeed,
	itemsFor,
	pendingFor,
	VERDICTS_FOLLOW_MS,
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

	it("reads the band assessment when it names a band, else the configured targets, as the core does", () => {
		// the core's decoderCoversHz: an assessment naming no band falls to the configured targets
		const vfo = decoder({
			id: "pager-vfo",
			type: "multimon-ng",
			targetFrequenciesHz: [1_090_062_000],
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
		})
		expect(onBand(vfo, 1_090_062_000)).toBe(true)
		expect(onBand(vfo, 466_100_000)).toBe(false)
		const configured = decoder({
			id: "pager-cfg",
			type: "multimon-ng",
			targetFrequenciesHz: [1_090_062_000],
			bandAssessment: { verdict: "in-band", targetsHz: [466_000_000] },
		})
		expect(onBand(configured, 466_100_000)).toBe(true)
		expect(onBand(configured, 1_090_062_000)).toBe(false)
	})

	it("never counts a configured target that only follows the tuner, as the core does", () => {
		// the repro: a pager's VFO channel on the tuned 1090 MHz centre, no assessed band
		const pager = decoder({
			id: "pager",
			type: "multimon-ng",
			targetFrequenciesHz: [1_090_062_000, 466_025_000],
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
			placements: [
				{
					sourceId: "synthetic",
					channelHz: 1_090_062_000,
					reach: "channel",
					origin: "vfo",
					primary: true,
					running: true,
					costCores: 0,
				},
				{
					sourceId: "synthetic",
					channelHz: 466_025_000,
					reach: "channel",
					origin: "bandplan",
					primary: false,
					running: true,
					costCores: 0,
				},
			],
		})
		expect(onBand(pager, 1_090_062_000)).toBe(false)
		expect(onBand(pager, 466_025_000)).toBe(true)
		const readsb = decoder({
			id: "readsb",
			type: "readsb",
			targetFrequenciesHz: [1_090_000_000],
			placements: [
				{
					sourceId: "synthetic",
					reach: "raw",
					origin: "configured",
					primary: true,
					running: true,
					costCores: 0,
				},
			],
		})
		expect(onBand(readsb, 1_090_000_000)).toBe(true)
	})

	it("covers a decoder with no band of its own where the band plan lists its protocols", () => {
		const pager = decoder({
			id: "pager",
			type: "multimon-ng",
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
		})
		const ranges = planRangesOf(SCANNER_BANDPLANS)
		expect(onBand(pager, 150_000_000, ranges)).toBe(true)
		expect(onBand(pager, 1_090_000_000, ranges)).toBe(false)
		// band plans not loaded yet: no claim
		expect(onBand(pager, 150_000_000, null)).toBe(false)
		// a type with a fixed band never reads the plan
		expect(
			onBand(decoder({ id: "readsb", type: "readsb" }), 150_000_000, ranges),
		).toBe(false)
		expect(onBand({ ...pager, ephemeral: true }, 150_000_000, ranges)).toBe(
			false,
		)
		// the mock's summary answers the same
		expect(mockCoversHz(pager, 150_000_000)).toBe(true)
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

	it("resumes the decoder's paused receiver, or opens the Receiver without a source", () => {
		const held = { ...ADSB, sourceId: "rtl-0" }
		expect(actionFor("resume-source", held, NO_SCAN)).toEqual({
			kind: "resume-source",
			sourceId: "rtl-0",
			label: "Resume",
			title: "Resume the receiver feed: the decoders start again",
		})
		expect(actionFor("resume-source", ADSB, NO_SCAN)?.kind).toBe("receiver")
		const v = parseVerdict({
			code: "source-paused",
			text: "ADS-B waiting: Receiver paused — Resume",
			actions: ["resume-source"],
		})
		expect(v).toEqual({
			code: "source-paused",
			text: "ADS-B waiting: Receiver paused — Resume",
			actions: ["resume-source"],
		})
		expect(rowAction(v!, held, NO_SCAN)?.kind).toBe("resume-source")
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

	it("reads a new frequency once the card rests on it VERDICTS_FOLLOW_MS", async () => {
		vi.useFakeTimers()
		expect(VERDICTS_FOLLOW_MS).toBe(150)
		const paths: string[] = []
		const get = vi.fn(async (path: string) => {
			paths.push(path)
			return [
				{
					id: "readsb",
					protocol: "readsb",
					verdict: { code: "decoding", text: "ADS-B decoding", actions: [] },
					coversHz: false,
				},
			]
		})
		const { data } = fakeData(get)
		const feed = new DecoderVerdictsFeed(data)
		const detach = feed.attach()
		await vi.advanceTimersByTimeAsync(0)
		expect(paths).toEqual(["/api/decoders/summary"])
		// a sweep of the dial: each step restarts the wait
		feed.follow(466_000_000)
		await vi.advanceTimersByTimeAsync(VERDICTS_FOLLOW_MS - 1)
		feed.follow(466_012_500)
		await vi.advanceTimersByTimeAsync(VERDICTS_FOLLOW_MS - 1)
		expect(paths).toHaveLength(1)
		expect(pendingFor(feed.get(), 466_012_500)).toBe(true)
		// at the bound: one read, for the frequency it rested on
		await vi.advanceTimersByTimeAsync(1)
		expect(paths).toEqual([
			"/api/decoders/summary",
			"/api/decoders/summary?hz=466012500",
		])
		expect(pendingFor(feed.get(), 466_012_500)).toBe(false)
		// past the bound nothing more is read
		await vi.advanceTimersByTimeAsync(VERDICTS_FOLLOW_MS * 2)
		expect(paths).toHaveLength(2)
		// a change pending at detach is never read
		feed.follow(433_920_000)
		detach()
		await vi.advanceTimersByTimeAsync(VERDICTS_FOLLOW_MS * 2)
		expect(paths).toHaveLength(2)
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

	it("reads statuses for a frequency whose read fails, and the core's answer once a read succeeds", async () => {
		const fail = (status: number) =>
			new ApiError({
				status,
				code: null,
				message: "Server error",
				body: null,
				method: "GET",
				path: "/api/decoders/summary",
			})
		const answer = [
			{
				id: "readsb",
				protocol: "readsb",
				verdict: { code: "decoding", text: "ADS-B decoding", actions: [] },
				coversHz: true,
			},
		]
		let next: () => Promise<unknown> = async () => {
			throw fail(500)
		}
		const get = vi.fn(async () => next())
		const { data } = fakeData(get)
		const feed = new DecoderVerdictsFeed(data)
		feed.follow(1_090_000_000)
		const detach = feed.attach()
		await vi.waitFor(() => expect(feed.get().failed).toBe(true))
		// not pending: the card falls back to statuses instead of "Checking…"
		expect(pendingFor(feed.get(), 1_090_000_000)).toBe(false)
		expect(itemsFor(feed.get(), 1_090_000_000)).toBeNull()
		// another frequency is still pending its own read
		expect(pendingFor(feed.get(), 466_000_000)).toBe(true)
		next = async () => answer
		await feed.load()
		expect(feed.get().failed).toBe(false)
		expect(itemsFor(feed.get(), 1_090_000_000)?.[0]?.id).toBe("readsb")
		// a later failure (401, a timeout) keeps the answer for the same frequency
		next = async () => {
			throw fail(401)
		}
		await feed.load()
		expect(itemsFor(feed.get(), 1_090_000_000)?.[0]?.id).toBe("readsb")
		next = async () => {
			throw new TypeError("network down")
		}
		await feed.load()
		expect(itemsFor(feed.get(), 1_090_000_000)?.[0]?.id).toBe("readsb")
		// a new frequency whose read fails reads statuses, never the old frequency's answer
		feed.follow(466_000_000)
		await vi.waitFor(() => expect(feed.get().hz).toBe(466_000_000))
		expect(itemsFor(feed.get(), 466_000_000)).toBeNull()
		expect(pendingFor(feed.get(), 466_000_000)).toBe(false)
		// still asked: a failure is not a core without the route
		const calls = get.mock.calls.length
		await feed.load()
		expect(get).toHaveBeenCalledTimes(calls + 1)
		detach()
	})

	it("keeps a pager without targets on the table at 150 MHz when the first read fails", async () => {
		const get = vi.fn(async () => {
			throw new TypeError("network down")
		})
		const { data } = fakeData(get)
		const feed = new DecoderVerdictsFeed(data)
		feed.follow(150_000_000)
		const detach = feed.attach()
		await vi.waitFor(() => expect(feed.get().failed).toBe(true))
		const items = itemsFor(feed.get(), 150_000_000)
		expect(items).toBeNull()
		const pager = decoder({
			id: "pager",
			type: "multimon-ng",
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
		})
		const ranges = planRangesOf(SCANNER_BANDPLANS)
		const rows = bandTable(items, [pager], 150_000_000, NO_SCAN, 0, ranges)
		expect(rows.map(r => [r.id, r.stateWord])).toEqual([["pager", "Listening"]])
		detach()
	})

	it("keeps a decoder whose assessment names no band on its configured targets when the first read fails", async () => {
		const get = vi.fn(async () => {
			throw new TypeError("network down")
		})
		const { data } = fakeData(get)
		const feed = new DecoderVerdictsFeed(data)
		feed.follow(466_050_000)
		const detach = feed.attach()
		await vi.waitFor(() => expect(feed.get().failed).toBe(true))
		const pager = decoder({
			id: "pager",
			type: "multimon-ng",
			targetFrequenciesHz: [466_025_000],
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
		})
		const items = itemsFor(feed.get(), 466_050_000)
		// band plans not loaded: the configured targets alone keep it there
		expect(
			bandTable(items, [pager], 466_050_000, NO_SCAN, 0, null).map(r => r.id),
		).toEqual(["pager"])
		expect(itemsFromStatus([pager])[0]?.coversHz).toBeNull()
		detach()
	})
})
