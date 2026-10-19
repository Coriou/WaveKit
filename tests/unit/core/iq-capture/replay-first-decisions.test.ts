/**
 * Seam decisions that scanner-service cannot run against this commit's store:
 * capture state keeps its receiver, the first gate pass materializes once,
 * and a capture removed before its replay settles falls back to live confirm.
 */
import { describe, expect, it } from "vitest"
import {
	captureRemovedRelease,
	captureServiceIsOn,
	gatePassCapture,
	needsLiveConfirm,
	replayConfirmInput,
	type GatePassCaptureInput,
} from "../../../../src/core/iq-capture/replay-first.js"

const idle: GatePassCaptureInput = {
	synthetic: false,
	late: false,
	closing: false,
	gate: "pending",
	hasDiscovery: false,
	ingestedThisSnapshot: false,
	everIngested: false,
	alreadyRequested: false,
}

describe("captureServiceIsOn", () => {
	it("calls state on the port so a class method keeps its receiver", () => {
		class CapturePort {
			constructor(private readonly st: "on" | "off" | "idle") {}
			state(): "on" | "off" | "idle" {
				return this.st
			}
		}
		const on = new CapturePort("on")
		expect(captureServiceIsOn(on)).toBe(true)
		expect(captureServiceIsOn(new CapturePort("off"))).toBe(false)
		expect(captureServiceIsOn(new CapturePort("idle"))).toBe(false)
		// The bug: reading `state` off the port and calling it has no receiver.
		const detached = on.state
		expect(() => detached()).toThrow()
	})

	it("a throw, a missing method, or no port is off", () => {
		class Boom {
			state(): string {
				throw new Error("state failed")
			}
		}
		const errors: unknown[] = []
		expect(
			captureServiceIsOn(new Boom(), err => {
				errors.push(err)
			}),
		).toBe(false)
		expect(errors).toHaveLength(1)
		expect(
			captureServiceIsOn(new Boom(), () => {
				throw new Error("log failed")
			}),
		).toBe(false)
		expect(captureServiceIsOn(undefined)).toBe(false)
		expect(captureServiceIsOn(null)).toBe(false)
		expect(captureServiceIsOn({})).toBe(false)
	})
})

describe("gatePassCapture", () => {
	it("a short transmission materializes once at the first gate pass, then requests once", () => {
		// open 0 ms: the gate has not passed, and the one-second throttle has not ingested
		expect(gatePassCapture(idle)).toEqual({
			materialize: false,
			request: false,
		})
		// gate pass 300 ms: discovery still null, throttle still closed
		expect(
			gatePassCapture({
				...idle,
				gate: "passed",
			}),
		).toEqual({ materialize: true, request: true })
		// the request was accepted; a later pass does not ask again
		expect(
			gatePassCapture({
				...idle,
				gate: "passed",
				hasDiscovery: true,
				everIngested: true,
				alreadyRequested: true,
			}),
		).toEqual({ materialize: false, request: false })
		// close 600 ms
		expect(
			gatePassCapture({
				...idle,
				closing: true,
				gate: "passed",
				hasDiscovery: true,
				ingestedThisSnapshot: true,
				everIngested: true,
				alreadyRequested: true,
			}),
		).toEqual({ materialize: false, request: false })
	})

	it("does not ingest twice when the throttle already ran, and does not request twice", () => {
		expect(
			gatePassCapture({
				...idle,
				gate: "passed",
				hasDiscovery: true,
				ingestedThisSnapshot: true,
				everIngested: true,
			}),
		).toEqual({ materialize: false, request: true })
		expect(
			gatePassCapture({
				...idle,
				gate: "passed",
				hasDiscovery: false,
				ingestedThisSnapshot: true,
				everIngested: true,
			}),
		).toEqual({ materialize: false, request: true })
		expect(
			gatePassCapture({
				...idle,
				gate: "passed",
				hasDiscovery: true,
				everIngested: true,
				alreadyRequested: true,
			}),
		).toEqual({ materialize: false, request: false })
	})

	it("a bypass already used is not repeated while the discovery is still missing", () => {
		expect(
			gatePassCapture({
				...idle,
				gate: "passed",
				everIngested: true,
			}),
		).toEqual({ materialize: false, request: true })
	})

	it("synthetic, late, closing and not-passed gates do not ask", () => {
		for (const patch of [
			{ synthetic: true, gate: "passed" as const },
			{ late: true, gate: "passed" as const },
			{ closing: true, gate: "passed" as const },
			{ gate: "below" as const },
			{ gate: undefined },
		]) {
			expect(gatePassCapture({ ...idle, ...patch })).toEqual({
				materialize: false,
				request: false,
			})
		}
	})
})

describe("captureRemovedRelease", () => {
	const pending = [{ observationId: "obs-1", captureId: "cap-1" }]

	it("an unsettled removal clears pending so live confirm sees capture not running", () => {
		const release = captureRemovedRelease({
			removedCaptureId: "cap-1",
			removedObservationId: "obs-1",
			pending,
			settledObservationIds: new Set(),
		})
		expect(release).toBe("obs-1")
		const stranded = replayConfirmInput({
			serviceOn: true,
			refused: false,
			pendingCapture: true,
			replaySettled: false,
			replayDecoded: false,
			acceptedIdentity: false,
			gate: "passed",
			trackOpen: true,
			discoveryDecoded: false,
			emitterOnAir: true,
		})
		expect(stranded.captureRunning).toBe(true)
		expect(stranded.capturePending).toBe(true)
		expect(needsLiveConfirm(stranded)).toBe(false)
		const cleared = replayConfirmInput({
			serviceOn: true,
			refused: true,
			pendingCapture: false,
			replaySettled: false,
			replayDecoded: false,
			acceptedIdentity: false,
			gate: "passed",
			trackOpen: true,
			discoveryDecoded: false,
			emitterOnAir: true,
		})
		expect(cleared.captureRunning).toBe(false)
		expect(cleared.capturePending).toBe(false)
		expect(needsLiveConfirm(cleared)).toBe(true)
	})

	it("matches a removal that carries no observation id, and ignores a different capture", () => {
		expect(
			captureRemovedRelease({
				removedCaptureId: "cap-1",
				removedObservationId: null,
				pending,
				settledObservationIds: new Set(),
			}),
		).toBe("obs-1")
		expect(
			captureRemovedRelease({
				removedCaptureId: "other",
				removedObservationId: "obs-1",
				pending,
				settledObservationIds: new Set(),
			}),
		).toBeNull()
		expect(
			captureRemovedRelease({
				removedCaptureId: "cap-1",
				removedObservationId: "obs-2",
				pending,
				settledObservationIds: new Set(),
			}),
		).toBeNull()
	})

	it("a removal after the replay settled does not clear the pending capture", () => {
		expect(
			captureRemovedRelease({
				removedCaptureId: "cap-1",
				removedObservationId: "obs-1",
				pending,
				settledObservationIds: new Set(["obs-1"]),
			}),
		).toBeNull()
	})
})
