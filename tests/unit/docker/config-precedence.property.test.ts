/**
 * Property-Based Test: Configuration via Environment Variables with Precedence
 *
 * Feature: docker-setup, Property 10: Configuration via Environment Variables with Precedence
 * Validates: Requirements 5.1, 5.3
 *
 * For any configuration setting, if both an environment variable (WAVEKIT_* prefix)
 * and a config file specify the same setting, the environment variable value SHALL
 * take precedence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as fc from "fast-check"
import { loadConfig, parseEnvironmentVariables } from "../../../src/config.js"

describe("Feature: docker-setup, Property 10: Configuration via Environment Variables with Precedence", () => {
	let tempDir: string
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-docker-config-"))
		originalEnv = { ...process.env }
		// Clear all WAVEKIT_ env vars before each test
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("WAVEKIT_")) {
				delete process.env[key]
			}
		}
	})

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true })
		}
		// Restore original environment
		process.env = originalEnv
	})

	/**
	 * Property 10.1: Environment variables with WAVEKIT_ prefix override config file values
	 *
	 * For any valid API host and port combination, when both YAML config and
	 * environment variables specify values, the environment variable SHALL take precedence.
	 */
	it("should override API config values with WAVEKIT_API_* environment variables", () => {
		fc.assert(
			fc.property(
				// YAML values (what's in the config file)
				fc.record({
					yamlHost: fc.stringMatching(/^[a-z][a-z0-9.-]{0,15}$/),
					yamlPort: fc.integer({ min: 1, max: 65535 }),
				}),
				// Environment variable values (should override)
				fc.record({
					envHost: fc.stringMatching(/^[a-z][a-z0-9.-]{0,15}$/),
					envPort: fc.integer({ min: 1, max: 65535 }),
				}),
				({ yamlHost, yamlPort }, { envHost, envPort }) => {
					// Skip if values are the same (can't verify precedence)
					if (yamlHost === envHost && yamlPort === envPort) {
						return true
					}

					const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
					const yamlContent = `
api:
  host: ${yamlHost}
  port: ${yamlPort}
`
					fs.writeFileSync(configPath, yamlContent)

					// Set environment variables (Requirements 5.1)
					process.env["WAVEKIT_API_HOST"] = envHost
					process.env["WAVEKIT_API_PORT"] = String(envPort)

					const config = loadConfig(configPath)

					// Clean up for next iteration
					delete process.env["WAVEKIT_API_HOST"]
					delete process.env["WAVEKIT_API_PORT"]

					// Property: Environment variables take precedence (Requirements 5.3)
					return config.api.host === envHost && config.api.port === envPort
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 10.2: Environment variables override audio configuration
	 *
	 * For any valid audio configuration, environment variables SHALL override
	 * config file values.
	 */
	it("should override audio config values with WAVEKIT_AUDIO_* environment variables", () => {
		fc.assert(
			fc.property(
				// YAML audio config
				fc.record({
					yamlTcpPort: fc.integer({ min: 1, max: 65535 }),
					yamlSampleRate: fc.constantFrom(
						8000,
						16000,
						22050,
						44100,
						48000,
						96000,
					),
				}),
				// Environment variable overrides
				fc.record({
					envTcpPort: fc.integer({ min: 1, max: 65535 }),
					envSampleRate: fc.constantFrom(
						8000,
						16000,
						22050,
						44100,
						48000,
						96000,
					),
				}),
				({ yamlTcpPort, yamlSampleRate }, { envTcpPort, envSampleRate }) => {
					// Skip if values are the same
					if (yamlTcpPort === envTcpPort && yamlSampleRate === envSampleRate) {
						return true
					}

					const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
					const yamlContent = `
audio:
  tcpPort: ${yamlTcpPort}
  sampleRate: ${yamlSampleRate}
`
					fs.writeFileSync(configPath, yamlContent)

					// Set environment variables
					process.env["WAVEKIT_AUDIO_TCP_PORT"] = String(envTcpPort)
					process.env["WAVEKIT_AUDIO_SAMPLE_RATE"] = String(envSampleRate)

					const config = loadConfig(configPath)

					// Clean up
					delete process.env["WAVEKIT_AUDIO_TCP_PORT"]
					delete process.env["WAVEKIT_AUDIO_SAMPLE_RATE"]

					// Property: Environment variables take precedence
					return (
						config.audio.tcpPort === envTcpPort &&
						config.audio.sampleRate === envSampleRate
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 10.3: Environment variables override logging configuration
	 *
	 * For any valid logging configuration, environment variables SHALL override
	 * config file values.
	 */
	it("should override logging config values with WAVEKIT_LOG_* environment variables", () => {
		fc.assert(
			fc.property(
				// YAML logging config
				fc.record({
					yamlLevel: fc.constantFrom("trace", "debug", "info", "warn", "error"),
					yamlDir: fc.stringMatching(/^\/[a-z][a-z0-9/]{0,20}$/),
				}),
				// Environment variable overrides
				fc.record({
					envLevel: fc.constantFrom("trace", "debug", "info", "warn", "error"),
					envDir: fc.stringMatching(/^\/[a-z][a-z0-9/]{0,20}$/),
				}),
				({ yamlLevel, yamlDir }, { envLevel, envDir }) => {
					// Skip if values are the same
					if (yamlLevel === envLevel && yamlDir === envDir) {
						return true
					}

					const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
					const yamlContent = `
logging:
  level: ${yamlLevel}
  dir: ${yamlDir}
`
					fs.writeFileSync(configPath, yamlContent)

					// Set environment variables
					process.env["WAVEKIT_LOG_LEVEL"] = envLevel
					process.env["WAVEKIT_LOG_DIR"] = envDir

					const config = loadConfig(configPath)

					// Clean up
					delete process.env["WAVEKIT_LOG_LEVEL"]
					delete process.env["WAVEKIT_LOG_DIR"]

					// Property: Environment variables take precedence
					return (
						config.logging.level === envLevel && config.logging.dir === envDir
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 10.4: Partial environment variable overrides
	 *
	 * When only some environment variables are set, only those specific values
	 * SHALL be overridden while others retain their config file values.
	 */
	it("should only override values for which environment variables are set", () => {
		fc.assert(
			fc.property(
				// YAML config values
				fc.record({
					yamlApiHost: fc.stringMatching(/^[a-z][a-z0-9.-]{0,15}$/),
					yamlApiPort: fc.integer({ min: 1, max: 65535 }),
					yamlLogLevel: fc.constantFrom(
						"trace",
						"debug",
						"info",
						"warn",
						"error",
					),
				}),
				// Only override API host via env var
				fc.stringMatching(/^[a-z][a-z0-9.-]{0,15}$/),
				({ yamlApiHost, yamlApiPort, yamlLogLevel }, envApiHost) => {
					// Skip if host values are the same
					if (yamlApiHost === envApiHost) {
						return true
					}

					const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
					const yamlContent = `
api:
  host: ${yamlApiHost}
  port: ${yamlApiPort}
logging:
  level: ${yamlLogLevel}
`
					fs.writeFileSync(configPath, yamlContent)

					// Only set API host env var (not port or log level)
					process.env["WAVEKIT_API_HOST"] = envApiHost

					const config = loadConfig(configPath)

					// Clean up
					delete process.env["WAVEKIT_API_HOST"]

					// Property: Only API host should be overridden
					// Port and log level should retain YAML values
					return (
						config.api.host === envApiHost &&
						config.api.port === yamlApiPort &&
						config.logging.level === yamlLogLevel
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 10.5: Environment variables with double underscore for nested keys
	 *
	 * Environment variables using double underscore (WAVEKIT_API__PORT) format
	 * SHALL correctly map to nested config paths.
	 */
	it("should support double underscore format for nested config keys", () => {
		fc.assert(
			fc.property(
				// YAML config values
				fc.record({
					yamlApiHost: fc.stringMatching(/^[a-z][a-z0-9.-]{0,15}$/),
					yamlApiPort: fc.integer({ min: 1, max: 65535 }),
				}),
				// Environment variable overrides using double underscore format
				fc.record({
					envApiHost: fc.stringMatching(/^[a-z][a-z0-9.-]{0,15}$/),
					envApiPort: fc.integer({ min: 1, max: 65535 }),
				}),
				({ yamlApiHost, yamlApiPort }, { envApiHost, envApiPort }) => {
					// Skip if values are the same
					if (yamlApiHost === envApiHost && yamlApiPort === envApiPort) {
						return true
					}

					const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
					const yamlContent = `
api:
  host: ${yamlApiHost}
  port: ${yamlApiPort}
`
					fs.writeFileSync(configPath, yamlContent)

					// Use double underscore format (Requirements 5.1)
					process.env["WAVEKIT_API__HOST"] = envApiHost
					process.env["WAVEKIT_API__PORT"] = String(envApiPort)

					const config = loadConfig(configPath)

					// Clean up
					delete process.env["WAVEKIT_API__HOST"]
					delete process.env["WAVEKIT_API__PORT"]

					// Property: Double underscore format should work for nested keys
					return (
						config.api.host === envApiHost && config.api.port === envApiPort
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 10.6: parseEnvironmentVariables returns correct structure
	 *
	 * The parseEnvironmentVariables function SHALL return an object structure
	 * that matches the expected config schema paths.
	 */
	it("should parse WAVEKIT_* environment variables into correct config structure", () => {
		fc.assert(
			fc.property(
				fc.record({
					apiHost: fc.stringMatching(/^[a-z][a-z0-9.-]{0,15}$/),
					apiPort: fc.integer({ min: 1, max: 65535 }),
					logLevel: fc.constantFrom("trace", "debug", "info", "warn", "error"),
				}),
				({ apiHost, apiPort, logLevel }) => {
					// Set environment variables
					process.env["WAVEKIT_API_HOST"] = apiHost
					process.env["WAVEKIT_API_PORT"] = String(apiPort)
					process.env["WAVEKIT_LOG_LEVEL"] = logLevel

					const envConfig = parseEnvironmentVariables()

					// Clean up
					delete process.env["WAVEKIT_API_HOST"]
					delete process.env["WAVEKIT_API_PORT"]
					delete process.env["WAVEKIT_LOG_LEVEL"]

					// Property: Parsed env vars should have correct structure
					const api = envConfig["api"] as Record<string, unknown> | undefined
					const logging = envConfig["logging"] as
						| Record<string, unknown>
						| undefined

					return (
						api?.["host"] === apiHost &&
						api?.["port"] === apiPort &&
						logging?.["level"] === logLevel
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
