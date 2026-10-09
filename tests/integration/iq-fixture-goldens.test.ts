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
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { loadManifest, type Fixture } from "./fixtures/manifest.js"
import {
	CONTAINER_FIXTURES_DIR,
	buildFixtureConfig,
	fixtureApiPort,
	goldenDecoderId,
	keySet,
	matchExpected,
	padCommand,
	runSeconds,
	type FixturePath,
	type ObservedOutput,
} from "./fixtures/harness.js"

const container = process.env["WAVEKIT_FIXTURE_CONTAINER"]
const fixturesDir = process.env["WAVEKIT_FIXTURES_DIR"]
const record = process.env["WAVEKIT_FIXTURE_RECORD"] === "1"
const paths = (process.env["WAVEKIT_FIXTURE_PATHS"] ?? "raw").split(
	",",
) as FixturePath[]
const onlyIds = process.env["WAVEKIT_FIXTURE_IDS"]?.split(",")
const COLLECTOR = "/tmp/wk-collect-outputs.mjs"

function exec(
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
) {
	const r = spawnSync(
		"docker",
		[
			"exec",
			...(options.input !== undefined ? ["-i"] : []),
			container!,
			...args,
		],
		{
			encoding: "utf8",
			timeout: options.timeoutMs ?? 30000,
			maxBuffer: 64 * 1024 * 1024,
			...(options.input !== undefined ? { input: options.input } : {}),
		},
	)
	if (r.error) throw r.error
	return r
}

/** A setup step that must succeed; its stderr explains the failure. */
function execOk(
	what: string,
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
) {
	const r = exec(args, options)
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

function runFixture(f: Fixture, path: FixturePath, index: number): PathResult {
	const tag = `${f.id}-${path}`
	const apiPort = fixtureApiPort(index, path)
	const padded = `/tmp/wk-${tag}.cu8`
	const configPath = `/tmp/wk-${tag}.yaml`
	const logPath = `/tmp/wk-${tag}.log`
	const pidPath = `/tmp/wk-${tag}.pid`
	const seconds = runSeconds(f)
	execOk("config write", ["sh", "-c", `cat > '${configPath}'`], {
		input: buildFixtureConfig({
			fixture: f,
			path,
			apiPort,
			paddedPath: padded,
		}),
	})
	let collected: ReturnType<typeof exec>
	try {
		execOk(
			"pad",
			[
				"sh",
				"-c",
				padCommand(f, `${CONTAINER_FIXTURES_DIR}/${f.file}`, padded),
			],
			{ timeoutMs: 120000 },
		)
		// $! is the `timeout` process (nohup execs it); `timeout` forwards SIGTERM to node, which stops its decoders.
		execOk("app launch", [
			"sh",
			"-c",
			`WAVEKIT_CONFIG='${configPath}' nohup timeout -s TERM ${Math.ceil(seconds + 20)} node /app/dist/index.js > '${logPath}' 2>&1 & echo $! > '${pidPath}'`,
		])
		collected = exec(
			["node", COLLECTOR, String(apiPort), String(seconds), goldenDecoderId(f)],
			{ timeoutMs: (seconds + 30) * 1000 },
		)
	} finally {
		// Runs even when setup or the collector throws, so the padded capture (hundreds of MB) never leaks.
		// No match-by-command-line kill: bookworm-slim has no procps, and the config path is in the env, not on the command line.
		// Stop this instance by pid and wait (bounded, 20 s) for it to exit before the next path starts, so two app
		// instances never overlap (doubled decoders, port collisions, a corrupted Property 15 comparison).
		exec(
			[
				"sh",
				"-c",
				`pid=$(cat '${pidPath}' 2>/dev/null); kill -TERM "$pid" 2>/dev/null; i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done; kill -KILL "$pid" 2>/dev/null; rm -f '${padded}' '${pidPath}'`,
			],
			{ timeoutMs: 30000 },
		)
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
		log: exec(["cat", logPath]).stdout,
		collectorExit: collected.status,
		collectorStderr: collected.stderr,
	}
}

describe.skipIf(!container || !fixturesDir)("IQ fixture goldens", () => {
	const manifest = loadManifest()
	// Negative fixtures are real captures with only channel.center_hz moved out of the capture. options.channelHz is
	// read only by getChannelRequest (Task 23), so on the raw path they decode the real signal. They run on the
	// channelizer path only, and are left out entirely when WAVEKIT_FIXTURE_PATHS has no channelizer (batch 3, Task 8).
	const fixtures = manifest.fixtures.filter(
		f =>
			f.format === "cu8" &&
			(f.role !== "negative" || paths.includes("channelizer")) &&
			(!onlyIds || onlyIds.includes(f.id)) &&
			existsSync(join(resolve(fixturesDir ?? "."), f.file)),
	)
	if (fixtures.length === 0) {
		// An empty or not-yet-downloaded manifest is not a failure: nothing to replay.
		it.skip("no verified cu8 fixture present in WAVEKIT_FIXTURES_DIR", () => {})
		return
	}
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
		(_id, f, index) => {
			const results = new Map<FixturePath, PathResult>()
			for (const path of paths) {
				if (
					path === "channelizer" &&
					f.role !== "channelizer-golden" &&
					f.role !== "negative"
				)
					continue
				if (path === "raw" && f.role === "negative") continue // see the filter above: raw ignores channelHz
				results.set(path, runFixture(f, path, index))
			}
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
			if (raw && chan && f.role === "channelizer-golden") {
				// Feature: core-channelizer, Property 15: Golden equality
				// Validates: addendum §8, §12.15
				expect(keySet(f, chan.observed)).toEqual(keySet(f, raw.observed))
			}
		},
		600000,
	)
})
