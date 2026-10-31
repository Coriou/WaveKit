/**
 * WG9 frozen contract (docs/specs/web-gaps-9, task 0.1): the pairing and session DTOs a web app
 * on another port of the API hostname uses, the preflight cache bound; the recording Keep and
 * delete DTOs, bounds, error statuses, keep keys and the protection port; the identify
 * `decoder-unavailable` reason; the unchanged tuning trust vocabulary. No behaviour beyond
 * defaults.
 */
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import {
	ACCESS_CSRF_HEADER,
	ACCESS_DEVICES_LIMITS,
	ACCESS_PAIR_ROUTE,
	ACCESS_PAIRING_CODE,
	ACCESS_PAIRING_CODES_ROUTE,
	ACCESS_PREFLIGHT_MAX_AGE_SECONDS,
	ACCESS_SESSION_COOKIE_NAME,
	ACCESS_SESSION_LOGOUT_ROUTE,
	ACCESS_SESSION_REFRESH_ROUTE,
	ACCESS_SESSION_ROUTE,
	RECORDING_DELETE_ROUTE,
	RECORDING_ERROR_STATUS,
	RECORDING_INVENTORY_ID,
	RECORDING_KEEP_ROUTE,
	RECORDING_KEEPS_FILE_MAX_BYTES,
	RECORDING_KEEPS_FILE_NAME,
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
	RECORDING_KEEPS_REQUIRES_ACCESS,
	RECORDINGS_REQUIRES_ACCESS,
	RECORDINGS_SCAN_MAX_FILES,
	SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
	accessPairRequestSchema,
	accessSessionDtoSchema,
} from "@wavekit/api-types"
import { CSRF_HEADER } from "../../../src/access/policy.js"
import type { AccessDenialCode } from "../../../src/access/types.js"
import {
	RECORDING_KEEP_KEY,
	RecordingKeepError,
	dsdFmeKeepKey,
	recordingKeepKeyOf,
	scannerKeepKey,
	type RecordingKeepService,
	type RecordingProtection,
} from "../../../src/core/recordings/contract.js"
import { STATION_STORE_FILE } from "../../../src/core/station/contract.js"
import { DECODER_SETTINGS_FILE_NAME } from "@wavekit/api-types"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value
type Extends<A, B> = [A] extends [B] ? true : false
const extendsType = <A, B>(value: Extends<A, B>): Extends<A, B> => value

const DSD_NAME = "20261017_081500_12345_DMR_GROUP_TGT_9_SRC_1234.wav"
const DEVICE_ID = `device_${"A".repeat(43)}`
const CSRF = "B".repeat(43)

describe("WG9 contract", () => {
	it("freezes the pairing routes, cookie name, CSRF header and preflight cache bound", () => {
		expect(ACCESS_PAIR_ROUTE).toBe("/api/access/pair")
		expect(ACCESS_SESSION_ROUTE).toBe("/api/access/session")
		expect(ACCESS_SESSION_REFRESH_ROUTE).toBe("/api/access/session/refresh")
		expect(ACCESS_SESSION_LOGOUT_ROUTE).toBe("/api/access/session/logout")
		expect(ACCESS_PAIRING_CODES_ROUTE).toBe("/api/access/pairing-codes")
		expect(ACCESS_SESSION_COOKIE_NAME).toBe("wavekit_session")
		expect(ACCESS_CSRF_HEADER).toBe(CSRF_HEADER)
		expect(ACCESS_PREFLIGHT_MAX_AGE_SECONDS).toBe(600)
		// Below the Chromium ceiling (7 200 s), so browsers honour it as sent.
		expect(ACCESS_PREFLIGHT_MAX_AGE_SECONDS).toBeLessThanOrEqual(7200)
	})

	it("freezes the pair request: code, optional name and kind by the label rules, strict", () => {
		expect(ACCESS_PAIRING_CODE.test("ABCDE-FGHJK")).toBe(true)
		expect(ACCESS_PAIRING_CODE.test("ABCDEFGHJK")).toBe(true)
		expect(ACCESS_PAIRING_CODE.test("ABCD-EFGHJK")).toBe(false)
		expect(
			accessPairRequestSchema.safeParse({ code: "ABCDE-FGHJK" }).success,
		).toBe(true)
		expect(
			accessPairRequestSchema.safeParse({
				code: "ABCDE-FGHJK",
				name: "Kitchen tablet",
				kind: "tablet",
			}).success,
		).toBe(true)
		const longest = "é".repeat(ACCESS_DEVICES_LIMITS.nameMaxBytes / 2)
		expect(
			accessPairRequestSchema.safeParse({ code: "ABCDE-FGHJK", name: longest })
				.success,
		).toBe(true)
		for (const bad of [
			{},
			{ code: "ABCDE-FGHJK", extra: 1 },
			{ code: "ABCDE-FGHJK", name: " padded" },
			{ code: "ABCDE-FGHJK", name: "" },
			{ code: "ABCDE-FGHJK", name: "x".repeat(65) },
			{ code: "ABCDE-FGHJK", name: "a‮b" },
			{ code: "ABCDE-FGHJK", name: null },
			{ code: "ABCDE-FGHJK", kind: "fridge" },
			{ code: "ABCDE-FGHJK-X" },
		])
			expect(accessPairRequestSchema.safeParse(bad).success).toBe(false)
	})

	it("freezes the session body (pair, session, refresh)", () => {
		const body = {
			deviceId: DEVICE_ID,
			expiresAt: 1_800_000_000_000,
			csrfToken: CSRF,
		}
		expect(accessSessionDtoSchema.parse(body)).toEqual(body)
		expect(
			accessSessionDtoSchema.safeParse({ ...body, token: "x" }).success,
		).toBe(false)
		expect(
			accessSessionDtoSchema.safeParse({ ...body, csrfToken: "short" }).success,
		).toBe(false)
		expect(same<Api.AccessLogoutResponse, { revoked: true }>(true)).toBe(true)
	})

	it("every access denial code is an AccessErrorCode", () => {
		expect(extendsType<AccessDenialCode, Api.AccessErrorCode>(true)).toBe(true)
	})

	it("freezes the Keep and delete routes, store file and bounds with their arithmetic", () => {
		expect(RECORDING_KEEPS_REQUIRES_ACCESS).toBe(true)
		expect(RECORDINGS_REQUIRES_ACCESS).toBe(true)
		expect(RECORDING_KEEP_ROUTE).toBe("/api/recordings/:id/keep")
		expect(RECORDING_DELETE_ROUTE).toBe("/api/recordings/:id")
		expect(RECORDING_KEEPS_FILE_NAME).toBe("recording-keeps.json")
		expect(RECORDING_KEEPS_FILE_NAME).not.toBe(DECODER_SETTINGS_FILE_NAME)
		expect(RECORDING_KEEPS_FILE_NAME).not.toBe(STATION_STORE_FILE)
		expect(RECORDING_KEEPS_MAX_ENTRIES).toBe(RECORDINGS_SCAN_MAX_FILES)
		expect(RECORDING_KEEPS_FILE_MAX_BYTES).toBe(1_048_576)
		expect(RECORDING_KEEPS_MAX_BYTES).toBe(512 * 1024 * 1024)
		// The longest key (dsd~ + a 226-character call name, or a scanner id) plus keptAt and
		// bytes stays under 330 bytes of JSON, so the entry bound fits in the file bound.
		const longestKey = `dsd~20261017_081500_12345_${"x".repeat(200)}.wav`
		expect(RECORDING_KEEP_KEY.test(longestKey)).toBe(true)
		const entry = JSON.stringify({
			key: longestKey,
			keptAt: "2026-10-17T08:15:00.000Z",
			bytes: Number.MAX_SAFE_INTEGER,
		})
		expect(entry.length + 2).toBeLessThan(330)
		expect(RECORDING_KEEPS_MAX_ENTRIES * 330).toBeLessThan(
			RECORDING_KEEPS_FILE_MAX_BYTES,
		)
	})

	it("freezes the error statuses", () => {
		expect({ ...RECORDING_ERROR_STATUS }).toEqual({
			RECORDINGS_QUERY_INVALID: 400,
			RECORDING_NOT_FOUND: 404,
			RECORDINGS_UNAVAILABLE: 503,
			RECORDING_KEPT: 409,
			RECORDING_BUSY: 409,
			RECORDING_KEEP_LIMIT: 409,
			RECORDING_DELETE_UNSUPPORTED: 409,
			RECORDING_KEEPS_UNAVAILABLE: 503,
			RECORDING_KEEP_FAILED: 500,
			RECORDING_DELETE_FAILED: 500,
		})
		expect(Object.isFrozen(RECORDING_ERROR_STATUS)).toBe(true)
		expect(SCANNER_DISCOVERY_HOLDS_KEPT_CODE).toBe(
			"SCANNER_DISCOVERY_HOLDS_KEPT_RECORDINGS",
		)
		const error = new RecordingKeepError("RECORDING_KEPT", "Recording is kept")
		expect(error.status).toBe(409)
		expect(error.code).toBe("RECORDING_KEPT")
		expect(
			new RecordingKeepError("RECORDING_NOT_FOUND", "Not found").status,
		).toBe(404)
	})

	it("freezes the keep keys: stable, never a path, derived from inventory ids", () => {
		expect(recordingKeepKeyOf(`dsd:0~${DSD_NAME}`)).toBe(`dsd~${DSD_NAME}`)
		// The directory index is not part of the key (it shifts with the configuration).
		expect(recordingKeepKeyOf(`dsd:7~${DSD_NAME}`)).toBe(`dsd~${DSD_NAME}`)
		expect(recordingKeepKeyOf("scan:d_ab12~rec_1.wav")).toBe(
			"scan:d_ab12~rec_1.wav",
		)
		expect(dsdFmeKeepKey(DSD_NAME)).toBe(`dsd~${DSD_NAME}`)
		expect(scannerKeepKey("d_ab12", "rec_1.wav")).toBe("scan:d_ab12~rec_1.wav")
		for (const bad of [
			"",
			`dsd:0~../${DSD_NAME}`,
			"dsd:0~a/b.wav",
			"scan:d_ab12~../x.wav",
			"scan:probe-1~x.wav",
			`dsd:01~${DSD_NAME}`,
			"/etc/passwd",
		])
			expect(recordingKeepKeyOf(bad)).toBeNull()
		for (const bad of ["../x.wav", "a/b.wav", "TEMP_x.wav", "x.WAV", ".wav"])
			expect(dsdFmeKeepKey(bad)).toBeNull()
		expect(scannerKeepKey("probe-1", "x.wav")).toBeNull()
		expect(scannerKeepKey("d_ab12", "../x.wav")).toBeNull()
		expect(scannerKeepKey("d_ab12", "a/b.wav")).toBeNull()
		// Every inventory id has a key and every key is free of path separators.
		for (const id of [`dsd:12~${DSD_NAME}`, "scan:d_Z9~a.b-c_d.wav"]) {
			expect(RECORDING_INVENTORY_ID.test(id)).toBe(true)
			const key = recordingKeepKeyOf(id)
			expect(key).not.toBeNull()
			expect(key).not.toMatch(/[/\\]/)
		}
	})

	it("freezes the protection port and the keep service shape", () => {
		expect(
			same<
				keyof RecordingProtection,
				| "isProtected"
				| "isDsdFmeFileProtected"
				| "isScannerFileProtected"
				| "discoveryHoldsKept"
			>(true),
		).toBe(true)
		expect(extendsType<RecordingKeepService, RecordingProtection>(true)).toBe(
			true,
		)
		expect(
			same<
				ReturnType<RecordingKeepService["state"]>,
				"loading" | "ready" | "failed"
			>(true),
		).toBe(true)
		const item: Api.RecordingInventoryItem = {
			id: `dsd:0~${DSD_NAME}`,
			kind: "dsd-fme-call",
			decoderId: "dmr",
			discoveryId: null,
			startedAtLocal: null,
			modifiedAt: "2026-10-17T08:15:00.000Z",
			bytes: 44,
			durationMs: 0,
			callType: "group",
			talkgroup: "9",
			source: "1234",
			frequencyHz: null,
		}
		// `kept` is optional: absent on cores before WG9.
		expect(item.kept).toBeUndefined()
	})

	it("adds the identify reason decoder-unavailable without a new outcome", () => {
		type Reason = NonNullable<Api.ScannerIdentifyTrial["reason"]>
		expect(
			same<
				Reason,
				| "no-decoder"
				| "needs-channelizer"
				| "unsupported-format"
				| "no-ambient-decoder"
				| "decoder-unavailable"
				// WG10 req 3.2: analog trial without live audio on the target
				| "no-live-audio"
				// an explicit protocol inside the ADS-B window, where only readsb is eligible
				| "adsb-window"
			>(true),
		).toBe(true)
		expect(
			same<
				Api.ScannerTrialOutcome,
				| "pending"
				| "running"
				| "decoded"
				| "no-sync"
				| "crc-errors"
				| "timeout"
				| "skipped-budget"
				| "unsupported"
				| "not-needed"
				| "cancelled"
				// WG11 req 1.1: an analog squelch opening without a tone or code
				| "heard"
				// WG12: analog replay trial outcomes
				| "data-like"
				| "carrier-only"
			>(true),
		).toBe(true)
	})

	it("keeps the tuning trust vocabulary (the WG9 fix changes derivation, not values)", () => {
		expect(
			same<Api.TuningTrust, "commanded" | "relay" | "unverified">(true),
		).toBe(true)
	})
})
