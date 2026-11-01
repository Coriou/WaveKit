/**
 * Longevity: Activity reader deadline against a main-thread stall (measure only, not CI). Opens a
 * store copy, starts the production query service in worker mode, warms the reader, then issues
 * four searches (the web Activity page's burst) and blocks the main thread for --stall ms right
 * after posting them. The reader answers each search in a few ms, but the 250 ms deadline timer
 * lives on the main thread: when the stall outlasts it, the timer runs before the worker's reply is
 * read, the reader is terminated and every read in flight or queued behind it fails.
 * Also times one facets read (the chip counts the web page refreshes every few seconds).
 *
 *   pnpm exec esbuild scripts/longevity/reader-stall.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=output/longevity/reader-stall.mjs
 *   pnpm exec esbuild src/core/activity/query/activity-query-worker.ts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=output/longevity/activity-query-worker.mjs
 *   node output/longevity/reader-stall.mjs --state-dir <copy> --stall 400
 *
 * The state directory must hold a copy of a store, never a live one (the open takes the lock).
 */
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import pino from "pino"
import { createActivityQueryService } from "../../src/core/activity/query/service.js"
import { openActivityStore } from "../../src/core/activity/storage/store.js"

const argText = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const stateDir = argText("state-dir")
if (stateDir === null) throw new RangeError("--state-dir is required")
const stallMs = Number(argText("stall") ?? "400")
const silent = pino({ level: "silent" })

const store = await openActivityStore({
	stateDir,
	logger: silent,
	execution: "inline",
})
let terminations = 0
const service = createActivityQueryService({
	store,
	logger: silent,
	workerUrl: new URL("./activity-query-worker.mjs", import.meta.url),
	onReaderEvent: event => {
		if (event.type === "terminate") terminations++
	},
})
const outcome = async (p: Promise<unknown>): Promise<string> =>
	p.then(
		() => "ok",
		(e: unknown) => (e instanceof Error ? e.name : "error"),
	)
const busy = (ms: number): void => {
	const end = performance.now() + ms
	while (performance.now() < end) {
		// main-thread stall
	}
}

try {
	await service.search({ query: {}, limit: 50 })
	const w0 = performance.now()
	await service.search({ query: {}, limit: 50 })
	const warmSearchMs = performance.now() - w0

	const f0 = performance.now()
	const facets = await outcome(
		service.facets({
			query: {},
			dimensions: ["category", "protocol", "decoderId", "sourceId", "kind"],
		}),
	)
	const facetsMs = performance.now() - f0

	// The facets timeout (if any) killed the reader: warm a fresh one first.
	await outcome(service.search({ query: {}, limit: 50 }))
	const burst = Array.from({ length: 4 }, () =>
		outcome(service.search({ query: {}, limit: 50 })),
	)
	// Let the first read reach the worker, then stall the main thread.
	await new Promise(resolve => setTimeout(resolve, 1))
	busy(stallMs)
	const results = await Promise.all(burst)
	const after = await outcome(service.search({ query: {}, limit: 50 }))

	console.log(
		JSON.stringify({
			warmSearchMs: Number(warmSearchMs.toFixed(1)),
			facets: { outcome: facets, ms: Math.round(facetsMs) },
			stallMs,
			burst: results,
			readerTerminations: terminations,
			nextSearch: after,
			loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
		}),
	)
} finally {
	await service.close()
	await store.close()
}
