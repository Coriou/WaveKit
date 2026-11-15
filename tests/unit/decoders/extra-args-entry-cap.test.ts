// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
import { describe, expect, it } from "vitest"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import { decoderOptionDescriptors } from "../../../src/decoders/options/index.js"
import { DECODER_OPTION_SCHEMAS } from "../../../src/decoders/options/index.js"

const cases: [string, new (c: DecoderConfig, l: pino.Logger) => unknown][] = [
	["acarsdec", AcarsdecDecoder],
	["dumpvdl2", Dumpvdl2Decoder],
	["ais-catcher", AisCatcherDecoder],
	["readsb", ReadsbDecoder],
	["direwolf", DirewolfDecoder],
]

function build(
	type: string,
	Ctor: new (c: DecoderConfig, l: pino.Logger) => unknown,
	extraArgs: unknown,
) {
	const warn: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "warn" },
		{ write: (l: string) => void warn.push(JSON.parse(l)) },
	)
	const config = {
		id: "t",
		type,
		enabled: true,
		options: { extraArgs },
	} as unknown as DecoderConfig
	const view = new Ctor(config, logger) as unknown as {
		options: { extraArgs?: string[] }
		onOptionsUpdated(): void
	}
	return { view, warn }
}

describe.each(cases)("%s extraArgs cap", (type, Ctor) => {
	const args = (n: number) => Array.from({ length: n }, (_, i) => `-x${i}`)

	it("keeps 64 untouched and silently", () => {
		const { view, warn } = build(type, Ctor, args(64))
		expect(view.options.extraArgs).toEqual(args(64))
		expect(warn).toHaveLength(0)
	})

	it.each([65, 200_000])(
		"slices %i entries to 64 with a key-only warning",
		n => {
			const { view, warn } = build(type, Ctor, args(n))
			expect(view.options.extraArgs).toEqual(args(64))
			expect(warn).toHaveLength(1)
			expect(warn[0]).toMatchObject({ key: "extraArgs", issue: "clamped" })
			view.onOptionsUpdated()
			expect(warn).toHaveLength(1)
		},
	)

	it("drops non-strings and non-arrays", () => {
		expect(
			build(type, Ctor, ["-a", 5, {}, "-b"]).view.options.extraArgs,
		).toEqual(["-a", "-b"])
		expect(build(type, Ctor, "--evil").view.options.extraArgs).toBeUndefined()
	})

	it("the schema rejects 65 entries and the descriptor says 64", () => {
		const schema = DECODER_OPTION_SCHEMAS[type]!
		expect(schema.safeParse({ extraArgs: args(64) }).success).toBe(true)
		expect(schema.safeParse({ extraArgs: args(65) }).success).toBe(false)
		const d = decoderOptionDescriptors(type)?.find(o => o.key === "extraArgs")
		expect(d?.description).toContain("64")
	})
})
