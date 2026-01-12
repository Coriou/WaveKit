import Fastify, { type FastifyInstance } from "fastify"
import cors from "@fastify/cors"
import type { Logger } from "@wavekit/shared"
import type { ProcessManager } from "../supervisor/process-manager.js"
import type { PreflightResult } from "../supervisor/preflight.js"
import type { SdrHostConfig } from "../config.js"
import { registerHealthRoutes } from "./routes/health.js"
import { registerStatusRoutes } from "./routes/status.js"
import { registerFixRoutes } from "./routes/fix.js"

export interface ApiServerDependencies {
	config: SdrHostConfig
	logger: Logger
	processManager: ProcessManager
	preflightResult: PreflightResult
}

/**
 * Creates and configures the Fastify API server.
 */
export async function createApiServer(
	deps: ApiServerDependencies,
): Promise<FastifyInstance> {
	const { config, logger, processManager, preflightResult } = deps
	const startTime = Date.now()

	const fastify = Fastify({
		logger: false, // We use our own logger
	})

	// Enable CORS
	await fastify.register(cors, {
		origin: true,
		methods: ["GET", "POST"],
	})

	// Add dependencies to request
	fastify.decorate("processManager", processManager)
	fastify.decorate("preflightResult", preflightResult)
	fastify.decorate("startTime", startTime)
	fastify.decorate("appLogger", logger)

	// Register routes
	registerHealthRoutes(fastify)
	registerStatusRoutes(fastify, config)
	registerFixRoutes(fastify)

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
	}
}
