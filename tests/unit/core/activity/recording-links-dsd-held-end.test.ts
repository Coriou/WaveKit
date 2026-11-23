/**
 * Real wiring, dsd-fme's held call_end → linked recording: the dsd-fme adapter fed short D-STAR,
 * YSF and DMR calls in dsd-fme's line format, its outputs published as the decoder manager
 * publishes them, the production Activity runtime (inline store and reader), the recordings
 * catalogue over the call directories and the link wiring as src/index.ts composes them. The
 * adapter holds a call's end for its WAV lookup's first attempt (at most DSD_FME_WAV_END_WAIT_MS),
 * so a file there at the end rides on the call_end row itself; one written later comes in a
 * `wavFileUpdate` that links the same row. The shipped DMR gate is on (DMR recordings off), so a
 * DMR call stays unlinked. A late update for a row that is gone, or for a file retention removed,
 * leaves no link. Real clock, timers, fs and SQLite; synthetic files only.
 */
import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { wireRecordingLinks } from "../../../../src/core/activity/recording-links.js"
import { startActivityRuntime } from "../../../../src/core/activity/runtime.js"
import type { ActivityRuntime } from "../../../../src/core/activity/runtime.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import type { RecordingInventory } from "../../../../src/core/recordings/inventory.js"
import type { ActivityPublisher } from "../../../../src/decoders/manager.js"
import { DsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../../src/decoders/types.js"
import { recordingDsdFmeDirs } from "../../../../src/index.js"

const logger = pino({ level: "silent" })
const realNow = (): number => performance.timeOrigin + performance.now()
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const STEP_MS: Record<string, number> = { dstar: 420, ysf: 100, dmr: 100 }

const DSTAR = "03:04:05 Sync: +DSTAR VOICE "
const YSF = (frame: string) =>
	`03:04:05 Sync: +YSF  V/D2 Group/CQ -Simplex ${frame}`
/** One call per protocol (D-STAR's syncs 420 ms apart, the others' lines 100 ms apart, as dsd-fme prints them). */
const LINES: Record<string, string[]> = {
	dstar: [DSTAR, DSTAR, DSTAR, DSTAR],
	ysf: [
		YSF("HC FN: 1/7 DST: ALL        SRC: N0CALL     "),
		YSF("CC FN: 2/7 U/L:           "),
		YSF("CC FN: 3/7 D/L:           "),
		YSF("CC FN: 4/7 D/L:           "),
	],
	dmr: (() => {
		const sync = (burst: string) =>
			`13:13:33 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | ${burst} `
		const slot = " SLOT 1 TGT=9 SRC=2001 Group Call "
		return [sync("VLC"), slot, sync("VC*"), slot, sync("VC*"), slot]
	})(),
}
/** The file-name system part dsd-fme writes for each. */
const SYSTEM: Record<string, string> = {
	dstar: "DSTAR_CC_0_GROUP_TGT_0_SRC_0",
	ysf: "YSF_CC_0_GROUP_TGT_0_SRC_0",
	dmr: "DMR_CC_1_GROUP_TGT_9_SRC_2001",
}

/** dsd-fme's per-call file name for a call starting at `ms` (local time, as it writes it). */
function callName(ms: number, mode: string): string {
	const d = new Date(ms)
	const p = (n: number) => String(n).padStart(2, "0")
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_12345_${SYSTEM[mode]}.wav`
}

/** A plain 8 kHz mono PCM WAV of `ms` of silence. */
function wav(ms: number): Buffer {
	const frames = Math.round((ms * 8000) / 1000)
	const b = Buffer.alloc(44 + 2 * frames)
	b.write("RIFF", 0)
	b.writeUInt32LE(36 + 2 * frames, 4)
	b.write("WAVE", 8)
	b.write("fmt ", 12)
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(8000, 24)
	b.writeUInt32LE(16000, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36)
	b.writeUInt32LE(2 * frames, 40)
	return b
}

/** Written, then dated a minute ago (real clock): past the catalogue's in-progress wait. */
async function settledFile(path: string): Promise<void> {
	await writeFile(path, wav(1000))
	const old = (realNow() - 60_000) / 1000
	await utimes(path, old, old)
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

type Harness = {
	runtime: ActivityRuntime
	inventory: RecordingInventory
	links: ReturnType<typeof wireRecordingLinks>
	publish: (id: string, output: DecoderOutput) => void
	dirOf: (mode: string) => string
	configOf: (mode: string) => DecoderConfig
}

/** One dsd-fme decoder per protocol, each with its own call directory, wired as src/index.ts. */
async function harness(): Promise<Harness> {
	const stateDir = await mkdtemp(join(tmpdir(), "wk-held-state-"))
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
	const dirs = new Map<string, string>()
	const configs = new Map<string, DecoderConfig>()
	for (const mode of Object.keys(LINES)) {
		const dir = await mkdtemp(join(tmpdir(), `wk-held-${mode}-`))
		cleanups.push(() => rm(dir, { recursive: true, force: true }))
		dirs.set(mode, dir)
		configs.set(mode, {
			id: `dsd-${mode}`,
			type: "dsd-fme",
			enabled: true,
			options: {
				mode,
				enablePerCallRecording: true,
				perCallRecordingDir: dir,
				perCallRecordingPrune: false,
			},
		})
	}
	const manager = { getConfiguredDecoderConfigs: () => [...configs.values()] }
	let publisher: ActivityPublisher | null = null
	const runtime = await startActivityRuntime({
		enabled: true,
		stateDir,
		logger,
		execution: "inline",
		queryExecution: "inline",
		limits: { batchWindowMs: 0 },
		setPublisher: p => {
			publisher = p
		},
		callRecordings: id =>
			recordingDsdFmeDirs(manager).some(d => d.decoderId === id),
	})
	cleanups.push(() => runtime.close())
	expect(runtime.status).toBe("ready")
	let links: ReturnType<typeof wireRecordingLinks> | null = null
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => recordingDsdFmeDirs(manager),
		scannerRecordingsDir: () => null,
		logger,
		now: realNow,
		activityEventId: key => links?.activityEventId(key) ?? null,
	})
	cleanups.push(() => inventory.close?.())
	links = wireRecordingLinks({
		links: runtime.recordingLinks?.() ?? null,
		catalogue: inventory,
		logger,
		now: realNow,
		sweepMs: 3_600_000,
		missingMs: 0,
	})
	cleanups.push(() => links?.close())
	return {
		runtime,
		inventory,
		links,
		// What DecoderManager does with every output (manager.ts, publish(parentId, type, …)).
		publish: (id, output) => publisher?.(id, "dsd-fme", output),
		dirOf: mode => dirs.get(mode) ?? "",
		configOf: mode => configs.get(mode)!,
	}
}

/** Runs one call of `mode` through a real adapter and ends it (stop: every open call ends). */
async function runCall(
	h: Harness,
	mode: string,
	beforeEnd?: () => Promise<void>,
): Promise<{ outputs: DecoderOutput[]; decoder: DsdFmeDecoder }> {
	const config = h.configOf(mode)
	const decoder = new DsdFmeDecoder(config, logger)
	const outputs: DecoderOutput[] = []
	decoder.on("output", (output: DecoderOutput) => {
		outputs.push(output)
		h.publish(config.id, output)
	})
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
	}
	for (const line of LINES[mode] ?? []) {
		internals.handleOutputLine(line)
		await pause(STEP_MS[mode] ?? 100)
	}
	await beforeEnd?.()
	// stop() publishes the ends it produces before it returns (each held for its first lookup).
	await decoder.stop()
	return { outputs, decoder }
}

const ends = (outputs: DecoderOutput[]) =>
	outputs.filter(o => o.type === "call_end")
const dataOf = (o: DecoderOutput | undefined) =>
	o?.data as
		| { wavFile?: string; callId?: string; flags?: { wavFileUpdate?: boolean } }
		| undefined

describe("dsd-fme held call_end to a linked recording", () => {
	it("a D-STAR call whose file is there at its end links its call_end row from the end itself", async () => {
		const h = await harness()
		const name = callName(Date.now(), "dstar")
		await settledFile(join(h.dirOf("dstar"), name))
		const { outputs } = await runCall(h, "dstar")
		// The end itself carries the file; no update follows it.
		expect(ends(outputs)).toHaveLength(1)
		expect(dataOf(ends(outputs)[0])?.wavFile).toContain(name)
		expect(dataOf(ends(outputs)[0])?.flags?.wavFileUpdate).toBeUndefined()
		const store = h.runtime.recordingLinks?.()
		// Linked with the row as it is stored (the inline store writes at once).
		expect(store?.recordingEventId(`dsd~${name}`)).toBeTypeOf("string")
		const rows = await h.runtime.service.search({
			query: { decoderIds: ["dsd-dstar"] },
		})
		expect(rows.items.map(i => i.recording?.id ?? null).sort()).toEqual(
			[`dsd~${name}`, null].sort(),
		)
	}, 30_000)

	it("a YSF call whose file appears after its end links the same row by the late update", async () => {
		const h = await harness()
		const name = callName(Date.now(), "ysf")
		const { outputs } = await runCall(h, "ysf")
		// The end went out without it (its first attempt found nothing).
		expect(dataOf(ends(outputs)[0])?.wavFile).toBeUndefined()
		const store = h.runtime.recordingLinks?.()
		expect(store?.recordingEventId(`dsd~${name}`)).toBeNull()
		// Inside the retries' second (DSD_FME_WAV_RETRIES × DSD_FME_WAV_RETRY_MS).
		await settledFile(join(h.dirOf("ysf"), name))
		await expect
			.poll(() => store?.recordingEventId(`dsd~${name}`), { timeout: 5_000 })
			.toBeTypeOf("string")
		expect(
			ends(outputs).map(o => dataOf(o)?.flags?.wavFileUpdate === true),
		).toEqual([false, true])
		// The update is a link change, never a row: call_start + call_end.
		const rows = await h.runtime.service.search({
			query: { decoderIds: ["dsd-ysf"] },
		})
		expect(rows.items).toHaveLength(2)
		const linked = rows.items.filter(i => i.recording !== undefined)
		expect(linked.map(i => i.recording?.id)).toEqual([`dsd~${name}`])
	}, 30_000)

	it("a DMR call stays unlinked while DMR recordings are off, its file on disk", async () => {
		const h = await harness()
		const name = callName(Date.now(), "dmr")
		await settledFile(join(h.dirOf("dmr"), name))
		const { outputs } = await runCall(h, "dmr")
		expect(ends(outputs).length).toBeGreaterThan(0)
		for (const e of ends(outputs)) expect(dataOf(e)?.wavFile).toBeUndefined()
		await h.inventory.list({})
		h.links.sweep()
		const store = h.runtime.recordingLinks?.()
		expect(store?.recordingEventId(`dsd~${name}`)).toBeNull()
		const page = await h.runtime.service.search({
			query: { hasRecording: true },
		})
		expect(page.items).toEqual([])
	}, 30_000)

	it("a late update for a row that is gone, or for a file retention removed, leaves no link", async () => {
		const h = await harness()
		const store = h.runtime.recordingLinks?.()
		const config = h.configOf("dstar")
		// The update's shape as dsd-fme emits it (findWavFileAsync), for a call with no row (its
		// row swept): the store links rows by call id, and there is none.
		const goneName = callName(Date.now(), "dstar")
		await settledFile(join(h.dirOf("dstar"), goneName))
		const update = (callId: string, file: string): DecoderOutput => ({
			timestamp: new Date(),
			decoder: config.id,
			type: "call_end",
			data: {
				callId,
				startedAt: new Date().toISOString(),
				protocol: "dstar",
				talkgroup: 0,
				source: 0,
				duration: 400,
				encryptionKnown: true,
				flags: { wavFileUpdate: true },
				wavFile: file,
			},
		})
		h.publish(config.id, update("swept-call", join(h.dirOf("dstar"), goneName)))
		await pause(200)
		expect(store?.recordingEventId(`dsd~${goneName}`)).toBeNull()

		// A real call whose file was removed by retention before its late update.
		await unlink(join(h.dirOf("dstar"), goneName))
		const name = callName(Date.now(), "dstar")
		const { outputs } = await runCall(h, "dstar")
		const callId = dataOf(ends(outputs)[0])?.callId ?? ""
		expect(callId).not.toBe("")
		h.publish(config.id, update(callId, join(h.dirOf("dstar"), name)))
		// The catalogue never lists it: a complete pass removes whatever the update asked.
		h.inventory.invalidate?.()
		await h.inventory.list({})
		h.links.sweep()
		h.links.sweep()
		await expect
			.poll(() => store?.recordingEventId(`dsd~${name}`), { timeout: 5_000 })
			.toBeNull()
		const page = await h.runtime.service.search({
			query: { hasRecording: true },
		})
		expect(page.items).toEqual([])
	}, 30_000)
})
