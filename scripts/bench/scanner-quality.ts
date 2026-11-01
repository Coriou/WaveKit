/**
 * Scanner quality benchmark (measurement only): is everything on the waterfall found and
 * identified, and how fast? Runs a seeded synthetic scene with ground truth (NFM voice and
 * push-to-talk, DMR, POCSAG, OOK and FSK ISM bursts, AFSK1200, LoRa, CW, a birdie and a DC spike
 * at several SNRs) through the real scanner (spectrum detector, frame tracks, channel gate,
 * passive-job discoveries, IQ capture requests and the real replay planner) on a virtual clock,
 * then scores detection, splitting, false discoveries, identification (fake decoders, see
 * scanner-quality/metrics.ts) and CPU. Prints a table and one JSON line.
 *
 *   pnpm exec esbuild scripts/bench/scanner-quality.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/scanner-quality.mjs
 *   node output/bench/scanner-quality.mjs [--scene small|full] [--seed N] [--unbounded-captures]
 *   node output/bench/scanner-quality.mjs --file <capture.cu8> --rate <Hz> --centre <Hz> [--seconds S]
 *
 * The fake capture port enforces the real one's limits (2 captures at once, 6 detection captures
 * per source per minute, a 2 s ring); --unbounded-captures grants every request instead.
 *
 * --file replays a CU8 capture (the first seconds feed the lead-in while the passive job starts)
 * and prints counts only: there is no ground truth, so nothing is scored. Nothing listens on the
 * network; the scanner state lives in a temp dir removed at the end.
 */
import { closeSync, openSync, readSync } from "node:fs"
import process from "node:process"
import { runScanner, type IqChunkSource } from "./scanner-quality/harness.js"
import {
	formatReport,
	formatUnscored,
	score,
	unscoredJson,
} from "./scanner-quality/metrics.js"
import {
	SceneGenerator,
	buildScene,
	fullScene,
	smallScene,
} from "./scanner-quality/scene.js"

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}
const num = (name: string): number | undefined => {
	const v = arg(name)
	if (v === undefined) return undefined
	const n = Number(v)
	if (!Number.isFinite(n) || n <= 0) {
		process.stderr.write(`--${name} needs a positive number\n`)
		process.exit(2)
	}
	return n
}

function fileSource(
	path: string,
	rateHz: number,
	centreHz: number,
	seconds: number | undefined,
): IqChunkSource & { close(): void } {
	const fd = openSync(path, "r")
	let left = seconds === undefined ? Infinity : Math.round(seconds * rateHz)
	const read = (samples: number): Buffer | null => {
		const n = Math.min(samples, left)
		if (n <= 0) return null
		const buf = Buffer.allocUnsafe(2 * n)
		const got = readSync(fd, buf, 0, buf.length, null)
		if (got < 2) return null
		left -= got >> 1
		return buf.subarray(0, got & ~1)
	}
	// An empty scene's generator only supplies noise once the file ran out during the lead-in.
	const filler = new SceneGenerator(
		buildScene({
			name: "lead-in",
			rateHz,
			centreHz,
			durationMs: 0,
			seed: 1,
			noiseSigma: 0.03,
			signals: [],
		}),
	)
	return {
		rateHz,
		centreHz,
		next: read,
		leadIn: n => read(n) ?? filler.noiseOnly(n),
		close: () => closeSync(fd),
	}
}

async function main(): Promise<void> {
	const file = arg("file")
	if (file !== undefined) {
		const rate = num("rate")
		const centre = num("centre")
		if (rate === undefined || centre === undefined) {
			process.stderr.write("--file needs --rate and --centre\n")
			process.exit(2)
		}
		const src = fileSource(file, rate, centre, num("seconds"))
		try {
			const run = await runScanner(src)
			process.stdout.write(`${formatUnscored(run)}\n\n`)
			process.stdout.write(`${JSON.stringify(unscoredJson(run))}\n`)
		} finally {
			src.close()
		}
		return
	}
	const name = arg("scene") ?? "small"
	if (name !== "small" && name !== "full") {
		process.stderr.write("--scene is small or full\n")
		process.exit(2)
	}
	const seed = num("seed")
	const scene = name === "full" ? fullScene(seed) : smallScene(seed)
	const gen = new SceneGenerator(scene)
	const captureLimits = !process.argv.includes("--unbounded-captures")
	const run = await runScanner(
		{
			rateHz: scene.rateHz,
			centreHz: scene.centreHz,
			next: n => gen.next(n),
			leadIn: n => gen.noiseOnly(n),
		},
		{
			captureLimits,
			onProgress: ms => {
				if (ms % 10_000 < 1_000)
					process.stderr.write(`  ${(ms / 1000).toFixed(0)} s\n`)
			},
		},
	)
	const report = score(scene, run)
	process.stdout.write(`${formatReport(report)}\n\n`)
	process.stdout.write(`${JSON.stringify(report)}\n`)
}

main().catch((err: unknown) => {
	process.stderr.write(
		`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
	)
	process.exit(1)
})
