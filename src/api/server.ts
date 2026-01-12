/**
 * API Server - Fastify-based REST and WebSocket server
 *
 * Requirements:
 * - 9.1: GET /health returns system health status
 *
 * This module sets up the Fastify server with:
 * - CORS support for cross-origin requests
 * - WebSocket support for real-time events
 * - Swagger/OpenAPI documentation
 * - Centralized error handling
 */

import Fastify, { type FastifyInstance, type FastifyError } from "fastify"
import fastifyCors from "@fastify/cors"
import fastifyWebsocket from "@fastify/websocket"
import fastifySwagger from "@fastify/swagger"
import fastifySwaggerUi from "@fastify/swagger-ui"
import {
	createComponentLogger,
	generateCorrelationId,
	createScopedLogger,
	type Logger,
} from "../utils/logger.js"
import type { SourceManager } from "../core/source-manager.js"
import type { FanoutManager } from "../core/fanout-manager.js"
import type { DecoderManager } from "../decoders/manager.js"
import type { DecoderRegistry } from "../decoders/registry.js"
import type { AudioOutput } from "../core/audio-output.js"
import type { TunerRelay } from "../core/tuner-relay.js"
import { WaveKitError } from "../utils/errors.js"
import { healthRoutes } from "./routes/health.js"
import { sourceRoutes } from "./routes/sources.js"
import { decoderRoutes } from "./routes/decoders.js"
import { telemetryRoutes } from "./routes/telemetry.js"
import { tunerRelayRoutes } from "./routes/tuner-relay.js"
import { WebSocketEventBroadcaster } from "./websocket/events.js"

/**
 * HTTP header name for correlation ID.
 * Clients can provide their own correlation ID via this header.
 */
const CORRELATION_ID_HEADER = "x-correlation-id"

export interface ApiServerConfig {
	host: string
	port: number
}

export interface AudioConfig {
	format: string
	sampleRate: number
}

export interface ApiServerDependencies {
	sourceManager: SourceManager
	fanoutManager: FanoutManager
	decoderManager: DecoderManager
	decoderRegistry?: DecoderRegistry | undefined
	audioOutput: AudioOutput
	tunerRelay?: TunerRelay | undefined
	logger: Logger
	audioConfig?: AudioConfig | undefined
}

/**
 * ApiServer - Fastify-based REST and WebSocket server for WaveKit.
 *
 * Provides:
 * - REST API for system control (sources, decoders)
 * - WebSocket endpoint for real-time events
 * - OpenAPI documentation via Swagger
 * - CORS support for browser clients
 */
export class ApiServer {
	private readonly app: FastifyInstance
	private readonly log: Logger
	private readonly config: ApiServerConfig
	private readonly sourceManager: SourceManager
	private readonly fanoutManager: FanoutManager
	private readonly decoderManager: DecoderManager
	private readonly decoderRegistry?: DecoderRegistry | undefined
	private readonly audioOutput: AudioOutput
	private readonly tunerRelay?: TunerRelay | undefined
	private readonly audioConfig?: AudioConfig | undefined
	private readonly wsBroadcaster: WebSocketEventBroadcaster
	private telemetryInterval: ReturnType<typeof setInterval> | null = null

	constructor(dependencies: ApiServerDependencies, config: ApiServerConfig) {
		this.sourceManager = dependencies.sourceManager
		this.fanoutManager = dependencies.fanoutManager
		this.decoderManager = dependencies.decoderManager
		this.decoderRegistry = dependencies.decoderRegistry
		this.audioOutput = dependencies.audioOutput
		this.tunerRelay = dependencies.tunerRelay
		this.audioConfig = dependencies.audioConfig
		this.log = createComponentLogger(dependencies.logger, "ApiServer")
		this.config = config

		// Create WebSocket broadcaster
		this.wsBroadcaster = new WebSocketEventBroadcaster(dependencies.logger)

		// Create Fastify instance with custom logger
		this.app = Fastify({
			logger: false, // We use our own Pino logger
			disableRequestLogging: true, // We'll handle request logging ourselves
		})

		// Register error handler immediately so it's available for any routes
		this.registerErrorHandler()

		// Wire up event handlers for broadcasting
		this.setupEventBroadcasting()
	}

	/**
	 * Starts the API server.
	 * Registers all plugins and routes, then begins listening.
	 */
	async start(): Promise<void> {
		this.log.info(
			{ host: this.config.host, port: this.config.port },
			"Starting API server",
		)

		// Register plugins
		await this.registerPlugins()

		// Register request logging hook
		this.registerRequestLogging()

		// Register routes (placeholder - routes will be implemented in later tasks)
		await this.registerRoutes()

		// Start listening
		try {
			await this.app.listen({
				host: this.config.host,
				port: this.config.port,
			})

			this.log.info(
				{ host: this.config.host, port: this.config.port },
				"API server started",
			)
		} catch (err) {
			this.log.error({ err }, "Failed to start API server")
			throw err
		}
	}

	/**
	 * Stops the API server gracefully.
	 */
	async stop(): Promise<void> {
		this.log.info("Stopping API server")

		try {
			// Stop telemetry broadcasting interval
			if (this.telemetryInterval) {
				clearInterval(this.telemetryInterval)
				this.telemetryInterval = null
			}

			// Close all WebSocket connections first
			this.wsBroadcaster.closeAll()

			await this.app.close()
			this.log.info("API server stopped")
		} catch (err) {
			this.log.error({ err }, "Error stopping API server")
			throw err
		}
	}

	/**
	 * Returns the underlying Fastify instance.
	 * Useful for testing or advanced configuration.
	 */
	getApp(): FastifyInstance {
		return this.app
	}

	/**
	 * Returns the source manager instance.
	 * Used by route handlers.
	 */
	getSourceManager(): SourceManager {
		return this.sourceManager
	}

	/**
	 * Returns the fanout manager instance.
	 * Used by route handlers and telemetry.
	 */
	getFanoutManager(): FanoutManager {
		return this.fanoutManager
	}

	/**
	 * Returns the decoder manager instance.
	 * Used by route handlers.
	 */
	getDecoderManager(): DecoderManager {
		return this.decoderManager
	}

	/**
	 * Returns the audio output instance.
	 * Used by route handlers.
	 */
	getAudioOutput(): AudioOutput {
		return this.audioOutput
	}

	/**
	 * Returns the tuner relay instance (if enabled).
	 */
	getTunerRelay(): TunerRelay | undefined {
		return this.tunerRelay
	}

	/**
	 * Returns the WebSocket broadcaster instance.
	 * Used for external event broadcasting.
	 */
	getWebSocketBroadcaster(): WebSocketEventBroadcaster {
		return this.wsBroadcaster
	}

	/**
	 * Sets up event broadcasting from source manager and decoder manager to WebSocket clients.
	 * Wires up event handlers to broadcast events to subscribed clients.
	 *
	 * Requirements:
	 * - 10.3: Broadcast decoder output to subscribed clients
	 * - 10.4: Broadcast source events to subscribed clients
	 * - 20.4: Broadcast decoder health state changes
	 * - Telemetry: Broadcast fanout backpressure/drain events
	 */
	private setupEventBroadcasting(): void {
		// Decoder events (Requirement 10.3)
		this.decoderManager.on("decoder:output", (decoderId, output) => {
			this.wsBroadcaster.broadcastDecoderOutput(decoderId, output)
		})

		this.decoderManager.on("decoder:started", decoderId => {
			this.wsBroadcaster.broadcastDecoderStarted(decoderId)
		})

		this.decoderManager.on("decoder:stopped", decoderId => {
			this.wsBroadcaster.broadcastDecoderStopped(decoderId)
		})

		this.decoderManager.on("decoder:error", (decoderId, error) => {
			this.wsBroadcaster.broadcastDecoderError(decoderId, error.message)
		})

		// Decoder health events (Requirement 20.4)
		this.decoderManager.on("decoder:health", (decoderId, health) => {
			this.wsBroadcaster.broadcastDecoderHealth(decoderId, health)
		})

		// Source events (Requirement 10.4)
		this.sourceManager.on("connected", sourceId => {
			this.wsBroadcaster.broadcastSourceConnected(sourceId)
		})

		this.sourceManager.on("disconnected", (sourceId, error) => {
			this.wsBroadcaster.broadcastSourceDisconnected(sourceId, error?.message)
		})

		this.sourceManager.on("error", (sourceId, error) => {
			this.wsBroadcaster.broadcastSourceError(sourceId, error.message)
		})

		// Metrics events (Requirement 10.5)
		this.sourceManager.on("metrics", (sourceId, metrics) => {
			this.wsBroadcaster.broadcastMetrics(sourceId, metrics)
		})

		// Fanout telemetry events (edge-triggered)
		this.fanoutManager.on("backpressure", (branchId, bufferedBytes) => {
			this.wsBroadcaster.broadcastFanoutBackpressure(branchId, bufferedBytes)
		})

		this.fanoutManager.on("drain", (branchId, durationMs) => {
			this.wsBroadcaster.broadcastFanoutDrain(branchId, durationMs)
		})

		// Periodic fanout telemetry snapshot (every 1 second)
		this.telemetryInterval = setInterval(() => {
			const snapshot = this.fanoutManager.getTelemetrySnapshot()
			this.wsBroadcaster.broadcastFanoutSnapshot(snapshot)
		}, 1000)

		this.log.debug("Event broadcasting handlers registered")
	}

	/**
	 * Registers all Fastify plugins.
	 */
	private async registerPlugins(): Promise<void> {
		// CORS support for browser clients
		await this.app.register(fastifyCors, {
			origin: true, // Allow all origins (can be restricted in production)
			methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowedHeaders: ["Content-Type", "Authorization"],
			credentials: true,
		})

		this.log.debug("CORS plugin registered")

		// WebSocket support for real-time events
		await this.app.register(fastifyWebsocket, {
			options: {
				maxPayload: 1048576, // 1MB max message size
			},
		})

		this.log.debug("WebSocket plugin registered")

		// Swagger/OpenAPI documentation
		await this.app.register(fastifySwagger, {
			openapi: {
				openapi: "3.0.0",
				info: {
					title: "WaveKit API",
					description: "SDR stream processing framework REST API",
					version: "1.0.0",
				},
				servers: [
					{
						url: `http://${this.config.host}:${this.config.port}`,
						description: "Local server",
					},
				],
				tags: [
					{ name: "health", description: "Health check endpoints" },
					{ name: "sources", description: "SDR source management" },
					{ name: "decoders", description: "Decoder management" },
				],
			},
		})

		this.log.debug("Swagger plugin registered")

		// Swagger UI for interactive documentation
		await this.app.register(fastifySwaggerUi, {
			routePrefix: "/docs",
			uiConfig: {
				docExpansion: "list",
				deepLinking: true,
			},
		})

		this.log.debug("Swagger UI plugin registered")
	}

	/**
	 * Registers the centralized error handler.
	 * Converts errors to consistent JSON responses with correlation IDs.
	 *
	 * Requirements:
	 * - 6.3: Include correlation IDs in logs for request tracing
	 */
	private registerErrorHandler(): void {
		// Handle 404 Not Found
		this.app.setNotFoundHandler((request, reply) => {
			const correlationId = (request as unknown as { correlationId?: string })
				.correlationId

			this.log.debug(
				{
					method: request.method,
					url: request.url,
					correlationId,
				},
				"Route not found",
			)

			return reply.status(404).send({
				error: "NotFound",
				code: "NOT_FOUND",
				message: `Route ${request.method} ${request.url} not found`,
				correlationId,
			})
		})

		this.app.setErrorHandler((error: FastifyError, request, reply) => {
			const correlationId = (request as unknown as { correlationId?: string })
				.correlationId

			// Log the error with correlation ID
			this.log.error(
				{
					err: error,
					method: request.method,
					url: request.url,
					statusCode: error.statusCode ?? 500,
					correlationId,
				},
				"Request error",
			)

			// Handle WaveKit-specific errors
			if (error instanceof WaveKitError) {
				return reply.status(400).send({
					error: error.name,
					code: error.code,
					message: error.message,
					correlationId,
				})
			}

			// Handle validation errors (from Fastify schema validation)
			if (error.validation) {
				return reply.status(400).send({
					error: "ValidationError",
					code: "VALIDATION_ERROR",
					message: error.message,
					details: error.validation,
					correlationId,
				})
			}

			// Handle not found errors
			if (error.statusCode === 404) {
				return reply.status(404).send({
					error: "NotFound",
					code: "NOT_FOUND",
					message: error.message || "Resource not found",
					correlationId,
				})
			}

			// Handle other HTTP errors
			if (
				error.statusCode &&
				error.statusCode >= 400 &&
				error.statusCode < 500
			) {
				return reply.status(error.statusCode).send({
					error: error.name || "ClientError",
					code: error.code || "CLIENT_ERROR",
					message: error.message,
					correlationId,
				})
			}

			// Default to 500 for unknown errors
			return reply.status(500).send({
				error: "InternalServerError",
				code: "INTERNAL_ERROR",
				message:
					process.env["NODE_ENV"] === "production"
						? "An internal error occurred"
						: error.message,
				correlationId,
			})
		})

		this.log.debug("Error handler registered")
	}

	/**
	 * Registers request logging hook.
	 * Logs incoming requests and response times with correlation IDs.
	 *
	 * Requirements:
	 * - 6.1: Output structured JSON logs
	 * - 6.3: Include correlation IDs in logs for request tracing
	 */
	private registerRequestLogging(): void {
		// Generate or extract correlation ID for each request
		this.app.addHook("onRequest", async (request, reply) => {
			// Use client-provided correlation ID or generate a new one
			const clientCorrelationId = request.headers[CORRELATION_ID_HEADER]
			const correlationId =
				typeof clientCorrelationId === "string"
					? clientCorrelationId
					: generateCorrelationId()

			// Store correlation ID on request for later use
			;(request as unknown as { correlationId: string }).correlationId =
				correlationId

			// Add correlation ID to response headers for client tracking
			void reply.header(CORRELATION_ID_HEADER, correlationId)

			// Create a request-scoped logger with correlation ID
			const requestLogger = createScopedLogger(
				this.log,
				"Request",
				correlationId,
			)
			;(request as unknown as { log: Logger }).log = requestLogger

			// Skip logging for health checks and docs to reduce noise
			if (request.url === "/health" || request.url.startsWith("/docs")) {
				return
			}

			requestLogger.debug(
				{
					method: request.method,
					url: request.url,
					remoteAddress: request.ip,
				},
				"Incoming request",
			)
		})

		this.app.addHook("onResponse", async (request, reply) => {
			// Skip logging for health checks and docs
			if (request.url === "/health" || request.url.startsWith("/docs")) {
				return
			}

			// Get the correlation ID from the request
			const correlationId = (request as unknown as { correlationId?: string })
				.correlationId

			this.log.info(
				{
					method: request.method,
					url: request.url,
					statusCode: reply.statusCode,
					responseTime: reply.elapsedTime,
					correlationId,
				},
				"Request completed",
			)
		})

		this.log.debug("Request logging hooks registered")
	}

	/**
	 * Registers all API routes.
	 * Routes are implemented in separate files and registered here.
	 */
	private async registerRoutes(): Promise<void> {
		// Register health and status routes (Requirement 9.1, 9.2)
		await this.app.register(healthRoutes, {
			sourceManager: this.sourceManager,
			decoderManager: this.decoderManager,
			audioOutput: this.audioOutput,
			audioConfig: this.audioConfig,
			tunerRelay: this.tunerRelay,
		})

		// Register source routes (Requirement 9.3, 9.4, 9.5)
		await this.app.register(sourceRoutes, {
			sourceManager: this.sourceManager,
			fanoutManager: this.fanoutManager,
		})

		// Register decoder routes (Requirement 9.6, 9.7, 9.8, 9.9)
		await this.app.register(decoderRoutes, {
			decoderManager: this.decoderManager,
			decoderRegistry: this.decoderRegistry,
		})

		// Register telemetry routes (Fanout backpressure monitoring)
		await this.app.register(telemetryRoutes, {
			fanoutManager: this.fanoutManager,
		})

		if (this.tunerRelay) {
			await this.app.register(tunerRelayRoutes, {
				tunerRelay: this.tunerRelay,
			})
		}

		// Register WebSocket route (Requirement 10.1, 10.2, 10.3, 10.4, 10.5)
		this.wsBroadcaster.registerRoute(this.app)

		this.log.debug("Routes registered")
	}
}
