import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export interface LoggerConfig {
	level: LogLevel
	dir?: string
	pretty?: boolean
}

export type Logger = PinoLogger

const SENSITIVE_PATTERNS = [/_SECRET$/i, /_PASSWORD$/i, /_KEY$/i, /_TOKEN$/i]
export const MASK_VALUE = "***REDACTED***"

export function isSensitiveEnvVar(name: string): boolean {
	return SENSITIVE_PATTERNS.some(pattern => pattern.test(name))
}

export function getSensitiveEnvVarNames(): Set<string> {
	const sensitiveNames = new Set<string>()
	for (const name of Object.keys(process.env)) {
		if (isSensitiveEnvVar(name)) {
			sensitiveNames.add(name)
		}
	}
	return sensitiveNames
}

function createRedactionPaths(): string[] {
	const sensitiveNames = getSensitiveEnvVarNames()
	const paths: string[] = []

	for (const name of sensitiveNames) {
		paths.push(name)
		paths.push(`*.${name}`)
		paths.push(`env.${name}`)
		paths.push(`config.${name}`)
	}

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

export function createLogger(config: LoggerConfig): Logger {
	const redactionPaths = createRedactionPaths()

	const options: LoggerOptions = {
		level: config.level,
		timestamp: pino.stdTimeFunctions.isoTime,
		base: null,
		redact: {
			paths: redactionPaths,
			censor: MASK_VALUE,
		},
	}

	if (config.dir) {
		if (!fs.existsSync(config.dir)) {
			fs.mkdirSync(config.dir, { recursive: true })
		}

		const logFilePath = path.join(config.dir, "wavekit.log")
		const destination = pino.destination({ dest: logFilePath, sync: false })
		return pino(options, destination)
	}

	if (config.pretty) {
		return pino({
			...options,
			transport: {
				target: "pino-pretty",
				options: { colorize: true },
			},
		})
	}

	return pino(options)
}

export function createComponentLogger(
	parent: Logger,
	component: string,
): Logger {
	return parent.child({ component })
}

export function generateCorrelationId(): string {
	return randomUUID()
}

export function createRequestLogger(
	parent: Logger,
	correlationId?: string,
): Logger {
	const id = correlationId ?? generateCorrelationId()
	return parent.child({ correlationId: id })
}

export function createScopedLogger(
	parent: Logger,
	component: string,
	correlationId: string,
): Logger {
	return parent.child({ component, correlationId })
}

export function maskSensitiveValues<T extends Record<string, unknown>>(
	obj: T,
): T {
	const sensitiveNames = getSensitiveEnvVarNames()
	const result = { ...obj }

	for (const [key, value] of Object.entries(result)) {
		if (isSensitiveEnvVar(key) || sensitiveNames.has(key)) {
			;(result as Record<string, unknown>)[key] = MASK_VALUE
			continue
		}

		if (typeof value === "object" && value !== null) {
			;(result as Record<string, unknown>)[key] = maskSensitiveValues(
				value as Record<string, unknown>,
			)
		}
	}

	return result
}
