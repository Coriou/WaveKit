import type { ZodError } from "zod"

/**
 * Base error class for all WaveKit errors.
 * Provides a consistent error structure with error codes and cause chaining.
 */
export class WaveKitError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public override readonly cause?: Error,
	) {
		super(message, { cause })
		this.name = "WaveKitError"
		// Maintains proper stack trace for where error was thrown (V8 engines)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor)
		}
	}
}

/**
 * Error thrown when a TCP connection to an SDR source fails.
 * Handles ECONNREFUSED, ETIMEDOUT, ECONNRESET errors gracefully.
 * Requirements: 1.6
 */
export class SourceConnectionError extends WaveKitError {
	constructor(
		public readonly host: string,
		public readonly port: number,
		cause?: Error,
	) {
		super(
			`Failed to connect to ${host}:${port}`,
			"SOURCE_CONNECTION_ERROR",
			cause,
		)
		this.name = "SourceConnectionError"
	}
}

/**
 * Error thrown when spawning a decoder process fails.
 * Requirements: 4.2
 */
export class DecoderSpawnError extends WaveKitError {
	constructor(
		public readonly decoderId: string,
		public readonly command: string,
		cause?: Error,
	) {
		super(
			`Failed to spawn decoder ${decoderId}: ${command}`,
			"DECODER_SPAWN_ERROR",
			cause,
		)
		this.name = "DecoderSpawnError"
	}
}

/**
 * Error thrown when parsing decoder output fails.
 * Requirements: 4.2
 */
export class DecoderParseError extends WaveKitError {
	constructor(
		public readonly decoderId: string,
		public readonly line: string,
	) {
		super(
			`Failed to parse decoder output: ${line.substring(0, 100)}`,
			"DECODER_PARSE_ERROR",
		)
		this.name = "DecoderParseError"
	}
}

/**
 * Error thrown when configuration validation fails.
 * Requirements: 12.4
 */
export class ConfigValidationError extends WaveKitError {
	constructor(public readonly zodError: ZodError) {
		super(
			`Configuration validation failed: ${zodError.message}`,
			"CONFIG_VALIDATION_ERROR",
		)
		this.name = "ConfigValidationError"
	}
}

/**
 * Error thrown when an unknown decoder type is requested from the registry.
 * Requirements: 5.3
 */
export class RegistryError extends WaveKitError {
	constructor(public readonly type: string) {
		super(`Unknown decoder type: ${type}`, "REGISTRY_ERROR")
		this.name = "RegistryError"
	}
}
