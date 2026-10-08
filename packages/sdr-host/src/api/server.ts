import Fastify, { type FastifyInstance } from "fastify"
import cors from "@fastify/cors"
import type { Logger } from "@wavekit/shared"
import type { SdrHostTelemetry } from "@wavekit/api-types"
import type { ProcessManager } from "../supervisor/process-manager.js"
import type { PreflightResult } from "../supervisor/preflight.js"
import type { SdrHostConfig } from "../config.js"
import { registerHealthRoutes } from "./routes/health.js"
import { registerStatusRoutes } from "./routes/status.js"
import { registerFixRoutes } from "./routes/fix.js"
import { registerHostRoutes } from "./routes/host.js"
import { registerUiRoutes } from "./routes/ui.js"

/** The part of HostCollector the API reads; requests never trigger I/O. */
export interface HostTelemetrySource {
	snapshot(): SdrHostTelemetry
}

export interface ApiServerDependencies {
	config: SdrHostConfig
	logger: Logger
	processManager: ProcessManager
	preflightResult: PreflightResult
	hostTelemetry: HostTelemetrySource
	/** Operator page asset directory; defaults to the package's ui/. */
	uiRoot?: string
}

/**
 * Creates and configures the Fastify API server.
 */
export async function createApiServer(
	deps: ApiServerDependencies,
): Promise<FastifyInstance> {
	const { config, logger, processManager, preflightResult, hostTelemetry } =
		deps
	const startTime = Date.now()

	const fastify = Fastify({
		logger: false, // We use our own logger
	})

	// The operator page is same-origin. Other browser origins may read the API
	// only when explicitly allowed; it exposes LAN and host details.
	await fastify.register(cors, {
		origin: config.api.corsOrigins.length > 0 ? config.api.corsOrigins : false,
		methods: ["GET"],
	})

	// Telemetry must never be served from a cache as if it were current.
	fastify.addHook("onSend", async (request, reply, payload) => {
		if (request.url.startsWith("/api/") || request.url.startsWith("/health")) {
			reply.header("Cache-Control", "no-store")
			reply.header("X-Content-Type-Options", "nosniff")
		}
		return payload
	})

	// Add dependencies to request
	fastify.decorate("processManager", processManager)
	fastify.decorate("preflightResult", preflightResult)
	fastify.decorate("startTime", startTime)
	fastify.decorate("appLogger", logger)
	fastify.decorate("hostTelemetry", hostTelemetry)

	// Register routes
	registerHealthRoutes(fastify)
	registerStatusRoutes(fastify, config)
	registerFixRoutes(fastify)
	registerHostRoutes(fastify)
	registerUiRoutes(
		fastify,
		deps.uiRoot === undefined ? {} : { root: deps.uiRoot },
	)

	return fastify
}

/**
 * Starts the API server.
 */
export async function startApiServer(
	fastify: FastifyInstance,
	config: SdrHostConfig,
	logger: Logger,
): Promise<void> {
	const address = await fastify.listen({
		host: config.api.host,
		port: config.api.port,
	})
	logger.info({ address }, "API server started")
}

// TypeScript augmentation for Fastify
declare module "fastify" {
	interface FastifyInstance {
		processManager: ProcessManager
		preflightResult: PreflightResult
		startTime: number
		appLogger: Logger
		hostTelemetry: HostTelemetrySource
	}
}
