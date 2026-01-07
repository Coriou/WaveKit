/**
 * Telemetry Routes - Fanout backpressure monitoring endpoints
 *
 * Provides real-time visibility into fanout system health:
 * - GET /api/telemetry/fanout - Full telemetry snapshot
 * - GET /api/telemetry/fanout/branches - Branch-level telemetry array
 */

import type { FastifyPluginAsync } from "fastify"
import type {
	FanoutManager,
	FanoutStatus,
	BranchTelemetry,
} from "../../core/fanout-manager.js"

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Branch telemetry schema
 */
const branchTelemetrySchema = {
	type: "object",
	properties: {
		id: { type: "string", description: "Branch identifier" },
		decoderId: {
			type: "string",
			nullable: true,
			description: "Associated decoder ID",
		},
		sourceId: {
			type: "string",
			nullable: true,
			description: "Associated source ID",
		},
		backpressureActive: {
			type: "boolean",
			description: "Whether branch is currently dropping data",
		},
		backpressureSince: {
			type: "string",
			format: "date-time",
			nullable: true,
			description: "ISO timestamp when backpressure started",
		},
		backpressureEnterCount: {
			type: "integer",
			description: "Total times branch entered backpressure state",
		},
		lastBackpressureAt: {
			type: "string",
			format: "date-time",
			nullable: true,
			description: "ISO timestamp of last backpressure event",
		},
		lastDrainAt: {
			type: "string",
			format: "date-time",
			nullable: true,
			description: "ISO timestamp of last drain event",
		},
		droppedBytesTotal: {
			type: "integer",
			description: "Total bytes dropped since start",
		},
		droppedChunksTotal: {
			type: "integer",
			description: "Total chunks dropped since start",
		},
		bufferBytes: {
			type: "integer",
			description: "Current buffer usage in bytes",
		},
		highWaterMark: {
			type: "integer",
			description: "Buffer high water mark threshold",
		},
	},
	required: [
		"id",
		"backpressureActive",
		"backpressureEnterCount",
		"droppedBytesTotal",
		"droppedChunksTotal",
		"bufferBytes",
		"highWaterMark",
	],
} as const

/**
 * Fanout status response schema
 */
const fanoutStatusSchema = {
	type: "object",
	properties: {
		timestamp: {
			type: "string",
			format: "date-time",
			description: "Snapshot timestamp",
		},
		branches: {
			type: "array",
			items: branchTelemetrySchema,
			description: "Per-branch telemetry",
		},
		backpressureActiveCount: {
			type: "integer",
			description: "Number of branches currently in backpressure",
		},
		droppedBytesTotal: {
			type: "integer",
			description: "Total bytes dropped across all branches",
		},
		droppedChunksTotal: {
			type: "integer",
			description: "Total chunks dropped across all branches",
		},
	},
	required: [
		"timestamp",
		"branches",
		"backpressureActiveCount",
		"droppedBytesTotal",
		"droppedChunksTotal",
	],
} as const

/**
 * Branches array response schema
 */
const branchesArraySchema = {
	type: "array",
	items: branchTelemetrySchema,
} as const

// ============================================================================
// Plugin Options
// ============================================================================

export interface TelemetryRoutesOptions {
	fanoutManager: FanoutManager
}

// ============================================================================
// Route Plugin
// ============================================================================

/**
 * Telemetry routes plugin for Fastify.
 * Registers fanout telemetry endpoints under /api/telemetry prefix.
 */
export const telemetryRoutes: FastifyPluginAsync<
	TelemetryRoutesOptions
> = async (fastify, options) => {
	const { fanoutManager } = options

	/**
	 * GET /api/telemetry/fanout
	 *
	 * Returns complete fanout system telemetry snapshot including:
	 * - Global drop counters
	 * - Active backpressure count
	 * - Per-branch detailed telemetry
	 */
	fastify.get<{ Reply: FanoutStatus }>(
		"/api/telemetry/fanout",
		{
			schema: {
				tags: ["telemetry"],
				summary: "Get fanout system telemetry",
				description:
					"Returns complete fanout telemetry snapshot with global and per-branch metrics",
				response: {
					200: fanoutStatusSchema,
				},
			},
		},
		async (_request, _reply) => {
			return fanoutManager.getTelemetrySnapshot()
		},
	)

	/**
	 * GET /api/telemetry/fanout/branches
	 *
	 * Returns array of per-branch telemetry only.
	 * Useful for lightweight polling or specific branch monitoring.
	 */
	fastify.get<{ Reply: BranchTelemetry[] }>(
		"/api/telemetry/fanout/branches",
		{
			schema: {
				tags: ["telemetry"],
				summary: "Get fanout branch telemetry",
				description:
					"Returns per-branch telemetry array without global summary",
				response: {
					200: branchesArraySchema,
				},
			},
		},
		async (_request, _reply) => {
			const snapshot = fanoutManager.getTelemetrySnapshot()
			return snapshot.branches
		},
	)

	/**
	 * GET /api/telemetry/fanout/branches/:branchId
	 *
	 * Returns telemetry for a specific branch.
	 */
	fastify.get<{
		Params: { branchId: string }
		Reply: BranchTelemetry | { error: string; code: string; message: string }
	}>(
		"/api/telemetry/fanout/branches/:branchId",
		{
			schema: {
				tags: ["telemetry"],
				summary: "Get specific branch telemetry",
				description: "Returns telemetry for a single fanout branch by ID",
				params: {
					type: "object",
					properties: {
						branchId: { type: "string", description: "Branch identifier" },
					},
					required: ["branchId"],
				},
				response: {
					200: branchTelemetrySchema,
					404: {
						type: "object",
						properties: {
							error: { type: "string" },
							code: { type: "string" },
							message: { type: "string" },
						},
						required: ["error", "code", "message"],
					},
				},
			},
		},
		async (request, reply) => {
			const { branchId } = request.params
			const telemetry = fanoutManager.getBranchTelemetry(branchId)

			if (!telemetry) {
				return reply.status(404).send({
					error: "NotFound",
					code: "BRANCH_NOT_FOUND",
					message: `Branch '${branchId}' not found`,
				})
			}

			return telemetry
		},
	)
}
