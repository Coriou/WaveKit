/**
 * dsd-fme P25: an encrypted call's per-call recording is never linked to
 * its call_end, nor is one whose clear ALG is not its own LDU2 0x80 KEY 0
 * print; a call that printed it is linked (the control that proves the
 * recording would match). Ids are synthetic.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import { createDecoder } from "./dsd-fme-call-first-helpers.js"
import { settleWavLookups } from "./dsd-fme-wav-settle.js"

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
}

interface EndData {
	protocol?: string
	encrypted?: boolean
	encryptionKnown?: boolean
	clearEvidence?: boolean
	wavFile?: string
	flags?: { encrypted?: boolean; wavFileUpdate?: boolean }
}

describe("dsd-fme P25 recording link", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("never links an encrypted call's recording; a clear call's is linked", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-p25-rec-"))
		try {
			const start = new Date(2026, 0, 9, 10, 53, 27)
			fs.writeFileSync(
				path.join(
					root,
					"20260109_105327_123_P25P_CC_1B_GROUP_TGT_56_SRC_1234.wav",
				),
				"",
			)
			vi.useFakeTimers({ toFake: ["Date"] })
			const end = async (algLine: string) => {
				const d = createDecoder({
					mode: "p25",
					enablePerCallRecording: true,
					perCallRecordingDir: root,
					perCallRecordingPrune: false,
				})
				const ends: EndData[] = []
				d.on("output", (o: DecoderOutput) => {
					if (o.type === "call_end") ends.push(o.data as EndData)
				})
				const adapter = d as unknown as Internals
				vi.setSystemTime(start)
				adapter.handleOutputLine("Sync: +P25p1 LDU1")
				adapter.handleOutputLine("nac: [ 1b] src: [ 1234] tg: [ 56]")
				// The LDU1's link control names the call its LDU2 may prove clear.
				adapter.handleOutputLine(
					" Group Voice Channel User - Group 56 Source 1234",
				)
				vi.setSystemTime(start.getTime() + 50)
				adapter.handleOutputLine("Sync: +P25p1 LDU2")
				adapter.handleOutputLine(algLine)
				vi.setSystemTime(start.getTime() + 5000)
				adapter.checkCallTimeoutAsync()
				await settleWavLookups(d)
				return ends
			}
			const encrypted = await end(
				" LDU2 ALG ID: 0x84 KEY ID: 0x1234 MI: 0x1122334455667788 ENC",
			)
			expect(encrypted.length).toBeGreaterThan(0)
			for (const e of encrypted) {
				expect(e.flags?.encrypted).toBe(true)
				expect(e.wavFile).toBeUndefined()
				expect(e.clearEvidence).toBeUndefined()
			}
			// A clear ALG that is not the call's LDU2 0x80 KEY 0 proves nothing.
			for (const e of await end("ALG ID: 0x80")) {
				expect(e.wavFile).toBeUndefined()
				expect(e.clearEvidence).toBeUndefined()
			}
			const clear = await end(
				" LDU2 ALG ID: 0x80 KEY ID: 0x0000 MI: 0x0000000000000000",
			)
			expect(clear[0]).toMatchObject({
				protocol: "p25p1",
				encryptionKnown: true,
				// The stored row's own proof of the clear print (callTrustAdmits needs it).
				clearEvidence: true,
			})
			// The file goes out in the lookup's update, with the same trust.
			expect(clear.filter(e => e.wavFile !== undefined)).toEqual([
				expect.objectContaining({
					encryptionKnown: true,
					clearEvidence: true,
					flags: expect.objectContaining({ wavFileUpdate: true }),
					wavFile: expect.stringContaining(root),
				}),
			])
		} finally {
			fs.rmSync(root, { recursive: true })
		}
	})
})
