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
} from "../../../../src/decoders/builtin/readsb.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
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
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

/** A public textbook DF17 frame (airborne identification), ICAO 4840D6, CRC-24 remainder 0. */
const DF17 = Buffer.from("8D4840D6202CC371C32CE0576098", "hex")

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
	it("a DF17 frame with its parity proves its address; one flipped bit does not", () => {
		expect(modeSCrcRemainder(DF17)).toBe(0)
		expect(beast(DF17)).toMatchObject({
			icao: "4840D6",
			modeS: { df: 17, crcOk: true },
		})
		const bad = Buffer.from(DF17)
		bad[6]! ^= 0x01
		expect(modeSCrcRemainder(bad)).not.toBe(0)
		expect(beast(bad)?.modeS?.crcOk).toBe(false)
	})

	it("a format whose parity hides the address (DF4) and a wrong length are never proven", () => {
		const df4 = Buffer.from("20001838CA3804", "hex")
		expect(beast(df4, 0x32)?.modeS).toEqual({ df: 4, crcOk: false })
		// a long frame announced as short
		expect(beast(DF17, 0x32)?.modeS?.crcOk).toBe(false)
	})
})

describe("readsb ambient interpreter", () => {
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
		r.decoders.out(aircraft({ icao: "4840D6", messageCount: 1 }))
		expect(r.got).toHaveLength(1)
		expect(r.got[0]).toMatchObject({
			decoderId: "adsb",
			sourceId: "rtl",
			hz: ADSB_HZ,
			ev: {
				protocol: "adsb",
				identity: { kind: "icao", value: "4840d6" },
				crcClean: true,
				origin: "ambient",
			},
		})
	})

	it("uses the placement's channel when the output carries one", () => {
		const parsed = parseReadsb(
			aircraft(
				{ icao: "4840d6" },
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
			beast(Buffer.from("20001838CA3804", "hex"), 0x32),
			{ icao: "~4840d6" },
			{ icao: "4840D" },
			{ icao: "4840D6", modeS: { df: 17, crcOk: "yes" } },
			{ icao: "4840D6", modeS: null },
			{ icao: 0x4840d6 },
			null,
			"4840D6",
			[],
		])
			r.decoders.out(aircraft(data))
		r.decoders.out({
			type: "signal",
			data: { icao: "4840D6" },
			timestamp: new Date(1_000),
		})
		expect(r.got).toEqual([])
		// the bad ones primed nothing: one good message is still no identity
		r.decoders.out(aircraft(beast(DF17)))
		expect(r.got).toEqual([])
	})

	// Feature: adsb-ambient, Property 1: only the second CRC-proven message of an ICAO names it
	it("property: evidence only for an ICAO with at least two proven messages, from its second on", () => {
		const icaos = ["4840d6", "abc123", "00ff00"]
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
						r.decoders.out(aircraft({ icao: m.icao.toUpperCase() }))
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

describe("scanner service: a 1090 MHz signal becomes ADS-B identified", () => {
	async function serviceRig() {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
		})
		const internals = h.service as unknown as {
			store: DiscoveryStore
			live: Map<string, LiveObservation>
			onAmbientEvidence: (e: AmbientEvidenceEvent) => void
		}
		const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()
		const track = trackOf({
			trackId: "adsb-1",
			stream: epoch.stream,
			epoch: epoch.epoch,
			centreHz: ADSB_HZ + 20_000,
			obwHz: 1_200_000,
			blocks: 1,
			gate: "pending",
			flags: { ...trackOf().flags, burst: true },
		})
		const startedAt = Date.now()
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
		const r = rig()
		// the rig's events at the live epoch and time, into the scanner
		r.ambient.on("evidence", (e: AmbientEvidenceEvent) =>
			internals.onAmbientEvidence({
				...e,
				ev: { ...e.ev, epoch: epoch.epoch, at: startedAt + 10 },
			}),
		)
		return { h, internals, r }
	}

	it("single and bad messages leave no record; the second proven one names the discovery", async () => {
		const { h, internals, r } = await serviceRig()
		try {
			const bad = Buffer.from(DF17)
			bad[2]! ^= 0x10
			r.decoders.out(aircraft(beast(bad)))
			r.decoders.out(aircraft({ icao: "~123456" }))
			r.decoders.out(aircraft(beast(DF17)))
			expect(internals.store.snapshot().discoveries).toEqual([])
			expect(internals.live.get("adsb-1")?.discoveryId).toBeNull()
			r.decoders.out(aircraft(beast(DF17)))
			const discoveries = internals.store.snapshot().discoveries
			expect(discoveries).toHaveLength(1)
			const d = internals.store.get(discoveries[0]!.id)
			expect(d?.protocol).toBe("adsb")
			expect(d?.confidence).toBe("decoded")
		} finally {
			r.ambient.stop()
			await h.service.stop()
		}
	})
})
