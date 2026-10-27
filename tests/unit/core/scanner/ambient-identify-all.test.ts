import { wmbusPacket } from "../../../mocks/rtl433-wmbus.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { readFileSync, rmSync } from "node:fs"
import fc from "fast-check"
import { z } from "zod"
import {
	placeAmbientDecode,
	ambientReachHz,
	AMBIENT_CHANNEL_WIDTH_HZ,
} from "../../../../src/core/scanner/probes/ambient-placement.js"
import { pickChannelObservation } from "../../../../src/core/scanner/probes/ambient-channel.js"
import {
	AmbientObservationIndex,
	AmbientObservationMap,
} from "../../../../src/core/scanner/probes/ambient-index.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import { EventEmitter } from "node:events"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
	type AmbientDeps,
} from "../../../../src/core/scanner/probes/ambient.js"
import { ConfirmMemory } from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"

const HZ = 131_725_000
function rig(
	type: string,
	hz = HZ,
	protocol?: string,
	tuningTrustOf?: AmbientDeps["tuningTrustOf"],
) {
	const trust = { value: "commanded" as "commanded" | "unverified" | undefined }
	const decoders = new EventEmitter()
	const status = {
		id: "synthetic",
		type,
		owner: "config",
		running: true,
		health: "running",
	}
	Object.assign(decoders, {
		getAllStatus: () => [status],
		getStatus: () => status,
		getDecoder: () =>
			Object.assign(new EventEmitter(), {
				getChannelRequest: () => ({ bandwidthHz: 25_000 }),
			}),
	})
	const clock = { at: 100_000 }
	const ambient = new AmbientEvidence({
		decoders: decoders as never,
		targetOf: () => ({
			sourceId: "fake",
			hz: hz - 25_000,
			targetsHz: [hz - 25_000, hz],
			external: false,
			...(protocol === "nxdn48" ? { nxdn: "nxdn48" as const } : {}),
		}),
		epochOf: () => 1,
		logger: pino({ level: "silent" }),
		now: () => clock.at,
		sampleRateOf: () => 1_024_000,
		centreOf: () => hz - 50_000,
		tuningTrustOf: tuningTrustOf ?? (() => trust.value),
		confirm: {
			memory: new ConfirmMemory(() => clock.at),
			scopeOf: () => "synthetic-discovery",
		},
	})
	const got: AmbientEvidenceEvent[] = []
	ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
	ambient.start()
	const emit = (outputType: string, data: unknown) => {
		if (outputType === "link")
			decoders.emit(
				"decoder:placed-link",
				"synthetic",
				{ ...(data as object), verified: true, at: clock.at },
				{ sourceId: "fake", channelHz: hz },
			)
		else
			decoders.emit("decoder:output", "synthetic", {
				type: outputType,
				data,
				timestamp: new Date(clock.at),
				provenanceBinding: { sourceId: "fake", channelHz: hz },
			})
		clock.at += 2_000
	}
	return { ambient, got, emit, clock, decoders, trust }
}

describe("ambient identify all regressions", () => {
	it("identifies wM-Bus through the existing ISM ambient confirmation rules", () => {
		const r = rig("rtl433", 868_950_000)
		try {
			r.emit("signal", wmbusPacket)
			expect(r.got.some(e => e.ev.identity !== undefined)).toBe(false)
			r.emit("signal", {
				...wmbusPacket,
				AC: 2,
				data: "0b4453547856341201077801",
			})
			expect(r.got.at(-1)).toMatchObject({
				hz: 868_950_000,
				ev: {
					protocol: "ism",
					identity: { kind: "ism-model", value: "Wireless-MBus:12345678" },
				},
			})
		} finally {
			r.ambient.stop()
		}
	})

	it("checks trust at the placed channel rather than the claimed decoder offset", () => {
		const seen: unknown[][] = []
		const r = rig("acarsdec", HZ, undefined, (...args) => {
			seen.push(args)
			return args[1] === HZ ? "commanded" : "unverified"
		})
		try {
			r.emit("acars", {
				frequency: HZ + 500,
				tail: "TEST01",
				error: 0,
				msgno: "M01A",
			})
			r.emit("acars", {
				frequency: HZ + 500,
				tail: "TEST01",
				error: 0,
				msgno: "M02A",
			})
			expect(seen).toEqual(
				Array.from({ length: 2 }, () => [
					"synthetic",
					HZ,
					"fake",
					{ sourceId: "fake", channelHz: HZ },
				]),
			)
			expect(r.got.at(-1)?.ev.identity).toBeDefined()
		} finally {
			r.ambient.stop()
		}
	})

	it.each([
		[
			"acarsdec",
			"acars",
			{ frequency: 0, error: 0, errorKnown: true, tail: "TEST01" },
		],
		["dumpvdl2", "vdl2", { frequency: 0, fromaddr: "ABC001" }],
	])(
		"%s uses the actual channel binding for frequency-less output and pairs spaced distinct messages",
		(type, outputType, data) => {
			const r = rig(type)
			try {
				r.emit(outputType, data)
				r.emit(outputType, { ...data, text: "SYNTHETIC SECOND" })
				expect(r.got.at(-1)).toMatchObject({
					hz: HZ,
					ev: { protocol: outputType, identity: expect.anything() },
				})
			} finally {
				r.ambient.stop()
			}
		},
	)

	it("multimon AFSK1200 output reaches the APRS interpreter", () => {
		const r = rig("multimon-ng")
		try {
			r.emit("decode", { protocol: "AFSK1200", from: "TEST01", to: "TEST02" })
			r.emit("decode", { protocol: "AFSK1200", from: "TEST01", to: "TEST02" })
			expect(r.got.at(-1)).toMatchObject({
				hz: HZ,
				ev: { protocol: "aprs", identity: { value: "TEST01" } },
			})
		} finally {
			r.ambient.stop()
		}
	})
})

const fixtures = z
	.array(
		z.object({
			decoder: z.string(),
			type: z.string(),
			protocol: z.string(),
			hz: z.number(),
			data: z.record(z.string(), z.unknown()),
		}),
	)
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../../../mocks/fixtures/ambient-identify-all.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	)

for (const sample of fixtures) {
	describe(`${sample.decoder}/${sample.protocol} synthetic decode`, () => {
		it("accepts two messages at their actual placement", () => {
			const r = rig(sample.decoder, sample.hz, sample.protocol)
			try {
				r.emit(sample.type, sample.data)
				r.emit(sample.type, {
					...sample.data,
					text: "SYNTHETIC SECOND",
					name: "SYNTHETIC SECOND",
					msgno: "M002",
					acars: { tail: "TEST01", msgno: "M002" },
					id: sample.protocol === "lora" ? 2 : sample.data["id"],
					tg: "2",
					raw:
						sample.decoder === "direwolf"
							? ">SYNTHETIC SECOND"
							: sample.data["raw"],
					value: 2,
					msgType: "SYNTHETIC SECOND",
				})
				expect(r.got.at(-1)).toMatchObject({
					hz: sample.hz,
					ev: { protocol: sample.protocol, identity: expect.anything() },
				})
			} finally {
				r.ambient.stop()
			}
		})

		it("content repeats do not confirm; content-free DTOs use spacing", () => {
			const r = rig(sample.decoder, sample.hz, sample.protocol)
			try {
				r.emit(sample.type, sample.data)
				r.clock.at += 3_000
				r.emit(sample.type, {
					...sample.data,
					timestamp: "synthetic later",
					time: "synthetic later",
					lastSeen: new Date(r.clock.at),
					rxRssi: -21,
					rxSnr: 3,
					fecErrs: 1,
				})
				expect(r.got.some(e => e.ev.identity !== undefined)).toBe(
					sample.decoder === "multimon-ng" &&
						(sample.protocol === "aprs" || sample.data["message"] === ""),
				)
				r.got.length = 0
				r.trust.value = "unverified"
				r.emit(sample.type, {
					...sample.data,
					text: "SYNTHETIC UNTRUSTED",
					msgType: "SYNTHETIC UNTRUSTED",
				})
				expect(r.got.some(e => e.ev.identity !== undefined)).toBe(false)
				r.trust.value = "commanded"
				r.emit(sample.type, {
					...sample.data,
					text: "SYNTHETIC SECOND",
					name: "SYNTHETIC SECOND",
					msgno: "M002",
					acars: { tail: "TEST01", msgno: "M002" },
					id: sample.protocol === "lora" ? 2 : sample.data["id"],
					tg: "2",
					raw:
						sample.decoder === "direwolf"
							? ">SYNTHETIC SECOND"
							: sample.data["raw"],
					msgType: "SYNTHETIC SECOND",
				})
				expect(r.got.at(-1)?.ev.identity).toBeDefined()
			} finally {
				r.ambient.stop()
			}
		})

		it("missing tuning provenance never primes confirmation", () => {
			const r = rig(sample.decoder, sample.hz, sample.protocol)
			try {
				r.trust.value = undefined
				r.emit(sample.type, sample.data)
				expect(r.got).toEqual([])
				r.trust.value = "commanded"
				r.emit(sample.type, sample.data)
				expect(r.got.some(e => e.ev.identity !== undefined)).toBe(false)
				r.emit(sample.type, {
					...sample.data,
					text: "SYNTHETIC SECOND",
					name: "SYNTHETIC SECOND",
					msgno: "M002",
					acars: { tail: "TEST01", msgno: "M002" },
					id: sample.protocol === "lora" ? 2 : sample.data["id"],
					tg: "2",
					raw:
						sample.decoder === "direwolf"
							? ">SYNTHETIC SECOND"
							: sample.data["raw"],
					msgType: "SYNTHETIC SECOND",
				})
				expect(r.got.at(-1)?.ev.identity).toBeDefined()
			} finally {
				r.ambient.stop()
			}
		})

		const candidate = (id: string, centreHz: number, obwHz = 2_000) => ({
			observationId: id,
			discoveryId: id,
			sourceId: "fake",
			startedAt: 90_000,
			lastTrack: { centreHz, obwHz },
		})
		const match = (offsets: number[], obwHz = 2_000) => {
			const observations = offsets.map((offset, i) =>
				candidate(`d${i}`, sample.hz + offset, obwHz),
			)
			return sample.protocol === "ism"
				? [
						pickChannelObservation(
							observations,
							{
								sourceId: "fake",
								at: 100_000,
								passband: { centreHz: sample.hz, halfHz: 100_000 },
								freqHz: sample.hz,
							},
							100_000,
							2_000,
						),
					].filter(o => o !== null)
				: placeAmbientDecode(
						observations,
						{
							sourceId: "fake",
							hz: sample.hz,
							at: 100_000,
							protocol: sample.protocol as ScannerProtocol,
						},
						100_000,
						2_000,
					)
		}
		it("refuses two nearby discoveries even when one is nearer", () => {
			expect(match([0, 500])).toEqual([])
		})
		// Feature: ambient-identify-all, Property 1: protocol placement is within its reach and unambiguous
		// Validates: Requirements R2
		it("matches only within its exclusive occupied span (property)", () => {
			fc.assert(
				fc.property(fc.integer({ min: -100_000, max: 100_000 }), offset => {
					const reach =
						sample.protocol === "ism"
							? 61_000
							: ambientReachHz(sample.protocol as ScannerProtocol, 2_000)
					expect(match([offset]).length).toBe(
						(sample.protocol === "ism"
							? Math.abs(offset) <= reach
							: Math.abs(offset) < reach) ||
							(sample.protocol === "ism" && Math.abs(offset) > 80_000)
							? 1
							: 0,
					)
					expect(match([offset, offset + 1]).length).toBeLessThanOrEqual(1)
				}),
				{ numRuns: 100 },
			)
		})
	})
}

it.each(Object.entries(AMBIENT_CHANNEL_WIDTH_HZ))(
	"%s reach boundary (%s nominal width)",
	(protocol, _width) => {
		const candidate = (offset: number) => ({
			observationId: "o",
			sourceId: "fake",
			startedAt: 0,
			lastTrack: {
				centreHz: HZ + offset,
				obwHz: protocol === "adsb" ? 250_000 : 1,
			},
		})
		const match = (offset: number) =>
			placeAmbientDecode(
				[candidate(offset)],
				{
					sourceId: "fake",
					hz: HZ,
					at: 0,
					protocol: protocol as ScannerProtocol,
				},
				0,
				0,
			)
		const reach = ambientReachHz(protocol as ScannerProtocol, 1)
		expect(match(reach - 1)).toHaveLength(1)
		// ADS-B keeps its inclusive centre tolerance; point decodes exclude the boundary.
		expect(match(reach)).toHaveLength(protocol === "adsb" ? 1 : 0)
		expect(match(reach + 1)).toHaveLength(0)
	},
)

it("logs ambiguous placement once per decode, with silent shared-scope lookups", () => {
	const h = serviceHarness()
	const debug = vi.fn()
	const internal = h.service as unknown as {
		now: () => number
		log: { debug: typeof debug }
		ambientObservations: AmbientObservationIndex<{
			observationId: string
			discoveryId: string
			sourceId: string
			startedAt: number
			lastTrack: { centreHz: number; obwHz: number }
		}>
		placeAmbient(e: {
			sourceId: string
			hz: number
			at: number
			protocol: "acars"
			decodeToken: object
		}): unknown[]
		ambientConfirmScope(ctx: {
			sourceId: string
			hz: number
			at: number
			protocol: "acars"
		}): string | null
	}
	internal.now = () => 100_000
	internal.log = { debug }
	try {
		for (const [i, offset] of [-500, 500].entries())
			internal.ambientObservations.upsert({
				observationId: `o${i}`,
				discoveryId: `d${i}`,
				sourceId: "fake",
				startedAt: 90_000,
				lastTrack: { centreHz: HZ + offset, obwHz: 2_000 },
			})
		const e = {
			sourceId: "fake",
			hz: HZ,
			at: 95_000,
			protocol: "acars" as const,
			decodeToken: {},
		}
		for (let i = 0; i < 5; i++)
			expect(internal.ambientConfirmScope(e)).toBeNull()
		expect(debug).not.toHaveBeenCalled()
		for (let i = 0; i < 5; i++) expect(internal.placeAmbient(e)).toEqual([])
		expect(debug).toHaveBeenCalledTimes(1)
		internal.placeAmbient({ ...e, decodeToken: {} })
		expect(debug).toHaveBeenCalledTimes(2)
	} finally {
		rmSync(h.dir, { recursive: true, force: true })
	}
})

it("queries occupied spans plus tolerance even beyond the widest half-width", () => {
	const index = new AmbientObservationIndex()
	const o = {
		observationId: "o",
		sourceId: "fake",
		startedAt: 0,
		lastTrack: { centreHz: HZ + 52_499, obwHz: 100_000 },
	}
	index.upsert(o)
	const candidates = index.window("fake", HZ, ambientReachHz("acars", 0), true)
	expect(candidates).toEqual([o])
	expect(
		placeAmbientDecode(
			candidates,
			{ sourceId: "fake", hz: HZ, at: 0, protocol: "acars" },
			0,
			0,
		),
	).toEqual([o])
})

it("updates the frequency index on centre movement and expiry", () => {
	const index = new AmbientObservationIndex()
	const o = {
		observationId: "o",
		sourceId: "fake",
		startedAt: 0,
		lastTrack: { centreHz: HZ, obwHz: 25_000 },
	}
	index.upsert(o)
	expect(index.window("fake", HZ, 0)).toEqual([o])
	o.lastTrack.centreHz += 25_000
	index.upsert(o)
	expect(index.window("fake", HZ, 0)).toEqual([])
	expect(index.window("fake", HZ + 25_000, 0)).toEqual([o])
	index.remove("o")
	expect(index.window("fake", HZ + 25_000, 0)).toEqual([])
})

for (const sample of fixtures) {
	for (const edge of [false, true])
		it(`${sample.decoder}/${sample.protocol} promotes a carrier discovery with protocol and decoded proof, edge=${edge}`, async () => {
			const clock = { at: 100_000 }
			const trust = {
				value: "commanded" as "commanded" | "unverified" | undefined,
			}
			const h = serviceHarness({
				centreHz: sample.hz - 50_000,
				patch: settings => {
					settings.passive.enabled = false
				},
				decoderConfigs: [
					{
						id: "synthetic",
						type: sample.decoder,
						enabled: true,
						sourceId: "rtl",
						frequencies: [sample.hz],
						options: sample.protocol === "nxdn48" ? { mode: "nxdn48" } : {},
					} as DecoderConfig,
				],
				ambientTrust: () => trust.value,
			})
			const decoder = new EventEmitter()
			const status = {
				id: "synthetic",
				type: sample.decoder,
				owner: "config",
				running: true,
				health: "running",
			}
			Object.assign(h.decoders, {
				getAllStatus: () => [status],
				getStatus: () => status,
				getDecoder: () =>
					Object.assign(decoder, {
						caps: { input: "iq" },
						getChannelRequest: () => ({ bandwidthHz: 125_000 }),
					}),
			})
			const internal = h.service as unknown as {
				now: () => number
				store: DiscoveryStore
				knownProtocols: {
					recordMiss(id: string, protocol: ScannerProtocol): void
					known(id: string): ScannerProtocol | null
				}
				onTrack(
					sourceId: string,
					event: { kind: "track-open" | "track-update"; track: TrackSnapshot },
				): void
			}
			internal.now = () => clock.at
			await h.service.start()
			try {
				await h.service.createJob({
					sourceId: "rtl",
					mode: "in-window",
					signalsOnly: true,
				})
				const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()
				const track = trackOf({
					trackId: "synthetic",
					sourceId: "rtl",
					stream: epoch.stream,
					epoch: epoch.epoch,
					centreHz: sample.hz,
					obwHz: 2_000,
					gate: "passed",
					flags: { ...trackOf().flags, edge },
				})
				internal.onTrack("rtl", { kind: "track-open", track })
				clock.at += 1_100
				internal.onTrack("rtl", { kind: "track-update", track })
				expect(internal.store.snapshot().discoveries).toHaveLength(1)
				for (const value of [1, 2]) {
					const data = {
						...sample.data,
						value,
						text: `SYNTHETIC ${value}`,
						name: `SYNTHETIC ${value}`,
						msgno: `M${value}`,
						acars: { tail: "TEST01", msgno: `M${value}` },
						id: sample.protocol === "lora" ? value : sample.data["id"],
						tg: String(value),
						raw:
							sample.decoder === "direwolf"
								? `>SYNTHETIC ${value}`
								: sample.data["raw"],
						msgType: `SYNTHETIC ${value}`,
					}
					if (sample.type === "link")
						h.decoders.emit(
							"decoder:placed-link",
							"synthetic",
							{ ...data, verified: true, at: clock.at },
							{ sourceId: "rtl", channelHz: sample.hz },
						)
					else
						h.decoders.emitOutput("synthetic", {
							type: sample.type,
							data,
							timestamp: new Date(clock.at),
							provenanceBinding: { sourceId: "rtl", channelHz: sample.hz },
						} as never)
					clock.at += 2_000
				}
				const id = internal.store.snapshot().discoveries[0]!.id
				const d = internal.store.get(id)
				expect(d).toMatchObject({
					confidence: "decoded",
					protocol: sample.protocol,
					proof: {
						kind: "decoded",
						protocol: sample.protocol,
						transport: "ambient",
					},
				})
				expect(h.service.trialMemoryOf(id)).toEqual([
					expect.objectContaining({
						protocol: sample.protocol,
						decoder: sample.decoder,
						attempts: 1,
						decoded: 1,
						consecutiveFailures: 0,
					}),
				])
				internal.knownProtocols.recordMiss(
					id,
					sample.protocol as ScannerProtocol,
				)
				internal.knownProtocols.recordMiss(
					id,
					sample.protocol as ScannerProtocol,
				)
				expect(internal.knownProtocols.known(id)).toBeNull()
				const send = (value: number) => {
					const data = {
						...sample.data,
						text: `SYNTHETIC ${value}`,
						name: `SYNTHETIC ${value}`,
						msgno: `M${value}`,
						acars: { tail: "TEST01", msgno: `M${value}` },
						id: sample.protocol === "lora" ? value : sample.data["id"],
						tg: String(value),
						raw:
							sample.decoder === "direwolf"
								? `>SYNTHETIC ${value}`
								: sample.data["raw"],
						value,
						msgType: `SYNTHETIC ${value}`,
					}
					if (sample.type === "link")
						h.decoders.emit(
							"decoder:placed-link",
							"synthetic",
							{ ...data, verified: true, at: clock.at },
							{ sourceId: "rtl", channelHz: sample.hz },
						)
					else
						h.decoders.emitOutput("synthetic", {
							type: sample.type,
							data,
							timestamp: new Date(clock.at),
							provenanceBinding: { sourceId: "rtl", channelHz: sample.hz },
						} as never)
					clock.at += 2_000
				}
				trust.value = "unverified"
				send(3)
				expect(internal.knownProtocols.known(id)).toBeNull()
				expect(h.service.trialMemoryOf(id)[0]?.attempts).toBe(1)
				trust.value = "commanded"
				send(4)
				expect(internal.knownProtocols.known(id)).toBe(sample.protocol)
				expect(h.service.trialMemoryOf(id)[0]).toMatchObject({
					attempts: 2,
					decoded: 2,
					consecutiveFailures: 0,
				})
			} finally {
				await h.service.stop()
				rmSync(h.dir, { recursive: true, force: true })
			}
		})
}

it("indexes every live-map insertion, replacement, deletion and clear", () => {
	const index = new AmbientObservationIndex()
	const live = new AmbientObservationMap(index)
	const observation = (id: string) => ({
		observationId: id,
		sourceId: "fake",
		startedAt: 0,
		lastTrack: { centreHz: HZ, obwHz: 1 },
	})
	const first = observation("first")
	live.set("track", first)
	expect(index.window("fake", HZ, 0)).toEqual([first])
	const replacement = observation("replacement")
	live.set("track", replacement)
	expect(index.window("fake", HZ, 0)).toEqual([replacement])
	live.delete("track")
	expect(index.window("fake", HZ, 0)).toEqual([])
	live.set("track", first)
	live.clear()
	expect(index.window("fake", HZ, 0)).toEqual([])
})

it("removes the old source entry even when a mutable observation changes source", () => {
	const index = new AmbientObservationIndex()
	const observation = {
		observationId: "o",
		sourceId: "first",
		startedAt: 0,
		lastTrack: { centreHz: HZ, obwHz: 1 },
	}
	index.upsert(observation)
	observation.sourceId = "second"
	index.upsert(observation)
	expect(index.window("first", HZ, 0)).toEqual([])
	expect(index.window("second", HZ, 0)).toEqual([observation])
})

describe("logical identity regressions", () => {
	it("preserves dumpvdl2's three-character message numbers ending in letters", () => {
		const r = rig("dumpvdl2")
		try {
			for (const msgno of ["M0A", "M0B"])
				r.emit("vdl2", {
					frequency: HZ,
					fromaddr: "ABC001",
					acars: { tail: "TEST01", msgno },
				})
			expect(r.got.at(-1)?.ev.identity).toBeDefined()
		} finally {
			r.ambient.stop()
		}
	})

	it.each([
		{ messageType: "alpha", message: "" },
		{ messageType: "unknown", message: "" },
	])("content-free paging uses spacing alone: %j", page => {
		const r = rig("multimon-ng")
		try {
			r.clock.at = 0
			const data = {
				protocol: "POCSAG1200",
				address: 1234567,
				function: 0,
				...page,
			}
			r.emit("message", data)
			expect(r.got.some(e => e.ev.identity)).toBe(false)
			r.emit("message", data)
			expect(r.got.at(-1)?.ev.identity).toMatchObject({
				kind: "pocsag-capcode",
				value: "1234567",
			})
		} finally {
			r.ambient.stop()
		}
	})

	it.each(["POCSAG1200", "FLEX"])(
		"%s pages with content need different text",
		protocol => {
			const r = rig("multimon-ng")
			const data = {
				protocol,
				address: 1234567,
				capcode: "1234567",
				function: 0,
				messageType: protocol === "FLEX" ? "ALN" : "alpha",
				message: "SYNTHETIC FIRST",
			}
			try {
				r.emit("message", data)
				r.emit("message", data)
				expect(r.got.some(e => e.ev.identity)).toBe(false)
				r.emit("message", { ...data, message: "SYNTHETIC SECOND" })
				expect(r.got.at(-1)?.ev.identity?.value).toBe("1234567")
			} finally {
				r.ambient.stop()
			}
		},
	)

	it.each(["raw", "header", "info"])(
		"Direwolf %s identity ignores routing and extra fields",
		shape => {
			const r = rig("direwolf")
			const packet = (info: string, repeated: boolean) => ({
				source: "TEST01",
				destination: "TEST02",
				path: repeated ? ["TEST03*"] : [],
				via: repeated ? "TEST03" : "TEST04",
				digipeater: repeated ? "TEST03" : "TEST04",
				comment: repeated ? "SYNTHETIC EXTRA" : "SYNTHETIC ORIGINAL",
				...(shape === "info"
					? { info, raw: repeated ? ">IGNORED SECOND" : ">IGNORED FIRST" }
					: {
							raw:
								shape === "header"
									? `TEST01>TEST02${repeated ? ",TEST03*" : ""}:${info}`
									: info,
						}),
			})
			try {
				r.emit("aprs", packet(">SYNTHETIC: FIRST", false))
				r.emit("aprs", packet(">SYNTHETIC: FIRST", true))
				expect(r.got.some(e => e.ev.identity)).toBe(false)
				r.emit("aprs", packet(">SYNTHETIC: SECOND", true))
				expect(r.got.at(-1)?.ev.identity?.value).toBe("TEST01")
			} finally {
				r.ambient.stop()
			}
		},
	)

	it("multimon APRS via changes do not bypass spacing", () => {
		const r = rig("multimon-ng")
		const data = { protocol: "AFSK1200", from: "TEST01", to: "TEST02" }
		try {
			r.emit("decode", { ...data, via: "TEST03" })
			r.clock.at = 100_100
			r.emit("decode", { ...data, via: "TEST04" })
			expect(r.got.some(e => e.ev.identity)).toBe(false)
			r.clock.at = 102_000
			r.emit("decode", { ...data, via: "TEST04" })
			expect(r.got.at(-1)?.ev.identity?.value).toBe("TEST01")
		} finally {
			r.ambient.stop()
		}
	})

	it.each([
		[
			"acarsdec",
			"acars",
			{ tail: "TEST01", msgno: "M01A", blockId: "A", error: 0, level: -20 },
			{ level: -21 },
			100,
		],
		[
			"acarsdec",
			"acars",
			{ tail: "TEST01", msgno: "M01A", blockId: "A", error: 0 },
			{ msgno: "M01B", blockId: "B", text: "SYNTHETIC NEXT BLOCK" },
			2_000,
		],
		[
			"dumpvdl2",
			"vdl2",
			{
				fromaddr: "ABC001",
				acars: { tail: "TEST01", msgno: "M01" },
				level: -20,
			},
			{ level: -21, noiseFloor: -50 },
			2_000,
		],
		[
			"rtl433",
			"signal",
			{ model: "SyntheticSensor", id: 1, mic: "CRC", value: 1, rssi: -20 },
			{ rssi: -21 },
			2_000,
		],
	])(
		"%s metadata/block repeats never confirm",
		(decoder, output, first, change, separation) => {
			const r = rig(decoder)
			try {
				r.emit(output, first)
				r.clock.at = 100_000 + separation
				r.emit(output, { ...first, ...change })
				expect(r.got.some(e => e.ev.identity !== undefined)).toBe(false)
			} finally {
				r.ambient.stop()
			}
		},
	)

	it("VDL2 non-ACARS address-only frames retain spacing-only pairing", () => {
		const r = rig("dumpvdl2")
		try {
			r.emit("vdl2", { fromaddr: "ABC001", level: -20 })
			r.clock.at = 100_100
			r.emit("vdl2", { fromaddr: "ABC001", level: -21 })
			expect(r.got.some(e => e.ev.identity !== undefined)).toBe(false)
			r.clock.at = 102_000
			r.emit("vdl2", { fromaddr: "ABC001", level: -22 })
			expect(r.got.at(-1)?.ev.identity).toBeDefined()
		} finally {
			r.ambient.stop()
		}
	})
})

it("two placed channels hearing one emission cannot confirm a discovery", () => {
	const r = rig("acarsdec")
	try {
		r.emit("acars", { frequency: 0, tail: "TEST01", msgno: "M01A", error: 0 })
		r.clock.at = 100_100
		r.decoders.emit("decoder:output", "synthetic", {
			type: "acars",
			data: { frequency: 0, tail: "TEST01", msgno: "M002", error: 0 },
			timestamp: new Date(r.clock.at),
			provenanceBinding: { sourceId: "fake", channelHz: HZ + 1_000 },
		})
		expect(r.got.some(e => e.ev.identity !== undefined)).toBe(false)
	} finally {
		r.ambient.stop()
	}
})
