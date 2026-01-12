import { describe, it, expect } from "vitest"
import {
	SdrHostConfigSchema,
	parseEnvironmentVariables,
} from "../../src/config.js"

describe("SdrHostConfigSchema", () => {
	it("should provide correct defaults", () => {
		const result = SdrHostConfigSchema.parse({})

		expect(result.rtlTcp.internalPort).toBe(1234)
		expect(result.rtlTcp.sampleRate).toBe(2048000)
		expect(result.rtlTcp.agc).toBe(false)
		expect(result.rtlTcp.gain).toBe(49)
		expect(result.rtlTcp.ppm).toBe(0)
		expect(result.rtlTcp.deviceIndex).toBe(0)

		expect(result.rtlmux.port).toBe(5555)
		expect(result.rtlmux.bind).toBe("0.0.0.0")

		expect(result.api.host).toBe("0.0.0.0")
		expect(result.api.port).toBe(8080)

		expect(result.logging.level).toBe("info")
		expect(result.logging.pretty).toBe(false)
	})

	it("should accept valid custom values", () => {
		const result = SdrHostConfigSchema.parse({
			rtlTcp: {
				internalPort: 2345,
				sampleRate: 1024000,
				agc: false,
				gain: 42.5,
				ppm: 50,
				deviceIndex: 1,
			},
			rtlmux: {
				port: 6666,
				bind: "192.168.1.1",
				statsPort: 6667,
			},
			api: {
				host: "127.0.0.1",
				port: 9090,
			},
			logging: {
				level: "debug",
				pretty: true,
			},
		})

		expect(result.rtlTcp.internalPort).toBe(2345)
		expect(result.rtlTcp.sampleRate).toBe(1024000)
		expect(result.rtlTcp.agc).toBe(false)
		expect(result.rtlTcp.gain).toBe(42.5)
		expect(result.rtlmux.port).toBe(6666)
		expect(result.rtlmux.statsPort).toBe(6667)
		expect(result.api.port).toBe(9090)
		expect(result.logging.level).toBe("debug")
	})

	it("should reject invalid port numbers", () => {
		expect(() =>
			SdrHostConfigSchema.parse({
				rtlmux: { port: 0 },
			}),
		).toThrow()

		expect(() =>
			SdrHostConfigSchema.parse({
				rtlmux: { port: 70000 },
			}),
		).toThrow()
	})

	it("should reject invalid gain values", () => {
		expect(() =>
			SdrHostConfigSchema.parse({
				rtlTcp: { gain: -1 },
			}),
		).toThrow()

		expect(() =>
			SdrHostConfigSchema.parse({
				rtlTcp: { gain: 100.1 },
			}),
		).toThrow()
	})

	it("should reject invalid ppm values", () => {
		expect(() =>
			SdrHostConfigSchema.parse({
				rtlTcp: { ppm: -201 },
			}),
		).toThrow()

		expect(() =>
			SdrHostConfigSchema.parse({
				rtlTcp: { ppm: 201 },
			}),
		).toThrow()
	})
})

describe("parseEnvironmentVariables", () => {
	const originalEnv = process.env

	beforeEach(() => {
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("should parse SDR_HOST_ prefixed variables", () => {
		process.env["SDR_HOST_RTLMUX__PORT"] = "6666"
		process.env["SDR_HOST_API__PORT"] = "9090"
		process.env["SDR_HOST_RTL_TCP__AGC"] = "false"

		const result = parseEnvironmentVariables()

		expect(result["rtlmux"]).toEqual({ port: 6666 })
		expect(result["api"]).toEqual({ port: 9090 })
		expect(result["rtlTcp"]).toEqual({ agc: false })
	})

	it("should parse boolean values", () => {
		process.env["SDR_HOST_LOGGING__PRETTY"] = "true"

		const result = parseEnvironmentVariables()

		expect(result["logging"]).toEqual({ pretty: true })
	})

	it("should ignore non-prefixed variables", () => {
		process.env["SOME_OTHER_VAR"] = "value"

		const result = parseEnvironmentVariables()

		expect(Object.keys(result)).not.toContain("someOtherVar")
	})
})
