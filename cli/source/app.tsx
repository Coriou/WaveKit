/**
 * WaveKit CLI Dashboard - Main Application
 *
 * A unified, modern, Ink-based CLI dashboard for monitoring WaveKit.
 *
 * Features:
 * - Tab-based navigation (1-8)
 * - Auto-reconnect WebSocket with exponential backoff
 * - Graceful shutdown (q or Ctrl+C)
 * - Real-time updates from WS channels
 */

import React, { useState, useCallback, useEffect } from "react"
import { Box, useInput, useApp } from "ink"
import { useWebSocket, type ServerMessage } from "./hooks/use-websocket.js"
import { useTerminalSize } from "./hooks/use-terminal-size.js"
import { Header } from "./components/header.js"
import { TabBar } from "./components/tab-bar.js"
import { HelpBar } from "./components/help-bar.js"
import { DecoderList } from "./components/decoder-list.js"
import { DecoderOutput as DecoderOutputPanel } from "./components/decoder-output.js"
import { BackpressurePanel } from "./components/backpressure-panel.js"
import { SourceStatus } from "./components/source-status.js"
import { Dashboard } from "./components/dashboard.js"
import { LiveAudioPanel } from "./components/live-audio-panel.js"
import { ResourcePanel } from "./components/resource-panel.js"
import { TunerPanel, type TunerCommand } from "./components/tuner-panel.js"
import type { View } from "./utils/args.js"
import type {
	DecoderStatus,
	DecoderOutput,
	FanoutSnapshot,
	SourceStatus as SourceStatusType,
	DecoderOutputMessage,
	TunerRelayStatus,
	TunerState,
	LiveAudioStatus,
	ResourceSnapshot,
} from "./types.js"

// ============================================================================
// Types
// ============================================================================

interface AppProps {
	initialView?: View
}

interface AppState {
	decoders: DecoderStatus[]
	sources: SourceStatusType[]
	messages: DecoderOutput[]
	snapshot: FanoutSnapshot | null
	dropRate: number
	tunerRelay: TunerRelayStatus | null
	tunerStates: TunerState[]
	tunerActionError: string | null
	liveAudioStatus: LiveAudioStatus | null
	resourceSnapshot: ResourceSnapshot | null
}

// ============================================================================
// Drop Rate Tracking
// ============================================================================

interface DropRecord {
	timestamp: number
	bytes: number
}

const DROP_WINDOW_MS = 5000
let dropHistory: DropRecord[] = []

function recordDrop(bytes: number) {
	const now = Date.now()
	dropHistory.push({ timestamp: now, bytes })
	// Prune old entries
	dropHistory = dropHistory.filter(d => d.timestamp >= now - DROP_WINDOW_MS)
}

function getDropRate(): number {
	const now = Date.now()
	const windowStart = now - DROP_WINDOW_MS
	const recentDrops = dropHistory.filter(d => d.timestamp >= windowStart)
	const totalBytes = recentDrops.reduce((sum, d) => sum + d.bytes, 0)
	return Math.round(totalBytes / (DROP_WINDOW_MS / 1000))
}

// ============================================================================
// Main App Component
// ============================================================================

export function App({ initialView = "dashboard" }: AppProps) {
	const { exit } = useApp()
	const { columns: stdoutWidth, rows: stdoutHeight } = useTerminalSize()

	// View state
	const [activeView, setActiveView] = useState<View>(initialView)

	// Data state
	const [state, setState] = useState<AppState>({
		decoders: [],
		sources: [],
		messages: [],
		snapshot: null,
		dropRate: 0,
		tunerRelay: null,
		tunerStates: [],
		tunerActionError: null,
		liveAudioStatus: null,
		resourceSnapshot: null,
	})
	const [tunerInputActive, setTunerInputActive] = useState(false)

	// Handle incoming WebSocket messages
	const handleMessage = useCallback((msg: ServerMessage) => {
		switch (msg.type) {
			case "decoder:output": {
				const data = msg.data as DecoderOutputMessage | undefined
				if (data?.output) {
					setState(prev => ({
						...prev,
						messages: [...prev.messages.slice(-99), data.output],
					}))
				}
				break
			}

			case "decoder:started":
			case "decoder:stopped":
			case "decoder:health":
			case "decoder:error": {
				setState(prev => {
					const data = msg.data as
						| { decoderId?: string; health?: string; error?: string }
						| undefined
					const decoderId = data?.decoderId
					if (!decoderId) return prev

					const nextDecoders = prev.decoders.map(decoder => {
						if (decoder.id !== decoderId) return decoder
						if (msg.type === "decoder:started") {
							return { ...decoder, running: true }
						}
						if (msg.type === "decoder:stopped") {
							return { ...decoder, running: false }
						}
						if (
							msg.type === "decoder:health" &&
							typeof data?.health === "string"
						) {
							return {
								...decoder,
								health: data.health as DecoderStatus["health"],
							}
						}
						if (
							msg.type === "decoder:error" &&
							typeof data?.error === "string"
						) {
							return { ...decoder, error: data.error }
						}
						return decoder
					})

					return { ...prev, decoders: nextDecoders }
				})
				break
			}

			case "fanout:snapshot": {
				const data = msg.data as FanoutSnapshot | undefined
				if (data) {
					setState(prev => {
						// Track drop deltas for rate calculation
						if (prev.snapshot?.branches) {
							const prevDrops = new Map<string, number>()
							for (const branch of prev.snapshot.branches) {
								prevDrops.set(branch.id, branch.droppedBytesTotal ?? 0)
							}
							for (const branch of data.branches) {
								const prevDrop = prevDrops.get(branch.id) ?? 0
								const delta = (branch.droppedBytesTotal ?? 0) - prevDrop
								if (delta > 0) recordDrop(delta)
							}
						}

						return {
							...prev,
							snapshot: data,
							dropRate: getDropRate(),
						}
					})
				}
				break
			}

			case "live-audio:status": {
				const data = msg.data as LiveAudioStatus | undefined
				if (data) {
					setState(prev => ({ ...prev, liveAudioStatus: data }))
				}
				break
			}

			case "live-audio:config": {
				const data = msg.data as LiveAudioStatus["config"] | undefined
				if (data) {
					setState(prev => {
						if (!prev.liveAudioStatus) return prev
						return {
							...prev,
							liveAudioStatus: {
								...prev.liveAudioStatus,
								config: data,
							},
						}
					})
				}
				break
			}

			case "resources:snapshot": {
				const data = msg.data as ResourceSnapshot | undefined
				if (data) {
					setState(prev => ({ ...prev, resourceSnapshot: data }))
				}
				break
			}

			case "tuner:state-changed": {
				const data = msg.data as
					| { sourceId?: string; state?: TunerState }
					| undefined
				const sourceId = data?.sourceId
				const state = data?.state
				if (state && sourceId) {
					const nextSourceId = sourceId
					const nextState: TunerState = state
					setState(prev => {
						const nextStates: TunerState[] = [
							...prev.tunerStates.filter(s => s.sourceId !== nextSourceId),
							nextState,
						].sort((a, b) => a.sourceId.localeCompare(b.sourceId))
						return { ...prev, tunerStates: nextStates }
					})
				}
				break
			}

			case "subscribed":
				// Successfully subscribed
				break

			case "error":
				// Handle error messages if needed
				break
		}
	}, [])

	// WebSocket connection
	const { status, error, reconnect, closeCode, closeReason } = useWebSocket({
		channels: [
			"decoders",
			"health",
			"fanout",
			"metrics",
			"sources",
			"live-audio",
			"resources",
			"tuner",
		],
		onMessage: handleMessage,
	})

	// Fetch initial decoder/source state via REST
	const fetchInitialState = useCallback(async () => {
		try {
			// Try common ports
			const ports = [9000, 4713]
			for (const port of ports) {
				try {
					const [
						decodersRes,
						sourcesRes,
						liveAudioRes,
						resourcesRes,
						tunerStatesRes,
					] = await Promise.all([
						fetch(`http://localhost:${port}/api/decoders`),
						fetch(`http://localhost:${port}/api/sources`).catch(() => null),
						fetch(`http://localhost:${port}/api/live-audio/status`).catch(
							() => null,
						),
						fetch(`http://localhost:${port}/api/resources`).catch(() => null),
						fetch(`http://localhost:${port}/api/tuner`).catch(() => null),
					])
					const tunerRes = await fetch(
						`http://localhost:${port}/api/tuner-relay`,
					).catch(() => null)

					if (decodersRes.ok) {
						const decoders = (await decodersRes.json()) as DecoderStatus[]
						const sources = sourcesRes?.ok
							? ((await sourcesRes.json()) as SourceStatusType[])
							: []
						const tunerRelay = tunerRes?.ok
							? ((await tunerRes.json()) as TunerRelayStatus)
							: null
						const liveAudioStatus = liveAudioRes?.ok
							? ((await liveAudioRes.json()) as LiveAudioStatus)
							: null
						const resourceSnapshot = resourcesRes?.ok
							? ((await resourcesRes.json()) as ResourceSnapshot)
							: null
						const tunerStates = tunerStatesRes?.ok
							? ((await tunerStatesRes.json()) as TunerState[])
							: []
						setState(prev => ({
							...prev,
							decoders,
							sources,
							tunerRelay,
							tunerStates,
							liveAudioStatus,
							resourceSnapshot,
						}))
						break
					}
				} catch {
					// Try next port
				}
			}
		} catch {
			// Ignore fetch errors, WS will provide updates
		}
	}, [])

	useEffect(() => {
		void fetchInitialState()

		// Refresh periodically
		const interval = setInterval(() => {
			void fetchInitialState()
		}, 5000)
		return () => clearInterval(interval)
	}, [fetchInitialState])

	const performLiveAudioAction = useCallback(
		async (action: "start" | "stop") => {
			const apiUrl = process.env["WAVEKIT_API_URL"]
			const candidates = apiUrl
				? [apiUrl.replace(/\/$/, "")]
				: ["http://localhost:9000", "http://localhost:4713"]

			for (const baseUrl of candidates) {
				try {
					const response = await fetch(`${baseUrl}/api/live-audio/${action}`, {
						method: "POST",
					})
					if (response.ok) {
						await fetchInitialState()
						break
					}
				} catch {
					// Try next URL
				}
			}
		},
		[fetchInitialState],
	)

	const performTunerAction = useCallback(
		async (command: TunerCommand) => {
			const apiUrl = process.env["WAVEKIT_API_URL"]
			const candidates = apiUrl
				? [apiUrl.replace(/\/$/, "")]
				: ["http://localhost:9000", "http://localhost:4713"]

			const toRequest = () => {
				switch (command.type) {
					case "setFrequency":
						return {
							path: `/api/tuner/${command.sourceId}/frequency`,
							body: { hz: command.hz },
						}
					case "setSampleRate":
						return {
							path: `/api/tuner/${command.sourceId}/sample-rate`,
							body: { hz: command.hz },
						}
					case "setGainMode":
						return {
							path: `/api/tuner/${command.sourceId}/gain-mode`,
							body: { mode: command.mode },
						}
					case "setGain":
						return {
							path: `/api/tuner/${command.sourceId}/gain`,
							body: { tenthsDb: command.tenthsDb },
						}
					case "setPpm":
						return {
							path: `/api/tuner/${command.sourceId}/ppm`,
							body: { ppm: command.ppm },
						}
					case "setAgcMode":
						return {
							path: `/api/tuner/${command.sourceId}/agc`,
							body: { enabled: command.enabled },
						}
					case "setBiasTee":
						return {
							path: `/api/tuner/${command.sourceId}/bias-tee`,
							body: { enabled: command.enabled },
						}
					case "setDirectSampling":
						return {
							path: `/api/tuner/${command.sourceId}/direct-sampling`,
							body: { mode: command.mode },
						}
					case "setOffsetTuning":
						return {
							path: `/api/tuner/${command.sourceId}/offset-tuning`,
							body: { enabled: command.enabled },
						}
					case "setControlMode":
						return {
							path: `/api/tuner/${command.sourceId}/control-mode`,
							body: { mode: command.mode },
						}
				}
			}

			const request = toRequest()
			let lastError: string | null = null

			for (const baseUrl of candidates) {
				try {
					const response = await fetch(`${baseUrl}${request.path}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(request.body),
					})
					if (response.ok) {
						setState(prev => ({ ...prev, tunerActionError: null }))
						await fetchInitialState()
						return
					}
					const payload = (await response.json().catch(() => null)) as {
						message?: string
						error?: string
					} | null
					lastError =
						payload?.message ??
						payload?.error ??
						`Request failed (${response.status})`
				} catch (err) {
					lastError = err instanceof Error ? err.message : "Request failed"
				}
			}

			if (lastError) {
				setState(prev => ({ ...prev, tunerActionError: lastError }))
			}
		},
		[fetchInitialState],
	)

	// Update drop rate periodically
	useEffect(() => {
		const interval = setInterval(() => {
			setState(prev => ({ ...prev, dropRate: getDropRate() }))
		}, 1000)
		return () => clearInterval(interval)
	}, [])

	// Keyboard input handling
	useInput(
		(input, key) => {
			if (key.ctrl && input === "c") {
				exit()
			}
		},
		{ isActive: tunerInputActive },
	)

	useInput(
		(input, key) => {
			// Quit
			if (input === "q" || (key.ctrl && input === "c")) {
				exit()
				return
			}

			// Reconnect
			if (input === "r") {
				reconnect()
				return
			}

			if (activeView === "live-audio") {
				if (input === "s") {
					void performLiveAudioAction("start")
					return
				}
				if (input === "x") {
					void performLiveAudioAction("stop")
					return
				}
			}

			// View navigation
			const viewMap: Record<string, View> = {
				"1": "dashboard",
				"2": "decoders",
				"3": "output",
				"4": "backpressure",
				"5": "sources",
				"6": "live-audio",
				"7": "resources",
				"8": "tuner",
			}
			if (viewMap[input]) {
				setActiveView(viewMap[input])
			}
		},
		{ isActive: !tunerInputActive },
	)

	// Track last disconnect for diagnostics
	const [lastDisconnect, setLastDisconnect] = useState<{
		time: string
		error?: string
		code?: number
	} | null>(null)

	useEffect(() => {
		if (status === "disconnected") {
			setLastDisconnect({
				time: new Date().toLocaleTimeString(),
				error: error || closeReason || undefined,
				code: closeCode || undefined,
			})
		}
	}, [status, error, closeCode, closeReason])

	// Render current view
	const renderView = () => {
		// Heuristic: available rows for the main panel.
		// (Header + TabBar + HelpBar consume a handful of rows; keep this simple.)
		const panelHeight = Math.max(8, stdoutHeight - 8)
		const outputMaxMessages = Math.max(10, panelHeight - 4)

		switch (activeView) {
			case "dashboard":
				return (
					<Dashboard
						decoders={state.decoders}
						sources={state.sources}
						snapshot={state.snapshot}
						dropRate={state.dropRate}
						messages={state.messages}
						tunerRelay={state.tunerRelay}
						liveAudioStatus={state.liveAudioStatus}
					/>
				)
			case "decoders":
				return <DecoderList decoders={state.decoders} />
			case "output":
				return (
					<DecoderOutputPanel
						messages={state.messages}
						maxMessages={outputMaxMessages}
					/>
				)
			case "backpressure":
				return (
					<BackpressurePanel
						snapshot={state.snapshot}
						dropRate={state.dropRate}
					/>
				)
			case "sources":
				return (
					<SourceStatus sources={state.sources} tunerRelay={state.tunerRelay} />
				)
			case "live-audio":
				return <LiveAudioPanel status={state.liveAudioStatus} />
			case "resources":
				return <ResourcePanel snapshot={state.resourceSnapshot} />
			case "tuner":
				return (
					<TunerPanel
						states={state.tunerStates}
						onCommand={performTunerAction}
						actionError={state.tunerActionError}
						onInputCaptureChange={active =>
							setTunerInputActive(prev => (prev === active ? prev : active))
						}
					/>
				)
		}
	}

	return (
		<Box flexDirection="column" width={stdoutWidth} height={stdoutHeight}>
			<Header
				status={status}
				error={error}
				closeCode={closeCode}
				closeReason={closeReason}
				lastDisconnect={lastDisconnect}
			/>
			<TabBar activeView={activeView} width={stdoutWidth} />
			<Box flexGrow={1} minHeight={10}>
				{renderView()}
			</Box>
			<HelpBar />
		</Box>
	)
}
