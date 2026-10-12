import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"
import { ActivityQueryInvalidError } from "../../../../../src/core/activity/query/errors.js"
import {
	compileFtsMatch,
	isQuotedFtsMatch,
} from "../../../../../src/core/activity/query/fts.js"
import {
	hashQuery,
	normaliseQuery,
} from "../../../../../src/core/activity/query/validate.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../../../src/core/activity/query/service.js"

const limits = {
	textBytes: DEFAULT_ACTIVITY_QUERY_LIMITS.textBytes,
	ftsTokens: DEFAULT_ACTIVITY_QUERY_LIMITS.ftsTokens,
}

function matchOf(text: string): string | null {
	return compileFtsMatch(text, limits)
}

describe("activity FTS compilation", () => {
	const dir = mkdtempSync(join(tmpdir(), "wavekit-activity-fts-"))
	const db = new DatabaseSync(join(dir, "fts.db"))
	db.exec(
		"CREATE VIRTUAL TABLE activity_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
	)
	db.prepare("INSERT INTO activity_fts(rowid, text) VALUES (1, ?)").run("alpha")
	const probe = db.prepare(
		"SELECT rowid FROM activity_fts WHERE activity_fts MATCH ?",
	)

	afterAll(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})

	it("quotes operators so they cannot change the query", () => {
		const match = matchOf("alpha OR beta")
		expect(match).toBe('"alpha" "OR" "beta"')
		expect(isQuotedFtsMatch(match ?? "", 8)).toBe(true)
		expect(probe.all('"alpha"').length).toBeGreaterThan(0)
		expect(probe.all(match).length).toBe(0)
	})

	it("treats punctuation-only text as no tokens", () => {
		expect(matchOf("...")).toBeNull()
		expect(matchOf("   ")).toBeNull()
		expect(matchOf("")).toBeNull()
	})

	it("rejects text past the byte and token caps", () => {
		expect(() => matchOf("a".repeat(257))).toThrow(ActivityQueryInvalidError)
		expect(() => matchOf("one two three four five six seven eight nine")).toThrow(
			ActivityQueryInvalidError,
		)
	})

	it("hashes equivalent tokenisations together and keeps case distinct", () => {
		const hello = hashQuery(normaliseQuery({ text: "Hello" }, DEFAULT_ACTIVITY_QUERY_LIMITS))
		const punctuated = hashQuery(
			normaliseQuery({ text: "Hello," }, DEFAULT_ACTIVITY_QUERY_LIMITS),
		)
		const lower = hashQuery(normaliseQuery({ text: "hello" }, DEFAULT_ACTIVITY_QUERY_LIMITS))
		const dots = hashQuery(normaliseQuery({ text: "..." }, DEFAULT_ACTIVITY_QUERY_LIMITS))
		const bangs = hashQuery(normaliseQuery({ text: "!!!" }, DEFAULT_ACTIVITY_QUERY_LIMITS))
		expect(hello).toBe(punctuated)
		expect(lower).not.toBe(hello)
		expect(dots).toBe(bangs)
	})

	it("rejects an unpaired surrogate as an invalid query rather than a TypeError", () => {
		expect(() => matchOf("\uD800")).not.toThrow(TypeError)
	})

	// Feature: event-foundation-batch1, Property 1: FTS escaping
	it("keeps arbitrary text inside quoted phrases that FTS can execute", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ maxLength: 300 }), async text => {
				let match: string | null
				try {
					match = compileFtsMatch(text, limits)
				} catch (error) {
					expect(error).toBeInstanceOf(ActivityQueryInvalidError)
					return
				}
				if (match === null) return
				expect(isQuotedFtsMatch(match, limits.ftsTokens)).toBe(true)
				expect(match.includes(" OR ") || match.startsWith("OR ")).toBe(false)
				expect(() => probe.all(match)).not.toThrow()
			}),
			{ numRuns: 100 },
		)
	}, 10_000)
})
