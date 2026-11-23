/**
 * How SourceManager reads an rtl_tcp IQ source: `socket` (today's path: Node's own TCP socket, the
 * default) or `hub` (a `wavekit-iqhub` process owns the TCP connection and Node reads a front sink
 * over a Unix socket). Selected once per process by WAVEKIT_SOURCE_INTAKE; it has no `__`, so the
 * config loader's WAVEKIT_ overrides never read it, and there is no config key.
 *
 * `hub` is opt-in: tuner-command receipts follow the hub's exact placements (tuning-ledger.ts,
 * placed connections). It needs the hub binary, WAVEKIT_IQHUB_BIN (default
 * DEFAULT_IQHUB_BIN, the image's install path), checked once at startup: a missing or
 * non-executable binary fails startup with an error naming the variable, never at the first
 * connect. WAVEKIT_IQHUB_STATS_DIR (bench diagnostic) gives each hub a stats file
 * `<dir>/<sourceId>.jsonl`.
 */
import * as fs from "node:fs"
import { ZodError } from "zod"
import { ConfigValidationError } from "../../utils/errors.js"
import type { Logger } from "../../utils/logger.js"

export const SOURCE_INTAKE_ENV = "WAVEKIT_SOURCE_INTAKE"
export const IQHUB_BIN_ENV = "WAVEKIT_IQHUB_BIN"
export const IQHUB_STATS_DIR_ENV = "WAVEKIT_IQHUB_STATS_DIR"
/** Where the image installs the hub (the Dockerfile's hub stage). */
export const DEFAULT_IQHUB_BIN = "/usr/local/bin/wavekit-iqhub"

export type SourceIntakeMode = "socket" | "hub"

/** The mode when WAVEKIT_SOURCE_INTAKE is unset or empty. */
export const DEFAULT_SOURCE_INTAKE_MODE: SourceIntakeMode = "socket"

/** The values WAVEKIT_SOURCE_INTAKE accepts, exactly as written. */
export const SOURCE_INTAKE_MODES: readonly SourceIntakeMode[] = [
	"socket",
	"hub",
]

function intakeError(
	message: string,
	variable: string = SOURCE_INTAKE_ENV,
): ConfigValidationError {
	return new ConfigValidationError(
		new ZodError([{ code: "custom", path: [variable], message }]),
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

/**
 * `socket` and `hub` are read as given; unset and empty read as the default (socket). Any other
 * value (another case, surrounding spaces, anything else) throws a ConfigValidationError naming
 * the accepted values: there is no silent fallback.
 */
export function sourceIntakeModeFrom(
	raw: string | undefined,
): SourceIntakeMode {
	if (raw === undefined || raw === "" || raw === "socket") return "socket"
	if (raw === "hub") return "hub"
	throw unknownSourceIntakeModeError()
}

export interface HubIntakeSettings {
	/** The hub binary (an absolute or relative path; checked executable). */
	bin: string
	/** Each hub's stats file goes here (`<sourceId>.jsonl`); null: none. */
	statsDir: string | null
}

/**
 * The hub settings for `hub` mode: WAVEKIT_IQHUB_BIN (unset or empty: DEFAULT_IQHUB_BIN) must
 * name an executable file, else a ConfigValidationError naming the variable (never its value) is
 * thrown; WAVEKIT_IQHUB_STATS_DIR (unset or empty: none) must name a directory, else the same.
 */
export function hubIntakeSettingsFrom(
	env: NodeJS.ProcessEnv,
	executable: (file: string) => boolean = isExecutableFile,
	isDirectory: (dir: string) => boolean = isDirectoryPath,
): HubIntakeSettings {
	const raw = env[IQHUB_BIN_ENV]
	const unset = raw === undefined || raw === ""
	const bin = unset ? DEFAULT_IQHUB_BIN : raw
	if (!executable(bin))
		throw intakeError(
			unset
				? `Hub intake needs the wavekit-iqhub binary: none is executable at the default path; set ${IQHUB_BIN_ENV}`
				: "Hub intake needs the wavekit-iqhub binary: this path is not an executable file",
			IQHUB_BIN_ENV,
		)
	const statsRaw = env[IQHUB_STATS_DIR_ENV]
	const statsDir = statsRaw === undefined || statsRaw === "" ? null : statsRaw
	if (statsDir !== null && !isDirectory(statsDir))
		throw intakeError("Not a directory", IQHUB_STATS_DIR_ENV)
	return { bin, statsDir }
}

/**
 * The environment variable a refused intake setting names (its ConfigValidationError's issue
 * path), or null for any other error. Only a known variable name comes back, never a value.
 */
export function intakeErrorVariable(error: unknown): string | null {
	if (!(error instanceof ConfigValidationError)) return null
	const name = error.zodError.issues[0]?.path[0]
	return name === SOURCE_INTAKE_ENV ||
		name === IQHUB_BIN_ENV ||
		name === IQHUB_STATS_DIR_ENV
		? name
		: null
}

function isExecutableFile(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK)
		return fs.statSync(file).isFile()
	} catch {
		return false
	}
}

function isDirectoryPath(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory()
	} catch {
		return false
	}
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
