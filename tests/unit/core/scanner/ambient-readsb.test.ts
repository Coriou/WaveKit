/**
 * ADS-B ambient identification: a running readsb names the ICAO address of the 1090 MHz signal
 * on its second CRC-proven message; single, CRC-failed and malformed messages never count.
 */
import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	modeSCrcRemainder,
	parseBeastMessage,
	parseSbsLine,
	parseJsonAircraft,
	ReadsbDecoder,
} from "../../../../src/decoders/builtin/readsb.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
	ADSB_FRAMES_MAX,
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"
import { resolveAmbientTargets } from "../../../../src/core/scanner/probes/ambient-target.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import {
	ADSB_HZ,
	parseReadsb,
} from "../../../../src/core/scanner/probes/confirm/readsb.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { createDecoderProvenanceIndex } from "../../../../src/decoders/provenance-bindings.js"
import { ambientTrustFromBinding } from "../../../../src/core/scanner/probes/ambient-trust.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

/** Synthetic DF17 with generated parity. */
const DF17 = frameOf(0x8d, 0xabc123, [0, 0, 0, 0, 0, 0, 0])

/** A long Mode S frame with its CRC-24 parity: first byte, 24-bit address, 7 payload bytes. */
function frameOf(first: number, address: number, payload: number[]): Buffer {
	const data = Buffer.from([
		first,
		(address >> 16) & 0xff,
		(address >> 8) & 0xff,
		address & 0xff,
		...payload,
		0,
		0,
		0,
	])
	// the parity is the CRC-24 of the 88 data bits; the whole frame then leaves remainder 0
	const parity = modeSCrcRemainder(data.subarray(0, 11))
	data[11] = (parity >> 16) & 0xff
	data[12] = (parity >> 8) & 0xff
	data[13] = parity & 0xff
	return data
}
/** Another DF17 message (different payload) from the same address as DF17. */
const DF17_B = frameOf(
	0x8d,
	0xabc123,
	[0x58, 0xc3, 0x82, 0xd6, 0x90, 0xc8, 0xac],
)
/** DF18 with CF = 1: a non-ICAO address, CRC-valid. */
const DF18_CF1 = frameOf(
	0x91,
	0xabc123,
	[0x58, 0xc3, 0x82, 0xd6, 0x90, 0xc8, 0xac],
)
/** DF18 with CF = 0: an ICAO address. */
const DF18_CF0 = frameOf(
	0x90,
	0xabc123,
	[0x58, 0xc3, 0x82, 0xd6, 0x90, 0xc8, 0xac],
)

const beast = (frame: Buffer, msgType = 0x33) =>
	parseBeastMessage(msgType, Buffer.alloc(6), 0, frame)

class FakeDecoders extends EventEmitter {
	getAllStatus() {
		return [{ id: "adsb", type: "readsb", owner: "config" }] as never
	}
	getStatus() {
		return {
			id: "adsb",
			type: "readsb",
			owner: "config",
			running: true,
			health: "running",
			suspended: false,
		} as never
	}
	getDecoder() {
		return new EventEmitter() as never
	}
	out(o: DecoderOutputLike): void {
		this.emit("decoder:output", "adsb", o)
	}
}

function rig() {
	const decoders = new FakeDecoders()
	const ambient = new AmbientEvidence({
		decoders: decoders as never,
		targetOf: () => ({
			sourceId: "rtl",
			hz: ADSB_HZ,
			targetsHz: [ADSB_HZ],
			external: false,
		}),
		epochOf: () => 1,
		logger: pino({ level: "silent" }),
		now: () => 1_000,
		tuningTrustOf: () => "commanded",
	})
	const got: AmbientEvidenceEvent[] = []
	ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
	ambient.start()
	return { decoders, ambient, got }
}

const aircraft = (data: unknown, extra: Partial<DecoderOutputLike> = {}) => ({
	type: "aircraft",
	data,
	timestamp: new Date(1_000),
	...extra,
})

describe("Mode S CRC on Beast frames", () => {
	it("checks a fixed synthetic vector independently verified by polynomial long division", () => {
		// Generator polynomial 0x1fff409; fixed parity, independent of modeSCrcRemainder.
		const fixed = Buffer.from("8dabc123202cc371c32ce0cf28bc", "hex")
		expect(modeSCrcRemainder(fixed)).toBe(0)
		expect(beast(fixed)).toMatchObject({
			icao: "ABC123",
			modeS: { crcOk: true },
		})
		fixed[13]! ^= 1
		expect(modeSCrcRemainder(fixed)).not.toBe(0)
	})

	it("a DF17 frame with its parity proves its address; one flipped bit does not", () => {
		expect(modeSCrcRemainder(DF17)).toBe(0)
		expect(beast(DF17)).toMatchObject({
			icao: "ABC123",
			modeS: { df: 17, crcOk: true },
		})
		const bad = Buffer.from(DF17)
		bad[6]! ^= 0x01
		expect(modeSCrcRemainder(bad)).not.toBe(0)
		expect(beast(bad)?.modeS?.crcOk).toBe(false)
	})

	it("a DF18 is an ICAO address only with control field 0", () => {
		expect(modeSCrcRemainder(DF18_CF1)).toBe(0)
		expect(modeSCrcRemainder(DF18_CF0)).toBe(0)
		expect(beast(DF18_CF1)?.modeS).toMatchObject({ df: 18, crcOk: false })
		expect(beast(DF18_CF0)?.modeS).toMatchObject({ df: 18, crcOk: true })
	})

	it("a format whose parity hides the address (DF4) and a wrong length are never proven", () => {
		const df4 = Buffer.from([0x20, 0xab, 0xc1, 0x23, 0, 0, 0])
		expect(beast(df4, 0x32)?.modeS).toMatchObject({ df: 4, crcOk: false })
		// a long frame announced as short
		expect(beast(DF17, 0x32)?.modeS?.crcOk).toBe(false)
	})
})

describe("readsb ambient interpreter", () => {
	it("never traverses ADS-B DTO content for shared message hashing", () => {
		const r = rig()
		let reads = 0
		try {
			for (const n of [0, 1]) {
				const frame = frameOf(0x8d, 0xabc001, [n, 0, 0, 0, 0, 0, 0])
				const data = beast(frame)!
				Object.defineProperty(data, "syntheticContent", {
					enumerable: true,
					get: () => {
						reads++
						return "SYNTHETIC"
					},
				})
				r.decoders.out(aircraft(data))
			}
			expect(r.got.some(e => e.ev.identity)).toBe(true)
			expect(reads).toBe(0)
		} finally {
			r.ambient.stop()
		}
	})

	it("targets 1090 MHz by default", () => {
		const cfg = {
			id: "adsb",
			type: "readsb",
			options: {},
		} as unknown as DecoderConfig
		const t = resolveAmbientTargets(cfg, {
			defaultSourceId: () => "rtl",
			caps: () => ({ centerFreq: ADSB_HZ }),
			inputKind: () => "iq",
		})
		expect(t).toEqual({
			sourceId: "rtl",
			hz: ADSB_HZ,
			targetsHz: [ADSB_HZ],
			external: false,
		})
	})

	it("names the ICAO on the second CRC-proven message, at 1090 MHz; a single one is no evidence", () => {
		const r = rig()
		r.decoders.out(aircraft(beast(DF17)))
		expect(r.got).toEqual([])
		r.decoders.out(aircraft(beast(DF17_B)))
		expect(r.got).toHaveLength(1)
		expect(r.got[0]).toMatchObject({
			decoderId: "adsb",
			sourceId: "rtl",
			hz: ADSB_HZ,
			ev: {
				protocol: "adsb",
				identity: { kind: "icao", value: "abc123" },
				crcClean: true,
				origin: "ambient",
			},
		})
	})

	it("an exact repeat of the previous raw frame is not a second message; a CF=1 DF18 never primes", () => {
		const r = rig()
		r.decoders.out(aircraft(beast(DF18_CF1)))
		r.decoders.out(aircraft(beast(DF17)))
		r.decoders.out(aircraft(beast(DF17)))
		expect(r.got).toEqual([])
		r.decoders.out(aircraft(beast(DF17_B)))
		expect(r.got.map(e => e.ev.identity?.value)).toEqual(["abc123"])
	})

	it("remembers the last frame of at most ADSB_FRAMES_MAX addresses, the oldest evicted", () => {
		const r = rig()
		const frames = () =>
			(
				r.ambient as unknown as {
					states: Map<string, { frames?: Map<string, string> }>
				}
			).states.get("adsb\u00001090000000")?.frames
		const payload = [0x58, 0xc3, 0x82, 0xd6, 0x90, 0xc8, 0xac]
		const send = (n: number) =>
			r.decoders.out(aircraft(beast(frameOf(0x8d, 0x100000 + n, payload))))
		for (let n = 0; n < ADSB_FRAMES_MAX; n++) send(n)
		expect(ADSB_FRAMES_MAX).toBe(4096)
		expect(frames()?.size).toBe(ADSB_FRAMES_MAX)
		expect(frames()?.has("100000")).toBe(true)
		send(ADSB_FRAMES_MAX)
		expect(frames()?.size).toBe(ADSB_FRAMES_MAX)
		expect(frames()?.has("100000")).toBe(false)
		expect(frames()?.has((0x100000 + ADSB_FRAMES_MAX).toString(16))).toBe(true)
	})

	it("uses the placement's channel when the output carries one", () => {
		const parsed = parseReadsb(
			aircraft(
				{
					icao: "abc123",
					messageCount: 2,
					lastSeen: new Date(1000),
					readsbFormat: "json",
					jsonSourceTimestamp: new Date(1000),
				},
				{ provenanceBinding: { sourceId: "rtl", channelHz: ADSB_HZ + 200 } },
			),
			{ targetsHz: [ADSB_HZ] },
		)
		expect(parsed?.hz).toBe(ADSB_HZ + 200)
	})

	it("CRC failures, hidden addresses, non-ICAO and malformed data never count nor prime", () => {
		const r = rig()
		const bad = Buffer.from(DF17)
		bad[13]! ^= 0x80
		for (const data of [
			beast(bad),
			beast(Buffer.from([0x20, 0xab, 0xc1, 0x23, 0, 0, 0]), 0x32),
			{ icao: "~abc123" },
			{ icao: "4840D" },
			{ icao: "ABC123", modeS: { df: 17, crcOk: "yes" } },
			{ icao: "ABC123", modeS: null },
			{ icao: 0xabc123 },
			null,
			"ABC123",
			[],
		])
			r.decoders.out(aircraft(data))
		r.decoders.out({
			type: "signal",
			data: { icao: "ABC123" },
			timestamp: new Date(1_000),
		})
		expect(r.got).toEqual([])
		// the bad ones primed nothing: one good message is still no identity
		r.decoders.out(aircraft(beast(DF17)))
		expect(r.got).toEqual([])
	})

	// Feature: adsb-ambient, Property 1: only the second CRC-proven message of an ICAO names it
	it("property: evidence only for an ICAO with at least two proven messages, from its second on", () => {
		const icaos = ["abc123", "abc124", "00ff00"]
		const msg = fc.oneof(
			fc.record({
				kind: fc.constant("good" as const),
				icao: fc.constantFrom(...icaos),
			}),
			fc.record({
				kind: fc.constant("bad" as const),
				data: fc.oneof(
					fc.record({
						icao: fc.constantFrom(...icaos),
						modeS: fc.record({
							df: fc.integer({ min: 0, max: 31 }),
							crcOk: fc.constant(false),
						}),
					}),
					fc
						.record({ icao: fc.string({ maxLength: 8 }) })
						.filter(d => !/^[0-9A-Fa-f]{6}$/.test(d.icao)),
					fc.anything(),
				),
			}),
		)
		fc.assert(
			fc.property(fc.array(msg, { maxLength: 30 }), msgs => {
				const r = rig()
				const seen = new Map<string, number>()
				let expected = 0
				for (const m of msgs) {
					if (m.kind === "good") {
						const n = (seen.get(m.icao) ?? 0) + 1
						seen.set(m.icao, n)
						if (n >= 2) expected++
						r.decoders.out(
							aircraft(
								beast(
									frameOf(0x8d, parseInt(m.icao, 16), [n, 0, 0, 0, 0, 0, 0]),
								),
							),
						)
					} else r.decoders.out(aircraft(m.data))
				}
				expect(r.got).toHaveLength(expected)
				for (const e of r.got) {
					expect(e.ev.identity?.kind).toBe("icao")
					expect(seen.get(e.ev.identity!.value) ?? 0).toBeGreaterThanOrEqual(2)
				}
				r.ambient.stop()
			}),
			{ numRuns: 100 },
		)
	})
})

/** Synthetic SBS source line; all fields, including type and timestamps, are source content. */
function sbsLine(time: string): string {
	return `MSG,3,1,1,ABC123,1,2026/01/01,${time},2026/01/01,00:00:09.000,,12000,,,,,,,,,,0`
}

describe("scanner service: a 1090 MHz signal becomes ADS-B identified", () => {
	/** The production wiring: the service's own AmbientEvidence with its shared confirmation. */
	async function serviceRig(
		mode:
			| "trusted"
			| "unknown"
			| "external"
			| "outside"
			| "declared" = "trusted",
		options: { observation?: "wide" | "none" | "carrier"; dir?: string } = {},
	) {
		let provenance: ReturnType<typeof createDecoderProvenanceIndex> | undefined
		const h = serviceHarness({
			...(options.dir ? { dir: options.dir } : {}),
			centreHz: ADSB_HZ,
			patch: s => {
				s.passive.enabled = false
			},
			decoderConfigs: [
				{
					id: "readsb",
					type: "readsb",
					sourceId: "rtl",
					options: {},
				} as unknown as DecoderConfig,
			],
			ambientTrust: (id, hz, sourceId, placement) =>
				ambientTrustFromBinding(
					provenance?.lookup(id, placement),
					hz,
					sourceId,
				),
		})
		const status = {
			id: "readsb",
			type: "readsb",
			owner: "config",
			running: true,
			health: "running",
			suspended: false,
		}
		h.tuner.states.get("rtl")!.sampleRate = 2_400_000
		h.sources.setCaps("rtl", { sampleRate: 2_400_000 })
		const decoder = new ReadsbDecoder(
			{
				id: "readsb",
				type: "readsb",
				enabled: true,
				options: mode === "external" ? { rtlTcpHost: "synthetic.invalid" } : {},
			} as DecoderConfig,
			pino({ level: "silent" }),
		)
		const decoders = h.decoders as unknown as {
			getAllDecoders: () => { id: string }[]
			getAllStatus: () => unknown[]
			getStatus: (id: string) => unknown
			getDecoder: (id: string) => unknown
		}
		decoders.getAllStatus = () => [status]
		decoders.getStatus = id => (id === "readsb" ? { ...status } : undefined)
		decoders.getDecoder = id => (id === "readsb" ? decoder : undefined)
		decoders.getAllDecoders = () => [{ id: "readsb" }]
		if (mode === "unknown") h.tuner.known.get("rtl")!.delete("frequency")
		if (mode === "declared")
			h.tuner.declared.set("rtl", new Set(["frequency", "sampleRate"]))
		if (mode === "outside")
			h.tuner.states.get("rtl")!.frequency = ADSB_HZ + 2_000_000
		provenance = createDecoderProvenanceIndex(
			h.decoders as never,
			() => "rtl",
			h.tuner,
		)
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
		})
		const internals = h.service as unknown as {
			store: DiscoveryStore
			live: Map<string, LiveObservation>
			now: () => number
		}
		const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()
		const track = trackOf({
			trackId: "adsb-1",
			stream: epoch.stream,
			epoch: epoch.epoch,
			centreHz: ADSB_HZ + 20_000,
			obwHz: options.observation === "carrier" ? 2_000 : 1_200_000,
			blocks: 1,
			gate: "pending",
			flags: { ...trackOf().flags, burst: true },
		})
		const startedAt = Date.now()
		if (options.observation !== "none")
			internals.live.set("adsb-1", {
				observationId: "adsb-1",
				sourceId: "rtl",
				trackId: "adsb-1",
				epoch: epoch.epoch,
				jobIds: [job.id],
				discoveryId: null,
				startedAt,
				classification: classifySpectral(track, { priors: {}, protocols: [] }),
				probeIds: new Set(),
				lastActivityAt: startedAt,
				lastIngestAt: startedAt,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			})
		let clock = Math.max(
			startedAt,
			...internals.store
				.snapshot()
				.discoveries.map(d => Date.parse(d.lastSeenAt)),
		)
		internals.now = () => clock
		;(internals.store as unknown as { now: () => number }).now = () => clock
		/** One readsb output `dtMs` after the previous, through the manager's output event. */
		const send = (data: unknown, dtMs = 500): void => {
			clock += dtMs
			const output = {
				decoder: "readsb",
				type: "aircraft",
				data,
				timestamp: new Date(clock),
				provenanceBinding: { sourceId: "rtl", channelHz: null },
			}
			h.decoders.emitOutput("readsb", output)
		}
		return {
			h,
			internals,
			send,
			provenance,
			advance: (ms: number) => {
				clock += ms
			},
		}
	}

	it.each(["trusted", "unknown", "external", "outside", "declared"] as const)(
		"advancing SBS-shaped aircraft records through production provenance: %s",
		async mode => {
			const { h, internals, send, provenance } = await serviceRig(mode)
			try {
				send(parseSbsLine(sbsLine("00:00:01.000")))
				expect(internals.store.snapshot().discoveries).toEqual([])
				send(parseSbsLine(sbsLine("00:00:03.000")), 2000)
				const discoveries = internals.store.snapshot().discoveries
				if (mode === "trusted") {
					expect(discoveries).toHaveLength(1)
					expect(internals.store.get(discoveries[0]!.id)).toMatchObject({
						protocol: "adsb",
						confidence: "decoded",
					})
				} else expect(discoveries).toEqual([])
			} finally {
				await h.service.stop()
				provenance.dispose()
			}
		},
	)

	it.each([
		[
			"identical line replayed",
			sbsLine("00:00:01.000"),
			sbsLine("00:00:01.000"),
			false,
		],
		[
			"one burst delayed in processing",
			sbsLine("00:00:01.000"),
			sbsLine("00:00:01.999"),
			false,
		],
		[
			"distinct source messages two seconds apart",
			sbsLine("00:00:01.000"),
			sbsLine("00:00:03.000"),
			true,
		],
		[
			"malformed generated time",
			sbsLine("25:00:01.000"),
			sbsLine("25:00:03.000"),
			false,
		],
	] as const)(
		"%s through adapter and production trust",
		async (_name, first, second, decoded) => {
			const { h, internals, send, provenance } = await serviceRig()
			try {
				send(parseSbsLine(first))
				send(parseSbsLine(second), 2000)
				const discoveries = internals.store.snapshot().discoveries
				expect(discoveries).toHaveLength(decoded ? 1 : 0)
				if (decoded)
					expect(discoveries[0]).toMatchObject({
						confidence: "decoded",
						protocol: "adsb",
					})
			} finally {
				await h.service.stop()
				provenance.dispose()
			}
		},
	)

	it.each([
		["replayed JSON snapshot", 2, 1, false],
		["JSON burst delayed in processing", 3, 2.999, false],
		["JSON source-time advancement", 3, 3, true],
		["JSON without source epoch", 3, undefined, false],
	] as const)(
		"%s through adapter and production trust",
		async (_name, messages, now, decoded) => {
			const { h, internals, send, provenance } = await serviceRig()
			try {
				send(parseJsonAircraft({ hex: "abc123", messages: 2, now: 1, seen: 0 }))
				send(parseJsonAircraft({ hex: "abc123", messages, now, seen: 0 }), 2000)
				expect(internals.store.snapshot().discoveries).toHaveLength(
					decoded ? 1 : 0,
				)
			} finally {
				await h.service.stop()
				provenance.dispose()
			}
		},
	)

	it("two CRC-valid messages 500 ms apart identify; single, bad and repeated frames leave no record", async () => {
		const { h, internals, send, provenance } = await serviceRig()
		try {
			const bad = Buffer.from(DF17)
			bad[2]! ^= 0x10
			send(beast(bad))
			send({ icao: "~123456" })
			send(beast(DF18_CF1))
			send(beast(DF17))
			// an exact repeat of the same raw frame is not a second message
			send(beast(DF17))
			expect(internals.store.snapshot().discoveries).toEqual([])
			expect(internals.live.get("adsb-1")?.discoveryId).toBeNull()
			send(beast(DF17_B))
			const discoveries = internals.store.snapshot().discoveries
			expect(discoveries).toHaveLength(1)
			const d = internals.store.get(discoveries[0]!.id)
			expect(d?.protocol).toBe("adsb")
			expect(d?.confidence).toBe("decoded")
		} finally {
			await h.service.stop()
			provenance.dispose()
		}
	})
	it.each(["trusted", "unknown", "external", "outside", "declared"] as const)(
		"decode anchor without a spectrum observation: %s",
		async mode => {
			const r = await serviceRig(mode, { observation: "none" })
			try {
				r.send(parseSbsLine(sbsLine("00:00:01.000")))
				expect(r.internals.store.snapshot().discoveries).toEqual([])
				r.send(parseSbsLine(sbsLine("00:00:03.000")), 2000)
				const discoveries = r.internals.store.snapshot().discoveries
				expect(discoveries).toHaveLength(mode === "trusted" ? 1 : 0)
				if (mode === "trusted")
					expect(r.internals.store.get(discoveries[0]!.id)).toMatchObject({
						anchor: "decode",
						frequencyHz: ADSB_HZ,
						protocol: "adsb",
						confidence: "decoded",
						aircraftCount: 1,
						proof: { kind: "decoded", transport: "ambient" },
					})
			} finally {
				await r.h.service.stop()
				r.provenance.dispose()
			}
		},
	)

	it("refreshes one anchor, preserves it through disk restart, and expires by normal retention", async () => {
		const r = await serviceRig("trusted", { observation: "none" })
		let stopped = false
		try {
			r.send(parseSbsLine(sbsLine("00:00:01.000")))
			r.send(parseSbsLine(sbsLine("00:00:03.000")), 2000)
			const id = r.internals.store.snapshot().discoveries[0]!.id
			const first = r.internals.store.get(id)!
			r.send(parseSbsLine(sbsLine("00:00:04.000").replace("ABC123", "DEF456")))
			r.send(
				parseSbsLine(sbsLine("00:00:06.000").replace("ABC123", "DEF456")),
				2000,
			)
			expect(r.internals.store.snapshot().discoveries).toHaveLength(1)
			expect(r.internals.store.get(id)).toMatchObject({
				aircraftCount: 2,
				observationCount: 2,
			})
			expect(r.internals.store.get(id)!.lastSeenAt > first.lastSeenAt).toBe(
				true,
			)
			await r.h.service.stop()
			stopped = true
			const snapshot = r.internals.store.snapshot()
			const again = await serviceRig("trusted", {
				observation: "none",
				dir: r.h.dir,
			})
			try {
				expect(again.internals.store.snapshot()).toEqual(snapshot)
				again.send(parseSbsLine(sbsLine("00:00:10.000")))
				again.send(parseSbsLine(sbsLine("00:00:12.000")), 2000)
				expect(
					again.internals.store.snapshot().discoveries.map(d => d.id),
				).toEqual([id])
				again.advance(86_400_000)
				expect(again.internals.store.pruneInactive(1)).toEqual([])
				again.advance(1)
				expect(again.internals.store.pruneInactive(1)).toEqual([id])
			} finally {
				await again.h.service.stop()
				again.provenance.dispose()
			}
		} finally {
			if (!stopped) await r.h.service.stop()
			r.provenance.dispose()
		}
	})

	it("never credits a nearby narrow carrier with ADS-B", async () => {
		const r = await serviceRig("trusted", { observation: "carrier" })
		try {
			const live = r.internals.live.get("adsb-1")!
			live.lastTrack!.centreHz = ADSB_HZ + 10_000
			live.lastTrack!.gate = "passed"
			live.lastTrack!.snrDb = 30
			live.lastTrack!.maxBlockSnrDb = 30
			const internals = r.h.service as unknown as {
				ingest: (
					o: LiveObservation,
					t: NonNullable<LiveObservation["lastTrack"]>,
				) => void
			}
			internals.ingest(live, live.lastTrack!)
			expect(live.discoveryId).not.toBeNull()
			r.send(parseSbsLine(sbsLine("00:00:01.000")))
			r.send(parseSbsLine(sbsLine("00:00:03.000")), 2000)
			const records = r.internals.store.snapshot().discoveries
			expect(records).toHaveLength(2)
			expect(r.internals.store.get(live.discoveryId!)?.protocol).toBe("unknown")
			expect(records.find(d => d.anchor === "decode")).toMatchObject({
				protocol: "adsb",
				confidence: "decoded",
			})
			expect(r.internals.store.consolidationPlan().groups).toEqual([])
		} finally {
			await r.h.service.stop()
			r.provenance.dispose()
		}
	})
})
