import type { SpectrumFrameEventData } from "@wavekit/api-types"

export function frame(
	over: Partial<SpectrumFrameEventData> & { bytes?: number[] },
): SpectrumFrameEventData {
	const { bytes, ...rest } = over
	const data = Uint8Array.from(bytes ?? [10, 20, 30, 40])
	return {
		sourceId: "rtl",
		profile: "25:2048",
		epoch: 1,
		tuningTrust: "commanded",
		centerHz: 446_000_000,
		sampleRateHz: 2_048_000,
		binHz: 1000,
		nativeBinHz: 1000,
		startHz: 445_000_000,
		binCount: data.length,
		bins: Buffer.from(data).toString("base64"),
		binEncoding: "u8-halfdb-127.5",
		floorDbfs: -92.5,
		thresholdDb: 9.2,
		tracks: [],
		masks: { dcHz: 446_000_000, dcGuardHz: 1500, spurRanges: [] },
		at: "2026-10-16T12:00:00.000Z",
		...rest,
	}
}

export function frameJson(over: Record<string, unknown>): string {
	return JSON.stringify({
		type: "spectrum:frame",
		channel: "spectrum",
		data: { ...frame({}), ...over },
	})
}
