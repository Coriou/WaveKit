/**
 * Longevity: Activity reader deadline against a main-thread stall (measure only, not CI). Opens a
 * store copy, starts the production query service in worker mode, warms the reader, then issues
 * four searches (the web Activity page's burst) and blocks the main thread for --stall ms right
 * after posting them. The reader answers each search in a few ms, but the 250 ms deadline timer
 * lives on the main thread.
 *
 * --phase decides where the stall runs. `timers` (the round-1 repro) blocks inside a timer
 * callback: the expired deadline is not seen until the next loop turn, and the reply is read in
 * this turn's poll phase first, so nothing fails. `poll` (default) blocks inside an I/O callback,
 * as a burst of decoder output parsed in one socket read does: the next loop turn runs timers
 * before poll, so before WG19 the deadline fired with the reply already waiting, the reader was
 * terminated and the read failed. WG19's one-turn grace (query/deadline.ts) reads the reply first.
 * Also times one facets read (the chip counts the web page refreshes every few seconds).
 *
 *   pnpm exec esbuild scripts/longevity/reader-stall.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=output/longevity/reader-stall.mjs
 *   pnpm exec esbuild src/core/activity/query/activity-query-worker.ts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=output/longevity/activity-query-worker.mjs
 *   node output/longevity/reader-stall.mjs --state-dir <copy> --stall 400 [--phase poll|timers]
 *
 * The state directory must hold a copy of a store, never a live one (the open takes the lock).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import os from "node:os"
import { join } from "node:path"
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
const phase = argText("phase") ?? "poll"
if (phase !== "poll" && phase !== "timers")
	throw new RangeError("--phase is poll or timers")
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
	if (phase === "timers") {
		await new Promise(resolve => setTimeout(resolve, 1))
		busy(stallMs)
	} else {
		// A socket `data` callback runs in the poll phase, like decoder output. (An fs callback
		// would not do: it shares libuv's async wakeup with the worker's reply, which is then
		// drained in the same pass.) A Unix socket pair in a temp directory, no TCP port.
		const sockDir = await mkdtemp(join(os.tmpdir(), "wavekit-stall-"))
		const sockPath = join(sockDir, "s")
		await new Promise<void>((resolve, reject) => {
			const server = createServer(socket => {
				socket.once("data", () => {
					busy(stallMs)
					socket.destroy()
					server.close()
					resolve()
				})
			})
			server.on("error", reject)
			server.listen(sockPath, () => {
				const client = createConnection(sockPath, () => {
					client.end("x")
				})
				client.on("error", reject)
			})
		})
		await rm(sockDir, { recursive: true, force: true })
	}
	const results = await Promise.all(burst)
	const after = await outcome(service.search({ query: {}, limit: 50 }))

	console.log(
		JSON.stringify({
			warmSearchMs: Number(warmSearchMs.toFixed(1)),
			facets: { outcome: facets, ms: Math.round(facetsMs) },
			stallMs,
			phase,
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
