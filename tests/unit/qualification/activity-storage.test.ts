import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"

// Existing script-test pattern: import an mjs URL dynamically (no declarations/package changes).
const source = resolve("scripts/qualification/activity-storage")
interface Config {
	scenario: string
	phase?: string
	seed?: number
	reserveBytes?: number
	deadlineMs?: number
	output?: string
	resourceWindow?: string
}
interface Counts {
	offered: number
	admitted: number
	rejected: number
	globalRejected: number
	producerRejected: number
}
interface Report {
	status: string
	output?: string
	counts: {
		offered: number
		admitted: number
		rejected: number
		committed: number
	} | null
	result?: {
		sqlite: string
		primitives: Record<string, unknown>
		initialPragmas: { journalMode: string; synchronous: number }
		finalPragmas: { journalMode: string; synchronous: number }
	}
	elapsedMs?: number
	deadlineExceeded?: boolean
	completion?: string
	diskError?: string
	cleanupError?: string
	reportError?: string
	artifacts?: { files: { name: string; sha256: string }[] }
	error?: string
}
interface FakeWorker extends EventEmitter {
	terminate: () => Promise<number>
}
const harness = (await import(pathToFileURL(join(source, "run.mjs")).href)) as {
	GiB: number
	LIMITS: { artifactBytes: number; memoryBytes: number }
	parseArgs: (args: string[]) => Config
	supportedRuntime: (version: string) => boolean
	diskGuard: (stats: unknown, reserve: number) => string
	prepareOutput: (
		output: string | undefined,
		reserve: number,
		root: string,
		statfs?: () => unknown,
	) => { path: string }
	inspectArtifacts: (path: string) => unknown
	supervise: (
		factory: () => FakeWorker,
		deadline: number,
		signal?: AbortSignal,
	) => Promise<unknown>
	run: (
		config: Config,
		options?: {
			version?: string
			root?: string
			statfs?: () => unknown
			workerFactory?: () => Worker | FakeWorker
			writeReport?: typeof fs.writeFileSync
			removeArtifact?: typeof fs.unlinkSync
			now?: () => number
			signal?: AbortSignal
		},
	) => Promise<Report>
}
const workload = (await import(
	pathToFileURL(join(source, "workloads.mjs")).href
)) as {
	offers: (
		scenario: string,
		seconds: number,
		seed?: number,
	) => Generator<{
		id: number
		producer: number
		timeMs: number
		payload: string
	}>
	admissionCounts: (
		input: Iterable<{ producer: number; timeMs?: number; timeUs?: number }>,
	) => Counts
}
const guards = (await import(
	pathToFileURL(join(source, "worker.mjs")).href
)) as {
	writeGuard: (
		usage: {
			queuedRows: number
			queuedBytes: number
			artifactBytes: number
			rssBytes: number
			free: unknown
		},
		reserve: number,
	) => void
	guardedWrite: (check: () => void, write: () => unknown) => unknown
}
const free = () => ({ bavail: 100n * BigInt(harness.GiB), bsize: 1n })
const roots: string[] = []
function sandbox() {
	const root = fs.realpathSync(
		fs.mkdtempSync(join(tmpdir(), "activity-qualification-test-")),
	)
	roots.push(root)
	return root
}
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true })
})
function fake() {
	return Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) })
}

function completedFixture(output: string) {
	fs.writeFileSync(join(output, "fixture.db"), "synthetic fixture")
	const worker = fake()
	queueMicrotask(() => {
		worker.emit("message", {
			status: "ok",
			counts: { offered: 0, admitted: 0, rejected: 0, committed: 0 },
		})
		worker.emit("exit", 0)
	})
	return worker
}
function savedReport(output: string): unknown {
	return JSON.parse(
		fs.readFileSync(join(output, "report.json"), "utf8"),
	) as unknown
}

describe("disposable activity qualification guards", () => {
	it("rejects malformed arguments, open enums, duplicates and hard-cap escapes", () => {
		for (const args of [
			["--wat", "x"],
			["--scenario"],
			["--scenario", "micro", "--scenario", "micro"],
			["--scenario", "nope"],
			["--seed", "43"],
			["--deadline-ms", "1200001"],
			["--deadline-ms", "0"],
			["--deadline-ms", "1e3"],
			["--reserve-gib", "0"],
			["--deadline-ms", "10001"],
			["--scenario", "steady"],
			["--resource-window", "short"],
		])
			expect(() => harness.parseArgs(args)).toThrow()
		expect(harness.parseArgs([]).scenario).toBe("disabled")
	})
	it("keeps disabled and unsupported-runtime paths free of worker/filesystem effects", async () => {
		const statfs = vi.fn(() => {
			throw new Error("filesystem touched")
		})
		const workerFactory = vi.fn(() => {
			throw new Error("worker spawned")
		})
		const root = join(tmpdir(), "never-create-activity-test")
		expect(
			(
				await harness.run(
					{ scenario: "disabled" },
					{ version: "20.19.0", root, statfs, workerFactory },
				)
			).status,
		).toBe("disabled")
		await expect(
			harness.run(
				{ scenario: "micro" },
				{ version: "22.12.9", root, statfs, workerFactory },
			),
		).rejects.toThrow("Unsupported")
		expect(statfs).not.toHaveBeenCalled()
		expect(workerFactory).not.toHaveBeenCalled()
		for (const version of ["20.19.0", "22.12.9", "garbage"])
			expect(harness.supportedRuntime(version)).toBe(false)
		for (const version of ["22.13.0", "22.23.3", "25.2.1"])
			expect(harness.supportedRuntime(version)).toBe(true)
	})
	it("reports long cases as not-run even with operator attestation", async () => {
		const statfs = vi.fn(() => {
			throw new Error("unexpected disk")
		})
		for (const scenario of [
			"steady",
			"burst",
			"overload",
			"queries",
			"retention",
			"crash",
			"combined",
		]) {
			expect(
				(
					await harness.run(
						{ scenario, resourceWindow: "Main window pending" },
						{ version: "25.2.1", statfs },
					)
				).status,
			).toBe("not-run")
		}
		expect(statfs).not.toHaveBeenCalled()
	})
	it("fails closed on unknown disk and requires eight GiB plus reserve", () => {
		for (const stats of [
			undefined,
			{},
			{ bavail: 99, bsize: 1 },
			{ bavail: 1n, bsize: 0n },
			{ bavail: 8n * BigInt(harness.GiB), bsize: 1n },
		])
			expect(() => harness.diskGuard(stats, harness.GiB)).toThrow()
		expect(
			harness.diskGuard(
				{ bavail: 9n * BigInt(harness.GiB), bsize: 1n },
				harness.GiB,
			),
		).toBe(String(9 * harness.GiB))
		const root = sandbox()
		expect(() =>
			harness.prepareOutput(undefined, harness.GiB, root, () => undefined),
		).toThrow()
		expect(fs.readdirSync(root)).toEqual([])
	})
	it("refuses arbitrary, preexisting and symlink output without deleting them", () => {
		const root = sandbox()
		fs.mkdirSync(join(root, "output", "qualification"), { recursive: true })
		const existing = join(root, "output", "qualification", "activity-existing")
		fs.mkdirSync(existing)
		fs.writeFileSync(join(existing, "keep"), "keep")
		fs.symlinkSync(
			existing,
			join(root, "output", "qualification", "activity-link"),
		)
		fs.symlinkSync(
			join(root, "absent"),
			join(root, "output", "qualification", "activity-dangling"),
		)
		for (const path of [
			existing,
			"output/qualification/activity-link",
			"output/qualification/activity-dangling",
			"../activity-escape",
			"output/qualification/nested/activity-x",
		])
			expect(() =>
				harness.prepareOutput(path, harness.GiB, root, free),
			).toThrow()
		expect(fs.readFileSync(join(existing, "keep"), "utf8")).toBe("keep")
		const other = sandbox()
		fs.symlinkSync(join(root, "output"), join(other, "output"))
		expect(() =>
			harness.prepareOutput(undefined, harness.GiB, other, free),
		).toThrow("Unsafe")
	})
	it("enforces queue, byte, RSS and transaction headroom quotas before writes", () => {
		const usage = {
			queuedRows: 10,
			queuedBytes: 26000,
			artifactBytes: 0,
			rssBytes: 1,
			free: free(),
		}
		for (const change of [
			{ queuedRows: 33 },
			{ queuedBytes: 128 * 1024 + 1 },
			{ queuedBytes: 144 * 1024 },
			{ artifactBytes: harness.LIMITS.artifactBytes },
			{ rssBytes: harness.LIMITS.memoryBytes + 1 },
			{ rssBytes: NaN },
			{ free: undefined },
		])
			expect(() =>
				guards.writeGuard({ ...usage, ...change }, harness.GiB),
			).toThrow()
		const write = vi.fn()
		expect(() =>
			guards.guardedWrite(() => {
				throw Object.assign(new Error("Injected ENOSPC"), { code: "ENOSPC" })
			}, write),
		).toThrow("ENOSPC")
		expect(write).not.toHaveBeenCalled()
		const root = sandbox()
		fs.writeFileSync(join(root, "fixture.db-wal"), "small")
		fs.symlinkSync(join(root, "fixture.db-wal"), join(root, "fixture.db"))
		expect(() => harness.inspectArtifacts(root)).toThrow("Unsafe")
	})
	it("has deterministic burst offers and exact independent overload rejection counts", () => {
		expect([...workload.offers("micro", 1)]).toEqual([
			...workload.offers("micro", 1),
		])
		const burst = workload.admissionCounts(workload.offers("burst", 60))
		expect(burst).toMatchObject({ offered: 5640, admitted: 5640, rejected: 0 })
		expect(
			workload.admissionCounts(workload.offers("steady", 60)),
		).toMatchObject({ offered: 6000, admitted: 6000, rejected: 0 })
		// Independent reference: all producers offer exactly 50/s, so only the
		// global bucket rejects. At t=(N-1)*2ms available tokens = 1000+floor(t/10).
		for (const seconds of [1, 3, 10, 60]) {
			const offered = seconds * 500
			const admitted = Math.min(
				offered,
				1000 + Math.floor(((offered - 1) * 2) / 10),
			)
			expect(
				workload.admissionCounts(workload.offers("overload", seconds)),
			).toEqual({
				offered,
				admitted,
				rejected: offered - admitted,
				globalRejected: offered - admitted,
				producerRejected: 0,
			})
		}
		const singleProducer = Array.from({ length: 500 }, (_, i) => ({
			producer: 0,
			timeMs: i * 10,
		}))
		expect(workload.admissionCounts(singleProducer)).toEqual({
			offered: 500,
			admitted: 449,
			rejected: 51,
			globalRejected: 0,
			producerRejected: 51,
		})
		expect(
			[...workload.offers("micro", 1)].every(
				row => Buffer.byteLength(row.payload) === 2560,
			),
		).toBe(true)
		expect(() => [...workload.offers("steady", 901)]).toThrow()
	})
	it("matches independent per-producer reference over 100 bounded schedules", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 1500 }), size => {
				const input = Array.from({ length: size }, (_, i) => ({
					producer: 0,
					timeMs: i * 10,
				}))
				const admitted = Math.min(size, 200 + Math.floor((size - 1) / 2))
				expect(workload.admissionCounts(input)).toEqual({
					offered: size,
					admitted,
					rejected: size - admitted,
					globalRejected: 0,
					producerRejected: size - admitted,
				})
			}),
			{ numRuns: 100, seed: 42 },
		)
	})
	it("joins workers on success, error, interrupted exit, timeout and cancellation", async () => {
		for (const kind of ["success", "error", "exit", "timeout", "cancel"]) {
			vi.useFakeTimers()
			const worker = fake()
			const controller = new AbortController()
			const pending = harness.supervise(() => worker, 100, controller.signal)
			const settled = pending.then(
				value => ({ value }),
				error => ({ error: String(error) }),
			)
			if (kind === "success") {
				worker.emit("message", { status: "ok" })
				worker.emit("exit", 0)
			}
			if (kind === "error") worker.emit("error", new Error("worker error"))
			if (kind === "exit") worker.emit("exit", 1)
			if (kind === "cancel") controller.abort()
			if (kind === "timeout") await vi.advanceTimersByTimeAsync(101)
			const outcome = await settled
			expect("error" in outcome).toBe(kind !== "success")
			expect(worker.terminate).toHaveBeenCalledTimes(1)
			expect(vi.getTimerCount()).toBe(0)
			vi.useRealTimers()
		}
		const controller = new AbortController()
		controller.abort()
		const factory = vi.fn(fake)
		await expect(
			harness.supervise(factory, 100, controller.signal),
		).rejects.toThrow("Cancelled")
		expect(factory).not.toHaveBeenCalled()
	})
	it.each(["stuck", "rejected"])(
		"signals fatal containment for %s termination without touching worker artifacts",
		async kind => {
			vi.useFakeTimers()
			const root = sandbox()
			const output = join(root, "output/qualification/activity-containment")
			const statfs = vi.fn(free)
			const worker = fake()
			worker.terminate.mockImplementation(() =>
				kind === "stuck"
					? new Promise<number>(() => {})
					: Promise.reject(new Error("termination rejected")),
			)
			const pending = harness.run(
				{ scenario: "micro", output, deadlineMs: 5 },
				{
					root,
					statfs,
					now: () => 0,
					workerFactory: () => {
						fs.writeFileSync(
							join(output, "fixture.db"),
							"still owned by worker",
						)
						return worker
					},
				},
			)
			const assertion = expect(pending).rejects.toMatchObject({
				name: "FatalContainmentError",
				fatalContainment: true,
				output,
			})
			await vi.advanceTimersByTimeAsync(105)
			await assertion
			expect(worker.terminate).toHaveBeenCalledTimes(1)
			expect(vi.getTimerCount()).toBe(0)
			expect(statfs).toHaveBeenCalledTimes(3)
			expect(fs.readdirSync(output)).toEqual(["fixture.db"])
			expect(fs.readFileSync(join(output, "fixture.db"), "utf8")).toBe(
				"still owned by worker",
			)
		},
	)
	it.each(["report", "cleanup"])(
		"includes delayed %s finalization in elapsed time and deadline failure",
		async phase => {
			const root = sandbox()
			const output = join(root, "output/qualification/activity-delay")
			let clock = 0
			const report = await harness.run(
				{ scenario: "micro", output, deadlineMs: 30 },
				{
					root,
					statfs: free,
					now: () => clock,
					workerFactory: () => completedFixture(output),
					writeReport: (...args) => {
						fs.writeFileSync(...args)
						if (phase === "report") clock += 50
					},
					removeArtifact: path => {
						fs.unlinkSync(path)
						if (phase === "cleanup") clock += 50
					},
				},
			)
			expect(report).toMatchObject({
				status: "failed",
				elapsedMs: 50,
				deadlineExceeded: true,
				completion: "observed",
			})
			expect(savedReport(output)).toMatchObject({
				status: "finalization-pending",
				completion: "pending",
				elapsedMs: 0,
			})
			expect(fs.readdirSync(output)).toEqual(["report.json"])
		},
	)
	it("saves hashes and removes verified DB after fourth statfs call fails", async () => {
		const root = sandbox()
		const output = join(root, "output/qualification/activity-statfs")
		const statfs = vi.fn(free)
		statfs.mockImplementationOnce(free).mockImplementationOnce(free)
		statfs.mockImplementationOnce(free).mockImplementationOnce(() => {
			throw new Error("final statfs failure")
		})
		const report = await harness.run(
			{ scenario: "micro", output },
			{ root, statfs, workerFactory: () => completedFixture(output) },
		)
		expect(report.status).toBe("failed")
		expect(report.diskError).toContain("final statfs failure")
		expect(report.artifacts?.files).toEqual([
			expect.objectContaining({
				name: "fixture.db",
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		])
		expect(savedReport(output)).toMatchObject({
			status: "failed",
			artifacts: report.artifacts,
		})
		expect(fs.readdirSync(output)).toEqual(["report.json"])
	})
	it("preserves a replaced unsafe cleanup path and its external target", async () => {
		const root = sandbox()
		const output = join(root, "output/qualification/activity-unsafe-cleanup")
		const external = join(root, "keep")
		fs.writeFileSync(external, "keep")
		const report = await harness.run(
			{ scenario: "micro", output },
			{
				root,
				statfs: free,
				workerFactory: () => completedFixture(output),
				writeReport: (...args) => {
					fs.writeFileSync(...args)
					fs.unlinkSync(join(output, "fixture.db"))
					fs.symlinkSync(external, join(output, "fixture.db"))
				},
			},
		)
		expect(report.status).toBe("failed")
		expect(report.cleanupError).toContain("Unsafe cleanup")
		expect(fs.lstatSync(join(output, "fixture.db")).isSymbolicLink()).toBe(true)
		expect(fs.readFileSync(external, "utf8")).toBe("keep")
		expect(savedReport(output)).toMatchObject({
			status: "finalization-pending",
			completion: "pending",
		})
	})

	it.each(["report", "cleanup"])(
		"reports %s errors explicitly and preserves DB",
		async phase => {
			const root = sandbox()
			const output = join(root, "output/qualification/activity-error")
			const fail = () => {
				throw new Error("injected finalization failure")
			}
			const report = await harness.run(
				{ scenario: "micro", output },
				{
					root,
					statfs: free,
					workerFactory: () => completedFixture(output),
					...(phase === "report"
						? { writeReport: fail }
						: { removeArtifact: fail }),
				},
			)
			expect(report.status).toBe("failed")
			expect(
				phase === "report" ? report.reportError : report.cleanupError,
			).toContain("injected finalization failure")
			expect(fs.existsSync(join(output, "fixture.db"))).toBe(true)
			if (phase === "cleanup")
				expect(savedReport(output)).toMatchObject({
					status: "finalization-pending",
					completion: "pending",
				})
			else expect(fs.existsSync(join(output, "report.json"))).toBe(false)
		},
	)

	it("terminates and joins real blocked worker threads on timeout and cancellation", async () => {
		for (const kind of ["timeout", "cancel"]) {
			const worker = new Worker(
				"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
				{ eval: true },
			)
			const controller = new AbortController()
			const pending = harness.supervise(() => worker, 100, controller.signal)
			const assertion = expect(pending).rejects.toThrow(
				kind === "timeout" ? "deadline" : "Cancelled",
			)
			if (kind === "cancel") controller.abort()
			await assertion
			expect(worker.threadId).toBe(-1)
		}
	})
	it("preserves a failure report and unknown counts after a real worker interruption", async () => {
		const root = sandbox()
		let worker: Worker | undefined
		const report = await harness.run(
			{ scenario: "micro" },
			{
				root,
				version: "25.2.1",
				statfs: free,
				workerFactory: () => {
					worker = new Worker("process.exit(7)", { eval: true })
					return worker
				},
			},
		)
		expect(report.status).toBe("failed")
		expect(report.counts).toBeNull()
		expect(report.error).toContain("exit 7")
		expect(worker?.threadId).toBe(-1)
		expect(fs.readdirSync(report.output!)).toEqual(["report.json"])
		const saved: unknown = JSON.parse(
			fs.readFileSync(join(report.output!, "report.json"), "utf8"),
		)
		expect(saved).toMatchObject({
			status: "failed",
			counts: null,
			qualificationClaim: false,
		})
	})
	it("real SQLite micro fixture and injected ENOSPC, with truthful capability skip", async context => {
		if (!harness.supportedRuntime(process.versions.node)) {
			context.skip()
			return
		}
		// Availability probe happens only in an explicitly started worker, never here.
		const root = sandbox()
		const runtime = await harness.run({ scenario: "runtime" }, { root })
		if (
			runtime.status === "failed" &&
			/No such built-in module|Cannot find|no such module: fts5/.test(
				runtime.error ?? "",
			)
		) {
			context.skip()
			return
		}
		expect(runtime.status).toBe("micro-only")
		expect(runtime.result?.initialPragmas).toMatchObject({
			journalMode: "memory",
			synchronous: 2,
		})
		const report = await harness.run({ scenario: "micro" }, { root })
		expect(report.status).toBe("micro-only")
		expect(report.counts).toEqual({
			offered: 10,
			admitted: 10,
			rejected: 0,
			committed: 10,
		})
		expect(report.result?.initialPragmas).toMatchObject({
			journalMode: "wal",
			synchronous: 2,
		})
		expect(report.result?.finalPragmas).toMatchObject({
			journalMode: "wal",
			synchronous: 2,
		})
		expect(report.result?.sqlite).toMatch(/^\d+\.\d+/)
		expect(report.result?.primitives).toMatchObject({
			ftsAvailable: true,
			rollback: true,
			retentionBeforeRetry: true,
			originalReceiptAfterPrune: true,
			explicitExpiry: true,
			cleanRestart: true,
		})
		expect(fs.readdirSync(report.output!)).toEqual(["report.json"])
		// Factory injection is test-only; CLI cannot request faults or arbitrary worker paths.
		let faultDirectory = ""
		const fault = await harness.run(
			{ scenario: "micro", output: "output/qualification/activity-enospc" },
			{
				root,
				workerFactory: () => {
					faultDirectory = join(
						root,
						"output",
						"qualification",
						"activity-enospc",
					)
					return new Worker(pathToFileURL(join(source, "worker.mjs")), {
						workerData: {
							scenario: "micro",
							directory: faultDirectory,
							root,
							identity: {
								inode: fs.lstatSync(faultDirectory).ino,
								device: fs.lstatSync(faultDirectory).dev,
							},
							limits: { queueRows: 32 },
							reserveBytes: harness.GiB,
							fault: "enospc",
						},
					})
				},
			},
		)
		expect(fault.status).toBe("failed")
		expect(fault.error).toContain("Injected ENOSPC")
		expect(fault.counts).toEqual({
			offered: 10,
			admitted: 10,
			rejected: 0,
			committed: 0,
		})
		expect(fs.readdirSync(faultDirectory)).toEqual(["report.json"])
	}, 20000)
})

interface DriverEvent {
	id: number
	producer: number
	timeUs: number
	payload: string
}
interface DriverSnapshot {
	mode: string
	counts: Record<string, number>
	warmup: Record<string, number> | null
	retainedRows: number
	retainedBytes: number
	controlRows: number
	controlBytes: number
	peakRows: number
	maxLatenessUs: number
}
interface Batch {
	id: number
	rows: { id: string }[]
	bytes: number
}
interface Driver {
	start: (now: number) => void
	turn: (
		now: number,
		available?: boolean,
	) => { processed: number; missed: number; done: boolean }
	admit: (event: DriverEvent, now: number, available?: boolean) => string
	batch: (now: number, force?: boolean) => Batch | null
	settle: (id: number, outcome: string) => boolean
	control: (id: number, bytes: number) => boolean
	releaseControl: (id: number) => boolean
	measure: (now: number) => void
	stop: () => void
	snapshot: () => DriverSnapshot
}
interface QuerySnapshot {
	planned: number
	totals: Record<string, number>
	classes: number[]
	pending: number
	terminalCount: number
	reconciled: boolean
}
interface QueryDriver {
	turn: (now: number) => number
	dispatch: (now: number) => number | null
	settle: (id: number, reason: string, replyBytes?: number) => boolean
	releaseReply: (client: number) => boolean
	stop: (deliberate?: boolean, joined?: boolean) => void
	snapshot: () => QuerySnapshot
}
interface Budget {
	reserve: (id: string, bytes: number) => void
	materialize: (id: string, bytes: number, remaining?: number) => void
	check: (free: unknown) => {
		measured: number
		reserved: number
		total: number
	}
	usage: () => { measured: number; reserved: number; total: number }
	transaction: (inventory: unknown, growth?: unknown) => void
	reserveCapture: (runId: string) => { bytes: number; consumer: string }
}
const delivery = (await import(
	pathToFileURL(join(source, "run.mjs")).href
)) as {
	admissionDriver: (scenario: string, seconds?: number) => Driver
	queryAccounting: (seconds?: number) => QueryDriver
	artifactBudget: (reserve?: number) => Budget
	inventoryArtifacts: (
		path: string,
		long?: boolean,
	) => { bytes: number; files: unknown[] }
	inspectArtifacts: (
		path: string,
		check?: () => void,
	) => { files: { sha256: string }[] }
	stageDeadline: (now: () => number) => {
		enter: (stage: string) => void
		check: () => number
		snapshot: () => { stage: string; elapsedMs: number }
		supervise: (
			factory: () => FakeWorker,
			signal?: AbortSignal,
		) => Promise<unknown>
	}
}
const schedules = (await import(
	pathToFileURL(join(source, "workloads.mjs")).href
)) as {
	offers: (scenario: string, seconds: number) => Generator<DriverEvent>
	offerSchedule: (
		scenario: string,
		seconds: number,
	) => {
		skipBefore: (cutoff: number) => number
		nextDue: (now: number) => DriverEvent | null
		done: boolean
	}
	queryOffers: (seconds?: number) => Generator<{
		id: number
		client: number
		timeUs: number
		queryClass: number
	}>
}
function event(id: number, timeUs = 0, bytes = 2560): DriverEvent {
	return { id, producer: id % 10, timeUs, payload: "x".repeat(bytes) }
}
function wireBytes(row: DriverEvent) {
	return Buffer.byteLength(
		JSON.stringify({
			id: `warmup:${row.id}`,
			producer: row.producer,
			timeUs: row.timeUs,
			payload: row.payload,
		}),
	)
}

function acknowledge(driver: Driver, now: number) {
	let batch
	while ((batch = driver.batch(now, true))) driver.settle(batch.id, "committed")
}
function warmed(scenario: string, seconds = 1) {
	const driver = delivery.admissionDriver(scenario, seconds)
	driver.start(0)
	for (let now = 0; now < 25000000; now += 10000) {
		driver.turn(now)
		acknowledge(driver, now)
	}
	driver.turn(30000000)
	driver.measure(30000000)
	return driver
}

describe("allocated driver delivery, virtual evidence only", () => {
	it("closes scenario/phase combinations and leaves every real long phase not-run", async () => {
		for (const args of [
			["--phase", "both"],
			["--scenario", "micro", "--phase", "storage"],
			[
				"--scenario",
				"steady",
				"--phase",
				"both",
				"--resource-window",
				"pending window",
			],
		])
			expect(() => harness.parseArgs(args)).toThrow()
		const workerFactory = vi.fn(() => {
			throw new Error("not released")
		})
		const statfs = vi.fn(() => {
			throw new Error("not released")
		})
		for (const scenario of [
			"steady",
			"burst",
			"overload",
			"queries",
			"retention",
			"crash",
			"combined",
		]) {
			for (const phase of ["baseline", "storage"]) {
				const config = harness.parseArgs([
					"--scenario",
					scenario,
					"--phase",
					phase,
					"--resource-window",
					"pending window",
				])
				const report = await harness.run(config, { workerFactory, statfs })
				expect(report).toMatchObject({
					status: "not-run",
					phase,
					qualificationClaim: false,
					remainingPrerequisites: expect.arrayContaining([
						expect.stringContaining(
							"current worker accepts micro/runtime only",
						),
						expect.stringContaining("capped pipe consumer"),
					]),
				})
			}
		}
		expect(workerFactory).not.toHaveBeenCalled()
		expect(statfs).not.toHaveBeenCalled()
	})
	it("checks the exact 900-second totals and integer overload reference without waiting", () => {
		for (const [scenario, offered, admitted] of [
			["steady", 90000, 90000],
			["burst", 84600, 84600],
			["overload", 450000, 90999],
		] as const) {
			expect(workload.admissionCounts(schedules.offers(scenario, 900))).toEqual(
				{
					offered,
					admitted,
					rejected: offered - admitted,
					globalRejected: offered - admitted,
					producerRejected: 0,
				},
			)
		}
	})
	it("matches streamed seed payloads after arithmetic stale skips over 100 cases", () => {
		// Feature: activity-recording-catalog, Property 5: Bounded failure
		// Validates: Requirements 2.3, 7.2
		fc.assert(
			fc.property(
				fc.constantFrom("steady", "burst", "overload"),
				fc.integer({ min: 0, max: 59999999 }),
				(scenario, cutoff) => {
					const cursor = schedules.offerSchedule(scenario, 60)
					let skipped = 0
					let second = 0
					let slot = 0
					for (; second < 60; second++) {
						const rate =
							scenario === "overload"
								? 500
								: scenario === "burst"
									? second % 60 < 58
										? 80
										: 500
									: 100
						for (slot = 0; slot < rate; slot++) {
							if (second * 1000000 + slot * (1000000 / rate) >= cutoff) break
							skipped++
						}
						if (slot < rate) break
					}
					let random = 42
					for (let i = 0; i <= skipped; i++)
						random = (Math.imul(random, 1664525) + 1013904223) >>> 0
					const rate =
						scenario === "overload"
							? 500
							: scenario === "burst"
								? second % 60 < 58
									? 80
									: 500
								: 100
					const timeUs = second * 1000000 + slot * (1000000 / rate)
					expect(cursor.skipBefore(cutoff)).toBe(skipped)
					expect(cursor.nextDue(60000000)).toEqual(
						second === 60
							? null
							: {
									id: skipped + 1,
									producer: slot % 10,
									timeUs,
									timeMs: timeUs / 1000,
									payload: `synthetic seed42 ${random} `.padEnd(2560, "x"),
								},
					)
				},
			),
			{ numRuns: 100, seed: 42 },
		)
	})
	it("uses the strict 20ms boundary and caps repeated turns including huge stale backlogs", () => {
		const onTime = delivery.admissionDriver("steady", 1)
		onTime.start(0)
		expect(onTime.turn(20000)).toMatchObject({ processed: 3, missed: 0 })
		const late = delivery.admissionDriver("steady", 1)
		late.start(0)
		expect(late.turn(20001)).toMatchObject({ processed: 2, missed: 1 })
		const cursor = schedules.offerSchedule("overload", 900)
		expect(cursor.skipBefore(899978000)).toBe(449989)
		let count = 0
		while (cursor.nextDue(900000000)) count++
		expect(count).toBe(11)
		// 100/s warmup has no more than three offers within the allowed window.
		expect(late.turn(24999000).processed).toBeLessThanOrEqual(64)
		expect(late.snapshot().counts["schedulerMissed"]).toBeGreaterThan(2400)
	})
	it("drains 25s warmup and resets all measured state at a fresh epoch", () => {
		const driver = warmed("overload", 3)
		expect(driver.snapshot()).toMatchObject({
			mode: "load",
			warmup: { admitted: 2500, committed: 2500, offered: 2500 },
			counts: { admitted: 0, offered: 0, schedulerMissed: 0 },
			retainedRows: 0,
			peakRows: 0,
		})
		for (let now = 30000000; now < 33000000; now += 2000) {
			driver.turn(now)
			acknowledge(driver, now)
		}
		expect(driver.snapshot().counts).toMatchObject({
			offered: 1500,
			admitted: 1299,
			globalRejected: 201,
			committed: 1299,
		})
		const incomplete = delivery.admissionDriver("steady", 1)
		incomplete.start(0)
		incomplete.turn(0)
		expect(() => incomplete.measure(30000000)).toThrow("Warmup")
		const undrained = delivery.admissionDriver("steady", 1)
		undrained.start(0)
		undrained.turn(25000000)
		expect(() => undrained.measure(30000000)).toThrow("Warmup")
		expect(() => warmed("steady").measure(60000000)).toThrow()
	})
	it("charges real queue rows and bytes through fake-worker acknowledgement", () => {
		const driver = delivery.admissionDriver("steady", 1)
		const worker = fake()
		worker.on("message", (id: number) => driver.settle(id, "committed"))
		for (let i = 0; i < 1024; i++)
			expect(driver.admit(event(i, i * 10000), i * 10000)).toBe("admitted")
		const batch = driver.batch(10240000, true)!
		expect(batch.rows).toHaveLength(64)
		expect(driver.batch(10240000, true)).toBeNull()
		expect(driver.snapshot()).toMatchObject({
			retainedRows: 1024,
			retainedBytes: Array.from({ length: 1024 }, (_, i) =>
				wireBytes(event(i, i * 10000)),
			).reduce((sum, bytes) => sum + bytes, 0),
		})
		expect(driver.admit(event(1024, 10240000), 10240000)).toBe("queueDenied")
		worker.emit("message", batch.id)
		expect(driver.snapshot().retainedRows).toBe(960)
		expect(driver.admit(event(1025, 10250000), 10250000)).toBe("admitted")
		worker.emit("message", batch.id)
		expect(driver.snapshot().counts["duplicateReceipts"]).toBe(1)
		driver.stop()
		const snapshot = driver.snapshot()
		expect(snapshot.counts["admitted"]).toBe(
			snapshot.counts["committed"]! +
				snapshot.counts["failed"]! +
				snapshot.counts["uncertain"]!,
		)
		expect(snapshot.retainedBytes).toBe(0)
	})
	it("accepts 144KiB, bounds batch bytes/dwell and separates data/control capacity", () => {
		const driver = delivery.admissionDriver("steady", 1)
		expect(driver.admit(event(0, 0, 144 * 1024), 0)).toBe("admitted")
		expect(driver.admit(event(1, 0, 144 * 1024 + 1), 0)).toBe("invalid")
		expect(driver.admit(event(2, 0, 144 * 1024), 0)).toBe("admitted")
		expect(driver.batch(19999)).toBeNull()
		const batch = driver.batch(20000)!
		expect(batch.rows).toHaveLength(1)
		expect(batch.bytes).toBe(wireBytes(event(0, 0, 144 * 1024)))
		for (let i = 0; i < 127; i++) expect(driver.control(i, 16384)).toBe(true)
		expect(driver.control(128, 1)).toBe(false)
		expect(driver.snapshot()).toMatchObject({
			retainedBytes:
				wireBytes(event(0, 0, 144 * 1024)) + wireBytes(event(2, 0, 144 * 1024)),
			controlBytes: 127 * 16384 + 1024,
			controlRows: 128,
		})
		expect(driver.releaseControl(0)).toBe(true)
		expect(driver.control(128, 32768)).toBe(false)
		expect(driver.releaseControl(0)).toBe(false)
		driver.settle(batch.id, "uncertain")
		expect(driver.snapshot().counts["uncertain"]).toBe(1)
		const bytes = delivery.admissionDriver("steady", 1)
		for (let i = 0; i < 56; i++)
			expect(bytes.admit(event(i, 0, 144 * 1024), 0)).toBe("admitted")
		expect(bytes.admit(event(56, 0, 144 * 1024), 0)).toBe("queueDenied")
	})
	it("consumes tokens only for admission, with independent bounded queue/release traces", () => {
		// Feature: activity-recording-catalog, Property 5: Bounded failure
		// Validates: Requirements 2.3, 5.4, 7.2
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						delta: fc.integer({ min: 0, max: 10000 }),
						producer: fc.integer({ min: 0, max: 9 }),
						bytes: fc.constantFrom(0, 2560, 16384, 32768),
						release: fc.boolean(),
						available: fc.boolean(),
					}),
					{ minLength: 100, maxLength: 160 },
				),
				actions => {
					const driver = delivery.admissionDriver("steady", 1)
					let global = 1000000000
					const tokens = Array<number>(10).fill(200000000)
					const last = Array<number>(10).fill(0)
					let time = 0
					let previous = 0
					let rows = 0
					let bytes = 0
					const queued: number[] = []
					for (const [id, action] of actions.entries()) {
						time += action.delta
						const input = {
							...event(id, time, action.bytes),
							producer: action.producer,
						}
						const serializedBytes = wireBytes(input)
						global = Math.min(1000000000, global + (time - previous) * 100)
						previous = time
						tokens[action.producer] = Math.min(
							200000000,
							tokens[action.producer]! + (time - last[action.producer]!) * 50,
						)
						last[action.producer] = time
						const reason =
							!action.bytes || action.bytes > 144 * 1024
								? "invalid"
								: tokens[action.producer]! < 1000000
									? "producerRejected"
									: global < 1000000
										? "globalRejected"
										: rows >= 1024 || bytes + serializedBytes > 8 * 1024 ** 2
											? "queueDenied"
											: !action.available
												? "storageDenied"
												: "admitted"
						expect(driver.admit(input, time, action.available)).toBe(reason)
						if (reason === "admitted") {
							global -= 1000000
							tokens[action.producer]! -= 1000000
							rows++
							bytes += serializedBytes
							queued.push(serializedBytes)
						}
						if (action.release) {
							const batch = driver.batch(time, true)
							if (batch) {
								let expectedBytes = 0
								let expectedRows = 0
								while (
									expectedRows < queued.length &&
									expectedRows < 64 &&
									expectedBytes + queued[expectedRows]! <= 256 * 1024
								) {
									expectedBytes += queued[expectedRows]!
									expectedRows++
								}
								expect(batch.bytes).toBe(expectedBytes)
								expect(batch.rows).toHaveLength(expectedRows)
								queued.splice(0, expectedRows)
								rows -= expectedRows
								bytes -= expectedBytes
								driver.settle(batch.id, "committed")
							}
						}
						expect(driver.snapshot()).toMatchObject({
							retainedRows: rows,
							retainedBytes: bytes,
						})
					}
				},
			),
			{ numRuns: 100, seed: 42 },
		)
	})
	it("has exactly 7200 planned query slots and 900 of each class, without actual queries", () => {
		const counts = Array<number>(8).fill(0)
		let slots = 0
		const driver = delivery.queryAccounting()
		for (const slot of schedules.queryOffers()) {
			expect(slot.timeUs).toBe(
				Math.floor(slots / 8) * 1000000 + (slots % 8) * 125000,
			)
			expect(slot.queryClass).toBe((Math.floor(slots / 8) + (slots % 8)) % 8)
			counts[slot.queryClass]!++
			slots++
			driver.turn(slot.timeUs)
			const id = driver.dispatch(slot.timeUs)!
			expect(driver.settle(id, "successful")).toBe(true)
			expect(driver.settle(id, "successful")).toBe(false)
		}
		driver.stop()
		expect(slots).toBe(7200)
		expect(counts).toEqual(Array(8).fill(900))
		expect(driver.snapshot()).toMatchObject({
			planned: 7200,
			terminalCount: 7200,
			reconciled: true,
			classes: counts,
			totals: { successful: 7200, "not-offered-after-stop": 0 },
		})
	})
	it("partitions query lateness, timeout/reply races, cancel/unknown and future slots once", () => {
		const late = delivery.queryAccounting(2)
		late.turn(20001)
		late.stop()
		expect(late.snapshot().totals).toMatchObject({
			"scheduler-missed": 1,
			"not-offered-after-stop": 15,
		})
		for (const joined of [true, false]) {
			const driver = delivery.queryAccounting(2)
			driver.turn(0)
			expect(driver.dispatch(0)).toBe(0)
			driver.turn(125000)
			driver.stop(true, joined)
			expect(driver.settle(0, "successful")).toBe(false)
			expect(driver.snapshot()).toMatchObject({
				terminalCount: 16,
				reconciled: true,
				totals: {
					"cancelled-before-dispatch": 1,
					"cancelled-in-flight": joined ? 1 : 0,
					"interrupted-unknown": joined ? 0 : 1,
					"not-offered-after-stop": 14,
				},
			})
		}
		const timeout = delivery.queryAccounting(1)
		timeout.turn(0)
		timeout.dispatch(0)
		timeout.dispatch(250000)
		expect(timeout.settle(0, "successful")).toBe(false)
		timeout.stop(true, true)
		expect(timeout.snapshot().totals).toMatchObject({
			"active-timeout": 1,
			"not-offered-after-stop": 7,
		})
		const before = delivery.queryAccounting(900)
		before.stop()
		expect(before.snapshot()).toMatchObject({
			terminalCount: 7200,
			totals: { "not-offered-after-stop": 7200 },
			reconciled: true,
		})
	})
	it("reconciles 100 independent scaled query stop/miss schedules", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 30 }),
				fc.integer({ min: 0, max: 240 }),
				fc.array(fc.boolean(), { minLength: 240, maxLength: 240 }),
				(seconds, stopAt, misses) => {
					const driver = delivery.queryAccounting(seconds)
					const issued = Math.min(seconds * 8, stopAt)
					let success = 0
					let missed = 0
					for (let id = 0; id < issued; id++) {
						const now = id * 125000 + (misses[id] ? 20001 : 20000)
						driver.turn(now)
						if (misses[id]) missed++
						else {
							success++
							expect(driver.dispatch(now)).toBe(id)
							driver.settle(id, "successful")
						}
					}
					driver.stop()
					expect(driver.snapshot()).toMatchObject({
						terminalCount: seconds * 8,
						reconciled: true,
						totals: {
							successful: success,
							"scheduler-missed": missed,
							"not-offered-after-stop": seconds * 8 - issued,
						},
					})
				},
			),
			{ numRuns: 100, seed: 42 },
		)
	})
	it("keeps physical bytes and reservations disjoint, denies unknown space/growth and reserves capture separately", () => {
		const budget = delivery.artifactBudget()
		const capture = budget.reserveCapture(
			"00000000-0000-0000-0000-000000000042",
		)
		expect(capture).toMatchObject({
			bytes: 4 * 1024 ** 2,
			consumer: expect.stringContaining("not-run"),
		})
		budget.reserve("writer", 1024 * 1024)
		budget.materialize("writer", 100000, 1024 * 1024 - 100000)
		expect(budget.usage()).toEqual({
			measured: 100000,
			reserved: 5 * 1024 ** 2 - 100000,
			total: 5 * 1024 ** 2,
		})
		expect(() => budget.materialize("writer", 1024 * 1024 + 1)).toThrow(
			"Unreserved",
		)
		expect(() => budget.reserve("writer", 1)).toThrow()
		expect(() => budget.reserve("overflow", 4 * harness.GiB)).toThrow()
		expect(() => budget.check(undefined)).toThrow("Unknown")
		expect(() =>
			budget.check({ bavail: BigInt(9 * harness.GiB), bsize: 1n }),
		).toThrow("Reservation")
		expect(budget.check(free()).total).toBe(5 * 1024 ** 2)
		for (const growth of [
			undefined,
			{ dbBytes: 0, walBytes: 0 },
			{ enforced: true, dbBytes: NaN, walBytes: 0 },
		])
			expect(() =>
				budget.transaction({ dbBytes: 0, walBytes: 0 }, growth),
			).toThrow()
		expect(() =>
			budget.transaction(
				{ dbBytes: 2 * harness.GiB, walBytes: 0 },
				{ enforced: true, dbBytes: 1, walBytes: 0 },
			),
		).toThrow("growth gate")
		expect(() =>
			budget.transaction(
				{ dbBytes: 0, walBytes: 64 * 1024 ** 2 },
				{ enforced: true, dbBytes: 0, walBytes: 1 },
			),
		).toThrow("growth gate")
	})
	it("bounds metadata-only live inventory and hashes post-join in 64KiB blocks with deadline checks", () => {
		const root = sandbox()
		fs.writeFileSync(join(root, "fixture.db"), Buffer.alloc(200000, 42))
		const read = vi.spyOn(nodeFs, "readSync")
		expect(delivery.inventoryArtifacts(root).bytes).toBe(200000)
		expect(read).not.toHaveBeenCalled()
		const check = vi.fn()
		expect(delivery.inspectArtifacts(root, check).files[0]?.sha256).toMatch(
			/^[a-f0-9]{64}$/,
		)
		expect(
			read.mock.calls.every(call => Array.from<unknown>(call)[3] === 65536),
		).toBe(true)
		expect(check).toHaveBeenCalledTimes(5)
		let blocks = 0
		expect(() =>
			delivery.inspectArtifacts(root, () => {
				if (++blocks === 2) throw new Error("deadline")
			}),
		).toThrow("deadline")
		expect(fs.statSync(join(root, "fixture.db")).size).toBe(200000)
	})
	it("shares stage/end-to-end deadlines across worker replacements with no reset", async () => {
		let clock = 0
		const deadline = delivery.stageDeadline(() => clock)
		expect(deadline.check()).toBe(180000)
		clock = 180000
		deadline.enter("warmup")
		clock += 30000
		deadline.enter("load")
		clock += 900000
		deadline.enter("drain")
		clock += 15000
		deadline.enter("finalization")
		expect(deadline.check()).toBe(75000)
		clock += 74999
		vi.useFakeTimers()
		const worker = fake()
		const pending = deadline.supervise(() => worker)
		const assertion = expect(pending).rejects.toThrow("deadline")
		await vi.advanceTimersByTimeAsync(1)
		await assertion
		expect(worker.terminate).toHaveBeenCalledOnce()
		expect(deadline.check()).toBe(1)
		clock += 2
		expect(() => deadline.check()).toThrow("finalization")
		expect(() => deadline.enter("setup")).toThrow()
		const failedSetup = delivery.stageDeadline(() => clock)
		clock += 180001
		expect(() => failedSetup.enter("warmup")).toThrow("setup")
	})
})

describe("driver containment edge fixtures", () => {
	it("does not burn tokens for queue/storage denial, and never batches escaped oversize", () => {
		const driver = delivery.admissionDriver("steady", 1)
		for (let id = 0; id < 56; id++) driver.admit(event(id, 0, 144 * 1024), 0)
		for (let id = 0; id < 300; id++)
			expect(
				driver.admit({ ...event(1000 + id, 0, 144 * 1024), producer: 0 }, 0),
			).toBe("queueDenied")
		const first = driver.batch(0, true)!
		driver.settle(first.id, "committed")
		acknowledge(driver, 0)
		for (let id = 0; id < 194; id++)
			expect(driver.admit({ ...event(2000 + id), producer: 0 }, 0)).toBe(
				"admitted",
			)
		expect(driver.admit({ ...event(3000), producer: 0 }, 0)).toBe(
			"producerRejected",
		)
		const unavailable = delivery.admissionDriver("steady", 1)
		for (let id = 0; id < 300; id++)
			expect(unavailable.admit({ ...event(id), producer: 0 }, 0, false)).toBe(
				"storageDenied",
			)
		for (let id = 0; id < 200; id++)
			expect(unavailable.admit({ ...event(id), producer: 0 }, 0)).toBe(
				"admitted",
			)
		expect(unavailable.admit({ ...event(201), producer: 0 }, 0)).toBe(
			"producerRejected",
		)
		const escaped = delivery.admissionDriver("steady", 1)
		expect(
			escaped.admit({ ...event(0), payload: '"'.repeat(144 * 1024) }, 0),
		).toBe("invalid")
		expect(escaped.batch(0, true)).toBeNull()
	})
	it("charges a batch control envelope until ack and refuses to bypass a full control queue", () => {
		const driver = delivery.admissionDriver("steady", 1)
		driver.admit(event(0), 0)
		for (let id = 0; id < 128; id++) expect(driver.control(id, 1)).toBe(true)
		expect(driver.batch(20000)).toBeNull()
		expect(driver.snapshot().retainedRows).toBe(1)
		driver.releaseControl(0)
		const batch = driver.batch(20000)!
		expect(driver.snapshot()).toMatchObject({
			controlRows: 128,
			controlBytes: 127 + 1024,
		})
		driver.settle(batch.id, "failed")
		expect(driver.snapshot()).toMatchObject({
			controlRows: 127,
			controlBytes: 127,
			counts: { failed: 1, acknowledged: 1 },
		})
	})
	it("accounts query busy/queue denial, queued expiry and failure beside successes", () => {
		const driver = delivery.queryAccounting(2)
		driver.turn(0)
		driver.dispatch(0)
		for (let id = 1; id <= 8; id++) driver.turn(id * 125000)
		expect(driver.snapshot().totals).toMatchObject({
			"queue-denied": 3,
			"client-busy": 1,
		})
		expect(driver.dispatch(1000000)).toBeNull()
		driver.stop()
		expect(driver.snapshot()).toMatchObject({
			terminalCount: 16,
			reconciled: true,
			totals: {
				"active-timeout": 1,
				"queue-expired": 4,
				"not-offered-after-stop": 7,
			},
		})
		const failed = delivery.queryAccounting(1)
		failed.turn(0)
		failed.dispatch(0)
		expect(failed.settle(0, "query-failed")).toBe(true)
		failed.stop()
		failed.stop()
		expect(failed.snapshot().totals["query-failed"]).toBe(1)
		expect(() => failed.settle(0, "invented")).toThrow()
	})
	it("caps replacements at 32, rejects overlapping roles and keeps fixed phase durations", async () => {
		let clock = 0
		const deadline = delivery.stageDeadline(() => clock)
		const complete = () => {
			const worker = fake()
			queueMicrotask(() => {
				worker.emit("message", { status: "ok" })
				worker.emit("exit", 0)
			})
			return worker
		}
		for (let i = 0; i <= 32; i++) await deadline.supervise(complete)
		const factory = vi.fn(complete)
		await expect(deadline.supervise(factory)).rejects.toThrow("replacement cap")
		expect(factory).not.toHaveBeenCalled()
		const fixed = delivery.stageDeadline(() => clock)
		fixed.enter("warmup")
		expect(() => fixed.enter("load")).toThrow("Fixed phase")
		clock = 30000
		fixed.enter("load")
		clock += 899999
		expect(() => fixed.enter("drain")).toThrow("Fixed phase")
		const active = delivery.stageDeadline(() => clock)
		const worker = fake()
		const controller = new AbortController()
		const pending = active.supervise(() => worker, controller.signal)
		const assertion = expect(pending).rejects.toThrow("Cancelled")
		await expect(active.supervise(factory)).rejects.toThrow("role not admitted")
		controller.abort()
		await assertion
		expect(worker.terminate).toHaveBeenCalledOnce()
	})
	it("bounds worker results and still joins on a rejected oversized receipt", async () => {
		const worker = fake()
		const pending = harness.supervise(() => worker, 100)
		const assertion = expect(pending).rejects.toThrow("result quota")
		worker.emit("message", { status: "ok", text: "x".repeat(128 * 1024) })
		await assertion
		expect(worker.terminate).toHaveBeenCalledOnce()
	})
	it("preserves bounded residue evidence when a post-join hash deadline expires", async () => {
		const root = sandbox()
		const output = join(root, "output/qualification/activity-hash-deadline")
		let clock = 0
		const report = await harness.run(
			{ scenario: "micro", output, deadlineMs: 5 },
			{
				root,
				statfs: free,
				workerFactory: () => completedFixture(output),
				now: () => {
					const value = clock
					clock += 2
					return value
				},
			},
		)
		expect(report.status).toBe("failed")
		expect(report.deadlineExceeded).toBe(true)
		expect(savedReport(output)).toMatchObject({
			completion: "pending",
			status: "failed",
		})
		expect(report).toMatchObject({
			residue: { path: output, bytes: expect.any(Number) },
		})
	})
})

describe("query reply retention accounting only", () => {
	it("bounds retained replies and denies the same client's fixed slot without postponing it", () => {
		const driver = delivery.queryAccounting(2)
		driver.turn(0)
		expect(() => driver.settle(0, "successful")).toThrow("before dispatch")
		driver.dispatch(0)
		expect(driver.settle(0, "successful", 1024 * 1024)).toBe(true)
		driver.turn(125000)
		driver.dispatch(125000)
		driver.settle(1, "successful", 1024 * 1024)
		driver.turn(250000)
		driver.dispatch(250000)
		expect(() => driver.settle(2, "successful", 1)).toThrow("quota")
		expect(driver.releaseReply(0)).toBe(true)
		expect(driver.releaseReply(0)).toBe(false)
		driver.settle(2, "successful")
		for (let id = 3; id <= 9; id++) {
			driver.turn(id * 125000)
			const active = driver.dispatch(id * 125000)
			if (active !== null) driver.settle(active, "successful")
		}
		expect(driver.snapshot().totals["client-busy"]).toBe(1)
		driver.stop()
		expect(driver.snapshot()).toMatchObject({
			reconciled: true,
			terminalCount: 16,
			retainedReplyBytes: 0,
			retainedReplies: 0,
			totals: { "not-offered-after-stop": 6 },
		})
	})
})
