import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	ChannelProvider,
	DecoderChannelRequest,
} from "../../../../src/core/channelizer/types.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import type {
	EfficiencyGate,
	PlannerSource,
} from "../../../../src/decoders/enablement/contract.js"
import { RTL433_WINDOW_MAX_RATE_HZ } from "../../../../src/decoders/enablement/contract.js"
import {
	fitsReach,
	planPlacements,
	rtl433ChannelCandidate,
} from "../../../../src/decoders/enablement/placement.js"
import {
	CATALOGUE_DEFAULT_OPTIONS,
	catalogueLoraSlots,
} from "../../../../src/decoders/enablement/catalogue.js"
import { iqChannelRequest } from "../../../../src/decoders/iq-decimate-decoder.js"
import { Rtl433Decoder } from "../../../../src/decoders/builtin/rtl433.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"
import type {
	PlannerDecoder,
	PlannerInput,
} from "../../../../src/decoders/enablement/contract.js"

// Reference ISM selection before optional meter widening (Property 17).
function ismCandidate(
	c: number,
	h: number,
	ranges: readonly { minHz: number; maxHz: number }[],
	target = 1_000_000,
): { hz: number; rateHz: number } | undefined {
	let best: { hz: number; rateHz: number } | undefined
	for (const range of ranges) {
		const lo = Math.max(range.minHz, c - h)
		const hi = Math.min(range.maxHz, c + h)
		if (lo > hi || h < 125_000) continue
		const hz = Math.min(
			Math.max((lo + hi) / 2, c - h + 125_000),
			c + h - 125_000,
		)
		const rateHz =
			Math.floor(Math.min(target, 2 * (h - Math.abs(hz - c))) / 1000) * 1000
		if (rateHz >= 250_000 && (!best || rateHz > best.rateHz))
			best = { hz, rateHz }
	}
	return best
}

const decoder = (overrides: Partial<PlannerDecoder> = {}): PlannerDecoder => ({
	id: "test",
	type: "acarsdec",
	origin: "catalogue",
	order: 0,
	mode: "auto",
	startMode: "auto",
	configuredSourceId: null,
	band: undefined,
	configuredChannelsHz: [],
	reach: "channel",
	channelBandwidthHz: 20_000,
	channelTransitionHz: 10_000,
	protocols: [],
	channelPlacements: true,
	unavailable: false,
	ownDevice: false,
	centreSlotHz: null,
	centrePassbandHz: null,
	...overrides,
})
const source = (overrides: Partial<PlannerSource> = {}): PlannerSource => ({
	id: "s",
	centreHz: 100_000_000,
	sampleRateHz: 2_400_000,
	usableFraction: 0.8,
	dedicatedScanner: false,
	held: false,
	reservedBy: null,
	channelizerAvailable: true,
	order: 0,
	...overrides,
})
const input = (d: PlannerDecoder, sources: PlannerSource[]): PlannerInput => ({
	decoders: [d],
	sources,
	vfo: null,
	bandplanChannels: () => [],
	maxBandplanChannels: 4,
})

const OUT = 446_380_000
const IN = 434_440_000
const RATE = 1_024_000

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

type Fake = RateDecoder & Pick<Decoder, "getChannelRequest">

/** Catalogue rtl433 (or LoRa) on a fake source; the channel echoes the request. */
function setup(
	types: string[] = ["rtl433"],
	centre = OUT,
	opts: {
		modes?: Record<string, "auto" | "always">
		/** Global `bandSuspension` (default true). */
		bandSuspension?: boolean
		/** YAML-configured ids (sourceId rtl, useChannelizer). */
		yaml?: readonly string[]
		unavailable?: readonly string[]
		/** Per-decoder `band.bandSuspension: false`. */
		optOut?: readonly string[]
		/** Operator starts after startAll. */
		operator?: readonly string[]
		/** Keep the fake's ~48 kHz audio frontend (default: the full capture). */
		audio?: readonly string[]
	} = {},
) {
	vi.useFakeTimers()
	const logger = pino({ level: "silent" })
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: centre })
	const registry = new DecoderRegistry()
	const instances = new Map<string, Fake>()
	const applied = new Map<string, Record<string, unknown>>()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	for (const type of types)
		registry.register(
			type,
			config => {
				const d: Fake = new RateDecoder(config.id, caps)
				// IQ adapters keep the capture span (no audio frontend).
				const adapter = d.getRateAdapter.bind(d)
				if (!(opts.audio ?? []).includes(type))
					d.getRateAdapter = input => ({
						...adapter(input),
						frontendRateHz: input.sampleRateHz,
					})
				let options = { ...config.options }
				applied.set(config.id, options)
				d.updateOptions = updates => {
					options = { ...options, ...updates }
					config.options = options
					applied.set(config.id, options)
				}
				if (
					type !== "rtl433" &&
					type !== "readsb" &&
					type !== "lora-meshtastic"
				)
					d.getChannelRequest = input => {
						const wide = type === "ais-catcher"
						return {
							centerHz:
								(options["channelHz"] as number | undefined) ??
								input.centerHz ??
								0,
							bandwidthHz: wide ? 384_000 : 12_500,
							transitionHz: wide ? 8_000 : 2_500,
							outputRateHz: wide ? 288_000 : 48_000,
							format: "cu8",
						}
					}
				if (type === "rtl433")
					d.getChannelRequest = input =>
						iqChannelRequest(
							{
								inputSampleRate: input.sampleRateHz,
								targetSampleRate:
									(options["targetSampleRate"] as number | undefined) ??
									1_000_000,
								filterTransition: 0.05,
								channelHz: options["channelHz"] as number | undefined,
							},
							input,
						)
				instances.set(config.id, d)
				return d
			},
			caps,
		)
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>(() => ({ admit: true })),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 2, cpuGuardPercent: 90, sources: [] }),
	}
	const requests: DecoderChannelRequest[] = []
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(
			async (_source: string, _decoder: string, req: DecoderChannelRequest) => {
				requests.push(req)
				return {
					ok: true,
					stream: new PassThrough(),
					channelId: `ch${requests.length}`,
					generation: 1,
					realised: {
						outputRateHz: req.outputRateHz,
						format: "cu8",
						groupDelaySamples: 0,
					},
				}
			},
		),
		releaseChannel: vi.fn(async () => {}),
		currentGeneration: () => 1,
		retuneChannel: vi.fn(async () => "retuned" as const),
	})
	const make = () => {
		const m = new DecoderManager(registry, new FanoutManager(logger), logger, {
			validateVersions: false,
			...(opts.bandSuspension === false ? { bandSuspension: false } : {}),
			enablement: {
				planner: planPlacements,
				gate,
				resolveMode: id => ({
					mode: opts.modes?.[id] ?? "auto",
					source: "default",
				}),
				isCatalogue: config => !(opts.yaml ?? []).includes(config.id),
				unavailable: id => (opts.unavailable ?? []).includes(id),
				recheckAvailable: async () => true,
				vfo: () => null,
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
			},
		})
		m.setSourceManager(sources as unknown as SourceManager)
		m.setChannelizer(provider as unknown as ChannelProvider)
		const defaults = CATALOGUE_DEFAULT_OPTIONS("EU")
		for (const type of types)
			m.createDecoder({
				id: type,
				type,
				enabled: true,
				options: { ...defaults[type as keyof typeof defaults] },
				...((opts.yaml ?? []).includes(type)
					? { sourceId: "rtl", useChannelizer: true }
					: { useChannelizer: false }),
				...((opts.optOut ?? []).includes(type)
					? { band: { bandSuspension: false } }
					: {}),
			})
		return m
	}
	manager = make()
	return {
		get manager() {
			return manager!
		},
		sources,
		provider,
		requests,
		instances,
		applied,
		async restart() {
			await manager?.destroy()
			manager = make()
			await this.begin()
		},
		async begin() {
			await manager!.startAll()
			for (const id of opts.operator ?? [])
				await manager!.startDecoder(id, { startMode: "operator" })
			await settle()
		},
	}
}

async function settle() {
	await vi.advanceTimersByTimeAsync(3_000)
}

async function tune(f: ReturnType<typeof setup>, hz: number) {
	f.sources.setCenter("rtl", hz)
	await settle()
}

function view(f: ReturnType<typeof setup>, id: string) {
	const s = f.manager.getStatus(id)!
	return {
		verdict: s.bandAssessment?.verdict,
		reason: s.suspension?.reasonCode,
		since: s.suspension?.since,
		placements: s.placements ?? [],
	}
}

describe("rtl_433 channel arithmetic", () => {
	it("live case: 434.44 MHz at 1.024 Msps places 434.41 MHz at 759 kHz", () => {
		const found = rtl433ChannelCandidate(
			{ centreHz: IN, sampleRateHz: RATE, usableFraction: 0.8 },
			[{ minHz: 433_050_000, maxHz: 434_790_000 }],
		)
		expect(found).toEqual({ hz: 434_410_200, rateHz: 759_000 })
	})

	it("a fit of exactly 250 kHz is placed and one just below is capture-too-narrow", () => {
		const c = 434_000_000
		const ism = {
			basis: "configured" as const,
			rangesHz: [{ minHz: 433_050_000, maxHz: 434_790_000 }],
		}
		// Window reach from 250 ksps (rtl_433's narrowest rate) to 2.4 Msps.
		for (const rate of [250_000, 312_000, 2_400_000]) {
			const at = planPlacements(
				input(decoder({ type: "rtl433", band: ism }), [
					source({ centreHz: c, sampleRateHz: rate }),
				]),
			)
			expect(at.wanted).toMatchObject([
				{ reach: "raw", channelHz: null, options: { targetSampleRate: rate } },
			])
		}
		// Below 250 ksps no channel fits either (h < 125 kHz).
		const past = planPlacements(
			input(decoder({ type: "rtl433", band: ism }), [
				source({ centreHz: c, sampleRateHz: 249_999 }),
			]),
		)
		expect(past.wanted).toEqual([])
		expect(past.unplaced.get("test")).toBe("capture-too-narrow")
		// Past 2.4 Msps the channel path places one exactly 250 kHz channel at the
		// window edge: h = 3.2 Msps * 0.8 / 2 = 1.28 MHz, overlap 125 kHz wide.
		const edge = planPlacements(
			input(decoder({ type: "rtl433", band: ism }), [
				source({
					centreHz: 434_790_000 + 1_280_000 - 125_000,
					sampleRateHz: 3_200_000,
				}),
			]),
		)
		expect(edge.wanted).toMatchObject([
			{ reach: "channel", options: { targetSampleRate: 250_000 } },
		])
		const away = planPlacements(
			input(decoder({ type: "rtl433", band: ism }), [
				source({ centreHz: OUT, sampleRateHz: RATE }),
			]),
		)
		expect(away.unplaced.get("test")).toBe("frequency-out-of-band")
	})

	it("non-finite caps give no candidate", () => {
		for (const s of [
			{ centreHz: null, sampleRateHz: RATE, usableFraction: 0.8 },
			{ centreHz: IN, sampleRateHz: Infinity, usableFraction: 0.8 },
			{ centreHz: IN, sampleRateHz: RATE, usableFraction: NaN },
		])
			expect(
				rtl433ChannelCandidate(s, [{ minHz: 433_050_000, maxHz: 434_790_000 }]),
			).toEqual({ overlap: false })
	})

	it("the adapter's -s equals the realised channel rate", () => {
		const d = new Rtl433Decoder(
			{
				id: "r",
				type: "rtl433",
				enabled: true,
				options: { targetSampleRate: 759_000, inputSampleRate: 759_000 },
			},
			pino({ level: "silent" }),
		)
		const args = (
			d as unknown as { getDecoderArgs(): string[] }
		).getDecoderArgs()
		expect(args[args.indexOf("-s") + 1]).toBe("759000")
	})

	it("Property 17: channels fit and meter widening preserves the ISM span", () => {
		// Feature: decoder-enablement, Property 17: The rtl_433 channel fits
		// Validates: Requirements 3.16
		fc.assert(
			fc.property(
				fc.oneof(
					fc.integer({ min: 300_000_000, max: 900_000_000 }),
					fc.integer({ min: 867_000_000, max: 871_000_000 }),
				),
				fc.integer({ min: 312_500, max: 6_000_000 }),
				fc.array(
					fc
						.tuple(
							fc.integer({ min: -3_000_000, max: 3_000_000 }),
							fc.integer({ min: 0, max: 3_000_000 }),
						)
						.map(([lo, width]) => ({ lo, width })),
					{ minLength: 1, maxLength: 4 },
				),
				(c, fs, parts) => {
					const s: PlannerSource = source({ centreHz: c, sampleRateHz: fs })
					const rangesHz = parts.map(p => ({
						minHz: c + p.lo,
						maxHz: c + p.lo + p.width,
					}))
					const found = rtl433ChannelCandidate(s, rangesHz)
					const h = (fs * 0.8) / 2
					const old = ismCandidate(c, h, rangesHz)
					const overlap = rangesHz.some(
						r => Math.max(r.minHz, c - h) <= Math.min(r.maxHz, c + h),
					)
					if (!("hz" in found)) {
						expect(found.overlap).toBe(overlap)
						expect(old).toBeUndefined()
						return
					}
					expect(found.rateHz).toBeGreaterThanOrEqual(250_000)
					const lo = found.hz - found.rateHz / 2
					const hi = found.hz + found.rateHz / 2
					if (old) {
						expect(lo).toBeLessThanOrEqual(old.hz - old.rateHz / 2)
						expect(hi).toBeGreaterThanOrEqual(old.hz + old.rateHz / 2)
					}
					if (old && found.rateHz === old.rateHz) {
						expect(found).toEqual(old)
					} else {
						expect(found.rateHz).toBeGreaterThanOrEqual(1_200_000)
						expect(found.rateHz).toBeLessThanOrEqual(RTL433_WINDOW_MAX_RATE_HZ)
						expect(
							rangesHz.some(
								r => r.minHz <= 868_950_000 && r.maxHz >= 868_950_000,
							),
						).toBe(true)
						expect(lo).toBeLessThanOrEqual(868_350_000)
						expect(hi).toBeGreaterThanOrEqual(869_550_000)
					}
					expect(found.rateHz % 1000).toBe(0)
					const request = iqChannelRequest(
						{
							inputSampleRate: fs,
							targetSampleRate: found.rateHz,
							filterTransition: 0.05,
						},
						{ sampleRateHz: fs },
					)
					expect(
						fitsReach(
							decoder({
								type: "rtl433",
								channelBandwidthHz: request.bandwidthHz,
								channelTransitionHz: request.transitionHz,
							}),
							s,
							found.hz,
						),
					).toBe(true)
				},
			),
			{
				numRuns: 500,
				examples: [[868563082, 2467295, [{ lo: 0, width: 386918 }]]],
			},
		)
	})
})

describe("LoRa regional slots", () => {
	it("the EU catalogue declares 868 and 433 slots", () => {
		expect(catalogueLoraSlots("EU_868")).toEqual([
			{ region: "EU_868", frequency: 869_525_000 },
			{ region: "EU_433", frequency: 433_875_000 },
		])
		expect(catalogueLoraSlots("US")).toBeUndefined()
	})

	it("EU LoRa near 433.875 MHz is placed on the 433 slot with its region", async () => {
		const f = setup(["lora-meshtastic"], 433_920_000)
		await f.manager.startAll()
		await settle()
		const status = f.manager.getStatus("lora-meshtastic")!
		expect(status.bandAssessment?.verdict).toBe("in-band")
		expect(status.suspension).toBeUndefined()
		expect(status.placements).toMatchObject([{ reach: "centre" }])
		expect(f.applied.get("lora-meshtastic")).toMatchObject({
			region: "EU_433",
			frequency: 433_875_000,
		})
		// 434.44 MHz: the 433 slot is 565 kHz away, outside the window.
		await tune(f, IN)
		expect(view(f, "lora-meshtastic").reason).toBe("frequency-out-of-band")
		await tune(f, 869_525_000)
		expect(view(f, "lora-meshtastic").reason).toBeUndefined()
		expect(f.applied.get("lora-meshtastic")).toMatchObject({
			region: "EU_868",
			frequency: 869_525_000,
		})
	})
})

describe("suspension follows the band", () => {
	it("rtl433 out, in, out, in at 1.024 Msps", async () => {
		const f = setup()
		await f.manager.startAll()
		await settle()
		for (let round = 0; round < 2; round++) {
			expect(view(f, "rtl433")).toMatchObject({
				verdict: "out-of-band",
				reason: "frequency-out-of-band",
				placements: [],
			})
			await tune(f, IN)
			const placed = view(f, "rtl433")
			expect(placed.verdict).toBe("in-band")
			expect(placed.reason).toBeUndefined()
			// The whole capture, no channel.
			expect(placed.placements).toEqual([
				expect.objectContaining({ reach: "raw", running: true }),
			])
			expect(placed.placements[0]?.channelHz).toBeUndefined()
			expect(f.requests).toEqual([])
			await tune(f, OUT)
		}
	})

	it("start at 446.52 MHz, retune after 3 s to 434.5125 MHz: rtl433 runs", async () => {
		// The band overlaps the window, so rtl_433 reads the whole 1.024 Msps capture.
		const f = setup(["rtl433"], 446_520_000)
		await f.manager.startAll()
		await vi.advanceTimersByTimeAsync(3_000)
		expect(view(f, "rtl433").reason).toBe("frequency-out-of-band")
		await tune(f, 434_512_500)
		const v = view(f, "rtl433")
		expect(v.verdict).toBe("in-band")
		expect(v.reason).toBeUndefined()
		expect(f.manager.getStatus("rtl433")?.suspended).toBe(false)
		expect(v.placements).toMatchObject([{ reach: "raw", running: true }])
		expect(f.requests).toEqual([])
		expect(f.applied.get("rtl433")?.["targetSampleRate"]).toBe(RATE)
		// The same after a manager restart already tuned there.
		await f.restart()
		expect(view(f, "rtl433").reason).toBeUndefined()
		expect(view(f, "rtl433").placements).toMatchObject([{ running: true }])
	})

	it("LoRa and rtl433 together follow out, in, out, in", async () => {
		const f = setup(["rtl433", "lora-meshtastic"], OUT)
		await f.manager.startAll()
		await settle()
		for (let round = 0; round < 2; round++) {
			for (const id of ["rtl433", "lora-meshtastic"])
				expect(view(f, id).reason).toBe("frequency-out-of-band")
			await tune(f, 433_920_000)
			for (const id of ["rtl433", "lora-meshtastic"]) {
				expect(view(f, id).verdict).toBe("in-band")
				expect(view(f, id).reason).toBeUndefined()
			}
			await tune(f, OUT)
		}
	})

	it("in band after a manager restart and after a reconnect at a new centre", async () => {
		const f = setup(["rtl433"], IN)
		await f.manager.startAll()
		await settle()
		expect(view(f, "rtl433").reason).toBeUndefined()
		await f.restart()
		expect(view(f, "rtl433").reason).toBeUndefined()
		expect(view(f, "rtl433").placements).toHaveLength(1)
		f.sources.remove("rtl")
		await settle()
		expect(view(f, "rtl433").reason).toBe("source-rate-unknown")
		f.sources.reconnect("rtl", RATE)
		f.sources.setCenter("rtl", OUT)
		await settle()
		expect(view(f, "rtl433").reason).toBe("frequency-out-of-band")
		await tune(f, IN)
		expect(view(f, "rtl433").reason).toBeUndefined()
		expect(view(f, "rtl433").placements).toHaveLength(1)
	})

	it("since resets on a reason change and after a run", async () => {
		const f = setup(["rtl433"], OUT)
		await f.manager.startAll()
		await settle()
		const first = view(f, "rtl433").since
		await vi.advanceTimersByTimeAsync(5_000)
		// Another out-of-band centre: the same uninterrupted suspension.
		await tune(f, OUT + 1_000_000)
		expect(view(f, "rtl433").since).toBe(first)
		// 200 kHz capture beside the band: capture-too-narrow, a new interval.
		f.sources.setRate("rtl", 200_000)
		await tune(f, 434_000_000)
		expect(view(f, "rtl433").reason).toBe("capture-too-narrow")
		const narrow = view(f, "rtl433").since
		expect(narrow).not.toBe(first)
		// Run, then suspend again with the first reason: a new since.
		f.sources.setRate("rtl", RATE)
		await tune(f, IN)
		expect(view(f, "rtl433").reason).toBeUndefined()
		await vi.advanceTimersByTimeAsync(5_000)
		await tune(f, OUT)
		const again = view(f, "rtl433").since
		expect(view(f, "rtl433").reason).toBe("frequency-out-of-band")
		expect(again).not.toBe(first)
		expect(again).not.toBe(narrow)
	})

	it("a moved rtl433 channel restarts with the new -f reference; a new rate restarts once", async () => {
		const f = setup(["rtl433"], IN)
		await f.manager.startAll()
		await settle()
		const d = f.instances.get("rtl433")!
		const starts = d.starts
		const requests = f.provider.requestChannel.mock.calls.length
		// 3.2 Msps (past window reach) at 433.5 MHz and 433.6 MHz: both give a
		// 1 MHz channel; h = 1.28 MHz, overlap 433.05-434.78 MHz then
		// 433.05-434.79 MHz, centres 433.915 and 433.92 MHz.
		f.sources.setRate("rtl", 3_200_000)
		await tune(f, 433_500_000)
		expect(f.applied.get("rtl433")?.["targetSampleRate"]).toBe(1_000_000)
		expect(d.starts).toBe(starts + 1)
		expect(f.provider.requestChannel.mock.calls.length).toBe(requests + 1)
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_915_000)
		await tune(f, 433_600_000)
		// No in-place retune: the running process gets the new centre.
		expect(f.provider.retuneChannel).not.toHaveBeenCalled()
		expect(d.starts).toBe(starts + 2)
		expect(f.provider.requestChannel.mock.calls.length).toBe(requests + 2)
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_920_000)
		expect(d.running).toBe(true)
		expect(view(f, "rtl433").placements).toMatchObject([
			{ channelHz: 433_920_000, running: true },
		])
	})

	it("a raw rtl433 centre move keeps crash accounting, and a later crash counts on top", async () => {
		const f = setup(["rtl433"], 433_600_000)
		await f.manager.startAll()
		await settle()
		const d = f.instances.get("rtl433")!
		d.crash()
		// The 2 s backoff restarts it once.
		await settle()
		expect(d.running).toBe(true)
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(1)
		const starts = d.starts
		await tune(f, 433_601_000)
		expect(d.starts).toBe(starts + 1)
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_601_000)
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(1)
		d.crash()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(2)
		expect(d.running).toBe(true)
	})

	it("a raw rtl433 centre move during a crash backoff waits for the retry", async () => {
		const f = setup(["rtl433"], 433_600_000)
		await f.manager.startAll()
		await settle()
		const d = f.instances.get("rtl433")!
		const starts = d.starts
		d.crash()
		f.sources.setCenter("rtl", 433_601_000)
		await vi.advanceTimersByTimeAsync(400)
		expect(d.starts).toBe(starts)
		await vi.advanceTimersByTimeAsync(3_000)
		expect(d.starts).toBe(starts + 1)
		expect(d.running).toBe(true)
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_601_000)
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(1)
	})

	it("a moved rtl433 channel during a crash backoff waits for the retry", async () => {
		const f = setup(["rtl433"], IN)
		await f.manager.startAll()
		await settle()
		f.sources.setRate("rtl", 3_200_000)
		await tune(f, 433_500_000)
		const d = f.instances.get("rtl433")!
		const starts = d.starts
		d.crash()
		f.sources.setCenter("rtl", 433_600_000)
		await vi.advanceTimersByTimeAsync(400)
		expect(d.starts).toBe(starts)
		await vi.advanceTimersByTimeAsync(3_000)
		expect(d.starts).toBe(starts + 1)
		expect(d.running).toBe(true)
		// The retry started it on the moved channel, with its centre as -f.
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_920_000)
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(1)
		expect(view(f, "rtl433").placements).toMatchObject([
			{ channelHz: 433_920_000, running: true },
		])
	})

	it("a moved rtl433 channel without a pending crash restarts at once and keeps accounting", async () => {
		const f = setup(["rtl433"], IN)
		await f.manager.startAll()
		await settle()
		f.sources.setRate("rtl", 3_200_000)
		await tune(f, 433_500_000)
		const d = f.instances.get("rtl433")!
		d.crash()
		await settle()
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(1)
		const starts = d.starts
		await tune(f, 433_600_000)
		expect(d.starts).toBe(starts + 1)
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_920_000)
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(1)
		d.crash()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(f.manager.getStatus("rtl433")?.restartCount).toBe(2)
	})

	it("a raw rtl433 restarts when only the capture centre moves", async () => {
		const f = setup(["rtl433"], 433_600_000)
		await f.manager.startAll()
		await settle()
		const d = f.instances.get("rtl433")!
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_600_000)
		const starts = d.starts
		await tune(f, 433_700_000)
		expect(view(f, "rtl433").placements).toMatchObject([
			{ reach: "raw", running: true },
		])
		// The process was restarted after the reference changed.
		expect(f.applied.get("rtl433")?.["inputCenterFreq"]).toBe(433_700_000)
		expect(d.starts).toBe(starts + 1)
		expect(d.running).toBe(true)
	})

	it("Property 16: after each settle the suspension equals the band verdict", async () => {
		// Feature: decoder-enablement, Property 16: Suspension equals the band verdict after settle
		// Validates: Requirements 3.13, 3.14, 3.15, 11.3
		// rtl433 (adaptive channel), ais-catcher (fixed IQ channel), readsb (raw),
		// dsd-fme (audio demodulator), multimon-ng (no band: unknown), LoRa (centre).
		const KINDS = [
			"rtl433",
			"ais-catcher",
			"readsb",
			"dsd-fme",
			"multimon-ng",
			"lora-meshtastic",
		] as const
		const role = fc.constantFrom(
			"auto",
			"always",
			"yaml",
			"operator",
			"opt-out",
			"unavailable",
		)
		const step = fc.oneof(
			fc.record({
				kind: fc.constant("tune" as const),
				hz: fc.constantFrom(
					OUT,
					135_800_000,
					IN,
					433_920_000,
					869_525_000,
					162_000_000,
					1_090_000_000,
				),
			}),
			fc.record({
				kind: fc.constant("rate" as const),
				// 20 kHz is below the fakes' 48 kHz minimum: a rate reason.
				hz: fc.constantFrom(20_000, 250_000, 1_024_000, 2_048_000, 3_200_000),
			}),
			fc.record({
				kind: fc.constant("reconnect" as const),
				hz: fc.constant(0),
			}),
			fc.record({ kind: fc.constant("restart" as const), hz: fc.constant(0) }),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(fc.constantFrom(...KINDS), role), {
					minLength: 1,
					maxLength: 4,
				}),
				fc.array(step, { minLength: 1, maxLength: 4 }),
				fc.boolean(),
				async (picked, steps, globalBand) => {
					const roles = new Map(picked)
					const ids = [...roles.keys()]
					const having = (r: string) => ids.filter(id => roles.get(id) === r)
					const f = setup(ids, OUT, {
						modes: Object.fromEntries(
							having("always").map(id => [id, "always"]),
						),
						bandSuspension: globalBand,
						yaml: having("yaml"),
						unavailable: having("unavailable"),
						optOut: having("opt-out"),
						operator: having("operator"),
						// Audio demodulators keep their ~48 kHz frontend.
						audio: ["dsd-fme", "multimon-ng"],
					})
					await f.begin()
					let previous = new Map<string, { reason?: string; since?: unknown }>()
					for (const s of steps) {
						if (s.kind === "tune") await tune(f, s.hz)
						else if (s.kind === "rate") {
							f.sources.setRate("rtl", s.hz)
							await settle()
						} else if (s.kind === "reconnect") {
							const centre = f.sources.caps.get("rtl")?.centerFreq ?? IN
							const rate = f.sources.caps.get("rtl")?.sampleRate ?? RATE
							f.sources.remove("rtl")
							await settle()
							f.sources.reconnect("rtl", rate)
							f.sources.setCenter("rtl", centre)
							await settle()
						} else await f.restart()
						const next = new Map<string, { reason?: string; since?: unknown }>()
						for (const id of ids) {
							const status = f.manager.getStatus(id)!
							const v = view(f, id)
							const r = roles.get(id)
							const bandFree =
								!globalBand ||
								r === "always" ||
								r === "operator" ||
								r === "opt-out"
							const rate = status.rateAssessment
							// (a) higher-priority gates win whatever the band says.
							// 11.3 order: a rate reason, then decoder-unavailable.
							if (rate?.verdict === "unusable")
								expect(v.reason).toBe(rate.reasonCode)
							else if (r === "unavailable")
								expect(v.reason).toBe("decoder-unavailable")
							// (c) opt-outs, always and operator starts.
							else if (bandFree)
								expect(v.reason).not.toBe("frequency-out-of-band")
							// (d) the band verdict decides.
							else if (v.verdict === "out-of-band")
								expect(v.reason).toBe("frequency-out-of-band")
							else if (v.verdict === "in-band") {
								expect(
									v.reason === undefined
										? v.placements.length > 0 || r === "yaml"
										: v.reason === "capture-too-narrow" ||
												v.reason === "no-channel-selected" ||
												v.reason === "efficiency-budget",
								).toBe(true)
							}
							// Unknown band (multimon-ng): never out of band.
							else expect(v.reason).not.toBe("frequency-out-of-band")
							const before = previous.get(id)
							// A reconnect or restart passes through other states.
							if (
								s.kind !== "restart" &&
								s.kind !== "reconnect" &&
								before?.reason !== undefined &&
								before.reason === v.reason
							)
								expect(v.since).toBe(before.since)
							if (
								before?.reason !== undefined &&
								v.reason !== undefined &&
								before.reason !== v.reason
							)
								expect(v.since).not.toBe(before.since)
							next.set(id, {
								...(v.reason !== undefined ? { reason: v.reason } : {}),
								...(v.since !== undefined ? { since: v.since } : {}),
							})
						}
						previous = next
					}
					await manager?.destroy()
					manager = undefined
				},
			),
			{ numRuns: 100 },
		)
	}, 300_000)
})

describe("band reasons and opt-outs", () => {
	const away = source({ centreHz: 446_520_000, sampleRateHz: RATE })
	it("AIS and ADS-B at 446.52 MHz are out of band, not capture-too-narrow", () => {
		const ais = planPlacements(
			input(
				decoder({
					type: "ais-catcher",
					channelBandwidthHz: 384_000,
					channelTransitionHz: 8_000,
					band: { basis: "protocol", targetsHz: [161_975_000, 162_025_000] },
				}),
				[away],
			),
		)
		expect(ais.unplaced.get("test")).toBe("frequency-out-of-band")
		const adsb = planPlacements(
			input(
				decoder({
					type: "readsb",
					reach: "raw",
					band: { basis: "protocol", targetsHz: [1_090_000_000] },
				}),
				[away],
			),
		)
		expect(adsb.unplaced.get("test")).toBe("frequency-out-of-band")
	})

	it.each([
		["global", { bandSuspension: false }],
		["per-decoder", { optOut: ["rtl433"] }],
	] as const)(
		"%s band-suspension opt-out never reports frequency-out-of-band",
		async (_name, opts) => {
			const f = setup(["rtl433"], 446_520_000, opts)
			await f.begin()
			const v = view(f, "rtl433")
			expect(v.verdict).toBe("out-of-band")
			expect(v.reason).not.toBe("frequency-out-of-band")
			// The planner skips the band: rtl_433 reads the whole window.
			expect(v.reason).toBeUndefined()
			expect(v.placements).toMatchObject([{ reach: "raw", running: true }])
		},
	)
})

describe("fit failures are capture-too-narrow", () => {
	it("catalogue dsd-fme at 446.52 MHz, 250 ksps, band-plan channel 446.615 MHz that cannot fit", () => {
		const plan = planPlacements({
			...input(
				decoder({
					type: "dsd-fme",
					channelBandwidthHz: 20_000,
					channelTransitionHz: 10_000,
					band: {
						basis: "region-default",
						rangesHz: [{ minHz: 446_000_000, maxHz: 446_700_000 }],
					},
				}),
				[source({ centreHz: 446_520_000, sampleRateHz: 250_000 })],
			),
			bandplanChannels: () => [446_615_000],
		})
		// 95 kHz off centre + 10 kHz half channel + 10 kHz transition > 100 kHz usable half.
		expect(plan.wanted).toEqual([])
		expect(plan.unplaced.get("test")).toBe("capture-too-narrow")
		// A channel that fits is placed.
		const fits = planPlacements({
			...input(
				decoder({
					type: "dsd-fme",
					channelBandwidthHz: 20_000,
					channelTransitionHz: 10_000,
					band: {
						basis: "region-default",
						rangesHz: [{ minHz: 446_000_000, maxHz: 446_700_000 }],
					},
				}),
				[source({ centreHz: 446_520_000, sampleRateHz: 250_000 })],
			),
			bandplanChannels: () => [446_575_000],
		})
		expect(fits.wanted).toMatchObject([
			{ channelHz: 446_575_000, origin: "bandplan" },
		])
	})

	it.each([
		["always", { mode: "always" }],
		["operator start", { startMode: "operator" }],
		["band opt-out", { bandSuspension: false }],
	] as const)(
		"%s: dsd-fme at 446.52 MHz, 250 ksps, VFO 446.615 MHz that cannot fit",
		(_name, bypass) => {
			const dsd = decoder({
				type: "dsd-fme",
				channelBandwidthHz: 20_000,
				channelTransitionHz: 10_000,
				band: {
					basis: "region-default",
					rangesHz: [{ minHz: 446_000_000, maxHz: 446_700_000 }],
				},
				...bypass,
			})
			const capture = source({ centreHz: 446_520_000, sampleRateHz: 250_000 })
			const plan = planPlacements({
				...input(dsd, [capture]),
				vfo: { sourceId: "s", frequencyHz: 446_615_000 },
			})
			expect(plan.wanted).toEqual([])
			expect(plan.unplaced.get("test")).toBe("capture-too-narrow")
			// Centre just outside the usable window (446.62 MHz is its edge), and far away.
			for (const frequencyHz of [446_620_001, 460_000_000]) {
				const outside = planPlacements({
					...input(dsd, [capture]),
					vfo: { sourceId: "s", frequencyHz },
				})
				expect(outside.wanted, `${frequencyHz}`).toEqual([])
				expect(outside.unplaced.get("test"), `${frequencyHz}`).toBe(
					"capture-too-narrow",
				)
			}
			// A VFO channel that fits is placed.
			const fits = planPlacements({
				...input(dsd, [capture]),
				vfo: { sourceId: "s", frequencyHz: 446_575_000 },
			})
			expect(fits.wanted).toMatchObject([{ channelHz: 446_575_000 }])
			expect(fits.unplaced.has("test")).toBe(false)
		},
	)

	it("EU catalogue LoRa always at 434.2 MHz, 1.024 Msps: the 433 slot cannot fit", async () => {
		const f = setup(["lora-meshtastic"], 434_200_000, {
			modes: { "lora-meshtastic": "always" },
		})
		await f.begin()
		const v = view(f, "lora-meshtastic")
		expect(v.placements).toEqual([])
		expect(v.reason).toBe("capture-too-narrow")
	})
})

describe("no channel selected", () => {
	it("catalogue dsd-fme at 446.52 MHz, 2.4 Msps, no VFO or band-plan channel", async () => {
		const f = setup(["dsd-fme"], 446_520_000)
		f.sources.setRate("rtl", 2_400_000)
		await f.begin()
		await settle()
		const v = view(f, "dsd-fme")
		expect(v.verdict).toBe("in-band")
		expect(v.reason).toBe("no-channel-selected")
	})

	it("catalogue dsd-fme at 135.8 MHz, 1.024 Msps follows assessBand: out of band", async () => {
		const f = setup(["dsd-fme"], 135_800_000, { audio: ["dsd-fme"] })
		await f.begin()
		const v = view(f, "dsd-fme")
		// The audio frontend keeps ~48 kHz around the centre: 136 MHz is out of view.
		expect(v.verdict).toBe("out-of-band")
		expect(v.reason).toBe("frequency-out-of-band")
		// The planner alone sees 136 MHz in its ±409.6 kHz window.
		expect(
			planPlacements(
				input(
					decoder({
						type: "dsd-fme",
						band: {
							basis: "region-default",
							rangesHz: [{ minHz: 136_000_000, maxHz: 174_000_000 }],
						},
					}),
					[source({ centreHz: 135_800_000, sampleRateHz: RATE })],
				),
			).unplaced.get("test"),
		).toBe("no-channel-selected")
	})
})

it("Property 17: a 2 MHz target preserves ISM and any widened meter span", () => {
	// Feature: decoder-enablement, Property 17: The rtl_433 channel fits
	// Validates: Requirements 3.16
	fc.assert(
		fc.property(
			fc.integer({ min: 867_000_000, max: 871_000_000 }),
			fc.integer({ min: 312_500, max: 6_000_000 }),
			(c, fs) => {
				const ranges = [{ minHz: 863_000_000, maxHz: 870_000_000 }]
				const h = (fs * 0.8) / 2
				const old = ismCandidate(c, h, ranges, 2_000_000)
				const found = rtl433ChannelCandidate(
					source({ centreHz: c, sampleRateHz: fs }),
					ranges,
					2_000_000,
				)
				if (!("hz" in found)) {
					expect(old).toBeUndefined()
					return
				}
				const lo = found.hz - found.rateHz / 2
				const hi = found.hz + found.rateHz / 2
				if (old) {
					expect(lo).toBeLessThanOrEqual(old.hz - old.rateHz / 2)
					expect(hi).toBeGreaterThanOrEqual(old.hz + old.rateHz / 2)
				}
				if (!old || found.rateHz > old.rateHz) {
					expect(lo).toBeLessThanOrEqual(868_350_000)
					expect(hi).toBeGreaterThanOrEqual(869_550_000)
				}
				expect(lo).toBeGreaterThanOrEqual(c - h)
				expect(hi).toBeLessThanOrEqual(c + h)
				expect(found.rateHz).toBeLessThanOrEqual(2_400_000)
			},
		),
		{
			numRuns: 500,
			examples: [
				[868_950_000, 3_000_000],
				[868_600_000, 3_000_000],
			],
		},
	)
})
