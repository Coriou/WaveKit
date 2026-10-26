/**
 * Decoder-enablement 3.18 end to end with a SYNTHETIC POCSAG1200 burst
 * (scripts/fixtures/pocsag-iq.mjs): the planner's paging raster placements,
 * the real MultimonDecoder channel request, a reference channel filter with
 * that request's passband and transition, FM discrimination, and the real
 * multimon-ng binary when it is installed (the decode step is skipped
 * otherwise). The burst sits on a 6.25 kHz offset channel of a synthetic
 * off-raster capture at 1.024 Msps.
 */
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import pino from "pino"
import { synthesizePocsagCu8 } from "../../scripts/fixtures/pocsag-iq.mjs"
import { MultimonDecoder } from "../../src/decoders/builtin/multimon-ng.js"
import { resolveBandRequirements } from "../../src/decoders/band-defaults.js"
import { planPlacements } from "../../src/decoders/enablement/placement.js"
import { pagingRasterRanges } from "../../src/decoders/enablement/paging-plan.js"
import type { PlannerDecoder } from "../../src/decoders/enablement/contract.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import type { DecoderOutput } from "../../src/decoders/types.js"

const FS = 1_024_000
const CENTRE = 466_103_300
const BURST_HZ = 466_156_250

class Probe extends MultimonDecoder {
	args(): string[] {
		return this.getDecoderArgs()
	}
	parse(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}
}
const probe = (channelHz?: number) =>
	new Probe(
		{
			id: "pager",
			type: "multimon-ng",
			enabled: true,
			options: {
				modes: ["POCSAG512", "POCSAG1200", "POCSAG2400"],
				...(channelHz ? { channelHz } : {}),
			},
		},
		pino({ level: "silent" }),
	)

/**
 * Reference channel: mix `channelHz` to DC, windowed-sinc lowpass at the
 * middle of the request's transition band, decimate by 20 (51.2 kHz), FM
 * discriminator, linear resample to 22 050 Hz s16 (multimon-ng raw input).
 */
function channelAudio(cu8: Buffer, req: DecoderChannelRequest): Buffer {
	const n = cu8.length / 2
	const decimation = 20
	const outRate = FS / decimation
	const fc = (req.bandwidthHz / 2 + req.transitionHz / 2) / FS
	const taps = Math.ceil(4 / (req.transitionHz / FS)) | 1
	const h = new Float64Array(taps)
	const mid = (taps - 1) / 2
	for (let i = 0; i < taps; i++) {
		const x = i - mid
		const sinc =
			x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
		const w =
			0.42 -
			0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
			0.08 * Math.cos((4 * Math.PI * i) / (taps - 1))
		h[i] = sinc * w
	}
	const offset = req.centerHz - CENTRE
	const re = new Float64Array(n)
	const im = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const a = (cu8[2 * i]! - 127.5) / 127.5
		const b = (cu8[2 * i + 1]! - 127.5) / 127.5
		const p = (-2 * Math.PI * offset * i) / FS
		const c = Math.cos(p)
		const s = Math.sin(p)
		re[i] = a * c - b * s
		im[i] = a * s + b * c
	}
	const count = Math.floor((n - taps) / decimation)
	const yi = new Float64Array(count)
	const yq = new Float64Array(count)
	for (let k = 0; k < count; k++) {
		let si = 0
		let sq = 0
		const o = k * decimation
		for (let j = 0; j < taps; j++) {
			si += h[j]! * re[o + j]!
			sq += h[j]! * im[o + j]!
		}
		yi[k] = si
		yq[k] = sq
	}
	const fm = new Float64Array(count)
	for (let k = 1; k < count; k++)
		fm[k] = Math.atan2(
			yq[k]! * yi[k - 1]! - yi[k]! * yq[k - 1]!,
			yi[k]! * yi[k - 1]! + yq[k]! * yq[k - 1]!,
		)
	const rate = 22_050
	const samples = Math.floor((count * rate) / outRate)
	const out = Buffer.alloc(2 * samples)
	for (let k = 0; k < samples; k++) {
		const t = (k * outRate) / rate
		const i0 = Math.floor(t)
		const f = t - i0
		const v = (fm[i0] ?? 0) * (1 - f) + (fm[i0 + 1] ?? 0) * f
		out.writeInt16LE(
			Math.max(
				-32_767,
				Math.min(32_767, Math.round((v / Math.PI) * 1.5 * 32_767)),
			),
			2 * k,
		)
	}
	return out
}

const hasMultimon =
	spawnSync("multimon-ng", ["-h"], { stdio: "ignore" }).error === undefined

function plan(): number[] {
	const request = probe().getChannelRequest({
		sampleRateHz: FS,
		centerHz: CENTRE,
	}) as DecoderChannelRequest
	const region = { code: "EU" as const, source: "configured" as const }
	const d: PlannerDecoder = {
		id: "pager",
		type: "multimon-ng",
		origin: "config",
		order: 0,
		mode: "auto",
		startMode: "auto",
		configuredSourceId: null,
		band: resolveBandRequirements({
			type: "multimon-ng",
			declaration: {},
			region,
		}).requirements,
		configuredChannelsHz: [],
		reach: "channel",
		channelBandwidthHz: request.bandwidthHz,
		channelTransitionHz: request.transitionHz,
		protocols: ["pocsag", "flex"],
		channelPlacements: false,
		unavailable: false,
		ownDevice: false,
		centreSlotHz: null,
		centrePassbandHz: null,
		pagingRaster: pagingRasterRanges("EU"),
	}
	return planPlacements({
		decoders: [d],
		sources: [
			{
				id: "s",
				centreHz: CENTRE,
				sampleRateHz: FS,
				usableFraction: 0.8,
				dedicatedScanner: false,
				held: false,
				reservedBy: null,
				channelizerAvailable: true,
				order: 0,
			},
		],
		vfo: { sourceId: "s", frequencyHz: CENTRE },
		bandplanChannels: () => [],
		maxBandplanChannels: 4,
	}).wanted.map(w => w.channelHz!)
}

describe("paging raster, synthetic POCSAG1200 (3.18)", () => {
	const iq = synthesizePocsagCu8({
		sampleRateHz: FS,
		offsetHz: BURST_HZ - CENTRE,
		address: 1_234_567,
		message: "12345",
	})
	const channels = plan()

	it("places the offset channel and its raster neighbours with a 12 kHz filter", () => {
		expect(channels).toContain(BURST_HZ)
		for (const hz of [BURST_HZ - 6250, BURST_HZ + 6250, BURST_HZ - 12_500])
			expect(channels).toContain(hz)
		const req = probe(BURST_HZ).getChannelRequest({
			sampleRateHz: FS,
			centerHz: CENTRE,
		}) as DecoderChannelRequest
		expect(req).toMatchObject({
			centerHz: BURST_HZ,
			bandwidthHz: 12_000,
			transitionHz: 2500,
			outputRateHz: 48_000,
		})
	})

	it.skipIf(!hasMultimon)(
		"the burst decodes on its own channel and on no neighbour",
		() => {
			const decoded = new Map<number, unknown[]>()
			for (const hz of [
				BURST_HZ,
				BURST_HZ - 6250,
				BURST_HZ + 6250,
				BURST_HZ - 12_500,
				BURST_HZ + 12_500,
			].filter(f => channels.includes(f))) {
				const p = probe(hz)
				const req = p.getChannelRequest({
					sampleRateHz: FS,
					centerHz: CENTRE,
				}) as DecoderChannelRequest
				const run = spawnSync("multimon-ng", p.args(), {
					input: channelAudio(iq, req),
				})
				decoded.set(
					hz,
					run.stdout
						.toString()
						.split("\n")
						.map(line => p.parse(line)?.data)
						.filter(Boolean),
				)
			}
			expect(decoded.get(BURST_HZ)).toEqual([
				expect.objectContaining({
					protocol: "POCSAG1200",
					address: 1_234_567,
					message: "12345",
				}),
			])
			for (const [hz, events] of decoded)
				if (hz !== BURST_HZ) expect(events, String(hz)).toEqual([])
		},
		60_000,
	)
})
