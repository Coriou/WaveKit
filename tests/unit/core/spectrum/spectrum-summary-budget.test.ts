import { performance } from "node:perf_hooks"
import { serialize } from "node:v8"
import { describe, expect, it } from "vitest"
import {
	accumulateHold,
	encodeBins,
	reduceMaxHold,
} from "../../../../src/core/spectrum/spectrum-service.js"
import type {
	BlockSummary,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../../mocks/scanner/signals.js"
import { CENTRE, Harness, yieldToRpc } from "./pipeline-harness.js"

type SummaryEvent = Extract<PipelineEvent, { kind: "block-summary" }>

/** 1 s of seeded noise (σ 0.05) plus a tone at +93.75 kHz (amplitude 0.3), packed once as CU8. */
function workload(fs: number): Uint8Array {
	const rng = mulberry32(37)
	const iq = addInto(gaussianNoise(rng, fs, 0.05), tone(fs, fs, 93_750, 0.3))
	return packCu8(iq.re, iq.im)
}

/**
 * Harness.start() announces the harness's fixed 256 kS/s; these runs need the real rate,
 * so the same three inputs are sent here with `fs`.
 */
function begin(h: Harness, fs: number): void {
	h.sample = 0
	h.send({
		kind: "masks",
		exclusions: [],
		cfarRanges: [],
		burstRanges: [],
		rasters: [],
		obwHz: [],
		inWindow: true,
	})
	h.send({ kind: "spectrum-feed", enabled: true })
	h.send({
		kind: "new-stream",
		stream: 1,
		centreHz: CENTRE,
		sampleRateHz: fs,
		gainKey: "m:496",
		tuningTrust: "commanded",
	})
}

/** One block (50 ms) per handle() call; returns the summaries and the time spent in handle(). */
async function run(
	bytes: Uint8Array,
	cfg: { fs: number; fftSize: number; spectrumBins: number },
): Promise<{ summaries: SummaryEvent[]; pipelineMs: number }> {
	const h = new Harness({
		sampleRateHz: cfg.fs,
		fftSize: cfg.fftSize,
		integrationMs: 50,
		spectrumBins: cfg.spectrumBins,
	})
	begin(h, cfg.fs)
	const blockBytes = (cfg.fs / 20) * 2
	const summaries: SummaryEvent[] = []
	let pipelineMs = 0
	for (let off = 0; off + blockBytes <= bytes.length; off += blockBytes) {
		const t0 = performance.now()
		const events = h.send({
			kind: "bytes",
			startSample: h.sample,
			bytes: bytes.subarray(off, off + blockBytes),
		})
		pipelineMs += performance.now() - t0
		h.sample += blockBytes / 2
		for (const ev of events) if (ev.kind === "block-summary") summaries.push(ev)
		await yieldToRpc()
	}
	return { summaries, pipelineMs }
}

function meanUs(n: number, fn: () => void): number {
	const t0 = performance.now()
	for (let i = 0; i < n; i++) fn()
	return ((performance.now() - t0) * 1000) / n
}

const profileUs = (s: BlockSummary, bins: number): number =>
	meanUs(50, () =>
		encodeBins(
			accumulateHold(undefined, reduceMaxHold(s.bins, bins), s.epoch).bins!,
		),
	)

const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

describe("engine summary budget", () => {
	it("keeps the 10 Hz × 512 default bins identical with a 512 or a 2048 summary budget when the native span is ≤ 2048 bins", async () => {
		const fs = 1_024_000
		const bytes = workload(fs).subarray(0, (fs / 20) * 2 * 6)
		const small = await run(bytes, { fs, fftSize: 1024, spectrumBins: 512 })
		const large = await run(bytes, { fs, fftSize: 1024, spectrumBins: 2048 })
		expect(small.summaries.length).toBeGreaterThan(0)
		expect(large.summaries.length).toBe(small.summaries.length)
		for (const [i, s512] of small.summaries.entries()) {
			const s2048 = large.summaries[i]!
			expect(s2048.summary.bins.length).toBe(819)
			const a = reduceMaxHold(s512.summary.bins, 512)
			const b = reduceMaxHold(s2048.summary.bins, 512)
			expect([...b.bins]).toEqual([...a.bins])
			expect(s2048.summary.binHz * b.factor).toBe(s512.summary.binHz * a.factor)
			expect(s2048.summary.startHz).toBe(s512.summary.startHz)
		}
	})

	describe.skipIf(process.env["WAVEKIT_MEASURE_SUMMARY"] !== "1")(
		"measurement (Step 9a)",
		() => {
			it("measures the summary transport and profile cost per budget", async () => {
				const fs = 2_048_000
				const bytes = workload(fs)
				expect(bytes.length).toBe(4_096_000)
				const budgets = [512, 1024, 2048] as const
				type Sample = {
					bytesPerSummary: number
					summaryBins: number
					cloneUs: number
					profile512Us: number
					profile2048Us: number
					pipelineMs: number
				}
				const samples = new Map<number, Sample[]>(budgets.map(b => [b, []]))
				for (let round = 0; round < 5; round++) {
					const order = budgets.map(
						(_, i) => budgets[(i + round) % budgets.length]!,
					)
					for (const budget of order) {
						const r = await run(bytes, {
							fs,
							fftSize: 2048,
							spectrumBins: budget,
						})
						const ev = r.summaries.at(-1)!
						samples.get(budget)!.push({
							bytesPerSummary: serialize(ev).byteLength,
							summaryBins: ev.summary.bins.length,
							cloneUs: meanUs(50, () => structuredClone(ev)),
							profile512Us: profileUs(ev.summary, 512),
							profile2048Us: profileUs(ev.summary, 2048),
							pipelineMs: r.pipelineMs,
						})
						await yieldToRpc()
					}
				}
				const rows = budgets.map(budget => {
					const s = samples.get(budget)!
					const col = (k: keyof Sample) => s.map(x => x[k])
					const row = {
						budget,
						summaryBins: s[0]!.summaryBins,
						summariesPerS: 20,
						bytesPerSummary: s[0]!.bytesPerSummary,
						cloneUsMedian: median(col("cloneUs")),
						cloneUsMin: Math.min(...col("cloneUs")),
						profile512UsMedian: median(col("profile512Us")),
						profile512UsMin: Math.min(...col("profile512Us")),
						profile2048UsMedian: median(col("profile2048Us")),
						profile2048UsMin: Math.min(...col("profile2048Us")),
						pipelineMsMedian: median(col("pipelineMs")),
						pipelineMsMin: Math.min(...col("pipelineMs")),
					}
					const pass = {
						a: row.bytesPerSummary * 20 <= 512 * 1024,
						b: row.cloneUsMin * 20 <= 10_000,
						c: row.profile2048UsMin * 20 <= 5_000,
					}
					return { ...row, pass: pass.a && pass.b && pass.c, ...pass }
				})
				const chosen = [...rows].reverse().find(r => r.pass)?.budget ?? null
				const keys = Object.keys(rows[0]!) as (keyof (typeof rows)[number])[]
				const cell = (v: unknown) =>
					typeof v === "number" && !Number.isInteger(v)
						? v.toFixed(1)
						: String(v)
				const table = [
					keys.join(" | "),
					...rows.map(r => keys.map(k => cell(r[k])).join(" | ")),
				].join("\n")
				console.info(
					`Spectrum summary budget (5 interleaved rounds, 1 s at 2.048 Msps, fftSize 2048, 50 ms blocks; criteria on minimums)\n${table}\nverdict: ${chosen ?? "none passes"}`,
				)
				expect(rows).toHaveLength(3)
			}, 120_000)
		},
	)
})
