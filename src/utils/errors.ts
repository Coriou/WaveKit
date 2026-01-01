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
 * Requirements: 5.4, 12.4
 */
export class ConfigValidationError extends WaveKitError {
	constructor(public readonly zodError: ZodError) {
		const formattedMessage = ConfigValidationError.formatZodError(zodError)
		super(formattedMessage, "CONFIG_VALIDATION_ERROR")
		this.name = "ConfigValidationError"
	}

	/**
	 * Formats a Zod error into a human-readable message.
	 * Provides clear, actionable error messages for configuration issues.
	 */
	static formatZodError(error: ZodError): string {
		const issues = error.issues.map(issue => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "root"
			const code = issue.code

			switch (code) {
				case "invalid_type":
					return `  - ${path}: Expected ${issue.expected}, received ${issue.received}`
				case "invalid_enum_value":
					return `  - ${path}: Invalid value. Expected one of: ${(issue as { options: string[] }).options.join(", ")}`
				case "too_small":
					return `  - ${path}: Value is too small (minimum: ${(issue as { minimum: number }).minimum})`
				case "too_big":
					return `  - ${path}: Value is too large (maximum: ${(issue as { maximum: number }).maximum})`
				case "invalid_string":
					return `  - ${path}: Invalid string format`
				case "custom":
					return `  - ${path}: ${issue.message}`
				default:
					return `  - ${path}: ${issue.message}`
			}
		})

		return `Configuration validation failed:\n${issues.join("\n")}`
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

/**
 * Error thrown when a network connection to a decoder output fails.
 * Requirements: 18.3
 */
export class NetworkConnectionError extends WaveKitError {
	constructor(
		public readonly host: string,
		public readonly port: number,
		public readonly protocol: "tcp" | "udp",
		cause?: Error,
	) {
		super(
			`Failed to connect to decoder output at ${host}:${port} (${protocol})`,
			"NETWORK_CONNECTION_ERROR",
			cause,
		)
		this.name = "NetworkConnectionError"
	}
}

/**
 * Error thrown when decoder version validation fails.
 * Requirements: 27.1, 27.2, 27.3
 */
export class DecoderVersionError extends WaveKitError {
	constructor(
		public readonly decoderType: string,
		public readonly detectedVersion: string | undefined,
		public readonly minVersion: string | undefined,
		public readonly maxVersion: string | undefined,
		message?: string,
	) {
		const defaultMessage = detectedVersion
			? `Decoder ${decoderType} version ${detectedVersion} does not satisfy version constraints`
			: `Failed to detect version for decoder ${decoderType}`
		super(message ?? defaultMessage, "DECODER_VERSION_ERROR")
		this.name = "DecoderVersionError"
	}
}
