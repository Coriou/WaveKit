import { z } from "zod"

/**
 * Configuration schema for wavekit-sdr-host.
 *
 * Environment variables use SDR_HOST_ prefix with double underscore nesting:
 *   SDR_HOST_RTL_TCP__SAMPLE_RATE=2048000
 *   SDR_HOST_RTLMUX__PORT=5555
 *   SDR_HOST_API__PORT=8080
 */
export const SdrHostConfigSchema = z.object({
	rtlTcp: z
		.object({
			/** Port for internal rtl_tcp (not exposed to LAN) */
			internalPort: z.number().int().min(1).max(65535).default(1234),
			/** Sample rate in Hz (2.048 Msps recommended, NOT 2.4 Msps) */
			sampleRate: z.number().int().positive().default(2048000),
			/** Enable tuner AGC */
			agc: z.boolean().default(false),
			/** Manual gain in dB (used when AGC is false) */
			gain: z.number().min(0).max(100).default(49),
			/** PPM frequency correction */
			ppm: z.number().int().min(-200).max(200).default(0),
			/** RTL-SDR device index (0 for first dongle) */
			deviceIndex: z.number().int().min(0).default(0),
		})
		.default({}),

	rtlmux: z
		.object({
			/** TCP port for IQ stream clients (WaveKit connects here) */
			port: z.number().int().min(1).max(65535).default(5555),
		})
		.default({}),

	api: z
		.object({
			/** API server bind address */
			host: z.string().default("0.0.0.0"),
			/** API server port */
			port: z.number().int().min(1).max(65535).default(8080),
		})
		.default({}),

	logging: z
		.object({
			level: z
				.enum(["trace", "debug", "info", "warn", "error"])
				.default("info"),
			/** Enable pretty printing (disable in production) */
			pretty: z.boolean().default(false),
		})
		.default({}),
})

export type SdrHostConfig = z.infer<typeof SdrHostConfigSchema>

/**
 * Environment variable prefix for SDR Host configuration.
 */
export const ENV_PREFIX = "SDR_HOST_"

/**
 * Parses environment variables into a partial config object.
 * Uses double underscore (__) as separator for nested keys.
 *
 * Examples:
 *   SDR_HOST_RTL_TCP__SAMPLE_RATE=2048000 -> { rtlTcp: { sampleRate: 2048000 } }
 *   SDR_HOST_RTLMUX__PORT=5555 -> { rtlmux: { port: 5555 } }
 */
export function parseEnvironmentVariables(): Record<string, unknown> {
	const result: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith(ENV_PREFIX) || value === undefined) {
			continue
		}

		// Remove prefix and convert to config path
		const configKey = key.slice(ENV_PREFIX.length)
		const parts = configKey.split("__").map(part =>
			part
				.toLowerCase()
				.split("_")
				.map((word, i) =>
					i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
				)
				.join(""),
		)

		// Parse value
		const parsedValue = parseEnvValue(value)

		// Set nested value
		setNestedValue(result, parts, parsedValue)
	}

	return result
}

/**
 * Parses an environment variable value to the appropriate type.
 */
function parseEnvValue(value: string): unknown {
	// Boolean
	if (value.toLowerCase() === "true") return true
	if (value.toLowerCase() === "false") return false

	// Number
	const num = Number(value)
	if (!isNaN(num) && value.trim() !== "") return num

	// String
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

		if (!(key in current) || typeof current[key] !== "object") {
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
 * Loads and validates configuration from environment variables.
 */
export function loadConfig(): SdrHostConfig {
	const envConfig = parseEnvironmentVariables()
	return SdrHostConfigSchema.parse(envConfig)
}
