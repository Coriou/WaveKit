/**
 * Identify regression snapshots, updated for scanner redesign 6.7/6.9:
 * narrow analog eligibility, nonzero priors, explicit requests, and evidence-only labels.
 * WAVEKIT_WRITE_IDENTIFY_GOLDENS=1 refreshes the snapshots locally.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type {
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
} from "@wavekit/api-types"
import {
	IdentifyRunner,
	normaliseIdentify,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type { IdentifyAnalogEvidence } from "../../../../src/core/scanner/identify-analog-contract.js"
import type { ArtefactKind } from "../../../../src/core/spectrum/artefacts.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { DecoderSpawnError } from "../../../../src/utils/errors.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import {
	flushAsync,
	linkLine,
	poolHarness,
} from "../../../mocks/scanner/probe-fakes.js"

const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"identify-analog-goldens.json",
)
const ENDED = ["completed", "cancelled", "failed"]

interface Extra {
	analogEvidence?: IdentifyAnalogEvidence
	memo?: (now: number) => ReadonlySet<string>
}

function harness(
	opts: {
		request?: Partial<ScannerIdentifyRequest>
		artefact?: ArtefactKind | null
		extra?: Extra
	} = {},
) {
	const settings = testSettings()
	const pool = poolHarness({ settings, cpuPercent: null })
	if (opts.extra?.memo)
		Object.assign(pool.pool, { unavailableTypes: opts.extra.memo })
	const record = identifyRecord()
	const inner = fakeInner(record, () => pool.clock.now)
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			...opts.request,
		}),
		inner,
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(opts.artefact ?? null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: () => undefined,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
		...(opts.extra?.analogEvidence
			? { analogEvidence: opts.extra.analogEvidence }
			: {}),
	})
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const settle = async (stepMs: number, steps: number): Promise<void> => {
		for (let i = 0; i < steps && !ENDED.includes(record.state); i++)
			await advance(stepMs)
	}
	return { ...pool, record, tracks, events, runner, advance, settle }
}

type H = ReturnType<typeof harness>

const dmrTrack = (over: Partial<TrackSnapshot> = {}): TrackSnapshot =>
	trackOf({ acf30: -0.94, acf60: 0.99, ...over })

async function startWith(h: H, ...tracks: TrackSnapshot[]): Promise<void> {
	await h.runner.start()
	for (const t of tracks) h.tracks.push(viewOf(t, `d_${t.trackId}`))
	await h.advance(100)
	await h.advance(100)
	await flushAsync()
}

function firstProbe(h: H): string {
	return [...h.decoders.created.values()][0]?.id ?? ""
}

interface GoldenScenario {
	name: string
	run: (extra?: Extra) => Promise<ScannerIdentifyEventData[]>
}

/** Scenarios: analog targets (narrow NFM, wide), digital decode, exhaustive, artefact, all, no signal, unavailable. */
const SCENARIOS: GoldenScenario[] = [
	{
		name: "nfm-9k-nothing-decodes",
		run: async extra => {
			const h = harness(extra ? { extra } : {})
			await startWith(h, trackOf({ obwHz: 11_000, spectralShape: "flat" }))
			await h.settle(1000, 60)
			return h.events
		},
	},
	{
		name: "wide-12k-nothing-decodes",
		run: async extra => {
			const h = harness(extra ? { extra } : {})
			await startWith(h, trackOf({ obwHz: 12_000 }))
			await h.settle(1000, 60)
			return h.events
		},
	},
	{
		name: "analog-fm-only-request",
		run: async extra => {
			const h = harness({
				request: { protocols: ["analog-fm"] },
				...(extra ? { extra } : {}),
			})
			await startWith(h, trackOf({ obwHz: 12_000 }))
			await h.settle(1000, 30)
			return h.events
		},
	},
	{
		name: "analog-am-only-request",
		run: async extra => {
			const h = harness({
				request: { protocols: ["analog-am"] },
				...(extra ? { extra } : {}),
			})
			await startWith(h, trackOf({ obwHz: 8_000 }))
			await h.settle(1000, 30)
			return h.events
		},
	},
	{
		name: "dmr-decoded",
		run: async extra => {
			const h = harness(extra ? { extra } : {})
			h.engine.push(1_100_000)
			await startWith(h, dmrTrack())
			const id = firstProbe(h)
			h.decoders.emitLink(id, linkLine(1, h.clock.now))
			h.decoders.emitLink(id, linkLine(1, h.clock.now + 30))
			await flushAsync()
			await h.settle(1000, 40)
			return h.events
		},
	},
	{
		name: "dmr-decoded-exhaustive",
		run: async extra => {
			const h = harness({
				request: { exhaustive: true },
				...(extra ? { extra } : {}),
			})
			h.engine.push(1_100_000)
			await startWith(h, dmrTrack())
			const id = firstProbe(h)
			h.decoders.emitLink(id, linkLine(1, h.clock.now))
			h.decoders.emitLink(id, linkLine(1, h.clock.now + 30))
			await flushAsync()
			await h.settle(1000, 60)
			return h.events
		},
	},
	{
		name: "dc-artefact",
		run: async extra => {
			const h = harness({ artefact: "dc", ...(extra ? { extra } : {}) })
			await startWith(h, trackOf())
			await h.settle(1000, 5)
			return h.events
		},
	},
	{
		name: "no-signal-timeout",
		run: async extra => {
			const h = harness({
				request: { timeoutMs: 3000 },
				...(extra ? { extra } : {}),
			})
			await h.runner.start()
			await h.settle(500, 30)
			return h.events
		},
	},
	{
		name: "all-two-tracks",
		run: async extra => {
			const h = harness({
				request: { target: { all: true }, timeoutMs: 4000 },
				...(extra ? { extra } : {}),
			})
			await startWith(
				h,
				trackOf({ trackId: "a", obwHz: 11_000, snrDb: 20 }),
				trackOf({
					trackId: "b",
					centreHz: 446_300_000,
					obwHz: 12_000,
					snrDb: 40,
				}),
			)
			await h.settle(1000, 80)
			return h.events
		},
	},
	{
		name: "spawn-enoent-unavailable",
		run: async extra => {
			const h = harness(extra ? { extra } : {})
			const cause = new Error("spawn failed") as NodeJS.ErrnoException
			cause.code = "ENOENT"
			h.decoders.failNext = new DecoderSpawnError("probe", "/bin/sh", cause)
			await startWith(h, trackOf({ obwHz: 12_000 }))
			await flushAsync()
			await h.settle(1000, 60)
			return h.events
		},
	},
]

/** Scenarios whose stream a WG10 requirement changes on purpose (field added to every result). */
const CHANGED: Readonly<Record<string, Record<string, unknown>>> = {
	"spawn-enoent-unavailable": { decodersUnavailable: ["multimon-ng"] },
}

function withAdded(
	events: ScannerIdentifyEventData[],
	added: Record<string, unknown> | undefined,
): ScannerIdentifyEventData[] {
	if (!added) return events
	return events.map(e =>
		e.result ? { ...e, result: { ...e.result, ...added } } : e,
	)
}

describe("identify goldens without the analog port (WG10 3.1, 3.5)", () => {
	if (process.env["WAVEKIT_WRITE_IDENTIFY_GOLDENS"] === "1") {
		it("records the goldens", async () => {
			const out: Record<string, ScannerIdentifyEventData[]> = {}
			for (const s of SCENARIOS) out[s.name] = await s.run()
			writeFileSync(FIXTURE, `${JSON.stringify(out, null, "\t")}\n`)
		})
		return
	}
	const goldens = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
		string,
		ScannerIdentifyEventData[]
	>
	for (const s of SCENARIOS) {
		it(`${s.name} matches the evidence-bound stream`, async () => {
			const recorded = goldens[s.name]
			expect(recorded).toBeDefined()
			const events = await s.run()
			expect(events).toEqual(withAdded(recorded!, CHANGED[s.name]))
		})
		it(`${s.name} matches with an empty unavailable memo wired`, async () => {
			const events = await s.run({ memo: () => new Set() })
			expect(events).toEqual(withAdded(goldens[s.name]!, CHANGED[s.name]))
		})
	}
})
