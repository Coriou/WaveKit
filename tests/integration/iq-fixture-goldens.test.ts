// tests/integration/iq-fixture-goldens.test.ts
/**
 * IQ fixture goldens (addendum §8). Opt-in; never a default gate on the dev Mac.
 *
 *   docker run -d --init --name wk-fixtures -v "$PWD/fixtures:/fixtures:ro" \
 *     --entrypoint sleep <image> infinity
 *
 * --init is required: with `sleep` as PID 1 nothing reaps the stopped app, and the pid-file cleanup would
 * wait the full 20 s on a zombie for every path.
 *   WAVEKIT_FIXTURE_CONTAINER=wk-fixtures WAVEKIT_FIXTURES_DIR="$PWD/fixtures" \
 *     pnpm exec vitest run tests/integration/iq-fixture-goldens.test.ts
 *
 * Batch 4 adds WAVEKIT_FIXTURE_PATHS=raw,channelizer (Property 15).
 * WAVEKIT_FIXTURE_RECORD=1 prints observed sets for review instead of asserting, and still fails a
 * suspended or zero-count run so it can never become a golden (delta E2).
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { loadManifest, type Fixture } from "./fixtures/manifest.js"
import {
	CONTAINER_FIXTURES_DIR,
	KILL_FALLBACK_MARK,
	buildFixtureConfig,
	fixtureApiPort,
	fixturePaths,
	goldenDecoderId,
	keySet,
	matchExpected,
	padCommand,
	runSeconds,
	selectFixtures,
	stopCommand,
	type FixturePath,
	type ObservedOutput,
} from "./fixtures/harness.js"

const container = process.env["WAVEKIT_FIXTURE_CONTAINER"]
const fixturesDir = process.env["WAVEKIT_FIXTURES_DIR"]
const record = process.env["WAVEKIT_FIXTURE_RECORD"] === "1"
const COLLECTOR = "/tmp/wk-collect-outputs.mjs"

interface ExecResult {
	status: number | null
	stdout: string
	stderr: string
}

/**
 * Async so the vitest worker's event loop stays live: a spawnSync blocked it for 30-53 s per fixture and its
 * "onTaskUpdate" RPC timed out, failing a green run (ruling QH-9). Rejects on spawn error or timeout, as spawnSync threw.
 */
function exec(
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
	const timeoutMs = options.timeoutMs ?? 30000
	return new Promise((resolvePromise, reject) => {
		const child = spawn("docker", [
			"exec",
			...(options.input !== undefined ? ["-i"] : []),
			container!,
			...args,
		])
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d))
		child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d))
		const timer = setTimeout(() => {
			child.kill("SIGTERM")
			reject(
				new Error(
					`docker exec ${args[0] ?? ""} timed out after ${timeoutMs} ms`,
				),
			)
		}, timeoutMs)
		child.on("error", err => {
			clearTimeout(timer)
			reject(err)
		})
		child.on("close", status => {
			clearTimeout(timer)
			resolvePromise({ status, stdout, stderr })
		})
		child.stdin.on("error", () => {})
		child.stdin.end(options.input)
	})
}

/** A setup step that must succeed; its stderr explains the failure. */
async function execOk(
	what: string,
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
) {
	const r = await exec(args, options)
	expect(r.status, `${what} failed: ${r.stderr}`).toBe(0)
	return r
}

interface PathResult {
	observed: ObservedOutput[]
	status: Record<string, unknown> | undefined
	log: string
	collectorExit: number | null
	collectorStderr: string
}

async function runFixture(
	f: Fixture,
	path: FixturePath,
	index: number,
): Promise<PathResult> {
	const tag = `${f.id}-${path}`
	const apiPort = fixtureApiPort(index, path)
	const padded = `/tmp/wk-${tag}.cu8`
	const configPath = `/tmp/wk-${tag}.yaml`
	const logPath = `/tmp/wk-${tag}.log`
	const pidPath = `/tmp/wk-${tag}.pid`
	const seconds = runSeconds(f)
	await execOk("config write", ["sh", "-c", `cat > '${configPath}'`], {
		input: buildFixtureConfig({
			fixture: f,
			path,
			apiPort,
			paddedPath: padded,
		}),
	})
	let collected: ExecResult
	try {
		await execOk(
			"pad",
			[
				"sh",
				"-c",
				padCommand(f, `${CONTAINER_FIXTURES_DIR}/${f.file}`, padded),
			],
			{ timeoutMs: 120000 },
		)
		// $! is the `timeout` process (nohup execs it); `timeout` forwards SIGTERM to node, which stops its decoders.
		await execOk("app launch", [
			"sh",
			"-c",
			`WAVEKIT_CONFIG='${configPath}' nohup timeout -s TERM ${Math.ceil(seconds + 20)} node /app/dist/index.js > '${logPath}' 2>&1 & echo $! > '${pidPath}'`,
		])
		collected = await exec(
			["node", COLLECTOR, String(apiPort), String(seconds), goldenDecoderId(f)],
			{ timeoutMs: (seconds + 30) * 1000 },
		)
	} finally {
		// Runs even when setup or the collector throws, so the padded capture (hundreds of MB) never leaks.
		// No match-by-command-line kill: bookworm-slim has no procps, and the config path is in the env, not on the command line.
		// Stop this instance before the next path starts, so two app instances never overlap (doubled decoders, port
		// collisions, a corrupted Property 15 comparison).
		const stopped = await exec(["sh", "-c", stopCommand(pidPath, padded)], {
			timeoutMs: 30000,
		})
		if (stopped.stderr.includes(KILL_FALLBACK_MARK))
			process.stderr.write(`${tag}: ${stopped.stderr}`)
	}
	const observed: ObservedOutput[] = []
	let status: Record<string, unknown> | undefined
	for (const line of collected.stdout.split("\n")) {
		if (!line.trim()) continue
		const msg = JSON.parse(line) as {
			kind: string
			output?: { type: string; data: Record<string, unknown> }
			status?: Record<string, unknown>
		}
		if (msg.kind === "output" && msg.output)
			observed.push({ type: msg.output.type, data: msg.output.data })
		if (msg.kind === "status") status = msg.status
	}
	return {
		observed,
		status,
		log: (await exec(["cat", logPath])).stdout,
		collectorExit: collected.status,
		collectorStderr: collected.stderr,
	}
}

describe.skipIf(!container || !fixturesDir)("IQ fixture goldens", () => {
	// vitest still runs a skipped suite's body to collect it; select only with the gate env set.
	if (!container || !fixturesDir) {
		it.skip("needs WAVEKIT_FIXTURE_CONTAINER and WAVEKIT_FIXTURES_DIR", () => {})
		return
	}
	// Negative fixtures are real captures with only channel.center_hz moved out of the capture. options.channelHz is
	// read only by getChannelRequest (Task 23), so on the raw path they decode the real signal. They run on the
	// channelizer path only (fixturePaths), and are left out when WAVEKIT_FIXTURE_PATHS has no channelizer (batch 3,
	// Task 8). With the gate env set, a selection that would compare nothing throws here and fails the run (final
	// review infra I1): a bad path list, an unknown, absent or unrunnable requested id, an absent public fixture.
	const { paths, fixtures, skippedPrivate } = selectFixtures({
		fixtures: loadManifest().fixtures,
		pathsEnv: process.env["WAVEKIT_FIXTURE_PATHS"],
		idsEnv: process.env["WAVEKIT_FIXTURE_IDS"],
		exists: file => existsSync(join(resolve(fixturesDir ?? "."), file)),
	})
	if (skippedPrivate.length > 0)
		process.stderr.write(
			`private fixtures absent, not replayed: ${skippedPrivate.join(", ")}\n`,
		)
	beforeAll(() => {
		const r = spawnSync("docker", [
			"cp",
			resolve("tests/integration/fixtures/collect-outputs.mjs"),
			`${container!}:${COLLECTOR}`,
		])
		expect(r.status).toBe(0)
	})
	it.each(fixtures.map((f, i) => [f.id, f, i] as const))(
		"%s",
		async (_id, f, index) => {
			const results = new Map<FixturePath, PathResult>()
			const runs = fixturePaths(f, paths)
			expect(runs.length, "fixture runs on no selected path").toBeGreaterThan(0)
			for (const path of runs)
				results.set(path, await runFixture(f, path, index))
			for (const [path, r] of results) {
				expect(
					r.collectorExit,
					`${path}: collector failed: ${r.collectorStderr}\n${r.log.slice(-4000)}`,
				).toBe(0)
			}
			if (record) {
				for (const [path, r] of results) {
					process.stdout.write(
						`${JSON.stringify({
							fixture: f.id,
							path,
							count: matchExpected(f, r.observed).count,
							keys: keySet(f, r.observed),
							suspended: r.status?.["suspended"],
							suspension: r.status?.["suspension"],
							bandAssessment: r.status?.["bandAssessment"],
							sample: r.observed.slice(0, 5),
						})}\n`,
					)
				}
				// Delta E2: a band- or rate-suspended or silent run must never be recorded as a golden.
				if (f.role !== "negative") {
					for (const [path, r] of results) {
						expect(
							r.status?.["suspended"],
							`${path}: ${JSON.stringify(r.status?.["suspension"])} ${JSON.stringify(r.status?.["bandAssessment"])}`,
						).not.toBe(true)
						expect(
							matchExpected(f, r.observed).count,
							`${path}: count`,
						).toBeGreaterThan(0)
					}
				}
				return
			}
			for (const [path, r] of results) {
				const m = matchExpected(f, r.observed)
				if (f.role === "negative") {
					// Only the channelizer path reaches here for a negative (raw is skipped above).
					expect(m.count, `${path}: negative fixture decoded`).toBe(0)
					if (f.expected.suspension) {
						expect(r.status?.["suspended"]).toBe(true)
						expect(r.log).toContain(`"reasonCode":"${f.expected.suspension}"`)
					}
				} else {
					// Delta E2: a suspended decoder decodes nothing; say why.
					expect(
						r.status?.["suspended"],
						JSON.stringify(r.status?.["bandAssessment"]),
					).not.toBe(true)
					expect(m.missing, `${path}: missing payloads`).toEqual([])
					expect(m.count, `${path}: count`).toBeGreaterThanOrEqual(
						f.expected.min_count,
					)
				}
			}
			const raw = results.get("raw")
			const chan = results.get("channelizer")
			if (paths.length === 2 && f.role === "channelizer-golden") {
				// Property 15 needs both sides; a missing one must never pass on the other alone.
				expect(raw, "raw path result").toBeDefined()
				expect(chan, "channelizer path result").toBeDefined()
			}
			if (raw && chan && f.role === "channelizer-golden") {
				// Feature: core-channelizer, Property 15: Golden equality
				// Validates: addendum §8, §12.15
				expect(keySet(f, chan.observed)).toEqual(keySet(f, raw.observed))
			}
		},
		600000,
	)
})
