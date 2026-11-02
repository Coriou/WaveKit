/**
 * Default-config analog recordings through the real scanner pipeline: an in-process fake source
 * (no network), the inline spectrum engine, the real evidence store and WAV files on disk.
 */
import { readFile, readdir, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FS, serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	CTCSS_TEST_HZ,
	NfmSource,
	VOICE_TONES_HZ,
	goertzel,
	wavDurationMs,
} from "./wideband-nfm-fixtures.js"

const OFFSET_HZ = 93_750
const RANGE = [{ startHz: 446_000_000, endHz: 446_300_000 }]
/** 25 ms of IQ per write, like a live source's chunking, with event-loop turns in between. */
const CHUNK = FS / 40

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

function harness(patch?: (s: ScannerSettings) => void) {
	const h = serviceHarness(patch ? { patch } : {})
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	return h
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Feeds `seconds` of noise with the NFM carrier keyed when `on`, yielding between chunks. */
async function feed(
	h: ReturnType<typeof harness>,
	src: NfmSource,
	seconds: number,
	on: boolean,
): Promise<void> {
	const chunks = Math.round((seconds * FS) / CHUNK)
	for (let i = 0; i < chunks; i++) {
		h.fanout.write(Buffer.from(src.next(CHUNK, on)))
		await turn()
		await turn()
	}
}

async function wavs(dir: string): Promise<string[]> {
	const root = join(dir, "recordings", "analog")
	let discoveries: string[]
	try {
		discoveries = await readdir(root)
	} catch {
		return []
	}
	const out: string[] = []
	for (const d of discoveries)
		for (const name of await readdir(join(root, d)))
			if (name.endsWith(".wav")) out.push(join(root, d, name))
	return out
}

async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 10))
}

/** Transmission + pre-roll (300 ms) + hang (2000 ms), the default hold settings. */
function expectedMs(txSeconds: number): number {
	return txSeconds * 1000 + 300 + 2000
}

describe("wideband analog recording with the default config", () => {
	it("keeps one WAV for a passive in-window NFM transmission, pre-roll to hang", async () => {
		const h = harness()
		await h.service.start()
		const src = new NfmSource({ fs: FS, offsetHz: OFFSET_HZ })
		await feed(h, src, 1, false)
		await feed(h, src, 3, true)
		await feed(h, src, 3.5, false)
		await settle()
		const files = await wavs(h.dir)
		expect(files).toHaveLength(1)
		const wav = await readFile(files[0]!)
		expect(Math.abs(wavDurationMs(wav) - expectedMs(3))).toBeLessThanOrEqual(
			200,
		)
		// The audio is the voice stand-in with the CTCSS high-passed out.
		const pcm = new Int16Array(
			wav.buffer,
			wav.byteOffset + 44,
			(wav.length - 44) / 2,
		)
		const voice = VOICE_TONES_HZ.reduce(
			(sum, hz) => sum + goertzel(pcm, 8000, hz, 2400, 2400 + 7200),
			0,
		)
		const ctcss = goertzel(pcm, 8000, CTCSS_TEST_HZ, 2400, 2400 + 7200)
		expect(voice).toBeGreaterThan(1000 * ctcss)
		// Listed against the discovery, with the CTCSS tone as analog evidence.
		const discoveryId = files[0]!.split("/").at(-2)!
		const d = h.service.getDiscovery(discoveryId)
		expect(d?.evidence.recordings).toBe(1)
		expect(d?.proof?.tone?.ctcssHz).toBe(CTCSS_TEST_HZ)
		// The recordings API resolves it by its scanner alias.
		const alias = `${discoveryId}~${files[0]!.split("/").at(-1)!}`
		// The resolver answers the real path (macOS /tmp is a symlink to /private/tmp).
		expect(h.service.recordingPath(alias)).toBe(await realpath(files[0]!))
	}, 120_000)

	it("a 28 s transmission yields exactly one recording", async () => {
		const h = harness()
		await h.service.start()
		const src = new NfmSource({ fs: FS, offsetHz: OFFSET_HZ, seed: 3 })
		// 1 s first: inside the startup epoch's settle window tracks are unverified (never recorded).
		await feed(h, src, 1, false)
		// Fed about twice as fast as real time; sample indices, not wall time, set the file bounds.
		await feed(h, src, 28, true)
		await feed(h, src, 3.5, false)
		await settle()
		const files = await wavs(h.dir)
		expect(files).toHaveLength(1)
		const wav = await readFile(files[0]!)
		expect(Math.abs(wavDurationMs(wav) - expectedMs(28))).toBeLessThanOrEqual(
			200,
		)
	}, 300_000)

	it("refuses a recording past storage.maxRecordingsMb and leaves nothing behind", async () => {
		// One reservation is a full 120 s file (1.92 MB): a 1 MB cap refuses it at admission.
		const h = harness(s => {
			s.storage.maxRecordingsMb = 1
		})
		await h.service.start()
		const src = new NfmSource({ fs: FS, offsetHz: OFFSET_HZ })
		await feed(h, src, 1, false)
		await feed(h, src, 3, true)
		await feed(h, src, 3.5, false)
		await settle()
		expect(await wavs(h.dir)).toEqual([])
		const staged = await readdir(join(h.dir, ".analog-operations")).catch(
			() => [],
		)
		expect(staged).toEqual([])
	}, 120_000)

	it("records nothing for a job with record.analog false", async () => {
		const h = harness(s => {
			s.passive.enabled = false
		})
		await h.service.start()
		await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: RANGE,
			record: { analog: false },
		})
		const src = new NfmSource({ fs: FS, offsetHz: OFFSET_HZ })
		await feed(h, src, 1, false)
		await feed(h, src, 3, true)
		await feed(h, src, 3.5, false)
		await settle()
		expect(await wavs(h.dir)).toEqual([])
		expect(
			h.service.listDiscoveries({}).items.some(d => d.evidence.recordings > 0),
		).toBe(false)
	}, 120_000)

	it("records for a job with the default record.analog", async () => {
		const h = harness(s => {
			s.passive.enabled = false
		})
		await h.service.start()
		await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: RANGE,
		})
		const src = new NfmSource({ fs: FS, offsetHz: OFFSET_HZ })
		await feed(h, src, 1, false)
		await feed(h, src, 3, true)
		await feed(h, src, 3.5, false)
		await settle()
		expect(await wavs(h.dir)).toHaveLength(1)
	}, 120_000)
})
