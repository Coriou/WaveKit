import { describe, it, expect } from "vitest"
import {
	guardScan,
	guardSpectrumFrame,
	guardSpectrumProfile,
	parseScanEvent,
} from "../../../cli/source/data/scanner-guards.js"
import { parseServerMessage } from "../../../cli/source/data/guards.js"
import {
	SCAN_FRAME,
	SCAN_PROFILE,
	SCAN_JOB,
	SCAN_DISCOVERY,
	SCAN_STATUS,
} from "../../../cli/source/test/fixtures.js"

describe("S1 boundary guards", () => {
	it("accepts merged wire contracts and preserves unknown RF as null", () => {
		expect(guardSpectrumFrame(SCAN_FRAME)).toEqual(SCAN_FRAME)
		expect(guardSpectrumProfile(SCAN_PROFILE)).toEqual(SCAN_PROFILE)
		expect(
			guardScan("job", SCAN_JOB)?.identify?.targets[0]?.result?.measurements
				.peakDbfs,
		).toBeNull()
		expect(guardScan("discovery", SCAN_DISCOVERY)?.metadata.slots).toEqual([1])
		expect(guardScan("status", SCAN_STATUS)?.enabled).toBe(true)
	})
	it.each([
		{ bins: "%%%" },
		{ binCount: 255 },
		{ nativeBinHz: Infinity },
		{ binHz: 0 },
		{ binCount: 2049 },
		{ startHz: -Infinity },
		{ centerHz: NaN },
		{ sampleRateHz: 0 },
		{ nativeBinHz: 0 },
		{ masks: { ...SCAN_FRAME.masks, dcGuardHz: -1 } },
		{
			masks: { ...SCAN_FRAME.masks, spurRanges: [{ startHz: -1, endHz: -2 }] },
		},
		{
			tracks: [
				{
					startHz: -1,
					endHz: -2,
					flags: { burst: false, iqImage: false, edge: false },
				},
			],
		},
		{ epoch: -1 },
		{ at: "never" },
		{ profile: "5:128" },
	])("rejects malformed frame %j before decoding", patch => {
		expect(guardSpectrumFrame({ ...SCAN_FRAME, ...patch })).toBeUndefined()
	})
	it("requires correct channel and bounded nested arrays", () => {
		expect(
			parseServerMessage({
				type: "spectrum:frame",
				channel: "scanner",
				data: SCAN_FRAME,
			}),
		).toBeUndefined()
		expect(
			guardScan("discoveries", {
				items: Array.from({ length: 51 }, () => SCAN_DISCOVERY),
				nextCursor: null,
			}),
		).toBeUndefined()
		expect(
			guardScan("job", { ...SCAN_JOB, name: "x".repeat(513) }),
		).toBeUndefined()
	})
	it("invalidates keyed discoveries including delete/merge, not durable append", () => {
		for (const change of ["deleted", "merged"])
			expect(
				parseScanEvent("scanner:discovery", {
					change,
					discovery: SCAN_DISCOVERY,
				}),
			).toEqual({ type: "scanner:invalidate", key: "discovery:disc1" })
		expect(
			parseScanEvent("scanner:progress", {
				jobId: "job1",
				state: "running",
				sweepIndex: 1,
				hopIndex: 2,
				hopCount: 4,
				centerHz: 1,
				coverage: 0.5,
				probes: [],
			}),
		).toBeUndefined()
	})
})

describe("Scan collection preflight", () => {
	function observed(length: number, value: unknown) {
		let reads = 0
		const values = Array.from({ length }, () => value)
		Object.defineProperty(values, 0, {
			get: () => {
				reads++
				return value
			},
			configurable: true,
		})
		return { values, reads: () => reads }
	}
	it("rejects oversized frame tracks and RF masks before accessing elements; accepts maxima", () => {
		const track = {
			startHz: 1,
			endHz: 2,
			flags: { burst: false, iqImage: false, edge: false },
		}
		for (const [key, maximum, value] of [
			["tracks", 256, track],
			["spurRanges", 128, { startHz: 1, endHz: 2 }],
		] as const) {
			const oversized = observed(maximum + 1, value)
			const wire =
				key === "tracks"
					? { ...SCAN_FRAME, tracks: oversized.values }
					: {
							...SCAN_FRAME,
							masks: { ...SCAN_FRAME.masks, spurRanges: oversized.values },
						}
			expect(guardSpectrumFrame(wire)).toBeUndefined()
			expect(oversized.reads()).toBe(0)
			const legal = observed(maximum, value)
			const valid =
				key === "tracks"
					? { ...SCAN_FRAME, tracks: legal.values }
					: {
							...SCAN_FRAME,
							masks: { ...SCAN_FRAME.masks, spurRanges: legal.values },
						}
			expect(guardSpectrumFrame(valid)).toBeDefined()
			expect(legal.reads()).toBeGreaterThan(0)
		}
	})
	it("rejects oversized top-level jobs and nested identify/result metadata before element parsing", () => {
		const jobs = observed(10001, SCAN_JOB)
		expect(guardScan("jobs", jobs.values)).toBeUndefined()
		expect(jobs.reads()).toBe(0)
		expect(
			guardScan(
				"jobs",
				Array.from({ length: 10000 }, () => ({
					...SCAN_JOB,
					identify: undefined,
				})),
			),
		).toHaveLength(10000)
		const target = SCAN_JOB.identify!.targets[0]!
		for (const [maximum, patch] of [
			[
				256,
				(values: unknown[]) => ({ ...SCAN_JOB, identify: { targets: values } }),
			],
			[
				128,
				(values: unknown[]) => ({
					...SCAN_JOB,
					identify: { targets: [{ ...target, trials: values }] },
				}),
			],
			[
				64,
				(values: unknown[]) => ({
					...SCAN_JOB,
					identify: {
						targets: [
							{
								...target,
								result: {
									...target.result!,
									metadata: { ...target.result!.metadata, talkgroups: values },
								},
							},
						],
					},
				}),
			],
		] as const) {
			const value =
				maximum === 256 ? target : maximum === 128 ? target.trials[0]! : "123"
			const oversized = observed(maximum + 1, value)
			expect(guardScan("job", patch(oversized.values))).toBeUndefined()
			expect(oversized.reads()).toBe(0)
			const legal = observed(maximum, value)
			expect(guardScan("job", patch(legal.values))).toBeDefined()
			expect(legal.reads()).toBeGreaterThan(0)
		}
	})
})

it.each([0, 10000])(
	"accepts producer-shaped signed Spectrum coordinates at centre%s without loosening scanner RF constraints",
	centerHz => {
		const frame = {
			...SCAN_FRAME,
			centerHz,
			tuningTrust: "unverified",
			sampleRateHz: 2048000,
			startHz: centerHz - 819500,
			binHz: 4000,
			binCount: 410,
			bins: Buffer.from(new Uint8Array(410).fill(70)).toString("base64"),
			tracks: [
				{
					startHz: -50500,
					endHz: -40500,
					flags: { burst: false, iqImage: false, edge: false },
				},
			],
			masks: {
				dcHz: centerHz,
				dcGuardHz: 1500,
				spurRanges: [{ startHz: -30500, endHz: -20500 }],
			},
		}
		expect(guardSpectrumFrame(frame)).toEqual(frame)
		expect(
			guardSpectrumFrame({
				...frame,
				centerHz: -10000,
				masks: { ...frame.masks, dcHz: -10000 },
			}),
		).toBeDefined()
		expect(
			guardScan("discovery", { ...SCAN_DISCOVERY, frequencyHz: -1 }),
		).toBeUndefined()
		const job = structuredClone(SCAN_JOB)
		job.identify!.targets[0]!.targetHz = -1
		expect(guardScan("job", job)).toBeUndefined()
	},
)

describe("strict identify attribution projection", () => {
	const request = {
		sourceId: "rtl",
		target: { frequencyHz: 446056250, bandwidthHz: 12500 },
		timeoutMs: 15000,
		exhaustive: false,
		record: false,
	} as const
	const wire = () => ({
		...SCAN_JOB,
		identify: {
			...SCAN_JOB.identify!,
			target: { ...request.target },
			timeoutMs: 15000,
			protocols: [],
			exhaustive: false,
			record: false,
		},
	})
	it("keeps old jobs inspectable without fabricating normalized request fields", async () => {
		const { guardIdentifyJob } =
			await import("../../../cli/source/data/scanner-guards.js")
		expect(guardScan("job", SCAN_JOB)).toBeDefined()
		expect(guardIdentifyJob(SCAN_JOB, request)).toBeUndefined()
		expect(guardIdentifyJob(wire(), request)?.identify).toMatchObject({
			target: request.target,
			protocols: [],
			record: false,
		})
	})
	it("requires all normalized settings and exact source/request, while allowing nearby resolved target", async () => {
		const { guardIdentifyJob } =
			await import("../../../cli/source/data/scanner-guards.js")
		for (const key of [
			"target",
			"timeoutMs",
			"protocols",
			"exhaustive",
			"record",
		] as const) {
			const identify: Record<string, unknown> = { ...wire().identify }
			delete identify[key]
			expect(guardIdentifyJob({ ...wire(), identify }, request)).toBeUndefined()
		}
		for (const patch of [
			{ protocols: ["dmr"] },
			{ record: true },
			{ exhaustive: true },
			{ timeoutMs: 15001 },
			{ target: { ...request.target, bandwidthHz: 12501 } },
			{ target: { ...request.target, frequencyHz: 1 } },
			{ targets: [{ ...SCAN_JOB.identify!.targets[0]!, jobId: "other" }] },
		])
			expect(
				guardIdentifyJob(
					{ ...wire(), identify: { ...wire().identify, ...patch } },
					request,
				),
			).toBeUndefined()
		expect(
			guardIdentifyJob(
				{ ...wire(), spec: { ...SCAN_JOB.spec, sourceId: "other" } },
				request,
			),
		).toBeUndefined()
		expect(
			guardIdentifyJob(wire(), request)?.identify?.targets[0]?.targetHz,
		).toBe(446000000)
	})
	it("preserves lockout without inventing one for old discoveries", () => {
		expect(guardScan("discovery", SCAN_DISCOVERY)?.operator).toBeUndefined()
		expect(
			guardScan("discovery", {
				...SCAN_DISCOVERY,
				operator: { lockout: true, notes: "private" },
			})?.operator,
		).toEqual({ lockout: true })
	})
	it("preserves candidate/identified and nullable RF plus all authoritative trial outcomes", () => {
		for (const outcome of [
			"unsupported",
			"skipped-budget",
			"not-needed",
			"cancelled",
		])
			for (const state of ["candidate", "identified", "unidentified"]) {
				const target = SCAN_JOB.identify!.targets[0]!
				const parsed = guardScan("job", {
					...wire(),
					identify: {
						...wire().identify,
						targets: [
							{
								...target,
								state,
								trials: [{ ...target.trials[0]!, outcome }],
								result: { ...target.result!, ended: "window-moved" },
							},
						],
					},
				})
				expect(parsed?.identify?.targets[0]?.state).toBe(state)
				expect(parsed?.identify?.targets[0]?.trials[0]?.outcome).toBe(outcome)
				expect(
					parsed?.identify?.targets[0]?.result?.measurements.obwHz,
				).toBeNull()
				expect(parsed?.identify?.targets[0]?.result?.ended).toBe("window-moved")
			}
	})

	it("accepts WG7 ambient trials (AIS/ACARS/VDL2/LoRa decoded by a running decoder)", () => {
		const target = SCAN_JOB.identify!.targets[0]!
		const parsed = guardScan("job", {
			...wire(),
			identify: {
				...wire().identify,
				targets: [
					{
						...target,
						state: "identified",
						trials: [
							{
								...target.trials[0]!,
								protocol: "ais",
								decoder: "ais-catcher",
								transport: "ambient",
								outcome: "decoded",
							},
						],
						result: {
							...target.result!,
							protocol: "ais",
							identity: { kind: "ais-mmsi", value: "244123456" },
						},
					},
				],
			},
		})
		expect(parsed?.identify?.targets[0]?.trials[0]?.transport).toBe("ambient")
		expect(parsed?.identify?.targets[0]?.result?.identity?.kind).toBe(
			"ais-mmsi",
		)
	})

	it("accepts WG11 heard analog trials, replay trials and replay probes", () => {
		const target = SCAN_JOB.identify!.targets[0]!
		const base = wire()
		const parsed = guardScan("job", {
			...base,
			progress: {
				...base.progress,
				probes: [
					{
						probeId: "p1",
						decoderId: "d1",
						targetHz: 446_006_250,
						protocol: "dpmr",
						transport: "replay",
						state: "confirming",
					},
				],
			},
			identify: {
				...base.identify,
				targets: [
					{
						...target,
						state: "candidate",
						trials: [
							{
								...target.trials[0]!,
								protocol: "analog-fm",
								decoder: "live-audio",
								mode: "nfm",
								transport: "ambient",
								outcome: "heard",
							},
							{
								...target.trials[0]!,
								protocol: "dpmr",
								decoder: "dsd-fme",
								mode: "dpmr",
								transport: "replay",
								outcome: "no-sync",
							},
						],
					},
				],
			},
		})
		expect(parsed?.identify?.targets[0]?.trials.map(t => t.outcome)).toEqual([
			"heard",
			"no-sync",
		])
		expect(parsed?.identify?.targets[0]?.trials[1]?.transport).toBe("replay")
		expect(parsed?.progress.probes[0]?.transport).toBe("replay")
	})

	it("accepts WG12 data-like and carrier-only outcomes, analog-demod and ended no-signal", () => {
		const target = SCAN_JOB.identify!.targets[0]!
		const base = wire()
		const parsed = guardScan("job", {
			...base,
			identify: {
				...base.identify,
				targets: [
					{
						...target,
						state: "unidentified",
						trials: [
							{
								...target.trials[0]!,
								protocol: "dmr",
								decoder: "analog-demod",
								mode: "nfm",
								transport: "replay",
								outcome: "data-like",
							},
							{
								...target.trials[0]!,
								protocol: "unknown",
								decoder: "analog-demod",
								mode: "am",
								transport: "replay",
								outcome: "carrier-only",
							},
						],
						result: { ...target.result!, ended: "no-signal" },
					},
				],
			},
		})
		expect(parsed?.identify?.targets[0]?.trials.map(t => t.outcome)).toEqual([
			"data-like",
			"carrier-only",
		])
		expect(parsed?.identify?.targets[0]?.trials[0]?.decoder).toBe(
			"analog-demod",
		)
		expect(parsed?.identify?.targets[0]?.result?.ended).toBe("no-signal")
		expect(
			guardScan("job", {
				...base,
				identify: {
					...base.identify,
					targets: [
						{
							...target,
							result: { ...target.result!, ended: "bogus" },
						},
					],
				},
			}),
		).toBeUndefined()
	})

	it("still refuses an unknown trial outcome or transport", () => {
		const target = SCAN_JOB.identify!.targets[0]!
		for (const trial of [
			{ ...target.trials[0]!, outcome: "identified" },
			{ ...target.trials[0]!, transport: "stream" },
		])
			expect(
				guardScan("job", {
					...wire(),
					identify: {
						...wire().identify,
						targets: [{ ...target, trials: [trial] }],
					},
				}),
			).toBeUndefined()
	})
})

it("keeps whole-window and optional-width identify requests inspectable, but cannot attribute them to exact-width submission", async () => {
	const { guardIdentifyJob } =
		await import("../../../cli/source/data/scanner-guards.js")
	const request = {
		sourceId: "rtl",
		target: { frequencyHz: 446056250, bandwidthHz: 12500 },
		timeoutMs: 15000,
		exhaustive: false,
		record: false,
	} as const
	for (const target of [{ all: true }, { frequencyHz: 446056250 }]) {
		const job = {
			...SCAN_JOB,
			identify: {
				...SCAN_JOB.identify!,
				target,
				timeoutMs: 15000,
				protocols: [],
				exhaustive: false,
				record: false,
			},
		}
		expect(guardScan("job", job)).toBeDefined()
		expect(guardIdentifyJob(job, request)).toBeUndefined()
	}
})
