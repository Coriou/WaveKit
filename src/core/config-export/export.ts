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
import {
	DECODER_OPTION_SCHEMAS,
	decoderOptionDescriptors,
} from "../../decoders/options/index.js"
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
 * outside decoder options, only keys declared by a ZodObject shape are kept; keys of a
 * ZodRecord, unknown keys and keys of unclassifiable objects become `<redacted-N>`
 * (N = 1-based position in that object) and their values are redacted unless the schema
 * classifies them. Decoder options are classified by meaning (see redactDecoderOptions).
 */

/** Every option key the built-in decoder types describe (derived, so it cannot drift). */
export const BUILTIN_OPTION_KEYS: readonly string[] = Object.freeze(
	[
		...new Set(
			Object.keys(DECODER_OPTION_SCHEMAS).flatMap(type =>
				(decoderOptionDescriptors(type) ?? []).map(d => d.key),
			),
		),
	].sort(),
)

/**
 * Reviewed per-type option keys (dotted inside nested option objects) whose numbers are
 * exported: frequencies, sample rates, gains, ppm, ports, durations and DSP parameters.
 * Never a device index or serial, a position or anything ambiguous. Any other number in
 * decoder options is redacted. A kept number must also pass the option's own schema.
 */
export const CONFIG_EXPORT_NUMERIC_OPTION_KEYS: Readonly<
	Record<string, readonly string[]>
> = Object.freeze({
	acarsdec: [
		"channelHz",
		"frequencies",
		"frequency",
		"gain",
		"inputSampleRate",
		"offsetHz",
	],
	"ais-catcher": [
		"channelHz",
		"frequencies",
		"frequency",
		"gain",
		"inputSampleRate",
		"outputPort",
		"ppm",
		"rtlTcpPort",
		"spyServerPort",
	],
	direwolf: [
		"agwPort",
		"channelHz",
		"frequencies",
		"frequency",
		"inputSampleRate",
		"kissPort",
		"offsetHz",
		"sampleRate",
	],
	"dsd-fme": [
		"callStartDelayMs",
		"callTimeoutMs",
		"channelHz",
		"fmGain",
		"frequencies",
		"frequency",
		"inputSampleRate",
		"minCallDurationMs",
		"offsetHz",
		"perCallRecordingMaxAgeHours",
		"perCallRecordingMaxTotalMb",
		"udpPort",
	],
	dumpvdl2: [
		"channelHz",
		"frequencies",
		"frequency",
		"gain",
		"inputCenterFreq",
		"inputSampleRate",
		"ppm",
		"rtlTcpPort",
		"targetSampleRate",
	],
	"lora-meshtastic": [
		"bandwidth",
		"codingRate",
		"frequency",
		"inputCenterFreq",
		"inputSampleRate",
		"oversampling",
		"spreadingFactor",
	],
	"multimon-ng": [
		"channelHz",
		"filters.gain",
		"filters.highpass",
		"filters.lowpass",
		"fmGain",
		"frequencies",
		"frequency",
		"inputSampleRate",
		"offsetHz",
		"verbosity",
	],
	readsb: [
		"frequencies",
		"frequency",
		"gain",
		"inputSampleRate",
		"outputPort",
		"ppm",
		"rtlTcpPort",
	],
	rtl433: [
		"channelHz",
		"frequencies",
		"frequency",
		"inputSampleRate",
		"protocols",
		"targetSampleRate",
	],
})

/** Key of the count of dropped (unknown) option keys inside an exported options object. */
export const CONFIG_EXPORT_UNKNOWN_OPTIONS_KEY = "<unknown-options>"

/** Decoder option names that carry a receiver position (no numeric allowlist entry may match). */
export const POSITION_OPTION_KEY_PATTERN =
	/^(lat|lon|lng|alt|latitude|longitude|altitude|altm|altitudem|height|elevation|position|location|coords?|qth|grid|locator|maidenhead)$/i

const redactedPaths = new Set(CONFIG_EXPORT_REDACTED_PATHS)
const keptPaths = CONFIG_EXPORT_KEPT_STRING_PATHS.map(p => p.split("."))
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

/**
 * Keys outside decoder options whose value names a host, address, URL, path, file, device
 * serial, account or a free-form argument list: redacted whatever the value type.
 */
export const SENSITIVE_KEY_PATTERN =
	/(host|url|uri|addr|path|dir|file|serial|arg|cmd|command|exec|user|login|account|email|phone|callsign|owner|operator|endpoint|server|ip$|^ip|mac$)/i

/**
 * Exact dotted paths (`*` for an array index) that SENSITIVE_KEY_PATTERN matches by
 * accident ("arg" in target/margin, "command", "file" in profiles). Each is a number or
 * number array in ConfigSchema; the exemption holds only while the runtime value is a
 * finite number (or an array of finite numbers), anything else stays redacted.
 */
export const CONFIG_EXPORT_SENSITIVE_NAME_EXEMPT_PATHS: readonly string[] =
	Object.freeze([
		// Frequency list in Hz of a decoder band ("arg" in targets).
		"decoders.*.band.targetsHz",
		// History length limit of the tuner relay ("command" in commandHistoryLimit).
		"tunerRelay.commandHistoryLimit",
		// Margin in dB for the automatic live demod choice ("arg" in margin).
		"liveDemod.autoMarginDb",
		// Minimum false-alarm target per MHz of the scanner detector ("arg" in target).
		"scanner.detection.faTargetPerMhzMin",
		// Margin in ppm of the scanner detector ("arg" in margin).
		"scanner.detection.ppmMargin",
		// Count limit of spectrum profiles per socket ("file" in profiles).
		"scanner.ws.spectrumMaxProfiles",
	])
const exemptPaths = CONFIG_EXPORT_SENSITIVE_NAME_EXEMPT_PATHS.map(p =>
	p.split("."),
)

function isFiniteNumberOrArray(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value)
	return (
		Array.isArray(value) &&
		value.every(item => typeof item === "number" && Number.isFinite(item))
	)
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

function budgetExceeded(ctx: WalkContext, depth: number): boolean {
	ctx.nodes += 1
	return depth > CONFIG_EXPORT_MAX_DEPTH || ctx.nodes > CONFIG_EXPORT_MAX_NODES
}

/** Members of the closed sets (enum, native enum, literal, unions of them) in `schema`. */
function closedMembers(schema: z.ZodTypeAny | undefined, depth = 0): unknown[] {
	const s = unwrap(schema)
	if (s === undefined || depth > 8) return []
	if (s instanceof z.ZodEnum) return [...(s.options as readonly unknown[])]
	if (s instanceof z.ZodNativeEnum)
		return Object.values(s.enum as Record<string, unknown>)
	if (s instanceof z.ZodLiteral) return [s.value]
	return (unionOptions(s) ?? []).flatMap(b => closedMembers(b, depth + 1))
}

// ---------------------------------------------------------------------------
// Decoder options (step 4): fail closed by meaning, never by shape
// ---------------------------------------------------------------------------

interface OptionScope {
	secret: ReadonlySet<string>
	numeric: ReadonlySet<string>
	dropped: number
}

/**
 * One known option value: a boolean or null is kept; a string only when its key is in
 * CONFIG_EXPORT_OPTION_ALLOWLIST and the value is a member of the option's closed set; a
 * number only when it is a member of the option's closed set, or its key path is in the
 * type's numeric allowlist and the option schema accepts it; arrays and objects only where
 * the option schema declares them. Everything else is redacted.
 */
function redactOptionValue(
	value: unknown,
	schema: z.ZodTypeAny | undefined,
	keyPath: string,
	scope: OptionScope,
	ctx: WalkContext,
	depth: number,
): unknown {
	if (budgetExceeded(ctx, depth)) return CONFIG_EXPORT_REDACTED
	if (value === null || value === undefined || typeof value === "boolean")
		return value
	const s = unwrap(schema)
	const key = keyPath.slice(keyPath.lastIndexOf(".") + 1)
	if (typeof value === "string")
		return optionAllowlist.has(key) && closedMembers(s).includes(value)
			? value
			: CONFIG_EXPORT_REDACTED
	if (typeof value === "number") {
		if (closedMembers(s).includes(value)) return value
		return scope.numeric.has(keyPath) && s?.safeParse(value).success === true
			? value
			: CONFIG_EXPORT_REDACTED
	}
	const objectSchema = (s ? (unionOptions(s) ?? [s]) : []).map(unwrap)
	if (Array.isArray(value)) {
		const array = objectSchema.find(b => b instanceof z.ZodArray)
		if (!(array instanceof z.ZodArray)) return CONFIG_EXPORT_REDACTED
		const element = (array as z.ZodArray<z.ZodTypeAny>).element
		// Elements are classified like their option; nested arrays only where declared.
		return value.map(item =>
			redactOptionValue(item, element, keyPath, scope, ctx, depth + 1),
		)
	}
	if (isPlainObject(value)) {
		const object = objectSchema.find(b => b instanceof z.ZodObject)
		if (!(object instanceof z.ZodObject)) return CONFIG_EXPORT_REDACTED
		return redactOptionObject(
			value,
			(object as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>,
			`${keyPath}.`,
			scope,
			ctx,
			depth + 1,
		)
	}
	return CONFIG_EXPORT_REDACTED
}

/** Known keys are classified; unknown keys are dropped (counted, never a value or a name). */
function redactOptionObject(
	value: Record<string, unknown>,
	shape: Record<string, z.ZodTypeAny>,
	prefix: string,
	scope: OptionScope,
	ctx: WalkContext,
	depth: number,
): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(shape, key)) {
			scope.dropped += 1
			continue
		}
		const keyPath = prefix + key
		out[key] =
			scope.secret.has(keyPath) || isSecretKey(key)
				? CONFIG_EXPORT_REDACTED
				: redactOptionValue(value[key], shape[key], keyPath, scope, ctx, depth)
	}
	return out
}

function redactDecoderOptions(
	options: unknown,
	type: unknown,
	secretOptionKeys: ExportConfigOptions["secretOptionKeys"],
	ctx: WalkContext,
	depth: number,
): unknown {
	if (!isPlainObject(options) || typeof type !== "string")
		return CONFIG_EXPORT_REDACTED
	const secret = new Set<string>()
	if (secretOptionKeys) {
		// Fail closed: a throwing or malformed descriptor lookup redacts every option.
		try {
			const keys: unknown = secretOptionKeys(type)
			if (!Array.isArray(keys)) return CONFIG_EXPORT_REDACTED
			const list: unknown[] = keys
			if (!list.every(k => typeof k === "string")) return CONFIG_EXPORT_REDACTED
			for (const k of list as string[]) secret.add(k)
		} catch {
			return CONFIG_EXPORT_REDACTED
		}
	}
	const known = Object.hasOwn(DECODER_OPTION_SCHEMAS, type)
	const descriptors = known ? (decoderOptionDescriptors(type) ?? []) : []
	for (const d of descriptors) if (d.secret) secret.add(d.key)
	const described = new Set(descriptors.map(d => d.key))
	const schema = known ? unwrap(DECODER_OPTION_SCHEMAS[type]) : undefined
	const fullShape =
		schema instanceof z.ZodObject
			? ((schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>)
			: {}
	// A key is known only when the type's schema declares it and a descriptor documents it.
	const shape = Object.fromEntries(
		Object.entries(fullShape).filter(([k]) => described.has(k)),
	)
	const numeric = known ? (CONFIG_EXPORT_NUMERIC_OPTION_KEYS[type] ?? []) : []
	const scope: OptionScope = { secret, numeric: new Set(numeric), dropped: 0 }
	const out = redactOptionObject(options, shape, "", scope, ctx, depth)
	if (scope.dropped > 0) out[CONFIG_EXPORT_UNKNOWN_OPTIONS_KEY] = scope.dropped
	return out
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

	if (value === null || value === undefined) return value
	if (typeof value === "string" && isKeptStringPath(path)) return value
	// A scalar is kept only where the schema classifies it: a member of a closed set, or a
	// number or boolean where the schema declares exactly that type. Unknown sections,
	// records of unknown and numbers where a string is expected are redacted.
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		if (closedMembers(schema).includes(value)) return value
		if (typeof value === "number" && schema instanceof z.ZodNumber) return value
		if (typeof value === "boolean" && schema instanceof z.ZodBoolean)
			return value
		return CONFIG_EXPORT_REDACTED
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
		// Outside options a sensitive-named object (sdrHost) is walked: its strings are
		// redacted by the string rule and its own keys are checked again.
		const exempt =
			declared &&
			isFiniteNumberOrArray(child) &&
			exemptPaths.some(pattern => pathMatches([...path, key], pattern))
		if (
			isSecretKey(key) ||
			(!exempt && SENSITIVE_KEY_PATTERN.test(key) && !isPlainObject(child))
		) {
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
