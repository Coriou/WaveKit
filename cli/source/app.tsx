/**
 * WaveKit CLI Dashboard - Main Application
 *
 * A unified, modern, Ink-based CLI dashboard for monitoring WaveKit.
 *
 * Features:
 * - Tab-based navigation (1-5)
 * - Auto-reconnect WebSocket with exponential backoff
 * - Graceful shutdown (q or Ctrl+C)
 * - Real-time updates from WS channels
 */

import React, { useState, useCallback, useEffect } from "react"
import { Box, useInput, useApp } from "ink"
import { useWebSocket, type ServerMessage } from "./hooks/use-websocket.js"
import { useTerminalSize } from "./hooks/use-terminal-size.js"
import { ErrorBoundary } from "./components/error-boundary.js"
import { Header } from "./components/header.js"
import { TabBar } from "./components/tab-bar.js"
import { HelpBar } from "./components/help-bar.js"
import { DecoderList } from "./components/decoder-list.js"
import { DecoderOutput as DecoderOutputPanel } from "./components/decoder-output.js"
import { BackpressurePanel } from "./components/backpressure-panel.js"
import { SourceStatus } from "./components/source-status.js"
import { Dashboard } from "./components/dashboard.js"
import type { View } from "./utils/args.js"
import type {
	DecoderStatus,
	DecoderOutput,
	FanoutSnapshot,
	BranchTelemetry,
	SourceStatus as SourceStatusType,
	DecoderOutputMessage,
	TunerRelayStatus,
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
	})

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
						| {
								decoderId?: string
								health?: string
								error?: string
						  }
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
		channels: ["decoders", "health", "fanout", "metrics", "sources"],
		onMessage: handleMessage,
	})

	// Fetch initial decoder/source state via REST
	useEffect(() => {
		async function fetchInitialState() {
			try {
				// Try common ports
				const ports = [9000, 4713]
				for (const port of ports) {
					try {
						const [decodersRes, sourcesRes] = await Promise.all([
							fetch(`http://localhost:${port}/api/decoders`),
							fetch(`http://localhost:${port}/api/sources`).catch(() => null),
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
							setState(prev => ({ ...prev, decoders, sources, tunerRelay }))
							break
						}
					} catch {
						// Try next port
					}
				}
			} catch {
				// Ignore fetch errors, WS will provide updates
			}
		}

		fetchInitialState()

		// Refresh periodically
		const interval = setInterval(fetchInitialState, 5000)
		return () => clearInterval(interval)
	}, [])

	// Update drop rate periodically
	useEffect(() => {
		const interval = setInterval(() => {
			setState(prev => ({ ...prev, dropRate: getDropRate() }))
		}, 1000)
		return () => clearInterval(interval)
	}, [])

	// Keyboard input handling
	useInput((input, key) => {
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

		// View navigation
		const viewMap: Record<string, View> = {
			"1": "dashboard",
			"2": "decoders",
			"3": "output",
			"4": "backpressure",
			"5": "sources",
		}
		if (viewMap[input]) {
			setActiveView(viewMap[input])
		}
	})

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
			<TabBar activeView={activeView} />
			<Box flexGrow={1} minHeight={10}>
				{renderView()}
			</Box>
			<HelpBar />
		</Box>
	)
}
