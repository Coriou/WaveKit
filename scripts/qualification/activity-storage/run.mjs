// Explicit disposable driver. Importing this file never creates state or starts work.
import * as fs from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { arch, platform, release } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

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
				result = message
			})
			worker.once("error", reject)
			worker.once("exit", code => {
				if (code !== 0 || !result)
					reject(new Error(`Worker interrupted: exit ${code}`))
				else if (result.status !== "ok")
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

function hashArtifact(path, expected) {
	const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const actual = fs.fstatSync(fd)
		if (
			actual.ino !== expected.ino ||
			actual.dev !== expected.dev ||
			actual.size !== expected.size
		)
			throw new Error("Artifact changed during inspection")
		return createHash("sha256").update(fs.readFileSync(fd)).digest("hex")
	} finally {
		fs.closeSync(fd)
	}
}

export function inspectArtifacts(path) {
	let bytes = 0
	const files = []
	for (const name of fs.readdirSync(path)) {
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
			? LIMITS.walBytes
			: name === "fixture.db"
				? LIMITS.dbBytes
				: 128 * 1024
		if (info.size > cap) throw new Error("Artifact quota exceeded")
		bytes += info.size
		files.push({
			name,
			bytes: info.size,
			inode: info.ino,
			device: info.dev,
			sha256: hashArtifact(full, info),
		})
	}
	if (bytes + 128 * 1024 > LIMITS.artifactBytes)
		throw new Error("Artifact budget exceeded")
	return { bytes, files }
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
		harnessVersion: 1,
		provisionalSQLite: true,
		qualificationClaim: false,
		scenario: config.scenario,
		seed: 42,
		node: version,
		versions: { ...process.versions },
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
	report.workloadVersion = 1
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
			status: "micro-only",
			result,
			counts: result.counts,
			preflightFreeBytes: output.freeBytes,
			filesystemType: output.filesystemType,
		}
	} catch (error) {
		if (error instanceof FatalContainmentError) {
			error.output = output.path
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
		outcome.artifacts = inspectArtifacts(output.path)
	} catch (error) {
		outcome.status = "failed"
		outcome.artifactError = String(error)
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
		process.stdout.write(JSON.stringify(report, null, 2) + "\n")
		if (report.status === "failed") process.exitCode = 1
	} catch (error) {
		process.stderr.write(String(error) + "\n")
		if (error instanceof FatalContainmentError) process.exit(1)
		process.exitCode = 1
	} finally {
		process.removeListener("SIGINT", cancel)
		process.removeListener("SIGTERM", cancel)
	}
}
