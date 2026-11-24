/**
 * Shared harness of the transmission route tests: the production Activity runtime (inline store
 * and reader, real SQLite in a temp directory), a registry, a memory catalogue double that
 * answers the two memory reads the route uses, and the route on a bare Fastify app. Synthetic
 * values only.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import pino from "pino"
import { expect } from "vitest"
import type {
	AnalogTransmissionPayload,
	RecordingChangePayload,
	RecordingInventoryItem,
	RecordingTone,
} from "@wavekit/api-types"
import { transmissionRoutes } from "../../../src/api/routes/transmissions.js"
import type { TransmissionRoutesOptions } from "../../../src/api/routes/transmissions.js"
import { startActivityRuntime } from "../../../src/core/activity/runtime.js"
import type { ActivityRuntime } from "../../../src/core/activity/runtime.js"
import type { ActivityQueryService } from "../../../src/core/activity/storage/contract.js"
import type { RecordingInventory } from "../../../src/core/recordings/inventory.js"
import { TransmissionRegistry } from "../../../src/core/transmissions/index.js"
import type { ActivityPublisher } from "../../../src/decoders/manager.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"

export const logger = pino({ level: "silent" })

export const TX_A = `tx_01JTESTTX${"A".repeat(17)}`
export const TX_B = `tx_01JTESTTX${"B".repeat(17)}`
export const TX_C = `tx_01JTESTTX${"C".repeat(17)}`
export const DISCOVERY = "d_01JTESTDISCOVERY"
export const keyOf = (n: number): string =>
	`scan:${DISCOVERY}~analog-6f0a2c1e-1111-4222-8333-${String(n).padStart(12, "0")}.wav`
export const DSD_NAME = "20261016_120000_01234_YSF_1_GROUP_TGT_100_SRC_2001.wav"

export interface Harness {
	runtime: ActivityRuntime
	registry: TransmissionRegistry
	items: Map<string, RecordingInventoryItem>
	publish(decoderId: string, output: DecoderOutput): void
	analog(patch: Partial<AnalogTransmissionPayload>): void
	kept(patch: Partial<RecordingChangePayload>): void
	/** Waits until the store answers `n` rows. */
	rows(n: number): Promise<void>
	app(opts?: Partial<TransmissionRoutesOptions>): Promise<FastifyInstance>
	inventory: RecordingInventory
	counts: { search: number; detail: number }
	close(): Promise<void>
}

export async function harness(now = Date.now()): Promise<Harness> {
	const stateDir = await mkdtemp(join(tmpdir(), "wk-tx-route-"))
	let publish: ActivityPublisher | null = null
	const runtime = await startActivityRuntime({
		enabled: true,
		stateDir,
		logger,
		execution: "inline",
		queryExecution: "inline",
		limits: { batchWindowMs: 0 },
		setPublisher: p => {
			publish = p
		},
		callRecordings: () => true,
	})
	expect(runtime.status).toBe("ready")
	const registry = new TransmissionRegistry({ now: () => now })
	const items = new Map<string, RecordingInventoryItem>()
	const inventory = {
		list: () => Promise.reject(new Error("not used")),
		resolve: () => Promise.resolve(null),
		open: () => Promise.resolve(null),
		itemsOfKeys: (keys: readonly string[]) =>
			keys.flatMap(k => {
				const item = items.get(k)
				return item ? [item] : []
			}),
		keysOfTx: (txId: string) =>
			[...items.values()]
				.filter(
					i =>
						i.facts?.txId === txId || (i.facts?.moreTxIds ?? []).includes(txId),
				)
				.map(i => i.key ?? i.id),
		keysOfCopyRoot: (key: string) =>
			[...items.values()]
				.filter(i => i.copyOf?.key === key)
				.map(i => i.key ?? i.id),
	} as unknown as RecordingInventory
	const counts = { search: 0, detail: 0 }
	const service = runtime.service
	const counted: ActivityQueryService = {
		...service,
		search: input => {
			counts.search++
			return service.search(input)
		},
		detail: eventId => {
			counts.detail++
			return service.detail(eventId)
		},
	}
	const apps: FastifyInstance[] = []
	const endedAt = new Date(now).toISOString()
	return {
		runtime,
		registry,
		items,
		inventory,
		counts,
		publish(decoderId, output) {
			publish?.(decoderId, "dsd-fme", output)
		},
		analog(patch) {
			runtime.transmissionSink()?.({
				transmissionId: "t-1",
				sourceId: "source-1",
				startedAt: new Date(now - 2_500).toISOString(),
				endedAt,
				durationMs: 2_500,
				frequency: { hz: 100_000_000, tuningTrust: "commanded" },
				modulation: "nfm",
				bandwidthHz: 12_500,
				squelchMode: "manual",
				thresholdDbfs: -40,
				peakChannelPowerDbfs: -12.5,
				meanChannelPowerDbfs: -18,
				closeReason: "squelch",
				...patch,
			})
		},
		kept(patch) {
			runtime.recordingLinks?.()?.admitRecording({
				change: "finalized",
				recordingId: keyOf(1),
				recordingKind: "scanner-analog",
				discoveryId: DISCOVERY,
				observationId: "o_01JTESTOBSERVATION",
				sourceId: "source-1",
				frequencyHz: 100_000_300,
				observationStartedAt: new Date(now - 60_000).toISOString(),
				durationMs: 3_500,
				finalizedAt: endedAt,
				...patch,
			})
		},
		async rows(n) {
			await expect
				.poll(
					async () =>
						(await service.search({ query: {}, limit: 100 })).items.length,
					{ timeout: 5_000 },
				)
				.toBe(n)
		},
		async app(opts = {}) {
			const app = Fastify({ logger: false })
			await app.register(transmissionRoutes, {
				transmissions: registry,
				activity: counted,
				inventory,
				...opts,
			})
			apps.push(app)
			return app
		},
		async close() {
			for (const a of apps) await a.close()
			await runtime.close()
			await rm(stateDir, { recursive: true, force: true })
		},
	}
}

/** A kept scanner analog catalogue item (as the inventory lists one). */
export function analogItem(
	key: string,
	patch: {
		txId?: string
		moreTxIds?: string[]
		tone?: RecordingTone | null
		part?: number
		parts?: number
		/** The listed root this file is a copy of (RecordingInventoryItem.copyOf). */
		copyOf?: { key: string; evidence: string[] }
		frequencyHz?: number
	} = {},
): RecordingInventoryItem {
	return {
		id: key,
		kind: "scanner-analog",
		decoderId: null,
		discoveryId: DISCOVERY,
		startedAtLocal: null,
		modifiedAt: "2026-10-12T00:00:30.000Z",
		bytes: 56_044,
		durationMs: 3_500,
		callType: null,
		talkgroup: null,
		source: null,
		frequencyHz: 100_000_000,
		kept: false,
		key,
		ownerDiscoveryId: DISCOVERY,
		cut: null,
		part: patch.part ?? null,
		parts: patch.parts ?? null,
		startedAt: "2026-10-12T00:00:26.500Z",
		observationId: "o_01JTESTOBSERVATION",
		speech: "heard",
		keptBy: "final",
		txId: patch.txId ?? null,
		copyOf: patch.copyOf ?? null,
		facts: {
			version: 1,
			operationId: "op-1",
			discoveryId: DISCOVERY,
			observationId: "o_01JTESTOBSERVATION",
			frequencyHz: patch.frequencyHz ?? 100_000_300,
			startedAt: "2026-10-12T00:00:26.500Z",
			endedAt: "2026-10-12T00:00:30.000Z",
			keptAt: "2026-10-12T00:00:30.000Z",
			durationMs: 3_500,
			finish: {
				cut: "completed",
				keptBy: "final",
				speechHeard: true,
				cutActive: false,
			},
			admission: null,
			...(patch.tone !== undefined ? { tone: patch.tone } : {}),
			...(patch.txId !== undefined ? { txId: patch.txId } : {}),
			...(patch.moreTxIds !== undefined ? { moreTxIds: patch.moreTxIds } : {}),
		},
	} as RecordingInventoryItem
}
