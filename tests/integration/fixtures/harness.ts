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
 * One recording source + one decoder. Unknown keys (channelizer,
 * useChannelizer) are stripped by Zod before batch 4. Ports derive from
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

export function runSeconds(f: Fixture): number {
	return LEAD_SECONDS + f.duration_s / f.playback_speed + TAIL_SECONDS + 10
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
