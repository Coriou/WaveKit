/**
 * Channel activity ranker cost on synthetic input, per block and per simulated second.
 * One source at the given block rate; each block carries `--tracks` gated segments, a share of
 * which churn every block (so most blocks are live edges and mark the source dirty). Two planner
 * queries of `--candidates` channels each are re-read on every change notice, as the decoder
 * manager does. Timers run on simulated time, so the result is CPU only (no wall-clock gate).
 *
 *   pnpm exec esbuild scripts/bench/channel-activity.ts --bundle \
 *     --platform=node --format=esm --packages=external --outfile=<tmp>/channel-activity.mjs
 *   node <tmp>/channel-activity.mjs --tracks 200 --candidates 192 --seconds 60
 */
import { performance } from "node:perf_hooks"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { createChannelActivityRanker } from "../../src/core/scanner/channel-activity.js"
import type {
	ActivityBlock,
	ActivityTimers,
} from "../../src/core/scanner/channel-activity.js"
import type { ActivityQuery } from "../../src/decoders/enablement/activity-contract.js"

export interface ChannelActivityBenchResult {
	tracks: number
	candidates: number
	blocks: number
	usPerBlockIngest: number
	usPerBlockTotal: number
	notices: number
	usPerNoticeSnapshot: number
	coreFraction: number
}

interface Pending {
	at: number
	fn: () => void
	id: number
}

export function runBench(opts: {
	tracks: number
	candidates: number
	seconds: number
	blockMs: number
	churn: number
}): ChannelActivityBenchResult {
	let now = 0
	let seq = 0
	const queue: Pending[] = []
	const timers: ActivityTimers = {
		setTimeout: (fn, ms) => {
			const p = { at: now + ms, fn, id: ++seq }
			queue.push(p)
			return p.id
		},
		clearTimeout: h => {
			const i = queue.findIndex(p => p.id === h)
			if (i >= 0) queue.splice(i, 1)
		},
	}
	const ranker = createChannelActivityRanker({ monoNow: () => now, timers })
	ranker.setHistory(() => ({
		decodes: Array.from({ length: 32 }, (_, i) => ({
			hz: 446_000_000 + i * 25_000,
			protocol: "pocsag1200",
			ageMs: 60_000,
		})),
		successes: [],
		occupancy: Array.from({ length: 64 }, (_, i) => ({
			hz: 445_000_000 + i * 37_500,
			duty: 0.2,
		})),
	}))
	const centre = 446_000_000
	const span = 2_400_000
	const raster = 12_500
	const first = centre - (opts.candidates / 2) * raster
	const candidatesHz = Array.from(
		{ length: opts.candidates },
		(_, i) => first + i * raster,
	)
	const query = (decoderId: string): ActivityQuery => ({
		epoch: { sourceId: "s", engineId: "e1", epoch: 1 },
		decoderId,
		decoderType: decoderId === "a" ? "multimon-ng" : "dsd-fme",
		protocols: decoderId === "a" ? ["pocsag1200", "pocsag2400"] : ["dmr"],
		centreHz: centre,
		candidatesHz,
		channelWidthHz: raster,
	})
	const queries = [query("a"), query("b")]
	let notices = 0
	let snapshotMs = 0
	ranker.port.subscribe(() => {
		notices++
		const t = performance.now()
		ranker.port.snapshot(queries, now)
		snapshotMs += performance.now() - t
	})
	// Fixed pseudo-random track layout; `churn` of them get new ids every block.
	let rnd = 12345
	const rand = (): number => {
		rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
		return rnd / 0x7fffffff
	}
	const layout = Array.from({ length: opts.tracks }, (_, i) => ({
		hz: centre - span * 0.4 + rand() * span * 0.8,
		id: `t${i}`,
	}))
	let nextId = opts.tracks
	const blocks = Math.round((opts.seconds * 1000) / opts.blockMs)
	let ingestMs = 0
	const cpu0 = process.cpuUsage()
	ranker.ingestEpoch("s", "e1", 1)
	ranker.port.snapshot(queries, now)
	for (let b = 0; b < blocks; b++) {
		now += opts.blockMs
		// Run due timers (flush and deadlines) in time order.
		for (;;) {
			queue.sort((x, y) => x.at - y.at || x.id - y.id)
			const p = queue[0]
			if (p === undefined || p.at > now) break
			queue.shift()
			p.fn()
		}
		for (let k = 0; k < opts.churn && layout.length > 0; k++) {
			const slot = layout[Math.floor(rand() * layout.length)]
			if (slot) slot.id = `t${nextId++}`
		}
		const block: ActivityBlock = {
			epoch: 1,
			centreHz: centre,
			sampleRateHz: span,
			overload: false,
			tracks: layout.map(t => ({
				startHz: t.hz - 4000,
				endHz: t.hz + 4000,
				flags: { iqImage: false, spur: false },
				trackId: t.id,
				gate: "passed" as const,
			})),
		}
		const t = performance.now()
		ranker.ingestBlock("s", "e1", block)
		ingestMs += performance.now() - t
	}
	const cpu = process.cpuUsage(cpu0)
	ranker.dispose()
	const cpuMs = (cpu.user + cpu.system) / 1000
	return {
		tracks: opts.tracks,
		candidates: opts.candidates,
		blocks,
		usPerBlockIngest: (ingestMs * 1000) / blocks,
		// Everything: ingest, flushes, deadline timers and notice snapshots (process CPU).
		usPerBlockTotal: (cpuMs * 1000) / blocks,
		notices,
		usPerNoticeSnapshot: notices > 0 ? (snapshotMs * 1000) / notices : 0,
		// Ranker CPU (ingest, flush and the notice snapshots) per simulated second.
		coreFraction: cpuMs / (opts.seconds * 1000),
	}
}

function arg(name: string, fallback: number): number {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : NaN
	return Number.isFinite(v) ? v : fallback
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const opts = {
		tracks: arg("tracks", 200),
		candidates: arg("candidates", 192),
		seconds: arg("seconds", 60),
		blockMs: arg("block-ms", 50),
		churn: arg("churn", 4),
	}
	runBench({ ...opts, seconds: 5 }) // warmup
	process.stdout.write(`${JSON.stringify(runBench(opts))}\n`)
}
