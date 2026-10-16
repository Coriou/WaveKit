/**
 * WG6 (web-gaps-6 req 3, design "Decoder option schemas"): every option key a
 * built-in adapter reads must be a key of its type's option schema, so a valid
 * config never reports a false `unknown-key` issue.
 *
 * Keys are extracted from the adapter source text with:
 * - BRACKET_READ `options["key"]` (also `options?.["key"]`, `config.options["key"]`):
 *   reads of the raw `Record<string, unknown>` options (every adapter and base uses this form).
 * - THIS_OPTIONS_READ `this.options.key` and THIS_OPTIONS_DESTRUCTURE
 *   `{ a, b } = this.options`: reads of the adapter's parsed options, whose keys mirror
 *   the raw keys (not used for lora-meshtastic, whose parsed options carry derived keys
 *   such as `bw`, `effectiveTargetRate`).
 * - RAW_READ `raw.key`: lora-meshtastic only, where `raw` is the input of the raw
 *   options schema transform.
 * Base-class reads come from scanning the base file with BRACKET_READ
 * (AudioDemodDecoder also calls IqDecimateDecoder's readChannelHz, so audio bases scan
 * both files). Keys read outside the adapter, listed by hand:
 * - `frequencies`, `frequency`: resolveDecoderTargetFrequencies (status-fields.ts) for every type.
 * Exception: lora-meshtastic parses its options with its own strict RawOptionsSchema and
 * throws on any other key, so base and generic reads it does not accept can never be
 * configured (UNREACHABLE_KEYS).
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { acarsdecOptionsSchema } from "../../../../src/decoders/options/acarsdec.js"
import { aisCatcherOptionsSchema } from "../../../../src/decoders/options/ais-catcher.js"
import { direwolfOptionsSchema } from "../../../../src/decoders/options/direwolf.js"
import { dsdFmeOptionsSchema } from "../../../../src/decoders/options/dsd-fme.js"
import { dumpvdl2OptionsSchema } from "../../../../src/decoders/options/dumpvdl2.js"
import { loraMeshtasticOptionsSchema } from "../../../../src/decoders/options/lora-meshtastic.js"
import { multimonNgOptionsSchema } from "../../../../src/decoders/options/multimon-ng.js"
import { readsbOptionsSchema } from "../../../../src/decoders/options/readsb.js"
import { rtl433OptionsSchema } from "../../../../src/decoders/options/rtl433.js"

const DECODERS_DIR = join(__dirname, "../../../../src/decoders")

const BRACKET_READ = /options\??\.?\["([A-Za-z_][A-Za-z0-9_]*)"\]/g
const THIS_OPTIONS_READ = /this\.options\??\.([A-Za-z_][A-Za-z0-9_]*)/g
const THIS_OPTIONS_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*this\.options\b/g
const RAW_READ = /\braw\.([A-Za-z_][A-Za-z0-9_]*)/g

const AUDIO_BASES = ["audio-demod-decoder.ts", "iq-decimate-decoder.ts"]
const IQ_BASES = ["iq-decimate-decoder.ts"]
const NETWORK_BASES = ["network-producer-decoder.ts"]
const TARGET_FREQUENCY_KEYS = ["frequencies", "frequency"]
const UNREACHABLE_KEYS: Record<string, string[]> = {
	"lora-meshtastic": ["channelHz", "frequencies"],
}

interface AdapterCase {
	type: string
	file: string
	bases: string[]
	parsedMirrorsRaw: boolean
	schema: z.ZodTypeAny
}

const CASES: AdapterCase[] = [
	{
		type: "dsd-fme",
		file: "dsd-fme.ts",
		bases: AUDIO_BASES,
		parsedMirrorsRaw: true,
		schema: dsdFmeOptionsSchema,
	},
	{
		type: "multimon-ng",
		file: "multimon-ng.ts",
		bases: AUDIO_BASES,
		parsedMirrorsRaw: true,
		schema: multimonNgOptionsSchema,
	},
	{
		type: "rtl433",
		file: "rtl433.ts",
		bases: IQ_BASES,
		parsedMirrorsRaw: true,
		schema: rtl433OptionsSchema,
	},
	{
		type: "readsb",
		file: "readsb.ts",
		bases: NETWORK_BASES,
		parsedMirrorsRaw: true,
		schema: readsbOptionsSchema,
	},
	{
		type: "acarsdec",
		file: "acarsdec.ts",
		bases: AUDIO_BASES,
		parsedMirrorsRaw: true,
		schema: acarsdecOptionsSchema,
	},
	{
		type: "ais-catcher",
		file: "ais-catcher.ts",
		bases: IQ_BASES,
		parsedMirrorsRaw: true,
		schema: aisCatcherOptionsSchema,
	},
	{
		type: "dumpvdl2",
		file: "dumpvdl2.ts",
		bases: IQ_BASES,
		parsedMirrorsRaw: true,
		schema: dumpvdl2OptionsSchema,
	},
	{
		type: "direwolf",
		file: "direwolf.ts",
		bases: AUDIO_BASES,
		parsedMirrorsRaw: true,
		schema: direwolfOptionsSchema,
	},
	{
		type: "lora-meshtastic",
		file: "lora-meshtastic.ts",
		bases: IQ_BASES,
		parsedMirrorsRaw: false,
		schema: loraMeshtasticOptionsSchema,
	},
]

/** Object keys of a schema, through refine/transform wrappers (lora-meshtastic). */
function schemaKeys(schema: z.ZodTypeAny): string[] {
	if (schema instanceof z.ZodObject) return Object.keys(schema.shape as object)
	if (schema instanceof z.ZodEffects)
		return schemaKeys(schema.innerType() as z.ZodTypeAny)
	throw new TypeError("option schema is not an object schema")
}

function matches(text: string, pattern: RegExp): string[] {
	return [...text.matchAll(pattern)].map(m => m[1] ?? "")
}

function destructured(text: string): string[] {
	return matches(text, THIS_OPTIONS_DESTRUCTURE).flatMap(list =>
		list
			.split(",")
			.map(part => part.split(":")[0]?.trim() ?? "")
			.filter(name => name.length > 0),
	)
}

function adapterKeys(c: AdapterCase): { own: string[]; all: string[] } {
	const text = readFileSync(join(DECODERS_DIR, "builtin", c.file), "utf8")
	const own = new Set(matches(text, BRACKET_READ))
	if (c.parsedMirrorsRaw) {
		for (const key of matches(text, THIS_OPTIONS_READ)) own.add(key)
		for (const key of destructured(text)) own.add(key)
	} else {
		for (const key of matches(text, RAW_READ)) own.add(key)
	}
	const all = new Set(own)
	for (const base of c.bases) {
		const baseText = readFileSync(join(DECODERS_DIR, base), "utf8")
		for (const key of matches(baseText, BRACKET_READ)) all.add(key)
	}
	for (const key of TARGET_FREQUENCY_KEYS) all.add(key)
	for (const key of UNREACHABLE_KEYS[c.type] ?? []) all.delete(key)
	return { own: [...own].sort(), all: [...all].sort() }
}

describe("decoder option schemas cover every adapter read", () => {
	it.each(CASES)("$type", c => {
		const { own, all } = adapterKeys(c)
		// Guard: a refactor must not make the extraction vacuous.
		expect(own.length).toBeGreaterThan(0)
		const shape = schemaKeys(c.schema)
		expect(all.filter(key => !shape.includes(key))).toEqual([])
	})

	it("base classes still read the keys the extraction expects", () => {
		const audio = readFileSync(
			join(DECODERS_DIR, "audio-demod-decoder.ts"),
			"utf8",
		)
		const iq = readFileSync(
			join(DECODERS_DIR, "iq-decimate-decoder.ts"),
			"utf8",
		)
		expect(matches(audio, BRACKET_READ).length).toBeGreaterThan(0)
		expect(matches(iq, BRACKET_READ)).toContain("channelHz")
	})
})
