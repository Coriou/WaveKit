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

function usbSnapshot(device: number | null) {
	return {
		ready: device !== null,
		dongle: {
			present: device !== null,
			product: null,
			serial: null,
			usb:
				device === null ? null : { vid: "0bda", pid: "2838", bus: 1, device },
			driverConflict: false,
			conflictingDriver: null,
		},
		warnings: [] as string[],
		errors: [] as string[],
	}
}

it("recovers on removal, insertion and rapid USB re-enumeration, not unchanged polls", async () => {
	vi.useFakeTimers()
	const { startPreflightMonitoring } =
		await import("../../src/supervisor/preflight.js")
	const result = usbSnapshot(4)
	let current = usbSnapshot(4)
	const recover = vi.fn(async () => {})
	const stop = startPreflightMonitoring(result, logger, {
		intervalMs: 100,
		refresh: async () => current,
		onDeviceChange: recover,
	})
	try {
		await vi.advanceTimersByTimeAsync(200)
		expect(recover).not.toHaveBeenCalled()
		current = usbSnapshot(null)
		await vi.advanceTimersByTimeAsync(200)
		expect(recover).toHaveBeenCalledTimes(1)
		current = usbSnapshot(5)
		await vi.advanceTimersByTimeAsync(200)
		expect(recover).toHaveBeenCalledTimes(2)
		current = usbSnapshot(6)
		await vi.advanceTimersByTimeAsync(200)
		expect(recover).toHaveBeenCalledTimes(3)
		current = { ...current, warnings: ["diagnostic changed"] }
		await vi.advanceTimersByTimeAsync(200)
		expect(recover).toHaveBeenCalledTimes(3)
	} finally {
		await stop()
		vi.useRealTimers()
	}
})

it("serializes recovery, waits on shutdown and retries failed recovery", async () => {
	vi.useFakeTimers()
	const { startPreflightMonitoring } =
		await import("../../src/supervisor/preflight.js")
	let finish!: () => void
	const recover = vi
		.fn()
		.mockRejectedValueOnce(new Error("s6 unavailable"))
		.mockImplementationOnce(
			() =>
				new Promise<void>(resolve => {
					finish = resolve
				}),
		)
	const refresh = vi.fn(async () => usbSnapshot(5))
	const stop = startPreflightMonitoring(usbSnapshot(4), logger, {
		intervalMs: 100,
		refresh,
		onDeviceChange: recover,
	})
	try {
		await vi.advanceTimersByTimeAsync(500)
		expect(recover).toHaveBeenCalledTimes(2)
		expect(refresh).toHaveBeenCalledTimes(2)
		let stopped = false
		const stopping = stop().then(() => {
			stopped = true
		})
		await Promise.resolve()
		expect(stopped).toBe(false)
		finish()
		await stopping
		await vi.advanceTimersByTimeAsync(500)
		expect(recover).toHaveBeenCalledTimes(2)
	} finally {
		await stop()
		vi.useRealTimers()
	}
})
