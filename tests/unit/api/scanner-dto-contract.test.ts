/**
 * Scanner DTO contract (spec § 12.4): new DecoderStatus fields and the
 * tuner-scanning reason survive the Fastify response schema, the
 * decoder:status serializer emits the same body, and the api-types scanner
 * DTOs stay identical to the core types they mirror.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import type * as Api from "@wavekit/api-types"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import { toApiDecoderInfo } from "../../../src/api/serializers/decoder-status.js"
import type { Bandplan as CoreBandplan } from "../../../src/core/scanner/bandplan/index.js"
import type * as CoreSettings from "../../../src/core/scanner/settings.js"
import type * as Core from "../../../src/core/scanner/types.js"
import type { SettleMode as CoreSettleMode } from "../../../src/core/spectrum/types.js"
import type { DecoderCaps, DecoderStatus } from "../../../src/decoders/types.js"

/**
 * Identity, not mutual assignability: an optional key added or dropped on one
 * side, at any depth, or a changed modifier makes it false.
 */
type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
// The guard sees optional keys: mutual assignability would call these the same.
const optionalCanary: Same<{ a?: number }, Record<never, never>> = false
// Compile-time drift guard (checked by `pnpm run typecheck`): the DTOs are copies.
const sameShapes: [
	Same<Api.Discovery, Core.Discovery>,
	Same<Api.Observation, Core.Observation>,
	Same<Api.ScanJobSpec, Core.ScanJobSpec>,
	Same<Api.NormalisedJobSpec, Core.NormalisedJobSpec>,
	Same<Api.HopPlan, Core.HopPlan>,
	Same<Api.PlanPreview, Core.PlanPreview>,
	Same<Api.Impact, Core.Impact>,
	Same<Api.PlanIssue, Core.PlanIssue>,
	Same<Api.ScannerSettingsValues, Core.ScannerSettings>,
	Same<Api.ScannerProtocol, Core.ScannerProtocol>,
	Same<Api.ScannerSettingProvenance, CoreSettings.ScannerSettingProvenance>,
	Same<Api.ScannerSettingBounds, CoreSettings.ScannerSettingBounds>,
	Same<Api.JobState, Core.JobState>,
	Same<Api.PauseReason, Core.PauseReason>,
	Same<Api.FailReason, Core.FailReason>,
	Same<Api.Bandplan, CoreBandplan>,
	Same<Api.SettleMode, CoreSettleMode>,
] = [
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
]

const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
/** One registry for the route and the WS serializer, as in production (routes/decoders.ts, server.ts). */
const decoderRegistry = {
	getCaps: () => caps,
	getRegisteredTypes: () => ["dsd-fme"],
} as unknown as DecoderRoutesOptions["decoderRegistry"]

function probeStatus(): DecoderStatus {
	return {
		id: "scan-abc1234-dmr-1",
		type: "dsd-fme",
		running: true,
		health: "running",
		uptime: 3,
		stats: { bytesIn: 10, eventsOut: 1, errors: 0 },
		restartCount: 0,
		desiredRunning: true,
		suspended: false,
		sourceId: "rtl",
		owner: "scanner",
		scannerJobId: "j_01JABCDEF",
		ephemeral: true,
	}
}

function heldStatus(): DecoderStatus {
	return {
		id: "dmr",
		type: "dsd-fme",
		running: false,
		health: "running",
		uptime: 0,
		stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
		restartCount: 0,
		desiredRunning: true,
		suspended: true,
		suspension: {
			reasonCode: "tuner-scanning",
			since: new Date("2026-10-09T12:00:00.000Z"),
		},
		sourceId: "rtl",
		owner: "config",
	}
}

describe("scanner DecoderStatus fields over REST and WS", () => {
	let app: FastifyInstance
	let statuses: DecoderStatus[]

	beforeEach(async () => {
		statuses = [probeStatus(), heldStatus()]
		app = Fastify()
		await app.register(decoderRoutes, {
			decoderManager: {
				getAllStatus: () => statuses,
				getStatus: (id: string) => statuses.find(s => s.id === id),
				getDecoder: (id: string) => {
					const s = statuses.find(x => x.id === id)
					return s ? { caps, getStatus: () => s } : undefined
				},
			} as unknown as DecoderRoutesOptions["decoderManager"],
			decoderRegistry,
		})
	})
	afterEach(async () => {
		await app.close()
	})

	it("keeps owner, scannerJobId and ephemeral on a probe", async () => {
		const body = (await app.inject("/api/decoders")).json() as Record<
			string,
			unknown
		>[]
		expect(body[0]).toMatchObject({
			owner: "scanner",
			scannerJobId: "j_01JABCDEF",
			ephemeral: true,
		})
		expect(body[1]?.["owner"]).toBe("config")
		expect(body[1]).not.toHaveProperty("ephemeral")
		expect(body[1]).not.toHaveProperty("scannerJobId")
	})

	it("reports a held configured decoder as suspended for tuner-scanning", async () => {
		const body = (await app.inject("/api/decoders/dmr")).json() as Record<
			string,
			unknown
		>
		expect(body).toMatchObject({
			suspended: true,
			suspension: {
				reasonCode: "tuner-scanning",
				since: "2026-10-09T12:00:00.000Z",
			},
		})
	})

	it("the decoder:status payload equals the REST body", async () => {
		for (const status of statuses) {
			const rest = (
				await app.inject(`/api/decoders/${status.id}`)
			).json() as unknown
			const ws = JSON.parse(
				JSON.stringify(toApiDecoderInfo(status, decoderRegistry)),
			) as unknown
			expect(ws).toEqual(rest)
		}
	})

	it("the DTO copies match the core types", () => {
		expect(sameShapes.every(Boolean)).toBe(true)
		expect(optionalCanary).toBe(false)
	})
})
