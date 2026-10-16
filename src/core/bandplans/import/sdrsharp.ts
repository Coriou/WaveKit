/**
 * Total parser for SDR# `BandPlan.xml` bytes (web-gaps-5 req 7.2-7.5). Never
 * throws. Oversized input is rejected before decoding. The tokenizer is hand
 * written, single pass and bounded: constant work per character, no DTD, no
 * entity declarations, no CDATA, no processing instruction after the start.
 * Failure reasons are fixed tokens and never include file content.
 */
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type { ImportSkipReason } from "@wavekit/api-types"
import type { BandPlanImportParser } from "../contract.js"
import {
	assembleImport,
	decodeStrictUtf8,
	invalid,
	tooLarge,
} from "./group-map.js"
import type { RawImportRow } from "./group-map.js"

/** Bounds from the design ("Band-plan import of SDR# and Gqrx"). */
export const SDRSHARP_LIMITS = Object.freeze({
	commentChars: 4_096,
	maxDepth: 4,
	maxAttributes: 16,
	attributeChars: 1_024,
	textChars: 1_024,
	nameChars: 128,
	declarationChars: 256,
	referenceChars: 12,
})

/**
 * `<?xml version="1.x" [encoding="UTF-8"] [standalone="yes|no"] ?>`, either
 * quote style; the encoding name is matched case-insensitively.
 */
const XML_DECLARATION =
	/^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>$/

const ROOT = "ArrayOfRangeEntry"
const ROW = "RangeEntry"

/** Internal signal for a malformed or forbidden construct; caught in this module only. */
class XmlReject {
	constructor(readonly reason: "xml" | "row-limit") {}
}

interface Attribute {
	readonly name: string
	readonly value: string
}

type Entry = RawImportRow | ImportSkipReason

export const parseSdrSharpBandPlan: BandPlanImportParser = (bytes, options) => {
	try {
		if (bytes.length > BANDPLANS_LIMITS.importFileBytes) return tooLarge()
		if (isUtf16Bom(bytes)) return invalid("encoding")
		const text = decodeStrictUtf8(bytes)
		if (text === null) return invalid("encoding")
		const read = readDocument(text)
		if (read === null) return invalid("empty")
		if (read instanceof XmlReject) return invalid(read.reason)
		return assembleImport(read.entries, {
			format: "sdrsharp-xml",
			bytes,
			fileName: options.fileName,
			overrides: options.overrides,
			rowsExamined: read.entries.length,
		})
	} catch {
		return invalid("shape")
	}
}

function isUtf16Bom(bytes: Uint8Array): boolean {
	const b0 = bytes[0]
	const b1 = bytes[1]
	return (b0 === 0xfe && b1 === 0xff) || (b0 === 0xff && b1 === 0xfe)
}

/** `null` when the document holds no element at all (empty, whitespace or comments only). */
function readDocument(
	text: string,
): { entries: readonly Entry[] } | XmlReject | null {
	try {
		return new Tokenizer(text).run()
	} catch (error: unknown) {
		if (error instanceof XmlReject) return error
		throw error
	}
}

function reject(): never {
	throw new XmlReject("xml")
}

function isSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

/** XML 1.0 Char minus the controls this importer refuses. */
function isAllowedChar(code: number): boolean {
	if (code < 0x20) return code === 0x09 || code === 0x0a || code === 0x0d
	return code !== 0xfffe && code !== 0xffff
}

function isNameStart(code: number): boolean {
	return (
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x5f
	)
}

function isNameChar(code: number): boolean {
	return (
		isNameStart(code) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2d ||
		code === 0x2e
	)
}

/** Attribute-value normalisation: tab, CR and LF read as a space. */
function normaliseSpace(text: string): string {
	return text.replace(/[\t\n\r]/g, " ")
}

/** A scalar a numeric reference may name: no controls, surrogates or non-characters. */
function isReferableScalar(code: number): boolean {
	if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
	if (code >= 0xd800 && code <= 0xdfff) return false
	if (code === 0xfffe || code === 0xffff) return false
	return code <= 0x10ffff
}

class Tokenizer {
	private pos = 0
	private readonly stack: string[] = []
	/**
	 * Length of each open element's current character-data run: comments do
	 * not split a run, a child element does.
	 */
	private readonly textLengths: number[] = []
	private readonly entries: Entry[] = []
	private rootSeen = false
	private rootClosed = false
	/** Attributes and text of the open `RangeEntry` (depth 2), if any. */
	private row: { attrs: readonly Attribute[]; name: string } | null = null

	constructor(private readonly s: string) {}

	run(): { entries: readonly Entry[] } | null {
		const s = this.s
		if (s.startsWith("<?xml")) this.declaration()
		while (this.pos < s.length) {
			const code = s.charCodeAt(this.pos)
			if (code === 0x3c) this.markup()
			else this.text()
		}
		if (!this.rootSeen) return null
		if (!this.rootClosed) reject()
		return { entries: this.entries }
	}

	private declaration(): void {
		const s = this.s
		const start = this.pos
		this.pos += 5
		for (;;) {
			if (this.pos - start > SDRSHARP_LIMITS.declarationChars) reject()
			if (this.pos >= s.length) reject()
			if (
				s.charCodeAt(this.pos) === 0x3f &&
				s.charCodeAt(this.pos + 1) === 0x3e
			) {
				this.pos += 2
				break
			}
			this.pos++
		}
		// Bounded by declarationChars, so the pattern runs on a short string.
		if (!XML_DECLARATION.test(s.slice(start, this.pos))) reject()
	}

	private markup(): void {
		const s = this.s
		const next = s.charCodeAt(this.pos + 1)
		if (next === 0x21) {
			if (s.startsWith("<!--", this.pos)) this.comment()
			else reject() // DOCTYPE, ENTITY, CDATA and every other `<!`
		} else if (next === 0x3f) {
			reject() // processing instruction after the start
		} else if (next === 0x2f) {
			this.endTag()
		} else {
			this.startTag()
		}
	}

	private comment(): void {
		const s = this.s
		this.pos += 4
		const start = this.pos
		for (;;) {
			if (this.pos >= s.length) reject()
			const code = s.charCodeAt(this.pos)
			if (code === 0x2d && s.charCodeAt(this.pos + 1) === 0x2d) {
				if (s.charCodeAt(this.pos + 2) !== 0x3e) reject()
				if (this.pos - start > SDRSHARP_LIMITS.commentChars) reject()
				this.pos += 3
				return
			}
			if (!isAllowedChar(code)) reject()
			this.pos++
			if (this.pos - start > SDRSHARP_LIMITS.commentChars) reject()
		}
	}

	private text(): void {
		const s = this.s
		const top = this.stack.length
		const outside = top === 0
		const keep = this.row !== null && top === 2
		let out = ""
		let length = outside ? 0 : (this.textLengths[top - 1] ?? 0)
		let segment = this.pos
		while (this.pos < s.length) {
			const code = s.charCodeAt(this.pos)
			if (code === 0x3c || code === 0x26) {
				if (keep) out += s.slice(segment, this.pos)
				if (code === 0x3c) break
				if (outside) reject() // no character data, references included, outside the root
				const piece = this.reference()
				length += piece.length
				if (keep) out += piece
				segment = this.pos
			} else {
				if (!isAllowedChar(code)) reject()
				if (outside && !isSpace(code)) reject()
				if (code === 0x3e && s.startsWith("]]>", this.pos - 2)) reject()
				this.pos++
				length++
			}
			if (length > SDRSHARP_LIMITS.textChars) reject()
		}
		if (!outside) this.textLengths[top - 1] = length
		if (keep && segment < this.pos && this.pos >= s.length)
			out += s.slice(segment, this.pos)
		if (this.row !== null && top === 2) {
			const name = this.row.name + out
			if (name.length > SDRSHARP_LIMITS.textChars) reject()
			this.row.name = name
		}
	}

	/** Decodes one reference at `pos` (on `&`); returns its text. */
	private reference(): string {
		const s = this.s
		const start = this.pos
		const limit = Math.min(s.length, start + SDRSHARP_LIMITS.referenceChars)
		let end = start + 1
		while (end < limit && s.charCodeAt(end) !== 0x3b) end++
		if (end >= limit) reject()
		const body = s.slice(start + 1, end)
		this.pos = end + 1
		switch (body) {
			case "amp":
				return "&"
			case "lt":
				return "<"
			case "gt":
				return ">"
			case "quot":
				return '"'
			case "apos":
				return "'"
		}
		let code: number
		// Leading zeros are legal; the scalar value, not the digit count, decides.
		if (/^#[0-9]+$/.test(body)) code = Number.parseInt(body.slice(1), 10)
		else if (/^#x[0-9a-fA-F]+$/.test(body))
			code = Number.parseInt(body.slice(2), 16)
		else reject() // unknown entity
		if (!isReferableScalar(code)) reject()
		return String.fromCodePoint(code)
	}

	private qualifiedName(): string {
		const s = this.s
		const start = this.pos
		if (!isNameStart(s.charCodeAt(this.pos))) reject()
		this.pos++
		let colon = false
		for (;;) {
			const code = s.charCodeAt(this.pos)
			if (isNameChar(code)) this.pos++
			else if (code === 0x3a && !colon) {
				colon = true
				this.pos++
				if (!isNameStart(s.charCodeAt(this.pos))) reject()
			} else break
			if (this.pos - start > SDRSHARP_LIMITS.nameChars) reject()
		}
		return s.slice(start, this.pos)
	}

	private skipSpace(): boolean {
		const s = this.s
		const start = this.pos
		while (this.pos < s.length && isSpace(s.charCodeAt(this.pos))) this.pos++
		return this.pos > start
	}

	private startTag(): void {
		const s = this.s
		if (this.rootClosed) reject()
		this.pos++
		const qualified = this.qualifiedName()
		const name = localName(qualified)
		const attrs: Attribute[] = []
		let selfClosing = false
		for (;;) {
			const spaced = this.skipSpace()
			const code = s.charCodeAt(this.pos)
			if (code === 0x3e) {
				this.pos++
				break
			}
			if (code === 0x2f) {
				if (s.charCodeAt(this.pos + 1) !== 0x3e) reject()
				this.pos += 2
				selfClosing = true
				break
			}
			if (!spaced) reject()
			attrs.push(this.attribute(attrs))
			if (attrs.length > SDRSHARP_LIMITS.maxAttributes) reject()
		}
		const depth = this.stack.length + 1
		if (depth > SDRSHARP_LIMITS.maxDepth) reject()
		if (depth === 1) {
			if (name !== ROOT || selfClosing) reject()
			this.rootSeen = true
		} else if (depth === 2) {
			if (this.entries.length >= BANDPLANS_LIMITS.importRows)
				throw new XmlReject("row-limit")
			if (name !== ROW) this.entries.push("malformed-row")
			else if (selfClosing) this.entries.push(toRow(attrs, ""))
			else this.row = { attrs, name: "" }
		}
		if (this.textLengths.length > 0)
			this.textLengths[this.textLengths.length - 1] = 0
		if (!selfClosing) {
			this.stack.push(qualified)
			this.textLengths.push(0)
		}
	}

	private attribute(seen: readonly Attribute[]): Attribute {
		const s = this.s
		const name = this.qualifiedName()
		for (const other of seen) if (other.name === name) reject()
		this.skipSpace()
		if (s.charCodeAt(this.pos) !== 0x3d) reject()
		this.pos++
		this.skipSpace()
		const quote = s.charCodeAt(this.pos)
		if (quote !== 0x22 && quote !== 0x27) reject()
		this.pos++
		let value = ""
		let segment = this.pos
		for (;;) {
			if (this.pos >= s.length) reject()
			const code = s.charCodeAt(this.pos)
			if (code === quote || code === 0x26) {
				value += normaliseSpace(s.slice(segment, this.pos))
				if (code === quote) {
					this.pos++
					break
				}
				value += this.reference()
				segment = this.pos
			} else {
				if (code === 0x3c || !isAllowedChar(code)) reject()
				this.pos++
			}
			if (value.length + (this.pos - segment) > SDRSHARP_LIMITS.attributeChars)
				reject()
		}
		return { name, value }
	}

	private endTag(): void {
		const s = this.s
		this.pos += 2
		// Tags match on the full qualified name, prefix included.
		const name = this.qualifiedName()
		this.skipSpace()
		if (s.charCodeAt(this.pos) !== 0x3e) reject()
		this.pos++
		this.textLengths.pop()
		if (this.textLengths.length > 0)
			this.textLengths[this.textLengths.length - 1] = 0
		const open = this.stack.pop()
		if (open === undefined || open !== name) reject()
		const depth = this.stack.length + 1
		if (depth === 1) this.rootClosed = true
		else if (depth === 2 && this.row !== null) {
			this.entries.push(toRow(this.row.attrs, this.row.name))
			this.row = null
		}
	}
}

/** Namespace prefixes are allowed and ignored when recognising element names. */
function localName(qualified: string): string {
	const colon = qualified.indexOf(":")
	return colon < 0 ? qualified : qualified.slice(colon + 1)
}

function toRow(attrs: readonly Attribute[], name: string): Entry {
	let minHz: string | null = null
	let maxHz: string | null = null
	let mode = ""
	let step: string | null = null
	let color: string | null = null
	for (const attr of attrs) {
		switch (attr.name) {
			case "minFrequency":
				minHz = attr.value
				break
			case "maxFrequency":
				maxHz = attr.value
				break
			case "mode":
				mode = attr.value
				break
			case "step":
				step = attr.value
				break
			case "color":
				color = attr.value
				break
		}
	}
	if (minHz === null || maxHz === null) return "malformed-row"
	return { name, minHz, maxHz, mode, step, color }
}
