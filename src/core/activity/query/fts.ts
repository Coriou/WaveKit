import { ActivityQueryInvalidError } from "./errors.js"

const TOKEN = /[\p{L}\p{N}]+/gu

/**
 * Quote one FTS5 token as a phrase. Internal quotes are doubled so the token
 * cannot close the phrase. Callers must still bind the result as a parameter.
 */
export function quoteFtsToken(token: string): string {
	return `"${token.replaceAll('"', '""')}"`
}

export interface FtsLimits {
	textBytes: number
	ftsTokens: number
}

/**
 * Turn plain text into a MATCH string of quoted tokens.
 * Returns null when the text has no searchable tokens (the caller matches nothing).
 * Never returns user operators, column filters, or prefix stars.
 */
export function compileFtsMatch(text: string, limits: FtsLimits): string | null {
	if (Buffer.byteLength(text, "utf8") > limits.textBytes) {
		throw new ActivityQueryInvalidError(
			`Text query exceeds ${limits.textBytes} UTF-8 bytes`,
		)
	}
	let tokens: string[]
	try {
		tokens = text.match(TOKEN) ?? []
	} catch {
		throw new ActivityQueryInvalidError("Text query is not valid Unicode")
	}
	if (tokens.length === 0) return null
	if (tokens.length > limits.ftsTokens) {
		throw new ActivityQueryInvalidError(
			`Text query has more than ${limits.ftsTokens} tokens`,
		)
	}
	return tokens.map(quoteFtsToken).join(" ")
}

/** True when `match` is only space-separated quoted phrases. */
export function isQuotedFtsMatch(match: string, maxTokens: number): boolean {
	let index = 0
	let phrases = 0
	while (index < match.length) {
		if (match[index] !== '"') return false
		index += 1
		let closed = false
		while (index < match.length) {
			if (match[index] === '"') {
				const next = match[index + 1]
				if (next === '"') {
					index += 2
					continue
				}
				index += 1
				closed = true
				break
			}
			index += 1
		}
		if (!closed) return false
		phrases += 1
		if (index === match.length) break
		if (match[index] !== " ") return false
		index += 1
		if (index >= match.length) return false
	}
	return phrases > 0 && phrases <= maxTokens
}
