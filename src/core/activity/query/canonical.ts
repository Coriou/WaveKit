import { createHash } from "node:crypto"

/** Canonical JSON: sorted object keys, arrays keep their already-normal order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(",")}]`
	}
	const record = value as Record<string, unknown>
	const keys = Object.keys(record).sort()
	const body = keys
		.filter(key => record[key] !== undefined)
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")
	return `{${body}}`
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}
