import { STORAGE_AREA_IDS } from "@wavekit/api-types"
import type { StorageReport } from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"
import type { StorageReportProvider } from "../../core/storage-report/contract.js"

export interface StorageRoutesOptions {
	report: StorageReportProvider
}

const nullableNumber = { type: ["number", "null"] } as const
const nullableString = { type: ["string", "null"] } as const
const policy = { type: "string", enum: ["fair-share", "oldest-first"] } as const

const retentionSchema = {
	anyOf: [
		{ type: "null" },
		{
			type: "object",
			additionalProperties: false,
			properties: {
				policy,
				effective: { anyOf: [{ type: "null" }, policy] },
				maxRows: { type: "number" },
				maxDbBytes: { type: "number" },
				maxAgeMs: { type: "number" },
				rows: nullableNumber,
				oldestReceivedAt: nullableString,
				shares: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							key: { type: "string" },
							rows: { type: "number" },
							bytes: { type: "number" },
							oldestReceivedAt: nullableString,
						},
						required: ["key", "rows", "bytes", "oldestReceivedAt"],
					},
				},
				sharesTruncated: { type: "boolean" },
			},
			required: [
				"policy",
				"effective",
				"maxRows",
				"maxDbBytes",
				"maxAgeMs",
				"rows",
				"oldestReceivedAt",
				"shares",
				"sharesTruncated",
			],
		},
	],
} as const

const areaSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: "string", enum: [...STORAGE_AREA_IDS] },
		class: { type: "string", enum: ["automatic", "state", "other"] },
		bytes: { type: "number" },
		files: { type: "number" },
		exists: { type: "boolean" },
		partial: { type: "boolean" },
		partialReason: {
			anyOf: [
				{ type: "null" },
				{
					type: "string",
					enum: [
						"entry-limit",
						"depth-limit",
						"time-limit",
						"permission",
						"io-error",
					],
				},
			],
		},
		cap: {
			anyOf: [
				{ type: "null" },
				{
					type: "object",
					additionalProperties: false,
					properties: { bytes: { type: "number" } },
					required: ["bytes"],
				},
			],
		},
		retention: retentionSchema,
	},
	required: [
		"id",
		"class",
		"bytes",
		"files",
		"exists",
		"partial",
		"partialReason",
		"cap",
		"retention",
	],
} as const

const responseSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		generatedAt: { type: "string" },
		cachedUntil: { type: "string" },
		filesystem: {
			anyOf: [
				{ type: "null" },
				{
					type: "object",
					additionalProperties: false,
					properties: {
						totalBytes: { type: "number" },
						freeBytes: { type: "number" },
						availableBytes: { type: "number" },
					},
					required: ["totalBytes", "freeBytes", "availableBytes"],
				},
			],
		},
		areas: { type: "array", items: areaSchema },
		kept: { type: "null" },
		lowSpace: {
			type: "object",
			additionalProperties: false,
			properties: {
				policy: { type: "string", const: "scanner-evidence-stops-writing" },
				minFreeBytes: nullableNumber,
				state: { type: "string", enum: ["ok", "low", "unknown"] },
			},
			required: ["policy", "minFreeBytes", "state"],
		},
	},
	required: [
		"generatedAt",
		"cachedUntil",
		"filesystem",
		"areas",
		"kept",
		"lowSpace",
	],
} as const

const errorSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "STORAGE_REPORT_FAILED" },
	},
	required: ["error", "code"],
} as const

export const storageRoutes: FastifyPluginAsync<StorageRoutesOptions> = async (
	app,
	options,
) => {
	app.get<{
		Reply: StorageReport | { error: string; code: "STORAGE_REPORT_FAILED" }
	}>(
		"/api/storage",
		{
			schema: {
				description:
					"Sizes of the directories and files WaveKit writes, without paths",
				tags: ["storage"],
				response: { 200: responseSchema, 500: errorSchema },
			},
		},
		async (request, reply) => {
			reply.header("Cache-Control", "no-store")
			try {
				return await options.report.report()
			} catch (err) {
				request.log.error({ err }, "Storage report failed")
				reply.status(500)
				return {
					error: "Storage report failed",
					code: "STORAGE_REPORT_FAILED" as const,
				}
			}
		},
	)
}
