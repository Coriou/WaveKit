import { Text } from "ink"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WsHandlers } from "./data/ws-client.js"
import type { DecoderRow } from "./data/types.js"
import { renderApp } from "./test/app-harness.js"
import { scenarioState } from "./test/fixtures.js"
import { KEYS } from "./test/harness.js"
import { EMPTY_VIEW_CTX } from "./ui/actions.js"
import type { ViewModule } from "./views/types.js"

const stubDecoders: ViewModule = {
	id: "decoders",
	title: "Decoders",
	Component: () => <Text>stub decoders</Text>,
	keyInfo: () => ({
		rowIds: ["a"],
		pageSize: 1,
		ctx: { ...EMPTY_VIEW_CTX, hasSelection: true, decoderRunning: true },
	}),
	onAction: (a, _s, ui) =>
		a.type === "decoder-op"
			? {
					ui: {
						...ui,
						confirm: {
							kind: "decoder",
							prompt: "restart a",
							yes: "restart",
							no: "cancel",
							intent: { kind: "decoder", op: "restart", decoderId: "a" },
						},
					},
					effects: [],
				}
			: undefined,
}
const stubOverview: ViewModule = {
	id: "overview",
	title: "Overview",
	Component: () => <Text>stub overview</Text>,
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
}
const stubMessages: ViewModule = {
	id: "messages",
	title: "Messages",
	Component: ({ ui }) => <Text>{`draft:${ui.messages.draft ?? "none"}`}</Text>,
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
}
const stubSystem: ViewModule = {
	id: "system",
	title: "System",
	Component: () => <Text>stub system</Text>,
	keyInfo: () => ({
		rowIds: [],
		pageSize: 1,
		ctx: { ...EMPTY_VIEW_CTX, audioRunning: true },
	}),
}
const views = {
	overview: stubOverview,
	decoders: stubDecoders,
	messages: stubMessages,
	system: stubSystem,
}
const QUIET = { expectWrite: false } as const

describe("App shell", () => {
	it("frames chrome in rows−1 with the strip, switcher and footer", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		const f = h.frame()
		expect(f).toHaveLength(39)
		expect(f.at(-1)).toMatch(/\? help/)
		expect(f[0]).toMatch(/^ api ● 2s {2}iq ● streaming/)
		expect(f[1]).toBe(
			" 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System  6 Scan",
		)
		for (const l of f) expect([...l].length).toBeLessThanOrEqual(120)
		expect(h.text()).toContain("stub overview")
		h.unmount()
	})
	it("switches views, opens and closes help", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		await h.press("2")
		expect(h.text()).toContain("stub decoders")
		await h.press("?")
		expect(h.text()).toContain("keys · Decoders")
		await h.press("x")
		expect(h.text()).toContain("stub decoders")
		expect(h.frame().some(l => l.includes("▶"))).toBe(false)
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	it("shows a banner when the API is down", async () => {
		const h = await renderApp({
			state: scenarioState("api-down-cached"),
			views,
			view: "overview",
			cols: 80,
			rows: 24,
		})
		expect(h.frame()[1]).toMatch(/^ ! API unreachable · ECONNREFUSED/)
		h.unmount()
	})
	it("keeps a pending confirm across too-small resizes and writes only on y (review focus 2)", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await h.press("R")
		expect(h.frame().at(-1)).toContain("▶ restart a")
		await h.resize(50, 12)
		expect(h.frame()).toEqual(["wavekit: 50×12 too small (min 60×16)"])
		// A5 fix 1: nothing is visible, so y must not send the hidden confirm.
		await h.press("y", QUIET)
		expect(h.runtime.sent).toEqual([])
		await h.resize(120, 40)
		expect(h.frame().at(-1)).toContain("▶ restart a")
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([
			{ kind: "decoder", op: "restart", decoderId: "a" },
		])
		expect(h.frame().at(-1)).not.toContain("▶")
		h.unmount()
	})
	it("cancels confirms with Esc and reconnects on r", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await h.press("R")
		await h.press(KEYS.esc)
		expect(h.frame().at(-1)).not.toContain("▶")
		await h.press("r")
		expect(h.runtime.reconnects).toBe(1)
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	it("drops every key but quit while too small: no blind audio write, draft unchanged (review focus 2)", async () => {
		const sys = await renderApp({
			state: scenarioState("live"),
			views,
			view: "system",
			cols: 50,
			rows: 12,
		})
		await sys.press("a", QUIET)
		expect(sys.runtime.sent).toEqual([])
		await sys.resize(120, 40)
		// The write changes no frame, so do not wait for one.
		await sys.press("a", QUIET)
		expect(sys.runtime.sent).toEqual([{ kind: "audio", op: "stop" }])
		sys.unmount()

		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press("/")
		await h.press("a")
		await h.press("b")
		expect(h.text()).toContain("draft:ab")
		await h.resize(60, 15)
		await h.press("c", QUIET)
		await h.press(KEYS.esc, QUIET)
		await h.resize(120, 40)
		expect(h.text()).toContain("draft:ab")
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	it("renders the banner directly under the strip in roomy layouts (§5.1)", async () => {
		const h = await renderApp({
			state: scenarioState("api-down-cached"),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		const f = h.frame()
		expect(f[1]).toMatch(/^ ! API unreachable/)
		expect(f[2]).toBe(
			" 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System  6 Scan",
		)
		h.unmount()
	})
})

describe("q while too small (A5 fix 2, item 6)", () => {
	it("quits even with a hidden confirm pending", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await h.press("R")
		await h.resize(50, 12)
		await h.press("q", QUIET)
		await h.waitFor(() => h.exited())
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	it("quits even with a hidden filter draft open (q is not typed)", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press("/")
		await h.resize(60, 15)
		await h.press("q", QUIET)
		await h.waitFor(() => h.exited())
		h.unmount()
	})
	it("quits even with help open", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		await h.press("?")
		await h.resize(50, 12)
		await h.press("q", QUIET)
		await h.waitFor(() => h.exited())
		h.unmount()
	})
})

describe("App error boundary (spec §6.6)", () => {
	let spy: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
	})
	afterEach(() => {
		spy.mockRestore()
	})
	it("wraps the whole frame: a throw in the strip shows the fallback and keys stay live", async () => {
		const live = scenarioState("live")
		const broken = {
			...live,
			decoders: { ...live.decoders, value: [null as unknown as DecoderRow] },
		}
		const h = await renderApp({
			state: broken,
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		expect(h.frame()[0]).toMatch(/^ wavekit: render error · .+ · q quit$/)
		await h.press("r")
		expect(h.runtime.reconnects).toBe(1)
		await h.press("q", QUIET)
		await h.waitFor(() => h.exited())
		h.unmount()
	})
})

it("explicitly reselects and reconnects a re-added sole Scan source across App/runtime", async () => {
	const { App } = await import("./app.js")
	const { createRuntime, nodeRuntimeDeps } = await import("./data/runtime.js")
	const { VIEWS } = await import("./views/registry.js")
	const { renderAt, pollUntil } = await import("./test/harness.js")
	const { SCAN_PROFILE, SCAN_FRAME } = await import("./test/fixtures.js")
	const handlers: WsHandlers[] = [],
		sent: string[] = []
	const rt = createRuntime(
		nodeRuntimeDeps(
			{
				base: "http://localhost:9100",
				ws: "ws://localhost:9100/ws",
				explicit: true,
			},
			(await import("./data/reducers.js")).PLAIN_SUMMARY.summarize,
			{
				fetchFn: () => new Promise(() => undefined),
				wsFactory: (_url, h) => {
					handlers.push(h)
					return { send: s => sent.push(s), close: () => undefined }
				},
			},
		),
	)
	const state = scenarioState(
		"live",
		(await import("./data/reducers.js")).PLAIN_SUMMARY,
	)
	const source = { ...state.sources.value![0]!, id: "rtl" }
	state.sources.value = [source]
	rt.start()
	rt.store.set(state)
	const h = await renderAt(
		<App
			runtime={rt}
			views={VIEWS}
			initialView="scan"
			color={false}
			writeRaw={() => undefined}
		/>,
		{ cols: 80, rows: 24 },
	)
	const admit = (wire: WsHandlers) => {
		wire.message(
			JSON.stringify({
				type: "spectrum:profile",
				channel: "spectrum",
				data: SCAN_PROFILE,
			}),
		)
		wire.message(
			JSON.stringify({
				type: "spectrum:frame",
				channel: "spectrum",
				data: SCAN_FRAME,
			}),
		)
		rt.tick()
	}
	try {
		let wire = handlers[0]!
		wire.open()
		wire.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		admit(wire)
		expect(rt.store.get().scan.rows).toHaveLength(1)
		for (const key of ["s", "r"]) {
			wire.message(
				JSON.stringify({
					type: "source:removed",
					channel: "sources",
					data: { sourceId: "rtl" },
				}),
			)
			rt.tick()
			if (key === "s") {
				const before = sent.length
				await h.press("r", QUIET)
				wire = handlers.at(-1)!
				wire.open()
				wire.message(
					JSON.stringify({ type: "subscribed", data: { channels: [] } }),
				)
				rt.tick()
				expect(rt.store.get().scan.phase).toBe("removed")
				expect(
					sent.slice(before).every(s => !s.includes('"sourceId":"rtl"')),
				).toBe(true)
			}
			const removed = sent.length
			wire.message(
				JSON.stringify({
					type: "source:status",
					channel: "sources",
					data: source,
				}),
			)
			rt.tick()
			expect(
				await pollUntil(
					() =>
						rt.store.get().sources.value?.some(s => s.id === "rtl") === true,
				),
			).toBe(true)
			expect(rt.store.get().sources.value?.map(s => s.id)).toEqual(["rtl"])
			await h.press("", QUIET)
			expect(sent).toHaveLength(removed)
			expect(rt.store.get().scan.phase).toBe("removed")
			await h.press(key, QUIET)
			if (key === "r") {
				wire = handlers.at(-1)!
				wire.open()
				wire.message(
					JSON.stringify({ type: "subscribed", data: { channels: [] } }),
				)
			}
			expect(JSON.parse(sent.at(-1)!)).toMatchObject({
				type: "subscribe",
				options: { spectrum: { sourceId: "rtl" } },
			})
			admit(wire)
			expect(rt.store.get().scan.rows).toHaveLength(1)
		}
	} finally {
		h.unmount()
		rt.stop()
	}
})

it("commits visible identify consent before y, synchronously fences resize, and never uses generic writes", async () => {
	const { scanView } = await import("./views/scan.js")
	const { SCAN_DISCOVERY, SCAN_PROFILE, SCAN_FRAME, SCAN_STATUS } =
		await import("./test/fixtures.js")
	const { initialScan, selectScan, scanRead, scanProfile, scanFrame } =
		await import("./data/scan-state.js")
	const { guardScan } = await import("./data/scanner-guards.js")
	const { identifyConsentLayout } = await import("./data/identify-state.js")
	const state = scenarioState("live")
	state.sources.value = [{ ...state.sources.value![0]!, id: "rtl" }]
	state.scan = scanFrame(
		scanProfile(selectScan(initialScan(), "rtl"), SCAN_PROFILE),
		SCAN_FRAME,
		state.now,
	)
	state.scan = scanRead(
		state.scan,
		"status",
		guardScan("status", SCAN_STATUS)!,
		null,
		state.now,
	)
	state.scan = scanRead(
		state.scan,
		"discoveries",
		guardScan("discoveries", { items: [SCAN_DISCOVERY], nextCursor: null })!,
		null,
		state.now,
	)
	state.scan = scanRead(
		state.scan,
		"discovery",
		guardScan("discovery", SCAN_DISCOVERY)!,
		null,
		state.now,
	)
	const request = {
		sourceId: "rtl",
		target: {
			frequencyHz: SCAN_DISCOVERY.frequencyHz,
			bandwidthHz: SCAN_DISCOVERY.bandwidthHz,
		},
		timeoutMs: 15000 as const,
		exhaustive: false as const,
		record: false as const,
	}
	state.identify = {
		prompt: null,
		receipt: null,
		inspection: false,
		readiness: { ready: true, reason: null, request, layout: null },
	}
	const h = await renderApp({
		state,
		views: { scan: scanView },
		view: "scan",
		cols: 80,
		rows: 24,
	})
	const visible = vi.fn(),
		confirm = vi.fn(),
		invalidate = vi.fn()
	h.runtime.markIdentifyVisible = visible
	h.runtime.confirmIdentify = confirm
	h.runtime.invalidateIdentify = invalidate
	h.runtime.prepareIdentify = context => ({
		token: 1,
		destination: "http://core",
		session: 1,
		revision: 1,
		profileGeneration: 1,
		contextKey: context.key,
		discoveryId: "disc1",
		request,
		frameKey: "frame",
		layout: identifyConsentLayout(request, context),
	})
	await h.press("d")
	await h.press(KEYS.enter)
	await h.press("i")
	expect(h.text()).toContain("Identify this frequency")
	expect(h.text()).toContain("y confirm  n cancel  Esc cancel")
	expect(visible).toHaveBeenCalledWith(1)
	await h.press("y")
	expect(confirm).toHaveBeenCalledTimes(1)
	await h.press("y", QUIET)
	expect(confirm).toHaveBeenCalledTimes(1)
	expect(h.runtime.sent).toEqual([])
	await h.press("i")
	const before = invalidate.mock.calls.length
	await h.resize(59, 15)
	expect(invalidate.mock.calls.length).toBeGreaterThan(before)
	await h.press("y", QUIET)
	expect(confirm).toHaveBeenCalledTimes(1)
	h.unmount()
})

// Exercise the real ingress fence and credential adapter across React's fallback.
describe("identify consent subtree failures", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => undefined)
	})
	afterEach(() => vi.restoreAllMocks())

	async function realConsentApp() {
		const { App } = await import("./app.js")
		const { createRuntime } = await import("./data/runtime.js")
		const { createCliFetch } = await import("./data/access-transport.js")
		const { MachineCredential } = await import("./data/access-credentials.js")
		const { PLAIN_SUMMARY } = await import("./data/reducers.js")
		const { scanView } = await import("./views/scan.js")
		const { renderAt, settle } = await import("./test/harness.js")
		const { SCAN_FRAME, SCAN_PROFILE, SCAN_STATUS, SCAN_DISCOVERY, SCAN_JOB } =
			await import("./test/fixtures.js")
		let now = Date.now()
		let failure: "none" | "confirm" | "always" = "none"
		let deferCredentials = false
		const credentialWaiters: ((
			value: InstanceType<typeof MachineCredential>,
		) => void)[] = []
		const handlers: WsHandlers[] = []
		const posts: string[] = []
		const source = {
			...scenarioState("live").sources.value![0]!,
			id: "rtl",
			connected: true,
			caps: {
				...scenarioState("live").sources.value![0]!.caps,
				kind: "iq" as const,
				format: "U8_IQ" as const,
				centerFreq: SCAN_FRAME.centerHz,
				sampleRate: SCAN_FRAME.sampleRateHz,
			},
			activity: {
				...scenarioState("live").sources.value![0]!.activity!,
				state: "streaming" as const,
			},
		}
		const accepted = {
			...SCAN_JOB,
			identify: {
				...SCAN_JOB.identify,
				target: {
					frequencyHz: SCAN_DISCOVERY.frequencyHz,
					bandwidthHz: SCAN_DISCOVERY.bandwidthHz,
				},
				timeoutMs: 15000,
				protocols: [],
				exhaustive: false,
				record: false,
			},
		}
		const native = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input)
			if (init?.method === "POST") {
				posts.push(String(init.body))
				return new Response(JSON.stringify(accepted), { status: 201 })
			}
			const body = url.endsWith("/api/sources")
				? [source]
				: url.endsWith("/api/scanner")
					? SCAN_STATUS
					: url.includes("/observations")
						? { items: [], nextCursor: null }
						: url.endsWith("/discoveries/disc1")
							? SCAN_DISCOVERY
							: url.includes("/discoveries?")
								? { items: [SCAN_DISCOVERY], nextCursor: null }
								: url.endsWith("/api/spectrum")
									? { defaultProfile: SCAN_PROFILE.profile, sources: [] }
									: []
			return new Response(JSON.stringify(body))
		})
		const base = "http://localhost:9100"
		const rt = createRuntime({
			fetchFn: createCliFetch({
				fetch: native,
				policy: {
					origin: base,
					credentials: () =>
						deferCredentials
							? new Promise(resolve => credentialWaiters.push(resolve))
							: Promise.resolve(new MachineCredential("A".repeat(43))),
				},
			}),
			probeFetchFn: () => new Promise(() => undefined),
			wsFactory: (_url, wire) => {
				handlers.push(wire)
				return { send: () => undefined, close: () => undefined }
			},
			now: () => now,
			random: () => 0.5,
			timers: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 1,
				clearInterval: () => undefined,
			},
			summarize: PLAIN_SUMMARY.summarize,
			explicit: {
				base,
				ws: `${base.replace("http", "ws")}/ws`,
				explicit: true,
			},
		})
		const testView: ViewModule = {
			...scanView,
			Component: props => {
				if (
					failure === "always" ||
					(failure === "confirm" && props.ui.confirm?.kind === "identify")
				)
					throw new Error("consent subtree failed")
				return <scanView.Component {...props} />
			},
		}
		rt.start()
		const h = await renderAt(
			<App
				runtime={rt}
				views={{ scan: testView }}
				initialView="scan"
				color={false}
				writeRaw={() => undefined}
			/>,
			{ cols: 80, rows: 24 },
		)
		const opened = new Set<WsHandlers>()
		const refresh = async (_reconnect = false) => {
			const wire = handlers.at(-1)!
			if (!opened.has(wire)) {
				opened.add(wire)
				wire.open()
				wire.message(
					JSON.stringify({ type: "subscribed", data: { channels: [] } }),
				)
			}
			for (const [type, data] of [
				["source:status", source],
				["spectrum:profile", SCAN_PROFILE],
				["spectrum:frame", SCAN_FRAME],
			] as const)
				wire.message(
					JSON.stringify({
						type,
						channel: type.startsWith("source:") ? "sources" : "spectrum",
						data,
					}),
				)
			now += 5001
			rt.tick()
			for (let i = 0; i < 80; i++) await Promise.resolve()
			rt.tick()
			await settle()
		}
		await refresh()
		await h.press("d")
		await refresh()
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		await refresh()
		expect(
			rt.identifySnapshot().readiness,
			JSON.stringify(rt.identifySnapshot()) + "\n" + h.text(),
		).toMatchObject({ ready: true })
		return {
			h,
			rt,
			posts,
			handlers,
			refresh,
			setFailure: (next: typeof failure) => {
				failure = next
			},
			defer: () => {
				deferCredentials = true
			},
			pending: () => credentialWaiters.length,
			resolve: () => {
				deferCredentials = false
				for (const resolve of credentialWaiters.splice(0))
					resolve(new MachineCredential("A".repeat(43)))
			},
			renderFailure: async () => {
				rt.store.set({ ...rt.store.get(), now: ++now })
				await settle()
			},
		}
	}

	it.each(["confirm", "latched", "credentials"] as const)(
		"does not dispatch through a %s render failure and recovers only with fresh visible consent",
		async mode => {
			const a = await realConsentApp()
			try {
				if (mode === "latched") {
					a.setFailure("always")
					await a.renderFailure()
				} else if (mode === "confirm") a.setFailure("confirm")
				await a.h.press("i", QUIET)
				if (mode === "credentials") {
					expect(a.h.text()).toContain("Identify this frequency")
					a.defer()
					await a.h.press("y", QUIET)
					expect(a.pending()).toBeGreaterThan(0)
					a.setFailure("always")
					await a.renderFailure()
					a.resolve()
				}
				expect(a.h.text()).toContain("render error")
				await a.h.press("y", QUIET)
				expect(a.posts).toEqual([])
				a.setFailure("none")
				const previousSockets = a.handlers.length
				await a.h.press("r", QUIET)
				expect(a.handlers).toHaveLength(previousSockets + 1)
				await a.refresh(true)
				await a.h.press("y", QUIET)
				expect(a.posts).toEqual([])
				// Reconnect cannot revalidate the old consent token.
				await a.refresh()
				await a.h.press("i", QUIET)
				expect(a.h.text()).toContain("Identify this frequency")
				await a.h.press("y", QUIET)
				expect(a.posts).toHaveLength(1)
				await a.h.press("q", QUIET)
				await a.h.waitFor(() => a.h.exited())
			} finally {
				a.h.unmount()
				a.rt.stop()
			}
		},
	)
})
