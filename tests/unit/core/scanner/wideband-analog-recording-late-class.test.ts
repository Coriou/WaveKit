/**
 * Analog recordings that do not depend on early classification, through the real scanner
 * pipeline: an in-process fake source (no network), the inline spectrum engine, the real
 * evidence store and WAV files on disk. The class reaches the recorder at controlled times
 * through a wrapper around the service's own classification (a test seam; the classifier is
 * unchanged).
 */
import { readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { FS, serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import type { WidebandAnalogRecorder } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { Classification } from "../../../../src/core/scanner/types.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { NfmSource, wavDurationMs } from "./wideband-nfm-fixtures.js"

const VOICE_HZ = 93_750
/** 25 ms of IQ per write, like a live source's chunking, with event-loop turns in between. */
const CHUNK = FS / 40

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

type TrackEvent = Extract<
	PipelineEvent,
	{ kind: "track-open" | "track-update" | "track-close" }
>
interface Seams {
	classify(track: TrackSnapshot, sourceId: string): Classification
	onTrack(sourceId: string, ev: TrackEvent, synthetic?: boolean): void
	widebandAnalog: WidebandAnalogRecorder
	evidence: { beginAnalog(input: unknown): unknown }
}

/**
 * `analogFm(ageS, closing)`: whether a snapshot of a track `ageS` seconds old (closing: the
 * track-close snapshot) is classed analog-fm; otherwise it is "unknown" (never a definite class).
 */
function harness(analogFm: (ageS: number, closing: boolean) => boolean) {
	const h = serviceHarness({})
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	const svc = h.service as unknown as Seams
	const classify = svc.classify.bind(svc)
	const onTrack = svc.onTrack.bind(svc)
	let closing = false
	svc.onTrack = (sourceId, ev, synthetic) => {
		closing = ev.kind === "track-close"
		try {
			onTrack(sourceId, ev, synthetic)
		} finally {
			closing = false
		}
	}
	svc.classify = (track, sourceId) => {
		const c = classify(track, sourceId)
		const age = (track.lastSample - track.startSample) / FS
		return { ...c, class: analogFm(age, closing) ? "analog-fm" : "unknown" }
	}
	let begun = 0
	const begin = svc.evidence.beginAnalog.bind(svc.evidence)
	svc.evidence.beginAnalog = input => {
		begun++
		return begin(input)
	}
	return { ...h, begun: () => begun, recorder: svc.widebandAnalog }
}

type H = ReturnType<typeof harness>

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Feeds `seconds` of the sum of `sources` (each keyed by its own flag), yielding between chunks. */
async function feed(
	h: H,
	sources: { src: NfmSource; on: boolean }[],
	seconds: number,
): Promise<void> {
	const chunks = Math.round((seconds * FS) / CHUNK)
	for (let i = 0; i < chunks; i++) {
		const parts = sources.map(x => x.src.next(CHUNK, x.on))
		const out = Buffer.alloc(2 * CHUNK)
		for (let k = 0; k < out.length; k++) {
			let v = 127.5
			for (const p of parts) v += p[k]! - 127.5
			out[k] = Math.max(0, Math.min(255, Math.round(v)))
		}
		h.fanout.write(out)
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

/** One 28 s voice transmission after 1 s of noise (inside the startup settle window tracks are unverified). */
async function voiceTx(h: H): Promise<void> {
	const voice = {
		src: new NfmSource({ fs: FS, offsetHz: VOICE_HZ, seed: 3 }),
		on: false,
	}
	await feed(h, [voice], 1)
	voice.on = true
	await feed(h, [voice], 28)
	voice.on = false
	await feed(h, [voice], 3.5)
	await h.recorder.idle()
}

describe("wideband analog recording with a late class", () => {
	for (const classAtS of [0.2, 3.5, 10, 27.5, null]) {
		it(`a 28 s transmission classed ${classAtS === null ? "only at the close" : `at ${classAtS} s`} yields one WAV of at least 25 s`, async () => {
			const h = harness((age, closing) =>
				classAtS === null ? closing : age >= classAtS,
			)
			await h.service.start()
			await voiceTx(h)
			const files = await wavs(h.dir)
			expect(files).toHaveLength(1)
			const ms = wavDurationMs(await readFile(files[0]!))
			expect(ms).toBeGreaterThanOrEqual(25_000)
			// Pre-roll 300 ms + 28 s + hang 2000 ms.
			expect(Math.abs(ms - 30_300)).toBeLessThanOrEqual(300)
			if (classAtS !== 0.2) return
			// The recordings inventory (GET /api/recordings) lists it as a scanner analog file.
			const inventory = createRecordingInventory({
				dsdFmeDirs: () => [],
				scannerRecordingsDir: () => join(h.dir, "recordings"),
				// A file modified in the last RECORDINGS_IN_PROGRESS_MS is still in progress.
				now: () => Date.now() + 60_000,
				logger: pino({ level: "silent" }),
			})
			const page = await inventory.list({})
			const discoveryId = files[0]!.split("/").at(-2)!
			expect(page.items.map(i => [i.kind, i.discoveryId])).toEqual([
				["scanner-analog", discoveryId],
			])
		}, 300_000)
	}

	it("a track never classed analog-fm yields no WAV and no store operation", async () => {
		const h = harness(() => false)
		await h.service.start()
		await voiceTx(h)
		expect(await wavs(h.dir)).toEqual([])
		expect(h.begun()).toBe(0)
		const staged = await readdir(join(h.dir, ".analog-operations")).catch(
			() => [],
		)
		expect(staged).toEqual([])
	}, 300_000)

	it("two analog-fm steady carriers do not keep a voice out: only the voice is recorded", async () => {
		const h = harness(() => true)
		await h.service.start()
		const carrier = (offsetHz: number, seed: number) => ({
			src: new NfmSource({
				fs: FS,
				offsetHz,
				amp: 0.25,
				noiseSigma: 0,
				voice: false,
				ctcssHz: null,
				seed,
			}),
			on: false,
		})
		const a = carrier(VOICE_HZ - 30_000, 1)
		const b = carrier(VOICE_HZ + 30_000, 2)
		const voice = {
			src: new NfmSource({ fs: FS, offsetHz: VOICE_HZ, amp: 0.25, seed: 3 }),
			on: false,
		}
		const mix = [a, b, voice]
		await feed(h, mix, 1)
		a.on = true
		b.on = true
		await feed(h, mix, 9)
		voice.on = true
		await feed(h, mix, 28)
		voice.on = false
		await feed(h, mix, 3.5)
		await h.recorder.idle()
		const files = await wavs(h.dir)
		expect(files).toHaveLength(1)
		expect(wavDurationMs(await readFile(files[0]!))).toBeGreaterThanOrEqual(
			25_000,
		)
		// The one file is the voice's (carriers were never admitted).
		expect(h.begun()).toBe(1)
	}, 300_000)
})
