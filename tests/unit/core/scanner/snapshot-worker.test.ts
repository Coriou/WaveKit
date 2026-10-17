/**
 * WG11 req 3.5/3.6: ScannerPersistence.writeSnapshotOf through the real snapshot worker (built
 * from the ts entry with esbuild, as the activity worker tests do) and through fake worker ports
 * for crash, hostile message, timeout and overflow paths. The store is a local test double: a
 * DiscoveryStore with `recordCounts` and `snapshotParts` derived from `snapshot()` (subagent A
 * adds the real O(1) ones to discovery-store.ts).
 */
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	DiscoveryStoreOptions,
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { SnapshotWorkerOptions } from "../../../../src/core/scanner/store/persistence.js"
import { PreparedRecordingOperationsSchema } from "../../../../src/core/scanner/store/recording-operation.js"
import type { SnapshotParts } from "../../../../src/core/scanner/store/snapshot-mirror.js"
import type { SnapshotWorkerPort } from "../../../../src/core/scanner/store/snapshot-writer.js"
import {
	defaultSnapshotWorkerFactory,
	SnapshotWriter,
} from "../../../../src/core/scanner/store/snapshot-writer.js"
import type { Logger } from "../../../../src/utils/logger.js"
import type { SnapshotWorkerRequest } from "../../../../src/core/scanner/store/snapshot-protocol.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import { applySeededOps, mulberry32, OPS_T0 } from "./snapshot-mirror-ops.js"

const logger = createLogger({ level: "fatal" })

/** The store's own `snapshotParts`, with a switch to corrupt it for the validation test. */
class TestStore extends DiscoveryStore {
	corruptParts = false
	override snapshotParts(): SnapshotParts {
		const parts = super.snapshotParts()
		if (this.corruptParts)
			return {
				...parts,
				recordingOperations: [{ nope: true }],
			} as unknown as SnapshotParts
		return parts
	}
}

function frozenText(
	s: StoreSnapshot,
	lastSeq: number,
	savedAtMs: number,
): string {
	return JSON.stringify({
		version: 1,
		lastSeq,
		savedAt: new Date(savedAtMs).toISOString(),
		discoveries: s.discoveries,
		observations: s.observations,
		corrections: s.corrections,
		recordingOperations: PreparedRecordingOperationsSchema.parse(
			s.recordingOperations ?? [],
		),
		...(s.aliases && s.aliases.length > 0 ? { aliases: s.aliases } : {}),
	})
}

let workerUrl: URL
let buildDir: string

beforeAll(async () => {
	const repository = fileURLToPath(new URL("../../../../", import.meta.url))
	const cache = join(repository, "node_modules", ".cache")
	await mkdir(cache, { recursive: true })
	buildDir = await mkdtemp(join(cache, "wk-snapshot-worker-"))
	const outfile = join(buildDir, "snapshot-worker.js")
	await build({
		absWorkingDir: repository,
		entryPoints: ["src/core/scanner/store/snapshot-worker.ts"],
		bundle: true,
		outfile,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "silent",
	})
	workerUrl = pathToFileURL(outfile)
})

afterAll(async () => {
	await rm(buildDir, { recursive: true, force: true })
})

interface Harness {
	dir: string
	store: TestStore
	p: ScannerPersistence
	clock: { now: number }
	rand: () => number
	ops: (n: number) => void
	expected: () => string
	file: () => Promise<string>
	close: () => Promise<void>
}

async function harness(
	worker: SnapshotWorkerOptions,
	opts: {
		appendFile?: (path: string, data: string) => Promise<void>
		maxJournalBacklogBytes?: number
	} = {},
): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-snapworker-"))
	const clock = { now: OPS_T0 }
	const storeOpts: DiscoveryStoreOptions = {
		maxDiscoveries: 30,
		now: () => clock.now,
		newId: counterIds(),
		rasters: () => [{ spacingHz: 12_500, firstChannelHz: 446_000_000 }],
	}
	const store = new TestStore(storeOpts)
	const p = new ScannerPersistence({
		dir,
		logger,
		now: () => clock.now,
		snapshotWorker: { url: workerUrl, ...worker },
		...opts,
	})
	await p.load()
	let seq = 0
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
		seq += 1
		void p.append(e).catch(() => undefined)
	})
	const rand = mulberry32(42)
	let obsBase = 0
	const run = { store, entries: [] as Omit<JournalEntry, "seq">[], clock }
	return {
		dir,
		store,
		p,
		clock,
		rand,
		ops: n => {
			applySeededOps(run, rand, n, { obsBase, channels: 4, ingestShare: 0.8 })
			obsBase += 10_000
		},
		expected: () => frozenText(store.snapshot(), seq, clock.now),
		file: () => readFile(join(dir, "discoveries.json"), "utf8"),
		close: async () => {
			await p.closeSnapshotWorker()
			await rm(dir, { recursive: true, force: true })
		},
	}
}

describe("snapshot worker (WG11 req 3.5)", () => {
	it("writes the same text as the main path; the first snapshot resets the mirror on the main thread", async () => {
		const h = await harness({})
		try {
			h.ops(40)
			let want = h.expected()
			await h.p.writeSnapshotOf(h.store)
			expect(await h.file()).toBe(want)
			expect(h.p.snapshotWorkerStatus()?.state).toBe("live")
			for (let round = 0; round < 3; round++) {
				h.ops(30)
				want = h.expected()
				await h.p.writeSnapshotOf(h.store)
				expect(await h.file()).toBe(want)
			}
			const status = h.p.snapshotWorkerStatus()
			expect(status).toMatchObject({ state: "live", fallbacks: 0, failures: 0 })
			expect(status?.lastTextBytes).toBe(Buffer.byteLength(want))
			expect(status?.heapUsedBytes).toBeGreaterThan(0)
			expect(status?.queuedBytes).toBe(0)
		} finally {
			await h.close()
		}
	})

	it("a diverged mirror fails that snapshot to the main path once and resets the mirror", async () => {
		const h = await harness({})
		try {
			h.ops(40)
			await h.p.writeSnapshotOf(h.store)
			h.ops(10)
			const victim = h.store.snapshot().discoveries[0]
			if (victim === undefined) throw new Error("fixture")
			// A removal the store did not make: the mirror loses a record the counts still hold.
			h.store.emit("mirror-removal", {
				discoveries: [victim.id],
				observations: [],
			})
			let want = h.expected()
			await h.p.writeSnapshotOf(h.store)
			expect(await h.file()).toBe(want)
			expect(h.p.snapshotWorkerStatus()).toMatchObject({
				fallbacks: 1,
				divergences: 1,
			})
			h.ops(20)
			want = h.expected()
			await h.p.writeSnapshotOf(h.store)
			expect(await h.file()).toBe(want)
			expect(h.p.snapshotWorkerStatus()).toMatchObject({
				fallbacks: 1,
				state: "live",
			})
		} finally {
			await h.close()
		}
	})

	it("keeps one outstanding snapshot behind a stalled journal: newer requests supersede queued ones", async () => {
		let release!: () => void
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let calls = 0
		const h = await harness(
			{},
			{
				appendFile: async (path, data) => {
					calls += 1
					if (calls === 2) await gate
					await appendFile(path, data)
				},
			},
		)
		try {
			h.ops(20)
			await h.p.writeSnapshotOf(h.store) // main path, mirror reset
			h.ops(5)
			while (calls < 2) await new Promise<void>(r => setImmediate(r))
			const pending: Promise<void>[] = []
			for (let i = 0; i < 5; i++) {
				h.ops(3)
				pending.push(h.p.writeSnapshotOf(h.store))
				expect(h.p.backlog().snapshots).toBeLessThanOrEqual(1)
				expect(h.p.backlog().snapshotBytes).toBe(0)
			}
			const want = h.expected()
			release()
			await Promise.all(pending)
			expect(await h.file()).toBe(want)
			expect(h.p.backlog().snapshots).toBe(0)
			expect(h.p.snapshotWorkerStatus()?.fallbacks).toBe(0)
		} finally {
			release()
			await h.close()
		}
	})

	it("a worker snapshot covering a journal hole accepts appends again", async () => {
		let release!: () => void
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let calls = 0
		const h = await harness(
			{},
			{
				maxJournalBacklogBytes: 4096,
				appendFile: async (path, data) => {
					calls += 1
					if (calls === 1) await gate
					await appendFile(path, data)
				},
			},
		)
		try {
			h.ops(1)
			const first = h.p.writeSnapshotOf(h.store) // main path; resets the mirror
			h.ops(60) // stalled: lines past 4 KiB are refused (a hole)
			expect(h.p.backlog().refusedLines).toBeGreaterThan(0)
			const want = h.expected()
			const covering = h.p.writeSnapshotOf(h.store)
			release()
			await first
			await covering
			expect(await h.file()).toBe(want)
			expect(h.p.backlog().refusedLines).toBe(0)
			expect(h.p.snapshotWorkerStatus()?.fallbacks).toBe(0)
			const seq = await h.p.append({
				at: new Date(OPS_T0).toISOString(),
				op: "observation",
				payload: { discoveries: [], observations: [], deleted: [] },
			})
			expect(seq).toBeGreaterThan(0)
		} finally {
			release()
			await h.close()
		}
	})
})

/** A port around the real worker whose behaviour a test can corrupt. */
function wrapped(
	mode: { crashOnCommit?: boolean; garbage?: boolean; silentCommit?: boolean },
	made: { count: number },
) {
	return ({
		url,
		heapMb,
	}: {
		url: URL
		heapMb: number
	}): SnapshotWorkerPort => {
		made.count += 1
		const inner = defaultSnapshotWorkerFactory({ url, heapMb })
		let onMessage: (v: unknown) => void = () => undefined
		let onExit: (code: number) => void = () => undefined
		return {
			postMessage: (m: SnapshotWorkerRequest) => {
				if (m.type === "commit") {
					if (mode.crashOnCommit === true) {
						setImmediate(() => onExit(1))
						return
					}
					if (mode.garbage === true) {
						setImmediate(() => onMessage({ type: "written", id: "x" }))
						return
					}
					if (mode.silentCommit === true) return
				}
				inner.postMessage(m)
			},
			onMessage: l => {
				onMessage = l
				inner.onMessage(l)
			},
			onError: l => inner.onError(l),
			onExit: l => {
				onExit = l
				inner.onExit(l)
			},
			terminate: () => inner.terminate(),
		}
	}
}

describe("snapshot worker failures (WG11 req 3.5)", () => {
	it("a crash writes that snapshot on the main thread, restarts once, then stays on the main thread", async () => {
		const made = { count: 0 }
		const h = await harness({ factory: wrapped({ crashOnCommit: true }, made) })
		try {
			h.ops(20)
			await h.p.writeSnapshotOf(h.store) // main path, worker 1 started
			for (let i = 0; i < 4; i++) {
				h.ops(10)
				const want = h.expected()
				await h.p.writeSnapshotOf(h.store)
				expect(await h.file()).toBe(want)
			}
			expect(made.count).toBe(2)
			expect(h.p.snapshotWorkerStatus()).toMatchObject({
				state: "disabled",
				failures: 2,
			})
		} finally {
			await h.close()
		}
	})

	it("a hostile worker message fails over without losing the snapshot", async () => {
		const made = { count: 0 }
		const h = await harness({ factory: wrapped({ garbage: true }, made) })
		try {
			h.ops(20)
			await h.p.writeSnapshotOf(h.store)
			h.ops(10)
			const want = h.expected()
			await h.p.writeSnapshotOf(h.store)
			expect(await h.file()).toBe(want)
			expect(h.p.snapshotWorkerStatus()?.failures).toBe(1)
		} finally {
			await h.close()
		}
	})

	it("a commit that never answers times out to the main path", async () => {
		const made = { count: 0 }
		const h = await harness({
			factory: wrapped({ silentCommit: true }, made),
			commitTimeoutMs: 50,
		})
		try {
			h.ops(20)
			await h.p.writeSnapshotOf(h.store)
			h.ops(10)
			const want = h.expected()
			await h.p.writeSnapshotOf(h.store)
			expect(await h.file()).toBe(want)
			expect(h.p.snapshotWorkerStatus()?.failures).toBe(1)
		} finally {
			await h.close()
		}
	})

	it("past the message bound the mirror goes stale instead of queueing; the next snapshot resets it", async () => {
		const h = await harness({ maxQueuedBytes: 2048 })
		try {
			h.ops(20)
			await h.p.writeSnapshotOf(h.store)
			h.ops(40) // far more than 2 KiB of lines before the worker can acknowledge them
			expect(h.p.snapshotWorkerStatus()?.queuedBytes ?? 0).toBeLessThanOrEqual(
				2048,
			)
			const want = h.expected()
			await h.p.writeSnapshotOf(h.store)
			expect(await h.file()).toBe(want)
			expect(h.p.snapshotWorkerStatus()?.overflows).toBeGreaterThan(0)
		} finally {
			await h.close()
		}
	})

	it("rejects an invalid prepared recording snapshot as writeSnapshot does", async () => {
		const h = await harness({})
		try {
			h.ops(5)
			await h.p.writeSnapshotOf(h.store)
			h.store.corruptParts = true
			await expect(h.p.writeSnapshotOf(h.store)).rejects.toMatchObject({
				code: "SCANNER_JOURNAL_INVALID",
			})
			expect(h.p.snapshotWorkerStatus()?.fallbacks).toBe(0)
		} finally {
			await h.close()
		}
	})
})

describe("snapshot worker fallback warnings (WG11 req 3.5)", () => {
	it("warns at most once an hour, counting the suppressed ones", () => {
		const warn = vi.fn()
		const clock = { now: OPS_T0 }
		const writer = new SnapshotWriter({
			logger: { warn } as unknown as Logger,
			now: () => clock.now,
			factory: () => {
				throw new Error("unused")
			},
		})
		writer.noteFallback("diverged")
		clock.now += 60_000
		writer.noteFallback("worker-failed")
		writer.noteFallback("diverged")
		expect(warn).toHaveBeenCalledTimes(1)
		clock.now += 3_600_000
		writer.noteFallback("diverged")
		expect(warn).toHaveBeenCalledTimes(2)
		expect(warn.mock.calls[1]?.[0]).toMatchObject({
			fallbacks: 4,
			suppressed: 2,
		})
		expect(writer.status()).toMatchObject({ fallbacks: 4, divergences: 3 })
	})
})
