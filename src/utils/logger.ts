/**
 * Logger - Pino-based structured logging
 *
 * Requirements:
 * - 13.1: Output logs in JSON format using Pino
 * - 13.2: Support log levels: trace, debug, info, warn, error
 * - 13.3: Include timestamps, log level, and component name in each log entry
 * - 13.4: When configured, write logs to the specified directory
 */

import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino"
import * as fs from "node:fs"
import * as path from "node:path"

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error"

export interface LoggerConfig {
	level: LogLevel
	dir?: string
}

export type Logger = PinoLogger

/**
 * Creates the main application logger with JSON output format.
 * Supports configurable log levels and optional file output.
 *
 * @param config - Logger configuration with level and optional directory
 * @returns Configured Pino logger instance
 */
export function createLogger(config: LoggerConfig): Logger {
	const options: LoggerOptions = {
		level: config.level,
		// Ensure timestamp is included in every log entry (Requirement 13.3)
		timestamp: pino.stdTimeFunctions.isoTime,
		// Remove default pid/hostname, we'll add component via child loggers
		base: null,
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

	// Default: write to stdout in JSON format (Requirement 13.1)
	return pino(options)
}

/**
 * Creates a child logger for a specific component.
 * The component name is included in every log entry from this logger.
 *
 * @param parent - Parent logger instance
 * @param component - Component name to include in log entries
 * @returns Child logger with component context
 */
export function createComponentLogger(
	parent: Logger,
	component: string,
): Logger {
	// Child logger includes component name in every entry (Requirement 13.3)
	return parent.child({ component })
}
