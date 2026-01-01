/**
 * Logger - Pino-based structured logging
 *
 * Requirements:
 * - 6.1: Output structured JSON logs to stdout
 * - 6.2: Support configurable log levels (debug, info, warn, error)
 * - 6.3: Include correlation IDs in logs for request tracing
 * - 9.6: Mask secrets in logs (_SECRET, _PASSWORD, _KEY, _TOKEN env vars)
 * - 13.1: Output logs in JSON format using Pino
 * - 13.2: Support log levels: trace, debug, info, warn, error
 * - 13.3: Include timestamps, log level, and component name in each log entry
 * - 13.4: When configured, write logs to the specified directory
 */

import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error"

export interface LoggerConfig {
	level: LogLevel
	dir?: string
}

export type Logger = PinoLogger

/**
 * Patterns for identifying sensitive environment variable names.
 * Values matching these patterns will be masked in logs.
 * Requirements: 9.6
 */
const SENSITIVE_PATTERNS = [/_SECRET$/i, /_PASSWORD$/i, /_KEY$/i, /_TOKEN$/i]

/**
 * Mask value used to replace sensitive data in logs.
 */
const MASK_VALUE = "***REDACTED***"

/**
 * Checks if an environment variable name matches sensitive patterns.
 * Requirements: 9.6
 *
 * @param name - Environment variable name to check
 * @returns true if the name matches a sensitive pattern
 */
export function isSensitiveEnvVar(name: string): boolean {
	return SENSITIVE_PATTERNS.some(pattern => pattern.test(name))
}

/**
 * Gets a map of sensitive environment variable names for redaction.
 * Requirements: 9.6
 *
 * @returns Set of environment variable names that should be masked
 */
export function getSensitiveEnvVarNames(): Set<string> {
	const sensitiveNames = new Set<string>()
	for (const name of Object.keys(process.env)) {
		if (isSensitiveEnvVar(name)) {
			sensitiveNames.add(name)
		}
	}
	return sensitiveNames
}

/**
 * Creates redaction paths for Pino based on sensitive environment variables.
 * This ensures that any log entry containing these values will have them masked.
 * Requirements: 9.6
 *
 * @returns Array of paths to redact in log entries
 */
function createRedactionPaths(): string[] {
	const sensitiveNames = getSensitiveEnvVarNames()
	const paths: string[] = []

	// Add common paths where secrets might appear
	for (const name of sensitiveNames) {
		// Redact if the env var name appears as a key anywhere in the log
		paths.push(name)
		paths.push(`*.${name}`)
		paths.push(`env.${name}`)
		paths.push(`config.${name}`)
	}

	// Also redact common secret field names regardless of env vars
	const commonSecretFields = [
		"password",
		"secret",
		"token",
		"apiKey",
		"api_key",
		"apikey",
		"auth",
		"authorization",
		"credentials",
		"privateKey",
		"private_key",
	]

	for (const field of commonSecretFields) {
		paths.push(field)
		paths.push(`*.${field}`)
	}

	return paths
}

/**
 * Creates the main application logger with JSON output format.
 * Supports configurable log levels, optional file output, and secret masking.
 *
 * Requirements:
 * - 6.1: Output structured JSON logs to stdout
 * - 9.6: Mask secrets in logs
 * - 13.1: Output logs in JSON format using Pino
 * - 13.3: Include timestamps, log level, and component name in each log entry
 * - 13.4: When configured, write logs to the specified directory
 *
 * @param config - Logger configuration with level and optional directory
 * @returns Configured Pino logger instance
 */
export function createLogger(config: LoggerConfig): Logger {
	const redactionPaths = createRedactionPaths()

	const options: LoggerOptions = {
		level: config.level,
		// Ensure timestamp is included in every log entry (Requirement 13.3, 6.1)
		timestamp: pino.stdTimeFunctions.isoTime,
		// Remove default pid/hostname, we'll add component via child loggers
		base: null,
		// Configure redaction for sensitive values (Requirement 9.6)
		redact: {
			paths: redactionPaths,
			censor: MASK_VALUE,
		},
	}

	// If a directory is specified, write logs to file (Requirement 13.4)
	if (config.dir) {
		// Ensure the directory exists
		if (!fs.existsSync(config.dir)) {
			fs.mkdirSync(config.dir, { recursive: true })
		}

		const logFilePath = path.join(config.dir, "wavekit.log")
		const destination = pino.destination({
			dest: logFilePath,
			sync: false, // Async for better performance
		})

		return pino(options, destination)
	}

	// Default: write to stdout in JSON format (Requirement 13.1, 6.1)
	return pino(options)
}

/**
 * Creates a child logger for a specific component.
 * The component name is included in every log entry from this logger.
 *
 * Requirements:
 * - 6.1: Include component field in structured logs
 * - 13.3: Include component name in each log entry
 *
 * @param parent - Parent logger instance
 * @param component - Component name to include in log entries
 * @returns Child logger with component context
 */
export function createComponentLogger(
	parent: Logger,
	component: string,
): Logger {
	// Child logger includes component name in every entry (Requirement 13.3, 6.1)
	return parent.child({ component })
}

/**
 * Generates a new correlation ID for request tracing.
 * Uses UUID v4 for uniqueness.
 *
 * Requirements: 6.3
 *
 * @returns A unique correlation ID string
 */
export function generateCorrelationId(): string {
	return randomUUID()
}

/**
 * Creates a child logger with a correlation ID for request tracing.
 * The correlation ID is included in every log entry from this logger.
 *
 * Requirements: 6.3
 *
 * @param parent - Parent logger instance
 * @param correlationId - Correlation ID to include in log entries (generated if not provided)
 * @returns Child logger with correlation ID context
 */
export function createRequestLogger(
	parent: Logger,
	correlationId?: string,
): Logger {
	const id = correlationId ?? generateCorrelationId()
	return parent.child({ correlationId: id })
}

/**
 * Creates a child logger with both component name and correlation ID.
 * Useful for request-scoped logging within a specific component.
 *
 * Requirements: 6.1, 6.3
 *
 * @param parent - Parent logger instance
 * @param component - Component name to include in log entries
 * @param correlationId - Correlation ID to include in log entries
 * @returns Child logger with component and correlation ID context
 */
export function createScopedLogger(
	parent: Logger,
	component: string,
	correlationId: string,
): Logger {
	return parent.child({ component, correlationId })
}

/**
 * Masks sensitive values in an object for safe logging.
 * This is a utility function for cases where automatic redaction isn't sufficient.
 *
 * Requirements: 9.6
 *
 * @param obj - Object to mask sensitive values in
 * @returns New object with sensitive values masked
 */
export function maskSensitiveValues<T extends Record<string, unknown>>(
	obj: T,
): T {
	const sensitiveNames = getSensitiveEnvVarNames()
	const result = { ...obj }

	for (const [key, value] of Object.entries(result)) {
		// Check if key matches sensitive patterns
		if (isSensitiveEnvVar(key) || sensitiveNames.has(key)) {
			;(result as Record<string, unknown>)[key] = MASK_VALUE
		} else if (typeof value === "object" && value !== null) {
			// Recursively mask nested objects
			;(result as Record<string, unknown>)[key] = maskSensitiveValues(
				value as Record<string, unknown>,
			)
		}
	}

	return result
}
