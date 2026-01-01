/**
 * Graceful Shutdown - Signal handling and cleanup
 *
 * Requirements:
 * - 14.1: WHEN SIGTERM is received, THE Application SHALL begin graceful shutdown
 * - 14.6: IF shutdown takes longer than 10 seconds, THEN THE Application SHALL force exit
 */

import type { Logger } from "./logger.js"

export interface ShutdownHandler {
	name: string
	handler: () => Promise<void>
	timeout?: number // ms, default 5000
}

const DEFAULT_HANDLER_TIMEOUT = 5000
const DEFAULT_SHUTDOWN_TIMEOUT = 10000

export class GracefulShutdown {
	private handlers: ShutdownHandler[] = []
	private shuttingDown = false
	private logger: Logger | null = null
	private shutdownTimeout: number

	constructor(options?: { logger?: Logger; shutdownTimeout?: number }) {
		this.logger = options?.logger ?? null
		this.shutdownTimeout = options?.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT
	}

	/**
	 * Register a shutdown handler to be called during graceful shutdown.
	 * Handlers are called in reverse order of registration (LIFO).
	 */
	register(handler: ShutdownHandler): void {
		// Prevent duplicate registrations
		const existing = this.handlers.find(h => h.name === handler.name)
		if (existing) {
			this.logger?.warn(
				{ name: handler.name },
				"Shutdown handler already registered, replacing",
			)
			this.unregister(handler.name)
		}

		this.handlers.push({
			...handler,
			timeout: handler.timeout ?? DEFAULT_HANDLER_TIMEOUT,
		})
		this.logger?.debug({ name: handler.name }, "Shutdown handler registered")
	}

	/**
	 * Unregister a shutdown handler by name.
	 */
	unregister(name: string): void {
		const index = this.handlers.findIndex(h => h.name === name)
		if (index !== -1) {
			this.handlers.splice(index, 1)
			this.logger?.debug({ name }, "Shutdown handler unregistered")
		}
	}

	/**
	 * Get all registered handler names (for testing/debugging).
	 */
	getHandlerNames(): string[] {
		return this.handlers.map(h => h.name)
	}

	/**
	 * Check if shutdown is in progress.
	 */
	isShuttingDown(): boolean {
		return this.shuttingDown
	}

	/**
	 * Execute graceful shutdown, calling all registered handlers.
	 * Handlers are called in reverse order (LIFO) with individual timeouts.
	 * If total shutdown exceeds the shutdown timeout, force exit occurs.
	 */
	async shutdown(): Promise<void> {
		if (this.shuttingDown) {
			this.logger?.warn("Shutdown already in progress")
			return
		}

		this.shuttingDown = true
		this.logger?.info("Beginning graceful shutdown")

		// Set up force exit timer (Requirement 14.6)
		const forceExitTimer = setTimeout(() => {
			this.logger?.error(
				{ timeout: this.shutdownTimeout },
				"Shutdown timeout exceeded, forcing exit",
			)
			process.exit(1)
		}, this.shutdownTimeout)

		// Ensure the timer doesn't keep the process alive
		forceExitTimer.unref()

		try {
			// Execute handlers in reverse order (LIFO)
			const handlersToRun = [...this.handlers].reverse()

			for (const handler of handlersToRun) {
				await this.executeHandler(handler)
			}

			this.logger?.info("Graceful shutdown completed")
		} catch (err) {
			this.logger?.error({ err }, "Error during shutdown")
		} finally {
			clearTimeout(forceExitTimer)
		}
	}

	/**
	 * Execute a single handler with its timeout.
	 */
	private async executeHandler(handler: ShutdownHandler): Promise<void> {
		this.logger?.debug({ name: handler.name }, "Executing shutdown handler")

		const timeoutPromise = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Shutdown handler "${handler.name}" timed out`))
			}, handler.timeout)
			timer.unref()
		})

		try {
			await Promise.race([handler.handler(), timeoutPromise])
			this.logger?.debug(
				{ name: handler.name },
				"Shutdown handler completed successfully",
			)
		} catch (err) {
			this.logger?.error(
				{ name: handler.name, err },
				"Shutdown handler failed or timed out",
			)
			// Continue with other handlers even if one fails
		}
	}

	/**
	 * Install signal handlers for SIGTERM and SIGINT.
	 * Call this once at application startup.
	 */
	installSignalHandlers(): void {
		const handleSignal = (signal: string) => {
			this.logger?.info({ signal }, "Received shutdown signal")
			this.shutdown()
				.then(() => {
					process.exit(0)
				})
				.catch(err => {
					this.logger?.error({ err }, "Shutdown failed")
					process.exit(1)
				})
		}

		// SIGTERM - standard termination signal (Requirement 14.1)
		process.on("SIGTERM", () => handleSignal("SIGTERM"))

		// SIGINT - Ctrl+C in terminal
		process.on("SIGINT", () => handleSignal("SIGINT"))

		this.logger?.debug("Signal handlers installed for SIGTERM and SIGINT")
	}
}

/**
 * Create a singleton instance for application-wide use.
 * This is the recommended way to use GracefulShutdown.
 */
let instance: GracefulShutdown | null = null

export function getGracefulShutdown(options?: {
	logger?: Logger
	shutdownTimeout?: number
}): GracefulShutdown {
	if (!instance) {
		instance = new GracefulShutdown(options)
	}
	return instance
}

/**
 * Reset the singleton instance (primarily for testing).
 */
export function resetGracefulShutdown(): void {
	instance = null
}
