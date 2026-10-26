import { verifiedLinkLine } from "./verified-link-fake.js"
import { PassThrough } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import {
	IdentifyRunner,
	normaliseIdentify,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import {
	IDENTIFY_REPLAY_MAX_CAPTURES,
	type IqCaptureView,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import {
	offsetTransport,
	type ProbeRequest,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, poolHarness } from "../../../mocks/scanner/probe-fakes.js"

const view = (
	id: string,
	over: Partial<IqCaptureView> = {},
): IqCaptureView => ({
	captureId: id,
	sourceId: "rtl",
	observationId: "o_t1",
	epoch: 1,
	rfHz: TARGET_HZ,
	tuningTrust: "commanded",
	capturedAtMs: 1,
	durationMs: 3000,
	gapSamples: 0,
	...over,
})

function harness(
	opts: {
		captures?: IqCaptureView[]
		/** Captures that appear in `near` only after the first `end`. */
		requested?: IqCaptureView
		exhaustive?: boolean
	} = {},
) {
	const captures = [...(opts.captures ?? [])]
	const calls: string[] = []
	const claimed = new Map<string, string>()
	const port = {
		near: vi.fn(() => captures.slice(0, 5)),
		capture: vi.fn((_req: unknown) => {
			calls.push("capture")
			return { captureId: "requested-1" }
		}),
		end: vi.fn((_id: string) => {
			calls.push("end")
			if (opts.requested) captures.push(opts.requested)
		}),
		claim: vi.fn((id: string, holder: string) => {
			if (claimed.has(id)) return false
			claimed.set(id, holder)
			calls.push(`claim:${id}`)
			return true
		}),
		settle: vi.fn((id: string, holder: string) => {
			claimed.delete(id)
			calls.push(`settle:${id}:${holder}`)
		}),
		confirmLive: vi.fn((_s: string, _o: string) => 0),
		openReplay: vi.fn((): PassThrough | null => {
			// The capture read to its end (a clean replay needs the input's EOF).
			const s = new PassThrough()
			s.end()
			return s
		}),
	}
	const settings = testSettings()
	const pool = poolHarness({
		settings,
		transports: [offsetTransport, createReplayTransport(port)],
	})
	const record = identifyRecord()
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			...(opts.exhaustive ? { exhaustive: true } : {}),
		}),
		inner: fakeInner(record, () => pool.clock.now),
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: () => undefined,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
		iqCapture: port,
	})
	const exited = new Set<string>()
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const replayDecoders = () =>
		[...pool.decoders.created.entries()].filter(
			([, d]) => d.config.options["inputIqFormat"] === "cf32",
		)
	/** Runs until the job ended; every replay decoder exits cleanly one step after it started. */
	const run = async (
		onReplay?: (id: string) => void,
		steps = 120,
	): Promise<void> => {
		for (let i = 0; i < steps && record.state !== "completed"; i++) {
			await advance(1000)
			for (const [id, d] of replayDecoders()) {
				if (exited.has(id)) continue
				exited.add(id)
				onReplay?.(id)
				d.emit("exit", 0, null)
				await new Promise(r => setTimeout(r, 300))
				await flushAsync()
			}
		}
	}
	return {
		...pool,
		port,
		calls,
		claimed,
		record,
		tracks,
		events,
		runner,
		advance,
		run,
		replayDecoders,
		last: () => events.at(-1)!,
	}
}

type H = ReturnType<typeof harness>
const open = async (h: H, track = trackOf({ obwHz: 12_000 })) => {
	await h.runner.start()
	h.tracks.push(viewOf(track))
}
const dmrIdentity = (h: H, id: string): void => {
	h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
	h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now + 30))
}

describe("identify with IQ captures (WG11 req 6.8)", () => {
	it("claims at most IDENTIFY_REPLAY_MAX_CAPTURES newest captures of its own source, trust or observation", async () => {
		const h = harness({
			captures: [
				view("a"),
				view("b", { observationId: "o_other", tuningTrust: "unverified" }),
				view("c", { observationId: "o_other", tuningTrust: "relay" }),
				view("d"),
				view("e"),
			],
		})
		await open(h)
		for (let i = 0; i < 3; i++) await h.advance(1000)
		expect(h.port.near).toHaveBeenCalledWith(
			"rtl",
			TARGET_HZ,
			expect.any(Number),
			{ observationId: "o_t1", limit: IDENTIFY_REPLAY_MAX_CAPTURES },
		)
		expect([...h.claimed]).toEqual([
			["a", "j_ident"],
			["c", "j_ident"],
		])
		expect(h.port.capture).not.toHaveBeenCalled()
	})

	it("replays claimed captures after the live runs, decodes, then settles every claim", async () => {
		const h = harness({ captures: [view("a")] })
		await open(h)
		await h.run(id => dmrIdentity(h, id))
		const last = h.last()
		expect(last.state).toBe("identified")
		expect(last.result).toMatchObject({
			protocol: "dmr",
			identity: { kind: "dmr-cc", value: "1" },
		})
		const dmr = last.trials.find(t => t.protocol === "dmr")!
		expect(dmr).toMatchObject({ outcome: "decoded", transport: "replay" })
		// Live trials ran first (offset), the replay decoder came later and fed from the capture.
		expect(h.port.openReplay.mock.calls.length).toBeGreaterThan(0)
		expect(h.calls.at(-1)).toBe("settle:a:j_ident")
		expect(h.claimed.size).toBe(0)
		expect(h.port.confirmLive).not.toHaveBeenCalled()
	})

	it("a live decode confirms live, replays nothing and settles", async () => {
		const h = harness({ captures: [view("a")] })
		await open(h, trackOf({ acf30: -0.94, acf60: 0.99 }))
		for (let i = 0; i < 4 && h.pool.status().length === 0; i++)
			await h.advance(100)
		const [id] = [...h.decoders.created.keys()]
		dmrIdentity(h, id!)
		await h.advance(100)
		await h.advance(100)
		expect(h.last().state).toBe("identified")
		expect(h.port.confirmLive).toHaveBeenCalledWith("rtl", "o_t1")
		expect(h.replayDecoders()).toHaveLength(0)
		expect(h.port.openReplay).not.toHaveBeenCalled()
		expect(h.calls).toContain("settle:a:j_ident")
		expect(h.claimed.size).toBe(0)
	})

	it("a replay with no decode keeps the live verdicts and still settles", async () => {
		const h = harness({ captures: [view("a")] })
		await open(h)
		await h.run()
		expect(h.last().state).not.toBe("identified")
		expect(h.last().trials.every(t => t.transport !== "replay")).toBe(true)
		expect(h.calls.at(-1)).toBe("settle:a:j_ident")
	})

	it("a capture that is gone ends no trial: the run is skipped and the capture settled", async () => {
		const h = harness({ captures: [view("a")] })
		h.port.openReplay.mockReturnValue(null as never)
		await open(h)
		await h.run()
		expect(h.replayDecoders()).toHaveLength(0)
		expect(h.record.state).toBe("completed")
		expect(h.calls.at(-1)).toBe("settle:a:j_ident")
	})

	it("cancel settles every claimed capture", async () => {
		const h = harness({ captures: [view("a"), view("b")] })
		await open(h)
		for (let i = 0; i < 3; i++) await h.advance(500)
		expect(h.claimed.size).toBe(2)
		await h.runner.dispatch({ type: "cancel" })
		expect(h.claimed.size).toBe(0)
		expect(h.calls.filter(c => c.startsWith("settle:"))).toHaveLength(2)
	})

	it("requests a capture for the resolved track once when none exists, and claims it when finished", async () => {
		const h = harness({ requested: view("requested-1") })
		await open(h)
		await h.run()
		expect(h.port.capture).toHaveBeenCalledTimes(1)
		expect(h.port.capture).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceId: "rtl",
				observationId: "o_t1",
				reason: "identify",
				rfHz: TARGET_HZ,
			}),
		)
		expect(h.port.end).toHaveBeenCalledWith("requested-1")
		expect(h.calls).toContain("claim:requested-1")
		expect(h.calls.at(-1)).toBe("settle:requested-1:j_ident")
	})

	it("a replay request carries the claimed capture's own epoch and observation", async () => {
		// An older epoch of the target's own observation: claimed, replayed in its own epoch.
		const h = harness({ captures: [view("old", { epoch: 0 })] })
		const requests: ProbeRequest[] = []
		h.pool.on(
			"probe-state",
			(_id: string, state: string, req: ProbeRequest) => {
				if (state === "starting" && req.replay) requests.push(req)
			},
		)
		await open(h)
		await h.run(id => dmrIdentity(h, id))
		expect(requests.length).toBeGreaterThan(0)
		expect(requests[0]).toMatchObject({ epoch: 0, observationId: "o_t1" })
	})

	it("a capture of another epoch and another observation is never claimed", async () => {
		const h = harness({
			captures: [view("other", { epoch: 0, observationId: "o_old" })],
		})
		const requests: ProbeRequest[] = []
		h.pool.on(
			"probe-state",
			(_id: string, state: string, req: ProbeRequest) => {
				if (state === "starting" && req.replay) requests.push(req)
			},
		)
		await open(h)
		await h.run(id => dmrIdentity(h, id))
		expect(h.calls).not.toContain("claim:other")
		expect(requests.filter(r => r.replay?.captureId === "other")).toEqual([])
	})
})
