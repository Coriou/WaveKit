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
	format: z.enum(["S16LE", "FLOAT32LE", "U8_IQ", "S16_IQ", "auto"]),
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
	monitoring: z.boolean().default(false),
})

/**
 * Schema for tuner relay configuration (RTL-TCP compatible server).
 */
export const TunerRelayConfigSchema = z.object({
	enabled: z.boolean().default(false),
	host: z.string().default("0.0.0.0"),
	port: z.number().int().min(1).max(65535).default(1234),
	/** Source ID to expose (defaults to primary source if omitted) */
	sourceId: z.string().min(1).optional(),
	/** Control policy for client commands */
	controlPolicy: z.enum(["exclusive", "shared"]).default("exclusive"),
	/** Max number of connected clients (optional cap) */
	maxClients: z.number().int().positive().optional(),
	/** Command history entries to retain (0 disables history) */
	commandHistoryLimit: z.number().int().min(0).max(10000).default(200),
})

/**
 * Schema for live demodulation configuration.
 */
export const LiveDemodConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		sourceId: z.string().optional(),
		httpPort: z.number().int().min(1).max(65535).default(8081),
		modulation: z
			.enum(["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"])
			.default("nfm"),
		bandwidth: z.number().int().min(0).default(12500),
		// Squelch threshold in dBFS (negative). 0 disables squelch (open).
		squelch: z.number().min(-160).max(0).default(0),
		noiseReduction: z
			.enum(["off", "voice", "noaa-apt", "narrow-band"])
			.default("off"),
		lowPass: z.number().int().min(0).max(20000).default(0),
		highPass: z.number().int().min(0).max(5000).default(0),
		gain: z.number().min(0.1).max(100).default(10.0),
		deEmphasis: z.boolean().default(false),
		deEmphasisTau: z.union([z.literal(50), z.literal(75)]).default(50),
		audioFormat: z.enum(["s16le", "f32le"]).default("s16le"),
		iqDcBlock: z.boolean().default(true),
	})
	.superRefine((value, ctx) => {
		if (value.modulation !== "raw" && value.bandwidth <= 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "bandwidth must be greater than 0 for non-raw modulation",
				path: ["bandwidth"],
			})
		}
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
	/** Milliseconds without output before a decoder is considered idle (default: 30000ms) */
	idleTimeout: z.number().int().positive().default(30000),
})

/**
 * Main configuration schema for WaveKit.
 * Requirements: 12.5, 15.4, 17.1, 17.2, 17.3, 17.4
 */
export const ConfigSchema = z.object({
	sources: z.array(SourceConfigSchema).default([]),
	decoders: z.array(DecoderConfigSchema).default([]),
	audio: AudioConfigSchema.default({}),
	tunerRelay: TunerRelayConfigSchema.default({}),
	liveDemod: LiveDemodConfigSchema.optional(),
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
export type TunerRelayConfig = z.infer<typeof TunerRelayConfigSchema>
export type LiveDemodConfig = z.infer<typeof LiveDemodConfigSchema>
export type ApiConfig = z.infer<typeof ApiConfigSchema>
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>
export type HealthConfig = z.infer<typeof HealthConfigSchema>
export type Config = z.infer<typeof ConfigSchema>

// ============================================================================
// Environment Variable Mapping
// ============================================================================

/**
 * Prefix for all WaveKit environment variables.
 * Requirements: 5.1
 */
const ENV_PREFIX = "WAVEKIT_"

/**
 * Separator for nested keys in environment variables.
 * Example: WAVEKIT_API__PORT maps to config.api.port
 * Requirements: 5.1
 */
const NESTED_KEY_SEPARATOR = "__"

/**
 * Legacy environment variable mappings for backward compatibility.
 * These use single underscore format (e.g., WAVEKIT_API_PORT).
 * Format: ENV_VAR_NAME -> config.path.to.value
 */
const LEGACY_ENV_MAPPINGS: Record<
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
 * Attempts to infer the type from the value if not explicitly specified.
 */
function parseEnvValue(
	value: string,
	type?: "string" | "number" | "boolean",
): unknown {
	// If type is explicitly specified, use it
	if (type) {
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

	// Auto-detect type from value
	// Check for boolean
	if (value.toLowerCase() === "true" || value.toLowerCase() === "false") {
		return value.toLowerCase() === "true"
	}

	// Check for number (integer or float)
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		const num = Number(value)
		if (!Number.isNaN(num)) {
			return num
		}
	}

	// Default to string
	return value
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
 * Converts an environment variable name to a config path.
 * Uses double underscore (__) as separator for nested keys.
 *
 * Examples:
 *   WAVEKIT_API__PORT -> ["api", "port"]
 *   WAVEKIT_SOURCES__RTL_TCP__HOST -> ["sources", "rtlTcp", "host"]
 *   WAVEKIT_DECODERS__DSD_FME__ENABLED -> ["decoders", "dsdFme", "enabled"]
 *
 * Requirements: 5.1
 */
function envVarToConfigPath(envVar: string): string[] {
	// Remove the WAVEKIT_ prefix
	const withoutPrefix = envVar.slice(ENV_PREFIX.length)

	// Split by double underscore for nested keys
	const parts = withoutPrefix.split(NESTED_KEY_SEPARATOR)

	// Convert each part from SCREAMING_SNAKE_CASE to camelCase
	return parts.map(part => {
		// Split by single underscore and convert to camelCase
		const words = part.toLowerCase().split("_")
		return words
			.map((word, index) =>
				index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
			)
			.join("")
	})
}

/**
 * Parses all WAVEKIT_* environment variables and returns them as a config object.
 * Supports nested keys using double underscore separator.
 *
 * Requirements: 5.1
 */
export function parseEnvironmentVariables(): Record<string, unknown> {
	const result: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith(ENV_PREFIX) && value !== undefined && value !== "") {
			// Check if this is a legacy mapping first
			const legacyMapping = LEGACY_ENV_MAPPINGS[key]
			if (legacyMapping) {
				try {
					const parsedValue = parseEnvValue(value, legacyMapping.type)
					setNestedValue(result, legacyMapping.path, parsedValue)
				} catch {
					// Skip invalid env values - validation will catch them later
				}
			} else if (key.includes(NESTED_KEY_SEPARATOR)) {
				// Use new double-underscore format for nested keys
				try {
					const path = envVarToConfigPath(key)
					const parsedValue = parseEnvValue(value)
					setNestedValue(result, path, parsedValue)
				} catch {
					// Skip invalid env values - validation will catch them later
				}
			}
		}
	}

	return result
}

/**
 * Applies environment variable overrides to the configuration object.
 * Environment variables take precedence over config file values.
 *
 * Requirements: 5.1, 5.3
 */
function applyEnvironmentOverrides(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const result = structuredClone(config)
	const envConfig = parseEnvironmentVariables()

	// Deep merge environment config into result
	deepMerge(result, envConfig)

	return result
}

/**
 * Deep merges source object into target object.
 * Source values override target values.
 */
function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): void {
	for (const [key, sourceValue] of Object.entries(source)) {
		const targetValue = target[key]

		if (
			sourceValue !== null &&
			typeof sourceValue === "object" &&
			!Array.isArray(sourceValue) &&
			targetValue !== null &&
			typeof targetValue === "object" &&
			!Array.isArray(targetValue)
		) {
			// Both are objects, merge recursively
			deepMerge(
				targetValue as Record<string, unknown>,
				sourceValue as Record<string, unknown>,
			)
		} else {
			// Override with source value
			target[key] = sourceValue
		}
	}
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Default configuration paths.
 * In Docker, configs are mounted at /app/config.
 * For local development, use config/ directory.
 */
const CONFIG_PATHS = {
	/** Docker container config directory */
	dockerDir: "/app/config",
	/** Local development config directory */
	localDir: "config",
	/** Default config filename */
	defaultFile: "default.yaml",
	/** Custom config filename (merged on top of default) */
	customFile: "custom.yaml",
}

/**
 * Loads a YAML configuration file if it exists.
 * Returns an empty object if the file doesn't exist.
 *
 * @param filePath - Path to the YAML file
 * @returns Parsed configuration object or empty object
 * @throws ConfigValidationError if YAML parsing fails
 */
function loadYamlFile(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) {
		return {}
	}

	try {
		const fileContent = readFileSync(filePath, "utf-8")
		const parsed = parseYaml(fileContent) as unknown
		if (parsed !== null && typeof parsed === "object") {
			return parsed as Record<string, unknown>
		}
		return {}
	} catch (error) {
		throw new ConfigValidationError(
			z.ZodError.create([
				{
					code: z.ZodIssueCode.custom,
					path: [],
					message: `Failed to parse YAML file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				},
			]),
		)
	}
}

/**
 * Determines the config directory to use.
 * Prefers Docker path (/app/config) if it exists, otherwise uses local path.
 *
 * Requirements: 5.2
 */
function getConfigDirectory(): string {
	if (existsSync(CONFIG_PATHS.dockerDir)) {
		return CONFIG_PATHS.dockerDir
	}
	return CONFIG_PATHS.localDir
}

/**
 * Loads configuration from multiple YAML files with merging.
 * Files are loaded in order: default.yaml, then custom.yaml (if exists).
 * Later files override earlier ones.
 *
 * Requirements: 5.2
 *
 * @param configDir - Directory containing config files
 * @returns Merged configuration object
 */
function loadConfigFiles(configDir: string): Record<string, unknown> {
	const defaultPath = `${configDir}/${CONFIG_PATHS.defaultFile}`
	const customPath = `${configDir}/${CONFIG_PATHS.customFile}`

	// Load default config as base
	const defaultConfig = loadYamlFile(defaultPath)

	// Load custom config if it exists
	const customConfig = loadYamlFile(customPath)

	// Merge custom on top of default
	const merged = structuredClone(defaultConfig)
	deepMerge(merged, customConfig)

	return merged
}

/**
 * Loads and validates configuration from YAML files with environment variable overrides.
 *
 * Configuration loading order (later sources override earlier):
 * 1. default.yaml from config directory
 * 2. custom.yaml from config directory (if exists)
 * 3. Environment variables (WAVEKIT_* prefix)
 *
 * Requirements:
 * - 5.1: Support configuration via environment variables with WAVEKIT_ prefix
 * - 5.2: Support configuration via mounted YAML files at /app/config
 * - 5.3: Environment variables take precedence over config files
 * - 5.4: Validate configuration on startup and fail fast with clear error messages
 * - 12.1: Load configuration from default YAML file
 * - 12.2: Override config values with environment variables
 * - 12.3: Validate configuration against Zod schema
 * - 12.4: Return descriptive validation errors
 * - 12.5: Support configuration for sources, decoders, audio output, API server, and logging
 *
 * @param configPath - Optional path to a specific configuration file (for testing/backward compatibility)
 * @returns Validated configuration object
 * @throws ConfigValidationError if configuration is invalid
 */
export function loadConfig(configPath?: string): Config {
	let rawConfig: Record<string, unknown>

	if (configPath) {
		// Legacy mode: load from specific file path
		rawConfig = loadYamlFile(configPath)
	} else {
		// New mode: load from config directory with merging
		const configDir = getConfigDirectory()
		rawConfig = loadConfigFiles(configDir)
	}

	// Apply environment variable overrides (Requirements: 5.1, 5.3)
	const configWithOverrides = applyEnvironmentOverrides(rawConfig)

	// Validate against schema (Requirements: 5.4, 12.3)
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

/**
 * Validates configuration and returns detailed validation results.
 * Useful for providing user feedback without throwing.
 *
 * Requirements: 5.4
 *
 * @param config - Configuration object to validate
 * @returns Object with success status and either data or formatted errors
 */
export function validateConfigSafe(config: unknown): {
	success: boolean
	data?: Config
	errors?: string[]
} {
	const result = ConfigSchema.safeParse(config)

	if (result.success) {
		return { success: true, data: result.data }
	}

	const errors = result.error.issues.map(issue => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "root"
		return `${path}: ${issue.message}`
	})

	return { success: false, errors }
}

/**
 * Gets the list of supported environment variables for configuration.
 * Useful for documentation and help messages.
 *
 * Requirements: 5.1
 */
export function getSupportedEnvVars(): string[] {
	const legacyVars = Object.keys(LEGACY_ENV_MAPPINGS)
	const nestedExamples = [
		"WAVEKIT_API__HOST",
		"WAVEKIT_API__PORT",
		"WAVEKIT_AUDIO__TCP_PORT",
		"WAVEKIT_AUDIO__FORMAT",
		"WAVEKIT_AUDIO__SAMPLE_RATE",
		"WAVEKIT_TUNER_RELAY__ENABLED",
		"WAVEKIT_TUNER_RELAY__HOST",
		"WAVEKIT_TUNER_RELAY__PORT",
		"WAVEKIT_TUNER_RELAY__SOURCE_ID",
		"WAVEKIT_TUNER_RELAY__CONTROL_POLICY",
		"WAVEKIT_TUNER_RELAY__MAX_CLIENTS",
		"WAVEKIT_TUNER_RELAY__COMMAND_HISTORY_LIMIT",
		"WAVEKIT_LOGGING__LEVEL",
		"WAVEKIT_LOGGING__DIR",
		"WAVEKIT_SOURCES__<ID>__HOST",
		"WAVEKIT_SOURCES__<ID>__PORT",
		"WAVEKIT_DECODERS__<ID>__ENABLED",
	]
	return [...legacyVars, ...nestedExamples]
}
