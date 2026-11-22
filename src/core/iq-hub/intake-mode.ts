/**
 * How SourceManager reads an rtl_tcp IQ source: `socket` (today's path: Node's own TCP socket, the
 * default) or `hub` (a `wavekit-iqhub` process owns the TCP connection and Node reads a front sink
 * over a Unix socket). Selected once per process by WAVEKIT_SOURCE_INTAKE; it has no `__`, so the
 * config loader's WAVEKIT_ overrides never read it, and there is no config key.
 *
 * Hub intake is not yet available: until tuner-command receipts get exact hub positions, a
 * receipt recorded at Node's position could prove tuning up to the front's lag (6 s) early, so the
 * value `hub` is refused at startup. The hub path is exercised only through an injected
 * SourceIntake (tests).
 */
import { ZodError } from "zod"
import { ConfigValidationError } from "../../utils/errors.js"
import type { Logger } from "../../utils/logger.js"

export const SOURCE_INTAKE_ENV = "WAVEKIT_SOURCE_INTAKE"

export type SourceIntakeMode = "socket" | "hub"

/** The mode when WAVEKIT_SOURCE_INTAKE is unset or empty. */
export const DEFAULT_SOURCE_INTAKE_MODE: SourceIntakeMode = "socket"

/** The values WAVEKIT_SOURCE_INTAKE accepts, exactly as written. */
export const SOURCE_INTAKE_MODES: readonly SourceIntakeMode[] = [
	"socket",
	"hub",
]

/** The modes a process may select today. */
export const AVAILABLE_SOURCE_INTAKE_MODES: readonly SourceIntakeMode[] = [
	"socket",
]

function intakeError(message: string): ConfigValidationError {
	return new ConfigValidationError(
		new ZodError([{ code: "custom", path: [SOURCE_INTAKE_ENV], message }]),
	)
}

/**
 * The error for a value that is not accepted. It names the variable and the accepted values only:
 * the value itself is never in its message or its issues.
 */
export function unknownSourceIntakeModeError(): ConfigValidationError {
	return intakeError(
		`Invalid value. Expected one of: ${SOURCE_INTAKE_MODES.join(", ")}`,
	)
}

/** The error for `hub` while hub intake is not yet available. */
export function hubIntakeUnavailableError(): ConfigValidationError {
	return intakeError(
		"Hub intake is not yet available (it needs exact tuner-command positions); unset it or use socket",
	)
}

/**
 * `socket` is read as given; unset and empty read as the default (socket). `hub` throws (not yet
 * available). Any other value (another case, surrounding spaces, anything else) throws a
 * ConfigValidationError naming the accepted values: there is no silent fallback.
 */
export function sourceIntakeModeFrom(
	raw: string | undefined,
): SourceIntakeMode {
	if (raw === undefined || raw === "" || raw === "socket") return "socket"
	if (raw === "hub") throw hubIntakeUnavailableError()
	throw unknownSourceIntakeModeError()
}

let processMode: SourceIntakeMode | undefined

/**
 * The process's mode, read from the environment on the first call (the SourceManager constructor,
 * at startup); one info line names it. A refused value logs one error naming only the variable and
 * the accepted values (never the value) and throws, so startup fails; nothing is cached then.
 */
export function processSourceIntakeMode(
	log: Logger,
	env: NodeJS.ProcessEnv = process.env,
): SourceIntakeMode {
	if (processMode !== undefined) return processMode
	let mode: SourceIntakeMode
	try {
		mode = sourceIntakeModeFrom(env[SOURCE_INTAKE_ENV])
	} catch (error: unknown) {
		log.error(
			{
				variable: SOURCE_INTAKE_ENV,
				accepted: SOURCE_INTAKE_MODES,
				available: AVAILABLE_SOURCE_INTAKE_MODES,
			},
			"Source intake mode refused; startup stops",
		)
		throw error
	}
	processMode = mode
	log.info({ sourceIntake: mode }, "Source intake mode")
	return mode
}

/** Tests only: forget the process's mode so the next call reads the environment again. */
export function resetProcessSourceIntakeModeForTests(): void {
	processMode = undefined
}
