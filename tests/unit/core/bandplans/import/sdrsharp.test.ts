import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { BANDPLANS_LIMITS, storedBandSchema } from "@wavekit/api-types"
import type { DisplayGroup } from "@wavekit/api-types"
import { parseSdrSharpBandPlan } from "../../../../../src/core/bandplans/import/sdrsharp.js"

const encoder = new TextEncoder()
const fixturePath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../mocks/fixtures/bandplans/sdrsharp/BandPlan.xml",
)

const options = {
	fileName: "BandPlan.xml",
	overrides: new Map<string, DisplayGroup>(),
}

function parseText(text: string) {
	return parseSdrSharpBandPlan(encoder.encode(text), options)
}

function row(name: string, min = 1000, max = 2000, extra = ""): string {
	return `<RangeEntry minFrequency="${min}" maxFrequency="${max}" mode="NFM" step="12500" color="FF112233"${extra}>${name}</RangeEntry>`
}

function doc(rows: readonly string[], prolog = ""): string {
	return `${prolog}<ArrayOfRangeEntry>${rows.join("\n")}</ArrayOfRangeEntry>`
}

function rowsOf(count: number): string[] {
	return Array.from({ length: count }, (_, index) =>
		row(`B${index}`, 1000 + index * 10, 1005 + index * 10),
	)
}

function expectInvalid(text: string | Uint8Array, reason: string): void {
	const bytes = typeof text === "string" ? encoder.encode(text) : text
	const result = parseSdrSharpBandPlan(bytes, options)
	expect(result).toEqual({
		ok: false,
		code: "BANDPLANS_IMPORT_INVALID",
		reason,
	})
}

function accepted(text: string) {
	const result = parseText(text)
	if (!result.ok) throw new Error(`expected preview, got ${result.reason}`)
	return result.value
}

/** Pads `text` with trailing comments to exactly `target` bytes (ASCII). */
function padTo(text: string, target: number): string {
	let out = text
	while (target - out.length > 0) {
		const room = target - out.length
		if (room < 7) throw new Error("pad")
		const body = Math.min(4000, room - 7)
		const rest = room - 7 - body
		// Avoid leaving a remainder below the 7-byte minimum comment.
		const size = rest > 0 && rest < 7 ? body - 7 : body
		out += `<!--${"x".repeat(size)}-->`
	}
	return out
}

describe("parseSdrSharpBandPlan: fixture and mapping", () => {
	it("reads the synthetic BandPlan.xml", () => {
		const parsed = parseSdrSharpBandPlan(readFileSync(fixturePath), options)
		if (!parsed.ok) throw new Error(parsed.reason)
		const { preview, bands } = parsed.value
		expect(preview.format).toBe("sdrsharp-xml")
		expect(preview.meta).toEqual({
			name: null,
			countryName: null,
			countryCode: null,
			author: null,
			version: null,
		})
		expect(bands.map(band => band.name)).toEqual([
			"2200m Ham Band",
			"MW Broadcast",
			"80m Ham Band",
			"20m Ham & Contest",
			"FM Broadcast",
			"Air Band",
			"2m Ham Band",
			"Marine VHF",
			"ISM 433 – LPD",
		])
		expect(bands[0]).toMatchObject({
			startHz: 135000,
			endHz: 137800,
			mode: "cw",
			stepHz: 100,
			colourHint: "#4682b4",
			bandwidthHz: null,
		})
		expect(bands[2]?.colourHint).toBe("#b0c4de")
		expect(bands[3]).toMatchObject({
			startHz: 14000000,
			endHz: 14350000,
			mode: "usb",
			stepHz: 1000,
			colourHint: "#dda0dd",
		})
		expect(bands[4]?.mode).toBe("wfm")
		expect(bands[6]?.mode).toBe("nfm")
		for (const band of bands)
			expect(storedBandSchema.safeParse(band).success).toBe(true)
		expect(preview.report.rowsTotal).toBe(12)
		expect(preview.report.accepted).toBe(9)
		expect(
			Object.fromEntries(
				preview.report.skipped.map(entry => [entry.reason, entry.count]),
			),
		).toEqual({ unnamed: 1, "invalid-edges": 1, "malformed-row": 1 })
	})

	it("accepts attributes in any order, extra attributes and namespace prefixes", () => {
		const value = accepted(
			`<?xml version="1.0"?>\n<x:ArrayOfRangeEntry xmlns:x="urn:a" a='1'><RangeEntry extra="z" color='#AABBCC' maxFrequency='2000' minFrequency = "1000">  Name &lt;&gt;&quot;&apos;&#65;&#x42; </RangeEntry></x:ArrayOfRangeEntry>`,
		)
		expect(value.bands[0]).toMatchObject({
			name: "Name <>\"'AB",
			startHz: 1000,
			endHz: 2000,
			mode: null,
			stepHz: null,
			colourHint: "#aabbcc",
		})
	})

	it("skips non-RangeEntry children as malformed rows and accepts a BOM", () => {
		const value = accepted(
			`﻿${doc([row("A"), "<Other/>", "<Other>t</Other>"])}`,
		)
		expect(value.preview.report.rowsTotal).toBe(3)
		expect(value.preview.report.skipped).toContainEqual({
			reason: "malformed-row",
			count: 2,
		})
	})

	it("treats non-decimal frequencies as malformed rows", () => {
		const value = accepted(
			doc([row("A"), row("B", 1.5 as number), row("C", 1000, -5)]),
		)
		expect(value.bands).toHaveLength(1)
	})

	it("accepts CRLF and mixed line endings", () => {
		const value = accepted(
			`<?xml version="1.0"?>\r\n<ArrayOfRangeEntry>\r\n${row("A")}\n${row("B", 3000, 4000)}\r\n</ArrayOfRangeEntry>\r\n`,
		)
		expect(value.bands).toHaveLength(2)
	})
})

describe("parseSdrSharpBandPlan: bounds at and past", () => {
	it("rows examined 4096 accepted, 4097 row-limit", () => {
		const at = accepted(doc(rowsOf(BANDPLANS_LIMITS.importRows)))
		expect(at.preview.report.rowsTotal).toBe(4096)
		expect(at.bands).toHaveLength(BANDPLANS_LIMITS.bandsPerPack)
		expectInvalid(doc(rowsOf(BANDPLANS_LIMITS.importRows + 1)), "row-limit")
	})

	it("512 bands accepted, the 513th is a pack-band-limit skip", () => {
		expect(accepted(doc(rowsOf(512))).bands).toHaveLength(512)
		const past = accepted(doc(rowsOf(513)))
		expect(past.bands).toHaveLength(512)
		expect(past.preview.report.skipped).toContainEqual({
			reason: "pack-band-limit",
			count: 1,
		})
	})

	it("file of 1 MiB accepted, 1 MiB + 1 byte too large", () => {
		const limit = BANDPLANS_LIMITS.importFileBytes
		expect(limit).toBe(1_048_576)
		const at = padTo(doc(rowsOf(10)), limit)
		expect(at.length).toBe(limit)
		expect(accepted(at).preview.bytes).toBe(limit)
		const bytes = new Uint8Array(limit + 1)
		expect(parseSdrSharpBandPlan(bytes, options)).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_TOO_LARGE",
			reason: "too-large",
		})
	})

	it("depth 4 accepted, depth 5 rejected", () => {
		const nest = (levels: number) =>
			"<a>".repeat(levels) + "</a>".repeat(levels)
		expect(
			accepted(
				doc([
					row("A"),
					`<RangeEntry minFrequency="5000" maxFrequency="6000">N${nest(2)}</RangeEntry>`,
				]),
			).bands,
		).toHaveLength(2)
		expectInvalid(
			doc([
				row("A"),
				`<RangeEntry minFrequency="5000" maxFrequency="6000">N${nest(3)}</RangeEntry>`,
			]),
			"xml",
		)
	})

	it("16 attributes accepted, 17 rejected", () => {
		const extras = (n: number) =>
			Array.from({ length: n }, (_, index) => ` x${index}="v"`).join("")
		// row() carries 5 attributes.
		expect(
			accepted(doc([row("A", 1000, 2000, extras(11))])).bands,
		).toHaveLength(1)
		expectInvalid(doc([row("A", 1000, 2000, extras(12))]), "xml")
	})

	it("attribute value 1024 accepted, 1025 rejected", () => {
		expect(
			accepted(doc([row("A", 1000, 2000, ` pad="${"p".repeat(1024)}"`)])).bands,
		).toHaveLength(1)
		expectInvalid(
			doc([row("A", 1000, 2000, ` pad="${"p".repeat(1025)}"`)]),
			"xml",
		)
	})

	it("text 1024 accepted, 1025 rejected", () => {
		// The name itself is capped at 80 code points, so 1024 is a text-invalid skip.
		const at = accepted(doc([row("A"), row("n".repeat(1024), 3000, 4000)]))
		expect(at.preview.report.skipped).toContainEqual({
			reason: "text-invalid",
			count: 1,
		})
		expectInvalid(doc([row("A"), row("n".repeat(1025), 3000, 4000)]), "xml")
	})

	it("comment 4096 accepted, 4097 rejected", () => {
		expect(
			accepted(doc([`<!--${"c".repeat(4096)}-->`, row("A")])).bands,
		).toHaveLength(1)
		expectInvalid(doc([`<!--${"c".repeat(4097)}-->`, row("A")]), "xml")
	})
})

describe("parseSdrSharpBandPlan: failure paths", () => {
	const valid = doc([row("A")])
	it.each([
		[
			"DOCTYPE internal subset",
			`<?xml version="1.0"?><!DOCTYPE a [<!ELEMENT a ANY>]>${valid}`,
		],
		[
			"DOCTYPE external subset",
			`<!DOCTYPE ArrayOfRangeEntry SYSTEM "http://example.invalid/x.dtd">${valid}`,
		],
		["ENTITY at top", `<!ENTITY x "y">${valid}`],
		[
			"ENTITY inside root",
			doc([`<!ENTITY x SYSTEM "file:///etc/passwd">`, row("A")]),
		],
		[
			"billion laughs",
			`<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><ArrayOfRangeEntry>${row("&lol2;")}</ArrayOfRangeEntry>`,
		],
		["unknown entity &xxe;", doc([row("&xxe;")])],
		[
			"unknown entity in attribute",
			doc([row("A", 1000, 2000, ' mode2="&xxe;"')]),
		],
		["unterminated reference", doc([row("A &amp")])],
		["CDATA", doc([row("<![CDATA[x]]>")])],
		["PI after start", doc([`<?php x ?>`, row("A")])],
		["XML declaration not at start", ` <?xml version="1.0"?>${valid}`],
		["NUL", doc([row("A\u0000")])],
		["C0 control", doc([row("A\u0001")])],
		["C0 in attribute", doc([row("A", 1000, 2000, ' x="\u001f"')])],
		["lone surrogate reference", doc([row("&#xD800;")])],
		["decimal surrogate reference", doc([row("&#57343;")])],
		["control scalar reference", doc([row("&#x1;")])],
		["out of range reference", doc([row("&#x110000;")])],
		["unclosed root", `<ArrayOfRangeEntry>${row("A")}`],
		[
			"unclosed row",
			`<ArrayOfRangeEntry><RangeEntry minFrequency="1" maxFrequency="2">A</ArrayOfRangeEntry>`,
		],
		["mismatched tags", `<ArrayOfRangeEntry>${row("A")}</ArrayOfRange>`],
		["self-closing root", `<ArrayOfRangeEntry/>`],
		["wrong root", `<BandPlan>${row("A")}</BandPlan>`],
		["second root", `${valid}<ArrayOfRangeEntry></ArrayOfRangeEntry>`],
		["text outside root", `${valid}junk`],
		[
			"unquoted attribute",
			`<ArrayOfRangeEntry><RangeEntry minFrequency=1000 maxFrequency="2000">A</RangeEntry></ArrayOfRangeEntry>`,
		],
		["duplicate attribute", doc([row("A", 1000, 2000, ' mode="AM"')])],
		[
			"attribute without space",
			`<ArrayOfRangeEntry><RangeEntry minFrequency="1"maxFrequency="2">A</RangeEntry></ArrayOfRangeEntry>`,
		],
		["double dash in comment", doc(["<!-- a -- b -->", row("A")])],
		["unterminated comment", `${valid}<!-- x`],
		[
			"SDR++ JSON",
			JSON.stringify({ bands: [{ name: "A", type: "x", start: 1, end: 2 }] }),
		],
		["Gqrx CSV", "# Gqrx\n1000,2000,AM,10000,#ff0000,A\n"],
	])("%s -> xml", (_label, text) => {
		expectInvalid(text, "xml")
	})

	it("UTF-16 BE and LE with BOM -> encoding", () => {
		expectInvalid(new Uint8Array([0xfe, 0xff, 0x00, 0x3c]), "encoding")
		expectInvalid(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]), "encoding")
	})

	it("invalid UTF-8 -> encoding", () => {
		const bytes = encoder.encode(valid)
		const broken = new Uint8Array(bytes.length + 1)
		broken.set(bytes)
		broken[bytes.length] = 0xc3
		expectInvalid(broken, "encoding")
	})

	it("empty file, whitespace and only comments -> empty", () => {
		expectInvalid("", "empty")
		expectInvalid('<?xml version="1.0"?>\n  \n', "empty")
		expectInvalid("<!-- a --><!-- b -->", "empty")
	})

	it("a root with no accepted rows -> empty", () => {
		expectInvalid("<ArrayOfRangeEntry></ArrayOfRangeEntry>", "empty")
		expectInvalid(doc([row("")]), "empty")
	})

	it("never echoes content in failures", () => {
		const result = parseText(doc([row("SECRET&xxe;")]))
		expect(JSON.stringify(result)).not.toContain("SECRET")
	})
})
