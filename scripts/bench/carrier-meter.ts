/**
 * WG10 R2: cost of the manual-mode passive quieting meter (activity hygiene carrier evidence) per
 * 10 ms channel block, measure only (not CI). Runs ChannelSquelch in power mode with and without
 * `carrierEvidence` over noisy FM-like channel IQ at the nfm and wfm channel rates and prints the
 * mean cost per block, the meter's share (difference), its % of one core and the load average.
 *
 *   pnpm exec esbuild scripts/bench/carrier-meter.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/carrier-meter.mjs
 *   node output/bench/carrier-meter.mjs [--seconds 30]
 */
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { ChannelSquelch } from "../../src/core/channel-squelch.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? v : fallback
}
const SECONDS = arg("seconds", 30)

/** Channel rates of liveDemodRates at 2.048 Msps: nfm 12.5 kHz → /82, wfm 150 kHz preset → /7. */
const CASES = [
	{ name: "nfm", rate: 2_048_000 / 82, bandwidthHz: 12_500 },
	{ name: "wfm", rate: 2_048_000 / 7, bandwidthHz: 150_000 },
]

function signal(rate: number, seconds: number): Buffer {
	const n = Math.round(rate * seconds)
	const out = Buffer.alloc(n * 8)
	let phase = 0
	let seed = 12345
	const rnd = (): number => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed / 0x7fffffff - 0.5
	}
	for (let k = 0; k < n; k++) {
		phase +=
			(2 * Math.PI * (1000 * Math.sin((2 * Math.PI * 300 * k) / rate))) / rate
		out.writeFloatLE(0.3 * Math.cos(phase) + 0.05 * rnd(), k * 8)
		out.writeFloatLE(0.3 * Math.sin(phase) + 0.05 * rnd(), k * 8 + 4)
	}
	return out
}

function run(rate: number, bandwidthHz: number, evidence: boolean, iq: Buffer) {
	const squelch = new ChannelSquelch({
		sampleRate: rate,
		thresholdDbfs: -40,
		hangMs: 250,
		mode: "power",
		bandwidthHz,
		...(evidence ? { carrierEvidence: true } : {}),
	})
	const blockBytes = Math.max(1, Math.round(rate * 0.01)) * 8
	const blocks = Math.floor(iq.length / blockBytes)
	// Warm up.
	for (let i = 0; i < Math.min(blocks, 200); i++)
		squelch.process(iq.subarray(i * blockBytes, (i + 1) * blockBytes))
	const t0 = performance.now()
	let carrier = 0
	for (let i = 0; i < blocks; i++) {
		squelch.process(iq.subarray(i * blockBytes, (i + 1) * blockBytes))
		if (squelch.blockCarrier()) carrier += 1
	}
	return { msPerBlock: (performance.now() - t0) / blocks, blocks, carrier }
}

for (const c of CASES) {
	const iq = signal(c.rate, SECONDS)
	// Interleave to share the machine load evenly.
	const off: number[] = []
	const on: number[] = []
	let carrier = 0
	for (let r = 0; r < 5; r++) {
		off.push(run(c.rate, c.bandwidthHz, false, iq).msPerBlock)
		const e = run(c.rate, c.bandwidthHz, true, iq)
		on.push(e.msPerBlock)
		carrier = e.carrier
	}
	const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[2] ?? 0
	const meter = med(on) - med(off)
	console.log(
		JSON.stringify({
			modulation: c.name,
			channelRateHz: Math.round(c.rate),
			samplesPerBlock: Math.round(c.rate * 0.01),
			powerOnlyUsPerBlock: +(med(off) * 1000).toFixed(2),
			withMeterUsPerBlock: +(med(on) * 1000).toFixed(2),
			meterUsPerBlock: +(meter * 1000).toFixed(2),
			meterPercentOfCore: +((meter / 10) * 100).toFixed(3),
			carrierBlocks: carrier,
			loadAverage: os.loadavg().map(x => +x.toFixed(2)),
		}),
	)
}
