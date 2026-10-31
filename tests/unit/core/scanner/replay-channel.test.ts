/**
 * The raster channel of an ACARS/VDL2 replay and the decoder input it gets: snap bounds (at and
 * just past each), the dumpvdl2 replay argv (U8, 105 kHz × oversample 1, centre at DC, the raster
 * channel decoded), and acarsdec's replay chain (cf32 48 kHz, AM, 12 kHz audio). Synthetic only.
 */
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { probeReplayShapes } from "../../../../src/core/iq-capture/shapes.js"
import { replayRateHz } from "../../../../src/core/iq-capture/rates.js"
import {
	ACARS_OCCUPIED_HALF_HZ,
	AERO_DATALINK_RASTER_HZ,
	REPLAY_CHANNEL_SNAP_HZ,
	VDL2_OCCUPIED_HALF_HZ,
	VDL2_REPLAY_MAX_OFFSET_HZ,
	rasterChannelOf,
	replayChannelHz,
} from "../../../../src/core/scanner/replay-channel.js"
import {
	AERO_VHF_MAX_HZ,
	AERO_VHF_MIN_HZ,
} from "../../../../src/core/scanner/store/decode-anchor.js"
import { ambientReachHz } from "../../../../src/core/scanner/probes/ambient-placement.js"
import {
	REPLAY_PROBE_PRIORITY,
	buildProbeConfig,
	replayContext,
	type ProbeMode,
	type ProbeRequest,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import {
	ACARS_REPLAY_MODE,
	IQ_REPLAY_WIDEBAND_MODES,
} from "../../../../src/core/scanner/replay-plan.js"
import {
	DUMPVDL2_REPLAY_MAX_OFFSET_HZ,
	buildDumpvdl2ReplayArgs,
	createDumpvdl2Decoder,
	replayChannelOf,
} from "../../../../src/decoders/builtin/dumpvdl2.js"
import { createAcarsdecDecoder } from "../../../../src/decoders/builtin/acarsdec.js"
import { PassThrough } from "node:stream"

const VDL2 = 136_975_000
const ACARS = 131_550_000

describe("rasterChannelOf / replayChannelHz", () => {
	it("the snap reach is point placement's 4 000 Hz, inside the VDL2 burst margin", () => {
		expect(REPLAY_CHANNEL_SNAP_HZ).toBe(ambientReachHz("vdl2", 0))
		expect(REPLAY_CHANNEL_SNAP_HZ).toBe(4_000)
		// 12 500 Hz replay passband half-width − 8 400 Hz burst half-width = 4 100 Hz.
		expect(probeReplayShapes().dumpvdl2!.bandwidthHz / 2).toBe(12_500)
		expect(VDL2_OCCUPIED_HALF_HZ).toBe((10_500 * 1.6) / 2)
		expect(VDL2_REPLAY_MAX_OFFSET_HZ).toBe(4_100)
		expect(DUMPVDL2_REPLAY_MAX_OFFSET_HZ).toBe(VDL2_REPLAY_MAX_OFFSET_HZ)
		expect(REPLAY_CHANNEL_SNAP_HZ).toBeLessThan(VDL2_REPLAY_MAX_OFFSET_HZ)
		// ACARS: a block snapped from 3 999 Hz off still sits inside acarsdec's replay passband
		// (15 200 Hz), and the stop edge (11 600 Hz) stays short of the neighbouring channel's
		// nearest sideband (25 000 − 4 000 − 3 600 = 17 400 Hz) and the 24 kHz Nyquist edge.
		const acars = probeReplayShapes().acarsdec!
		expect(acars).toEqual({ bandwidthHz: 15_200, transitionHz: 4_000 })
		expect(REPLAY_CHANNEL_SNAP_HZ + ACARS_OCCUPIED_HALF_HZ).toBe(
			acars.bandwidthHz / 2,
		)
		expect(acars.bandwidthHz / 2 + acars.transitionHz).toBe(11_600)
		expect(acars.bandwidthHz / 2 + acars.transitionHz).toBeLessThanOrEqual(
			AERO_DATALINK_RASTER_HZ - REPLAY_CHANNEL_SNAP_HZ - ACARS_OCCUPIED_HALF_HZ,
		)
		expect(acars.bandwidthHz / 2 + acars.transitionHz).toBeLessThan(24_000)
	})

	it("snaps within 3 999 Hz of a raster channel, never at 4 000 Hz", () => {
		for (const protocol of ["acars", "vdl2"] as const) {
			expect(rasterChannelOf(protocol, VDL2)).toBe(VDL2)
			expect(rasterChannelOf(protocol, VDL2 + 3_999)).toBe(VDL2)
			expect(rasterChannelOf(protocol, VDL2 - 3_999)).toBe(VDL2)
			expect(rasterChannelOf(protocol, VDL2 + 4_000)).toBeNull()
			expect(rasterChannelOf(protocol, VDL2 - 4_000)).toBeNull()
			// half way between two channels belongs to neither
			expect(rasterChannelOf(protocol, VDL2 + 12_500)).toBeNull()
		}
	})

	it("only inside the aeronautical VHF band, endpoints included", () => {
		expect(rasterChannelOf("vdl2", AERO_VHF_MIN_HZ)).toBe(AERO_VHF_MIN_HZ)
		expect(rasterChannelOf("vdl2", AERO_VHF_MAX_HZ)).toBe(AERO_VHF_MAX_HZ)
		expect(rasterChannelOf("vdl2", AERO_VHF_MIN_HZ - 25_000)).toBeNull()
		expect(rasterChannelOf("vdl2", AERO_VHF_MAX_HZ + 25_000)).toBeNull()
		// 137.000 MHz − 1 kHz snaps to the band's last channel; + 1 kHz is still that channel
		expect(rasterChannelOf("acars", AERO_VHF_MAX_HZ + 1_000)).toBe(
			AERO_VHF_MAX_HZ,
		)
	})

	it("other protocols, and non-finite centres, keep the capture centre", () => {
		expect(rasterChannelOf("dmr", VDL2 + 1_000)).toBeNull()
		expect(replayChannelHz("dmr", VDL2 + 1_000)).toBe(VDL2 + 1_000)
		expect(rasterChannelOf("vdl2", Number.NaN)).toBeNull()
		expect(replayChannelHz("vdl2", VDL2 + 5_000)).toBe(VDL2 + 5_000)
		expect(replayChannelHz("acars", ACARS - 2_500)).toBe(ACARS)
	})

	it("property: a snapped channel is on the raster, in band and strictly within the reach", () => {
		// Feature: wg19-av replay, Property 1: raster snap
		// Validates: Requirements replay channel attribution
		fc.assert(
			fc.property(
				fc.integer({ min: 110_000_000, max: 140_000_000 }),
				fc.constantFrom("acars" as const, "vdl2" as const),
				(hz, protocol) => {
					const ch = rasterChannelOf(protocol, hz)
					const nearest =
						Math.round(hz / AERO_DATALINK_RASTER_HZ) * AERO_DATALINK_RASTER_HZ
					const inBand =
						nearest >= AERO_VHF_MIN_HZ && nearest <= AERO_VHF_MAX_HZ
					const near = Math.abs(hz - nearest) < REPLAY_CHANNEL_SNAP_HZ
					if (ch === null) return !(inBand && near)
					return (
						ch === nearest &&
						ch % AERO_DATALINK_RASTER_HZ === 0 &&
						inBand &&
						near
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("dumpvdl2 replay argv", () => {
	it("decodes the raster channel from a capture centred at DC, at most 4 100 Hz away", () => {
		expect(buildDumpvdl2ReplayArgs(VDL2)).toEqual([
			"--iq-file",
			"-",
			"--sample-format",
			"U8",
			"--oversample",
			"1",
			"--centerfreq",
			String(VDL2),
			"--output",
			"decoded:json:file:path=-",
			String(VDL2),
		])
		const at = buildDumpvdl2ReplayArgs(VDL2 + 4_100, VDL2)
		expect(at.slice(-4)).toEqual([
			String(VDL2 + 4_100),
			"--output",
			"decoded:json:file:path=-",
			String(VDL2),
		])
		expect(() => buildDumpvdl2ReplayArgs(VDL2 + 4_101, VDL2)).toThrow(
			"Invalid VDL2 replay channel",
		)
		expect(() => buildDumpvdl2ReplayArgs(VDL2 - 4_101, VDL2)).toThrow(
			"Invalid VDL2 replay channel",
		)
		expect(() => buildDumpvdl2ReplayArgs(VDL2, VDL2 + 0.5)).toThrow()
	})

	it("the replay channel is the one target frequency within 4 100 Hz of the centre, else the centre", () => {
		expect(replayChannelOf(VDL2 + 4_100, [VDL2])).toBe(VDL2)
		expect(replayChannelOf(VDL2 - 4_100, [VDL2])).toBe(VDL2)
		expect(replayChannelOf(VDL2 + 4_101, [VDL2])).toBe(VDL2 + 4_101)
		expect(replayChannelOf(VDL2, [VDL2 - 25_000, VDL2])).toBe(VDL2)
		expect(replayChannelOf(VDL2 + 1_000, [])).toBe(VDL2 + 1_000)
		expect(replayChannelOf(VDL2 + 1_000, [VDL2 + 0.5])).toBe(VDL2 + 1_000)
	})

	const request = (
		targetHz: number,
		mode: ProbeMode = IQ_REPLAY_WIDEBAND_MODES.vdl2,
	) => {
		const m = {
			...mode,
			covers: [...mode.covers],
			options: { ...mode.options },
		}
		const req: ProbeRequest & { replay: { captureId: string } } = {
			jobId: "j",
			priority: REPLAY_PROBE_PRIORITY,
			sourceId: "rtl",
			trackId: "replay-cap",
			observationId: "o",
			discoveryId: null,
			targetHz,
			epoch: 1,
			cls: "unknown",
			protocols: [m.protocol],
			preRollFromSample: null,
			holdMs: m.holdMs,
			record: false,
			admission: { kind: "undecoded", snrDb: 0 },
			modes: [m],
			replay: { captureId: "cap" },
		}
		return { req, mode: m }
	}
	const configFor = (
		targetHz: number,
		decoderType: "dumpvdl2" | "acarsdec",
	) => {
		const { req, mode } = request(
			targetHz,
			decoderType === "dumpvdl2"
				? IQ_REPLAY_WIDEBAND_MODES.vdl2
				: { ...ACARS_REPLAY_MODE, decoderType: "acarsdec" },
		)
		const transport = createReplayTransport({
			openReplay: () => new PassThrough(),
			replayRateOf: (_id, type) => replayRateHz(type, 48_000),
		})
		return buildProbeConfig({
			probeId: "p",
			req,
			mode,
			transport,
			ctx: replayContext(req),
			recordDir: null,
			ports: null,
		})
	}

	it("the replay transport gives dumpvdl2 U8 at 105 kHz, oversample 1, the raster channel", () => {
		// a track measured 1.5 kHz above its channel
		const config = configFor(VDL2 + 1_500, "dumpvdl2")
		expect(config.options).toMatchObject({
			inputSampleRate: 105_000,
			targetSampleRate: 105_000,
			inputCenterFreq: VDL2 + 1_500,
		})
		expect(config.frequencies).toEqual([VDL2])
		const decoder = createDumpvdl2Decoder(config, pino({ level: "silent" }))
		const argv = (decoder as unknown as { getArgs(): string[] }).getArgs()
		expect(argv).toEqual([
			"-c",
			`dumpvdl2 --iq-file - --sample-format U8 --oversample 1 --centerfreq ${VDL2 + 1_500} --output decoded:json:file:path=- ${VDL2}`,
		])
		// off the raster (≥ 4 kHz) the capture centre stays the channel, as before
		const off = configFor(VDL2 + 4_000, "dumpvdl2")
		expect(off.frequencies).toEqual([VDL2 + 4_000])
	})

	it("acarsdec reads the 48 kHz cf32 capture: AM there, 12 kHz audio, no shift or decimation", () => {
		const config = configFor(ACARS + 1_500, "acarsdec")
		expect(config.options).toMatchObject({
			inputIqFormat: "cf32",
			inputSampleRate: 48_000,
		})
		const decoder = createAcarsdecDecoder(config, pino({ level: "silent" }))
		const argv = (decoder as unknown as { getArgs(): string[] }).getArgs()
		expect(argv[1]).toContain("csdr amdemod")
		expect(argv[1]).toContain(
			"sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 12000 -",
		)
		expect(argv[1]).toContain(
			"acarsdec --output json:file:path=- --sndfile /dev/stdin,subtype=0x02 -m 1",
		)
		expect(argv[1]).not.toContain("shift")
		expect(argv[1]).not.toContain("firdecimate")
	})
})
