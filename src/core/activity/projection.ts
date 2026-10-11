import { types } from "node:util"
import { WaveKitError } from "../../utils/errors.js"
import type { JsonValue } from "./types.js"

export const MAX_ENVELOPE_BYTES = 128 * 1024
const MAX_DEPTH = 16
const MAX_NODES = 4096
const MAX_MEMBERS = 256
const MAX_STRING_BYTES = 32 * 1024

export function invalidEnvelope(): never {
	throw new WaveKitError(
		"Invalid decoder event envelope",
		"DECODE_ENVELOPE_INVALID",
	)
}

/** Shallow descriptor boundary. No getter, Proxy trap or custom serializer is read. */
export function ownRecord(
	input: unknown,
	array = false,
): Record<string, unknown> {
	try {
		if (input === null || typeof input !== "object" || types.isProxy(input))
			return invalidEnvelope()
		const prototype: unknown = Object.getPrototypeOf(input)
		if (
			array
				? prototype !== Array.prototype
				: prototype !== null && prototype !== Object.prototype
		)
			return invalidEnvelope()
		const result = Object.create(null) as Record<string, unknown>
		const keys = Reflect.ownKeys(input)
		if (keys.length > MAX_MEMBERS + (array ? 1 : 0)) return invalidEnvelope()
		let members = 0
		for (const key of keys) {
			if (typeof key !== "string") return invalidEnvelope()
			const descriptor = Object.getOwnPropertyDescriptor(input, key)!
			if (!("value" in descriptor)) return invalidEnvelope()
			const value: unknown = descriptor.value
			if (key === "toJSON" && typeof value === "function")
				return invalidEnvelope()
			if (array) {
				if (key === "length") continue
				if (!/^(0|[1-9][0-9]*)$/.test(key)) return invalidEnvelope()
			} else if (!descriptor.enumerable) continue
			if (++members > MAX_MEMBERS) return invalidEnvelope()
			Object.defineProperty(result, key, {
				value,
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		return result
	} catch {
		return invalidEnvelope()
	}
}

/**
 * Complete detached JSON projection, with independent decodedData-root budgets.
 * Node-only Proxy detection precedes reflection. Date support is disabled for wire
 * validation. Omitted undefined members still consume the traversal budget.
 */
export function projectDecodedData(input: unknown): JsonValue {
	return projectJson(input, true, true)
}

/** Internal modes for constructor metadata and strict JSON wire validation. */
export function projectJson(
	input: unknown,
	allowDates: boolean,
	allowUndefined: boolean,
): JsonValue {
	let nodes = 0
	let bytes = 0
	const ancestors = new Set<object>()
	const consume = (size: number): void => {
		bytes += size
		if (bytes > MAX_ENVELOPE_BYTES) invalidEnvelope()
	}
	const quote = (value: string, limit: number): string => {
		if (Buffer.byteLength(value, "utf8") > limit) return invalidEnvelope()
		return JSON.stringify(value)
	}
	const visit = (value: unknown, depth: number): JsonValue | undefined => {
		if (++nodes > MAX_NODES || depth > MAX_DEPTH) return invalidEnvelope()
		if (value === undefined)
			return allowUndefined ? undefined : invalidEnvelope()
		if (typeof value === "string") {
			consume(Buffer.byteLength(quote(value, MAX_STRING_BYTES), "utf8"))
			return value
		}
		if (
			value === null ||
			typeof value === "boolean" ||
			typeof value === "number"
		) {
			if (typeof value === "number" && !Number.isFinite(value))
				return invalidEnvelope()
			consume(Buffer.byteLength(JSON.stringify(value), "utf8"))
			return value === 0 ? 0 : value
		}
		if (typeof value !== "object" || types.isProxy(value))
			return invalidEnvelope()
		if (types.isDate(value)) {
			if (
				!allowDates ||
				Object.getPrototypeOf(value) !== Date.prototype ||
				Reflect.ownKeys(value).length !== 0
			)
				return invalidEnvelope()
			const time = Date.prototype.getTime.call(value)
			if (!Number.isFinite(time)) return invalidEnvelope()
			const iso = Date.prototype.toISOString.call(value)
			consume(Buffer.byteLength(JSON.stringify(iso), "utf8"))
			return iso
		}
		if (ancestors.has(value)) return invalidEnvelope()
		ancestors.add(value)
		try {
			const array = Array.isArray(value)
			const entries = ownRecord(value, array)
			consume(2)
			if (array) {
				const length: unknown = Object.getOwnPropertyDescriptor(
					value,
					"length",
				)?.value
				if (typeof length !== "number" || length > MAX_MEMBERS)
					return invalidEnvelope()
				if (
					Object.keys(entries).some(
						key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length,
					)
				)
					return invalidEnvelope()
				consume(Math.max(0, length - 1))
				const output: JsonValue[] = []
				for (let i = 0; i < length; i++) {
					const member = visit(entries[String(i)], depth + 1)
					if (member === undefined) consume(4)
					output.push(member ?? null)
				}
				return output
			}
			const output = Object.create(null) as Record<string, JsonValue>
			let count = 0
			for (const key of Object.keys(entries)) {
				const encodedKey = quote(key, MAX_MEMBERS)
				const projected = visit(entries[key], depth + 1)
				if (projected === undefined) continue
				consume(
					Buffer.byteLength(encodedKey, "utf8") + 1 + (count++ > 0 ? 1 : 0),
				)
				Object.defineProperty(output, key, {
					value: projected,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			return output
		} finally {
			ancestors.delete(value)
		}
	}
	try {
		return visit(input, 0) ?? (input === null ? null : invalidEnvelope())
	} catch {
		return invalidEnvelope()
	}
}
