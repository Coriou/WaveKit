/**
 * Real wiring, scanner analog recording → playable recording, both directions, through the
 * production composition (sweep-qualification-harness.ts, settled: ScannerService, JobRunner,
 * SweepScheduler and the wideband recorder on an in-process fake source), the production Activity
 * runtime (inline store and reader), the recordings catalogue over the scanner's recordings and
 * the catalogue and link wirings as src/index.ts composes them. A suspect prior holds the voice's
 * file provisional for LATE_VERDICT_GRACE_MS: kept, it becomes one `recording-change` row linked
 * to the file; discarded at the end of its hold (a decode of its own signal), it never gets a
 * row or a link. Synthetic signals only.
 */
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { wireRecordingLinks } from "../../../../src/core/activity/recording-links.js"
import { startActivityRuntime } from "../../../../src/core/activity/runtime.js"
import type { ActivityRuntime } from "../../../../src/core/activity/runtime.js"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import { LATE_VERDICT_GRACE_MS } from "../../../../src/core/scanner/channel/recording-verdict.js"
import type { DecodedLabel } from "../../../../src/core/scanner/channel/voice-veto.js"
import { wireRecordingCatalogue } from "../../../../src/core/recordings/catalogue-wiring.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { makeTmpDir } from "../../../helpers/tmp-dir.js"
import {
	qualificationWorld,
	synthWorld,
} from "./sweep-qualification-harness.js"

const logger = pino({ level: "silent" })
const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const SIGNAL_HZ = CENTRE_HZ + 800_000 + 100_437
const END_MS = 6_000
/** Decisions wait 1 s for late reports; the finish takes some turns of the store. */
const SETTLED_MS = 3_000
/** The harness's clock origin (T0): its wall time is T0 + nowMs(). */
const HARNESS_T0 = 1_000_000

interface Recorder {
	held: Map<unknown, unknown>
	diagnostics(): { recent: { code: string }[] }
	deps: {
		voicePrior?: (discoveryId: string) => VoicePrior | null
		decodedLabel?: (discoveryId: string) => DecodedLabel | null
		timer?: (ms: number, run: () => void) => () => void
	}
}

const stops: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

/** The scene of sweep-held-file-release.test.ts, with Activity, the catalogue and the links wired. */
async function scene(discardDuringHold: boolean) {
	const w = qualificationWorld({
		centreHz: CENTRE_HZ,
		world: synthWorld([
			// Untoned: a file whose own audio carries a CTCSS tone is kept at once, never held.
			{
				hz: SIGNAL_HZ,
				kind: "voice",
				fromMs: 0,
				toMs: END_MS,
				speech: { subToneHz: null },
			},
		]),
		settled: true,
	})
	stops.push(() => w.stop())
	const stateDir = makeTmpDir("wk-p2-activity-")
	const runtime: ActivityRuntime = await startActivityRuntime({
		enabled: true,
		stateDir,
		logger,
		execution: "inline",
		queryExecution: "inline",
		limits: { batchWindowMs: 0 },
		setPublisher: () => undefined,
	})
	stops.push(() => runtime.close())
	let links: ReturnType<typeof wireRecordingLinks> | null = null
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => join(w.dir, "recordings"),
		discoveryOwner: id => {
			const owner = w.service.recordingFolderDiscovery(id)
			return owner ? { id: owner.id, frequencyHz: owner.frequencyHz } : null
		},
		logger,
		// A file is listed once quiet for 10 s (wall clock): read the catalogue a minute ahead.
		now: () => Date.now() + 60_000,
		activityEventId: key => links?.activityEventId(key) ?? null,
	})
	stops.push(() => inventory.close?.())
	const unwire = wireRecordingCatalogue({ inventory, scanner: w.service })
	stops.push(unwire)
	links = wireRecordingLinks({
		links: runtime.recordingLinks?.() ?? null,
		catalogue: inventory,
		scanner: w.service,
		logger,
	})
	stops.push(() => links?.close())
	await w.service.start()
	const rec = (w.service as unknown as { widebandAnalog: Recorder })
		.widebandAnalog
	// A digital spectral class with no label reads `suspect` (priorReading): the file is held.
	rec.deps.voicePrior = id => ({
		id,
		labels: [],
		class: "fsk4-12k5",
		analogVoice: () => false,
	})
	const graces: number[] = []
	const timer = rec.deps.timer
	if (timer === undefined) throw new Error("the settled harness sets the timer")
	rec.deps.timer = (ms, run) => {
		graces.push(ms)
		if (discardDuringHold) {
			// While the file is held, a pager decode of its own signal lands (it cites no
			// observation, stamped after the file's onset): the hold ends in a discard.
			const at = HARNESS_T0 + w.nowMs()
			rec.deps.decodedLabel = () => ({
				protocol: "pocsag",
				at,
				observationId: null,
			})
		}
		return timer(ms, run)
	}
	const codes = () => rec.diagnostics().recent.map(d => d.code)
	await w.service.createJob({
		sourceId: "rtl",
		mode: "sweep",
		bandplans: [],
		ranges: [RANGE],
		priority: 50,
		takeover: true,
		resume: { autoAfterIdleMs: null },
	} as never)
	await w.advance(END_MS + SETTLED_MS)
	expect(graces).toEqual([LATE_VERDICT_GRACE_MS])
	expect(rec.held.size).toBe(1)
	// Held: nothing kept, nothing in Activity.
	expect(w.wavSeconds()).toEqual([])
	expect(runtime.recordingLinks?.()?.linkedRecordings()).toEqual([])
	await w.advance(LATE_VERDICT_GRACE_MS + SETTLED_MS)
	expect(rec.held.size).toBe(0)
	return { w, runtime, inventory, links, codes }
}

describe("a scanner analog recording to a playable recording and back", () => {
	it("a held file kept for good becomes one recording-change row linked to it, both directions", async () => {
		const { w, runtime, inventory, codes } = await scene(false)
		expect(codes()).toContain("finalized")
		expect(w.wavSeconds()).toHaveLength(1)
		const store = runtime.recordingLinks?.()
		await expect
			.poll(() => store?.linkedRecordings().length, { timeout: 5_000 })
			.toBe(1)
		const page = await runtime.service.search({
			query: { kinds: ["recording-change"] },
		})
		expect(page.items).toHaveLength(1)
		const row = page.items[0]!
		const key = row.recording?.id ?? ""
		expect(key).toMatch(/^scan:d_[0-9A-Za-z]+~analog-[0-9a-f-]+\.wav$/)
		expect(row).toMatchObject({ category: "voice", protocol: "analog" })
		expect(row.recording?.durationMs).toBeGreaterThan(0)
		expect(row.frequencyHz).not.toBeNull()
		const withAudio = await runtime.service.search({
			query: { hasRecording: true },
		})
		expect(withAudio.items.map(i => i.eventId)).toEqual([row.eventId])
		// Row → recording: the link's id is the catalogue id and opens the file.
		const opened = await inventory.open(key)
		expect(opened?.name.endsWith(".wav")).toBe(true)
		await opened?.handle.close()
		// Recording → row.
		await expect
			.poll(async () => (await inventory.list({})).items.length, {
				timeout: 10_000,
			})
			.toBe(1)
		const item = (await inventory.list({})).items[0]!
		expect(item.key).toBe(key)
		expect(item.id).toBe(key)
		expect(item.activityEventId).toBe(row.eventId)
		const byRef = await runtime.service.search({
			query: { refs: [{ type: "recordingId", value: key }] },
		})
		expect(byRef.items.map(i => i.eventId)).toEqual([row.eventId])

		// The row is on its channel: the owning discovery's frequency, titled by what it holds.
		const folder = key.slice("scan:".length, key.indexOf("~"))
		const owner = w.service.recordingFolderDiscovery(folder)
		expect(owner).toBeDefined()
		const channelHz = Math.round(owner?.frequencyHz ?? 0)
		expect(row.title).toBe("FM voice")
		expect(row.channel).toEqual({
			discoveryId: owner?.id,
			frequencyHz: channelHz,
		})
		expect(row.frequencyHz).toBe(channelHz)
		expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(4 * 1024)
		const detail = await runtime.service.detail(row.eventId)
		const payload =
			detail?.kind === "recording-change" ? detail.payload : undefined
		// The measured centre stays in the record.
		expect(payload?.frequencyHz).toBeTypeOf("number")
		expect(payload?.channel).toEqual(row.channel)
		const onChannel = await runtime.service.search({ query: { channelHz } })
		expect(onChannel.items.map(i => i.eventId)).toEqual([row.eventId])
		expect(onChannel.channelMatch).toBe("exact")
		const facets = await runtime.service.facets({
			query: { channelHz },
			dimensions: ["channel"],
		})
		expect(facets.facets["channel"]).toEqual([
			{ value: String(channelHz), count: 1 },
		])
		expect(facets.channelMatch).toBe("exact")
		// The catalogue item: what the recorder knew at the finish (held, then kept at the end of
		// its grace: `final`), its observation and its start.
		expect(item.keptBy).toBe("final")
		expect(["heard", "not-heard", "unchecked"]).toContain(item.speech)
		expect(item.observationId).toBe(payload?.observationId)
		expect(Number.isFinite(Date.parse(item.startedAt ?? ""))).toBe(true)
		expect(item.frequencyHz).toBe(Math.round(owner?.frequencyHz ?? 0))
		const listed = await inventory.list({ channelHz })
		expect(listed.items.map(i => i.key)).toEqual([key])
		const nearby = await inventory.list({
			nearHz: channelHz,
			toleranceHz: 50_000,
		})
		expect(nearby.matchedByChannel).toEqual([
			{ frequencyHz: channelHz, count: 1 },
		])
	}, 240_000)

	it("a held file discarded when its hold ends never gets a row or a link", async () => {
		const { w, runtime, inventory, codes } = await scene(true)
		expect(codes()).not.toContain("finalized")
		expect(codes()).toContain("discarded:late-non-voice")
		expect(w.wavSeconds()).toEqual([])
		// Give a late listener every chance: still nothing.
		await w.advance(SETTLED_MS)
		expect(runtime.recordingLinks?.()?.linkedRecordings()).toEqual([])
		const page = await runtime.service.search({
			query: { kinds: ["recording-change"] },
		})
		expect(page.items).toEqual([])
		const withAudio = await runtime.service.search({
			query: { hasRecording: true },
		})
		expect(withAudio.items).toEqual([])
		expect((await inventory.list({})).items).toEqual([])
	}, 240_000)
})
