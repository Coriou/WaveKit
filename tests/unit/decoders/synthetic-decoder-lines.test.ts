/**
 * The adapters' parsers on the output dsd-fme and multimon-ng printed for the
 * synthetic transmissions of scripts/fixtures (recorded in
 * tests/mocks/fixtures/synthetic/; made-up identities). The same checks run
 * against the live binaries through the whole chain in
 * tests/integration/synthetic-frames.test.ts; these keep the parsers covered
 * where the binaries are not installed.
 */
import { readFileSync } from "node:fs"
import pino from "pino"
import { afterAll, describe, it, vi } from "vitest"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import {
	checkDpmr,
	checkDstar,
	checkFlex,
	checkNxdn,
	checkP25,
	checkYsf,
	dsdInterpreter,
	multimonInterpreter,
	replay,
} from "../../helpers/synthetic-decodes.js"
import type { Replay } from "../../helpers/synthetic-decodes.js"

const silent = pino({ level: "silent" })

/** A recorded output, comment lines dropped. */
function recorded(name: string): string[] {
	return readFileSync(
		new URL(`../../mocks/fixtures/synthetic/${name}.txt`, import.meta.url),
		"latin1",
	)
		.split("\n")
		.filter(line => !line.startsWith("#"))
}

const dsd = (mode: string) =>
	new DsdFmeDecoder(
		{ id: "dsd-fme", type: "dsd-fme", enabled: true, options: { mode } },
		silent,
	)

const CASES: {
	name: string
	fixture: string
	mode: string
	check: (r: Replay) => void
}[] = [
	{
		name: "D-STAR header and checked slow data",
		fixture: "dsd-fme-dstar",
		mode: "auto",
		check: checkDstar,
	},
	{
		name: "YSF CSD1 / V/D2 callsigns",
		fixture: "dsd-fme-ysf",
		mode: "auto",
		check: checkYsf,
	},
	{
		name: "P25 phase 1 LCW talkgroup and source",
		fixture: "dsd-fme-p25",
		mode: "auto",
		check: checkP25,
	},
	{
		name: "NXDN48 RAN and VCALL IDs",
		fixture: "dsd-fme-nxdn48",
		mode: "nxdn48",
		check: checkNxdn("nxdn48"),
	},
	{
		name: "NXDN96 RAN and VCALL IDs",
		fixture: "dsd-fme-nxdn96",
		mode: "nxdn",
		check: checkNxdn("nxdn96"),
	},
	{
		name: "dPMR protocol without unchecked IDs",
		fixture: "dsd-fme-dpmr",
		mode: "dpmr",
		check: checkDpmr,
	},
]

describe("adapter parsers on the synthetic transmissions' decoder output", () => {
	afterAll(() => {
		vi.useRealTimers()
	})

	for (const c of CASES)
		it(`dsd-fme: ${c.name}`, () => {
			c.check(replay(recorded(c.fixture), dsd(c.mode), dsdInterpreter()))
		})

	it("multimon-ng: FLEX alphanumeric page (pipe format with timestamp)", () => {
		const decoder = new MultimonDecoder(
			{
				id: "pager",
				type: "multimon-ng",
				enabled: true,
				options: { modes: ["FLEX"] },
			},
			silent,
		)
		checkFlex(replay(recorded("multimon-flex"), decoder, multimonInterpreter()))
	})
})
