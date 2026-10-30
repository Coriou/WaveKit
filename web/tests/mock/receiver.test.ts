import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { RTL_TUNER_GAIN_TABLES } from "@wavekit/api-types"
import type {
	ReceiverCapabilities,
	ReceiverCapabilitiesPage,
	TunerRelayStatus,
	TunerState,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import { receiverCapabilitiesSchema } from "../../src/data/receiver-api.ts"

describe("mock receiver controls", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	afterEach(() => {
		server.receiver.relayClient(false)
	})
	const inject = (
		method: "GET" | "POST" | "PATCH" | "PUT",
		url: string,
		payload?: unknown,
	) =>
		server.app.inject(
			payload === undefined
				? { method, url }
				: { method, url, payload: payload as Record<string, unknown> },
		)

	it("serves coherent R820T capabilities like the core's provider", async () => {
		const res = await inject("GET", "/api/receiver-capabilities/rtl-0")
		expect(res.statusCode).toBe(200)
		expect(res.headers["cache-control"]).toBe("no-store")
		const caps = res.json<ReceiverCapabilities>()
		expect(receiverCapabilitiesSchema.safeParse(caps).success).toBe(true)
		expect(caps.controls).toHaveLength(15)
		expect(caps.controls.every(c => c.transport.state === "applicable")).toBe(
			true,
		)
		expect(caps.controls.find(c => c.id === "gain")?.command).toMatchObject({
			opcode: 4,
			validation: { rule: { kind: "integer-range", min: 0, max: 500 } },
		})
		expect(caps.peerHeader).toMatchObject({
			state: "advertised",
			tunerType: 5,
			gainCount: 29,
			sessionId: caps.sessionId,
		})
		expect(caps.gainTable).toEqual({
			state: "suggested",
			provenance: "librtlsdr-tuner-gains",
			tuner: "R820T",
			valuesTenthsDb: RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb,
		})
		expect(caps.capturedAt).toHaveLength(24)
		expect(
			new Set([caps.sessionId, caps.snapshotId, caps.sourceIncarnation]).size,
		).toBe(3)
		expect(caps.delivery.sampleAgeMs).toBe(
			Date.parse(caps.capturedAt) -
				Date.parse(caps.delivery.lastSampleAt ?? ""),
		)

		const missing = await inject("GET", "/api/receiver-capabilities/nope")
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toEqual({
			error: "ReceiverCapabilitiesError",
			code: "RECEIVER_CAPABILITIES_NOT_FOUND",
			message: "Receiver source not found",
		})
		const page = (
			await inject("GET", "/api/receiver-capabilities")
		).json<ReceiverCapabilitiesPage>()
		expect(page.items.map(i => i.sourceId)).toEqual(["rtl-0"])
		expect(page.nextAfter).toBeNull()
		expect(
			(await inject("GET", "/api/receiver-capabilities?limit=99")).statusCode,
		).toBe(400)
	})

	it("serves the relay status, listening with nobody connected", async () => {
		const relay = (
			await inject("GET", "/api/tuner-relay")
		).json<TunerRelayStatus>()
		expect(relay).toMatchObject({
			enabled: true,
			listening: true,
			port: 1234,
			sourceId: "rtl-0",
			clientsConnected: 0,
			controlPolicy: "exclusive",
			rtlTcpHeader: { tunerType: 5, gainCount: 29 },
		})
		expect(relay.controlClientRemote).toBeUndefined()
	})

	it("applies each setting route and answers the new TunerState", async () => {
		const post = async (route: string, body: unknown) => {
			const res = await inject("POST", `/api/tuner/rtl-0/${route}`, body)
			expect(res.statusCode).toBe(200)
			return res.json<TunerState>()
		}
		expect((await post("gain-mode", { mode: "agc" })).gainMode).toBe("agc")
		expect((await post("gain-mode", { mode: "manual" })).gainMode).toBe(
			"manual",
		)
		expect((await post("gain", { gain: 254 })).gain).toBe(254)
		// the deprecated alias still works
		expect((await post("gain", { tenthsDb: 297 })).gain).toBe(297)
		expect((await post("agc", { enabled: true })).agcMode).toBe(true)
		expect((await post("agc", { enabled: false })).agcMode).toBe(false)
		expect((await post("ppm", { ppm: -12 })).ppm).toBe(-12)
		expect((await post("bias-tee", { enabled: true })).biasTee).toBe(true)
		expect((await post("direct-sampling", { mode: "q" })).directSampling).toBe(
			"q",
		)
		expect((await post("offset-tuning", { enabled: true })).offsetTuning).toBe(
			true,
		)
		const patched = await inject("PATCH", "/api/tuner/rtl-0/config", {
			gain: 297,
			ppm: 0,
			biasTee: false,
			directSampling: "off",
			offsetTuning: false,
		})
		expect(patched.statusCode).toBe(200)
		expect(patched.json<TunerState>()).toMatchObject({
			gain: 297,
			ppm: 0,
			biasTee: false,
			directSampling: "off",
			offsetTuning: false,
		})
	})

	it("validates like the core: codes, statuses and messages", async () => {
		const gain = await inject("POST", "/api/tuner/rtl-0/gain", {
			tenthsDb: 600,
		})
		expect(gain.statusCode).toBe(400)
		expect(gain.json()).toEqual({
			error: "TunerValidationError",
			code: "TUNER_VALIDATION_ERROR",
			message: "gain out of range: 600 (expected 0-500)",
		})
		const gap = await inject("POST", "/api/tuner/rtl-0/sample-rate", {
			hz: 600_000,
		})
		expect(gap.statusCode).toBe(400)
		expect(gap.json<{ message: string }>().message).toBe(
			"sampleRate 600000 is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)",
		)
		const ppm = await inject("POST", "/api/tuner/rtl-0/ppm", { ppm: 501 })
		expect(ppm.json<{ code: string }>().code).toBe("TUNER_VALIDATION_ERROR")
		const shape = await inject("POST", "/api/tuner/rtl-0/agc", {
			enabled: "yes",
		})
		expect(shape.statusCode).toBe(400)
		expect(shape.json<{ code: string }>().code).toBe("VALIDATION_ERROR")
		const extra = await inject("PATCH", "/api/tuner/rtl-0/config", {
			sourceId: "x",
		})
		// Fastify's default AJV (core and mock) strips unknown keys instead of refusing them
		expect(extra.statusCode).toBe(200)
		const unknown = await inject("POST", "/api/tuner/nope/gain", {
			tenthsDb: 100,
		})
		expect(unknown.statusCode).toBe(404)
		expect(unknown.json<{ code: string }>().code).toBe("TUNER_SOURCE_NOT_FOUND")
	})

	it("takes gain or its deprecated alias, never two different values", async () => {
		const both = await inject("POST", "/api/tuner/rtl-0/gain", {
			gain: 300,
			tenthsDb: 310,
		})
		expect(both.statusCode).toBe(400)
		expect(both.json<{ message: string }>().message).toMatch(
			/^Invalid request body; expected \{"gain": integer/,
		)
	})

	it("serves the per-band gain table and replaces it on PUT, with the core's rules", async () => {
		const first = await inject("GET", "/api/tuner-band-gain")
		expect(first.json()).toMatchObject({
			provenance: "config",
			settings: { applyToMyTuning: false },
			limits: { maxEntries: 32, maxGainTenthsDb: 500, labelMaxLength: 48 },
		})
		expect(
			first.json<{ settings: { entries: unknown[] } }>().settings.entries,
		).toContainEqual({
			minHz: 863_000_000,
			maxHz: 870_000_000,
			gain: 372,
			label: "868 MHz ISM",
		})
		const body = {
			applyToMyTuning: true,
			entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 }],
		}
		const put = await inject("PUT", "/api/tuner-band-gain", body)
		expect(put.statusCode).toBe(200)
		expect(put.json()).toMatchObject({ provenance: "runtime", settings: body })
		const overlap = await inject("PUT", "/api/tuner-band-gain", {
			applyToMyTuning: false,
			entries: [
				{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
				{ minHz: 870_000_000, maxHz: 880_000_000, gain: "keep" },
			],
		})
		expect(overlap.statusCode).toBe(400)
		expect(overlap.json()).toMatchObject({
			error: "BandGainSettingsError",
			code: "BAND_GAIN_INVALID",
		})
		for (const entry of [
			{ minHz: 863_000_000, maxHz: 863_000_000, gain: 297 },
			{ minHz: 863_000_000, maxHz: 870_000_000, gain: 501 },
			{ minHz: 20_000_000, maxHz: 30_000_000, gain: 297 },
			{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297, label: "" },
		]) {
			const res = await inject("PUT", "/api/tuner-band-gain", {
				applyToMyTuning: false,
				entries: [entry],
			})
			expect(res.statusCode, JSON.stringify(entry)).toBe(400)
		}
		const kept = await inject("GET", "/api/tuner-band-gain")
		expect(kept.json()).toMatchObject({ settings: body })
	})

	it("applies the band gain on an operator retune with the switch on, as the core does", async () => {
		const own = await buildMockServer({ port: 0 })
		await own.app.ready()
		try {
			const call = (
				method: "GET" | "POST" | "PATCH" | "PUT",
				url: string,
				payload?: unknown,
			) =>
				own.app.inject(
					payload === undefined
						? { method, url }
						: { method, url, payload: payload as Record<string, unknown> },
				)
			const state = async () =>
				(await call("GET", "/api/tuner/rtl-0")).json<TunerState>()
			await call("POST", "/api/tuner/rtl-0/gain-mode", { mode: "manual" })
			await call("POST", "/api/tuner/rtl-0/gain", { gain: 496 })
			// switch off (the default): a retune into 868 MHz leaves the gain
			await call("POST", "/api/tuner/rtl-0/frequency", { hz: 868_300_000 })
			expect(await state()).toMatchObject({ gain: 496 })
			expect(await state()).not.toHaveProperty("bandGain")
			const table = {
				applyToMyTuning: true,
				entries: [
					{
						minHz: 863_000_000,
						maxHz: 870_000_000,
						gain: 400,
						label: "868 MHz ISM",
					},
					{ minHz: 902_000_000, maxHz: 928_000_000, gain: 372 },
				],
			}
			await call("PUT", "/api/tuner-band-gain", table)
			// switched on, not retuned yet: nothing applied, nothing reported
			expect(await state()).not.toHaveProperty("bandGain")
			const res = await call("POST", "/api/tuner/rtl-0/frequency", {
				hz: 868_400_000,
			})
			// 40.0 dB snaps to the R820T's 40.2 dB; the frequency answer carries it
			expect(res.json<TunerState>()).toMatchObject({
				gainMode: "manual",
				gain: 402,
				bandGain: { tenthsDb: 402, label: "868 MHz ISM", owner: "user" },
			})
			await call("PATCH", "/api/tuner/rtl-0/config", { frequency: 915_000_000 })
			expect((await state()).bandGain).toEqual({ tenthsDb: 372, owner: "user" })
			// out of the bands: the operator's own gain comes back, no band gain reported
			await call("POST", "/api/tuner/rtl-0/frequency", { hz: 455_500_000 })
			expect(await state()).toMatchObject({ gain: 496 })
			expect(await state()).not.toHaveProperty("bandGain")
			// back in, then the operator's own gain write or AGC drops it
			await call("POST", "/api/tuner/rtl-0/frequency", { hz: 868_400_000 })
			expect((await state()).bandGain?.tenthsDb).toBe(402)
			await call("POST", "/api/tuner/rtl-0/gain", { gain: 402 })
			expect(await state()).not.toHaveProperty("bandGain")
			await call("POST", "/api/tuner/rtl-0/frequency", { hz: 915_000_000 })
			expect((await state()).bandGain?.tenthsDb).toBe(372)
			await call("POST", "/api/tuner/rtl-0/gain-mode", { mode: "agc" })
			expect(await state()).not.toHaveProperty("bandGain")
		} finally {
			await own.close()
		}
	})

	it("refuses commands with 409 while a relay client has the tuner, until control is reclaimed", async () => {
		server.receiver.relayClient(true)
		const relay = (
			await inject("GET", "/api/tuner-relay")
		).json<TunerRelayStatus>()
		expect(relay.controlClientRemote).toBe("192.168.1.23:51544")
		expect(
			(await inject("GET", "/api/tuner/rtl-0")).json<TunerState>().controlMode,
		).toBe("external")
		const refused = await inject("POST", "/api/tuner/rtl-0/bias-tee", {
			enabled: true,
		})
		expect(refused.statusCode).toBe(409)
		expect(refused.json()).toEqual({
			error: "TunerControlModeError",
			code: "TUNER_CONTROL_EXTERNAL",
			message:
				"Cannot send commands: control released to external tuner for rtl-0",
		})
		const reclaimed = await inject("POST", "/api/tuner/rtl-0/control-mode", {
			mode: "internal",
		})
		expect(reclaimed.json<TunerState>().controlMode).toBe("internal")
		// a relay client leaving after a user reclaim does not change anything
		server.receiver.relayClient(false)
		expect(
			(await inject("GET", "/api/tuner/rtl-0")).json<TunerState>().controlMode,
		).toBe("internal")
		// a relay client that took the tuner gives it back when it leaves
		server.receiver.relayClient(true)
		server.receiver.relayClient(false)
		expect(
			(await inject("GET", "/api/tuner/rtl-0")).json<TunerState>().controlMode,
		).toBe("internal")
	})

	it("emits command-sent then state-changed, and restarts the stream on a new rate", async () => {
		const { port } = await server.listen()
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
		const messages: { type: string; data: Record<string, unknown> }[] = []
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve())
			ws.once("error", reject)
		})
		ws.on("message", raw => {
			messages.push(JSON.parse(String(raw)) as (typeof messages)[number])
		})
		ws.send(
			JSON.stringify({
				type: "subscribe",
				channels: ["tuner", "spectrum"],
				options: { spectrum: { sourceId: "rtl-0", hz: 20, bins: 512 } },
			}),
		)
		const epochOf = async () => {
			await new Promise(resolve => setTimeout(resolve, 150))
			const frames = messages.filter(m => m.type === "spectrum:frame")
			return frames.at(-1)?.data["epoch"]
		}
		const before = await epochOf()
		const capsBefore = server.receiver.capabilities()
		await inject("POST", "/api/tuner/rtl-0/sample-rate", { hz: 2_048_000 })
		await new Promise(resolve => setTimeout(resolve, 50))
		const tuner = messages.filter(m => m.type.startsWith("tuner:"))
		expect(tuner.map(m => m.type).slice(-2)).toEqual([
			"tuner:command-sent",
			"tuner:state-changed",
		])
		expect(tuner.at(-2)?.data).toEqual({
			sourceId: "rtl-0",
			command: "set-sample-rate",
			value: 2_048_000,
			origin: "rest",
		})
		expect((tuner.at(-1)?.data["state"] as TunerState).sampleRate).toBe(
			2_048_000,
		)
		const after = await epochOf()
		expect(typeof before).toBe("number")
		expect(after).toBe(Number(before) + 1)
		const capsAfter = server.receiver.capabilities()
		expect(capsAfter.declaredStream.sampleRateHz).toBe(2_048_000)
		expect(capsAfter.sessionId).not.toBe(capsBefore.sessionId)

		server.receiver.relayClient(true)
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(messages.some(m => m.type === "tuner:control-mode-changed")).toBe(
			true,
		)
		await inject("POST", "/api/tuner/rtl-0/control-mode", { mode: "internal" })
		await inject("POST", "/api/tuner/rtl-0/sample-rate", { hz: 2_400_000 })
		ws.close()
	})
})
