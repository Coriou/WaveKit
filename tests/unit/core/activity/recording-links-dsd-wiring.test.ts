/**
 * Real wiring, dsd-fme call → playable recording, both directions: the dsd-fme adapter fed two
 * short DMR calls in dsd-fme's line format (as the synthetic two-press fixture), its outputs
 * published as the decoder manager publishes them, the production Activity runtime (inline store
 * and reader), the recordings catalogue over the call directory and the link wiring as
 * src/index.ts composes them. The first call's file is on disk at its end; the second's appears
 * after its row is stored (dsd-fme's late search), so its row is updated, never doubled. Real
 * clock, timers, fs and SQLite (an envelope takes only real Dates). Synthetic files only.
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

/** One short call in dsd-fme's MS/direct-mode line format: header, voice, terminator. */
function callLines(source: number): string[] {
	const sync = (burst: string) =>
		`13:13:33 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | ${burst} `
	const slot = ` SLOT 1 TGT=9 SRC=${source} Group Call `
	return [
		sync("VLC"),
		slot,
		sync("VC*"),
		slot,
		sync("VC*"),
		slot,
		sync("TLC"),
		slot,
	]
}

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
}

/** dsd-fme's per-call file name for a call starting at `ms` (local time, as it writes it). */
function callName(ms: number, digits: string, source: number): string {
	const d = new Date(ms)
	const p = (n: number) => String(n).padStart(2, "0")
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${digits}_DMR_CC_1_GROUP_TGT_9_SRC_${source}.wav`
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

describe("a dsd-fme call to a playable recording and back", () => {
	it("links each call_end row, updates the late one in place, and removes a deleted file's link", async () => {
		const callDir = await mkdtemp(join(tmpdir(), "wk-p2-calls-"))
		const stateDir = await mkdtemp(join(tmpdir(), "wk-p2-state-"))
		cleanups.push(() => rm(callDir, { recursive: true, force: true }))
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
		const config: DecoderConfig = {
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options: {
				mode: "auto",
				enablePerCallRecording: true,
				perCallRecordingDir: callDir,
				perCallRecordingPrune: false,
			},
		}
		// As src/index.ts: the catalogue's dsd-fme directories are the configured decoders'.
		const manager = { getConfiguredDecoderConfigs: () => [config] }
		let publish: ActivityPublisher | null = null
		const runtime: ActivityRuntime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			limits: { batchWindowMs: 0 },
			setPublisher: p => {
				publish = p
			},
			callRecordings: id =>
				recordingDsdFmeDirs(manager).some(d => d.decoderId === id),
		})
		cleanups.push(() => runtime.close())
		expect(runtime.status).toBe("ready")
		let links: ReturnType<typeof wireRecordingLinks> | null = null
		const inventory: RecordingInventory = createRecordingInventory({
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

		const decoder = new DsdFmeDecoder(config, logger)
		decoder.on("output", (output: DecoderOutput) => {
			// What DecoderManager does with every output (manager.ts, publish(parentId, type, …)).
			publish?.(config.id, config.type, output)
		})
		const internals = decoder as unknown as Internals
		const call = async (source: number): Promise<void> => {
			for (const line of callLines(source)) {
				internals.handleOutputLine(line)
				await new Promise(resolve => setTimeout(resolve, 20))
			}
		}

		// Call 1: its file is there when the call ends.
		const nameA = callName(Date.now(), "12345", 2001)
		await settledFile(join(callDir, nameA))
		await call(2001)
		// Call 2 (another radio, so its search never matches call 1's file): its file appears
		// after the call's row is stored.
		const nameB = callName(Date.now(), "54321", 2002)
		await call(2002)
		const store = runtime.recordingLinks?.()
		const keyA = `dsd~${nameA}`
		const keyB = `dsd~${nameB}`
		expect(store?.recordingEventId(keyA)).toBeTypeOf("string")
		// Its row is stored (the store writes at once here) without a link; dsd-fme searches again
		// for about a second, so the file is written now.
		expect(store?.recordingEventId(keyB)).toBeNull()
		await settledFile(join(callDir, nameB))
		await expect
			.poll(() => store?.recordingEventId(keyB), { timeout: 5_000 })
			.toBeTypeOf("string")

		// No row for the late file: 2 call_start + 2 call_end.
		const all = await runtime.service.search({
			query: { decoderIds: ["dsd-fme"] },
		})
		expect(all.items).toHaveLength(4)
		const page = await runtime.service.search({ query: { hasRecording: true } })
		expect(page.items.map(i => i.recording?.id).sort()).toEqual(
			[keyA, keyB].sort(),
		)
		for (const item of page.items) {
			const detail = await runtime.service.detail(item.eventId)
			expect(detail?.kind).toBe("decoder-reception")
			const payload = detail?.payload as {
				outputType: string
				decodedData: Record<string, unknown>
			}
			expect(payload.outputType).toBe("call_end")
			// Never a path in a stored record.
			expect(JSON.stringify(detail)).not.toContain(callDir)
			// Row → recording: the link's id opens the file through the catalogue (the file route).
			const opened = await inventory.open(item.recording!.id)
			expect(opened?.name).toBe(item.recording!.id.slice("dsd~".length))
			await opened?.handle.close()
		}
		// Recording → row: the catalogue item names the row, and the refs query finds it.
		const listed = await inventory.list({})
		expect(listed.items).toHaveLength(2)
		for (const item of listed.items) {
			const row = page.items.find(i => i.recording?.id === item.key)
			expect(item.activityEventId).toBe(row?.eventId)
			const byRef = await runtime.service.search({
				query: { refs: [{ type: "recordingId", value: item.key ?? "" }] },
			})
			expect(byRef.items.map(i => i.eventId)).toEqual([row?.eventId])
		}

		// The first file is deleted: its link goes once a complete catalogue lacks it.
		await unlink(join(callDir, nameA))
		inventory.invalidate?.()
		await inventory.list({})
		links.sweep()
		links.sweep()
		await expect
			.poll(() => store?.recordingEventId(keyA), { timeout: 5_000 })
			.toBeNull()
		const after = await runtime.service.search({
			query: { hasRecording: true },
		})
		expect(after.items.map(i => i.recording?.id)).toEqual([keyB])
		const again = await runtime.service.search({
			query: { decoderIds: ["dsd-fme"] },
		})
		expect(again.items).toHaveLength(4)
		await decoder.stop().catch(() => undefined)
	}, 30_000)
})
