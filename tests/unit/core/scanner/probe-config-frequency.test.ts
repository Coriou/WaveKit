import { describe, expect, it } from "vitest"
import { resolveProvenance } from "../../../../src/core/activity/provenance/resolve.js"
import {
	buildProbeConfig,
	offsetTransport,
	type ProbeMode,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createChannelTransport } from "../../../../src/core/scanner/probes/channel-transport.js"
import { resolveDecoderTargetFrequencies } from "../../../../src/decoders/status-fields.js"
import {
	FakeEngineView,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

// a probe's Activity rows carry its channel frequency.

const CENTRE_HZ = 446_000_000
const mode: ProbeMode = {
	decoderType: "multimon-ng",
	protocol: "pocsag",
	covers: ["pocsag"],
	options: {},
	holdMs: 4000,
}

function config(targetHz: number, transport = offsetTransport) {
	const req = probeRequest({ targetHz })
	return buildProbeConfig({
		probeId: "scan-p1",
		req,
		mode,
		transport,
		ctx: {
			req,
			epoch: new FakeEngineView({
				centreHz: CENTRE_HZ,
				sampleRateHz: 2_048_000,
			}).epoch,
			format: "U8_IQ",
			sampleRateHz: 2_048_000,
		},
		recordDir: null,
		ports: null,
	})
}

describe("probe config target frequency", () => {
	it("declares the probe channel as its single target, for both live transports", () => {
		const offset = config(446_206_250)
		expect(offset.frequencies).toEqual([446_206_250])
		expect(resolveDecoderTargetFrequencies(offset)).toEqual([446_206_250])
		const channel = config(
			446_206_250,
			createChannelTransport({ available: () => true, usableFraction: 0.8 }),
		)
		expect(channel.frequencies).toEqual([446_206_250])
	})

	it("declares nothing for a non-finite or non-positive target", () => {
		expect(config(Number.NaN).frequencies).toBeUndefined()
		expect(config(0).frequencies).toBeUndefined()
	})

	it("so the probe's Activity row resolves to that frequency", () => {
		const cfg = config(446_206_250)
		const targets = resolveDecoderTargetFrequencies(cfg) ?? []
		expect(
			resolveProvenance(
				{
					timestamp: new Date(0),
					decoder: "scan-p1",
					type: "message",
					data: { address: 8 },
				},
				{
					sourceId: "rtl",
					targetFrequenciesHz: targets,
					tuningTrust: "commanded",
				},
			),
		).toEqual({
			sourceId: "rtl",
			frequency: {
				hz: 446_206_250,
				basis: "channel",
				tuningTrust: "commanded",
			},
		})
	})
})
