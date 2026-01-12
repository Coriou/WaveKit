export {
	createComponentLogger,
	createLogger,
	createRequestLogger,
	createScopedLogger,
	generateCorrelationId,
	getSensitiveEnvVarNames,
	isSensitiveEnvVar,
	MASK_VALUE,
	maskSensitiveValues,
} from "@wavekit/shared"

export type { LogLevel, Logger, LoggerConfig } from "@wavekit/shared"
