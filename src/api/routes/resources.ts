/**
 * Resource Routes - Resource monitoring REST endpoints
 *
 * Provides real-time visibility into system resources:
 * - GET /api/resources - Full resource snapshot
 * - GET /api/resources/container - Container resources only
 * - GET /api/resources/sdr-hosts - All SDR host statuses
 * - GET /api/resources/sdr-hosts/:sourceId - Specific SDR host status
 * - GET /api/resources/backpressure - Source backpressure metrics
 */

import type { FastifyPluginAsync } from "fastify"
import type { ResourceAggregator } from "../../core/resource-aggregator.js"
import type {
	ResourceSnapshot,
	SourceLinkQuality,
	ContainerResources,
	SdrHostStatus,
	SourceBackpressure,
} from "@wavekit/api-types"

// ============================================================================
// Schema Definitions
// ============================================================================

const linkQualitySchema = {
	type: "object",
	properties: {
		sourceId: { type: "string" },
		transport: { type: "string", enum: ["network", "loopback"] },
		at: { type: "string" },
		absorber: {
			type: "object",
			properties: {
				capacityBytes: { type: "number" },
				capacitySeconds: { type: "number" },
				heldBytes: { type: "number" },
				peakHeldBytes10m: { type: "number" },
				peakHeldMs10m: { type: "number" },
				absorbedBytesTotal: { type: "number" },
				overflowBytesTotal: { type: "number" },
				overflowChunksTotal: { type: "number" },
				flushedBytesTotal: { type: "number" },
				absorbedBytes10m: { type: "number" },
				overflowBytes10m: { type: "number" },
				flushedBytes10m: { type: "number" },
				enabled: { type: "boolean" },
				laggardExcludeMsMax10m: { type: ["number", "null"] },
			},
		},
		arrivals: {
			type: "object",
			properties: {
				windowMs: { type: "number" },
				worstStallMs: { type: ["number", "null"] },
				gapP99Ms: { type: ["number", "null"] },
				burstSeconds: { type: "number" },
				catchupBytes10m: { type: "number" },
				chunks10m: { type: "number" },
			},
		},
		attribution: {
			type: "object",
			properties: {
				last: {
					type: ["string", "null"],
					enum: ["none", "link", "host", "consumer", "unknown", null],
				},
				counts10m: {
					type: "object",
					properties: {
						none: { type: "number" },
						link: { type: "number" },
						host: { type: "number" },
						consumer: { type: "number" },
						unknown: { type: "number" },
					},
				},
			},
		},
		upstreamDropBytesPerSecond: { type: ["number", "null"] },
		receiver: {
			type: ["object", "null"],
			properties: {
				interfaceKind: {
					type: ["string", "null"],
					enum: ["ethernet", "wireless", "other", null],
				},
				signalDbm: { type: ["number", "null"] },
				undervoltageNow: { type: ["boolean", "null"] },
				throttled: { type: ["boolean", "null"] },
			},
		},
		histograms: {
			type: "object",
			properties: {
				windowMs: { type: "number" },
				gapBucketUpperMs: { type: "array", items: { type: "number" } },
				gapCounts: { type: "array", items: { type: "number" } },
				chunkSizeBucketUpperBytes: { type: "array", items: { type: "number" } },
				chunkSizeCounts: { type: "array", items: { type: "number" } },
				catchupBucketUpperBytes: { type: "array", items: { type: "number" } },
				catchupCounts: { type: "array", items: { type: "number" } },
			},
		},
		loopDelay: {
			type: ["object", "null"],
			properties: {
				last: {
					type: ["object", "null"],
					properties: { maxMs: { type: "number" }, p99Ms: { type: "number" } },
				},
				maxMs10m: { type: ["number", "null"] },
				p99MaxMs10m: { type: ["number", "null"] },
				intervals10m: { type: "number" },
			},
		},
	},
} as const

const containerResourcesSchema = {
	type: "object",
	properties: {
		available: { type: "boolean" },
		cpuUsagePercent: { type: ["number", "null"] },
		cpuThrottledPercent: { type: ["number", "null"] },
		memoryUsageBytes: { type: ["number", "null"] },
		memoryLimitBytes: { type: ["number", "null"] },
		memoryUsagePercent: { type: ["number", "null"] },
		oomKillCount: { type: ["number", "null"] },
		cgroupVersion: { type: "string", enum: ["v1", "v2", "unknown"] },
	},
	required: ["available", "cgroupVersion"],
} as const

const sdrHostStatusSchema = {
	type: "object",
	properties: {
		available: { type: "boolean" },
		sourceId: { type: "string" },
		apiUrl: { type: "string" },
		version: { type: ["string", "null"] },
		uptime: { type: ["number", "null"] },
		rtlTcp: {
			type: ["object", "null"],
			properties: {
				running: { type: "boolean" },
				pid: { type: ["number", "null"] },
				restartCount: { type: "number" },
				lastRestartAt: { type: ["string", "null"] },
			},
		},
		rtlmux: {
			type: ["object", "null"],
			properties: {
				running: { type: "boolean" },
				pid: { type: ["number", "null"] },
				restartCount: { type: "number" },
				clients: { type: "number" },
				bytesPerSec: { type: "number" },
				totalBytesSent: { type: "number" },
			},
		},
		iqDelivery: {
			type: ["object", "null"],
			properties: {
				modes: {
					type: "array",
					items: { type: "string", enum: ["raw", "channels"] },
				},
			},
		},
		dongle: {
			type: ["object", "null"],
			properties: {
				found: { type: "boolean" },
				vendor: { type: ["string", "null"] },
				product: { type: ["string", "null"] },
				serial: { type: ["string", "null"] },
			},
		},
		warnings: { type: "array", items: { type: "string" } },
		errors: { type: "array", items: { type: "string" } },
		lastFetchedAt: { type: ["string", "null"] },
		fetchError: { type: ["string", "null"] },
	},
	required: ["available", "sourceId", "apiUrl"],
} as const

const sourceBackpressureSchema = {
	type: "object",
	properties: {
		sourceId: { type: "string" },
		available: { type: "boolean" },
		bytesDroppedUpstream: { type: "number" },
		totalBytesSent: { type: "number" },
		dropRate: { type: "number" },
		dropPercent: { type: "number" },
		lastCheckedAt: { type: "string" },
	},
	required: [
		"sourceId",
		"available",
		"bytesDroppedUpstream",
		"totalBytesSent",
		"dropRate",
		"dropPercent",
		"lastCheckedAt",
	],
} as const

const resourceSnapshotSchema = {
	type: "object",
	properties: {
		timestamp: { type: "string" },
		container: containerResourcesSchema,
		sdrHosts: { type: "array", items: sdrHostStatusSchema },
		sourceBackpressure: { type: "array", items: sourceBackpressureSchema },
	},
	required: ["timestamp", "container", "sdrHosts", "sourceBackpressure"],
} as const

// ============================================================================
// Plugin Options
// ============================================================================

export interface ResourceRoutesOptions {
	resourceAggregator: ResourceAggregator
}

// ============================================================================
// Route Plugin
// ============================================================================

/**
 * Resource routes plugin for Fastify.
 * Registers resource monitoring endpoints under /api/resources prefix.
 */
export const resourceRoutes: FastifyPluginAsync<ResourceRoutesOptions> = async (
	fastify,
	options,
) => {
	const { resourceAggregator } = options

	fastify.get<{ Reply: SourceLinkQuality[] }>(
		"/api/resources/link-quality",
		{
			schema: {
				response: { 200: { type: "array", items: linkQualitySchema } },
			},
		},
		async () => resourceAggregator.getLinkQuality(),
	)

	fastify.get<{
		Params: { sourceId: string }
		Reply: SourceLinkQuality | { error: string; code: string; message: string }
	}>(
		"/api/resources/link-quality/:sourceId",
		{
			schema: {
				params: {
					type: "object",
					properties: { sourceId: { type: "string" } },
					required: ["sourceId"],
				},
				response: {
					200: linkQualitySchema,
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
			const report = resourceAggregator.getLinkQualityFor(
				request.params.sourceId,
			)
			if (report) return report
			return reply.status(404).send({
				error: "NotFound",
				code: "LINK_QUALITY_NOT_FOUND",
				message: "No link-quality report for this source",
			})
		},
	)

	/**
	 * GET /api/resources
	 *
	 * Returns complete resource snapshot including:
	 * - Container metrics (CPU, memory)
	 * - SDR host statuses (one per configured source)
	 * - Source backpressure metrics
	 */
	fastify.get<{ Reply: ResourceSnapshot }>(
		"/api/resources",
		{
			schema: {
				tags: ["resources"],
				summary: "Get complete resource snapshot",
				description:
					"Returns unified resource monitoring data including container metrics, SDR host statuses, and source backpressure",
				response: {
					200: resourceSnapshotSchema,
				},
			},
		},
		async (_request, _reply) => {
			return resourceAggregator.getSnapshot()
		},
	)

	/**
	 * GET /api/resources/container
	 *
	 * Returns container resource metrics only.
	 */
	fastify.get<{ Reply: ContainerResources }>(
		"/api/resources/container",
		{
			schema: {
				tags: ["resources"],
				summary: "Get container resources",
				description: "Returns container CPU and memory metrics from cgroups",
				response: {
					200: containerResourcesSchema,
				},
			},
		},
		async (_request, _reply) => {
			return resourceAggregator.getContainerResources()
		},
	)

	/**
	 * GET /api/resources/sdr-hosts
	 *
	 * Returns all SDR host statuses.
	 */
	fastify.get<{ Reply: SdrHostStatus[] }>(
		"/api/resources/sdr-hosts",
		{
			schema: {
				tags: ["resources"],
				summary: "Get all SDR host statuses",
				description: "Returns status for all configured SDR hosts",
				response: {
					200: { type: "array", items: sdrHostStatusSchema },
				},
			},
		},
		async (_request, _reply) => {
			return resourceAggregator.getSdrHostStatuses()
		},
	)

	/**
	 * GET /api/resources/sdr-hosts/:sourceId
	 *
	 * Returns status for a specific SDR host.
	 */
	fastify.get<{
		Params: { sourceId: string }
		Reply: SdrHostStatus | { error: string; code: string; message: string }
	}>(
		"/api/resources/sdr-hosts/:sourceId",
		{
			schema: {
				tags: ["resources"],
				summary: "Get specific SDR host status",
				description: "Returns status for a single SDR host by source ID",
				params: {
					type: "object",
					properties: {
						sourceId: { type: "string", description: "Source identifier" },
					},
					required: ["sourceId"],
				},
				response: {
					200: sdrHostStatusSchema,
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
			const { sourceId } = request.params
			const statuses = resourceAggregator.getSdrHostStatuses()
			const status = statuses.find(s => s.sourceId === sourceId)

			if (!status) {
				return reply.status(404).send({
					error: "NotFound",
					code: "SDR_HOST_NOT_FOUND",
					message: `SDR host for source '${sourceId}' not found or not configured`,
				})
			}

			return status
		},
	)

	/**
	 * GET /api/resources/backpressure
	 *
	 * Returns source backpressure metrics for all sources.
	 */
	fastify.get<{ Reply: SourceBackpressure[] }>(
		"/api/resources/backpressure",
		{
			schema: {
				tags: ["resources"],
				summary: "Get source backpressure metrics",
				description: "Returns upstream backpressure metrics for all sources",
				response: {
					200: { type: "array", items: sourceBackpressureSchema },
				},
			},
		},
		async (_request, _reply) => {
			return resourceAggregator.getSourceBackpressure()
		},
	)
}
