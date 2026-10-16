/**
 * WG5 frozen contract (docs/specs/web-gaps-5, task 0.1): additive Activity aggregate DTOs and
 * optional query-service methods, the optional vessel fields, the widened band-plan import
 * formats with a parser slot that keeps today's behaviour, the ShipData names lanes AIS and
 * TA share, and the tuner source type of the provenance index. No behaviour beyond defaults.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import {
	ACTIVITY_AGGREGATES_SCAN_ROWS,
	ACTIVITY_BANDMAP_DEFAULT_BUCKET_HZ,
	ACTIVITY_BANDMAP_DEFAULT_MAX_HZ,
	ACTIVITY_BANDMAP_DEFAULT_MIN_HZ,
	ACTIVITY_BANDMAP_DEFAULT_WINDOW_MS,
	ACTIVITY_BANDMAP_MAX_BUCKET_HZ,
	ACTIVITY_BANDMAP_MAX_BUCKETS,
	ACTIVITY_BANDMAP_MAX_HZ,
	ACTIVITY_BANDMAP_MAX_PROTOCOLS,
	ACTIVITY_BANDMAP_MAX_SPAN_HZ,
	ACTIVITY_BANDMAP_MAX_TOP_ENTITIES,
	ACTIVITY_BANDMAP_MAX_WINDOW_MS,
	ACTIVITY_BANDMAP_MIN_BUCKET_HZ,
	ACTIVITY_TIMELINE_DEFAULT_BUCKET_MS,
	ACTIVITY_TIMELINE_DEFAULT_WINDOW_MS,
	ACTIVITY_TIMELINE_MAX_BUCKET_MS,
	ACTIVITY_TIMELINE_MAX_BUCKETS,
	ACTIVITY_TIMELINE_MAX_ENTITY_KEYS,
	ACTIVITY_TIMELINE_MAX_WINDOW_MS,
	ACTIVITY_TIMELINE_MIN_BUCKET_MS,
	BANDPLAN_IMPORT_FORMATS,
	importedProvenanceSchema,
} from "@wavekit/api-types"
import { inertActivityService } from "../../../src/core/activity/runtime.js"
import type * as Contract from "../../../src/core/activity/storage/contract.js"
import { openBandPlanService } from "../../../src/core/bandplans/index.js"
import type { BandPlanService } from "../../../src/core/bandplans/index.js"
import type {
	BandPlanImportParser,
	BandPlanImportParsers,
	ParseSdrppBandPlan,
	SdrppFailureReason,
} from "../../../src/core/bandplans/contract.js"
import type { TunerController } from "../../../src/core/tuner-controller.js"
import type { ShipData } from "../../../src/decoders/builtin/ais-catcher.js"
import type {
	ProvenanceTunerSource,
	ProvenanceTunerState,
} from "../../../src/decoders/provenance-bindings.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value

describe("WG5 contract", () => {
	let directory: string
	const services: BandPlanService[] = []
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "wg5-contract-"))
	})
	afterEach(async () => {
		for (const service of services.splice(0)) await service.close()
		rmSync(directory, { recursive: true, force: true })
	})

	it("keeps the aggregate DTO copies identical and the bounds pinned", () => {
		// Feature: web-gaps-5, requirements 1.2-1.6 and 2.2-2.4
		expect(
			same<
				Api.ActivityAggregateTruncation,
				Contract.ActivityAggregateTruncation
			>(true),
		).toBe(true)
		expect(
			same<Api.ActivityBandMapTruncation, Contract.ActivityBandMapTruncation>(
				true,
			),
		).toBe(true)
		expect(
			same<
				Api.ActivityBandMapTruncation,
				"scan-rows" | "time-limit" | "buckets"
			>(true),
		).toBe(true)
		expect(
			same<Api.ActivityBandMapQuery, Contract.ActivityBandMapQuery>(true),
		).toBe(true)
		expect(
			same<Api.ActivityBandMapProtocol, Contract.ActivityBandMapProtocol>(true),
		).toBe(true)
		expect(
			same<Api.ActivityBandMapEntity, Contract.ActivityBandMapEntity>(true),
		).toBe(true)
		expect(
			same<Api.ActivityBandMapBucket, Contract.ActivityBandMapBucket>(true),
		).toBe(true)
		expect(same<Api.ActivityBandMap, Contract.ActivityBandMap>(true)).toBe(true)
		expect(
			same<Api.ActivityTimelineQuery, Contract.ActivityTimelineQuery>(true),
		).toBe(true)
		expect(
			same<Api.ActivityTimelineBucket, Contract.ActivityTimelineBucket>(true),
		).toBe(true)
		expect(same<Api.ActivityTimeline, Contract.ActivityTimeline>(true)).toBe(
			true,
		)

		expect(ACTIVITY_AGGREGATES_SCAN_ROWS).toBe(250_000)
		expect(ACTIVITY_BANDMAP_DEFAULT_WINDOW_MS).toBe(86_400_000)
		expect(ACTIVITY_BANDMAP_MAX_WINDOW_MS).toBe(259_200_000)
		expect(ACTIVITY_BANDMAP_DEFAULT_MIN_HZ).toBe(0)
		expect(ACTIVITY_BANDMAP_DEFAULT_MAX_HZ).toBe(2_000_000_000)
		expect(ACTIVITY_BANDMAP_MAX_SPAN_HZ).toBe(2_000_000_000)
		expect(ACTIVITY_BANDMAP_MAX_HZ).toBe(100_000_000_000)
		expect(ACTIVITY_BANDMAP_DEFAULT_BUCKET_HZ).toBe(12_500)
		expect(ACTIVITY_BANDMAP_MIN_BUCKET_HZ).toBe(1_000)
		expect(ACTIVITY_BANDMAP_MAX_BUCKET_HZ).toBe(1_000_000)
		expect(ACTIVITY_BANDMAP_MAX_BUCKETS).toBe(1_000)
		expect(ACTIVITY_BANDMAP_MAX_PROTOCOLS).toBe(8)
		expect(ACTIVITY_BANDMAP_MAX_TOP_ENTITIES).toBe(3)
		expect(ACTIVITY_TIMELINE_DEFAULT_WINDOW_MS).toBe(3_600_000)
		expect(ACTIVITY_TIMELINE_MAX_WINDOW_MS).toBe(259_200_000)
		expect(ACTIVITY_TIMELINE_DEFAULT_BUCKET_MS).toBe(60_000)
		expect(ACTIVITY_TIMELINE_MIN_BUCKET_MS).toBe(10_000)
		expect(ACTIVITY_TIMELINE_MAX_BUCKET_MS).toBe(3_600_000)
		expect(ACTIVITY_TIMELINE_MAX_BUCKETS).toBe(1_440)
		expect(ACTIVITY_TIMELINE_MAX_ENTITY_KEYS).toBe(64)
		// 1 440 one-minute buckets fit the 72 h window; the bucket count bounds the rest.
		expect(
			ACTIVITY_TIMELINE_MAX_BUCKETS * ACTIVITY_TIMELINE_DEFAULT_BUCKET_MS,
		).toBeLessThanOrEqual(ACTIVITY_TIMELINE_MAX_WINDOW_MS)
	})

	it("requires the aggregate methods; the inert service rejects them", async () => {
		expect(
			same<
				Pick<Contract.ActivityQueryService, "bandMap" | "timeline">,
				{
					bandMap(
						input: Contract.ActivityBandMapQuery,
					): Promise<Contract.ActivityBandMap>
					timeline(
						input: Contract.ActivityTimelineQuery,
					): Promise<Contract.ActivityTimeline>
				}
			>(true),
		).toBe(true)
		const service = inertActivityService()
		expect(service.bandMap).toBeTypeOf("function")
		expect(service.timeline).toBeTypeOf("function")
		await expect(service.bandMap({})).rejects.toMatchObject({
			code: "ACTIVITY_UNAVAILABLE",
		})
		await expect(service.timeline({})).rejects.toMatchObject({
			code: "ACTIVITY_UNAVAILABLE",
		})
	})

	it("keeps the WG5 vessel fields optional", () => {
		// Feature: web-gaps-5, requirement 5.5
		expect(
			same<
				Pick<Api.VesselState, "channel" | "aton" | "altitudeM">,
				{
					channel?: "A" | "B" | null
					aton?: Api.VesselAton | null
					altitudeM?: number | null
				}
			>(true),
		).toBe(true)
		expect(
			same<
				Api.VesselAton,
				{
					aidType: number | null
					virtual: boolean | null
					offPosition: boolean | null
				}
			>(true),
		).toBe(true)
	})

	it("names the ShipData fields lanes AIS and TA share", () => {
		// Feature: web-gaps-5, requirement 5.3
		const ship: ShipData = {
			mmsi: "992351000",
			lastSeen: new Date(0),
			messageType: 21,
			name: "NORTH CARDINAL BUOY 12",
			aidType: 9,
			virtualAid: false,
			offPosition: false,
			altitudeM: 120,
		}
		expect(ship.aidType).toBe(9)
	})

	it("widens the import formats and keeps persisted provenance readable", () => {
		// Feature: web-gaps-5, requirement 7.1
		expect([...BANDPLAN_IMPORT_FORMATS]).toEqual([
			"sdrpp-json",
			"sdrsharp-xml",
			"gqrx-csv",
		])
		expect(
			same<
				Api.BandPlanImportFormat,
				"sdrpp-json" | "sdrsharp-xml" | "gqrx-csv"
			>(true),
		).toBe(true)
		expect(
			same<Api.ImportPreview["format"], Api.BandPlanImportFormat>(true),
		).toBe(true)
		const provenance = {
			kind: "imported",
			trust: "community-unverified",
			format: "sdrpp-json",
			sourceName: "plan.json",
			author: null,
			licence: null,
			importedAt: "2026-10-16T00:00:00.000Z",
			sha256: "0".repeat(64),
		}
		for (const format of BANDPLAN_IMPORT_FORMATS)
			expect(
				importedProvenanceSchema.safeParse({ ...provenance, format }).success,
			).toBe(true)
		expect(
			importedProvenanceSchema.safeParse({ ...provenance, format: "csv" })
				.success,
		).toBe(false)
		expect(same<BandPlanImportParser, ParseSdrppBandPlan>(true)).toBe(true)
		expect(
			same<keyof BandPlanImportParsers, "sdrsharp-xml" | "gqrx-csv">(true),
		).toBe(true)
		const reasons: SdrppFailureReason[] = ["xml", "csv"]
		expect(reasons).toHaveLength(2)
	})

	it("advertises and parses SDR++, SDR# and Gqrx once Main wires the parsers", async () => {
		// Feature: web-gaps-5, requirement 7.1
		const service = await openBandPlanService({
			stateDir: directory,
			context: { region: "EU", effectiveCountry: null },
			writable: true,
		})
		services.push(service)
		expect(service.view().capabilities.importFormats).toEqual([
			"sdrpp-json",
			"sdrsharp-xml",
			"gqrx-csv",
		])
		const fixtures = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../mocks/fixtures/bandplans",
		)
		for (const [format, file] of [
			["sdrsharp-xml", "sdrsharp/BandPlan.xml"],
			["gqrx-csv", "synthetic-gqrx.csv"],
		] as const) {
			const preview = service.previewImport({
				format,
				fileName: file,
				contentBase64: readFileSync(join(fixtures, file)).toString("base64"),
				groupOverrides: [],
			})
			expect(preview.format).toBe(format)
			expect(preview.bands.length).toBeGreaterThan(0)
		}
	})

	it("types the provenance tuner source so TunerController satisfies it", () => {
		// Feature: web-gaps-5, requirement 6.1
		const accepts = (source: ProvenanceTunerSource | undefined): boolean =>
			source === undefined
		const controller = undefined as TunerController | undefined
		expect(accepts(controller)).toBe(true)
		expect(
			same<
				ProvenanceTunerState,
				Pick<
					Api.TunerState,
					"frequency" | "sampleRate" | "controlMode" | "unknownFields"
				>
			>(true),
		).toBe(true)
	})
})
