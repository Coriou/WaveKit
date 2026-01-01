/**
 * Logger Unit Tests
 *
 * Tests for the Pino-based structured logging utility.
 * Requirements: 13.1, 13.2, 13.3, 13.4
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as fc from "fast-check"
import {
	createLogger,
	createComponentLogger,
	type LogLevel,
} from "../../../src/utils/logger.js"

describe("Logger", () => {
	describe("createLogger", () => {
		it("should create a logger with the specified log level", () => {
			const levels: LogLevel[] = ["trace", "debug", "info", "warn", "error"]

			for (const level of levels) {
				const logger = createLogger({ level })
				expect(logger.level).toBe(level)
			}
		})

		it("should create a logger that outputs JSON format", () => {
			const logger = createLogger({ level: "info" })
			// Pino loggers have these standard methods
			expect(typeof logger.info).toBe("function")
			expect(typeof logger.error).toBe("function")
			expect(typeof logger.warn).toBe("function")
			expect(typeof logger.debug).toBe("function")
			expect(typeof logger.trace).toBe("function")
		})
	})

	describe("createComponentLogger", () => {
		it("should create a child logger with component context", () => {
			const parent = createLogger({ level: "info" })
			const child = createComponentLogger(parent, "TestComponent")

			// Child logger should have the same level as parent
			expect(child.level).toBe(parent.level)

			// Child logger should have bindings with component
			const bindings = child.bindings()
			expect(bindings["component"]).toBe("TestComponent")
		})

		it("should allow creating multiple component loggers from same parent", () => {
			const parent = createLogger({ level: "debug" })
			const child1 = createComponentLogger(parent, "Component1")
			const child2 = createComponentLogger(parent, "Component2")

			expect(child1.bindings()["component"]).toBe("Component1")
			expect(child2.bindings()["component"]).toBe("Component2")
		})
	})

	describe("file output", () => {
		let tempDir: string

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-logger-test-"))
		})

		afterEach(() => {
			// Clean up temp directory
			if (fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, { recursive: true })
			}
		})

		it("should create log directory if it does not exist", () => {
			const logDir = path.join(tempDir, "logs", "nested")
			expect(fs.existsSync(logDir)).toBe(false)

			createLogger({ level: "info", dir: logDir })

			expect(fs.existsSync(logDir)).toBe(true)
		})

		it("should write logs to file when directory is specified", async () => {
			const logger = createLogger({ level: "info", dir: tempDir })

			logger.info({ test: true }, "Test log message")

			// Flush the logger to ensure async write completes
			await new Promise<void>(resolve => {
				logger.flush()
				// Give a small delay for async write
				setTimeout(resolve, 100)
			})

			const logFile = path.join(tempDir, "wavekit.log")
			expect(fs.existsSync(logFile)).toBe(true)

			const content = fs.readFileSync(logFile, "utf-8")
			expect(content).toContain("Test log message")
			expect(content).toContain('"test":true')
		})
	})
})

describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 23: Log Entry Structure
	 * Validates: Requirements 13.3
	 *
	 * For any log entry produced by the Logger, it should contain
	 * `time` (timestamp), `level` (log level), and `component` (component name) fields.
	 */
	describe("Property 23: Log Entry Structure", () => {
		it("should include time, level, and component in every log entry", async () => {
			const logLevels: LogLevel[] = ["trace", "debug", "info", "warn", "error"]
			// Pino numeric level values
			const pinoLevelValues: Record<LogLevel, number> = {
				trace: 10,
				debug: 20,
				info: 30,
				warn: 40,
				error: 50,
			}

			await fc.assert(
				fc.asyncProperty(
					// Generate random component names (non-empty alphanumeric strings)
					fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,20}$/),
					// Generate random log messages
					fc.string({ minLength: 1, maxLength: 100 }),
					// Generate random log level index
					fc.integer({ min: 0, max: logLevels.length - 1 }),
					// Generate random additional data
					fc.dictionary(
						fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,10}$/),
						fc.oneof(fc.string(), fc.integer(), fc.boolean()),
						{ minKeys: 0, maxKeys: 3 },
					),
					async (componentName, message, levelIndex, extraData) => {
						const level = logLevels[levelIndex] as LogLevel

						// Use a writable stream to capture log output in memory
						const { Writable } = await import("node:stream")
						const pino = await import("pino")

						let capturedOutput = ""
						const captureStream = new Writable({
							write(chunk: Buffer, _encoding, callback) {
								capturedOutput += chunk.toString()
								callback()
							},
						})

						// Create logger with custom destination
						const parentLogger = pino.default(
							{
								level: "trace",
								timestamp: pino.default.stdTimeFunctions.isoTime,
								base: null,
							},
							captureStream,
						)

						const componentLogger = createComponentLogger(
							parentLogger,
							componentName,
						)

						// Log a message at the specified level with extra data
						const logMethod = componentLogger[level].bind(componentLogger)
						logMethod(extraData, message)

						// Parse the JSON log entry
						const logEntry = JSON.parse(capturedOutput.trim()) as Record<
							string,
							unknown
						>

						// Property assertions:
						// 1. Must have 'time' field (timestamp)
						if (!("time" in logEntry)) {
							return false
						}
						if (typeof logEntry["time"] !== "string") {
							return false
						}
						// Verify it's a valid ISO timestamp
						const timestamp = new Date(logEntry["time"] as string)
						if (isNaN(timestamp.getTime())) {
							return false
						}

						// 2. Must have 'level' field with correct numeric value
						if (!("level" in logEntry)) {
							return false
						}
						if (typeof logEntry["level"] !== "number") {
							return false
						}
						if (logEntry["level"] !== pinoLevelValues[level]) {
							return false
						}

						// 3. Must have 'component' field (from child logger)
						if (!("component" in logEntry)) {
							return false
						}
						if (logEntry["component"] !== componentName) {
							return false
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
