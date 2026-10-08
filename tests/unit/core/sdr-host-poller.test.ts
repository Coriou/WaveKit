import { describe, expect, it, vi } from "vitest"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import type { SdrHostStatus } from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

async function pollResponse(payload: unknown): Promise<SdrHostStatus> {
	const fetchFn = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
	const poller = new SdrHostPoller(
		logger,
		[{ sourceId: "local-iq", apiUrl: "http://localhost:8080" }],
		{ fetchFn },
	)
	try {
		const status = new Promise<SdrHostStatus>((resolve, reject) => {
			poller.once("status", resolve)
			poller.once("error", (_sourceId, error) => reject(error))
		})
		poller.start()
		const result = await status
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:8080/api/status",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		return result
	} finally {
		poller.stop()
	}
}

describe("SdrHostPoller API compatibility", () => {
	it("reports dongle presence from the actual SDR host status response", async () => {
		const status = await pollResponse({
			uptime: 120,
			dongle: {
				present: true,
				vendor: "Realtek Semiconductor Corp.",
				product: "RTL2838 DVB-T",
				serial: "00000001",
				driverConflict: false,
			},
			rtlTcp: {
				running: true,
				pid: 42,
				config: {
					sampleRate: 2400000,
					frequency: 100000000,
					gain: 0,
					agc: true,
				},
			},
			rtlmux: {
				running: true,
				stats: { clients: 1, bytesPerSec: 4800000, totalBytesSent: 9600000 },
			},
			warnings: [],
			errors: [],
		})
		expect(status.available).toBe(true)
		expect(status.dongle).toEqual({
			found: true,
			vendor: "Realtek Semiconductor Corp.",
			product: "RTL2838 DVB-T",
			serial: "00000001",
		})
		expect(status.rtlmux?.totalBytesSent).toBe(9600000)
	})

	it("prefers present=false over an older found field", async () => {
		const status = await pollResponse({
			dongle: { present: false, found: true },
		})
		expect(status.dongle?.found).toBe(false)
	})

	it("continues accepting the legacy dongle found field", async () => {
		const status = await pollResponse({ dongle: { found: true } })
		expect(status.dongle?.found).toBe(true)
	})

	it("sums raw rtlmux client IQ output instead of upstream command traffic", async () => {
		const status = await pollResponse({
			rtlmux: {
				running: true,
				stats: {
					server: { dataIn: 5000000, dataOut: 15 },
					clients: [
						{
							client: { host: "192.168.1.2", port: 50000 },
							dataOut: 2000000,
							dropped: { size: 1000 },
						},
						{
							client: { host: "192.168.1.3", port: 50001 },
							dataOut: 3000000,
							dropped: { size: 2000 },
						},
						{ client: { host: "192.168.1.4", port: 50002 } },
					],
				},
			},
		})
		expect(status.rtlmux?.clients).toBe(3)
		expect(status.rtlmux?.totalBytesSent).toBe(5000000)
		expect(status.rtlmux?.clientDetails).toEqual([
			{ id: 0, address: "192.168.1.2", bytesDropped: 1000 },
			{ id: 1, address: "192.168.1.3", bytesDropped: 2000 },
			{ id: 2, address: "192.168.1.4", bytesDropped: 0 },
		])
	})
})
