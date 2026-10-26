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
import { describe, expect, it } from "vitest"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"
import { ConfirmMemory } from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"

const HZ = 131_725_000
function rig(type: string, hz = HZ, protocol?: string) {
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
		centreOf: () => hz,
		tuningTrustOf: () => trust.value,
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
				{ ...(data as object), at: clock.at },
				{ sourceId: "fake", channelHz: hz },
			)
		else
			decoders.emit("decoder:output", "synthetic", {
				type: outputType,
				data,
				timestamp: new Date(clock.at),
				provenanceBinding: { sourceId: "fake", channelHz: hz },
			})
		clock.at += 100
	}
	return { ambient, got, emit, clock, decoders, trust }
}

describe("ambient identify all regressions", () => {
	it.each([
		[
			"acarsdec",
			"acars",
			{ frequency: 0, error: 0, errorKnown: true, tail: "TEST01" },
		],
		["dumpvdl2", "vdl2", { frequency: 0, fromaddr: "ABC001" }],
	])(
		"%s uses the actual channel binding for frequency-less output and pairs fast distinct messages",
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
			r.emit("decode", { protocol: "AFSK1200", from: "TEST01", to: "TEST03" })
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

		it("duplicates never prime confirmation and untrusted content does not count", () => {
			const r = rig(sample.decoder, sample.hz, sample.protocol)
			try {
				r.emit(sample.type, sample.data)
				r.clock.at += 3_000
				r.emit(sample.type, {
					...sample.data,
					timestamp: "synthetic later",
					time: "synthetic later",
				})
				expect(r.got.some(e => e.ev.identity !== undefined)).toBe(false)
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
		it("matches only in the inclusive protocol window (property)", () => {
			fc.assert(
				fc.property(fc.integer({ min: -100_000, max: 100_000 }), offset => {
					const reach =
						sample.protocol === "ism"
							? 61_000
							: ambientReachHz(sample.protocol as ScannerProtocol, 2_000)
					expect(match([offset]).length).toBe(
						Math.abs(offset) <= reach ||
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
	"%s includes half-channel width %s / 2 and rejects one Hz past it",
	(protocol, width) => {
		const candidate = (offset: number) => ({
			observationId: "o",
			sourceId: "fake",
			startedAt: 0,
			lastTrack: { centreHz: HZ + offset, obwHz: 1 },
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
		expect(match(width / 2)).toHaveLength(1)
		expect(match(width / 2 + 1)).toHaveLength(0)
	},
)

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
						msgType: `SYNTHETIC ${value}`,
					}
					if (sample.type === "link")
						h.decoders.emit(
							"decoder:placed-link",
							"synthetic",
							{ ...data, at: clock.at },
							{ sourceId: "rtl", channelHz: sample.hz },
						)
					else
						h.decoders.emitOutput("synthetic", {
							type: sample.type,
							data,
							timestamp: new Date(clock.at),
							provenanceBinding: { sourceId: "rtl", channelHz: sample.hz },
						} as never)
					clock.at += 100
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
						value,
						msgType: `SYNTHETIC ${value}`,
					}
					if (sample.type === "link")
						h.decoders.emit(
							"decoder:placed-link",
							"synthetic",
							{ ...data, at: clock.at },
							{ sourceId: "rtl", channelHz: sample.hz },
						)
					else
						h.decoders.emitOutput("synthetic", {
							type: sample.type,
							data,
							timestamp: new Date(clock.at),
							provenanceBinding: { sourceId: "rtl", channelHz: sample.hz },
						} as never)
					clock.at += 100
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
