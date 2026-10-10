import { stringify } from "yaml"
import type { Fixture } from "./manifest.js"

export type FixturePath = "raw" | "channelizer"
export const LEAD_SECONDS = 5
export const TAIL_SECONDS = 3
export const CONTAINER_FIXTURES_DIR = "/fixtures"
const UNCOUNTED_TYPES = new Set(["stats", "error", "sync"])

export interface ObservedOutput {
	type: string
	data: Record<string, unknown>
}

/**
 * Stride 8 per fixture, channelizer path at +4: each instance uses api, audio
 * (+1) and digital voice (+2), so the two paths never overlap (delta E2).
 */
export function fixtureApiPort(index: number, path: FixturePath): number {
	return 19100 + index * 8 + (path === "raw" ? 0 : 4)
}

export function goldenDecoderId(f: Fixture): string {
	return `golden-${f.id}`.slice(0, 60)
}

/**
 * One recording source + one decoder; `channelizer.enabled` and the
 * decoder's `useChannelizer` select the path. Ports derive from
 * apiPort: audio +1, digital voice +2. Band suspension is off so a capture
 * tuned off its band still records what the decoder hears (delta E1).
 */
export function buildFixtureConfig(input: {
	fixture: Fixture
	path: FixturePath
	apiPort: number
	paddedPath: string
}): string {
	const { fixture: f, path, apiPort, paddedPath } = input
	const channelised = path === "channelizer"
	return stringify({
		sources: [
			{
				id: "fixture",
				type: "recording",
				filePath: paddedPath,
				loop: false,
				playbackSpeed: f.playback_speed,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: f.sample_rate,
					...(f.center_hz !== undefined ? { centerFreq: f.center_hz } : {}),
					exclusive: false,
				},
			},
		],
		decoders: [
			{
				id: goldenDecoderId(f),
				type: f.decoder,
				enabled: true,
				sourceId: "fixture",
				useChannelizer: channelised,
				options: {
					...f.decoder_options,
					...(f.channel ? { channelHz: f.channel.center_hz } : {}),
				},
			},
		],
		api: { host: "127.0.0.1", port: apiPort },
		audio: { tcpPort: apiPort + 1, monitoring: false },
		tunerRelay: { enabled: false },
		liveDemod: { enabled: false },
		digitalVoice: { enabled: true, httpPort: apiPort + 2 },
		health: { bandSuspension: false },
		stateDir: `/tmp/wk-state-${apiPort}`,
		logging: { level: "info" },
		channelizer: { enabled: channelised },
	})
}

const PATHS: readonly FixturePath[] = ["raw", "channelizer"]

/**
 * The paths a fixture runs on: negatives only on the channelizer path (the raw path ignores channelHz and would
 * decode the real signal), the channelizer path only for channelizer goldens and negatives.
 */
export function fixturePaths(f: Fixture, paths: FixturePath[]): FixturePath[] {
	return paths.filter(p =>
		p === "raw"
			? f.role !== "negative"
			: f.role === "channelizer-golden" || f.role === "negative",
	)
}

export interface FixtureSelection {
	paths: FixturePath[]
	fixtures: Fixture[]
	/** Private fixtures absent here (no private access); listed, never silently dropped. */
	skippedPrivate: string[]
}

/**
 * The gate's selection (final review infra I1): a run that would compare nothing throws instead of passing.
 * WAVEKIT_FIXTURE_PATHS must be distinct entries of raw/channelizer; every WAVEKIT_FIXTURE_IDS entry must name a cu8
 * fixture that is present and that a selected path runs; without ids an absent public or generated fixture (a
 * failed download or sha mismatch) throws, and an empty selection throws.
 */
export function selectFixtures(input: {
	fixtures: Fixture[]
	pathsEnv: string | undefined
	idsEnv: string | undefined
	exists: (file: string) => boolean
}): FixtureSelection {
	const rawPaths = (input.pathsEnv ?? "raw").split(",").map(p => p.trim())
	if (
		rawPaths.some(p => !(PATHS as readonly string[]).includes(p)) ||
		new Set(rawPaths).size !== rawPaths.length
	)
		throw new Error(
			`WAVEKIT_FIXTURE_PATHS=${JSON.stringify(input.pathsEnv)}: expected distinct entries of ${PATHS.join(", ")}`,
		)
	const paths = rawPaths as FixturePath[]
	const byId = new Map(input.fixtures.map(f => [f.id, f]))
	const runnable = (f: Fixture) =>
		f.format === "cu8" && fixturePaths(f, paths).length > 0
	const absent = (f: Fixture) =>
		new Error(
			`fixture ${f.id}: ${f.file} absent; run fixtures/download.sh (a sha mismatch deletes the output)`,
		)
	if (input.idsEnv !== undefined) {
		const ids = input.idsEnv.split(",").map(id => id.trim())
		if (ids.some(id => id === ""))
			throw new Error(
				`WAVEKIT_FIXTURE_IDS=${JSON.stringify(input.idsEnv)}: empty entry`,
			)
		const fixtures = ids.map(id => {
			const f = byId.get(id)
			if (!f) throw new Error(`unknown fixture id ${id} in WAVEKIT_FIXTURE_IDS`)
			if (f.format !== "cu8")
				throw new Error(`fixture ${id} is ${f.format}; the gate replays cu8`)
			if (!runnable(f))
				throw new Error(
					`fixture ${id} (${f.role}) runs on no selected path (${paths.join(",")})`,
				)
			if (!input.exists(f.file)) throw absent(f)
			return f
		})
		return { paths, fixtures, skippedPrivate: [] }
	}
	const fixtures: Fixture[] = []
	const skippedPrivate: string[] = []
	for (const f of input.fixtures) {
		if (!runnable(f)) continue
		if (input.exists(f.file)) fixtures.push(f)
		else if (f.fetch.kind === "private") skippedPrivate.push(f.id)
		else throw absent(f)
	}
	if (fixtures.length === 0)
		throw new Error(
			`no fixture to replay on ${paths.join(",")} (private fixtures absent: ${skippedPrivate.join(", ") || "none"})`,
		)
	return { paths, fixtures, skippedPrivate }
}

export function padCommand(
	f: Fixture,
	sourcePath: string,
	paddedPath: string,
): string {
	const bytesPerSecond = f.sample_rate * 2
	const pad = (seconds: number) =>
		`head -c ${seconds * bytesPerSecond} /dev/zero | tr '\\000' '\\177'`
	return `{ ${pad(LEAD_SECONDS)}; cat '${sourcePath}'; ${pad(TAIL_SECONDS)}; } > '${paddedPath}'`
}

/** Printed by stopCommand when the KILL fallback fires; the harness surfaces it. */
export const KILL_FALLBACK_MARK = "KILL fallback"

/**
 * Stops one app instance by pid and waits (bounded, 20 s) for it to exit, so two instances never overlap. The pid
 * is GNU `timeout`, which leads its own process group: the KILL fallback signals the whole group so node cannot
 * survive `timeout` and keep its decoders bound to fixed ports (final review infra M3).
 */
export function stopCommand(pidPath: string, paddedPath: string): string {
	return [
		`pid=$(cat '${pidPath}' 2>/dev/null)`,
		`kill -TERM "$pid" 2>/dev/null`,
		`i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done`,
		`if kill -0 "$pid" 2>/dev/null; then echo "${KILL_FALLBACK_MARK}: app group $pid still running after 20 s" >&2; kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; fi`,
		`rm -f '${paddedPath}' '${pidPath}'`,
	].join("; ")
}

/** Whole seconds: spawnSync rejects a fractional timeout (sigid_pocsag, 16.364 s). */
export function runSeconds(f: Fixture): number {
	return Math.ceil(
		LEAD_SECONDS + f.duration_s / f.playback_speed + TAIL_SECONDS + 10,
	)
}

export function isSubset(expected: unknown, actual: unknown): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			expected.length === actual.length &&
			expected.every((e, i) => isSubset(e, actual[i]))
		)
	}
	if (expected !== null && typeof expected === "object") {
		if (actual === null || typeof actual !== "object" || Array.isArray(actual))
			return false
		const a = actual as Record<string, unknown>
		return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
			isSubset(v, a[k]),
		)
	}
	return Object.is(expected, actual)
}

function counted(f: Fixture, observed: ObservedOutput[]): ObservedOutput[] {
	const types = f.expected.output_types
	return observed.filter(o =>
		types ? types.includes(o.type) : !UNCOUNTED_TYPES.has(o.type),
	)
}

export function matchExpected(
	f: Fixture,
	observed: ObservedOutput[],
): { ok: boolean; count: number; missing: Record<string, unknown>[] } {
	const outputs = counted(f, observed)
	const missing = f.expected.payloads.filter(
		p => !outputs.some(o => isSubset(p, o.data)),
	)
	return {
		ok: missing.length === 0 && outputs.length >= f.expected.min_count,
		count: outputs.length,
		missing,
	}
}

export function keySet(f: Fixture, observed: ObservedOutput[]): string[] {
	const fields = f.expected.key_fields ?? []
	const keys = new Set(
		counted(f, observed).map(o =>
			JSON.stringify(fields.map(k => o.data[k] ?? null)),
		),
	)
	return [...keys].sort()
}
