/**
 * WG2 frozen contract (docs/specs/web-gaps-2, design "Contract"). Copied core declarations
 * must stay identical to the shared DTOs; the device schemas accept pre-WG2 and WG2 rows.
 * Same is stricter than mutual assignability: an optional key added or dropped on one side
 * makes it false, so typecheck fails the build.
 */
import { describe, expect, it } from "vitest"
import {
	ACCESS_DEVICE_KINDS,
	accessDeviceDtoSchema,
	accessDeviceLabelRequestSchema,
} from "@wavekit/api-types"
import type * as Api from "@wavekit/api-types"
import type * as Contract from "../../../src/core/activity/storage/contract.js"
import type * as DigitalVoice from "../../../src/core/digital-voice.js"
import type * as CoreScanner from "../../../src/core/scanner/types.js"
import type { DsdFmeVoiceCallState } from "../../../src/decoders/builtin/dsd-fme.js"
import type {
	ServerMessage,
	WebSocketChannel,
} from "../../../src/api/websocket/events.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false

const payloadSame: Same<
	Contract.AnalogTransmissionPayload,
	Api.AnalogTransmissionPayload
> = true
const toneSame: Same<
	NonNullable<Api.AnalogTransmissionPayload["tone"]>,
	Api.AnalogTransmissionTone
> = true
const eventToneSame: Same<
	NonNullable<Api.AnalogTransmissionEventData["tone"]>,
	Api.AnalogTransmissionTone
> = true
const callSame: Same<DigitalVoice.DigitalVoiceCall, Api.DigitalVoiceCall> = true
type CallMetadata = Pick<
	Api.DigitalVoiceCall,
	"colourCode" | "nac" | "algorithmId" | "keyId" | "ran" | "errors"
>
const stateMetadataSame: Same<
	Pick<
		DsdFmeVoiceCallState,
		"colourCode" | "nac" | "algorithmId" | "keyId" | "ran" | "errors"
	>,
	CallMetadata
> = true
const lockoutSame: Same<Api.LockoutExclusion, CoreScanner.LockoutExclusion> =
	true
const aprsChannel: Extract<WebSocketChannel, "aprs" | "mesh"> = "aprs"
const aprsMessage: Extract<ServerMessage, { type: "aprs:lost" }>["data"] = {
	key: "callsign:N0CALL-9",
	station: {} as Api.AprsStation,
}
const meshMessage: Extract<ServerMessage, { type: "mesh:lost" }>["data"] = {
	nodeId: "!a1b2c3d4",
	node: {} as Api.MeshNode,
}

const DEVICE_ID = `device_${"A".repeat(42)}A`
const base = {
	deviceId: DEVICE_ID,
	createdAt: 1_000,
	renewedAt: 2_000,
	expiresAt: 3_000,
	current: true,
}

describe("WG2 contract", () => {
	it("keeps the copied declarations identical", () => {
		expect([
			payloadSame,
			toneSame,
			eventToneSame,
			callSame,
			stateMetadataSame,
			lockoutSame,
		]).toEqual([true, true, true, true, true, true])
		expect(aprsChannel).toBe("aprs")
		expect(aprsMessage.key).toBe("callsign:N0CALL-9")
		expect(meshMessage.nodeId).toBe("!a1b2c3d4")
	})

	it("accepts pre-WG2 and WG2 device rows", () => {
		expect(accessDeviceDtoSchema.safeParse(base).success).toBe(true)
		expect(
			accessDeviceDtoSchema.safeParse({
				...base,
				name: "Kitchen tablet",
				kind: "tablet",
				lastSeenAt: 7_200_000,
			}).success,
		).toBe(true)
		expect(
			accessDeviceDtoSchema.safeParse({
				...base,
				name: null,
				kind: null,
				lastSeenAt: null,
			}).success,
		).toBe(true)
	})

	it("rejects invalid device names, kinds and last-seen clocks", () => {
		for (const extra of [
			{ name: "" },
			{ name: " padded" },
			{ name: "x".repeat(65) },
			{ name: "bad\u0007bell" },
			{ name: "rtl\u202eoverride" },
			{ kind: "toaster" },
			{ lastSeenAt: 7_200_001 },
		])
			expect(
				accessDeviceDtoSchema.safeParse({ ...base, ...extra }).success,
			).toBe(false)
		expect(ACCESS_DEVICE_KINDS).toContain("browser")
	})

	it("parses the label request", () => {
		expect(
			accessDeviceLabelRequestSchema.safeParse({
				deviceId: DEVICE_ID,
				name: "Laptop",
			}).success,
		).toBe(true)
		expect(
			accessDeviceLabelRequestSchema.safeParse({
				deviceId: DEVICE_ID,
				kind: null,
			}).success,
		).toBe(true)
		expect(
			accessDeviceLabelRequestSchema.safeParse({ deviceId: DEVICE_ID }).success,
		).toBe(false)
		expect(
			accessDeviceLabelRequestSchema.safeParse({
				deviceId: DEVICE_ID,
				name: "x",
				extra: 1,
			}).success,
		).toBe(false)
	})
})
