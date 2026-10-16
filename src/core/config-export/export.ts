/**
 * WG6 lane CE (docs/specs/web-gaps-6 requirement 7): pure redacted export of the
 * effective configuration as YAML. Fail closed: anything the walker cannot classify
 * is replaced by CONFIG_EXPORT_REDACTED.
 */
import {
	CONFIG_EXPORT_KEPT_STRING_PATHS,
	CONFIG_EXPORT_MAX_BYTES,
	CONFIG_EXPORT_OPTION_ALLOWLIST,
	CONFIG_EXPORT_REDACTED,
	CONFIG_EXPORT_REDACTED_PATHS,
	CONFIG_EXPORT_SECRET_KEY_PATTERN,
} from "@wavekit/api-types"
import { stringify } from "yaml"
import { z } from "zod"
import type { Config } from "../../config.js"
import { ConfigSchema } from "../../config.js"
import { WaveKitError } from "../../utils/errors.js"

export interface ExportConfigOptions {
	/** Option keys a decoder type describes as secret (redacted whatever their type). */
	secretOptionKeys?: (type: string) => readonly string[]
	version: string
	generatedAt: string
	/** Body bound in UTF-8 bytes; defaults to CONFIG_EXPORT_MAX_BYTES (tests inject it). */
	maxBytes?: number
}

/** The export body exceeds its byte bound. The message never carries config content. */
export class ConfigExportTooLargeError extends WaveKitError {
	constructor(
		public readonly bytes: number,
		public readonly maxBytes: number,
	) {
		super(
			`Configuration export is ${bytes} bytes, above the ${maxBytes} byte limit`,
			"CONFIG_EXPORT_TOO_LARGE",
		)
		this.name = "ConfigExportTooLargeError"
	}
}

/** Beyond this nesting depth every value is redacted. */
export const CONFIG_EXPORT_MAX_DEPTH = 64
/** Beyond this many visited nodes every further value is redacted. */
export const CONFIG_EXPORT_MAX_NODES = 200_000

/**
 * Object-key rule. Keys are data too (a record keyed by host name would leak it):
 * - Outside decoder options, only keys declared by a ZodObject shape are kept. Keys of
 *   a ZodRecord, unknown keys and keys of unclassifiable objects become
 *   `<redacted-N>` (N = 1-based position in that object), values walked fail closed.
 * - Inside decoder options (a free record), at any depth, a key is kept only when it is
 *   in a finite trusted set: CONFIG_EXPORT_OPTION_ALLOWLIST, the decoder type's secret
 *   option keys (their values are redacted anyway) and BUILTIN_OPTION_KEYS. Any other
 *   key becomes `<redacted-N>`, so a record keyed by host or call sign never leaks.
 */

/**
 * Option key names the built-in adapters under src/decoders/ actually read (from
 * `config.options[...]`, typed option parsers and option schemas), one global set.
 * Update when an adapter starts reading a new option; an unlisted key is only
 * renamed to `<redacted-N>` in the export, never dropped.
 */
export const BUILTIN_OPTION_KEYS: readonly string[] = Object.freeze([
	"agwPort",
	"analyze",
	"audioDevice",
	"bandwidth",
	"bw",
	"callsign",
	"callStartDelayMs",
	"callTimeoutMs",
	"channelHz",
	"channelKey",
	"charset",
	"codingRate",
	"cr",
	"debugRecordPath",
	"debugRecordStages",
	"device",
	"deviceSerial",
	"dmr",
	"dstar",
	"emitDebugEvents",
	"enableIqAgc",
	"enableMlat",
	"enablePerCallRecording",
	"extraArgs",
	"fillBits",
	"filters",
	"highpass",
	"lowpass",
	"gain",
	"flags",
	"fmGain",
	"followCenter",
	"format",
	"frequencies",
	"frequency",
	"inputCenterFreq",
	"inputIqFormat",
	"inputSampleRate",
	"kissPort",
	"lat",
	"lon",
	"minCallDurationMs",
	"mode",
	"modes",
	"nxdn",
	"offsetHz",
	"output",
	"outputFormat",
	"outputPort",
	"oversampling",
	"p25",
	"perCallRecordingDir",
	"perCallRecordingMaxAgeHours",
	"perCallRecordingMaxTotalMb",
	"perCallRecordingPrune",
	"ppm",
	"preset",
	"protocol",
	"protocols",
	"quality",
	"region",
	"rtlTcpHost",
	"rtlTcpPort",
	"sampleRate",
	"sf",
	"slot",
	"spreadingFactor",
	"spyServerHost",
	"spyServerPort",
	"stateDir",
	"talkgroup",
	"targetSampleRate",
	"udpHost",
	"udpPort",
	"verbosity",
	"voiceSlot",
	"wavDir",
	"ysf",
])
const builtinOptionKeys = new Set(BUILTIN_OPTION_KEYS)

/**
 * Decoder option keys that carry a receiver position (readsb `lat`/`lon` and the usual
 * spellings). Redacted whatever the value type, like CONFIG_EXPORT_REDACTED_PATHS: a precise
 * position is personal data even as a number.
 */
export const POSITION_OPTION_KEY_PATTERN =
	/^(lat|lon|lng|alt|latitude|longitude|altitude|altm|altitudem|height|elevation|position|location|coords?|qth|grid|locator|maidenhead)$/i

function isTrustedOptionKey(key: string, secret: ReadonlySet<string>): boolean {
	return (
		optionAllowlist.has(key) || builtinOptionKeys.has(key) || secret.has(key)
	)
}

const keptPaths = CONFIG_EXPORT_KEPT_STRING_PATHS.map(p => p.split("."))
const redactedPaths = new Set(CONFIG_EXPORT_REDACTED_PATHS)
const optionAllowlist = new Set(CONFIG_EXPORT_OPTION_ALLOWLIST)

type Path = readonly (string | number)[]

interface WalkContext {
	nodes: number
}

function redactedKey(index: number): string {
	return `<redacted-${index + 1}>`
}

function isSecretKey(key: string): boolean {
	return CONFIG_EXPORT_SECRET_KEY_PATTERN.test(key)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

function pathMatches(path: Path, pattern: readonly string[]): boolean {
	if (path.length !== pattern.length) return false
	return pattern.every((segment, i) => {
		const actual = path[i]
		if (segment === "*") return typeof actual === "number"
		return actual === segment
	})
}

function isKeptStringPath(path: Path): boolean {
	return keptPaths.some(pattern => pathMatches(path, pattern))
}

function dottedPath(path: Path): string {
	return path.join(".")
}

/** Scalars kept as-is whatever the schema (strings are never in this set). */
function isKeptScalar(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		typeof value === "boolean" ||
		typeof value === "number"
	)
}

function budgetExceeded(ctx: WalkContext, depth: number): boolean {
	ctx.nodes += 1
	return depth > CONFIG_EXPORT_MAX_DEPTH || ctx.nodes > CONFIG_EXPORT_MAX_NODES
}

// ---------------------------------------------------------------------------
// Decoder options (step 4)
// ---------------------------------------------------------------------------

function redactOptionValue(
	value: unknown,
	key: string,
	secret: ReadonlySet<string>,
	ctx: WalkContext,
	depth: number,
): unknown {
	if (budgetExceeded(ctx, depth)) return CONFIG_EXPORT_REDACTED
	if (
		secret.has(key) ||
		isSecretKey(key) ||
		POSITION_OPTION_KEY_PATTERN.test(key)
	)
		return CONFIG_EXPORT_REDACTED
	if (isKeptScalar(value)) return value
	if (typeof value === "string")
		return optionAllowlist.has(key) ? value : CONFIG_EXPORT_REDACTED
	// Array elements inherit the parent key.
	if (Array.isArray(value))
		return value.map(item =>
			redactOptionValue(item, key, secret, ctx, depth + 1),
		)
	if (isPlainObject(value))
		return redactOptionObject(value, secret, ctx, depth + 1)
	return CONFIG_EXPORT_REDACTED
}

function redactOptionObject(
	value: Record<string, unknown>,
	secret: ReadonlySet<string>,
	ctx: WalkContext,
	depth: number,
): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	Object.keys(value).forEach((key, index) => {
		const outKey = isTrustedOptionKey(key, secret) ? key : redactedKey(index)
		out[outKey] = redactOptionValue(value[key], key, secret, ctx, depth)
	})
	return out
}

function redactDecoderOptions(
	options: unknown,
	type: unknown,
	secretOptionKeys: ExportConfigOptions["secretOptionKeys"],
	ctx: WalkContext,
	depth: number,
): unknown {
	if (!isPlainObject(options)) return CONFIG_EXPORT_REDACTED
	let secret: ReadonlySet<string> = new Set()
	if (secretOptionKeys) {
		// Fail closed: a throwing or malformed descriptor lookup redacts every option.
		if (typeof type !== "string") return CONFIG_EXPORT_REDACTED
		try {
			const keys: unknown = secretOptionKeys(type)
			if (!Array.isArray(keys)) return CONFIG_EXPORT_REDACTED
			const list: unknown[] = keys
			if (!list.every(k => typeof k === "string")) return CONFIG_EXPORT_REDACTED
			secret = new Set(list as string[])
		} catch {
			return CONFIG_EXPORT_REDACTED
		}
	}
	return redactOptionObject(options, secret, ctx, depth)
}

// ---------------------------------------------------------------------------
// Schema walk (step 5)
// ---------------------------------------------------------------------------

/** Peel wrappers that do not change the value's shape. Returns undefined when unknown. */
function unwrap(schema: z.ZodTypeAny | undefined): z.ZodTypeAny | undefined {
	let current = schema
	for (let i = 0; i < 32 && current !== undefined; i += 1) {
		if (
			current instanceof z.ZodDefault ||
			current instanceof z.ZodOptional ||
			current instanceof z.ZodNullable ||
			current instanceof z.ZodCatch ||
			current instanceof z.ZodReadonly
		) {
			current = (current._def as { innerType: z.ZodTypeAny }).innerType
		} else if (current instanceof z.ZodEffects) {
			current = (current as z.ZodEffects<z.ZodTypeAny>).innerType()
		} else if (current instanceof z.ZodLazy) {
			current = (current as z.ZodLazy<z.ZodTypeAny>).schema
		} else if (current instanceof z.ZodPipeline) {
			// The config holds parsed output, so the output side describes it.
			current = (current as z.ZodPipeline<z.ZodTypeAny, z.ZodTypeAny>)._def.out
		} else if (current instanceof z.ZodBranded) {
			current = (current as z.ZodBranded<z.ZodTypeAny, string>).unwrap()
		} else {
			return current
		}
	}
	return undefined
}

/** True when the schema is a closed set of strings containing `value`. */
function closedSetContains(schema: z.ZodTypeAny, value: string): boolean {
	if (schema instanceof z.ZodEnum)
		return (schema.options as readonly unknown[]).includes(value)
	if (schema instanceof z.ZodNativeEnum)
		return Object.values(schema.enum as Record<string, unknown>).includes(value)
	if (schema instanceof z.ZodLiteral) return schema.value === value
	return false
}

function unionOptions(
	schema: z.ZodTypeAny,
): readonly z.ZodTypeAny[] | undefined {
	if (schema instanceof z.ZodUnion)
		return (schema as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options
	if (schema instanceof z.ZodDiscriminatedUnion)
		return (
			schema as z.ZodDiscriminatedUnion<
				string,
				z.ZodDiscriminatedUnionOption<string>[]
			>
		).options
	return undefined
}

function walk(
	value: unknown,
	rawSchema: z.ZodTypeAny | undefined,
	path: Path,
	ctx: WalkContext,
	depth: number,
	secretOptionKeys: ExportConfigOptions["secretOptionKeys"],
): unknown {
	if (budgetExceeded(ctx, depth)) return CONFIG_EXPORT_REDACTED
	if (redactedPaths.has(dottedPath(path))) return CONFIG_EXPORT_REDACTED
	const last = path[path.length - 1]
	if (typeof last === "string" && isSecretKey(last))
		return CONFIG_EXPORT_REDACTED

	let schema = unwrap(rawSchema)
	const branches = schema ? unionOptions(schema) : undefined
	if (branches) {
		const matching = branches.filter(b => b.safeParse(value).success)
		if (matching.length === 0) {
			schema = undefined
		} else if (matching.length === 1) {
			schema = matching[0]
		} else {
			// Several branches parse: use them only when they classify identically.
			const results = matching.map(b =>
				JSON.stringify(
					walk(value, b, path, { nodes: ctx.nodes }, depth, secretOptionKeys),
				),
			)
			schema = results.every(r => r === results[0]) ? matching[0] : undefined
		}
		// The chosen branch counted its own node; walk it from here.
		ctx.nodes -= 1
		return walk(value, schema, path, ctx, depth, secretOptionKeys)
	}

	if (isKeptScalar(value)) return value
	if (typeof value === "string") {
		if (isKeptStringPath(path)) return value
		return schema !== undefined && closedSetContains(schema, value)
			? value
			: CONFIG_EXPORT_REDACTED
	}
	if (Array.isArray(value)) {
		const element =
			schema instanceof z.ZodArray
				? (schema as z.ZodArray<z.ZodTypeAny>).element
				: undefined
		return value.map((item, index) =>
			walk(item, element, [...path, index], ctx, depth + 1, secretOptionKeys),
		)
	}
	if (!isPlainObject(value)) return CONFIG_EXPORT_REDACTED

	// decoders.N with its options record (step 4).
	const isDecoder =
		path.length === 2 && path[0] === "decoders" && typeof path[1] === "number"

	const out: Record<string, unknown> = {}
	const shape =
		schema instanceof z.ZodObject
			? ((schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>)
			: undefined
	const recordValue =
		schema instanceof z.ZodRecord
			? (schema as z.ZodRecord<z.ZodString, z.ZodTypeAny>).valueSchema
			: undefined
	Object.keys(value).forEach((key, index) => {
		const child = value[key]
		const declared = shape !== undefined && Object.hasOwn(shape, key)
		const outKey = declared ? key : redactedKey(index)
		if (isSecretKey(key)) {
			out[outKey] = CONFIG_EXPORT_REDACTED
			return
		}
		if (isDecoder && key === "options") {
			out[outKey] = redactDecoderOptions(
				child,
				value["type"],
				secretOptionKeys,
				ctx,
				depth + 1,
			)
			return
		}
		const childSchema = declared ? shape[key] : recordValue
		// Undeclared keys walk with a path that never matches a kept path.
		const childPath = declared ? [...path, key] : [...path, outKey]
		out[outKey] = walk(
			child,
			childSchema,
			childPath,
			ctx,
			depth + 1,
			secretOptionKeys,
		)
	})
	return out
}

/**
 * Walk `value` against `schema` with the export rules (exported for tests of the walker
 * on arbitrary schemas). Decoder options are handled only at `decoders.N.options`.
 */
export function redactWithSchema(
	value: unknown,
	schema: z.ZodTypeAny | undefined,
	options: Pick<ExportConfigOptions, "secretOptionKeys"> = {},
): unknown {
	return walk(value, schema, [], { nodes: 0 }, 0, options.secretOptionKeys)
}

/** Redacted plain-object copy of `config` (requirement 7.3, steps 1 to 5). */
export function redactConfig(
	config: Config,
	options: Pick<ExportConfigOptions, "secretOptionKeys"> = {},
): Record<string, unknown> {
	const source: unknown = config
	if (!isPlainObject(source)) return {}
	const access: unknown = source["access"]
	const mode =
		isPlainObject(access) &&
		(access["mode"] === "legacy" || access["mode"] === "protected")
			? access["mode"]
			: CONFIG_EXPORT_REDACTED
	const reduced: Record<string, unknown> = { ...source }
	if ("access" in source) reduced["access"] = { mode }
	const result = walk(
		reduced,
		ConfigSchema,
		[],
		{ nodes: 0 },
		0,
		options.secretOptionKeys,
	)
	if (!isPlainObject(result)) return {}
	// The reduced access block no longer parses against either access branch, so its
	// mode (already checked against the closed set above) is restored here.
	if ("access" in source) result["access"] = { mode }
	return result
}

function sanitizeHeaderField(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
		.slice(0, 64)
}

/** YAML body of the redacted export; throws ConfigExportTooLargeError above maxBytes. */
export function exportConfig(
	config: Config,
	options: ExportConfigOptions,
): string {
	const redacted = redactConfig(
		config,
		options.secretOptionKeys
			? { secretOptionKeys: options.secretOptionKeys }
			: {},
	)
	const header = `# WaveKit ${sanitizeHeaderField(options.version)} redacted configuration export ${sanitizeHeaderField(options.generatedAt)}: secrets, hosts, paths, names and the station position are replaced by "${CONFIG_EXPORT_REDACTED}"`
	const yaml = stringify(redacted, {
		aliasDuplicateObjects: false,
		lineWidth: 0,
	})
	const body = `${header}\n${yaml}`
	const maxBytes = options.maxBytes ?? CONFIG_EXPORT_MAX_BYTES
	const bytes = Buffer.byteLength(body, "utf8")
	if (bytes > maxBytes) throw new ConfigExportTooLargeError(bytes, maxBytes)
	return body
}
