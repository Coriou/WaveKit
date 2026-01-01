import { readFileSync, existsSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { ConfigValidationError } from "./utils/errors.js"

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for source capabilities (Requirements 15.4, 16.1).
 * Declares what kind of data a source provides.
 */
export const SourceCapsSchema = z.object({
	kind: z.enum(["audio_pcm", "iq", "recording"]),
	sampleRate: z.number().int().positive(),
	format: z.enum(["S16LE", "FLOAT32LE", "U8_IQ", "S16_IQ"]),
	channels: z.number().int().positive().optional(),
	centerFreq: z.number().positive().optional(),
	exclusive: z.boolean().default(false),
})

/**
 * Schema for SDR source configuration.
 * Supports rtl_tcp, SDR++ network sink, and recording sources.
 */
export const SourceConfigSchema = z.object({
	id: z.string().min(1),
	type: z.enum(["sdrpp-network", "rtl_tcp", "recording"]),
	host: z.string().min(1).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	filePath: z.string().optional(), // For recording sources
	loop: z.boolean().default(false), // For recording sources
	playbackSpeed: z.number().positive().default(1.0), // For recording sources
	caps: SourceCapsSchema,
})

/**
 * Schema for decoder capabilities (Requirements 17.1, 17.2, 17.3, 17.4).
 * Declares what input/output a decoder supports and its integration pattern.
 */
export const DecoderCapsSchema = z.object({
	/** Input type the decoder accepts */
	input: z.enum(["audio_pcm", "iq", "external"]),
	/** Whether the decoder requires exclusive access to its source */
	wantsExclusiveSource: z.boolean().optional(),
	/** Preferred sample rates for this decoder */
	preferredSampleRates: z.array(z.number().int().positive()).optional(),
	/** Output format produced by the decoder */
	output: z.enum(["jsonl", "nmea", "beast", "text"]),
	/** Integration pattern for this decoder */
	integrationPattern: z.enum([
		"pure_consumer",
		"network_producer",
		"external_sdr",
	]),
})

/**
 * Schema for decoder configuration.
 * Each decoder has a type that maps to a registered factory.
 * Supports all three integration patterns: pure_consumer, network_producer, external_sdr.
 * Requirements: 17.1, 17.2, 17.3, 17.4
 */
export const DecoderConfigSchema = z.object({
	id: z.string().min(1),
	type: z.string().min(1),
	enabled: z.boolean(),
	/** Which source to attach to (for pure_consumer decoders) */
	sourceId: z.string().min(1).optional(),
	options: z.record(z.unknown()),
	// For external SDR decoders (external_sdr pattern)
	/** Device serial number for external SDR decoders */
	deviceSerial: z.string().optional(),
	/** Frequencies to monitor (Hz) for external SDR decoders */
	frequencies: z.array(z.number().positive()).optional(),
	/** Gain setting for external SDR decoders */
	gain: z.number().optional(),
	/** PPM correction for external SDR decoders */
	ppm: z.number().optional(),
	// For network producer decoders (network_producer pattern)
	/** Host to connect to for network producer output */
	outputHost: z.string().optional(),
	/** Port to connect to for network producer output */
	outputPort: z.number().int().min(1).max(65535).optional(),
	/** Protocol for network producer output */
	outputProtocol: z.enum(["tcp", "udp"]).optional(),
	// Version pinning (Requirement 27.1, 27.2, 27.3)
	/** Minimum required version for this decoder */
	minVersion: z.string().optional(),
	/** Maximum allowed version for this decoder */
	maxVersion: z.string().optional(),
})

/**
 * Schema for audio output configuration.
 */
export const AudioConfigSchema = z.object({
	tcpPort: z.number().int().min(1).max(65535).default(8080),
	format: z.enum(["S16LE", "FLOAT32LE"]).default("S16LE"),
	sampleRate: z.number().int().positive().default(48000),
})

/**
 * Schema for API server configuration.
 */
export const ApiConfigSchema = z.object({
	host: z.string().default("0.0.0.0"),
	port: z.number().int().min(1).max(65535).default(3000),
})

/**
 * Schema for logging configuration.
 */
export const LoggingConfigSchema = z.object({
	level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
	dir: z.string().optional(),
})

/**
 * Schema for health monitoring configuration (Requirements 20.1, 20.2, 20.3, 20.4).
 * Configures how decoder health is monitored and when state transitions occur.
 */
export const HealthConfigSchema = z.object({
	/** Interval in milliseconds between health checks (default: 5000ms) */
	checkInterval: z.number().int().positive().default(5000),
	/** Milliseconds without output before a decoder is considered degraded (default: 30000ms) */
	degradedTimeout: z.number().int().positive().default(30000),
})

/**
 * Main configuration schema for WaveKit.
 * Requirements: 12.5, 15.4, 17.1, 17.2, 17.3, 17.4
 */
export const ConfigSchema = z.object({
	sources: z.array(SourceConfigSchema).default([]),
	decoders: z.array(DecoderConfigSchema).default([]),
	audio: AudioConfigSchema.default({}),
	api: ApiConfigSchema.default({}),
	logging: LoggingConfigSchema.default({}),
	health: HealthConfigSchema.optional(),
})

// ============================================================================
// Type Exports
// ============================================================================

export type SourceCaps = z.infer<typeof SourceCapsSchema>
export type SourceConfig = z.infer<typeof SourceConfigSchema>
export type DecoderCaps = z.infer<typeof DecoderCapsSchema>
export type DecoderConfig = z.infer<typeof DecoderConfigSchema>
export type AudioConfig = z.infer<typeof AudioConfigSchema>
export type ApiConfig = z.infer<typeof ApiConfigSchema>
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>
export type HealthConfig = z.infer<typeof HealthConfigSchema>
export type Config = z.infer<typeof ConfigSchema>

// ============================================================================
// Environment Variable Mapping
// ============================================================================

/**
 * Maps environment variables to configuration paths.
 * Format: ENV_VAR_NAME -> config.path.to.value
 */
const ENV_MAPPINGS: Record<
	string,
	{ path: string[]; type: "string" | "number" | "boolean" }
> = {
	WAVEKIT_API_HOST: { path: ["api", "host"], type: "string" },
	WAVEKIT_API_PORT: { path: ["api", "port"], type: "number" },
	WAVEKIT_AUDIO_TCP_PORT: { path: ["audio", "tcpPort"], type: "number" },
	WAVEKIT_AUDIO_FORMAT: { path: ["audio", "format"], type: "string" },
	WAVEKIT_AUDIO_SAMPLE_RATE: { path: ["audio", "sampleRate"], type: "number" },
	WAVEKIT_LOG_LEVEL: { path: ["logging", "level"], type: "string" },
	WAVEKIT_LOG_DIR: { path: ["logging", "dir"], type: "string" },
}

/**
 * Parses an environment variable value to the appropriate type.
 */
function parseEnvValue(
	value: string,
	type: "string" | "number" | "boolean",
): unknown {
	switch (type) {
		case "number": {
			const num = Number(value)
			if (Number.isNaN(num)) {
				throw new Error(`Invalid number value: ${value}`)
			}
			return num
		}
		case "boolean":
			return value.toLowerCase() === "true" || value === "1"
		case "string":
		default:
			return value
	}
}

/**
 * Sets a nested value in an object using a path array.
 */
function setNestedValue(
	obj: Record<string, unknown>,
	path: string[],
	value: unknown,
): void {
	let current = obj
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i]
		if (key === undefined) continue
		if (
			!(key in current) ||
			typeof current[key] !== "object" ||
			current[key] === null
		) {
			current[key] = {}
		}
		current = current[key] as Record<string, unknown>
	}
	const lastKey = path[path.length - 1]
	if (lastKey !== undefined) {
		current[lastKey] = value
	}
}

/**
 * Applies environment variable overrides to the configuration object.
 * Requirements: 12.2
 */
function applyEnvironmentOverrides(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const result = structuredClone(config)

	for (const [envVar, mapping] of Object.entries(ENV_MAPPINGS)) {
		const envValue = process.env[envVar]
		if (envValue !== undefined && envValue !== "") {
			try {
				const parsedValue = parseEnvValue(envValue, mapping.type)
				setNestedValue(result, mapping.path, parsedValue)
			} catch {
				// Skip invalid env values - validation will catch them later
			}
		}
	}

	return result
}

// ============================================================================
// Configuration Loading
// ============================================================================

const DEFAULT_CONFIG_PATH = "config/default.yaml"

/**
 * Loads and validates configuration from a YAML file with environment variable overrides.
 *
 * Requirements:
 * - 12.1: Load configuration from default YAML file
 * - 12.2: Override config values with environment variables
 * - 12.3: Validate configuration against Zod schema
 * - 12.4: Return descriptive validation errors
 * - 12.5: Support configuration for sources, decoders, audio output, API server, and logging
 *
 * @param configPath - Optional path to the configuration file. Defaults to config/default.yaml
 * @returns Validated configuration object
 * @throws ConfigValidationError if configuration is invalid
 */
export function loadConfig(configPath?: string): Config {
	const filePath = configPath ?? DEFAULT_CONFIG_PATH

	// Load YAML file if it exists
	let rawConfig: Record<string, unknown> = {}
	if (existsSync(filePath)) {
		try {
			const fileContent = readFileSync(filePath, "utf-8")
			const parsed = parseYaml(fileContent) as unknown
			if (parsed !== null && typeof parsed === "object") {
				rawConfig = parsed as Record<string, unknown>
			}
		} catch (error) {
			throw new ConfigValidationError(
				z.ZodError.create([
					{
						code: z.ZodIssueCode.custom,
						path: [],
						message: `Failed to parse YAML file: ${error instanceof Error ? error.message : String(error)}`,
					},
				]),
			)
		}
	}

	// Apply environment variable overrides
	const configWithOverrides = applyEnvironmentOverrides(rawConfig)

	// Validate against schema
	const result = ConfigSchema.safeParse(configWithOverrides)

	if (!result.success) {
		throw new ConfigValidationError(result.error)
	}

	return result.data
}

/**
 * Validates a partial configuration object.
 * Useful for validating individual config sections.
 */
export function validateConfig(config: unknown): Config {
	const result = ConfigSchema.safeParse(config)
	if (!result.success) {
		throw new ConfigValidationError(result.error)
	}
	return result.data
}
