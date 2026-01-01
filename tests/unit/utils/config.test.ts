/**
 * Configuration Loader Unit Tests
 *
 * Tests for YAML configuration loading with environment variable overrides.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as fc from "fast-check"
import {
	loadConfig,
	validateConfig,
	ConfigSchema,
} from "../../../src/config.js"
import { ConfigValidationError } from "../../../src/utils/errors.js"

describe("Configuration Loader", () => {
	let tempDir: string
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-config-test-"))
		originalEnv = { ...process.env }
	})

	afterEach(() => {
		// Clean up temp directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true })
		}
		// Restore environment
		process.env = originalEnv
	})

	describe("loadConfig", () => {
		it("should load configuration from YAML file (Requirement 12.1)", () => {
			const configPath = path.join(tempDir, "config.yaml")
			const yamlContent = `
sources:
  - id: test-source
    type: rtl_tcp
    host: localhost
    port: 1234
    format: S16LE
    sampleRate: 48000
decoders:
  - id: test-decoder
    type: dsd-fme
    enabled: true
    options:
      mode: auto
audio:
  tcpPort: 9000
  format: S16LE
  sampleRate: 48000
api:
  host: 127.0.0.1
  port: 4000
logging:
  level: debug
`
			fs.writeFileSync(configPath, yamlContent)

			const config = loadConfig(configPath)

			expect(config.sources).toHaveLength(1)
			expect(config.sources[0]?.id).toBe("test-source")
			expect(config.decoders).toHaveLength(1)
			expect(config.decoders[0]?.type).toBe("dsd-fme")
			expect(config.audio.tcpPort).toBe(9000)
			expect(config.api.host).toBe("127.0.0.1")
			expect(config.api.port).toBe(4000)
			expect(config.logging.level).toBe("debug")
		})

		it("should apply default values when config file is missing", () => {
			const config = loadConfig(path.join(tempDir, "nonexistent.yaml"))

			expect(config.sources).toEqual([])
			expect(config.decoders).toEqual([])
			expect(config.audio.tcpPort).toBe(8080)
			expect(config.audio.format).toBe("S16LE")
			expect(config.audio.sampleRate).toBe(48000)
			expect(config.api.host).toBe("0.0.0.0")
			expect(config.api.port).toBe(3000)
			expect(config.logging.level).toBe("info")
		})

		it("should override config values with environment variables (Requirement 12.2)", () => {
			const configPath = path.join(tempDir, "config.yaml")
			const yamlContent = `
api:
  host: 127.0.0.1
  port: 3000
logging:
  level: info
`
			fs.writeFileSync(configPath, yamlContent)

			// Set environment variables
			process.env["WAVEKIT_API_HOST"] = "0.0.0.0"
			process.env["WAVEKIT_API_PORT"] = "5000"
			process.env["WAVEKIT_LOG_LEVEL"] = "debug"
			process.env["WAVEKIT_AUDIO_TCP_PORT"] = "9999"

			const config = loadConfig(configPath)

			// Environment variables should override YAML values
			expect(config.api.host).toBe("0.0.0.0")
			expect(config.api.port).toBe(5000)
			expect(config.logging.level).toBe("debug")
			expect(config.audio.tcpPort).toBe(9999)
		})

		it("should validate configuration against Zod schema (Requirement 12.3)", () => {
			const configPath = path.join(tempDir, "config.yaml")
			const yamlContent = `
sources:
  - id: valid-source
    type: rtl_tcp
    host: localhost
    port: 1234
    format: S16LE
    sampleRate: 48000
`
			fs.writeFileSync(configPath, yamlContent)

			const config = loadConfig(configPath)

			// Should pass schema validation
			expect(config.sources[0]?.type).toBe("rtl_tcp")
			expect(config.sources[0]?.format).toBe("S16LE")
		})

		it("should return descriptive validation errors for invalid config (Requirement 12.4)", () => {
			const configPath = path.join(tempDir, "config.yaml")
			const yamlContent = `
sources:
  - id: invalid-source
    type: invalid_type
    host: localhost
    port: -1
    format: INVALID
    sampleRate: 0
`
			fs.writeFileSync(configPath, yamlContent)

			expect(() => loadConfig(configPath)).toThrow(ConfigValidationError)

			try {
				loadConfig(configPath)
			} catch (error) {
				expect(error).toBeInstanceOf(ConfigValidationError)
				const configError = error as ConfigValidationError
				expect(configError.zodError.issues.length).toBeGreaterThan(0)
				// Should have descriptive error messages
				const messages = configError.zodError.issues.map(i => i.message)
				expect(messages.some(m => m.length > 0)).toBe(true)
			}
		})

		it("should support all config sections (Requirement 12.5)", () => {
			const configPath = path.join(tempDir, "config.yaml")
			const yamlContent = `
sources:
  - id: source1
    type: sdrpp-network
    host: 192.168.1.100
    port: 5555
    format: FLOAT32LE
    sampleRate: 96000
decoders:
  - id: decoder1
    type: multimon-ng
    enabled: false
    options:
      modes:
        - POCSAG512
        - POCSAG1200
audio:
  tcpPort: 7000
  format: FLOAT32LE
  sampleRate: 96000
api:
  host: localhost
  port: 8080
logging:
  level: trace
  dir: /var/log/wavekit
`
			fs.writeFileSync(configPath, yamlContent)

			const config = loadConfig(configPath)

			// Verify all sections are loaded
			expect(config.sources).toBeDefined()
			expect(config.decoders).toBeDefined()
			expect(config.audio).toBeDefined()
			expect(config.api).toBeDefined()
			expect(config.logging).toBeDefined()

			// Verify specific values
			expect(config.sources[0]?.type).toBe("sdrpp-network")
			expect(config.decoders[0]?.enabled).toBe(false)
			expect(config.audio.format).toBe("FLOAT32LE")
			expect(config.logging.dir).toBe("/var/log/wavekit")
		})

		it("should handle empty YAML file gracefully", () => {
			const configPath = path.join(tempDir, "empty.yaml")
			fs.writeFileSync(configPath, "")

			const config = loadConfig(configPath)

			// Should use defaults
			expect(config.sources).toEqual([])
			expect(config.api.port).toBe(3000)
		})

		it("should throw error for malformed YAML", () => {
			const configPath = path.join(tempDir, "malformed.yaml")
			fs.writeFileSync(configPath, "invalid: yaml: content: [")

			expect(() => loadConfig(configPath)).toThrow(ConfigValidationError)
		})
	})

	describe("validateConfig", () => {
		it("should validate a complete config object", () => {
			const rawConfig = {
				sources: [],
				decoders: [],
				audio: { tcpPort: 8080, format: "S16LE", sampleRate: 48000 },
				api: { host: "0.0.0.0", port: 3000 },
				logging: { level: "info" },
			}

			const config = validateConfig(rawConfig)

			expect(config.api.port).toBe(3000)
		})

		it("should throw ConfigValidationError for invalid config", () => {
			const invalidConfig = {
				sources: [{ id: "test", type: "invalid" }],
			}

			expect(() => validateConfig(invalidConfig)).toThrow(ConfigValidationError)
		})
	})

	describe("ConfigSchema", () => {
		it("should export the Zod schema for external use", () => {
			expect(ConfigSchema).toBeDefined()
			expect(typeof ConfigSchema.parse).toBe("function")
			expect(typeof ConfigSchema.safeParse).toBe("function")
		})
	})

	describe("Environment Variable Overrides", () => {
		it("should handle WAVEKIT_LOG_DIR environment variable", () => {
			process.env["WAVEKIT_LOG_DIR"] = "/custom/log/path"

			const config = loadConfig(path.join(tempDir, "nonexistent.yaml"))

			expect(config.logging.dir).toBe("/custom/log/path")
		})

		it("should handle WAVEKIT_AUDIO_SAMPLE_RATE environment variable", () => {
			process.env["WAVEKIT_AUDIO_SAMPLE_RATE"] = "96000"

			const config = loadConfig(path.join(tempDir, "nonexistent.yaml"))

			expect(config.audio.sampleRate).toBe(96000)
		})

		it("should handle WAVEKIT_AUDIO_FORMAT environment variable", () => {
			process.env["WAVEKIT_AUDIO_FORMAT"] = "FLOAT32LE"

			const config = loadConfig(path.join(tempDir, "nonexistent.yaml"))

			expect(config.audio.format).toBe("FLOAT32LE")
		})

		it("should ignore invalid numeric environment variables", () => {
			process.env["WAVEKIT_API_PORT"] = "not-a-number"

			// Should not throw, but use default
			const config = loadConfig(path.join(tempDir, "nonexistent.yaml"))

			expect(config.api.port).toBe(3000)
		})
	})
})

describe("Property-Based Tests", () => {
	let tempDir: string
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-config-pbt-"))
		originalEnv = { ...process.env }
	})

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true })
		}
		process.env = originalEnv
	})

	/**
	 * Feature: wavekit-core, Property 21: Config Environment Override
	 * Validates: Requirements 12.2
	 *
	 * For any configuration key K with YAML value Y and environment variable value E,
	 * the loaded config should have value E (environment overrides file).
	 */
	describe("Property 21: Config Environment Override", () => {
		it("should override YAML values with environment variables for all supported env vars", () => {
			fc.assert(
				fc.property(
					// Generate random API host (valid hostname-like strings)
					fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/),
					// Generate random API port (valid port numbers)
					fc.integer({ min: 1, max: 65535 }),
					// Generate random audio TCP port
					fc.integer({ min: 1, max: 65535 }),
					// Generate random sample rate (common audio sample rates)
					fc.constantFrom(8000, 16000, 22050, 44100, 48000, 96000),
					// Generate random log level
					fc.constantFrom("trace", "debug", "info", "warn", "error"),
					// Generate random log directory path
					fc.stringMatching(/^\/[a-z][a-z0-9/]{0,30}$/),
					(apiHost, apiPort, audioPort, sampleRate, logLevel, logDir) => {
						// Create YAML config with different values
						const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
						const yamlContent = `
api:
  host: original-host
  port: 1111
audio:
  tcpPort: 2222
  sampleRate: 11025
logging:
  level: info
  dir: /original/path
`
						fs.writeFileSync(configPath, yamlContent)

						// Set environment variables with generated values
						process.env["WAVEKIT_API_HOST"] = apiHost
						process.env["WAVEKIT_API_PORT"] = String(apiPort)
						process.env["WAVEKIT_AUDIO_TCP_PORT"] = String(audioPort)
						process.env["WAVEKIT_AUDIO_SAMPLE_RATE"] = String(sampleRate)
						process.env["WAVEKIT_LOG_LEVEL"] = logLevel
						process.env["WAVEKIT_LOG_DIR"] = logDir

						const config = loadConfig(configPath)

						// Clean up env vars for next iteration
						delete process.env["WAVEKIT_API_HOST"]
						delete process.env["WAVEKIT_API_PORT"]
						delete process.env["WAVEKIT_AUDIO_TCP_PORT"]
						delete process.env["WAVEKIT_AUDIO_SAMPLE_RATE"]
						delete process.env["WAVEKIT_LOG_LEVEL"]
						delete process.env["WAVEKIT_LOG_DIR"]

						// Property: Environment variables should override YAML values
						return (
							config.api.host === apiHost &&
							config.api.port === apiPort &&
							config.audio.tcpPort === audioPort &&
							config.audio.sampleRate === sampleRate &&
							config.logging.level === logLevel &&
							config.logging.dir === logDir
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should preserve YAML values when environment variables are not set", () => {
			fc.assert(
				fc.property(
					// Generate random API host
					fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/),
					// Generate random API port
					fc.integer({ min: 1, max: 65535 }),
					// Generate random log level
					fc.constantFrom("trace", "debug", "info", "warn", "error"),
					(yamlHost, yamlPort, yamlLogLevel) => {
						const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
						const yamlContent = `
api:
  host: ${yamlHost}
  port: ${yamlPort}
logging:
  level: ${yamlLogLevel}
`
						fs.writeFileSync(configPath, yamlContent)

						// Ensure no env vars are set
						delete process.env["WAVEKIT_API_HOST"]
						delete process.env["WAVEKIT_API_PORT"]
						delete process.env["WAVEKIT_LOG_LEVEL"]

						const config = loadConfig(configPath)

						// Property: YAML values should be preserved when no env override
						return (
							config.api.host === yamlHost &&
							config.api.port === yamlPort &&
							config.logging.level === yamlLogLevel
						)
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 22: Config Validation Errors
	 * Validates: Requirements 12.3, 12.4
	 *
	 * For any invalid configuration (missing required fields, wrong types),
	 * the Config_Loader should return a Zod validation error with a descriptive
	 * message indicating the invalid field.
	 */
	describe("Property 22: Config Validation Errors", () => {
		it("should return validation errors for invalid source type", () => {
			fc.assert(
				fc.property(
					// Generate invalid source types (not rtl_tcp or sdrpp-network)
					fc
						.stringMatching(/^[a-z_]{3,15}$/)
						.filter(
							s =>
								s !== "rtl_tcp" &&
								s !== "sdrpp_network" &&
								s !== "sdrpp-network",
						),
					invalidType => {
						const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
						const yamlContent = `
sources:
  - id: test-source
    type: ${invalidType}
    host: localhost
    port: 1234
    format: S16LE
    sampleRate: 48000
`
						fs.writeFileSync(configPath, yamlContent)

						try {
							loadConfig(configPath)
							return false // Should have thrown
						} catch (error) {
							if (!(error instanceof ConfigValidationError)) {
								return false
							}
							// Property: Error should have issues array with descriptive messages
							const hasIssues = error.zodError.issues.length > 0
							const hasPath = error.zodError.issues.some(
								issue => issue.path.length > 0,
							)
							const hasMessage = error.zodError.issues.some(
								issue => issue.message.length > 0,
							)
							return hasIssues && hasPath && hasMessage
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return validation errors for invalid port numbers", () => {
			fc.assert(
				fc.property(
					// Generate invalid port numbers (negative, zero, or too large)
					fc.oneof(
						fc.integer({ min: -1000, max: 0 }),
						fc.integer({ min: 65536, max: 100000 }),
					),
					invalidPort => {
						const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
						const yamlContent = `
sources:
  - id: test-source
    type: rtl_tcp
    host: localhost
    port: ${invalidPort}
    format: S16LE
    sampleRate: 48000
`
						fs.writeFileSync(configPath, yamlContent)

						try {
							loadConfig(configPath)
							return false // Should have thrown
						} catch (error) {
							if (!(error instanceof ConfigValidationError)) {
								return false
							}
							// Property: Error should indicate the invalid field path
							const hasPortInPath = error.zodError.issues.some(issue =>
								issue.path.includes("port"),
							)
							return hasPortInPath
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return validation errors for invalid audio format", () => {
			fc.assert(
				fc.property(
					// Generate invalid audio formats (not S16LE or FLOAT32LE)
					fc
						.stringMatching(/^[A-Z0-9]{3,12}$/)
						.filter(s => s !== "S16LE" && s !== "FLOAT32LE"),
					invalidFormat => {
						const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
						const yamlContent = `
audio:
  tcpPort: 8080
  format: ${invalidFormat}
  sampleRate: 48000
`
						fs.writeFileSync(configPath, yamlContent)

						try {
							loadConfig(configPath)
							return false // Should have thrown
						} catch (error) {
							if (!(error instanceof ConfigValidationError)) {
								return false
							}
							// Property: Error should have descriptive message about format
							const hasFormatInPath = error.zodError.issues.some(issue =>
								issue.path.includes("format"),
							)
							return hasFormatInPath
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return validation errors for invalid log level", () => {
			fc.assert(
				fc.property(
					// Generate invalid log levels
					fc
						.stringMatching(/^[a-z]{3,10}$/)
						.filter(
							s => !["trace", "debug", "info", "warn", "error"].includes(s),
						),
					invalidLevel => {
						const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)
						const yamlContent = `
logging:
  level: ${invalidLevel}
`
						fs.writeFileSync(configPath, yamlContent)

						try {
							loadConfig(configPath)
							return false // Should have thrown
						} catch (error) {
							if (!(error instanceof ConfigValidationError)) {
								return false
							}
							// Property: Error should indicate the invalid level field
							const hasLevelInPath = error.zodError.issues.some(issue =>
								issue.path.includes("level"),
							)
							return hasLevelInPath
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return validation errors for missing required source fields", () => {
			// Required fields for source: id, type, host, port, format, sampleRate
			const requiredFields = [
				"id",
				"type",
				"host",
				"port",
				"format",
				"sampleRate",
			]

			fc.assert(
				fc.property(
					// Pick a random required field to omit
					fc.constantFrom(...requiredFields),
					fieldToOmit => {
						const configPath = path.join(tempDir, `config-${Date.now()}.yaml`)

						// Build source config with one field missing
						const sourceFields: Record<string, string | number> = {
							id: "test-source",
							type: "rtl_tcp",
							host: "localhost",
							port: 1234,
							format: "S16LE",
							sampleRate: 48000,
						}
						delete sourceFields[fieldToOmit]

						const sourceYaml = Object.entries(sourceFields)
							.map(([k, v]) => `    ${k}: ${v}`)
							.join("\n")

						const yamlContent = `
sources:
  - 
${sourceYaml}
`
						fs.writeFileSync(configPath, yamlContent)

						try {
							loadConfig(configPath)
							return false // Should have thrown
						} catch (error) {
							if (!(error instanceof ConfigValidationError)) {
								return false
							}
							// Property: Error should exist and have issues
							return error.zodError.issues.length > 0
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
