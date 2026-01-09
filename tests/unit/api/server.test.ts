/**
 * API Server Unit Tests
 *
 * Tests for Fastify server setup with plugins and error handling.
 * Requirements: 9.1, 9.2
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fc from "fast-check"
import {
	ApiServer,
	type ApiServerConfig,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { createLogger } from "../../../src/utils/logger.js"
import { WaveKitError } from "../../../src/utils/errors.js"
import { EventEmitter } from "node:events"

// Create a test logger
const testLogger = createLogger({ level: "fatal" })

/**
 * Mock SourceManager for testing
 */
function createMockSourceManager() {
	const mock = new EventEmitter()
	return Object.assign(mock, {
		connect: vi.fn(),
		disconnect: vi.fn(),
		getStatus: vi.fn(),
		getAllStatus: vi.fn().mockReturnValue([]),
		getStream: vi.fn(),
		getSourceAssignments: vi.fn().mockReturnValue([]),
		isSourceAvailable: vi.fn().mockReturnValue(true),
		assignDecoder: vi.fn(),
		unassignDecoder: vi.fn(),
		getAssignedSource: vi.fn(),
		getCaps: vi.fn(),
		isCompatible: vi.fn().mockReturnValue(true),
	})
}

/**
 * Mock DecoderManager for testing
 */
function createMockDecoderManager() {
	const mock = new EventEmitter()
	return Object.assign(mock, {
		createDecoder: vi.fn(),
		startDecoder: vi.fn(),
		stopDecoder: vi.fn(),
		restartDecoder: vi.fn(),
		getDecoder: vi.fn(),
		getAllDecoders: vi.fn().mockReturnValue([]),
		getStatus: vi.fn(),
		getAllStatus: vi.fn().mockReturnValue([]),
		getAllHealth: vi.fn().mockReturnValue(new Map()),
	})
}

/**
 * Mock FanoutManager for testing
 */
function createMockFanoutManager() {
	const mock = new EventEmitter()
	return Object.assign(mock, {
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		addBranch: vi.fn(),
		removeBranch: vi.fn(),
		getBranchIds: vi.fn().mockReturnValue([]),
		getBranchStatus: vi.fn(),
		getBranchTelemetry: vi.fn(),
		getTelemetrySnapshot: vi.fn().mockReturnValue({
			timestamp: new Date().toISOString(),
			branches: [],
			backpressureActiveCount: 0,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
		}),
		destroy: vi.fn(),
	})
}

/**
 * Mock AudioOutput for testing
 */
function createMockAudioOutput() {
	const mock = new EventEmitter()
	return Object.assign(mock, {
		start: vi.fn(),
		stop: vi.fn(),
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		getConnectedClients: vi.fn().mockReturnValue(0),
		getPort: vi.fn().mockReturnValue(8080),
	})
}

describe("API Server", () => {
	let apiServer: ApiServer
	let mockSourceManager: ReturnType<typeof createMockSourceManager>
	let mockFanoutManager: ReturnType<typeof createMockFanoutManager>
	let mockDecoderManager: ReturnType<typeof createMockDecoderManager>
	let mockAudioOutput: ReturnType<typeof createMockAudioOutput>
	let config: ApiServerConfig

	beforeEach(() => {
		mockSourceManager = createMockSourceManager()
		mockFanoutManager = createMockFanoutManager()
		mockDecoderManager = createMockDecoderManager()
		mockAudioOutput = createMockAudioOutput()

		config = {
			host: "127.0.0.1",
			port: 0, // Use random available port
		}

		const dependencies: ApiServerDependencies = {
			sourceManager:
				mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
			fanoutManager:
				mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
			decoderManager:
				mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
			audioOutput:
				mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
			logger: testLogger,
		}

		apiServer = new ApiServer(dependencies, config)
	})

	afterEach(async () => {
		try {
			await apiServer.stop()
		} catch {
			// Server may not be running
		}
	})

	describe("Server Lifecycle", () => {
		it("should start and listen on configured port", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const addresses = app.addresses()

			expect(addresses).toBeDefined()
			expect(addresses.length).toBeGreaterThan(0)
		})

		it("should stop gracefully", async () => {
			await apiServer.start()
			await apiServer.stop()

			// Server should be closed - trying to make a request should fail
			const app = apiServer.getApp()
			const addresses = app.addresses()
			expect(addresses.length).toBe(0)
		})

		it("should expose the Fastify instance via getApp()", async () => {
			const app = apiServer.getApp()
			expect(app).toBeDefined()
			expect(typeof app.listen).toBe("function")
			expect(typeof app.close).toBe("function")
		})
	})

	describe("Health Endpoint", () => {
		it("should respond to GET /health with ok status", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/health",
			})

			expect(response.statusCode).toBe(200)

			const body = JSON.parse(response.body)
			expect(body.status).toBe("ok")
			expect(body.timestamp).toBeDefined()
		})

		it("should include ISO timestamp in health response", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/health",
			})

			const body = JSON.parse(response.body)
			const timestamp = new Date(body.timestamp)

			// Should be a valid date
			expect(timestamp.toString()).not.toBe("Invalid Date")

			// Should be recent (within last minute)
			const now = new Date()
			const diff = Math.abs(now.getTime() - timestamp.getTime())
			expect(diff).toBeLessThan(60000)
		})
	})

	describe("Status Endpoint", () => {
		it("should respond to GET /api/status with system status", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/api/status",
			})

			expect(response.statusCode).toBe(200)

			const body = JSON.parse(response.body)
			expect(body.uptime).toBeDefined()
			expect(typeof body.uptime).toBe("number")
			expect(body.version).toBeDefined()
			expect(body.sources).toBeDefined()
			expect(Array.isArray(body.sources)).toBe(true)
			expect(body.decoders).toBeDefined()
			expect(Array.isArray(body.decoders)).toBe(true)
			expect(body.audio).toBeDefined()
			expect(body.audio.outputPort).toBeDefined()
			expect(body.audio.clientsConnected).toBeDefined()
		})

		it("should return sources from SourceManager", async () => {
			// Setup mock to return some sources
			const mockSources = [
				{
					id: "source-1",
					connected: true,
					bytesReceived: 1024,
					dataRate: 10.5,
					reconnectAttempts: 0,
				},
				{
					id: "source-2",
					connected: false,
					bytesReceived: 0,
					dataRate: 0,
					lastError: "Connection refused",
					reconnectAttempts: 3,
				},
			]
			mockSourceManager.getAllStatus.mockReturnValue(mockSources)

			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/api/status",
			})

			const body = JSON.parse(response.body)
			expect(body.sources).toEqual(mockSources)
			expect(mockSourceManager.getAllStatus).toHaveBeenCalled()
		})

		it("should return decoders from DecoderManager", async () => {
			// Setup mock to return some decoders
			const mockDecoders = [
				{
					id: "decoder-1",
					type: "dsd-fme",
					running: true,
					health: "running",
					pid: 12345,
					uptime: 3600,
					stats: { bytesIn: 1000000, eventsOut: 500, errors: 2 },
					restartCount: 0,
				},
				{
					id: "decoder-2",
					type: "multimon-ng",
					running: false,
					health: "running",
					uptime: 0,
					stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
					restartCount: 1,
				},
			]
			mockDecoderManager.getAllStatus.mockReturnValue(mockDecoders)

			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/api/status",
			})

			const body = JSON.parse(response.body)
			expect(body.decoders).toEqual(mockDecoders)
			expect(mockDecoderManager.getAllStatus).toHaveBeenCalled()
		})

		it("should return audio output status", async () => {
			mockAudioOutput.getPort.mockReturnValue(9090)
			mockAudioOutput.getConnectedClients.mockReturnValue(3)

			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/api/status",
			})

			const body = JSON.parse(response.body)
			expect(body.audio.outputPort).toBe(9090)
			expect(body.audio.clientsConnected).toBe(3)
		})

		it("should include audio format and sampleRate when audioConfig is provided", async () => {
			// Create server with audioConfig
			const testDependencies: ApiServerDependencies = {
				sourceManager:
					mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
				fanoutManager:
					mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
				decoderManager:
					mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
				audioOutput:
					mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
				logger: testLogger,
				audioConfig: {
					format: "S16LE",
					sampleRate: 48000,
				},
			}

			const testServer = new ApiServer(testDependencies, {
				host: "127.0.0.1",
				port: 0,
			})

			await testServer.start()

			try {
				const app = testServer.getApp()
				const response = await app.inject({
					method: "GET",
					url: "/api/status",
				})

				const body = JSON.parse(response.body)
				expect(body.audio.format).toBe("S16LE")
				expect(body.audio.sampleRate).toBe(48000)
			} finally {
				await testServer.stop()
			}
		})

		it("should return uptime in seconds", async () => {
			await apiServer.start()

			// Wait a bit to ensure uptime is > 0
			await new Promise(resolve => setTimeout(resolve, 100))

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/api/status",
			})

			const body = JSON.parse(response.body)
			expect(body.uptime).toBeGreaterThanOrEqual(0)
			expect(Number.isInteger(body.uptime)).toBe(true)
		})

		it("should return version string", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/api/status",
			})

			const body = JSON.parse(response.body)
			expect(body.version).toBe("1.0.0")
		})
	})

	describe("CORS Support", () => {
		it("should include CORS headers in response", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "OPTIONS",
				url: "/health",
				headers: {
					origin: "http://localhost:3000",
					"access-control-request-method": "GET",
				},
			})

			// CORS preflight should succeed
			expect(response.statusCode).toBeLessThan(400)
			expect(response.headers["access-control-allow-origin"]).toBeDefined()
		})

		it("should allow specified HTTP methods", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "OPTIONS",
				url: "/health",
				headers: {
					origin: "http://localhost:3000",
					"access-control-request-method": "POST",
				},
			})

			const allowedMethods = response.headers["access-control-allow-methods"]
			expect(allowedMethods).toBeDefined()
			expect(allowedMethods).toContain("GET")
			expect(allowedMethods).toContain("POST")
			expect(allowedMethods).toContain("DELETE")
		})
	})

	describe("Swagger Documentation", () => {
		it("should serve Swagger UI at /docs", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/docs",
			})

			// Should redirect to /docs/ or serve HTML
			expect(response.statusCode).toBeLessThan(400)
		})

		it("should serve OpenAPI JSON spec", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/docs/json",
			})

			expect(response.statusCode).toBe(200)

			const spec = JSON.parse(response.body)
			expect(spec.openapi).toBe("3.0.0")
			expect(spec.info.title).toBe("WaveKit API")
			expect(spec.info.version).toBe("1.0.0")
		})
	})

	describe("Error Handling", () => {
		it("should return 404 for unknown routes", async () => {
			await apiServer.start()

			const app = apiServer.getApp()
			const response = await app.inject({
				method: "GET",
				url: "/unknown-route",
			})

			expect(response.statusCode).toBe(404)

			const body = JSON.parse(response.body)
			expect(body.error).toBe("NotFound")
			expect(body.code).toBe("NOT_FOUND")
			expect(body.message).toContain("/unknown-route")
		})

		it("should handle WaveKitError with proper response format", async () => {
			// Create a new server instance with a test route that throws WaveKitError
			const testDependencies: ApiServerDependencies = {
				sourceManager:
					mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
				fanoutManager:
					mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
				decoderManager:
					mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
				audioOutput:
					mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
				logger: testLogger,
			}

			const testServer = new ApiServer(testDependencies, {
				host: "127.0.0.1",
				port: 0,
			})
			const app = testServer.getApp()

			// Add test route BEFORE starting the server
			app.get("/test-error", async () => {
				throw new WaveKitError("Test error message", "TEST_ERROR_CODE")
			})

			await testServer.start()

			try {
				const response = await app.inject({
					method: "GET",
					url: "/test-error",
				})

				expect(response.statusCode).toBe(400)

				const body = JSON.parse(response.body)
				expect(body.error).toBe("WaveKitError")
				expect(body.code).toBe("TEST_ERROR_CODE")
				expect(body.message).toBe("Test error message")
			} finally {
				await testServer.stop()
			}
		})

		it("should return 500 for unexpected errors", async () => {
			// Create a new server instance with a test route that throws generic error
			const testDependencies: ApiServerDependencies = {
				sourceManager:
					mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
				fanoutManager:
					mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
				decoderManager:
					mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
				audioOutput:
					mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
				logger: testLogger,
			}

			const testServer = new ApiServer(testDependencies, {
				host: "127.0.0.1",
				port: 0,
			})
			const app = testServer.getApp()

			// Add test route BEFORE starting the server
			app.get("/test-generic-error", async () => {
				throw new Error("Unexpected error")
			})

			await testServer.start()

			try {
				const response = await app.inject({
					method: "GET",
					url: "/test-generic-error",
				})

				expect(response.statusCode).toBe(500)

				const body = JSON.parse(response.body)
				expect(body.error).toBe("InternalServerError")
				expect(body.code).toBe("INTERNAL_ERROR")
			} finally {
				await testServer.stop()
			}
		})
	})

	describe("Dependency Access", () => {
		it("should provide access to SourceManager", () => {
			const sm = apiServer.getSourceManager()
			expect(sm).toBe(mockSourceManager)
		})

		it("should provide access to DecoderManager", () => {
			const dm = apiServer.getDecoderManager()
			expect(dm).toBe(mockDecoderManager)
		})

		it("should provide access to AudioOutput", () => {
			const ao = apiServer.getAudioOutput()
			expect(ao).toBe(mockAudioOutput)
		})
	})

	describe("WebSocket Support", () => {
		it("should have WebSocket plugin registered", async () => {
			await apiServer.start()

			const app = apiServer.getApp()

			// The websocket plugin adds a 'websocketServer' property
			// We can verify the plugin is registered by checking if the decorator exists
			expect(app.hasDecorator("websocketServer")).toBe(true)
		})
	})

	describe("Source Routes", () => {
		describe("GET /api/sources", () => {
			it("should return empty array when no sources configured", async () => {
				mockSourceManager.getAllStatus.mockReturnValue([])
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "GET",
					url: "/api/sources",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body).toEqual([])
			})

			it("should return all configured sources", async () => {
				const mockSources = [
					{
						id: "source-1",
						connected: true,
						bytesReceived: 1024,
						dataRate: 10.5,
						reconnectAttempts: 0,
						caps: {
							kind: "audio_pcm",
							sampleRate: 48000,
							format: "S16LE",
							exclusive: false,
						},
					},
					{
						id: "source-2",
						connected: false,
						bytesReceived: 0,
						dataRate: 0,
						lastError: "Connection refused",
						reconnectAttempts: 3,
						caps: {
							kind: "audio_pcm",
							sampleRate: 48000,
							format: "S16LE",
							exclusive: false,
						},
					},
				]
				mockSourceManager.getAllStatus.mockReturnValue(mockSources)
				mockSourceManager.getSourceAssignments.mockReturnValue([])
				mockSourceManager.isSourceAvailable.mockReturnValue(true)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "GET",
					url: "/api/sources",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				// Response now includes assignments and available fields
				expect(body).toHaveLength(2)
				expect(body[0]).toMatchObject({
					id: "source-1",
					connected: true,
					assignments: [],
					available: true,
				})
				expect(body[1]).toMatchObject({
					id: "source-2",
					connected: false,
					assignments: [],
					available: true,
				})
			})
		})

		describe("POST /api/sources", () => {
			it("should add a new source successfully", async () => {
				const newSource = {
					id: "new-source",
					type: "rtl_tcp",
					host: "192.168.1.100",
					port: 1234,
					caps: {
						kind: "audio_pcm",
						sampleRate: 48000,
						format: "S16LE",
						exclusive: false,
					},
				}

				mockSourceManager.getStatus.mockReturnValue(undefined) // Source doesn't exist
				mockSourceManager.connect.mockResolvedValue({}) // Mock stream
				// After connect, getStatus returns the new source
				mockSourceManager.getStatus
					.mockReturnValueOnce(undefined)
					.mockReturnValue({
						id: "new-source",
						connected: true,
						bytesReceived: 0,
						dataRate: 0,
						reconnectAttempts: 0,
						caps: {
							kind: "audio_pcm",
							sampleRate: 48000,
							format: "S16LE",
							exclusive: false,
						},
					})

				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/sources",
					payload: newSource,
				})

				expect(response.statusCode).toBe(201)
				const body = JSON.parse(response.body)
				expect(body.message).toContain("new-source")
				expect(body.source.id).toBe("new-source")
				expect(mockSourceManager.connect).toHaveBeenCalledWith(newSource)
			})

			it("should return 409 when source already exists", async () => {
				const existingSource = {
					id: "existing-source",
					type: "rtl_tcp",
					host: "192.168.1.100",
					port: 1234,
					caps: {
						kind: "audio_pcm",
						sampleRate: 48000,
						format: "S16LE",
						exclusive: false,
					},
				}

				mockSourceManager.getStatus.mockReturnValue({
					id: "existing-source",
					connected: true,
					bytesReceived: 1000,
					dataRate: 10,
					reconnectAttempts: 0,
				})

				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/sources",
					payload: existingSource,
				})

				expect(response.statusCode).toBe(409)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("SOURCE_EXISTS")
				expect(mockSourceManager.connect).not.toHaveBeenCalled()
			})

			it("should return 400 when connection fails", async () => {
				const newSource = {
					id: "failing-source",
					type: "rtl_tcp",
					host: "192.168.1.100",
					port: 1234,
					caps: {
						kind: "audio_pcm",
						sampleRate: 48000,
						format: "S16LE",
						exclusive: false,
					},
				}

				mockSourceManager.getStatus.mockReturnValue(undefined)
				mockSourceManager.connect.mockRejectedValue(
					new Error("Connection refused"),
				)

				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/sources",
					payload: newSource,
				})

				expect(response.statusCode).toBe(400)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("SOURCE_CONNECTION_ERROR")
				expect(body.message).toContain("Connection refused")
			})

			it("should return 400 for invalid source config", async () => {
				const invalidSource = {
					id: "invalid-source",
					// Missing required fields
				}

				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/sources",
					payload: invalidSource,
				})

				expect(response.statusCode).toBe(400)
			})
		})

		describe("DELETE /api/sources/:id", () => {
			it("should remove an existing source", async () => {
				mockSourceManager.getStatus.mockReturnValue({
					id: "source-to-delete",
					connected: true,
					bytesReceived: 1000,
					dataRate: 10,
					reconnectAttempts: 0,
				})
				mockSourceManager.disconnect.mockResolvedValue(undefined)

				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "DELETE",
					url: "/api/sources/source-to-delete",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body.message).toContain("source-to-delete")
				expect(body.id).toBe("source-to-delete")
				expect(mockSourceManager.disconnect).toHaveBeenCalledWith(
					"source-to-delete",
				)
			})

			it("should return 404 when source not found", async () => {
				mockSourceManager.getStatus.mockReturnValue(undefined)

				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "DELETE",
					url: "/api/sources/nonexistent-source",
				})

				expect(response.statusCode).toBe(404)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("SOURCE_NOT_FOUND")
				expect(mockSourceManager.disconnect).not.toHaveBeenCalled()
			})
		})
	})

	describe("Decoder Routes", () => {
		describe("GET /api/decoders", () => {
			it("should return empty array when no decoders configured", async () => {
				mockDecoderManager.getAllStatus.mockReturnValue([])
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "GET",
					url: "/api/decoders",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body).toEqual([])
			})

			it("should return all configured decoders", async () => {
				const mockDecoders = [
					{
						id: "decoder-1",
						type: "dsd-fme",
						running: true,
						health: "running",
						pid: 12345,
						uptime: 3600,
						stats: { bytesIn: 1000000, eventsOut: 500, errors: 2 },
						restartCount: 0,
					},
					{
						id: "decoder-2",
						type: "multimon-ng",
						running: false,
						health: "running",
						uptime: 0,
						stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
						restartCount: 1,
					},
				]
				mockDecoderManager.getAllStatus.mockReturnValue(mockDecoders)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "GET",
					url: "/api/decoders",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body).toEqual(mockDecoders)
			})
		})

		describe("GET /api/decoders/:id", () => {
			it("should return decoder status by ID", async () => {
				const mockDecoder = {
					id: "decoder-1",
					type: "dsd-fme",
					running: true,
					health: "running",
					pid: 12345,
					uptime: 3600,
					stats: { bytesIn: 1000000, eventsOut: 500, errors: 2 },
					restartCount: 0,
				}
				mockDecoderManager.getStatus.mockReturnValue(mockDecoder)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "GET",
					url: "/api/decoders/decoder-1",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body).toEqual(mockDecoder)
			})

			it("should return 404 when decoder not found", async () => {
				mockDecoderManager.getStatus.mockReturnValue(undefined)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "GET",
					url: "/api/decoders/nonexistent",
				})

				expect(response.statusCode).toBe(404)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("DECODER_NOT_FOUND")
			})
		})

		describe("POST /api/decoders/:id/start", () => {
			it("should start a stopped decoder", async () => {
				const mockDecoder = {
					getStatus: vi.fn().mockReturnValue({
						id: "decoder-1",
						type: "dsd-fme",
						running: false,
						health: "running",
						uptime: 0,
						stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
						restartCount: 0,
					}),
				}
				mockDecoderManager.getDecoder.mockReturnValue(mockDecoder)
				mockDecoderManager.startDecoder.mockResolvedValue(undefined)
				mockDecoderManager.getStatus.mockReturnValue({
					id: "decoder-1",
					type: "dsd-fme",
					running: true,
					health: "running",
					pid: 12345,
					uptime: 0,
					stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
					restartCount: 0,
				})
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/decoder-1/start",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body.message).toContain("decoder-1")
				expect(body.decoder.running).toBe(true)
				expect(mockDecoderManager.startDecoder).toHaveBeenCalledWith(
					"decoder-1",
				)
			})

			it("should return 404 when decoder not found", async () => {
				mockDecoderManager.getDecoder.mockReturnValue(undefined)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/nonexistent/start",
				})

				expect(response.statusCode).toBe(404)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("DECODER_NOT_FOUND")
			})

			it("should return 409 when decoder already running", async () => {
				const mockDecoder = {
					getStatus: vi.fn().mockReturnValue({
						id: "decoder-1",
						type: "dsd-fme",
						running: true,
						health: "running",
						pid: 12345,
						uptime: 100,
						stats: { bytesIn: 1000, eventsOut: 10, errors: 0 },
						restartCount: 0,
					}),
				}
				mockDecoderManager.getDecoder.mockReturnValue(mockDecoder)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/decoder-1/start",
				})

				expect(response.statusCode).toBe(409)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("DECODER_ALREADY_RUNNING")
			})
		})

		describe("POST /api/decoders/:id/stop", () => {
			it("should stop a running decoder", async () => {
				const mockDecoder = {
					getStatus: vi.fn().mockReturnValue({
						id: "decoder-1",
						type: "dsd-fme",
						running: true,
						health: "running",
						pid: 12345,
						uptime: 100,
						stats: { bytesIn: 1000, eventsOut: 10, errors: 0 },
						restartCount: 0,
					}),
				}
				mockDecoderManager.getDecoder.mockReturnValue(mockDecoder)
				mockDecoderManager.stopDecoder.mockResolvedValue(undefined)
				mockDecoderManager.getStatus.mockReturnValue({
					id: "decoder-1",
					type: "dsd-fme",
					running: false,
					health: "running",
					uptime: 0,
					stats: { bytesIn: 1000, eventsOut: 10, errors: 0 },
					restartCount: 0,
				})
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/decoder-1/stop",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body.message).toContain("decoder-1")
				expect(body.decoder.running).toBe(false)
				expect(mockDecoderManager.stopDecoder).toHaveBeenCalledWith("decoder-1")
			})

			it("should return 404 when decoder not found", async () => {
				mockDecoderManager.getDecoder.mockReturnValue(undefined)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/nonexistent/stop",
				})

				expect(response.statusCode).toBe(404)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("DECODER_NOT_FOUND")
			})

			it("should return 409 when decoder not running", async () => {
				const mockDecoder = {
					getStatus: vi.fn().mockReturnValue({
						id: "decoder-1",
						type: "dsd-fme",
						running: false,
						health: "running",
						uptime: 0,
						stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
						restartCount: 0,
					}),
				}
				mockDecoderManager.getDecoder.mockReturnValue(mockDecoder)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/decoder-1/stop",
				})

				expect(response.statusCode).toBe(409)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("DECODER_NOT_RUNNING")
			})
		})

		describe("POST /api/decoders/:id/restart", () => {
			it("should restart a decoder", async () => {
				const mockDecoder = {
					getStatus: vi.fn().mockReturnValue({
						id: "decoder-1",
						type: "dsd-fme",
						running: true,
						health: "running",
						pid: 12345,
						uptime: 100,
						stats: { bytesIn: 1000, eventsOut: 10, errors: 0 },
						restartCount: 0,
					}),
				}
				mockDecoderManager.getDecoder.mockReturnValue(mockDecoder)
				mockDecoderManager.restartDecoder.mockResolvedValue(undefined)
				mockDecoderManager.getStatus.mockReturnValue({
					id: "decoder-1",
					type: "dsd-fme",
					running: true,
					health: "running",
					pid: 12346,
					uptime: 0,
					stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
					restartCount: 1,
				})
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/decoder-1/restart",
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body.message).toContain("decoder-1")
				expect(body.decoder.restartCount).toBe(1)
				expect(mockDecoderManager.restartDecoder).toHaveBeenCalledWith(
					"decoder-1",
				)
			})

			it("should return 404 when decoder not found", async () => {
				mockDecoderManager.getDecoder.mockReturnValue(undefined)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "POST",
					url: "/api/decoders/nonexistent/restart",
				})

				expect(response.statusCode).toBe(404)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("DECODER_NOT_FOUND")
			})
		})

		describe("PATCH /api/decoders/:id", () => {
			it("should update decoder configuration", async () => {
				const mockDecoder = {
					getStatus: vi.fn().mockReturnValue({
						id: "decoder-1",
						type: "dsd-fme",
						running: true,
						health: "running",
						pid: 12345,
						uptime: 100,
						stats: { bytesIn: 1000, eventsOut: 10, errors: 0 },
						restartCount: 0,
					}),
				}
				mockDecoderManager.getDecoder.mockReturnValue(mockDecoder)
				mockDecoderManager.getStatus.mockReturnValue({
					id: "decoder-1",
					type: "dsd-fme",
					running: true,
					health: "running",
					pid: 12345,
					uptime: 100,
					stats: { bytesIn: 1000, eventsOut: 10, errors: 0 },
					restartCount: 0,
				})
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "PATCH",
					url: "/api/decoders/decoder-1",
					payload: {
						enabled: false,
						options: { mode: "dmr" },
					},
				})

				expect(response.statusCode).toBe(200)
				const body = JSON.parse(response.body)
				expect(body.message).toContain("decoder-1")
				expect(body.decoder.id).toBe("decoder-1")
			})

			it("should return 404 when decoder not found", async () => {
				mockDecoderManager.getDecoder.mockReturnValue(undefined)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "PATCH",
					url: "/api/decoders/nonexistent",
					payload: { enabled: false },
				})

				expect(response.statusCode).toBe(404)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("DECODER_NOT_FOUND")
			})

			it("should return 400 when no update fields provided", async () => {
				const mockDecoder = {
					getStatus: vi.fn().mockReturnValue({
						id: "decoder-1",
						type: "dsd-fme",
						running: true,
						pid: 12345,
						uptime: 100,
						stats: { bytesIn: 1000, eventsOut: 10, errors: 0 },
						restartCount: 0,
					}),
				}
				mockDecoderManager.getDecoder.mockReturnValue(mockDecoder)
				await apiServer.start()

				const app = apiServer.getApp()
				const response = await app.inject({
					method: "PATCH",
					url: "/api/decoders/decoder-1",
					payload: {},
				})

				expect(response.statusCode).toBe(400)
				const body = JSON.parse(response.body)
				expect(body.code).toBe("NO_UPDATE_FIELDS")
			})
		})
	})
})

/**
 * Property-Based Tests for API Server
 */
describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 17: Source CRUD Consistency
	 * Validates: Requirements 9.3, 9.4, 9.5
	 *
	 * For any valid source configuration S, after POST /api/sources with S,
	 * GET /api/sources should include S, and after DELETE /api/sources/:id,
	 * GET /api/sources should not include S.
	 */
	describe("Property 17: Source CRUD Consistency", () => {
		it("should maintain CRUD consistency: POST adds source, GET includes it, DELETE removes it", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate valid source configurations
					fc.record({
						id: fc
							.string({ minLength: 1, maxLength: 20 })
							.filter(s => /^[a-zA-Z0-9_-]+$/.test(s)), // Valid ID characters
						type: fc.constantFrom("sdrpp-network" as const, "rtl_tcp" as const),
						host: fc.constantFrom(
							"192.168.1.100",
							"10.0.0.1",
							"localhost",
							"127.0.0.1",
						),
						port: fc.integer({ min: 1024, max: 65535 }),
						caps: fc.record({
							kind: fc.constant("audio_pcm" as const),
							sampleRate: fc.constantFrom(44100, 48000, 96000, 192000),
							format: fc.constantFrom("S16LE" as const, "FLOAT32LE" as const),
							exclusive: fc.boolean(),
						}),
					}),
					async sourceConfig => {
						// Create fresh mocks for each test iteration
						const mockSourceManager = new EventEmitter()
						const sourcesStore = new Map<
							string,
							{
								id: string
								connected: boolean
								bytesReceived: number
								dataRate: number
								reconnectAttempts: number
								caps: {
									kind: string
									sampleRate: number
									format: string
									exclusive: boolean
								}
							}
						>()

						Object.assign(mockSourceManager, {
							connect: vi.fn().mockImplementation(
								async (config: {
									id: string
									caps: {
										kind: string
										sampleRate: number
										format: string
										exclusive: boolean
									}
								}) => {
									// Simulate successful connection
									sourcesStore.set(config.id, {
										id: config.id,
										connected: true,
										bytesReceived: 0,
										dataRate: 0,
										reconnectAttempts: 0,
										caps: config.caps,
									})
									return {}
								},
							),
							disconnect: vi.fn().mockImplementation(async (id: string) => {
								sourcesStore.delete(id)
							}),
							getStatus: vi.fn().mockImplementation((id: string) => {
								return sourcesStore.get(id)
							}),
							getAllStatus: vi.fn().mockImplementation(() => {
								return Array.from(sourcesStore.values())
							}),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn(),
							stopDecoder: vi.fn(),
							restartDecoder: vi.fn(),
							getDecoder: vi.fn(),
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue([]),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi.fn().mockReturnValue(0),
							getPort: vi.fn().mockReturnValue(8080),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()

							// Step 1: Verify source doesn't exist initially (GET /api/sources)
							const initialGetResponse = await app.inject({
								method: "GET",
								url: "/api/sources",
							})

							if (initialGetResponse.statusCode !== 200) {
								return false
							}

							const initialSources = JSON.parse(initialGetResponse.body)
							const initiallyExists = initialSources.some(
								(s: { id: string }) => s.id === sourceConfig.id,
							)

							if (initiallyExists) {
								// Source shouldn't exist initially
								return false
							}

							// Step 2: Add source via POST /api/sources
							const postResponse = await app.inject({
								method: "POST",
								url: "/api/sources",
								payload: sourceConfig,
							})

							if (postResponse.statusCode !== 201) {
								return false
							}

							const postBody = JSON.parse(postResponse.body)
							if (postBody.source.id !== sourceConfig.id) {
								return false
							}

							// Step 3: Verify source exists after POST (GET /api/sources)
							const afterPostGetResponse = await app.inject({
								method: "GET",
								url: "/api/sources",
							})

							if (afterPostGetResponse.statusCode !== 200) {
								return false
							}

							const afterPostSources = JSON.parse(afterPostGetResponse.body)
							const existsAfterPost = afterPostSources.some(
								(s: { id: string }) => s.id === sourceConfig.id,
							)

							if (!existsAfterPost) {
								// Source should exist after POST
								return false
							}

							// Step 4: Delete source via DELETE /api/sources/:id
							const deleteResponse = await app.inject({
								method: "DELETE",
								url: `/api/sources/${sourceConfig.id}`,
							})

							if (deleteResponse.statusCode !== 200) {
								return false
							}

							const deleteBody = JSON.parse(deleteResponse.body)
							if (deleteBody.id !== sourceConfig.id) {
								return false
							}

							// Step 5: Verify source doesn't exist after DELETE (GET /api/sources)
							const afterDeleteGetResponse = await app.inject({
								method: "GET",
								url: "/api/sources",
							})

							if (afterDeleteGetResponse.statusCode !== 200) {
								return false
							}

							const afterDeleteSources = JSON.parse(afterDeleteGetResponse.body)
							const existsAfterDelete = afterDeleteSources.some(
								(s: { id: string }) => s.id === sourceConfig.id,
							)

							if (existsAfterDelete) {
								// Source should NOT exist after DELETE
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 }, // Reduced from 100 due to server startup/shutdown overhead per iteration
			)
		}, 30000) // 30 second timeout for this test

		it("should return 409 when adding a source that already exists", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate valid source configurations
					fc.record({
						id: fc
							.string({ minLength: 1, maxLength: 20 })
							.filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
						type: fc.constantFrom("sdrpp-network" as const, "rtl_tcp" as const),
						host: fc.constantFrom("192.168.1.100", "10.0.0.1", "localhost"),
						port: fc.integer({ min: 1024, max: 65535 }),
						caps: fc.record({
							kind: fc.constant("audio_pcm" as const),
							sampleRate: fc.constantFrom(44100, 48000, 96000),
							format: fc.constantFrom("S16LE" as const, "FLOAT32LE" as const),
							exclusive: fc.boolean(),
						}),
					}),
					async sourceConfig => {
						const mockSourceManager = new EventEmitter()
						const sourcesStore = new Map<
							string,
							{
								id: string
								connected: boolean
								bytesReceived: number
								dataRate: number
								reconnectAttempts: number
								caps: {
									kind: string
									sampleRate: number
									format: string
									exclusive: boolean
								}
							}
						>()

						Object.assign(mockSourceManager, {
							connect: vi.fn().mockImplementation(
								async (config: {
									id: string
									caps: {
										kind: string
										sampleRate: number
										format: string
										exclusive: boolean
									}
								}) => {
									sourcesStore.set(config.id, {
										id: config.id,
										connected: true,
										bytesReceived: 0,
										dataRate: 0,
										reconnectAttempts: 0,
										caps: config.caps,
									})
									return {}
								},
							),
							disconnect: vi.fn().mockImplementation(async (id: string) => {
								sourcesStore.delete(id)
							}),
							getStatus: vi.fn().mockImplementation((id: string) => {
								return sourcesStore.get(id)
							}),
							getAllStatus: vi.fn().mockImplementation(() => {
								return Array.from(sourcesStore.values())
							}),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn(),
							stopDecoder: vi.fn(),
							restartDecoder: vi.fn(),
							getDecoder: vi.fn(),
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue([]),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi.fn().mockReturnValue(0),
							getPort: vi.fn().mockReturnValue(8080),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()

							// Add source first time - should succeed
							const firstPostResponse = await app.inject({
								method: "POST",
								url: "/api/sources",
								payload: sourceConfig,
							})

							if (firstPostResponse.statusCode !== 201) {
								return false
							}

							// Add same source again - should return 409 Conflict
							const secondPostResponse = await app.inject({
								method: "POST",
								url: "/api/sources",
								payload: sourceConfig,
							})

							if (secondPostResponse.statusCode !== 409) {
								return false
							}

							const body = JSON.parse(secondPostResponse.body)
							if (body.code !== "SOURCE_EXISTS") {
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)

		it("should return 404 when deleting a non-existent source", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random source IDs that don't exist
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
					async sourceId => {
						const mockSourceManager = new EventEmitter()
						Object.assign(mockSourceManager, {
							connect: vi.fn(),
							disconnect: vi.fn(),
							getStatus: vi.fn().mockReturnValue(undefined), // Source doesn't exist
							getAllStatus: vi.fn().mockReturnValue([]),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn(),
							stopDecoder: vi.fn(),
							restartDecoder: vi.fn(),
							getDecoder: vi.fn(),
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue([]),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi.fn().mockReturnValue(0),
							getPort: vi.fn().mockReturnValue(8080),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()

							// Try to delete non-existent source - should return 404
							const deleteResponse = await app.inject({
								method: "DELETE",
								url: `/api/sources/${sourceId}`,
							})

							if (deleteResponse.statusCode !== 404) {
								return false
							}

							const body = JSON.parse(deleteResponse.body)
							if (body.code !== "SOURCE_NOT_FOUND") {
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)
	})

	/**
	 * Feature: wavekit-core, Property 18: Decoder API State Consistency
	 * Validates: Requirements 9.6, 9.7, 9.8
	 *
	 * For any decoder D, after POST /api/decoders/:id/start, GET /api/decoders/:id
	 * should show `running: true`, and after POST /api/decoders/:id/stop, it should
	 * show `running: false`.
	 */
	describe("Property 18: Decoder API State Consistency", () => {
		it("should maintain state consistency: start sets running=true, stop sets running=false", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate valid decoder configurations
					fc.record({
						id: fc
							.string({ minLength: 1, maxLength: 20 })
							.filter(s => /^[a-zA-Z0-9_-]+$/.test(s)), // Valid ID characters
						type: fc.constantFrom("dsd-fme", "multimon-ng", "rtl433"),
					}),
					async decoderConfig => {
						// Create fresh mocks for each test iteration
						const mockSourceManager = new EventEmitter()
						Object.assign(mockSourceManager, {
							connect: vi.fn(),
							disconnect: vi.fn(),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue([]),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						// Track decoder state
						const decoderState = {
							id: decoderConfig.id,
							type: decoderConfig.type,
							running: false,
							health: "running" as const,
							pid: undefined as number | undefined,
							uptime: 0,
							stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
							restartCount: 0,
						}

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn().mockImplementation(async () => {
								decoderState.running = true
								decoderState.pid = Math.floor(Math.random() * 65535) + 1
							}),
							stopDecoder: vi.fn().mockImplementation(async () => {
								decoderState.running = false
								decoderState.pid = undefined
							}),
							restartDecoder: vi.fn().mockImplementation(async () => {
								decoderState.running = true
								decoderState.pid = Math.floor(Math.random() * 65535) + 1
								decoderState.restartCount++
							}),
							getDecoder: vi.fn().mockImplementation(() => ({
								getStatus: () => ({ ...decoderState }),
							})),
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi
								.fn()
								.mockImplementation(() => ({ ...decoderState })),
							getAllStatus: vi
								.fn()
								.mockImplementation(() => [{ ...decoderState }]),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi.fn().mockReturnValue(0),
							getPort: vi.fn().mockReturnValue(8080),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()

							// Step 1: Verify decoder starts as not running
							const initialGetResponse = await app.inject({
								method: "GET",
								url: `/api/decoders/${decoderConfig.id}`,
							})

							if (initialGetResponse.statusCode !== 200) {
								return false
							}

							const initialStatus = JSON.parse(initialGetResponse.body)
							if (initialStatus.running !== false) {
								// Decoder should start as not running
								return false
							}

							// Step 2: Start the decoder via POST /api/decoders/:id/start
							const startResponse = await app.inject({
								method: "POST",
								url: `/api/decoders/${decoderConfig.id}/start`,
							})

							if (startResponse.statusCode !== 200) {
								return false
							}

							const startBody = JSON.parse(startResponse.body)
							if (startBody.decoder.running !== true) {
								// Start response should show running=true
								return false
							}

							// Step 3: Verify decoder is running via GET /api/decoders/:id
							const afterStartGetResponse = await app.inject({
								method: "GET",
								url: `/api/decoders/${decoderConfig.id}`,
							})

							if (afterStartGetResponse.statusCode !== 200) {
								return false
							}

							const afterStartStatus = JSON.parse(afterStartGetResponse.body)
							if (afterStartStatus.running !== true) {
								// GET should show running=true after start
								return false
							}

							// Step 4: Stop the decoder via POST /api/decoders/:id/stop
							const stopResponse = await app.inject({
								method: "POST",
								url: `/api/decoders/${decoderConfig.id}/stop`,
							})

							if (stopResponse.statusCode !== 200) {
								return false
							}

							const stopBody = JSON.parse(stopResponse.body)
							if (stopBody.decoder.running !== false) {
								// Stop response should show running=false
								return false
							}

							// Step 5: Verify decoder is stopped via GET /api/decoders/:id
							const afterStopGetResponse = await app.inject({
								method: "GET",
								url: `/api/decoders/${decoderConfig.id}`,
							})

							if (afterStopGetResponse.statusCode !== 200) {
								return false
							}

							const afterStopStatus = JSON.parse(afterStopGetResponse.body)
							if (afterStopStatus.running !== false) {
								// GET should show running=false after stop
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)

		it("should return 409 when starting an already running decoder", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate valid decoder configurations
					fc.record({
						id: fc
							.string({ minLength: 1, maxLength: 20 })
							.filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
						type: fc.constantFrom("dsd-fme", "multimon-ng", "rtl433"),
					}),
					async decoderConfig => {
						const mockSourceManager = new EventEmitter()
						Object.assign(mockSourceManager, {
							connect: vi.fn(),
							disconnect: vi.fn(),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue([]),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						// Track decoder state - starts as running
						const decoderState = {
							id: decoderConfig.id,
							type: decoderConfig.type,
							running: false,
							health: "running" as const,
							pid: undefined as number | undefined,
							uptime: 0,
							stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
							restartCount: 0,
						}

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn().mockImplementation(async () => {
								decoderState.running = true
								decoderState.pid = Math.floor(Math.random() * 65535) + 1
							}),
							stopDecoder: vi.fn().mockImplementation(async () => {
								decoderState.running = false
								decoderState.pid = undefined
							}),
							restartDecoder: vi.fn(),
							getDecoder: vi.fn().mockImplementation(() => ({
								getStatus: () => ({ ...decoderState }),
							})),
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi
								.fn()
								.mockImplementation(() => ({ ...decoderState })),
							getAllStatus: vi
								.fn()
								.mockImplementation(() => [{ ...decoderState }]),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi.fn().mockReturnValue(0),
							getPort: vi.fn().mockReturnValue(8080),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()

							// Start decoder first time - should succeed
							const firstStartResponse = await app.inject({
								method: "POST",
								url: `/api/decoders/${decoderConfig.id}/start`,
							})

							if (firstStartResponse.statusCode !== 200) {
								return false
							}

							// Start same decoder again - should return 409 Conflict
							const secondStartResponse = await app.inject({
								method: "POST",
								url: `/api/decoders/${decoderConfig.id}/start`,
							})

							if (secondStartResponse.statusCode !== 409) {
								return false
							}

							const body = JSON.parse(secondStartResponse.body)
							if (body.code !== "DECODER_ALREADY_RUNNING") {
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)

		it("should return 409 when stopping an already stopped decoder", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate valid decoder configurations
					fc.record({
						id: fc
							.string({ minLength: 1, maxLength: 20 })
							.filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
						type: fc.constantFrom("dsd-fme", "multimon-ng", "rtl433"),
					}),
					async decoderConfig => {
						const mockSourceManager = new EventEmitter()
						Object.assign(mockSourceManager, {
							connect: vi.fn(),
							disconnect: vi.fn(),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue([]),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						// Track decoder state - starts as stopped
						const decoderState = {
							id: decoderConfig.id,
							type: decoderConfig.type,
							running: false,
							health: "running" as const,
							pid: undefined as number | undefined,
							uptime: 0,
							stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
							restartCount: 0,
						}

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn(),
							stopDecoder: vi.fn(),
							restartDecoder: vi.fn(),
							getDecoder: vi.fn().mockImplementation(() => ({
								getStatus: () => ({ ...decoderState }),
							})),
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi
								.fn()
								.mockImplementation(() => ({ ...decoderState })),
							getAllStatus: vi
								.fn()
								.mockImplementation(() => [{ ...decoderState }]),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi.fn().mockReturnValue(0),
							getPort: vi.fn().mockReturnValue(8080),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()

							// Try to stop already stopped decoder - should return 409 Conflict
							const stopResponse = await app.inject({
								method: "POST",
								url: `/api/decoders/${decoderConfig.id}/stop`,
							})

							if (stopResponse.statusCode !== 409) {
								return false
							}

							const body = JSON.parse(stopResponse.body)
							if (body.code !== "DECODER_NOT_RUNNING") {
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)

		it("should return 404 when starting/stopping non-existent decoder", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random decoder IDs that don't exist
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
					async decoderId => {
						const mockSourceManager = new EventEmitter()
						Object.assign(mockSourceManager, {
							connect: vi.fn(),
							disconnect: vi.fn(),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue([]),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn(),
							stopDecoder: vi.fn(),
							restartDecoder: vi.fn(),
							getDecoder: vi.fn().mockReturnValue(undefined), // Decoder doesn't exist
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi.fn().mockReturnValue(undefined),
							getAllStatus: vi.fn().mockReturnValue([]),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi.fn().mockReturnValue(0),
							getPort: vi.fn().mockReturnValue(8080),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()

							// Try to start non-existent decoder - should return 404
							const startResponse = await app.inject({
								method: "POST",
								url: `/api/decoders/${decoderId}/start`,
							})

							if (startResponse.statusCode !== 404) {
								return false
							}

							const startBody = JSON.parse(startResponse.body)
							if (startBody.code !== "DECODER_NOT_FOUND") {
								return false
							}

							// Try to stop non-existent decoder - should return 404
							const stopResponse = await app.inject({
								method: "POST",
								url: `/api/decoders/${decoderId}/stop`,
							})

							if (stopResponse.statusCode !== 404) {
								return false
							}

							const stopBody = JSON.parse(stopResponse.body)
							if (stopBody.code !== "DECODER_NOT_FOUND") {
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)
	})

	/**
	 * Feature: wavekit-core, Property 16: API Status Response Completeness
	 * Validates: Requirements 9.2
	 *
	 * For any call to GET /api/status, the response should contain `uptime`,
	 * `sources` (array), `decoders` (array), and `audio` (object with
	 * `outputPort`, `clientsConnected`).
	 */
	describe("Property 16: API Status Response Completeness", () => {
		it("should always return complete status response with all required fields", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random source statuses
					fc.array(
						fc.record({
							id: fc.string({ minLength: 1, maxLength: 20 }),
							connected: fc.boolean(),
							bytesReceived: fc.nat(),
							dataRate: fc.float({ min: 0, max: 1000, noNaN: true }),
							reconnectAttempts: fc.nat({ max: 100 }),
						}),
						{ minLength: 0, maxLength: 5 },
					),
					// Generate random decoder statuses
					fc.array(
						fc.record({
							id: fc.string({ minLength: 1, maxLength: 20 }),
							type: fc.constantFrom("dsd-fme", "multimon-ng", "rtl433"),
							running: fc.boolean(),
							health: fc.constantFrom("running", "degraded", "faulted"),
							uptime: fc.nat(),
							stats: fc.record({
								bytesIn: fc.nat(),
								eventsOut: fc.nat(),
								errors: fc.nat({ max: 1000 }),
							}),
							restartCount: fc.nat({ max: 100 }),
						}),
						{ minLength: 0, maxLength: 5 },
					),
					// Generate random audio output state
					fc.record({
						port: fc.integer({ min: 1024, max: 65535 }),
						clientsConnected: fc.nat({ max: 100 }),
					}),
					async (sources, decoders, audioState) => {
						// Create mock managers with generated data
						const mockSourceManager = new EventEmitter()
						Object.assign(mockSourceManager, {
							connect: vi.fn(),
							disconnect: vi.fn(),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue(sources),
							getStream: vi.fn(),
							getSourceAssignments: vi.fn().mockReturnValue([]),
							isSourceAvailable: vi.fn().mockReturnValue(true),
							assignDecoder: vi.fn(),
							unassignDecoder: vi.fn(),
							getAssignedSource: vi.fn(),
						})

						const mockDecoderManager = new EventEmitter()
						Object.assign(mockDecoderManager, {
							createDecoder: vi.fn(),
							startDecoder: vi.fn(),
							stopDecoder: vi.fn(),
							restartDecoder: vi.fn(),
							getDecoder: vi.fn(),
							getAllDecoders: vi.fn().mockReturnValue([]),
							getStatus: vi.fn(),
							getAllStatus: vi.fn().mockReturnValue(decoders),
							getAllHealth: vi.fn().mockReturnValue(new Map()),
						})

						const mockFanoutManager = new EventEmitter()
						Object.assign(mockFanoutManager, {
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							addBranch: vi.fn(),
							removeBranch: vi.fn(),
							getBranchIds: vi.fn().mockReturnValue([]),
							getBranchStatus: vi.fn(),
							getBranchTelemetry: vi.fn(),
							getTelemetrySnapshot: vi.fn().mockReturnValue({
								timestamp: new Date().toISOString(),
								branches: [],
								backpressureActiveCount: 0,
								droppedBytesTotal: 0,
								droppedChunksTotal: 0,
							}),
							destroy: vi.fn(),
						})

						const mockAudioOutput = new EventEmitter()
						Object.assign(mockAudioOutput, {
							start: vi.fn(),
							stop: vi.fn(),
							attachSource: vi.fn(),
							detachSource: vi.fn(),
							getConnectedClients: vi
								.fn()
								.mockReturnValue(audioState.clientsConnected),
							getPort: vi.fn().mockReturnValue(audioState.port),
						})

						const testLogger = createLogger({ level: "fatal" })
						const testDependencies: ApiServerDependencies = {
							sourceManager:
								mockSourceManager as unknown as ApiServerDependencies["sourceManager"],
							fanoutManager:
								mockFanoutManager as unknown as ApiServerDependencies["fanoutManager"],
							decoderManager:
								mockDecoderManager as unknown as ApiServerDependencies["decoderManager"],
							audioOutput:
								mockAudioOutput as unknown as ApiServerDependencies["audioOutput"],
							logger: testLogger,
						}

						const testServer = new ApiServer(testDependencies, {
							host: "127.0.0.1",
							port: 0,
						})

						await testServer.start()

						try {
							const app = testServer.getApp()
							const response = await app.inject({
								method: "GET",
								url: "/api/status",
							})

							// Verify response status
							if (response.statusCode !== 200) {
								return false
							}

							const body = JSON.parse(response.body)

							// Property 16: Response must contain uptime (number)
							if (typeof body.uptime !== "number") {
								return false
							}

							// Property 16: Response must contain sources (array)
							if (!Array.isArray(body.sources)) {
								return false
							}

							// Property 16: Response must contain decoders (array)
							if (!Array.isArray(body.decoders)) {
								return false
							}

							// Property 16: Response must contain audio object
							if (typeof body.audio !== "object" || body.audio === null) {
								return false
							}

							// Property 16: Audio must have outputPort (number)
							if (typeof body.audio.outputPort !== "number") {
								return false
							}

							// Property 16: Audio must have clientsConnected (number)
							if (typeof body.audio.clientsConnected !== "number") {
								return false
							}

							// Verify the data matches what we provided
							if (body.sources.length !== sources.length) {
								return false
							}

							if (body.decoders.length !== decoders.length) {
								return false
							}

							if (body.audio.outputPort !== audioState.port) {
								return false
							}

							if (body.audio.clientsConnected !== audioState.clientsConnected) {
								return false
							}

							return true
						} finally {
							await testServer.stop()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)
	})
})
