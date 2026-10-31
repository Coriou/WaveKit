/**
 * One shape for every HTTP 400 validation answer: the field(s) that failed and what each
 * accepts (type, values, bounds, units).
 *
 * Every word comes from the server's own schema (JSON schema for Fastify routes, Zod for
 * handler-side parses): field names are schema property names or array indexes, and
 * `expected` describes the schema. A submitted value, an unknown key the client sent, a
 * record key or a parser message (which can quote the body) is never echoed, so the body
 * is safe with access configured too.
 *
 * Body: `{ error: "ValidationError", code: "VALIDATION_ERROR", message, fields: [{ field,
 * expected }] }`. Routes with their own error codes keep them and add `fields`.
 */

import type { FastifyError, FastifyRequest } from "fastify"
import {
	ZodArray,
	ZodBoolean,
	ZodBranded,
	ZodCatch,
	ZodDate,
	ZodDefault,
	ZodDiscriminatedUnion,
	ZodEffects,
	ZodEnum,
	type ZodError,
	ZodIntersection,
	ZodLazy,
	ZodLiteral,
	ZodNativeEnum,
	ZodNull,
	ZodNullable,
	ZodNumber,
	ZodObject,
	ZodOptional,
	ZodPipeline,
	ZodReadonly,
	ZodRecord,
	ZodString,
	ZodTuple,
	ZodUnion,
	type ZodTypeAny,
} from "zod"

export interface ValidationField {
	/** Schema path ("hz", "entries.0.gain"); the request part ("body", "query") for the root. */
	field: string
	/** Static description of what the field accepts. */
	expected: string
}

export interface ValidationErrorBody {
	error: string
	code: string
	message: string
	fields: ValidationField[]
}

/** JSON schema of `fields`, for the `400` response schema of every route that declares one. */
export const validationFieldsSchema = {
	type: "array",
	items: {
		type: "object",
		properties: {
			field: { type: "string" },
			expected: { type: "string" },
		},
		required: ["field", "expected"],
	},
} as const

/**
 * A 400 names at most this many fields: Fastify stops at the first schema failure, and a
 * Zod parse of a 30-field body with every field wrong still answers a short body
 * (8 fields x ~200 chars of description stays under 2 KiB).
 */
export const MAX_VALIDATION_FIELDS = 8

/** Objects list at most this many property names in an `expected` text; longer get ", ...". */
const MAX_LISTED_PROPERTIES = 24

/** Nested unions, arrays and refinements are described at most this deep. */
const MAX_DESCRIBE_DEPTH = 4

/** Request part names as a client reads them (Fastify says "querystring"). */
export type RequestPart = "body" | "query" | "params" | "headers"

export function requestPart(context: string | undefined): RequestPart {
	if (context === "querystring") return "query"
	if (context === "params" || context === "headers") return context
	return "body"
}

/** The static message for these fields: names and expectations, never values. */
export function validationMessage(
	part: RequestPart,
	fields: readonly ValidationField[],
): string {
	const subject =
		part === "query"
			? "query parameter"
			: part === "params"
				? "path parameter"
				: `request ${part}`
	if (fields.length === 0) return `Invalid ${subject}`
	return `Invalid ${subject}: ${fields
		.map(f => (f.field === part ? f.expected : `${f.field}: ${f.expected}`))
		.join("; ")}`
}

export function validationErrorBody(
	part: RequestPart,
	fields: readonly ValidationField[],
	overrides: { error?: string; code?: string; message?: string } = {},
): ValidationErrorBody {
	const named =
		fields.length > 0 ? fields : [{ field: part, expected: "a valid value" }]
	return {
		error: overrides.error ?? "ValidationError",
		code: overrides.code ?? "VALIDATION_ERROR",
		message: overrides.message ?? validationMessage(part, named),
		fields: [...named],
	}
}

/** Unit a field name states by convention (`nearHz`, `timeoutMs`, `tenthsDb`), if any. */
export function unitFromName(name: string | undefined): string | null {
	if (name === undefined) return null
	if (/tenthsDb$/i.test(name)) return "tenths of a dB"
	if (/(^|[a-z])Hz$/.test(name) || /^hz$/i.test(name)) return "Hz"
	if (/(^|[a-z])Db$/.test(name) || /^db$/i.test(name)) return "dB"
	if (/(^|[a-z])Ms$/.test(name) || /^ms$/i.test(name)) return "milliseconds"
	if (/(^|[a-z])(Sec|Seconds)$/.test(name) || /^seconds$/i.test(name))
		return "seconds"
	if (/(^|[a-z])Bytes$/.test(name)) return "bytes"
	if (/^ppm$/i.test(name) || /[a-z]Ppm$/.test(name)) return "ppm"
	return null
}

function withUnit(text: string, name: string | undefined): string {
	const unit = unitFromName(name)
	return unit !== null && !text.includes(unit) ? `${text}, ${unit}` : text
}

function listNames(names: readonly string[]): string {
	const shown = names.slice(0, MAX_LISTED_PROPERTIES)
	return `${shown.join(", ")}${names.length > shown.length ? ", ..." : ""}`
}

function literal(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value)
}

function bounds(
	min: number | undefined,
	max: number | undefined,
	minExclusive = false,
	maxExclusive = false,
): string {
	if (min !== undefined && max !== undefined && !minExclusive && !maxExclusive)
		return ` (${min} to ${max})`
	const parts: string[] = []
	if (min !== undefined) parts.push(`${minExclusive ? ">" : ">="} ${min}`)
	if (max !== undefined) parts.push(`${maxExclusive ? "<" : "<="} ${max}`)
	return parts.length > 0 ? ` (${parts.join(", ")})` : ""
}

function lengthBounds(
	noun: string,
	min: number | undefined,
	max: number | undefined,
): string {
	const unit = (n: number) => (n === 1 ? noun.replace(/s$/, "") : noun)
	if (min !== undefined && max !== undefined)
		return min === max
			? `, exactly ${min} ${unit(min)}`
			: `, ${min} to ${max} ${noun}`
	if (min !== undefined) return `, at least ${min} ${unit(min)}`
	if (max !== undefined) return `, at most ${max} ${unit(max)}`
	return ""
}

// ---------------------------------------------------------------------------
// JSON schema (Fastify / Ajv)
// ---------------------------------------------------------------------------

type JsonSchema = Readonly<Record<string, unknown>>

function isSchema(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined
}

function schemaProperties(
	schema: JsonSchema,
): Readonly<Record<string, unknown>> {
	return isSchema(schema["properties"]) ? schema["properties"] : {}
}

function schemaBranches(schema: JsonSchema): JsonSchema[] {
	const out: JsonSchema[] = []
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const list = schema[key]
		if (Array.isArray(list)) for (const s of list) if (isSchema(s)) out.push(s)
	}
	return out
}

/** Property names of an object schema, including those of its anyOf/oneOf/allOf branches. */
function objectPropertyNames(schema: JsonSchema): string[] {
	const names = new Set(Object.keys(schemaProperties(schema)))
	for (const branch of schemaBranches(schema))
		for (const name of Object.keys(schemaProperties(branch))) names.add(name)
	return [...names]
}

/** Static text for what a JSON schema accepts. `name` adds a unit the name implies. */
export function describeJsonSchema(
	schema: unknown,
	name?: string,
	depth = 0,
): string {
	if (!isSchema(schema)) return "a valid value"
	const description = schema["description"]
	if (typeof description === "string" && description.length > 0)
		return withUnit(
			`${baseJsonDescription(schema, depth)}: ${description}`,
			name,
		)
	return withUnit(baseJsonDescription(schema, depth), name)
}

function baseJsonDescription(schema: JsonSchema, depth: number): string {
	if ("const" in schema) return literal(schema["const"])
	const values = schema["enum"]
	if (Array.isArray(values))
		return values.length === 1
			? literal(values[0])
			: `one of ${values.map(literal).join(" | ")}`
	const oneOf = Array.isArray(schema["oneOf"])
	const branches = [schema["anyOf"], schema["oneOf"]].find(Array.isArray)
	const presence = Array.isArray(branches) ? requiredOnly(branches) : null
	if (
		Array.isArray(branches) &&
		presence === null &&
		depth < MAX_DESCRIBE_DEPTH
	)
		return [
			...new Set(
				branches.map(b => describeJsonSchema(b, undefined, depth + 1)),
			),
		].join(" or ")
	const rawType = schema["type"]
	const types = Array.isArray(rawType) ? rawType : [rawType]
	const described = types
		.filter((t): t is string => typeof t === "string")
		.map(t => typedJsonDescription(schema, t, depth))
	const base =
		described.length > 0
			? described.join(" or ")
			: isSchema(schema["properties"])
				? typedJsonDescription(schema, "object", depth)
				: "a valid value"
	// Branches that only require fields ({ required: ["frequencyHz"] }) state which to send.
	return presence !== null
		? `${base}; ${oneOf ? "exactly one of" : "at least one of"} ${presence.join(" or ")}`
		: base
}

/** "a and b" per branch when every branch only lists required fields, else null. */
function requiredOnly(branches: readonly unknown[]): string[] | null {
	const out: string[] = []
	for (const branch of branches) {
		if (!isSchema(branch)) return null
		const required = branch["required"]
		if (
			Object.keys(branch).some(key => key !== "required") ||
			!Array.isArray(required) ||
			required.length === 0 ||
			!required.every(name => typeof name === "string")
		)
			return null
		out.push((required as string[]).join(" and "))
	}
	return out.length > 0 ? out : null
}

function typedJsonDescription(
	schema: JsonSchema,
	type: string,
	depth: number,
): string {
	switch (type) {
		case "integer":
		case "number": {
			const exMin = num(schema["exclusiveMinimum"])
			const exMax = num(schema["exclusiveMaximum"])
			return `${type}${bounds(
				exMin ?? num(schema["minimum"]),
				exMax ?? num(schema["maximum"]),
				exMin !== undefined,
				exMax !== undefined,
			)}`
		}
		case "string": {
			const format = schema["format"]
			const pattern = schema["pattern"]
			const kind =
				typeof format === "string"
					? `string (${format})`
					: typeof pattern === "string"
						? "string in the required format"
						: "string"
			return `${kind}${lengthBounds(
				"characters",
				num(schema["minLength"]),
				num(schema["maxLength"]),
			)}`
		}
		case "boolean":
			return "boolean"
		case "null":
			return "null"
		case "array": {
			const items = schema["items"]
			const of =
				isSchema(items) && depth < MAX_DESCRIBE_DEPTH
					? ` of ${describeJsonSchema(items, undefined, depth + 1)}`
					: ""
			return `array${of}${lengthBounds(
				"items",
				num(schema["minItems"]),
				num(schema["maxItems"]),
			)}`
		}
		case "object": {
			const names = objectPropertyNames(schema)
			return names.length > 0
				? `object with fields ${listNames(names)}`
				: "object"
		}
		default:
			return "a valid value"
	}
}

/** The child schema at `segment`, and whether the segment is a schema name (not client data). */
function jsonChild(
	schema: JsonSchema,
	segment: string,
): { schema: JsonSchema | undefined; named: boolean } {
	const props = schemaProperties(schema)
	if (Object.hasOwn(props, segment)) {
		const child = props[segment]
		return { schema: isSchema(child) ? child : undefined, named: true }
	}
	for (const branch of schemaBranches(schema)) {
		const found = jsonChild(branch, segment)
		if (found.named) return found
	}
	const items = schema["items"]
	if (/^\d+$/.test(segment)) {
		if (isSchema(items)) return { schema: items, named: true }
		if (Array.isArray(items)) {
			const item: unknown = items[Number(segment)]
			return { schema: isSchema(item) ? item : undefined, named: true }
		}
	}
	const extra = schema["additionalProperties"]
	if (isSchema(extra)) return { schema: extra, named: false }
	if (isSchema(schema["patternProperties"]))
		return { schema: undefined, named: false }
	return { schema: undefined, named: false }
}

/** Walks an Ajv instancePath: known names stay, client-chosen keys become "*", unknown stops. */
function walkJson(
	root: unknown,
	instancePath: string,
): { path: string[]; schema: JsonSchema | undefined } {
	const segments = instancePath
		.split("/")
		.filter(s => s !== "")
		.map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"))
	const path: string[] = []
	let schema = isSchema(root) ? root : undefined
	for (const segment of segments) {
		if (schema === undefined) break
		const child = jsonChild(schema, segment)
		if (!child.named && child.schema === undefined) {
			schema = undefined
			break
		}
		path.push(child.named ? segment : "*")
		schema = child.schema
	}
	return { path, schema }
}

/**
 * Fields for a Fastify (Ajv) validation failure, from the route schema only: `params`
 * values Ajv records (allowed values, limits) are not needed because the schema holds them,
 * and `additionalProperty` (a key the client chose) is never read.
 */
export function ajvValidationFields(
	errors: FastifyError["validation"],
	part: RequestPart,
	routeSchema: unknown,
): ValidationField[] {
	const fields = new Map<string, string>()
	for (const issue of errors ?? []) {
		if (fields.size >= MAX_VALIDATION_FIELDS) break
		const { path, schema } = walkJson(routeSchema, issue.instancePath)
		const at = path.length > 0 ? path.join(".") : part
		const missing = (issue.params as { missingProperty?: unknown })
			.missingProperty
		if (issue.keyword === "required" && typeof missing === "string") {
			const props = schema ? schemaProperties(schema) : {}
			if (Object.hasOwn(props, missing)) {
				const field = [...path, missing].join(".")
				if (!fields.has(field))
					fields.set(
						field,
						`required; ${describeJsonSchema(props[missing], missing)}`,
					)
				continue
			}
		}
		if (fields.has(at)) continue
		if (issue.keyword === "additionalProperties" && schema !== undefined) {
			const names = objectPropertyNames(schema)
			fields.set(
				at,
				names.length > 0 ? `only the fields ${listNames(names)}` : "no fields",
			)
			continue
		}
		fields.set(
			at,
			schema !== undefined
				? describeJsonSchema(schema, path.at(-1))
				: "a valid value",
		)
	}
	return [...fields].map(([field, expected]) => ({ field, expected }))
}

/** The route's own JSON schema for a request part (Fastify keeps it on routeOptions). */
export function routeSchemaFor(
	request: FastifyRequest,
	context: string | undefined,
): unknown {
	const schema = request.routeOptions.schema as
		| Readonly<Record<string, unknown>>
		| undefined
	return schema?.[context ?? "body"]
}

/** Fastify body parser 400s (malformed or empty JSON body, bad content type or length). */
export function isBodyParseError(error: FastifyError): boolean {
	return (
		error.statusCode === 400 &&
		typeof error.code === "string" &&
		error.code.startsWith("FST_ERR_CTP_")
	)
}

/**
 * The 400 for a Fastify schema or body-parse failure. A parse failure never repeats the
 * parser's message: V8 JSON errors quote the submitted text.
 */
export function fastifyValidationBody(
	error: FastifyError,
	request: FastifyRequest,
): ValidationErrorBody {
	if (!error.validation) {
		const schema = routeSchemaFor(request, "body")
		return validationErrorBody("body", [
			{
				field: "body",
				expected:
					schema !== undefined
						? `a JSON document: ${describeJsonSchema(schema)}`
						: "a valid JSON document",
			},
		])
	}
	const context = error.validationContext
	const part = requestPart(context)
	return validationErrorBody(
		part,
		ajvValidationFields(
			error.validation,
			part,
			routeSchemaFor(request, context),
		),
	)
}

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

/** Wrappers that do not change what a value must look like. */
function unwrapZod(schema: ZodTypeAny): ZodTypeAny {
	let current = schema
	for (let i = 0; i < 16; i++) {
		if (current instanceof ZodOptional || current instanceof ZodNullable)
			current = current.unwrap() as ZodTypeAny
		else if (current instanceof ZodDefault || current instanceof ZodCatch)
			current = current._def.innerType as ZodTypeAny
		else if (current instanceof ZodEffects)
			current = current.innerType() as ZodTypeAny
		else if (current instanceof ZodBranded)
			current = current.unwrap() as ZodTypeAny
		else if (current instanceof ZodReadonly)
			current = current._def.innerType as ZodTypeAny
		else if (current instanceof ZodLazy) current = current.schema as ZodTypeAny
		else if (current instanceof ZodPipeline)
			current = current._def.in as ZodTypeAny
		else return current
	}
	return current
}

function zodOptions(schema: ZodTypeAny): ZodTypeAny[] {
	if (schema instanceof ZodUnion)
		return [...(schema.options as readonly ZodTypeAny[])]
	if (schema instanceof ZodDiscriminatedUnion)
		return [...(schema.options as readonly ZodTypeAny[])]
	if (schema instanceof ZodIntersection)
		return [schema._def.left as ZodTypeAny, schema._def.right as ZodTypeAny]
	return []
}

function zodShapeNames(schema: ZodTypeAny, depth = 0): string[] {
	const inner = unwrapZod(schema)
	if (inner instanceof ZodObject) return Object.keys(inner.shape as object)
	if (depth >= MAX_DESCRIBE_DEPTH) return []
	const names = new Set<string>()
	for (const option of zodOptions(inner))
		for (const name of zodShapeNames(option, depth + 1)) names.add(name)
	return [...names]
}

interface ZodCheck {
	kind: string
	value?: number
	inclusive?: boolean
}

function zodChecks(schema: ZodNumber | ZodString): ZodCheck[] {
	return (schema._def as { checks: ZodCheck[] }).checks
}

/** Static text for what a Zod schema accepts. `name` adds a unit the name implies. */
export function describeZodSchema(
	schema: ZodTypeAny,
	name?: string,
	depth = 0,
): string {
	const text =
		schema.description !== undefined && schema.description.length > 0
			? schema.description
			: baseZodDescription(unwrapZod(schema), depth)
	return withUnit(text, name)
}

function baseZodDescription(schema: ZodTypeAny, depth: number): string {
	if (schema.description !== undefined && schema.description.length > 0)
		return schema.description
	if (schema instanceof ZodString) {
		let min: number | undefined
		let max: number | undefined
		const formats: string[] = []
		for (const check of zodChecks(schema)) {
			if (check.kind === "min") min = check.value
			else if (check.kind === "max") max = check.value
			else if (check.kind === "length") min = max = check.value
			else if (check.kind === "regex") formats.push("required format")
			else if (
				!["trim", "toLowerCase", "toUpperCase", "includes"].includes(check.kind)
			)
				formats.push(check.kind)
		}
		const kind =
			formats.length > 0
				? `string (${[...new Set(formats)].join(", ")})`
				: "string"
		return `${kind}${lengthBounds("characters", min, max)}`
	}
	if (schema instanceof ZodNumber) {
		let min: number | undefined
		let max: number | undefined
		let minEx = false
		let maxEx = false
		let int = false
		for (const check of zodChecks(schema)) {
			if (check.kind === "int") int = true
			else if (check.kind === "min" && check.value !== undefined) {
				min = check.value
				minEx = check.inclusive === false
			} else if (check.kind === "max" && check.value !== undefined) {
				max = check.value
				maxEx = check.inclusive === false
			}
		}
		return `${int ? "integer" : "number"}${bounds(min, max, minEx, maxEx)}`
	}
	if (schema instanceof ZodBoolean) return "boolean"
	if (schema instanceof ZodNull) return "null"
	if (schema instanceof ZodDate) return "date"
	if (schema instanceof ZodLiteral) return literal(schema.value)
	if (schema instanceof ZodEnum)
		return `one of ${(schema.options as readonly unknown[]).map(literal).join(" | ")}`
	if (schema instanceof ZodNativeEnum) {
		const values = Object.values(schema.enum as Record<string, unknown>)
		return `one of ${values.map(literal).join(" | ")}`
	}
	if (schema instanceof ZodArray) {
		const def = schema._def as {
			minLength: { value: number } | null
			maxLength: { value: number } | null
			exactLength: { value: number } | null
		}
		const exact = def.exactLength?.value
		const of =
			depth < MAX_DESCRIBE_DEPTH
				? ` of ${describeZodSchema(schema.element as ZodTypeAny, undefined, depth + 1)}`
				: ""
		return `array${of}${lengthBounds(
			"items",
			exact ?? def.minLength?.value,
			exact ?? def.maxLength?.value,
		)}`
	}
	if (schema instanceof ZodTuple) return "array"
	if (schema instanceof ZodRecord) return "object"
	if (schema instanceof ZodObject) {
		const names = Object.keys(schema.shape as object)
		return names.length > 0
			? `object with fields ${listNames(names)}`
			: "object"
	}
	const options = zodOptions(schema)
	if (options.length > 0 && depth < MAX_DESCRIBE_DEPTH) {
		if (schema instanceof ZodIntersection) {
			const names = zodShapeNames(schema)
			return names.length > 0
				? `object with fields ${listNames(names)}`
				: "object"
		}
		return [
			...new Set(options.map(o => describeZodSchema(o, undefined, depth + 1))),
		].join(" or ")
	}
	return "a valid value"
}

function zodChild(
	schema: ZodTypeAny,
	segment: string | number,
	depth = 0,
): { schema: ZodTypeAny | undefined; named: boolean } {
	const inner = unwrapZod(schema)
	if (inner instanceof ZodObject) {
		const shape = inner.shape as Record<string, ZodTypeAny>
		if (typeof segment === "string" && Object.hasOwn(shape, segment))
			return { schema: shape[segment], named: true }
		const catchall = inner._def.catchall as ZodTypeAny
		const typeName = (catchall._def as { typeName?: string }).typeName
		return typeName === "ZodNever"
			? { schema: undefined, named: false }
			: { schema: catchall, named: false }
	}
	if (inner instanceof ZodArray && typeof segment === "number")
		return { schema: inner.element as ZodTypeAny, named: true }
	if (inner instanceof ZodTuple && typeof segment === "number") {
		const items = inner.items as readonly ZodTypeAny[]
		return { schema: items[segment], named: true }
	}
	if (inner instanceof ZodRecord)
		return { schema: inner.valueSchema as ZodTypeAny, named: false }
	if (depth < MAX_DESCRIBE_DEPTH)
		for (const option of zodOptions(inner)) {
			const found = zodChild(option, segment, depth + 1)
			if (found.named) return found
		}
	return { schema: undefined, named: false }
}

function walkZod(
	root: ZodTypeAny,
	segments: readonly (string | number)[],
): { path: string[]; schema: ZodTypeAny | undefined; complete: boolean } {
	const path: string[] = []
	let schema: ZodTypeAny | undefined = root
	for (const segment of segments) {
		if (schema === undefined) return { path, schema, complete: false }
		const child = zodChild(schema, segment)
		if (!child.named && child.schema === undefined)
			return { path, schema, complete: false }
		path.push(child.named ? String(segment) : "*")
		schema = child.schema
	}
	return { path, schema, complete: true }
}

/**
 * A refinement collects at most this many submitted values to compare its message with
 * (and walks at most MAX_INPUT_DEPTH levels): a refinement message is shown only when no
 * collected value appears in it. Past either bound the message is dropped (safe default).
 */
const MAX_INPUT_VALUES = 256
const MAX_INPUT_DEPTH = 6

/** Strings, numbers and keys of `input` (bounded); null when past a bound. */
function submittedValues(input: unknown): string[] | null {
	const out: string[] = []
	const visit = (value: unknown, depth: number): boolean => {
		if (out.length > MAX_INPUT_VALUES || depth > MAX_INPUT_DEPTH) return false
		if (typeof value === "string" || typeof value === "number") {
			out.push(String(value))
			return true
		}
		if (typeof value !== "object" || value === null) return true
		for (const [key, child] of Object.entries(value)) {
			if (!Array.isArray(value)) out.push(key)
			if (!visit(child, depth + 1)) return false
		}
		return true
	}
	return visit(input, 0) && out.length <= MAX_INPUT_VALUES ? out : null
}

/** Plain words only: no digits, quotes, brackets or markup, so no value can hide in it. */
const PLAIN_RULE = /^[A-Za-z][A-Za-z ,.;:/()-]*$/

/**
 * A custom refinement's message ("noise squelch requires nfm or wfm modulation") when it
 * reads as fixed server text: plain words (PLAIN_RULE), and no submitted string, number or
 * unknown key appears in it (case-insensitive). Some refinements interpolate a value, and a
 * merged-config refinement can quote stored state, so anything else is dropped.
 */
function refinementRule(
	message: string,
	input: unknown,
	known: ReadonlySet<string>,
): string | null {
	if (input === undefined || message.length > 200 || !PLAIN_RULE.test(message))
		return null
	const values = submittedValues(input)
	if (values === null) return null
	const lower = message.toLowerCase()
	return values.some(
		v => v.length > 0 && !known.has(v) && lower.includes(v.toLowerCase()),
	)
		? null
		: message
}

/**
 * Fields for a Zod failure of `schema`, described from the schema walked along each issue
 * path. Zod's own messages are not used: some quote the received value or an unknown key.
 * A custom refinement's message is added only when `input` (the submitted value) is given
 * and none of its values appears in it. `expected` overrides the description of a field.
 */
export function zodValidationFields(
	error: ZodError,
	schema: ZodTypeAny,
	options: {
		part?: RequestPart
		expected?: Readonly<Record<string, string>>
		input?: unknown
	} = {},
): ValidationField[] {
	const part = options.part ?? "body"
	const fields = new Map<string, string>()
	// Schema field names a refinement may mention ("modulation"); a client's key may not.
	const known = new Set(zodShapeNames(schema))
	for (const issue of error.issues) {
		if (fields.size >= MAX_VALIDATION_FIELDS) break
		const walked = walkZod(schema, issue.path)
		const at = walked.path.length > 0 ? walked.path.join(".") : part
		if (fields.has(at)) continue
		const override = options.expected?.[at]
		if (override !== undefined) {
			fields.set(at, override)
			continue
		}
		const target = walked.complete ? walked.schema : undefined
		if (issue.code === "unrecognized_keys" && walked.schema !== undefined) {
			const names = zodShapeNames(walked.schema)
			fields.set(
				at,
				names.length > 0 ? `only the fields ${listNames(names)}` : "no fields",
			)
			continue
		}
		const name = walked.path.at(-1)
		const description =
			target !== undefined
				? describeZodSchema(target, name)
				: walked.schema !== undefined
					? describeZodSchema(walked.schema, name)
					: "a valid value"
		const required =
			issue.code === "invalid_type" && issue.received === "undefined"
		const rule =
			issue.code === "custom"
				? refinementRule(issue.message, options.input, known)
				: null
		fields.set(
			at,
			required
				? `required; ${description}`
				: rule !== null
					? `${description}; ${rule}`
					: description,
		)
	}
	return [...fields].map(([field, expected]) => ({ field, expected }))
}

/** The 400 body for a Zod failure of `schema`. */
export function zodValidationBody(
	error: ZodError,
	schema: ZodTypeAny,
	options: {
		part?: RequestPart
		expected?: Readonly<Record<string, string>>
		input?: unknown
		error?: string
		code?: string
	} = {},
): ValidationErrorBody {
	const part = options.part ?? "body"
	return validationErrorBody(
		part,
		zodValidationFields(error, schema, options),
		{
			...(options.error !== undefined ? { error: options.error } : {}),
			...(options.code !== undefined ? { code: options.code } : {}),
		},
	)
}
