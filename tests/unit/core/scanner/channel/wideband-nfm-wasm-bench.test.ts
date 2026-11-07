/**
 * Opt-in bench (WAVEKIT_NFM_BENCH=1), report only: no time decides a pass. The recorder's per-slice
 * block (readSlice: `process` per MAX_SLICE_SAMPLES piece of a 25 ms slice, then the tone twin
 * copied) on the JS and the wasm chain, alternated, at 1.024 and 2.4 Msps with 1 and 2 sessions.
 * Thread CPU per second of IQ (process.threadCpuUsage), the worst and p99 slice, and a catch-up
 * turn (1 s of IQ back to back). The scene is an NFM QSO with CTCSS, generated before timing.
 *
 *   WAVEKIT_NFM_BENCH=1 WAVEKIT_RECORDER_DSP_WASM=/path/wideband-nfm.wasm \
 *     nice -n 10 pnpm exec vitest run --maxWorkers=1 \
 *     tests/unit/core/scanner/channel/wideband-nfm-wasm-bench.test.ts
 */
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { describe, expect, it } from "vitest"
import {
	MAX_SLICE_SAMPLES,
	WidebandNfmChain,
} from "../../../../../src/core/scanner/channel/wideband-nfm.js"
import { NfmSource } from "../wideband-nfm-fixtures.js"
import { nfmWasmAvailable, testRuntime, wasmChain } from "./nfm-wasm-harness.js"

const BENCH = process.env["WAVEKIT_NFM_BENCH"] === "1"
const SECONDS = Number(process.env["WAVEKIT_NFM_BENCH_SECONDS"] ?? 10)
const ROUNDS = Number(process.env["WAVEKIT_NFM_BENCH_ROUNDS"] ?? 3)
const SLICE_MS = 25

function threadCpuUs(): number {
	const t = (
		process as unknown as {
			threadCpuUsage?: () => { user: number; system: number }
		}
	).threadCpuUsage
	const u = t ? t.call(process) : process.cpuUsage()
	return u.user + u.system
}

interface Run {
	path: "js" | "wasm"
	fs: number
	sessions: number
	load: number
	msPerIqSecond: number
	worstSliceMs: number
	p99SliceMs: number
	catchUpMs: number
}

function readSlice(chain: WidebandNfmChain, bytes: Uint8Array): number {
	let frames = 0
	for (let o = 0; o < bytes.length; o += MAX_SLICE_SAMPLES * 2) {
		const pcm = chain.process(
			bytes.subarray(o, Math.min(bytes.length, o + MAX_SLICE_SAMPLES * 2)),
		)
		frames += pcm.length + chain.toneAudio().slice().length
	}
	return frames
}

function measure(
	path: "js" | "wasm",
	fs: number,
	sessions: number,
	scene: Uint8Array,
): Run {
	const { runtime } = testRuntime(path === "js" ? "js" : "auto")
	const offsets = [93_750, -187_500]
	const chains = offsets
		.slice(0, sessions)
		.map(offsetHz =>
			path === "js"
				? new WidebandNfmChain({ inputRateHz: fs, offsetHz })
				: wasmChain(runtime, { inputRateHz: fs, offsetHz }),
		)
	const slice = 2 * Math.round((SLICE_MS * fs) / 1000)
	const slices = Math.floor(scene.length / slice)
	// warm-up: half a second
	for (let i = 0; i < Math.ceil(500 / SLICE_MS); i++)
		for (const c of chains)
			readSlice(
				c,
				scene.subarray((i % slices) * slice, ((i % slices) + 1) * slice),
			)
	const load = os.loadavg()[0]!
	const total = Math.round((SECONDS * 1000) / SLICE_MS)
	const times: number[] = []
	let sink = 0
	const cpu0 = threadCpuUs()
	for (let i = 0; i < total; i++) {
		const at = (i % slices) * slice
		const bytes = scene.subarray(at, at + slice)
		for (const c of chains) {
			const t0 = performance.now()
			sink += readSlice(c, bytes)
			times.push(performance.now() - t0)
		}
	}
	const cpuMs = (threadCpuUs() - cpu0) / 1000
	// a catch-up turn: 1 s of IQ in slices back to back, one session
	const t0 = performance.now()
	for (let i = 0; i < 1000 / SLICE_MS; i++) {
		const at = (i % slices) * slice
		sink += readSlice(chains[0]!, scene.subarray(at, at + slice))
	}
	const catchUpMs = performance.now() - t0
	expect(sink).toBeGreaterThan(0)
	times.sort((a, b) => a - b)
	return {
		path,
		fs,
		sessions,
		load,
		msPerIqSecond: cpuMs / SECONDS,
		worstSliceMs: times.at(-1)!,
		p99SliceMs: times[Math.floor(0.99 * (times.length - 1))]!,
		catchUpMs,
	}
}

describe.skipIf(!BENCH || !nfmWasmAvailable)("wideband NFM chain bench", () => {
	it("reports thread CPU per IQ second, JS and wasm alternated", () => {
		const lines: string[] = []
		for (const fs of [1_024_000, 2_400_000]) {
			const scene = new NfmSource({
				fs,
				offsetHz: 93_750,
				syllables: true,
			}).next(2 * fs, true)
			for (const sessions of [1, 2])
				for (let r = 0; r < ROUNDS; r++)
					for (const path of r % 2 === 0
						? (["js", "wasm"] as const)
						: (["wasm", "js"] as const)) {
						const m = measure(path, fs, sessions, scene)
						lines.push(
							`[nfm-bench] ${m.path.padEnd(4)} fs ${m.fs} sessions ${m.sessions} load ${m.load.toFixed(1)}: ${m.msPerIqSecond.toFixed(1)} ms CPU per IQ s; slice worst ${m.worstSliceMs.toFixed(2)} ms p99 ${m.p99SliceMs.toFixed(2)} ms; catch-up 1 s IQ ${m.catchUpMs.toFixed(1)} ms`,
						)
						process.stderr.write(`${lines.at(-1)}\n`)
					}
		}
		expect(lines.length).toBeGreaterThan(0)
	}, 600_000)
})
