import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createLogger } from "@wavekit/shared"

const detectDongleMock = vi.fn()

vi.mock("../../src/utils/usb-dongle.js", () => ({
	detectDongle: detectDongleMock,
}))

const logger = createLogger({ level: "fatal" })

describe("runPreflight", () => {
	afterEach(() => {
		vi.useRealTimers()
	})
	beforeEach(() => {
		detectDongleMock.mockReset()
	})
	it("marks readiness false when no dongle is detected", async () => {
		detectDongleMock.mockResolvedValueOnce({
			present: false,
			product: null,
			serial: null,
			usb: null,
			driverConflict: false,
			conflictingDriver: null,
		})

		const { runPreflight } = await import("../../src/supervisor/preflight.js")
		const result = await runPreflight(logger)

		expect(result.ready).toBe(false)
		expect(result.errors.length).toBe(1)
		expect(result.warnings.length).toBe(0)
	})

	it("adds warning when driver conflict detected", async () => {
		detectDongleMock.mockResolvedValueOnce({
			present: true,
			product: "RTL2838UHIDIR",
			serial: null,
			usb: { vid: "0bda", pid: "2838", bus: 1, device: 4 },
			driverConflict: true,
			conflictingDriver: "dvb_usb_rtl28xxu",
		})

		const { runPreflight } = await import("../../src/supervisor/preflight.js")
		const result = await runPreflight(logger)

		expect(result.ready).toBe(true)
		expect(result.warnings.length).toBe(1)
	})
})

it("prevents overlapping USB checks and discards results after shutdown", async () => {
	vi.useFakeTimers()
	const { startPreflightMonitoring } =
		await import("../../src/supervisor/preflight.js")
	const result = {
		ready: false,
		dongle: {
			present: false,
			product: null,
			serial: null,
			usb: null,
			driverConflict: false,
			conflictingDriver: null,
		},
		warnings: [],
		errors: ["Missing dongle"],
	}
	let complete!: (value: typeof result) => void
	const refresh = vi.fn(
		() =>
			new Promise<typeof result>(resolve => {
				complete = resolve
			}),
	)
	const stop = startPreflightMonitoring(result, logger, {
		intervalMs: 1000,
		refresh,
	})
	try {
		await vi.advanceTimersByTimeAsync(4000)
		expect(refresh).toHaveBeenCalledOnce()
		const stopped = stop()
		complete({ ...result, ready: true, errors: [] })
		await stopped
		await vi.advanceTimersByTimeAsync(4000)
		expect(refresh).toHaveBeenCalledOnce()
		expect(result.ready).toBe(false)
	} finally {
		await stop()
		vi.useRealTimers()
	}
})
