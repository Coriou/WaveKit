import { verifiedLinkLine } from "./verified-link-fake.js"
/**
 * WG9 req 5.4: an identify trial whose decoder program cannot run is
 * `unsupported` / `decoder-unavailable`; every other early end keeps the
 * frozen outcome (goldens recorded from the code before this change).
 */
import { describe, expect, it } from "vitest"
import { DecoderSpawnError } from "../../../../src/utils/errors.js"
import {
	isSpawnUnavailableError,
	isUnavailableExit,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import {
	identifyHarness,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync } from "../../../mocks/scanner/probe-fakes.js"

type Harness = ReturnType<typeof identifyHarness>
const ENDED = ["completed", "cancelled", "failed"]

async function settle(h: Harness, stepMs: number, steps: number) {
	for (let i = 0; i < steps && !ENDED.includes(h.record.state); i++)
		await h.advance(stepMs)
}

const trials = (h: Harness) =>
	Object.fromEntries(
		(h.last()?.trials ?? []).map(t => [
			t.protocol,
			t.reason ? `${t.outcome}/${t.reason}` : t.outcome,
		]),
	)

/** The 12 kHz track of identify-runner's "tries every plausible decoder": multimon-ng runs first. */
async function startWideTrack(h: Harness): Promise<string> {
	await h.runner.start()
	h.tracks.push(viewOf(trackOf({ obwHz: 12_000 })))
	await h.advance(100)
	await h.advance(100)
	await flushAsync()
	const [probe] = [...h.decoders.created.values()]
	return probe?.id ?? ""
}

function spawnError(errno: string | undefined): DecoderSpawnError {
	const cause = new Error("spawn failed") as NodeJS.ErrnoException
	if (errno !== undefined) cause.code = errno
	return new DecoderSpawnError("probe", "/bin/sh", cause)
}

/** Frozen outcomes of the wide track when nothing decodes (identify-runner golden). */
const ALL_NO_SYNC = {
	pocsag: "no-sync",
	flex: "no-sync",
	aprs: "no-sync",
	"analog-fm": "unsupported/no-decoder",
	dmr: "no-sync",
	ysf: "no-sync",
	p25p1: "no-sync",
	nxdn96: "no-sync",
}

describe("identify decoder-unavailable (WG9 5.4)", () => {
	for (const code of [126, 127]) {
		it(`marks the trial unsupported/decoder-unavailable on exit ${code} before any output`, async () => {
			const h = identifyHarness()
			const id = await startWideTrack(h)
			expect(id).not.toBe("")
			h.decoders.created.get(id)!.emit("exit", code, null)
			await flushAsync()
			await settle(h, 1000, 40)
			expect(trials(h)).toEqual({
				...ALL_NO_SYNC,
				pocsag: "unsupported/decoder-unavailable",
				flex: "unsupported/decoder-unavailable",
			})
			expect(h.record.state).toBe("completed")
		})
	}

	// Goldens: frozen code ignored every probe exit, so the hold ran out.
	for (const [label, code, signal] of [
		["exit 1", 1, null],
		["exit 0", 0, null],
		["exit 2", 2, null],
		["a signal", null, "SIGKILL"],
		["unknown exit info", undefined, undefined],
		["a 127 code with a signal", 127, "SIGTERM"],
	] as const) {
		it(`keeps the frozen outcome on ${label} before any output`, async () => {
			const h = identifyHarness()
			const id = await startWideTrack(h)
			h.decoders.created.get(id)!.emit("exit", code, signal)
			await flushAsync()
			await settle(h, 1000, 40)
			expect(trials(h)).toEqual(ALL_NO_SYNC)
		})
	}

	it("keeps the frozen outcome on exit 127 after output", async () => {
		const h = identifyHarness()
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99 })))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		const [probe] = [...h.decoders.created.values()]
		expect(probe?.config.type).toBe("dsd-fme")
		h.decoders.emitLink(probe!.id, verifiedLinkLine(1, h.clock.now))
		probe!.emit("exit", 127, null)
		await flushAsync()
		await settle(h, 1000, 40)
		expect(trials(h)).toEqual(GOLDEN_OUTPUT_THEN_127)
	})

	for (const errno of ["ENOENT", "EACCES"]) {
		it(`marks the trial unsupported/decoder-unavailable on a spawn ${errno}`, async () => {
			const h = identifyHarness()
			h.decoders.failNext = spawnError(errno)
			await startWideTrack(h)
			await flushAsync()
			await settle(h, 1000, 40)
			expect(trials(h)).toEqual({
				...ALL_NO_SYNC,
				pocsag: "unsupported/decoder-unavailable",
				flex: "unsupported/decoder-unavailable",
			})
		})
	}

	// Golden: a launch rejection stops the probe with "error" → cancelled.
	for (const [label, err] of [
		["spawn EPERM", spawnError("EPERM")],
		["spawn error with no errno", spawnError(undefined)],
		[
			"a bare ENOENT not wrapped as a spawn error",
			Object.assign(new Error("x"), { code: "ENOENT" }),
		],
	] as const) {
		it(`keeps the frozen outcome on a launch rejection by ${label}`, async () => {
			const h = identifyHarness()
			h.decoders.failNext = err
			await startWideTrack(h)
			await flushAsync()
			await settle(h, 1000, 40)
			expect(trials(h)).toEqual(GOLDEN_LAUNCH_REJECTED)
		})
	}

	it("classifies only trusted exit and spawn evidence", () => {
		expect(isUnavailableExit(127, null)).toBe(true)
		expect(isUnavailableExit(126, null)).toBe(true)
		expect(isUnavailableExit(127, "SIGKILL")).toBe(false)
		expect(isUnavailableExit(undefined, undefined)).toBe(false)
		expect(isUnavailableExit("127", null)).toBe(false)
		expect(isUnavailableExit(1, null)).toBe(false)
		expect(isSpawnUnavailableError(spawnError("ENOENT"))).toBe(true)
		expect(isSpawnUnavailableError(spawnError("EACCES"))).toBe(true)
		expect(isSpawnUnavailableError(spawnError("EPERM"))).toBe(false)
		expect(isSpawnUnavailableError(spawnError(undefined))).toBe(false)
		expect(isSpawnUnavailableError(new Error("ENOENT"))).toBe(false)
		expect(isSpawnUnavailableError(undefined)).toBe(false)
	})
})

/** Recorded from the frozen code (5669c187): output, then exit 127, ran the hold out. */
const GOLDEN_OUTPUT_THEN_127 = {
	dmr: "no-sync",
	aprs: "no-sync",
	"analog-fm": "unsupported/no-decoder",
	dstar: "no-sync",
	pocsag: "no-sync",
	ysf: "no-sync",
	flex: "no-sync",
	p25p1: "no-sync",
	nxdn96: "no-sync",
}
/** Recorded from the frozen code (5669c187): a rejected launch stops the probe with "error". */
const GOLDEN_LAUNCH_REJECTED = {
	...ALL_NO_SYNC,
	pocsag: "cancelled",
	flex: "cancelled",
}
