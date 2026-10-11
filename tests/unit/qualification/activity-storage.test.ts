import { EventEmitter } from "node:events"
import * as fs from "node:fs"
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
		input: Iterable<{ producer: number; timeMs: number }>,
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
