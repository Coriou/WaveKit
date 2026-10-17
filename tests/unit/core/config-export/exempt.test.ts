import { z } from "zod"
import { describe, expect, it } from "vitest"
import { CONFIG_EXPORT_REDACTED } from "@wavekit/api-types"
import { ConfigSchema } from "../../../../src/config.js"
import {
	CONFIG_EXPORT_SENSITIVE_NAME_EXEMPT_PATHS,
	SENSITIVE_KEY_PATTERN,
	redactWithSchema,
} from "../../../../src/core/config-export/export.js"

type Node = z.ZodTypeAny

function unwrap(schema: Node): Node {
	let s: Node = schema
	for (let i = 0; i < 32; i += 1) {
		if (
			s instanceof z.ZodDefault ||
			s instanceof z.ZodOptional ||
			s instanceof z.ZodNullable
		)
			s = (s._def as { innerType: Node }).innerType
		else if (s instanceof z.ZodEffects) s = s.innerType() as Node
		else return s
	}
	return s
}

function isNumeric(schema: Node): boolean {
	const s = unwrap(schema)
	if (s instanceof z.ZodNumber) return true
	return s instanceof z.ZodArray && unwrap(s.element) instanceof z.ZodNumber
}

/** Every schema key the pattern matches, with its dotted path and whether it is numeric. */
function matchedKeys(): { path: string; numeric: boolean }[] {
	const found: { path: string; numeric: boolean }[] = []
	const visit = (schema: Node, path: string[]): void => {
		const s = unwrap(schema)
		if (s instanceof z.ZodObject) {
			for (const [k, v] of Object.entries(s.shape as Record<string, Node>)) {
				if (SENSITIVE_KEY_PATTERN.test(k))
					found.push({ path: [...path, k].join("."), numeric: isNumeric(v) })
				visit(v, [...path, k])
			}
		} else if (s instanceof z.ZodArray) visit(s.element as Node, [...path, "*"])
		else if (s instanceof z.ZodRecord)
			visit(s.valueSchema as Node, [...path, "*"])
	}
	visit(ConfigSchema, [])
	return found
}

/** Nested object for a dotted path (`*` becomes a one-element array) holding `leaf`. */
function build(path: string, leaf: unknown): Record<string, unknown> {
	const segments = path.split(".")
	let node: unknown = leaf
	for (let i = segments.length - 1; i >= 0; i -= 1) {
		const seg = segments[i] as string
		if (seg === "*") continue
		const wrapped: unknown = segments[i + 1] === "*" ? [node] : node
		node = { [seg]: wrapped }
	}
	return node as Record<string, unknown>
}

function exported(path: string, leaf: unknown): unknown {
	return redactWithSchema(build(path, leaf), ConfigSchema)
}

function pick(tree: unknown, path: string): unknown {
	let cur: unknown = tree
	for (const seg of path.split(".")) {
		if (cur === undefined || cur === null) return undefined
		cur = Array.isArray(cur)
			? cur[seg === "*" ? 0 : Number(seg)]
			: (cur as Record<string, unknown>)[seg]
	}
	return cur
}

const NUMBER_LEAF = (path: string): unknown =>
	path.endsWith("targetsHz") ? [118_000_000, 136_000_000] : 3

describe("sensitive-name exemptions (WG7 10.3)", () => {
	const exempt = CONFIG_EXPORT_SENSITIVE_NAME_EXEMPT_PATHS

	it("lists exactly the numeric keys the pattern matches by accident", () => {
		const numeric = matchedKeys()
			.filter(k => k.numeric)
			.map(k => k.path)
			.sort()
		expect([...exempt].sort()).toEqual(numeric)
	})

	it("every exempt path exists in the schema and is typed as a number", () => {
		const keys = new Map(matchedKeys().map(k => [k.path, k.numeric]))
		for (const p of exempt) expect(keys.get(p)).toBe(true)
	})

	it.each([...exempt])("%s exports its finite number", path => {
		const leaf = NUMBER_LEAF(path)
		expect(pick(exported(path, leaf), path)).toEqual(leaf)
	})

	it.each([...exempt])("%s stays redacted for non-number values", path => {
		for (const bad of [
			"secret-text",
			{ a: 1 },
			[1, "x"],
			[{ a: 1 }],
			true,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			[1, Number.NEGATIVE_INFINITY],
		]) {
			const out = pick(exported(path, bad), path)
			expect(JSON.stringify(out)).not.toContain("secret-text")
			expect(out).not.toEqual(bad)
			expect(JSON.stringify(out) ?? "").toContain(CONFIG_EXPORT_REDACTED)
		}
	})

	it("keeps the value bound: extreme finite numbers export, an empty array exports", () => {
		const p = "decoders.*.band.targetsHz"
		expect(pick(exported(p, [Number.MAX_SAFE_INTEGER]), p)).toEqual([
			Number.MAX_SAFE_INTEGER,
		])
		expect(pick(exported(p, []), p)).toEqual([])
		const q = "tunerRelay.commandHistoryLimit"
		expect(pick(exported(q, 0), q)).toBe(0)
		expect(pick(exported(q, Number.MAX_VALUE), q)).toBe(Number.MAX_VALUE)
	})

	it("redacts similar names that are not listed", () => {
		for (const path of [
			"tunerRelay.commandLine",
			"liveDemod.targetHost",
			"scanner.detection.otherMargin",
			"decoders.*.band.targetsHzExtra",
			"scanner.ws.profilesDir",
		]) {
			const out = redactWithSchema(build(path, 5), ConfigSchema)
			expect(JSON.stringify(out)).not.toContain("5")
		}
	})

	it("every other schema key the pattern matches stays redacted", () => {
		for (const k of matchedKeys().filter(k => !exempt.includes(k.path))) {
			expect(exempt).not.toContain(k.path)
		}
	})

	it("does not exempt decoder options", () => {
		const out = redactWithSchema(
			{
				decoders: [
					{ type: "x", options: { targetsHz: [1], commandHistoryLimit: 5 } },
				],
			},
			ConfigSchema,
		)
		const options = (
			out as { decoders: { options: Record<string, unknown> }[] }
		).decoders[0]?.options
		expect(JSON.stringify(options)).not.toContain("[1]")
	})
})
