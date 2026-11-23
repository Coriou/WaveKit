/**
 * dsd-fme recording admission with DMR recordings switched on: the clearance gate's link
 * decision stays exercised while the shipped flag is off. The call-recordings module is mocked
 * with DMR_RECORDING_LINK_ENABLED true (everything else is the real module).
 * Ids are synthetic.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as CallRecordings from "../../../src/decoders/builtin/call-recordings.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	createDecoder,
	T0,
	type CallData,
} from "./dsd-fme-call-first-helpers.js"
import { settleWavLookups } from "./dsd-fme-wav-settle.js"
import {
	DSD_FME_WAV_RETRIES,
	DSD_FME_WAV_RETRY_MS,
} from "../../../src/decoders/builtin/dsd-fme.js"

vi.mock(
	"../../../src/decoders/builtin/call-recordings.js",
	async importOriginal => ({
		...(await importOriginal<typeof CallRecordings>()),
		DMR_RECORDING_LINK_ENABLED: true,
	}),
)

const M = (k: string) =>
	`00:00:01 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | ${k} `
const LC = (extra = "", tg = 9001, src = 91) =>
	` SLOT 1 TGT=${tg} SRC=${src} Group Call ${extra} `

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
	getDecoderArgs(): string[]
}

type Ended = CallData & { wavFile?: string }

describe("dsd-fme recording admission (DMR recordings on)", () => {
	const START = new Date(2026, 0, 9, 10, 53, 27)
	const FILE = "20260109_105327_123_DMR_CC_1_GROUP_TGT_9001_SRC_91.wav"
	let root: string
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-dmr-admit-on-"))
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
		vi.setSystemTime(START)
	})
	afterEach(() => {
		vi.useRealTimers()
		fs.rmSync(root, { recursive: true, force: true })
	})

	function decoder() {
		return createDecoder({
			mode: "dmr",
			enablePerCallRecording: true,
			perCallRecordingDir: root,
			perCallRecordingPrune: false,
		})
	}

	/** One header call, optionally encrypted mid-call; the file exists at its end or only later. */
	async function call(
		encrypted: boolean,
		fileFirst: boolean,
	): Promise<Ended[]> {
		if (fileFirst) fs.writeFileSync(path.join(root, FILE), "")
		const d = decoder()
		const adapter = d as unknown as Internals
		const ends: Ended[] = []
		d.on("output", (o: DecoderOutput) => {
			if (o.type === "call_end") ends.push(o.data as Ended)
		})
		const base = START.getTime() - T0
		const at = (ms: number, line: string) => {
			vi.setSystemTime(T0 + ms)
			adapter.handleOutputLine(line)
		}
		at(base, M("VLC"))
		at(base + 1, LC())
		at(base + 60, M("VC*"))
		if (encrypted) at(base + 61, LC("Encrypted"))
		at(base + 420, M("VC*"))
		vi.setSystemTime(T0 + base + 5000)
		adapter.checkCallTimeoutAsync()
		if (!fileFirst) fs.writeFileSync(path.join(root, FILE), "")
		// The lookup runs off the event loop: each attempt's read, then the next retry's timer.
		for (let i = 0; i <= DSD_FME_WAV_RETRIES; i++) {
			await settleWavLookups(d)
			await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		}
		await settleWavLookups(d)
		return ends
	}

	const linked = (ends: Ended[]) => ends.filter(e => e.wavFile !== undefined)

	it("a clear DMR call is linked, when its file exists at its end and when it is found later", async () => {
		const now = await call(false, true)
		expect(now.some(e => e.encryptionKnown === true)).toBe(true)
		// The end never carries the file: the lookup's update (its first attempt) links it.
		expect(linked(now).map(e => e.flags?.wavFileUpdate)).toEqual([true])
		expect(linked(now)[0]?.wavFile).toEqual(expect.stringContaining(FILE))
		fs.rmSync(path.join(root, FILE))
		const later = await call(false, false)
		expect(linked(later).map(e => e.flags?.wavFileUpdate)).toEqual([true])
	})

	it("a known encrypted DMR call never links, at its end or later", async () => {
		const now = await call(true, true)
		expect(now.some(e => e.flags?.encrypted === true)).toBe(true)
		expect(linked(now)).toEqual([])
		fs.rmSync(path.join(root, FILE))
		expect(linked(await call(true, false))).toEqual([])
	})

	it("a DMR-only decoder asks dsd-fme for per-call files", () => {
		const args = (decoder() as unknown as Internals).getDecoderArgs()
		const at = args.indexOf("-7")
		expect(args.slice(at, at + 3)).toEqual(["-7", root, "-P"])
	})
})
