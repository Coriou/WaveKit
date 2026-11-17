/**
 * Real wiring, scanner probe reception → its row's channel: a real ScannerService (the service
 * harness: fake source, fanout and tuner) running one probe for a discovery in its own store, the
 * production Activity runtime (inline store and reader) with the channel lookup src/index.ts
 * composes (activityProbeChannel over ScannerService.probeChannel), the dsd-fme adapter fed one
 * DMR call in dsd-fme's line format as the probe decoder, and the REST activity route. The row
 * carries the discovery's raster frequency and its `discoveryId` ref; after a merge the next
 * reception names the survivor; once no live discovery owns the probe, rows carry no channel.
 * Modelled frequencies and ids only.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { activityRoutes } from "../../../../src/api/routes/activity.js"
import { startActivityRuntime } from "../../../../src/core/activity/runtime.js"
import type { ActivityRuntime } from "../../../../src/core/activity/runtime.js"
import type { ActivitySummary } from "../../../../src/core/activity/storage/contract.js"
import type { ProbePool } from "../../../../src/core/scanner/probes/probe-pool.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { DsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import type { ActivityPublisher } from "../../../../src/decoders/manager.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../../src/decoders/types.js"
import { activityProbeChannel } from "../../../../src/index.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import { probeRequest } from "../../../mocks/scanner/probe-fakes.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const logger = pino({ level: "silent" })

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

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

describe("a scanner probe's reception carries its discovery's channel", () => {
	it("stores the raster channel and discoveryId ref, follows a merge, and drops a gone discovery", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		cleanups.push(() => h.service.stop())
		await h.service.createJob({ sourceId: "rtl", mode: "in-window" })
		const internals = h.service as unknown as {
			probes: ProbePool
			store: DiscoveryStore
		}
		const now = Date.now()
		// Two modelled discoveries 12.5 kHz apart inside the source's window.
		const first = internals.store.ingest(
			makeObs({ id: "o-probe-a", centreHz: CENTRE + 25_000, startedAt: now }),
		).discoveryId
		const second = internals.store.ingest(
			makeObs({ id: "o-probe-b", centreHz: CENTRE + 37_500, startedAt: now }),
		).discoveryId
		if (!first || !second) throw new TypeError("fixture discoveries missing")
		const firstHz = internals.store.get(first)!.frequencyHz

		const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()
		const result = internals.probes.request(
			probeRequest({
				epoch: epoch.epoch,
				targetHz: firstHz,
				discoveryId: first,
				holdMs: 60_000,
			}),
		)
		if (!("started" in result))
			throw new TypeError("fixture probe not admitted")
		const probe = internals.probes
			.status()
			.find(p => p.probeId === result.started)
		if (!probe) throw new TypeError("fixture probe missing")
		const decoderId = probe.decoderId
		expect(decoderId).toMatch(/^scan-/)

		const stateDir = await mkdtemp(join(tmpdir(), "wk-probe-channel-"))
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
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
			// As src/index.ts composes it.
			channel: activityProbeChannel(() => h.service),
		})
		cleanups.push(() => runtime.close())
		expect(runtime.status).toBe("ready")

		const config: DecoderConfig = {
			id: decoderId,
			type: "dsd-fme",
			enabled: true,
			options: { mode: "auto" },
		}
		const decoder = new DsdFmeDecoder(config, logger)
		decoder.on("output", (output: DecoderOutput) => {
			// What DecoderManager does with every output, ephemeral probe decoders included.
			publish?.(config.id, config.type, output)
		})
		const lines = decoder as unknown as {
			handleOutputLine(line: string): void
		}
		const call = async (source: number): Promise<void> => {
			for (const line of callLines(source)) {
				lines.handleOutputLine(line)
				await new Promise(resolve => setTimeout(resolve, 20))
			}
		}

		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service: runtime.service,
			enabled: true,
		})
		cleanups.push(() => app.close())
		const list = async (query: string): Promise<ActivitySummary[]> => {
			const res = await app.inject({
				method: "GET",
				url: `/api/activity?limit=100${query}`,
			})
			expect(res.statusCode, query).toBe(200)
			return (res.json() as { items: ActivitySummary[] }).items
		}
		const bySource = (items: ActivitySummary[], source: number) =>
			items.filter(i => JSON.stringify(i).includes(`${source}`))

		// 1. The probe's discovery is live: every row of the call carries its channel.
		await call(3001)
		const rows = bySource(await list(""), 3001)
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows)
			expect(row.channel).toEqual({ discoveryId: first, frequencyHz: firstHz })
		// The channel's refs: the discoveryId ref and the channel query both find the rows.
		const byRef = bySource(await list(`&refs=discoveryId:${first}`), 3001)
		expect(byRef.map(r => r.eventId).sort()).toEqual(
			rows.map(r => r.eventId).sort(),
		)
		const byChannel = bySource(await list(`&channelHz=${firstHz}`), 3001)
		expect(byChannel.map(r => r.eventId).sort()).toEqual(
			rows.map(r => r.eventId).sort(),
		)

		// 2. A merge absorbs the probe's discovery: the next reception names the survivor.
		const merged = internals.store.applyConsolidation({
			groups: [{ survivor: second, members: [first] }],
		})
		expect(merged.absorbed).toBe(1)
		expect(internals.store.get(first)).toBeUndefined()
		// The survivor's frequency after the merge (its observations now include the absorbed ones).
		const secondHz = internals.store.get(second)!.frequencyHz
		await call(3002)
		const after = bySource(await list(""), 3002)
		expect(after.length).toBeGreaterThan(0)
		for (const row of after)
			expect(row.channel).toEqual({
				discoveryId: second,
				frequencyHz: secondHz,
			})

		// 3. No live discovery owns the probe any more: the row is kept without a channel.
		expect(internals.store.delete(second)).toBe(true)
		await call(3003)
		const orphan = bySource(await list(""), 3003)
		expect(orphan.length).toBeGreaterThan(0)
		for (const row of orphan) expect(row.channel).toBeUndefined()
	}, 30_000)

	it("answers null for every decoder that is not a running probe, and without a scanner", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		cleanups.push(() => h.service.stop())
		const lookup = activityProbeChannel(() => h.service)
		// A configured decoder, a probe-shaped id no probe runs, a near-miss shape.
		for (const id of ["dsd-fme", "scan-abc-dmr-7", "scan-ABC-dmr-7", "scan-"])
			expect(lookup(id, CENTRE), id).toBeNull()
		expect(h.service.probeChannel("dsd-fme")).toBeNull()
		expect(activityProbeChannel(() => null)("scan-abc-dmr-7", null)).toBeNull()
	})

	it("never asks the scanner for an id that is not probe-shaped", () => {
		let asked = 0
		const lookup = activityProbeChannel(() => ({
			probeChannel: () => {
				asked++
				return { discoveryId: "d_x", frequencyHz: 1 }
			},
		}))
		expect(lookup("ais-1", null)).toBeNull()
		expect(lookup("scan-abc-dmr-1-extra", null)).toBeNull()
		expect(asked).toBe(0)
		expect(lookup("scan-abc-dmr-1", null)).toEqual({
			discoveryId: "d_x",
			frequencyHz: 1,
		})
		expect(asked).toBe(1)
	})
})
