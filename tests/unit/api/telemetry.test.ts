/**
 * Telemetry Routes Unit Tests
 *
 * Tests for the fanout backpressure monitoring API endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { telemetryRoutes } from "../../../src/api/routes/telemetry.js"
import { EventEmitter } from "node:events"
import type {
	FanoutStatus,
	BranchTelemetry,
} from "../../../src/core/fanout-manager.js"

/**
 * Mock FanoutManager for testing
 */
function createMockFanoutManager() {
	const mock = new EventEmitter()

	const mockSnapshot: FanoutStatus = {
		timestamp: "2026-01-07T12:00:00.000Z",
		branches: [
			{
				id: "decoder-pagers",
				decoderId: "pagers",
				backpressureActive: false,
				backpressureEnterCount: 2,
				lastBackpressureAt: "2026-01-07T11:55:00.000Z",
				lastDrainAt: "2026-01-07T11:55:01.000Z",
				droppedBytesTotal: 1024,
				droppedChunksTotal: 4,
				bufferBytes: 8192,
				highWaterMark: 262144,
				totalBytesWritten: 123_456,
			},
			{
				id: "decoder-adsb",
				decoderId: "adsb",
				backpressureActive: true,
				backpressureSince: "2026-01-07T11:59:30.000Z",
				backpressureEnterCount: 1,
				lastBackpressureAt: "2026-01-07T11:59:30.000Z",
				droppedBytesTotal: 512,
				droppedChunksTotal: 2,
				bufferBytes: 250000,
				highWaterMark: 262144,
				totalBytesWritten: 654_321,
			},
		],
		backpressureActiveCount: 1,
		droppedBytesTotal: 1536,
		droppedChunksTotal: 6,
		totalBytesWritten: 777_777,
	}

	return Object.assign(mock, {
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		addBranch: vi.fn(),
		removeBranch: vi.fn(),
		getBranchIds: vi.fn().mockReturnValue(["decoder-pagers", "decoder-adsb"]),
		getBranchStatus: vi.fn(),
		getBranchTelemetry: vi.fn((id: string): BranchTelemetry | undefined => {
			return mockSnapshot.branches.find(b => b.id === id)
		}),
		getTelemetrySnapshot: vi.fn().mockReturnValue(mockSnapshot),
		destroy: vi.fn(),
	})
}

describe("Telemetry Routes", () => {
	let app: FastifyInstance
	let mockFanoutManager: ReturnType<typeof createMockFanoutManager>

	beforeEach(async () => {
		mockFanoutManager = createMockFanoutManager()

		app = Fastify({ logger: false })
		await app.register(telemetryRoutes, {
			fanoutManager: mockFanoutManager as unknown as Parameters<
				typeof telemetryRoutes
			>[1]["fanoutManager"],
		})
	})

	afterEach(async () => {
		await app.close()
	})

	describe("GET /api/telemetry/fanout", () => {
		it("should return complete fanout status snapshot", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout",
			})

			expect(response.statusCode).toBe(200)
			const body = JSON.parse(response.body) as FanoutStatus

			expect(body.timestamp).toBe("2026-01-07T12:00:00.000Z")
			expect(body.branches).toHaveLength(2)
			expect(body.backpressureActiveCount).toBe(1)
			expect(body.droppedBytesTotal).toBe(1536)
			expect(body.droppedChunksTotal).toBe(6)
		})

		it("should include branch telemetry in response", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout",
			})

			const body = JSON.parse(response.body) as FanoutStatus
			const pagersBranch = body.branches.find(b => b.id === "decoder-pagers")

			expect(pagersBranch).toBeDefined()
			expect(pagersBranch?.backpressureActive).toBe(false)
			expect(pagersBranch?.backpressureEnterCount).toBe(2)
			expect(pagersBranch?.droppedBytesTotal).toBe(1024)
		})

		it("should call getTelemetrySnapshot on FanoutManager", async () => {
			await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout",
			})

			expect(mockFanoutManager.getTelemetrySnapshot).toHaveBeenCalled()
		})
	})

	describe("GET /api/telemetry/fanout/branches", () => {
		it("should return array of branch telemetry", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout/branches",
			})

			expect(response.statusCode).toBe(200)
			const body = JSON.parse(response.body) as BranchTelemetry[]

			expect(Array.isArray(body)).toBe(true)
			expect(body).toHaveLength(2)
		})

		it("should include all branch fields", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout/branches",
			})

			const body = JSON.parse(response.body) as BranchTelemetry[]
			const adsbBranch = body.find(b => b.id === "decoder-adsb")

			expect(adsbBranch).toBeDefined()
			expect(adsbBranch?.backpressureActive).toBe(true)
			expect(adsbBranch?.backpressureSince).toBe("2026-01-07T11:59:30.000Z")
			expect(adsbBranch?.bufferBytes).toBe(250000)
			expect(adsbBranch?.highWaterMark).toBe(262144)
		})
	})

	describe("GET /api/telemetry/fanout/branches/:branchId", () => {
		it("should return telemetry for existing branch", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout/branches/decoder-pagers",
			})

			expect(response.statusCode).toBe(200)
			const body = JSON.parse(response.body) as BranchTelemetry

			expect(body.id).toBe("decoder-pagers")
			expect(body.decoderId).toBe("pagers")
			expect(body.backpressureActive).toBe(false)
		})

		it("should return 404 for non-existent branch", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout/branches/non-existent",
			})

			expect(response.statusCode).toBe(404)
			const body = JSON.parse(response.body)

			expect(body.error).toBe("NotFound")
			expect(body.code).toBe("BRANCH_NOT_FOUND")
			expect(body.message).toContain("non-existent")
		})

		it("should call getBranchTelemetry with correct branchId", async () => {
			await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout/branches/decoder-adsb",
			})

			expect(mockFanoutManager.getBranchTelemetry).toHaveBeenCalledWith(
				"decoder-adsb",
			)
		})
	})

	describe("Empty state", () => {
		it("should handle empty branches array", async () => {
			mockFanoutManager.getTelemetrySnapshot.mockReturnValue({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
				totalBytesWritten: 0,
			})

			const response = await app.inject({
				method: "GET",
				url: "/api/telemetry/fanout",
			})

			expect(response.statusCode).toBe(200)
			const body = JSON.parse(response.body) as FanoutStatus

			expect(body.branches).toHaveLength(0)
			expect(body.backpressureActiveCount).toBe(0)
		})
	})
})
