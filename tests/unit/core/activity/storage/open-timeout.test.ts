/**
 * The threaded writer's open: a timed-out open terminates the worker and frees the lock, the
 * runtime classifies it as ACTIVITY_OPEN_TIMEOUT (retryable), the lifecycle opens on a retry,
 * and the deferred retention seed runs before the first write. The worker holds its open
 * for 60 s (openDelayMs) against a 50 ms budget, so the timeout never depends on speed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { startActivityLifecycle } from "../../../../../src/core/activity/lifecycle.js"
import { startActivityRuntime } from "../../../../../src/core/activity/runtime.js"
import { ActivityOpenTimeoutError } from "../../../../../src/core/activity/storage/errors.js"
import {
	ActivityWriterClient,
	openActivityStore,
} from "../../../../../src/core/activity/storage/store.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import type { ActivityWorkerResponse } from "../../../../../src/core/activity/storage/writer-protocol.js"
import { loadDatabaseSync } from "../../../../../src/core/activity/storage/probe.js"
import { Worker } from "node:worker_threads"
import {
	envelope,
	FIXTURE_CLOCK_ANCHOR_MS,
	fixtureClock,
	logger,
} from "./helpers.js"
import { shareRow, YEAR_MS } from "./retention-helpers.js"

const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
const roots: string[] = []
let workerUrl: URL

/** Longer than any test: the open can only end by the timeout. */
const HELD_OPEN_MS = 60_000

beforeAll(async () => {
	// Outside the checkout: every package is bundled in, so nothing resolves from the tmp dir.
	const bundleDir = await mkdtemp(join(tmpdir(), "wavekit-activity-open-"))
	roots.push(bundleDir)
	const outfile = join(bundleDir, "activity-writer-worker.mjs")
	await build({
		absWorkingDir: repository,
		entryPoints: ["src/core/activity/storage/activity-writer-worker.ts"],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		external: ["node:*"],
		// Bundled CommonJS dependencies call require(); ESM output needs one in scope.
		banner: {
			js: 'import { createRequire as wkRequire } from "node:module"; const require = wkRequire(import.meta.url);',
		},
		logLevel: "silent",
	})
	await writeFile(join(bundleDir, "package.json"), '{"type":"module"}\n')
	workerUrl = pathToFileURL(outfile)
})

afterAll(async () => {
	await Promise.all(
		roots.map(root => rm(root, { recursive: true, force: true })),
	)
})

async function stateDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-activity-open-"))
	roots.push(dir)
	return dir
}

describe("activity writer open timeout", () => {
	it("terminates the worker and releases the lock", async () => {
		const dir = await stateDir()
		await expect(
			openActivityStore({
				stateDir: dir,
				logger,
				workerUrl,
				openDelayMs: HELD_OPEN_MS,
				openTimeoutMs: 50,
			}),
		).rejects.toBeInstanceOf(ActivityOpenTimeoutError)
		// The timed-out worker held the lock; a new open (another worker) gets it.
		const store = await openActivityStore({
			stateDir: dir,
			logger,
			workerUrl,
		})
		expect(store.stats().writer).toBe("running")
		await store.close()
	}, 20_000)

	it("is a retryable ACTIVITY_OPEN_TIMEOUT for the runtime", async () => {
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir: await stateDir(),
			logger,
			workerUrl,
			openDelayMs: HELD_OPEN_MS,
			openTimeoutMs: 50,
			setPublisher: () => {},
		})
		expect(runtime.status).toBe("unavailable")
		expect(runtime.unavailable).toMatchObject({
			reason: "ACTIVITY_OPEN_TIMEOUT",
			retryable: true,
		})
		await runtime.close()
	}, 20_000)

	it("the lifecycle opens on the retry after a timed-out open", async () => {
		let attempts = 0
		const life = startActivityLifecycle({
			enabled: true,
			stateDir: await stateDir(),
			logger,
			workerUrl,
			queryExecution: "inline",
			setPublisher: () => {},
			retryDelaysMs: [1],
			attempt: options => {
				attempts += 1
				return startActivityRuntime(
					attempts === 1
						? { ...options, openDelayMs: HELD_OPEN_MS, openTimeoutMs: 50 }
						: options,
				)
			},
		})
		await life.settled()
		expect(life.lifecycle()).toMatchObject({
			state: "retrying",
			reason: "ACTIVITY_OPEN_TIMEOUT",
		})
		await life.settled()
		expect(life.lifecycle()).toMatchObject({
			state: "available",
			reason: null,
			attempts: 2,
		})
		expect(life.stats().writer).toBe("running")
		await life.close()
	}, 20_000)
})

/** A store on disk holding three rows: two from decoder a, one from b. */
async function populated(): Promise<string> {
	const dir = await stateDir()
	const first = await openActivityStore({
		stateDir: dir,
		logger,
		execution: "inline",
		now: fixtureClock(),
		limits: { batchWindowMs: 0, globalBurst: 100, decoderBurst: 100 },
	})
	for (const [i, decoderId] of ["a", "a", "b"].entries())
		first.admit(envelope({ eventId: `old-${i}`, decoderId }))
	await first.close()
	return dir
}

/** Polls until the worker's post-seed snapshot is adopted (bounded, not a timing assertion). */
const SEED_WAIT = { timeout: 10_000, interval: 10 }

describe("deferred retention seed", () => {
	it("publishes the seeded shares without a write", async () => {
		const store = await openActivityStore({
			stateDir: await populated(),
			logger,
			workerUrl,
			now: fixtureClock(),
		})
		await vi.waitFor(() => {
			expect(
				store.stats().retention?.shares.map(share => [share.key, share.rows]),
			).toEqual([
				["decoder:a", 2],
				["decoder:b", 1],
			])
		}, SEED_WAIT)
		expect(store.stats()).toMatchObject({
			rows: 3,
			committed: 0,
			retention: { effective: "fair-share", sharesTruncated: false },
		})
		await store.close()
	}, 20_000)

	it("publishes a failed seed as oldest-first without a write", async () => {
		const dir = await populated()
		// A record size past Number.MAX_SAFE_INTEGER fails the seed scan's SUM check.
		const DatabaseSync = await loadDatabaseSync()
		const db = new DatabaseSync(join(dir, "activity", "activity.db"))
		db.exec("UPDATE activity SET record_bytes = 9007199254740993 WHERE seq = 1")
		db.close()
		const store = await openActivityStore({
			stateDir: dir,
			logger,
			workerUrl,
			now: fixtureClock(),
		})
		await vi.waitFor(() => {
			expect(store.stats().retention).toMatchObject({
				policy: "fair-share",
				effective: "oldest-first",
				shares: [],
			})
		}, SEED_WAIT)
		await store.close()
	}, 20_000)

	it("seeds the counters before the first write after a threaded open", async () => {
		const dir = await stateDir()
		const now = fixtureClock()
		const limits = { batchWindowMs: 0, globalBurst: 100, decoderBurst: 100 }
		const first = await openActivityStore({
			stateDir: dir,
			logger,
			execution: "inline",
			now,
			limits,
		})
		for (const [i, decoderId] of ["a", "a", "b"].entries())
			first.admit(envelope({ eventId: `old-${i}`, decoderId }))
		await first.close()

		const store = await openActivityStore({
			stateDir: dir,
			logger,
			workerUrl,
			now,
			limits,
		})
		expect(store.stats().rows).toBe(3)
		const committed = new Promise<void>(resolve => {
			store.onCommit(() => {
				resolve()
			})
		})
		store.admit(envelope({ eventId: "new", decoderId: "b" }))
		await committed
		// The shares count the rows already on disk: the seed ran before this write.
		expect(
			store.stats().retention?.shares.map(share => [share.key, share.rows]),
		).toEqual([
			["decoder:a", 2],
			["decoder:b", 2],
		])
		await store.close()
	}, 20_000)
})

/** The worker's replies in order, from a raw worker on the bundled entry. */
function rawWorker() {
	const worker = new Worker(workerUrl, { name: "activity-writer-test" })
	const messages: ActivityWorkerResponse[] = []
	const waiters: (() => void)[] = []
	worker.on("message", (m: ActivityWorkerResponse) => {
		messages.push(m)
		for (const wake of waiters.splice(0)) wake()
	})
	/** Resolves once `count` messages arrived (event-driven, no clock). */
	const received = async (count: number): Promise<ActivityWorkerResponse[]> => {
		while (messages.length < count)
			await new Promise<void>(resolve => {
				waiters.push(resolve)
			})
		return messages.slice(0, count)
	}
	return { worker, messages, received }
}

describe("deferred retention seed on the worker protocol", () => {
	it("answers ready unseeded and scans once, after ready", async () => {
		const dir = await populated()
		const w = rawWorker()
		try {
			w.worker.postMessage({
				id: 1,
				type: "open",
				dbPath: join(dir, "activity", "activity.db"),
				lockPath: join(dir, "activity", "activity.lock.db"),
				limits: resolveActivityLimits({ maxAgeMs: YEAR_MS }),
				failNextWrites: 0,
				throwNextWrites: 0,
				writeDelayMs: 0,
			})
			const [ready, seeded] = await w.received(2)
			// Without deferSeed the ready snapshot would carry seedScans 1 and both shares.
			expect(ready).toMatchObject({ id: 1, type: "ready" })
			if (ready?.type !== "ready") return
			expect(ready.snapshot.rows).toBe(3)
			expect(ready.snapshot.seedScans).toBe(0)
			expect(ready.snapshot.retention.shares).toEqual([])
			expect(seeded).toMatchObject({ id: 0, type: "seeded" })
			if (seeded?.type !== "seeded") return
			expect(seeded.snapshot.seedScans).toBe(1)
			expect(
				seeded.snapshot.retention.shares.map(share => [share.key, share.rows]),
			).toEqual([
				["decoder:a", 2],
				["decoder:b", 1],
			])
			// The first write does not scan again: exactly one seed scan this session.
			w.worker.postMessage({
				id: 2,
				type: "write",
				rows: [shareRow("new", "b", FIXTURE_CLOCK_ANCHOR_MS)],
				nowMs: FIXTURE_CLOCK_ANCHOR_MS,
			})
			const wrote = (await w.received(3))[2]
			expect(wrote).toMatchObject({ id: 2, type: "wrote" })
			if (wrote?.type !== "wrote" || !wrote.result.ok) return
			expect(wrote.result.snapshot.seedScans).toBe(1)
			w.worker.postMessage({ id: 3, type: "close" })
			expect((await w.received(4))[3]).toMatchObject({ id: 3, type: "closed" })
		} finally {
			await w.worker.terminate()
		}
	}, 20_000)

	it("a throwing seed task loses no message and keeps the writer", async () => {
		const store = await openActivityStore({
			stateDir: await populated(),
			logger,
			workerUrl,
			now: fixtureClock(),
			limits: { batchWindowMs: 0, globalBurst: 100, decoderBurst: 100 },
			seedThrows: true,
		})
		const committed = new Promise<void>(resolve => {
			store.onCommit(() => {
				resolve()
			})
		})
		store.admit(envelope({ eventId: "after-throw", decoderId: "b" }))
		await committed
		// The write was answered (not an error for the next message) and seeded the counters.
		expect(store.stats()).toMatchObject({ writer: "running", rows: 4 })
		expect(
			store.stats().retention?.shares.map(share => [share.key, share.rows]),
		).toEqual([
			["decoder:a", 2],
			["decoder:b", 2],
		])
		await store.close()
	}, 20_000)

	it("replays the last seeded snapshot to a late listener", async () => {
		const dir = await populated()
		const client = await ActivityWriterClient.open(
			workerUrl,
			join(dir, "activity", "activity.db"),
			join(dir, "activity", "activity.lock.db"),
			resolveActivityLimits({ maxAgeMs: YEAR_MS }),
			0,
			0,
			0,
			0,
			false,
			5_000,
			30_000,
			logger,
		)
		try {
			await vi.waitFor(() => {
				expect(client.seededSnapshot()).toBeDefined()
			}, SEED_WAIT)
			const heard: number[] = []
			client.onSeeded(snapshot => {
				heard.push(snapshot.seedScans)
			})
			// Synchronously, once, with the snapshot that arrived before the listener.
			expect(heard).toEqual([1])
		} finally {
			await client.close()
		}
	}, 20_000)
})
