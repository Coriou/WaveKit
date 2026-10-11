// Explicit disposable driver. Importing this file never creates state or starts work.
import * as fs from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { arch, platform, release } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { offerSchedule, tokenBuckets, WORKLOAD_VERSION } from "./workloads.mjs"

export const GiB = 1024 ** 3
export const LIMITS = Object.freeze({
	artifactBytes: 4 * GiB,
	reserveBytes: GiB,
	deadlineMs: 20 * 60 * 1000,
	microDeadlineMs: 10000,
	terminationGraceMs: 100,
	memoryBytes: 192 * 1024 ** 2,
	queueRows: 32,
	queueBytes: 128 * 1024,
	dbBytes: 16 * 1024 ** 2,
	walBytes: 4 * 1024 ** 2,
})
export const SCENARIOS = [
	"disabled",
	"runtime",
	"micro",
	"steady",
	"burst",
	"overload",
	"queries",
	"retention",
	"crash",
	"combined",
]
const LONG = SCENARIOS.slice(3)
export const PHASES = Object.freeze(["baseline", "storage"])
export const LONG_PREREQUISITES = Object.freeze([
	"Accepted writer batch/ack protocol and baseline ack path (current worker accepts micro/runtime only through CLI; tiny is fixture-only)",
	"Enforced conservative DB/WAL transaction growth bounds for every mutation, including setup and receipts",
	"Accepted read-only query worker, receipt/fault contracts and exact extension qualification",
	"Owned 4MiB capture reservation and separately accepted capped pipe consumer with post-exit verification",
	"Exact independent implementation review and individually allocated execution window",
])
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
export const UNVERIFIED = [
	"Node20 disabled executable",
	"Node22.13.0",
	"Node22.23.3",
	"native Linux AMD64/ARM64",
	"15-minute paired baseline",
	"combined scanner",
	"power loss/fsync",
	"query matrix",
	"64MiB WAL pressure",
	"20 receipt epochs",
]

export function parseArgs(args) {
	const config = {
		scenario: "disabled",
		seed: 42,
		reserveBytes: GiB,
		deadlineMs: 10000,
	}
	const seen = new Set()
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i]
		const value = args[i + 1]
		if (
			![
				"--scenario",
				"--phase",
				"--output",
				"--seed",
				"--reserve-gib",
				"--deadline-ms",
				"--resource-window",
			].includes(key) ||
			seen.has(key) ||
			!value ||
			value.startsWith("--")
		)
			throw new Error("Malformed or unknown argument")
		seen.add(key)
		if (key === "--scenario") config.scenario = value
		else if (key === "--phase") config.phase = value
		else if (key === "--output") config.output = value
		else if (key === "--resource-window") {
			if (!/^[\x20-\x7e]{8,200}$/.test(value) || !value.trim())
				throw new Error("Invalid operator attestation")
			config.resourceWindow = value
		} else {
			if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))
				throw new Error("Invalid integer")
			if (key === "--seed") config.seed = Number(value)
			if (key === "--reserve-gib") config.reserveBytes = Number(value) * GiB
			if (key === "--deadline-ms") config.deadlineMs = Number(value)
		}
	}
	if (
		!SCENARIOS.includes(config.scenario) ||
		config.seed !== 42 ||
		config.reserveBytes < GiB ||
		config.reserveBytes > 64 * GiB ||
		config.deadlineMs < 1 ||
		config.deadlineMs > LIMITS.deadlineMs
	)
		throw new Error("Hard cap or scenario rejected")
	if (
		!LONG.includes(config.scenario) &&
		config.deadlineMs > LIMITS.microDeadlineMs
	)
		throw new Error("Micro deadline cap")
	if (
		config.phase !== undefined &&
		(!PHASES.includes(config.phase) || !LONG.includes(config.scenario))
	)
		throw new Error("Invalid phase for scenario")
	if (LONG.includes(config.scenario)) config.phase ??= "storage"
	if (LONG.includes(config.scenario) && !config.resourceWindow)
		throw new Error(
			"Long scenarios require --resource-window operator attestation",
		)
	return config
}

export function supportedRuntime(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
	return (
		!!match &&
		(Number(match[1]) > 22 ||
			(Number(match[1]) === 22 && Number(match[2]) >= 13))
	)
}

export function diskGuard(stats, reserveBytes) {
	if (
		!Number.isSafeInteger(reserveBytes) ||
		reserveBytes < GiB ||
		reserveBytes > 64 * GiB
	)
		throw new Error("Invalid disk reserve")
	if (
		!stats ||
		typeof stats.bavail !== "bigint" ||
		typeof stats.bsize !== "bigint" ||
		stats.bavail < 0n ||
		stats.bsize <= 0n
	)
		throw new Error("Unknown disk availability")
	const free = stats.bavail * stats.bsize
	if (free < BigInt(8 * GiB + reserveBytes))
		throw new Error("Disk reserve breached")
	return free.toString()
}

function directory(path, create = false) {
	try {
		const info = fs.lstatSync(path)
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("Unsafe output ancestor")
	} catch (error) {
		if (create && error.code === "ENOENT") fs.mkdirSync(path, { mode: 0o700 })
		else throw error
	}
}

export function prepareOutput(
	output,
	reserveBytes,
	root = ROOT,
	statfs = fs.statfsSync,
) {
	// Check every existing ancestor; never traverse a symlink, even above the repository.
	const absolute = resolve(root)
	const components = absolute.split(sep).filter(Boolean)
	let ancestor = sep
	for (const component of components) {
		ancestor = join(ancestor, component)
		directory(ancestor)
	}
	const base = join(absolute, "output", "qualification")
	const target = output
		? resolve(absolute, output)
		: join(base, `activity-${randomUUID()}`)
	if (
		dirname(target) !== base ||
		!/^activity-[A-Za-z0-9-]{1,100}$/.test(target.slice(base.length + 1))
	)
		throw new Error(
			"Output must be a unique activity-* directory under output/qualification",
		)
	// Validate output ancestors before even inspecting a target through them.
	let diskPath = absolute
	for (const candidate of [join(absolute, "output"), base]) {
		try {
			directory(candidate)
			diskPath = candidate
		} catch (error) {
			if (error.code !== "ENOENT") throw error
			break
		}
	}
	if (fs.existsSync(target)) throw new Error("Output already exists")
	const freeBytes = diskGuard(statfs(diskPath, { bigint: true }), reserveBytes)
	directory(join(absolute, "output"), true)
	directory(base, true)
	diskGuard(statfs(base, { bigint: true }), reserveBytes)
	fs.mkdirSync(target, { mode: 0o700 }) // Exclusive creation; dangling links/existing paths also fail.
	return {
		path: target,
		freeBytes,
		filesystemType: String(statfs(target, { bigint: true }).type ?? "unknown"),
	}
}

export function verifyOutputDirectory(path, root) {
	const absolute = resolve(root)
	if (
		dirname(path) !== join(absolute, "output", "qualification") ||
		!/^activity-[A-Za-z0-9-]{1,100}$/.test(path.slice(dirname(path).length + 1))
	)
		throw new Error("Worker output outside disposable root")
	let ancestor = sep
	for (const part of path.split(sep).filter(Boolean)) {
		ancestor = join(ancestor, part)
		directory(ancestor)
	}
	return fs.lstatSync(path)
}

// Native/OS stalls can prevent timely termination and even delay these timers.
// Callers must end their owned process on this error; artifacts remain untouched.
export class FatalContainmentError extends Error {
	constructor(cause) {
		super("Fatal containment: worker termination was not confirmed", { cause })
		this.name = "FatalContainmentError"
		this.fatalContainment = true
	}
}

async function joinWorker(worker) {
	let timer
	try {
		await Promise.race([
			Promise.resolve().then(() => worker.terminate()),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Termination grace exceeded")),
					LIMITS.terminationGraceMs,
				)
			}),
		])
	} catch (error) {
		throw new FatalContainmentError(error)
	} finally {
		clearTimeout(timer)
	}
}

export async function supervise(factory, deadlineMs, signal) {
	if (
		!Number.isInteger(deadlineMs) ||
		deadlineMs < 1 ||
		deadlineMs > LIMITS.deadlineMs
	)
		throw new Error("Invalid deadline")
	if (signal?.aborted) throw new Error("Cancelled before worker start")
	const worker = factory()
	let timer
	let abort
	let result
	try {
		return await new Promise((resolveResult, reject) => {
			abort = () => reject(new Error("Cancelled"))
			signal?.addEventListener("abort", abort, { once: true })
			timer = setTimeout(
				() => reject(new Error("Worker deadline exceeded")),
				deadlineMs,
			)
			worker.on("message", message => {
				if (result) {
					reject(new Error("Duplicate worker result"))
					return
				}
				try {
					if (Buffer.byteLength(JSON.stringify(message)) > 128 * 1024)
						throw new Error("Worker result quota exceeded")
					result = message
				} catch (error) {
					reject(error)
				}
			})
			worker.once("error", reject)
			worker.once("exit", code => {
				if (code !== 0 || !result)
					reject(new Error(`Worker interrupted: exit ${code}`))
				else if (!["ok", "unsupported"].includes(result.status))
					reject(
						Object.assign(new Error(result.error || "Worker failure"), {
							workerResult: result,
						}),
					)
				else resolveResult(result)
			})
			if (signal?.aborted) abort()
		})
	} finally {
		clearTimeout(timer)
		if (abort) signal?.removeEventListener("abort", abort)
		await joinWorker(worker) // Bounded confirmation on every outcome; no subprocesses.
	}
}

function hashArtifact(path, expected, checkDeadline = () => {}) {
	const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const verify = () => {
			const actual = fs.fstatSync(fd)
			if (
				actual.ino !== expected.ino ||
				actual.dev !== expected.dev ||
				actual.size !== expected.size ||
				actual.mtimeMs !== expected.mtimeMs
			)
				throw new Error("Artifact changed during inspection")
		}
		verify()
		const hash = createHash("sha256")
		const block = Buffer.alloc(64 * 1024)
		let count
		do {
			checkDeadline()
			count = fs.readSync(fd, block, 0, block.length, null)
			if (count) hash.update(block.subarray(0, count))
		} while (count)
		verify()
		return hash.digest("hex")
	} finally {
		fs.closeSync(fd)
	}
}

export function inventoryArtifacts(path, long = false) {
	let bytes = 0
	const files = []
	const dir = fs.opendirSync(path)
	try {
		let entry
		let entries = 0
		while ((entry = dir.readSync())) {
			if (++entries > 4) throw new Error("Artifact entry cap exceeded")
			const name = entry.name
			if (
				![
					"fixture.db",
					"fixture.db-wal",
					"fixture.db-shm",
					"report.json",
				].includes(name)
			)
				throw new Error("Unexpected artifact")
			const full = join(path, name)
			const info = fs.lstatSync(full)
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
				throw new Error("Unsafe artifact")
			const cap = name.endsWith("-wal")
				? long
					? DRIVER_LIMITS.walBytes
					: LIMITS.walBytes
				: name === "fixture.db"
					? long
						? DRIVER_LIMITS.dbBytes
						: LIMITS.dbBytes
					: 128 * 1024
			if (info.size > cap) throw new Error("Artifact quota exceeded")
			bytes += info.size
			files.push({
				name,
				bytes: info.size,
				inode: info.ino,
				device: info.dev,
				mtimeMs: info.mtimeMs,
			})
		}
	} finally {
		dir.closeSync()
	}
	if (bytes + 128 * 1024 > LIMITS.artifactBytes)
		throw new Error("Artifact budget exceeded")
	return { bytes, files }
}

// Live admission uses metadata only. Content hashing is a separate joined-worker
// operation; workers never hash live database contents.
export function inspectArtifacts(path, checkDeadline = () => {}) {
	const inventory = inventoryArtifacts(path)
	return {
		bytes: inventory.bytes,
		files: inventory.files.map(file => ({
			...file,
			sha256: hashArtifact(
				join(path, file.name),
				{
					ino: file.inode,
					dev: file.device,
					size: file.bytes,
					mtimeMs: file.mtimeMs,
				},
				checkDeadline,
			),
		})),
	}
}

export async function run(
	config,
	{
		version = process.versions.node,
		root = ROOT,
		statfs = fs.statfsSync,
		writeReport = fs.writeFileSync,
		removeArtifact = fs.unlinkSync,
		now = () => performance.now(),
		signal,
		workerFactory,
	} = {},
) {
	// Revalidate programmatic entry too. Disabled/runtime rejection precedes all filesystem calls.
	config = parseArgs(
		Object.entries(config).flatMap(([key, value]) => {
			const flag = {
				scenario: "--scenario",
				phase: "--phase",
				seed: "--seed",
				reserveBytes: "--reserve-gib",
				deadlineMs: "--deadline-ms",
				output: "--output",
				resourceWindow: "--resource-window",
			}[key]
			if (!flag) throw new Error("Unknown configuration")
			return [flag, String(key === "reserveBytes" ? value / GiB : value)]
		}),
	)
	const report = {
		harnessVersion: 2,
		provisionalSQLite: true,
		qualificationClaim: false,
		scenario: config.scenario,
		seed: 42,
		node: version,
		versions: { ...process.versions },
		runtimeProvenance: {
			executable: process.execPath,
			actualNode: process.versions.node,
			requestedNode: version,
		},
		pragmaProvenance:
			"Worker-reported actual open/reopen PRAGMAs; never inferred from runtime version",
		osStallLimit:
			"Synchronous OS/native calls can delay timers and deadline checks; no absolute interruption guarantee",
		os: platform(),
		osRelease: release(),
		arch: arch(),
		unverified: UNVERIFIED,
		counts: { offered: 0, admitted: 0, rejected: 0, committed: 0 },
	}
	if (config.scenario === "disabled") return { ...report, status: "disabled" }
	if (!supportedRuntime(version))
		throw new Error("Unsupported enabled runtime: requires Node >=22.13.0")
	if (LONG.includes(config.scenario))
		return {
			...report,
			status: "not-run",
			reason:
				"Deferred pending exact harness review and Main allocation; attestation is not authorization",
			resourceWindow: config.resourceWindow,
			phase: config.phase,
			remainingPrerequisites: LONG_PREREQUISITES,
			metrics: {
				receiptLatency: null,
				loopDelay: null,
				cpu: null,
				memory: null,
				diskGrowth: null,
			},
			measurement: "not-run; virtual fixtures are correctness evidence only",
		}
	if (signal?.aborted) throw new Error("Cancelled before filesystem")
	const started = now()
	report.sourceHashes = Object.fromEntries(
		["run.mjs", "worker.mjs", "workloads.mjs"].map(name => {
			const path = join(dirname(fileURLToPath(import.meta.url)), name)
			const info = fs.lstatSync(path)
			if (!info.isFile() || info.size > 64 * 1024)
				throw new Error("Unbounded harness source")
			return [name, hashArtifact(path, info)]
		}),
	)
	report.workloadVersion = WORKLOAD_VERSION
	report.commandArguments = config
	const output = prepareOutput(config.output, config.reserveBytes, root, statfs)
	const identity = verifyOutputDirectory(output.path, root)
	const verify = () => {
		const current = verifyOutputDirectory(output.path, root)
		if (current.ino !== identity.ino || current.dev !== identity.dev)
			throw new Error("Task directory replaced")
	}
	let outcome
	try {
		const result = await supervise(
			workerFactory ||
				(() =>
					new Worker(new URL("./worker.mjs", import.meta.url), {
						workerData: {
							scenario: config.scenario,
							directory: output.path,
							root: resolve(root),
							identity: { inode: identity.ino, device: identity.dev },
							limits: LIMITS,
							reserveBytes: config.reserveBytes,
						},
						resourceLimits: {
							maxOldGenerationSizeMb: 96,
							maxYoungGenerationSizeMb: 16,
							stackSizeMb: 4,
						},
					})),
			Math.floor(config.deadlineMs - (now() - started)),
			signal,
		)
		outcome = {
			...report,
			status: result.status === "unsupported" ? "unsupported" : "micro-only",
			result,
			counts: result.counts,
			preflightFreeBytes: output.freeBytes,
			filesystemType: output.filesystemType,
		}
	} catch (error) {
		if (error instanceof FatalContainmentError) {
			error.output = output.path
			error.scenario = config.scenario
			error.phase = config.phase ?? "micro"
			error.stage = "worker"
			throw error // No inspection, hashing, persistence or deletion before a confirmed join.
		}
		outcome = {
			...report,
			status: "failed",
			error: String(error),
			result: error.workerResult,
			counts: error.workerResult?.counts ?? null,
			accounting: error.workerResult?.counts
				? "Worker returned final failure accounting"
				: "Unverified after interrupted worker; no success inferred",
		}
	}
	try {
		verify()
		diskGuard(statfs(output.path, { bigint: true }), config.reserveBytes)
	} catch (error) {
		outcome.status = "failed"
		outcome.diskError = String(error)
	}
	// Disk admission and safe artifact identity inspection are independent after join.
	try {
		verify()
		outcome.artifacts = inspectArtifacts(output.path, () => {
			if (now() - started > config.deadlineMs)
				throw new Error("Hash deadline exceeded")
		})
	} catch (error) {
		outcome.status = "failed"
		outcome.artifactError = String(error)
		try {
			outcome.residue = inventoryArtifacts(output.path)
		} catch (inventoryError) {
			outcome.residue = { status: "unknown", error: String(inventoryError) }
		}
	}
	const observeDeadline = () => {
		outcome.elapsedMs = now() - started
		if (outcome.elapsedMs > config.deadlineMs) {
			outcome.status = "failed"
			outcome.deadlineExceeded = true
		}
	}
	observeDeadline()
	// One preliminary write saves hashes before cleanup. It never asserts completed
	// success: its own write and cleanup have not happened yet and cannot be measured
	// in this snapshot. Only the returned result describes observed completion.
	let persisted = false
	try {
		verify()
		const serialized = JSON.stringify(
			{
				...outcome,
				status: outcome.status === "failed" ? "failed" : "finalization-pending",
				preliminaryOutcome: outcome.status,
				completion: "pending",
				elapsedScope: "before report persistence and cleanup",
			},
			null,
			2,
		)
		if (Buffer.byteLength(serialized) > 128 * 1024)
			throw new Error("Report quota exceeded")
		writeReport(join(output.path, "report.json"), serialized, {
			flag: "wx",
			mode: 0o600,
		})
		persisted = true
	} catch (error) {
		outcome.status = "failed"
		outcome.reportError = String(error)
	}
	if (persisted && outcome.artifacts) {
		try {
			for (const file of outcome.artifacts.files) {
				if (file.name.startsWith("fixture.db")) {
					verify()
					const full = join(output.path, file.name)
					const info = fs.lstatSync(full)
					if (
						!info.isFile() ||
						info.isSymbolicLink() ||
						info.nlink !== 1 ||
						info.ino !== file.inode ||
						info.dev !== file.device
					)
						throw new Error("Unsafe cleanup")
					removeArtifact(full)
				}
			}
		} catch (error) {
			outcome.status = "failed"
			outcome.cleanupError = String(error)
		}
	}
	try {
		verify()
		outcome.residue = {
			...inventoryArtifacts(output.path),
			path: output.path,
			ownership: "Driver-owned; capture inventory is separate",
		}
	} catch (error) {
		outcome.status = "failed"
		outcome.residue = {
			path: output.path,
			status: "unknown",
			error: String(error),
		}
	}
	outcome.reportPersisted = persisted
	outcome.completion = "observed"
	outcome.elapsedScope = "through report persistence and cleanup attempt"
	observeDeadline()
	return { ...outcome, output: output.path }
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	const controller = new AbortController()
	const cancel = () => controller.abort()
	process.once("SIGINT", cancel)
	process.once("SIGTERM", cancel)
	try {
		const report = await run(parseArgs(process.argv.slice(2)), {
			signal: controller.signal,
		})
		const finalText = JSON.stringify(report, null, 2) + "\n"
		if (Buffer.byteLength(finalText) > 1024 * 1024)
			throw new Error("Final stdout quota exceeded")
		process.stdout.write(finalText)
		if (report.status === "failed") process.exitCode = 1
	} catch (error) {
		process.stderr.write(
			JSON.stringify({
				error: String(error).slice(0, 1024),
				output: error.output ?? null,
				scenario: error.scenario ?? null,
				phase: error.phase ?? null,
				stage: error.stage ?? null,
			}) + "\n",
		)
		if (error instanceof FatalContainmentError) process.exit(1)
		process.exitCode = 1
	} finally {
		process.removeListener("SIGINT", cancel)
		process.removeListener("SIGTERM", cancel)
	}
}

// Allocated driver routines only: these are not wired to long CLI execution.
export const DRIVER_LIMITS = Object.freeze({
	dataRows: 1024,
	dataBytes: 8 * 1024 ** 2,
	controlRows: 128,
	controlBytes: 2 * 1024 ** 2,
	rowBytes: 144 * 1024,
	batchRows: 64,
	batchBytes: 256 * 1024,
	dwellUs: 20000,
	latenessUs: 20000,
	transitionLatenessUs: 20000,
	turnRows: 64,
	dbBytes: 2 * GiB,
	dbHeadroomBytes: 256 * 1024 ** 2,
	walBytes: 64 * 1024 ** 2,
	captureBytes: 4 * 1024 ** 2,
})
const STAGE_MS = Object.freeze({
	setup: 180000,
	warmup: 30000,
	load: 900000,
	drain: 15000,
	finalization: 75000,
})
export function stageDeadline(now = () => performance.now()) {
	const started = now()
	let stage = "setup"
	let entered = started
	let index = 0
	const stages = Object.keys(STAGE_MS)
	const roles = new Map()
	let replacements = 0
	let fatal = false
	const transitions = []
	const check = (current = now()) => {
		const grace = ["warmup", "load"].includes(stage)
			? DRIVER_LIMITS.transitionLatenessUs / 1000
			: 0
		if (
			current < entered ||
			current - started > LIMITS.deadlineMs ||
			current > entered + STAGE_MS[stage] + grace
		)
			throw new Error(`Deadline exceeded: ${stage}`)
		return Math.max(
			0,
			Math.min(
				LIMITS.deadlineMs - (current - started),
				entered + STAGE_MS[stage] - current,
			),
		)
	}
	return {
		check,
		enter(next) {
			const current = now()
			check(current)
			if (
				["warmup", "load"].includes(stage) &&
				current < entered + STAGE_MS[stage]
			)
				throw new Error("Fixed phase duration not complete")
			if (stages[index + 1] !== next)
				throw new Error("Invalid stage transition")
			transitions.push({
				from: stage,
				to: next,
				scheduledMs: entered + STAGE_MS[stage],
				observedMs: current,
				latenessMs: Math.max(0, current - (entered + STAGE_MS[stage])),
			})
			stage = next
			index++
			// Observed entry is the new epoch: load always gets its full 900s.
			// Transition delay consumes the unchanged total/finalization budget.
			entered = current
		},
		snapshot() {
			return {
				stage,
				elapsedMs: now() - started,
				stageElapsedMs: now() - entered,
				enteredMs: entered,
				transitions: transitions.map(value => ({ ...value })),
				transitionLatenessLimitMs: DRIVER_LIMITS.transitionLatenessUs / 1000,
			}
		},
		// A replacement receives this same remaining budget; it never resets it.
		async supervise(factory, signal, role = "writer") {
			if (
				fatal ||
				!["writer", "reader"].includes(role) ||
				roles.get(role) === "active"
			)
				throw new Error("Worker role not admitted")
			const remaining = Math.floor(check())
			if (remaining < 1) throw new Error(`Deadline exceeded: ${stage}`)
			if (roles.has(role) && ++replacements > 32)
				throw new Error("Worker replacement cap exceeded")
			roles.set(role, "active")
			try {
				return await supervise(factory, remaining, signal)
			} catch (error) {
				if (error instanceof FatalContainmentError) {
					fatal = true
					error.stage = stage
				}
				throw error
			} finally {
				roles.set(role, fatal ? "unjoined" : "joined")
			}
		},
	}
}

// Physical inventory and unmaterialized reservations are disjoint. A transfer
// replaces reservation bytes with measured bytes exactly once.
export function artifactBudget(reserveBytes = GiB) {
	const owned = new Map()
	function usage() {
		let measured = 0
		let reserved = 0
		for (const entry of owned.values()) {
			measured += entry.measured
			reserved += entry.reserved
		}
		return { measured, reserved, total: measured + reserved }
	}
	return {
		reserve(id, bytes) {
			if (
				typeof id !== "string" ||
				!id ||
				owned.has(id) ||
				owned.size >= 256 ||
				!Number.isSafeInteger(bytes) ||
				bytes < 0
			)
				throw new Error("Invalid owned reservation")
			if (usage().total + bytes > LIMITS.artifactBytes)
				throw new Error("Artifact budget exceeded")
			owned.set(id, { measured: 0, reserved: bytes })
		},
		materialize(id, measured, remaining = 0) {
			if (
				!owned.has(id) ||
				![measured, remaining].every(
					value => Number.isSafeInteger(value) && value >= 0,
				)
			)
				throw new Error("Unknown inventory")
			const before = owned.get(id)
			if (measured + remaining > before.measured + before.reserved)
				throw new Error("Unreserved growth")
			owned.set(id, { measured, reserved: remaining })
		},
		check(free) {
			const result = usage()
			const available = BigInt(diskGuard(free, reserveBytes))
			if (available < BigInt(8 * GiB + reserveBytes + result.reserved))
				throw new Error("Reservation free-space breached")
			return result
		},
		transaction(inventory, growth) {
			// No fabricated bound: future worker must supply and enforce page/schema
			// growth bounds BEFORE every transaction, not a post-commit size check.
			if (
				!growth ||
				growth.enforced !== true ||
				![
					growth.dbBytes,
					growth.walBytes,
					inventory?.dbBytes,
					inventory?.walBytes,
				].every(value => Number.isSafeInteger(value) && value >= 0)
			)
				throw new Error("Transaction growth bound unavailable")
			if (
				inventory.dbBytes + growth.dbBytes >
					DRIVER_LIMITS.dbBytes - DRIVER_LIMITS.dbHeadroomBytes ||
				inventory.walBytes + growth.walBytes > DRIVER_LIMITS.walBytes
			)
				throw new Error("DB/WAL growth gate")
			if (
				usage().total + growth.dbBytes + growth.walBytes >
				LIMITS.artifactBytes
			)
				throw new Error("Aggregate growth gate")
		},
		reserveCapture(runId) {
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
					runId,
				)
			)
				throw new Error("Invalid capture owner")
			this.reserve(`capture:${runId}`, DRIVER_LIMITS.captureBytes)
			return {
				id: `capture:${runId}`,
				bytes: DRIVER_LIMITS.captureBytes,
				consumer: "not-run: separately accepted capped pipe consumer required",
			}
		},
		usage,
	}
}

function writerCounts() {
	return {
		offered: 0,
		invalid: 0,
		producerRejected: 0,
		globalRejected: 0,
		queueDenied: 0,
		storageDenied: 0,
		admitted: 0,
		committed: 0,
		acknowledged: 0,
		failed: 0,
		uncertain: 0,
		duplicateReceipts: 0,
		schedulerMissed: 0,
	}
}
// JSON envelope size includes array brackets/separators and its own bytes field.
// The decimal self-size reaches a fixed point in at most a few digit changes.
function batchWireBytes(id, dataBytes, rows) {
	const base =
		Buffer.byteLength(JSON.stringify({ id, bytes: 0, rows: [] })) +
		dataBytes +
		Math.max(0, rows - 1) -
		1
	let bytes = base + 1
	while (base + String(bytes).length !== bytes)
		bytes = base + String(bytes).length
	return bytes
}
export function admissionDriver(scenario, seconds = 900) {
	if (
		!["steady", "burst", "overload"].includes(scenario) ||
		!Number.isInteger(seconds) ||
		seconds < 1 ||
		seconds > 900
	)
		throw new Error("Invalid driver scenario")
	let schedule = offerSchedule("steady", 25)
	let buckets = tokenBuckets()
	let counts = writerCounts()
	let epoch = null
	let mode = "warmup"
	let warmup = null
	let previousWall = -1
	let queue = []
	let inflight = null
	let retainedBytes = 0
	let retainedRows = 0
	let batchId = 0
	const controls = new Map()
	let controlBytes = 0
	let peakRows = 0
	let peakBytes = 0
	let maxLatenessUs = 0
	let transitionLatenessUs = null
	let warmupDrainedUs = null
	const recordDrain = () => {
		if (mode === "warmup" && !retainedRows && !controls.size)
			warmupDrainedUs = previousWall
	}
	const monotonic = nowUs => {
		if (!Number.isSafeInteger(nowUs) || nowUs < 0 || nowUs < previousWall)
			throw new Error("Invalid monotonic clock")
		previousWall = nowUs
	}
	function admit(event, nowUs, storageAvailable = true) {
		counts.offered++
		const payloadBytes =
			typeof event.payload === "string" ? Buffer.byteLength(event.payload) : 0
		if (
			!Number.isSafeInteger(event.id) ||
			event.id < 0 ||
			!Number.isInteger(event.producer) ||
			event.producer < 0 ||
			event.producer > 9 ||
			!Number.isSafeInteger(event.timeUs) ||
			event.timeUs < 0 ||
			!payloadBytes ||
			payloadBytes > DRIVER_LIMITS.rowBytes
		) {
			counts.invalid++
			return "invalid"
		}
		const row = {
			id: `${mode}:${event.id}`,
			producer: event.producer,
			timeUs: event.timeUs,
			payload: event.payload,
		}
		const bytes = Buffer.byteLength(JSON.stringify(row))
		// Escaping can make a raw payload too large for one bounded IPC batch.
		if (
			batchWireBytes(Number.MAX_SAFE_INTEGER, bytes, 1) >
			DRIVER_LIMITS.batchBytes
		) {
			counts.invalid++
			return "invalid"
		}
		const rate = buckets.decide(event.producer, event.timeUs, false)
		if (rate) {
			counts[rate]++
			return rate
		}
		if (
			retainedRows === DRIVER_LIMITS.dataRows ||
			retainedBytes + bytes > DRIVER_LIMITS.dataBytes
		) {
			counts.queueDenied++
			return "queueDenied"
		}
		if (!storageAvailable) {
			counts.storageDenied++
			return "storageDenied"
		}
		buckets.decide(event.producer, event.timeUs)
		queue.push({
			...row,
			bytes,
			admittedUs: nowUs,
		})
		retainedRows++
		retainedBytes += bytes
		counts.admitted++
		peakRows = Math.max(peakRows, retainedRows)
		peakBytes = Math.max(peakBytes, retainedBytes)
		return "admitted"
	}
	return {
		start(nowUs) {
			if (epoch !== null) throw new Error("Already started")
			monotonic(nowUs)
			epoch = nowUs
		},
		turn(nowUs, storageAvailable = true) {
			monotonic(nowUs)
			if (epoch === null || mode === "stopped")
				throw new Error("Driver not active")
			const offset = nowUs - epoch
			const missed = schedule.skipBefore(offset - DRIVER_LIMITS.latenessUs)
			counts.schedulerMissed += missed
			counts.offered += missed
			let processed = 0
			while (processed < DRIVER_LIMITS.turnRows) {
				const event = schedule.nextDue(offset)
				if (!event) break
				maxLatenessUs = Math.max(maxLatenessUs, offset - event.timeUs)
				admit(event, nowUs, storageAvailable)
				processed++
			}
			return { processed, missed, done: schedule.done }
		},
		// Test fixture entry exercises the same actual queue and token path.
		admit(event, nowUs, storageAvailable = true) {
			monotonic(nowUs)
			return admit(event, nowUs, storageAvailable)
		},
		batch(nowUs, force = false) {
			monotonic(nowUs)
			if (inflight || !queue.length) return null
			if (
				!force &&
				queue.length < DRIVER_LIMITS.batchRows &&
				nowUs - queue[0].admittedUs < DRIVER_LIMITS.dwellUs
			)
				return null
			const id = batchId + 1
			if (!Number.isSafeInteger(id)) throw new Error("Batch ID exhausted")
			let dataBytes = 0
			let rows = 0
			while (
				rows < queue.length &&
				rows < DRIVER_LIMITS.batchRows &&
				batchWireBytes(id, dataBytes + queue[rows].bytes, rows + 1) <=
					DRIVER_LIMITS.batchBytes
			) {
				dataBytes += queue[rows].bytes
				rows++
			}
			if (!rows) throw new Error("Queued row cannot fit batch envelope")
			// Disjoint charges: serialized rows remain data; 1KiB reserves control
			// state/envelope overhead. The actual wire cap includes both categories.
			if (
				controls.size >= DRIVER_LIMITS.controlRows ||
				controlBytes + 1024 > DRIVER_LIMITS.controlBytes
			)
				return null
			batchId = id
			controls.set(`batch:${id}`, 1024)
			controlBytes += 1024
			inflight = { id, rows: queue.splice(0, rows), dataBytes }
			return {
				id,
				bytes: batchWireBytes(id, dataBytes, rows),
				rows: inflight.rows.map(row => ({
					id: row.id,
					producer: row.producer,
					timeUs: row.timeUs,
					payload: row.payload,
				})),
			}
		},
		// Async receipt handlers supply their observed clock; fixtures may use the
		// latest driver clock. Warmup drain must finish before transition grace.
		settle(id, outcome, nowUs = previousWall) {
			if (!["committed", "failed", "uncertain"].includes(outcome))
				throw new Error("Invalid batch settlement")
			if (!inflight || inflight.id !== id) {
				counts.duplicateReceipts++
				return false
			}
			monotonic(nowUs)
			counts[outcome] += inflight.rows.length
			if (outcome !== "uncertain") counts.acknowledged += inflight.rows.length
			controlBytes -= controls.get(`batch:${id}`)
			controls.delete(`batch:${id}`)
			retainedRows -= inflight.rows.length
			retainedBytes -= inflight.dataBytes
			inflight = null
			recordDrain()
			return true
		},
		control(id, bytes) {
			if (
				!Number.isSafeInteger(id) ||
				id < 0 ||
				!Number.isSafeInteger(bytes) ||
				bytes < 1 ||
				controls.has(id) ||
				controls.size >= DRIVER_LIMITS.controlRows ||
				controlBytes + bytes > DRIVER_LIMITS.controlBytes
			)
				return false
			controls.set(id, bytes)
			controlBytes += bytes
			return true
		},
		releaseControl(id, nowUs = Math.max(0, previousWall)) {
			if (!controls.has(id)) return false
			monotonic(nowUs)
			controlBytes -= controls.get(id)
			controls.delete(id)
			recordDrain()
			return true
		},
		measure(nowUs) {
			monotonic(nowUs)
			if (
				mode !== "warmup" ||
				epoch === null ||
				nowUs - epoch < 30000000 ||
				nowUs - epoch > 30000000 + DRIVER_LIMITS.transitionLatenessUs ||
				warmupDrainedUs === null ||
				warmupDrainedUs > epoch + 30000000 ||
				!schedule.done ||
				counts.admitted !== 2500 ||
				counts.committed !== 2500 ||
				counts.schedulerMissed ||
				retainedRows ||
				controls.size
			)
				throw new Error("Warmup drain/reset failed")
			transitionLatenessUs = nowUs - epoch - 30000000
			warmup = { ...counts }
			counts = writerCounts()
			buckets = tokenBuckets()
			schedule = offerSchedule(scenario, seconds)
			epoch = nowUs
			mode = "load"
			peakRows = 0
			peakBytes = 0
			maxLatenessUs = 0
		},
		stop() {
			mode = "stopped"
			counts.failed += queue.length
			retainedRows -= queue.length
			retainedBytes -= queue.reduce((sum, row) => sum + row.bytes, 0)
			queue = []
			if (inflight) {
				counts.uncertain += inflight.rows.length
				controlBytes -= controls.get(`batch:${inflight.id}`)
				controls.delete(`batch:${inflight.id}`)
				retainedRows -= inflight.rows.length
				retainedBytes -= inflight.dataBytes
				inflight = null
			}
		},
		snapshot() {
			return {
				mode,
				counts: { ...counts },
				warmup,
				retainedRows,
				retainedBytes,
				controlRows: controls.size,
				controlBytes,
				peakRows,
				peakBytes,
				maxLatenessUs,
				transitionLatenessUs,
				transitionLatenessLimitUs: DRIVER_LIMITS.transitionLatenessUs,
				epochUs: epoch,
				loadEndsUs: mode === "load" ? epoch + seconds * 1000000 : null,
				fidelity: counts.schedulerMissed ? "failed" : "no scheduler misses",
				receiptLatency: null,
				latencyMeasurement:
					"unmeasured; no worker receipt clock in this delivery item",
			}
		},
	}
}

export const QUERY_TERMINALS = Object.freeze([
	"successful",
	"scheduler-missed",
	"client-busy",
	"queue-denied",
	"queue-expired",
	"active-timeout",
	"query-failed",
	"cancelled-before-dispatch",
	"cancelled-in-flight",
	"interrupted-unknown",
	"not-offered-after-stop",
])
// Driver-only query partition. No SQL, actual query worker or result oracle is
// implemented here. Retained state is at most one slot per client (eight total).
export function queryAccounting(seconds = 900) {
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900)
		throw new Error("Invalid query duration")
	const planned = seconds * 8
	const totals = Object.fromEntries(QUERY_TERMINALS.map(key => [key, 0]))
	const classes = Array(8).fill(0)
	const pending = new Map()
	const retainedReplies = new Map()
	let retainedReplyBytes = 0
	let next = 0
	let active = null
	let readerOwner = null
	let ownerSequence = 0
	let readerJoinFailed = false
	let stopped = false
	let previous = -1
	const terminal = (id, reason) => {
		if (!QUERY_TERMINALS.includes(reason))
			throw new Error("Invalid query terminal")
		if (!pending.has(id)) return false
		pending.delete(id)
		if (active === id) active = null
		totals[reason]++
		return true
	}
	const monotonic = nowUs => {
		if (!Number.isSafeInteger(nowUs) || nowUs < 0 || nowUs < previous)
			throw new Error("Invalid query clock")
		previous = nowUs
	}
	const expire = nowUs => {
		for (const [id, slot] of pending)
			if (nowUs - slot.timeUs >= 250000)
				terminal(id, slot.dispatched ? "active-timeout" : "queue-expired")
	}
	return {
		turn(nowUs) {
			if (stopped) throw new Error("Invalid query clock/state")
			monotonic(nowUs)
			let processed = 0
			// Query cadence is fixed at 125ms, so <= 8 current slots can be within
			// 20ms. Stale whole slots are accounted arithmetically without a loop.
			const staleEnd = Math.min(
				planned,
				Math.max(next, Math.ceil((nowUs - 20000) / 125000)),
			)
			totals["scheduler-missed"] += staleEnd - next
			next = staleEnd
			while (next < planned && next * 125000 <= nowUs && processed < 64) {
				const id = next++
				const client = id % 8
				classes[(Math.floor(id / 8) + client) % 8]++
				if (
					retainedReplies.has(client) ||
					readerOwner?.id % 8 === client ||
					[...pending.keys()].some(key => key % 8 === client)
				)
					totals["client-busy"]++
				else if (pending.size >= (active === null ? 4 : 5))
					totals["queue-denied"]++
				else pending.set(id, { dispatched: false, timeUs: id * 125000 })
				processed++
			}
			return processed
		},
		dispatch(nowUs) {
			monotonic(nowUs)
			expire(nowUs)
			if (stopped || readerOwner !== null || readerJoinFailed) return null
			for (const [id, slot] of pending)
				if (!slot.dispatched) {
					slot.dispatched = true
					active = id
					readerOwner = { id, owner: ++ownerSequence }
					return id
				}
			return null
		},
		// Every reply callback must supply its observed monotonic microseconds.
		// Expiration wins at the deadline, regardless of timeout callback order.
		settle(id, reason, nowUs, replyBytes = 0) {
			if (!["successful", "query-failed"].includes(reason))
				throw new Error("Invalid query terminal reply")
			monotonic(nowUs)
			expire(nowUs)
			if (!pending.has(id)) return false
			if (!pending.get(id).dispatched) throw new Error("Reply before dispatch")
			if (
				!Number.isSafeInteger(replyBytes) ||
				replyBytes < 0 ||
				replyBytes > 1024 * 1024 ||
				retainedReplyBytes + replyBytes > DRIVER_LIMITS.controlBytes ||
				(replyBytes && reason !== "successful")
			)
				throw new Error("Retained reply quota exceeded")
			terminal(id, reason)
			readerOwner = null // A valid terminal reply confirms query settlement.
			if (replyBytes) {
				retainedReplies.set(id % 8, replyBytes)
				retainedReplyBytes += replyBytes
			}
			return true
		},
		// Called only after external termination/settlement confirmation. Matching
		// both keys fences delayed joins from prior owners; failure poisons reuse.
		join(id, owner, confirmed) {
			if (readerOwner?.id !== id || readerOwner.owner !== owner) return false
			if (pending.has(id)) throw new Error("Reader join before terminal")
			if (confirmed !== true) {
				readerJoinFailed = true
				throw new Error("Reader join failed; reuse forbidden")
			}
			if (readerJoinFailed) return false
			readerOwner = null
			return true
		},
		releaseReply(client) {
			if (!retainedReplies.has(client)) return false
			retainedReplyBytes -= retainedReplies.get(client)
			retainedReplies.delete(client)
			return true
		},
		stop(deliberate = false, joined = false) {
			if (stopped) return
			stopped = true
			retainedReplies.clear()
			retainedReplyBytes = 0
			for (const [id, slot] of pending)
				terminal(
					id,
					deliberate
						? slot.dispatched
							? joined
								? "cancelled-in-flight"
								: "interrupted-unknown"
							: "cancelled-before-dispatch"
						: slot.dispatched
							? "interrupted-unknown"
							: "cancelled-before-dispatch",
				)
			totals["not-offered-after-stop"] += planned - next
			next = planned
		},
		snapshot() {
			const terminalCount = Object.values(totals).reduce(
				(sum, count) => sum + count,
				0,
			)
			return {
				planned,
				totals: { ...totals },
				classes: [...classes],
				plannedClasses: Array(8).fill(seconds),
				pending: pending.size,
				readerOwner: readerOwner ? { ...readerOwner } : null,
				readerJoinFailed,
				retainedReplies: retainedReplies.size,
				retainedReplyBytes,
				terminalCount,
				reconciled: terminalCount === planned,
				actualQueries: "not-run",
			}
		},
	}
}

// Narrow fixture wire glue. Callbacks observe the parent's clock at reception;
// worker clocks cannot be compared with admission clocks. State changes are sync.
export function validateBatchEnvelope(batch) {
	if (
		!batch ||
		Object.keys(batch).sort().join() !== "bytes,id,rows" ||
		!Number.isSafeInteger(batch.id) ||
		batch.id < 1 ||
		!Array.isArray(batch.rows) ||
		batch.rows.length < 1 ||
		batch.rows.length > 64 ||
		batch.bytes !== Buffer.byteLength(JSON.stringify(batch)) ||
		batch.bytes > 262144
	)
		throw new Error("Invalid bounded batch envelope")
	return batch
}
export function batchAcknowledgement(id, outcome, rows) {
	if (
		!Number.isSafeInteger(id) ||
		id < 1 ||
		!["committed", "failed", "uncertain"].includes(outcome) ||
		!Number.isInteger(rows) ||
		rows < 1 ||
		rows > 64
	)
		throw new Error("Invalid batch acknowledgement")
	return Object.freeze({ id, outcome, rows })
}
// Baseline performs identical envelope/ack ownership, with database I/O omitted.
export function baselineBatchAcknowledgement(batch) {
	validateBatchEnvelope(batch)
	return batchAcknowledgement(batch.id, "committed", batch.rows.length)
}
export function receiveBatchAcknowledgement(driver, batch, ack, nowUs) {
	validateBatchEnvelope(batch)
	if (!Number.isSafeInteger(nowUs) || nowUs < 0)
		throw new Error("Invalid receipt clock")
	if (
		!ack ||
		Object.keys(ack).sort().join() !== "id,outcome,rows" ||
		ack.id !== batch.id ||
		ack.rows !== batch.rows.length ||
		Buffer.byteLength(JSON.stringify(ack)) > 1024
	)
		throw new Error("Invalid batch acknowledgement ownership")
	batchAcknowledgement(ack.id, ack.outcome, ack.rows)
	return Object.freeze({
		accepted: driver.settle(ack.id, ack.outcome, nowUs),
		receiptUs: nowUs,
	})
}
export function receiveReaderResult(driver, result, nowUs) {
	const owner = driver.snapshot().readerOwner
	if (!owner || result?.id !== owner.id || result.owner !== owner.owner)
		return false
	if (!["successful", "query-failed"].includes(result.reason))
		throw new Error("Invalid reader result")
	const bytes = Buffer.byteLength(JSON.stringify(result))
	if (bytes > 1024 * 1024) throw new Error("Reader page quota exceeded")
	return driver.settle(
		result.id,
		result.reason,
		nowUs,
		result.reason === "successful" ? bytes : 0,
	)
}
