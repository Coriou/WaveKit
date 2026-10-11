// Closed disposable evidence consumer. Importing starts no process or filesystem work.
import * as fs from "node:fs"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { TextDecoder } from "node:util"
import { diskGuard, GiB, parseArgs, verifyCaptureReservation } from "./run.mjs"

const SOURCE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SOURCE, "../../..")
export const CAPS = Object.freeze({
	stdout: 1024 ** 2,
	stderr: 2 * 1024 ** 2,
	manifest: 1024 ** 2,
	reservation: 4 * 1024 ** 2,
	pull: 16384,
	queued: 65536,
	discard: 256 * 1024,
	preflightMs: 5000,
	driverMs: 1200000,
	terminationMs: 1000,
	postMs: 60000,
	totalMs: 1266000,
	captureRss: 96 * 1024 ** 2,
	driverRss: 192 * 1024 ** 2,
	combinedRss: 288 * 1024 ** 2,
})

// Strict lexical admission precedes the ONE parse. No recursive walk/token array.
// Sets retain decoded keys only, bounded by property/key-unit caps. UTF-8 decoding
// retains raw <=1MiB plus <=2MiB UTF-16; GC is never assumed to release either.
export function lexicalJSON(bytes, check = () => {}) {
	if (!Buffer.isBuffer(bytes) || bytes.length > CAPS.stdout)
		throw new Error("JSON byte cap")
	check()
	const text = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: true,
	}).decode(bytes)
	check()
	let i = 0
	let checked = 0
	let values = 0
	let properties = 0
	let keyUnits = 0
	let stringUnits = 0
	const stack = Array(16).fill(null)
	let depth = 0
	const fail = () => {
		throw new Error("Invalid or unbounded JSON")
	}
	const tick = () => {
		// UTF-16 positions are conservative for the <=16KiB byte-check cadence.
		if (i - checked >= 4096) {
			check()
			checked = i
		}
	}
	const whitespace = () => {
		while (i < text.length && /[\x20\t\r\n]/.test(text[i])) {
			i++
			tick()
		}
	}
	const string = key => {
		if (text[i++] !== '"') fail()
		let decoded = ""
		let units = 0
		let high = false
		const append = code => {
			if (high && !(code >= 0xdc00 && code <= 0xdfff)) fail()
			if (!high && code >= 0xdc00 && code <= 0xdfff) fail()
			high = code >= 0xd800 && code <= 0xdbff
			if (++units > 4096) fail()
			if (key ? ++keyUnits > 131072 : ++stringUnits > 262144) fail()
			if (key) decoded += String.fromCharCode(code)
		}
		while (i < text.length) {
			tick()
			let code = text.charCodeAt(i++)
			if (code === 34) {
				if (high) fail()
				return decoded
			}
			if (code < 32) fail()
			if (code === 92) {
				const escape = text[i++]
				if (escape === "u") {
					const hex = text.slice(i, i + 4)
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail()
					code = Number.parseInt(hex, 16)
					i += 4
				} else {
					const index = '"\\/bfnrt'.indexOf(escape ?? "\0")
					if (index < 0) fail()
					code = [34, 92, 47, 8, 12, 10, 13, 9][index]
				}
			}
			append(code)
		}
		fail()
	}
	const value = () => {
		if (++values > 8192) fail()
		const ch = text[i]
		if (ch === "{" || ch === "[") {
			if (depth === 16) fail()
			stack[depth++] = {
				object: ch === "{",
				state: "first",
				count: 0,
				keys: ch === "{" ? new Set() : null,
			}
			i++
			return
		}
		if (ch === '"') {
			string(false)
			return
		}
		for (const literal of ["true", "false", "null"])
			if (text.startsWith(literal, i)) {
				i += literal.length
				return
			}
		const start = i
		while (i < text.length && /[0-9eE+.\-]/.test(text[i])) {
			if (i - start === 64) fail()
			i++
		}
		if (
			!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(
				text.slice(start, i),
			)
		)
			fail()
	}
	whitespace()
	if (text[i] !== "{") fail()
	value()
	while (depth) {
		tick()
		whitespace()
		const frame = stack[depth - 1]
		const end = frame.object ? "}" : "]"
		if (frame.state === "after") {
			if (text[i] === ",") {
				i++
				frame.state = "next"
				continue
			}
			if (text[i] !== end) fail()
		} else if (frame.state === "first" && text[i] === end) {
			// Empty container.
		} else {
			if (++frame.count > (frame.object ? 256 : 2048)) fail()
			if (frame.object) {
				if (++properties > 4096) fail()
				const key = string(true)
				if (frame.keys.has(key)) fail()
				frame.keys.add(key)
				whitespace()
				if (text[i++] !== ":") fail()
				whitespace()
			}
			frame.state = "after"
			value()
			continue
		}
		i++
		stack[--depth] = null
	}
	whitespace()
	check()
	if (i !== text.length) fail()
	return { text, values, properties, keyUnits, stringUnits }
}
export function parseBoundedJSON(bytes, check) {
	const lexical = lexicalJSON(bytes, check)
	return {
		report: JSON.parse(lexical.text),
		accounting: {
			rawBytes: bytes.length,
			decodedInputUnits: lexical.text.length,
			values: lexical.values,
			properties: lexical.properties,
			keyUnits: lexical.keyUnits,
			stringUnits: lexical.stringUnits,
			workingSetEstimateBytes: 8 * 1024 ** 2,
			estimateOnly: true,
			simultaneous:
				"raw + decoded input + bounded keys/strings + parsed values/properties + manifest object/text + 64KiB queues + 64KiB hash block; runtime/native/kernel overhead unknown",
		},
	}
}

const object = value =>
	value !== null && typeof value === "object" && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const finite = value =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
const str = value => typeof value === "string" && value.length <= 4096
function shape(value, required, optional = []) {
	if (
		!object(value) ||
		required.some(key => !Object.hasOwn(value, key)) ||
		Object.keys(value).some(
			key => !required.includes(key) && !optional.includes(key),
		)
	)
		throw new Error("Closed report shape rejected")
}
function strings(value, cap = 256) {
	if (!Array.isArray(value) || value.length > cap || !value.every(str))
		throw new Error("Report strings rejected")
}
function counts(value) {
	shape(value, ["offered", "admitted", "rejected", "committed"])
	if (
		!Object.values(value).every(integer) ||
		value.offered !== value.admitted + value.rejected ||
		value.committed > value.admitted
	)
		throw new Error("Report counts rejected")
}
function inventory(value, hashed = false) {
	shape(value, ["bytes", "files"], ["path", "ownership"])
	if (
		!integer(value.bytes) ||
		!Array.isArray(value.files) ||
		value.files.length > 4
	)
		throw new Error("Report inventory rejected")
	const names = new Set()
	let total = 0
	for (const file of value.files) {
		shape(file, [
			"name",
			"bytes",
			"inode",
			"device",
			"mtimeMs",
			...(hashed ? ["sha256"] : []),
		])
		if (
			![
				"fixture.db",
				"fixture.db-wal",
				"fixture.db-shm",
				"report.json",
			].includes(file.name) ||
			names.has(file.name) ||
			![file.bytes, file.inode, file.device].every(integer) ||
			!finite(file.mtimeMs) ||
			file.bytes >
				(file.name === "fixture.db"
					? 16 * 1024 ** 2
					: file.name.endsWith("-wal")
						? 4 * 1024 ** 2
						: 128 * 1024) ||
			(hashed && !/^[a-f0-9]{64}$/.test(file.sha256))
		)
			throw new Error("Report artifact rejected")
		names.add(file.name)
		total += file.bytes
	}
	if (total !== value.bytes) throw new Error("Report inventory sum rejected")
}
function pragmas(value) {
	shape(value, [
		"journalMode",
		"synchronous",
		"pageSize",
		"maxPageCount",
		"cacheSpill",
		"busyTimeout",
		"walAutocheckpoint",
	])
	if (
		!["wal", "memory"].includes(value.journalMode) ||
		value.synchronous !== 2 ||
		value.pageSize !== 4096 ||
		value.maxPageCount !== 128 ||
		value.cacheSpill !== 0 ||
		value.busyTimeout !== 50 ||
		value.walAutocheckpoint !== 32
	)
		throw new Error("Report PRAGMA rejected")
}
function workerResult(value, scenario, status) {
	if (status === "unsupported") {
		shape(value, ["status", "error", "provenance", "counts"])
		if (
			value.status !== "unsupported" ||
			value.error !== "Unsupported pretransaction SQLite growth proof"
		)
			throw new Error("Unsupported reason rejected")
	} else {
		shape(value, [
			"status",
			"warnings",
			"sqlite",
			"provenance",
			"growthReservation",
			"compileOptions",
			"initialPragmas",
			"finalPragmas",
			"primitives",
			"counts",
			"processRssBytes",
			"memoryMetric",
			"queueMaxRows",
			"unverified",
		])
		if (
			value.status !== "ok" ||
			value.sqlite !== "3.50.4" ||
			!integer(value.processRssBytes) ||
			value.processRssBytes > CAPS.driverRss ||
			value.queueMaxRows !== (scenario === "micro" ? 10 : 0) ||
			!str(value.memoryMetric)
		)
			throw new Error("Worker report rejected")
		strings(value.warnings, 16)
		strings(value.unverified)
		pragmas(value.initialPragmas)
		pragmas(value.finalPragmas)
		if (
			value.initialPragmas.journalMode !==
				(scenario === "runtime" ? "memory" : "wal") ||
			value.finalPragmas.journalMode !== value.initialPragmas.journalMode
		)
			throw new Error("Report journal rejected")
		const growth = value.growthReservation
		shape(growth, [
			"pageSize",
			"pages",
			"dbBytes",
			"walBytes",
			"totalBytes",
			"proof",
		])
		if (
			growth.pageSize !== 4096 ||
			growth.pages !== 128 ||
			growth.dbBytes !== 524288 ||
			growth.walBytes !== 597048 ||
			growth.totalBytes !== 1223744 ||
			!str(growth.proof)
		)
			throw new Error("Tiny reservation rejected")
		if (
			!Array.isArray(value.compileOptions) ||
			value.compileOptions.length > 256
		)
			throw new Error("Compile options rejected")
		for (const option of value.compileOptions) {
			shape(option, ["compile_options"])
			if (!str(option.compile_options))
				throw new Error("Compile option rejected")
		}
		shape(
			value.primitives,
			["ftsAvailable"],
			scenario === "micro"
				? [
						"rollback",
						"retentionBeforeRetry",
						"originalReceiptAfterPrune",
						"explicitExpiry",
						"queryPlan",
						"cleanRestart",
					]
				: [],
		)
		for (const key of [
			"ftsAvailable",
			...(scenario === "micro"
				? [
						"rollback",
						"retentionBeforeRetry",
						"originalReceiptAfterPrune",
						"explicitExpiry",
						"cleanRestart",
					]
				: []),
		])
			if (value.primitives[key] !== true)
				throw new Error("Primitive completion rejected")
		if (scenario === "micro") {
			if (
				!Array.isArray(value.primitives.queryPlan) ||
				value.primitives.queryPlan.length > 16
			)
				throw new Error("Plan rejected")
			for (const row of value.primitives.queryPlan) {
				shape(row, ["id", "parent", "notused", "detail"])
				if (
					![row.id, row.parent, row.notused].every(integer) ||
					!str(row.detail)
				)
					throw new Error("Plan row rejected")
			}
		}
	}
	shape(value.provenance, ["version", "sourceId"])
	if (!str(value.provenance.version) || !str(value.provenance.sourceId))
		throw new Error("SQLite provenance rejected")
	counts(value.counts)
	if (
		status === "unsupported" &&
		Object.values(value.counts).some(count => count !== 0)
	)
		throw new Error("Unsupported counts rejected")
	if (
		status !== "unsupported" &&
		(value.counts.offered !== (scenario === "micro" ? 10 : 0) ||
			value.counts.committed !== value.counts.offered ||
			value.provenance.version !== "3.50.4" ||
			value.provenance.sourceId !==
				"2025-07-30 19:33:53 4d8adfb30e03f9cf27f800a2c1ba3c48fb4ca1b08b0f5ed59a4d5ecbf45e20a3")
	)
		throw new Error("Worker completion rejected")
}

export function validateReport(
	report,
	config,
	reservation,
	exitCode,
	sourceHashes,
) {
	const base = [
		"externalCapture",
		"harnessVersion",
		"provisionalSQLite",
		"qualificationClaim",
		"scenario",
		"seed",
		"node",
		"versions",
		"runtimeProvenance",
		"pragmaProvenance",
		"osStallLimit",
		"os",
		"osRelease",
		"arch",
		"unverified",
		"counts",
		"status",
	]
	const long = !["disabled", "runtime", "micro"].includes(config.scenario)
	const extra =
		config.scenario === "disabled"
			? []
			: long
				? [
						"reason",
						"resourceWindow",
						"phase",
						"remainingPrerequisites",
						"metrics",
						"measurement",
					]
				: [
						"sourceHashes",
						"workloadVersion",
						"commandArguments",
						"result",
						"preflightFreeBytes",
						"filesystemType",
						"artifacts",
						"elapsedMs",
						"residue",
						"reportPersisted",
						"completion",
						"elapsedScope",
						"output",
					]
	shape(report, [...base, ...extra])
	if (
		exitCode !== 0 ||
		report.harnessVersion !== 2 ||
		report.provisionalSQLite !== true ||
		report.qualificationClaim !== false ||
		report.scenario !== config.scenario ||
		report.seed !== 42 ||
		report.node !== process.versions.node ||
		report.os !== process.platform ||
		report.arch !== process.arch
	)
		throw new Error("Driver identity/exit rejected")
	shape(report.externalCapture, Object.keys(reservation))
	if (
		Object.keys(reservation).some(
			key => report.externalCapture[key] !== reservation[key],
		)
	)
		throw new Error("Reservation echo rejected")
	shape(report.runtimeProvenance, ["executable", "actualNode", "requestedNode"])
	if (
		report.runtimeProvenance.executable !== process.execPath ||
		report.runtimeProvenance.actualNode !== report.node ||
		report.runtimeProvenance.requestedNode !== report.node
	)
		throw new Error("Runtime identity rejected")
	shape(report.versions, Object.keys(process.versions))
	if (
		Object.keys(process.versions).some(
			key => report.versions[key] !== process.versions[key],
		)
	)
		throw new Error("Runtime versions rejected")
	for (const key of ["pragmaProvenance", "osStallLimit", "osRelease"])
		if (!str(report[key])) throw new Error("Report metadata rejected")
	strings(report.unverified)
	counts(report.counts)
	if (config.scenario === "disabled") {
		if (report.status !== "disabled" || report.counts.offered !== 0)
			throw new Error("Disabled report rejected")
		return "disabled"
	}
	if (long) {
		if (
			report.status !== "not-run" ||
			report.phase !== config.phase ||
			report.resourceWindow !== config.resourceWindow ||
			!str(report.reason) ||
			!report.reason.startsWith(
				"Unsupported long mutation growth proof before persistent open/setup",
			) ||
			report.counts.offered !== 0
		)
			throw new Error("Long refusal rejected")
		strings(report.remainingPrerequisites, 5)
		shape(report.metrics, [
			"receiptLatency",
			"loopDelay",
			"cpu",
			"memory",
			"diskGrowth",
		])
		if (
			!Object.values(report.metrics).every(value => value === null) ||
			!str(report.measurement)
		)
			throw new Error("Not-run metrics rejected")
		return "not-run"
	}
	if (
		!["micro-only", "unsupported"].includes(report.status) ||
		report.completion !== "observed" ||
		report.reportPersisted !== true ||
		report.elapsedScope !== "through report persistence and cleanup attempt" ||
		!finite(report.elapsedMs) ||
		report.elapsedMs > config.deadlineMs ||
		report.output !== reservation.output ||
		report.residue.path !== reservation.output ||
		report.residue.ownership !==
			"Driver-owned; capture inventory is separate" ||
		!/^[0-9]+$/.test(report.preflightFreeBytes) ||
		!str(report.filesystemType) ||
		report.workloadVersion !== 2
	)
		throw new Error("Final completion rejected")
	shape(report.commandArguments, Object.keys(config))
	if (
		Object.keys(config).some(
			key => report.commandArguments[key] !== config[key],
		)
	)
		throw new Error("Command echo rejected")
	shape(report.sourceHashes, ["run.mjs", "worker.mjs", "workloads.mjs"])
	if (
		Object.keys(report.sourceHashes).some(
			key => report.sourceHashes[key] !== sourceHashes[key],
		)
	)
		throw new Error("Source hash mismatch")
	workerResult(report.result, config.scenario, report.status)
	if (JSON.stringify(report.counts) !== JSON.stringify(report.result.counts))
		throw new Error("Final count mismatch")
	inventory(report.artifacts, true)
	inventory(report.residue)
	return report.status
}

// One assignment even when cancellation, exit and timer callbacks race.
export function terminalLatch() {
	let reason = null
	return {
		assign(value) {
			if (reason !== null) return false
			reason = value
			return true
		},
		value: () => reason,
	}
}
export async function writeChunk(state, chunk, write, abort) {
	if (!Buffer.isBuffer(chunk) || chunk.length > CAPS.pull)
		throw new Error("Pull bound rejected")
	state.read += chunk.length
	if (state.truncated || state.failed) {
		state.discarded += chunk.length
		return
	}
	const allowed = Math.min(chunk.length, state.cap - state.stored)
	if (allowed < chunk.length) {
		state.truncated = true
		abort("capture cap exceeded")
	}
	let offset = 0
	try {
		while (offset < allowed) {
			const written = await write(chunk, offset, allowed - offset)
			if (
				!Number.isInteger(written) ||
				written <= 0 ||
				written > allowed - offset
			)
				throw new Error("Zero/invalid partial write")
			state.hash.update(chunk.subarray(offset, offset + written))
			offset += written
			state.stored += written
		}
	} catch (error) {
		state.failed = true
		abort(`capture write failed: ${String(error).slice(0, 256)}`)
	}
	state.discarded += chunk.length - offset
}

function same(actual, expected, file = false) {
	if (
		actual.ino !== expected.ino ||
		actual.dev !== expected.dev ||
		actual.isSymbolicLink() ||
		(file
			? !actual.isFile() ||
				actual.nlink !== 1 ||
				(actual.mode & 0o777) !== 0o600
			: !actual.isDirectory())
	)
		throw new Error("Owned identity changed")
}
function ancestors(path) {
	let current = sep
	for (const part of resolve(path).split(sep).filter(Boolean)) {
		current = join(current, part)
		const info = fs.lstatSync(current)
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("Unsafe ancestor")
	}
}
export function prepareCapture(
	config,
	root = ROOT,
	statfs = fs.statfsSync,
	check = () => {},
	runId = randomUUID(),
) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			runId,
		)
	)
		throw new Error("Invalid run UUID")
	ancestors(root)
	check()
	const base = join(resolve(root), "output", "qualification")
	let diskPath = resolve(root)
	for (const path of [join(resolve(root), "output"), base]) {
		try {
			ancestors(path)
			diskPath = path
		} catch (error) {
			if (error.code !== "ENOENT") throw error
			break
		}
	}
	diskGuard(
		statfs(diskPath, { bigint: true }),
		config.reserveBytes + CAPS.reservation,
	)
	for (const path of [join(resolve(root), "output"), base]) {
		try {
			fs.mkdirSync(path, { mode: 0o700 })
		} catch (error) {
			if (error.code !== "EEXIST") throw error
		}
		ancestors(path)
		check()
	}
	// Conservative recovery gate: prior activity evidence must be explicitly
	// disposed of by its owner before this consumer admits another reservation.
	const prior = fs.opendirSync(base)
	try {
		let entry
		let count = 0
		while ((entry = prior.readSync())) {
			check()
			if (++count > 256) throw new Error("Prior inventory cap")
			if (entry.name.startsWith("activity-"))
				throw new Error("Prior activity residue requires owner reconciliation")
		}
	} finally {
		prior.closeSync()
	}
	const output = join(base, `activity-${runId}`)
	const path = join(base, `activity-capture-${runId}`)
	const owned = { path, output, runId, files: [], driver: null, capture: null }
	try {
		fs.mkdirSync(path, { mode: 0o700 })
		owned.capture = fs.lstatSync(path)
		fs.mkdirSync(output, { mode: 0o700 })
		owned.driver = fs.lstatSync(output)
		for (const name of ["stdout.bin", "stderr.bin", "manifest.json"]) {
			check()
			owned.verify = () => {
				ancestors(base)
				same(fs.lstatSync(path), owned.capture)
				same(fs.lstatSync(output), owned.driver)
			}
			owned.verify()
			const full = join(path, name)
			const fd = fs.openSync(
				full,
				fs.constants.O_RDWR |
					fs.constants.O_CREAT |
					fs.constants.O_EXCL |
					fs.constants.O_NOFOLLOW,
				0o600,
			)
			const info = fs.fstatSync(fd)
			owned.files.push({ name, path: full, fd, info, closed: false })
			same(fs.lstatSync(full), info, true)
		}
		owned.config = {
			...config,
			output,
			captureReservation: [
				runId,
				owned.capture.ino,
				owned.capture.dev,
				owned.driver.ino,
				owned.driver.dev,
			].join(":"),
		}
		owned.reservation = verifyCaptureReservation(owned.config, root)
		check()
		diskGuard(
			statfs(base, { bigint: true }),
			config.reserveBytes + CAPS.reservation,
		)
		return owned
	} catch (error) {
		closeOwned(owned)
		cleanupPreSpawn(owned)
		throw error
	}
}
function verifyFile(owned, file) {
	owned.verify()
	same(fs.lstatSync(file.path), file.info, true)
	if (!file.closed) same(fs.fstatSync(file.fd), file.info, true)
}
function closeFile(file) {
	if (file.closed) return
	if (file.closeAttempted) throw new Error("Capture close settlement unknown")
	file.closeAttempted = true
	fs.closeSync(file.fd)
	file.closed = true
}
export function closeOwned(owned) {
	for (const file of owned.files)
		if (!file.closed && !file.closeAttempted) {
			try {
				closeFile(file)
			} catch {
				/* Preserve uncertain file. */
			}
		}
}
export function cleanupPreSpawn(owned) {
	// No recursive delete, no post-spawn cleanup, no dependence on statfs.
	if (owned.spawned) return
	for (const file of owned.files) {
		try {
			verifyFile(owned, file)
			if (file.closed) fs.unlinkSync(file.path)
		} catch {
			/* Preserve unsafe identity. */
		}
	}
}
export function writeManifest(owned, manifest, check = () => {}) {
	check()
	const text = JSON.stringify(manifest) + "\n"
	if (Buffer.byteLength(text) > CAPS.manifest)
		throw new Error("Manifest cap exceeded")
	const file = owned.files.find(file => file.name === "manifest.json")
	verifyFile(owned, file)
	fs.ftruncateSync(file.fd, 0)
	const bytes = Buffer.from(text)
	let offset = 0
	while (offset < bytes.length) {
		check()
		const n = fs.writeSync(
			file.fd,
			bytes,
			offset,
			Math.min(CAPS.pull, bytes.length - offset),
			offset,
		)
		if (n <= 0) throw new Error("Manifest zero write")
		offset += n
	}
	check()
	verifyFile(owned, file)
	return bytes.length
}
export function hashOwned(
	path,
	expected,
	cap,
	check = () => {},
	collect = false,
) {
	ancestors(dirname(path))
	same(fs.lstatSync(path), expected, true)
	const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const info = fs.fstatSync(fd)
		same(info, expected, true)
		if (info.size !== expected.size || info.mtimeMs !== expected.mtimeMs)
			throw new Error("File replaced before hashing")
		if (info.size > cap) throw new Error("Verification byte cap")
		const bytes = collect ? Buffer.alloc(info.size) : null
		const block = Buffer.alloc(65536)
		const hash = createHash("sha256")
		let total = 0
		while (total < info.size) {
			check()
			const n = fs.readSync(
				fd,
				block,
				0,
				Math.min(block.length, info.size - total),
				total,
			)
			if (!n) throw new Error("Truncated verification")
			hash.update(block.subarray(0, n))
			if (bytes) block.copy(bytes, total, 0, n)
			total += n
		}
		check()
		const final = fs.fstatSync(fd)
		same(final, info, true)
		same(fs.lstatSync(path), info, true)
		if (
			final.size !== info.size ||
			final.mtimeMs !== info.mtimeMs ||
			fs.lstatSync(path).mtimeMs !== info.mtimeMs
		)
			throw new Error("File changed during hashing")
		return {
			bytes,
			size: total,
			sha256: hash.digest("hex"),
			inode: info.ino,
			device: info.dev,
			mtimeMs: info.mtimeMs,
		}
	} finally {
		fs.closeSync(fd)
	}
}
export function inspectDriver(owned, check = () => {}) {
	owned.verify()
	check()
	const files = []
	let bytes = 0
	const dir = fs.opendirSync(owned.output)
	try {
		let entry
		while ((entry = dir.readSync())) {
			check()
			if (
				files.length === 4 ||
				![
					"fixture.db",
					"fixture.db-wal",
					"fixture.db-shm",
					"report.json",
				].includes(entry.name)
			)
				throw new Error("Unexpected driver residue")
			owned.verify()
			const path = join(owned.output, entry.name)
			const info = fs.lstatSync(path)
			const cap =
				entry.name === "fixture.db"
					? 16 * 1024 ** 2
					: entry.name.endsWith("-wal")
						? 4 * 1024 ** 2
						: 128 * 1024
			const hash = hashOwned(path, info, cap, check)
			bytes += hash.size
			files.push({
				name: entry.name,
				bytes: hash.size,
				inode: hash.inode,
				device: hash.device,
				mtimeMs: hash.mtimeMs,
				sha256: hash.sha256,
			})
		}
	} finally {
		dir.closeSync()
	}
	owned.verify()
	return { bytes, files }
}
export function unionAccounting(captureBytes, driverBytes, settled) {
	if (
		!integer(captureBytes) ||
		captureBytes > CAPS.reservation ||
		(driverBytes !== null && !integer(driverBytes))
	)
		throw new Error("Unknown union accounting")
	return {
		captureMeasuredBytes: captureBytes,
		captureReservedBytes: settled ? 0 : CAPS.reservation - captureBytes,
		driverMeasuredBytes: driverBytes,
		driverReservationBytes: driverBytes === null ? null : 0,
		totalBytes:
			driverBytes === null
				? null
				: (settled ? captureBytes : CAPS.reservation) + driverBytes,
		settled,
		filesystemOverhead: "unmeasured; logical file lengths only",
	}
}

function pull(pipe, room) {
	if (!pipe.readableLength) {
		pipe.read(0)
		return null
	}
	const bytes = pipe.read(Math.min(room, pipe.readableLength))
	if (bytes === null) return null
	if (!Buffer.isBuffer(bytes) || bytes.length > room)
		throw new Error("Pipe pull bound rejected")
	// Own <=16KiB, rather than retaining a view of an arbitrarily larger runtime
	// read buffer. Two owned chunks plus transient copies remain <=64KiB;
	// runtime/kernel/child buffering is separate unknown overhead.
	return Buffer.from(bytes)
}
export async function superviseChild(
	factory,
	writers,
	{
		now = () => performance.now(),
		signal,
		sample = () => ({
			captureRss: process.memoryUsage().rss,
			captureCpu: process.cpuUsage(),
			driverRss: null,
			driverCpu: null,
		}),
		kill = (pid, sig) => process.kill(-pid, sig),
	} = {},
) {
	if (signal?.aborted) throw new Error("Cancelled before spawn")
	const started = now()
	const driverEnd = started + CAPS.driverMs
	const child = factory()
	const latch = terminalLatch()
	const states = ["stdout", "stderr"].map(name => ({
		name,
		cap: CAPS[name],
		read: 0,
		stored: 0,
		discarded: 0,
		truncated: false,
		failed: false,
		closed: false,
		eof: false,
		busy: false,
		hash: createHash("sha256"),
	}))
	let exited = false
	let childClosed = false
	let exitCode = null
	let exitSignal = null
	let abortAt = null
	let joinEnd = null
	let discarded = 0
	let stopped = false
	let complete
	const timers = []
	const metrics = {
		samples: 0,
		peakCaptureRss: 0,
		peakDriverRss: null,
		peakCombinedRss: null,
		captureCpuUs: 0,
		driverCpuUs: null,
		combinedOverSamples: 0,
		driverMeasurement: "unknown: no platform-qualified external driver sampler",
		sampleGuarantee: "1Hz observations; no native hard cap or peak guarantee",
	}
	let priorCpu = null
	let priorDriverCpu = null
	let priorTime = started
	let consecutive = 0
	const timer = (fn, ms) => {
		const id = setTimeout(fn, ms)
		timers.push(id)
		return id
	}
	const result = () => ({
		reason: latch.value(),
		joined: exited && childClosed && states.every(state => state.closed),
		writersSettled: states.every(state => !state.busy),
		exitCode,
		exitSignal,
		childElapsedMs: now() - started,
		terminationMs: abortAt === null ? 0 : now() - abortAt,
		streams: states.map(({ hash, ...state }) => ({
			...state,
			sha256: state.busy ? null : hash.digest("hex"),
		})),
		metrics,
	})
	const finish = () => {
		if (stopped) return
		// Timers may be delayed behind exit, EOF, close or writer callbacks.
		// Observe the absolute budgets before clearing them, while retaining the
		// actual physical join facts and the first terminal failure.
		const at = now()
		if (at >= driverEnd) latch.assign("driver deadline exceeded")
		if (joinEnd !== null && at >= joinEnd)
			latch.assign("exit without pipe closure")
		if (abortAt !== null && at >= abortAt + CAPS.terminationMs)
			latch.assign("termination deadline exceeded")
		stopped = true
		for (const id of timers) clearTimeout(id)
		signal?.removeEventListener("abort", cancel)
		complete(result())
	}
	const maybeFinish = () => {
		if (
			exited &&
			childClosed &&
			states.every(state => state.closed && !state.busy)
		)
			finish()
	}
	const send = sig => {
		// A reaped numeric PID/group is never signalled again.
		if (exited || !Number.isSafeInteger(child.pid) || child.pid <= 0) return
		try {
			kill(child.pid, sig)
		} catch (error) {
			latch.assign(`signal failed: ${String(error).slice(0, 256)}`)
		}
	}
	const abort = (reason, deadline = now()) => {
		latch.assign(reason)
		if (abortAt !== null || stopped) return
		abortAt = Math.min(deadline, driverEnd)
		send("SIGTERM")
		timer(() => send("SIGKILL"), Math.max(0, abortAt + 100 - now()))
		timer(
			() => {
				for (const state of states) child[state.name].destroy()
				// Closing our read ends is not proof that an unjoined driver died.
				finish()
			},
			Math.max(
				0,
				Math.min(joinEnd ?? Infinity, abortAt + CAPS.terminationMs) - now(),
			),
		)
	}
	const cancel = () => abort("cancelled")
	const pump = async state => {
		if (state.busy || stopped || state.closed) return
		state.busy = true
		const pipe = child[state.name]
		try {
			while (!stopped && !state.closed) {
				const room =
					abortAt === null
						? CAPS.pull
						: Math.min(CAPS.pull, CAPS.discard - discarded)
				if (
					room <= 0 ||
					(abortAt !== null && now() >= abortAt + CAPS.terminationMs)
				) {
					pipe.destroy()
					break
				}
				const chunk = pull(pipe, room)
				if (chunk === null) break
				if (!Buffer.isBuffer(chunk) || chunk.length > room)
					throw new Error("Pipe pull bound rejected")
				if (abortAt !== null) {
					state.read += chunk.length
					state.discarded += chunk.length
					discarded += chunk.length
					continue
				}
				const before = state.discarded
				await writeChunk(state, chunk, writers[state.name], abort)
				discarded += state.discarded - before
			}
		} catch (error) {
			state.failed = true
			abort(`pipe failed: ${String(error).slice(0, 256)}`)
		} finally {
			state.busy = false
			maybeFinish()
		}
	}
	const pending = new Promise(resolveResult => {
		complete = resolveResult
	})
	child.once("error", error => {
		if (!child.pid) exited = true // Failed spawn has no live numeric owner.
		abort(`child error: ${String(error).slice(0, 256)}`)
	})
	child.once("exit", (code, sig) => {
		exited = true
		exitCode = code
		exitSignal = sig
		if (code !== 0) abort("driver exit failed")
		// A root exit with inherited/held pipes has only the fixed join grace.
		if (!childClosed || !states.every(state => state.closed && !state.busy)) {
			if (abortAt === null) {
				joinEnd = Math.min(now(), driverEnd) + CAPS.terminationMs
				timer(
					() => {
						latch.assign("exit without pipe closure")
						for (const state of states) child[state.name].destroy()
						finish()
					},
					Math.max(0, joinEnd - now()),
				)
			}
		}
		maybeFinish()
	})
	child.once("close", () => {
		childClosed = true
		maybeFinish()
	})
	for (const state of states) {
		const pipe = child[state.name]
		pipe.pause()
		pipe.on("readable", () => {
			void pump(state)
		})
		pipe.once("end", () => {
			state.eof = true
			pipe.destroy()
		})
		pipe.once("error", error => {
			state.failed = true
			abort(`pipe error: ${String(error).slice(0, 256)}`)
		})
		pipe.once("close", () => {
			state.closed = true
			if (!state.eof && abortAt === null) abort("pipe closed before EOF")
			maybeFinish()
		})
	}
	signal?.addEventListener("abort", cancel, { once: true })
	if (signal?.aborted) cancel()
	timer(
		() => abort("driver deadline exceeded", driverEnd),
		Math.max(0, driverEnd - now()),
	)
	const observe = () => {
		if (stopped) return
		try {
			if (++metrics.samples > 1266) throw new Error("Sampling cap exceeded")
			const current = sample(child.pid)
			if (!integer(current.captureRss)) throw new Error("Capture RSS unknown")
			metrics.peakCaptureRss = Math.max(
				metrics.peakCaptureRss,
				current.captureRss,
			)
			if (current.captureRss > CAPS.captureRss)
				abort("capture RSS stop objective")
			const at = now()
			const cpu = current.captureCpu?.user + current.captureCpu?.system
			if (integer(cpu)) {
				if (priorCpu !== null)
					metrics.captureCpuUs += Math.max(0, cpu - priorCpu)
			}
			if (integer(current.driverRss)) {
				metrics.peakDriverRss = Math.max(
					metrics.peakDriverRss ?? 0,
					current.driverRss,
				)
				metrics.peakCombinedRss = Math.max(
					metrics.peakCombinedRss ?? 0,
					current.driverRss + current.captureRss,
				)
				if (
					current.driverRss > CAPS.driverRss ||
					current.driverRss + current.captureRss > CAPS.combinedRss
				)
					abort("driver/combined RSS stop objective")
			}
			if (
				integer(current.driverCpu) &&
				integer(cpu) &&
				priorCpu !== null &&
				priorDriverCpu !== null &&
				at > priorTime
			) {
				const delta = current.driverCpu - priorDriverCpu
				metrics.driverCpuUs = (metrics.driverCpuUs ?? 0) + Math.max(0, delta)
				const cores = (delta + cpu - priorCpu) / ((at - priorTime) * 1000)
				consecutive = cores > 1.5 ? consecutive + 1 : 0
				if (cores > 1.5) metrics.combinedOverSamples++
				if (consecutive >= 10) abort("combined CPU stop objective")
			}
			priorCpu = integer(cpu) ? cpu : null
			priorDriverCpu = integer(current.driverCpu) ? current.driverCpu : null
			priorTime = at
		} catch (error) {
			abort(`sampling failed: ${String(error).slice(0, 256)}`)
		}
		if (!stopped) timer(observe, 1000)
	}
	observe()
	return await pending
}

export function fixedLaunch(config) {
	const args = ["--max-old-space-size=96", join(SOURCE, "run.mjs")]
	const flags = {
		scenario: "--scenario",
		phase: "--phase",
		seed: "--seed",
		reserveBytes: "--reserve-gib",
		deadlineMs: "--deadline-ms",
		resourceWindow: "--resource-window",
		output: "--output",
		captureReservation: "--capture-reservation",
	}
	for (const [key, value] of Object.entries(config)) {
		if (!flags[key]) throw new Error("Unknown child option")
		args.push(flags[key], String(key === "reserveBytes" ? value / GiB : value))
	}
	return {
		executable: process.execPath,
		args,
		options: {
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { LANG: "C", TZ: "UTC" },
			cwd: ROOT,
		},
	}
}
export function captureArgs(args) {
	if (args.some(arg => ["--output", "--capture-reservation"].includes(arg)))
		throw new Error("Capture owns output and reservation")
	const config = parseArgs(args)
	if (config.reserveBytes > 63 * GiB)
		throw new Error("Capture reserve headroom rejected")
	return config
}
export async function capture(
	config,
	{
		root = ROOT,
		statfs = fs.statfsSync,
		now = () => performance.now(),
		signal,
		spawnChild = spawn,
		write = fs.writeSync,
		manifestWriter = writeManifest,
		sample,
		kill,
		hashSource = hashOwnedSource,
	} = {},
) {
	// Test injections are library-only; CLI accepts no executable/command/environment.
	config = captureArgs(
		Object.entries(config).flatMap(([key, value]) => {
			const flag = {
				scenario: "--scenario",
				phase: "--phase",
				seed: "--seed",
				reserveBytes: "--reserve-gib",
				deadlineMs: "--deadline-ms",
				resourceWindow: "--resource-window",
			}[key]
			if (!flag) throw new Error("Unknown capture configuration")
			return [flag, String(key === "reserveBytes" ? value / GiB : value)]
		}),
	)
	if (!["darwin", "linux"].includes(process.platform))
		throw new Error("POSIX group capability unsupported")
	if (signal?.aborted) throw new Error("Cancelled before preflight")
	const started = now()
	const startedCpu = process.cpuUsage()
	const totalEnd = started + CAPS.totalMs
	let deadline = started + CAPS.preflightMs
	const captureMeasurements = {
		samples: 0,
		peakRssBytes: 0,
		scope:
			"1Hz observations at supervised timers and preflight/post-exit checkpoints; additional parse-boundary observation; synchronous/native peaks can be missed",
	}
	let lastCaptureSample = -Infinity
	const resourceSample =
		sample ??
		(() => ({
			captureRss: process.memoryUsage().rss,
			captureCpu: process.cpuUsage(),
			driverRss: null,
			driverCpu: null,
		}))
	const observeOwn = (force = false, measurement) => {
		const at = now()
		if (!force && at < lastCaptureSample + 1000) return
		lastCaptureSample = at
		if (++captureMeasurements.samples > 1266)
			throw new Error("Capture sample cap exceeded")
		const current = measurement ?? resourceSample()
		if (!integer(current.captureRss)) throw new Error("Capture RSS unknown")
		captureMeasurements.peakRssBytes = Math.max(
			captureMeasurements.peakRssBytes,
			current.captureRss,
		)
		if (current.captureRss > CAPS.captureRss)
			throw new Error("Capture RSS stop objective")
	}
	const check = () => {
		if (signal?.aborted && deadline === started + CAPS.preflightMs)
			throw new Error("Cancelled preflight")
		if (now() >= deadline || now() >= totalEnd)
			throw new Error("Capture deadline exceeded")
		observeOwn()
	}
	let owned
	let supervised
	let manifest
	let manifestBytes = 0
	let finalPersisted = false
	let finalAttempted = false
	let spawnStarted = null
	const latch = terminalLatch()
	try {
		owned = prepareCapture(config, root, statfs, check)
		manifest = {
			version: 1,
			runId: owned.runId,
			completion: "pending",
			outcome: "pending",
			reservation: owned.reservation,
			limits: CAPS,
			accounting: unionAccounting(0, null, false),
			process: null,
			measurements:
				"capture CPU/RSS observed; driver/combined measurement unknown; no qualification claim",
			allocationEstimate:
				"8MiB working-set estimate only; simultaneous parsing/buffer/key/manifest allocations retained",
			inventory: [],
		}
		manifestBytes = manifestWriter(owned, manifest, check)
		const sourceHashes = {}
		for (const name of ["run.mjs", "worker.mjs", "workloads.mjs"]) {
			check()
			const path = join(SOURCE, name)
			sourceHashes[name] = hashSource(path, 65536, check)
		}
		const captureHash = hashSource(join(SOURCE, "capture.mjs"), 65536, check)
		const executableHash = hashSource(process.execPath, 256 * 1024 ** 2, check)
		check()
		owned.verify()
		const launch = fixedLaunch(owned.config)
		const writers = Object.fromEntries(
			["stdout", "stderr"].map(name => {
				const file = owned.files.find(file => file.name === `${name}.bin`)
				return [
					name,
					(chunk, offset, length) => {
						verifyFile(owned, file)
						return write(file.fd, chunk, offset, length, null)
					},
				]
			}),
		)
		spawnStarted = now()
		owned.spawned = true // From here, no cleanup even if spawn throws.
		supervised = await superviseChild(
			() => spawnChild(launch.executable, launch.args, launch.options),
			writers,
			{
				now,
				signal,
				sample: pid => {
					const current = resourceSample(pid)
					observeOwn(false, current)
					return current
				},
				...(kill ? { kill } : {}),
			},
		)
		deadline = Math.min(totalEnd, now() + CAPS.postMs)
		check()
		manifest.process = supervised
		manifest.provenance = {
			executable: process.execPath,
			executableHash,
			captureHash,
			node: process.versions.node,
			sourceHashes,
			childCommand: launch.args,
			topology:
				"fixed driver with approved worker_threads only; OS descendants unsupported/unverified",
		}
		if (
			supervised.reason ||
			!supervised.joined ||
			!supervised.writersSettled ||
			supervised.streams.some(
				stream => !stream.eof || stream.failed || stream.truncated,
			)
		)
			latch.assign(supervised.reason ?? "closure/bytes uncertain")
		// Never inspect a still-live driver's artifacts, or close a descriptor with
		// an outstanding write. The owned CLI exits on uncertain containment.
		if (!supervised.writersSettled)
			throw new Error("Capture writer settlement unknown")
		for (const file of owned.files.filter(
			file => file.name !== "manifest.json",
		)) {
			closeFile(file)
		}
		const captures = []
		let stdout
		for (const name of ["stdout", "stderr"]) {
			const file = owned.files.find(file => file.name === `${name}.bin`)
			verifyFile(owned, file)
			const verified = hashOwned(
				file.path,
				fs.lstatSync(file.path),
				CAPS[name],
				check,
				name === "stdout",
			)
			const stream = supervised.streams.find(stream => stream.name === name)
			if (verified.size !== stream.stored || verified.sha256 !== stream.sha256)
				throw new Error("Capture digest/count mismatch")
			captures.push({
				name: file.name,
				bytes: verified.size,
				sha256: verified.sha256,
				inode: verified.inode,
				device: verified.device,
			})
			if (name === "stdout") stdout = verified.bytes
		}
		let driver = null
		if (supervised.joined) {
			driver = inspectDriver(owned, check)
			if (!latch.value()) {
				const parsed = parseBoundedJSON(stdout, check)
				manifest.parsing = parsed.accounting
				observeOwn(true)
				manifest.driverOutcome = validateReport(
					parsed.report,
					owned.config,
					owned.reservation,
					supervised.exitCode,
					sourceHashes,
				)
				const claimed = parsed.report.residue ?? { bytes: 0, files: [] }
				if (
					claimed.bytes !== driver.bytes ||
					claimed.files.length !== driver.files.length ||
					claimed.files.some(
						file =>
							!driver.files.some(
								actual =>
									actual.name === file.name &&
									actual.bytes === file.bytes &&
									actual.inode === file.inode &&
									actual.device === file.device &&
									actual.mtimeMs === file.mtimeMs,
							),
					)
				)
					throw new Error("Driver residue reconciliation failed")
			}
		}
		try {
			diskGuard(statfs(owned.path, { bigint: true }), config.reserveBytes)
		} catch (error) {
			latch.assign(
				`post-exit disk unknown/breached: ${String(error).slice(0, 256)}`,
			)
		}
		manifest.inventory = [...captures, ...(driver?.files ?? [])]
		manifest.outcome = latch.value() ? "incomplete" : "captured"
		manifest.reason = latch.value()
		manifest.completion =
			"observed before final manifest write; final write confirmed by summary only"
		manifest.captureMeasurements = { ...captureMeasurements }
		manifest.preflightMs = spawnStarted - started
		manifest.postExitVerificationMs =
			now() - (spawnStarted + supervised.childElapsedMs)
		// Include the sole manifest's final length in the disjoint union, with a
		// bounded fixed point. No self hash/duration or atomic durability claim.
		for (let i = 0; i < 8; i++) {
			manifest.accounting = unionAccounting(
				captures.reduce((sum, file) => sum + file.bytes, 0) + manifestBytes,
				driver?.bytes ?? null,
				supervised.joined,
			)
			const size = Buffer.byteLength(JSON.stringify(manifest) + "\n")
			if (size === manifestBytes) break
			manifestBytes = size
			if (i === 7) throw new Error("Manifest accounting did not converge")
		}
		finalAttempted = true
		manifestWriter(owned, manifest, check)
		check()
		finalPersisted = true
	} catch (error) {
		latch.assign(String(error).slice(0, 512))
		if (owned && !owned.spawned) {
			closeOwned(owned)
			cleanupPreSpawn(owned)
		} else if (
			owned &&
			manifest &&
			supervised?.writersSettled &&
			!finalAttempted
		) {
			// Protocol/hash/inventory failures leave an explicit final incomplete
			// record. Unknown bytes retain the full reservation, never zero them.
			try {
				check()
				manifest.outcome = "incomplete"
				manifest.reason = latch.value()
				manifest.completion = "incomplete; accounting/verification pending"
				manifest.process = supervised
				manifest.accounting = {
					captureMeasuredBytes: null,
					captureReservedBytes: CAPS.reservation,
					driverMeasuredBytes: null,
					driverReservationBytes: null,
					totalBytes: null,
					settled: false,
				}
				finalAttempted = true
				manifestWriter(owned, manifest, check)
				check()
				finalPersisted = true
			} catch {
				/* Initial/potentially torn manifest remains pending evidence. */
			}
		}
	} finally {
		if (owned && (!supervised || supervised.writersSettled)) {
			closeOwned(owned)
			if (owned.files.some(file => !file.closed))
				latch.assign("Capture file close settlement unknown")
		}
	}
	// Final descriptor closure is part of the unchanged post-exit/total budget.
	// Even a successfully returned synchronous close can reveal an overrun.
	if (now() >= deadline || now() >= totalEnd)
		latch.assign("Capture deadline exceeded through file closure")
	return {
		outcome: finalPersisted && !latch.value() ? "captured" : "incomplete",
		reason: latch.value(),
		path: owned?.path ?? null,
		runId: owned?.runId ?? null,
		finalManifestPersisted: finalPersisted,
		joined: supervised?.joined ?? false,
		writersSettled: supervised?.writersSettled ?? true,
		filesClosed: owned?.files.every(file => file.closed) ?? true,
		driverOutcome: manifest?.driverOutcome ?? null,
		elapsedMs: now() - started,
		qualificationClaim: false,
		captureMeasurements: { ...captureMeasurements },
		captureCpuThroughClosureUs: (() => {
			const cpu = process.cpuUsage(startedCpu)
			return cpu.user + cpu.system
		})(),
		measurements:
			"driver CPU/RSS and combined acceptance unknown; sampled capture metrics only",
		accounting: finalPersisted ? manifest.accounting : null,
	}
}
function hashOwnedSource(path, cap, check) {
	// Source/executable modes differ from private evidence files; no-follow,
	// descriptor/path identity and size/mtime checks still apply.
	ancestors(dirname(path))
	const expected = fs.lstatSync(path)
	if (!expected.isFile() || expected.isSymbolicLink() || expected.size > cap)
		throw new Error("Unsafe/unbounded source")
	const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const before = fs.fstatSync(fd)
		if (before.ino !== expected.ino || before.dev !== expected.dev)
			throw new Error("Source replaced")
		const hash = createHash("sha256")
		const block = Buffer.alloc(65536)
		let read = 0
		while (read < before.size) {
			check()
			const n = fs.readSync(
				fd,
				block,
				0,
				Math.min(block.length, before.size - read),
				read,
			)
			if (!n) throw new Error("Source truncated")
			read += n
			hash.update(block.subarray(0, n))
		}
		const after = fs.fstatSync(fd)
		const current = fs.lstatSync(path)
		if (
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			current.ino !== before.ino ||
			current.dev !== before.dev ||
			current.isSymbolicLink() ||
			current.mtimeMs !== before.mtimeMs
		)
			throw new Error("Source changed")
		check()
		return hash.digest("hex")
	} finally {
		fs.closeSync(fd)
	}
}
export function emitSummary(
	summary,
	{
		write = text => process.stdout.write(text),
		exit = code => process.exit(code),
	} = {},
) {
	try {
		const text = JSON.stringify(summary) + "\n"
		if (Buffer.byteLength(text) > 4096) throw new Error("Summary cap exceeded")
		write(text)
	} finally {
		// The consumer's own stdout can be backpressured too. Never wait for its
		// flush callback while an uncertain root or write still holds live refs.
		// A lost/truncated summary is incomplete; the bounded manifest survives.
		if (!summary.joined || !summary.writersSettled || !summary.filesClosed)
			exit(1)
	}
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
		const summary = await capture(captureArgs(process.argv.slice(2)), {
			signal: controller.signal,
		})
		emitSummary(summary)
		if (summary.outcome !== "captured") process.exitCode = 1
	} catch (error) {
		process.stderr.write(
			JSON.stringify({
				outcome: "incomplete",
				error: String(error).slice(0, 1024),
			}) + "\n",
		)
		process.exitCode = 1
	} finally {
		process.removeListener("SIGINT", cancel)
		process.removeListener("SIGTERM", cancel)
	}
}
