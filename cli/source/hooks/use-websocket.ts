/**
 * WebSocket Hook - Manages connection with auto-reconnect
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Multi-URL fallback support
 * - Automatic resubscription on reconnect
 * - Connection state tracking
 *
 * Ported from the gold-standard backpressure-viewer.mjs
 */

import { useState, useEffect, useCallback, useRef } from "react"
import type { WebSocket as WsWebSocket, Data as WsData } from "ws"
import WsModule from "ws"

// ============================================================================
// Types
// ============================================================================

export type ConnectionStatus = "connecting" | "connected" | "disconnected"

export type WebSocketChannel = "decoders" | "metrics" | "sources" | "health" | "fanout"

export interface ServerMessage {
	type: string
	channel?: WebSocketChannel
	data?: unknown
}

export interface UseWebSocketOptions {
	/** Channels to subscribe to on connect */
	channels: WebSocketChannel[]
	/** Called when a message is received */
	onMessage?: (message: ServerMessage) => void
	/** Called on connection error */
	onError?: (error: Error) => void
	/** Auto-reconnect on disconnect (default: true) */
	autoReconnect?: boolean
}

export interface UseWebSocketResult {
	status: ConnectionStatus
	error: string | null
	closeCode: number | null
	closeReason: string | null
	reconnect: () => void
}

// ============================================================================
// URL Resolution
// ============================================================================

function normalizeWsUrl(url: string | undefined): string | null {
	if (!url || typeof url !== "string") return null
	const trimmed = url.trim()
	if (!trimmed) return null
	if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed
	if (trimmed.startsWith("http://")) return "ws://" + trimmed.slice("http://".length)
	if (trimmed.startsWith("https://")) return "wss://" + trimmed.slice("https://".length)
	return trimmed
}

function getCandidateWsUrls(): string[] {
	const envUrls = process.env["WAVEKIT_WS_URLS"]
	if (envUrls) {
		return envUrls.split(",").map(normalizeWsUrl).filter((u): u is string => u !== null)
	}

	const single = process.env["WAVEKIT_WS_URL"]
	if (single) {
		const url = normalizeWsUrl(single)
		return url ? [url] : []
	}

	const apiUrl = process.env["WAVEKIT_API_URL"]
	if (apiUrl) {
		const wsBase = normalizeWsUrl(apiUrl)
		if (wsBase) {
			return [wsBase.replace(/\/$/, "") + "/ws"]
		}
	}

	// Defaults: dev container uses 9000, docker-compose exposes 4713
	return [
		"ws://localhost:9000/ws",
		"ws://localhost:4713/ws",
		"ws://127.0.0.1:9000/ws",
		"ws://127.0.0.1:4713/ws",
	]
}

// ============================================================================
// Hook Implementation
// ============================================================================

// Require connection to be stable for 10s before resetting backoff
const STABLE_CONNECTION_MS = 10000

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketResult {
	const { channels, onMessage, onError, autoReconnect = true } = options

	const [status, setStatus] = useState<ConnectionStatus>("connecting")
	const [error, setError] = useState<string | null>(null)

	const wsRef = useRef<WsWebSocket | null>(null)
	const attemptRef = useRef(0)
	const candidateIndexRef = useRef(0)
	const stopRequestedRef = useRef(false)
	const channelsRef = useRef(channels)
	const onMessageRef = useRef(onMessage)
	const onErrorRef = useRef(onError)
	const connectedAtRef = useRef<number | null>(null)
	const closeCodeRef = useRef<number | null>(null)
	const closeReasonRef = useRef<string | null>(null)
	const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null)

	// Keep refs updated
	channelsRef.current = channels
	onMessageRef.current = onMessage
	onErrorRef.current = onError

	const connect = useCallback(() => {
		// Clear any pending reconnect timer
		if (reconnectTimerRef.current) {
			clearTimeout(reconnectTimerRef.current)
			reconnectTimerRef.current = null
		}
		
		// Close existing connection if any
		if (wsRef.current) {
			try {
				wsRef.current.close()
			} catch {
				// Ignore
			}
			wsRef.current = null
		}

		if (stopRequestedRef.current) return

		const candidates = getCandidateWsUrls()
		if (candidates.length === 0) {
			setError("No WebSocket URL candidates found")
			setStatus("disconnected")
			return
		}

		const url = candidates[candidateIndexRef.current % candidates.length]
		candidateIndexRef.current++
		attemptRef.current++

		setStatus("connecting")
		setError(null)
		closeCodeRef.current = null
		closeReasonRef.current = null

		try {
			const ws = new WsModule(url!)
			wsRef.current = ws

			const connectionTimeout = setTimeout(() => {
				if (ws.readyState !== WsModule.OPEN) {
					ws.close()
				}
			}, 5000)

			ws.on("open", () => {
				clearTimeout(connectionTimeout)
				// Track when connection opened - only reset attempt after stable duration
				connectedAtRef.current = Date.now()
				setStatus("connected")
				setError(null) 
				// Clear error on success, but maybe we want to know WHICH url connected?
				// For now let's leave it clean, but if send fails we'll see the URL.
				closeCodeRef.current = null
				closeReasonRef.current = null

				// Subscribe to channels
				setTimeout(() => {
					try {
						if (ws.readyState === WsModule.OPEN) {
							const msg = JSON.stringify({
								type: "subscribe",
								channels: channelsRef.current,
							})
							// console.log("Sending subscription:", msg) // Debug
							ws.send(msg)
							// setError(null) // Clear any previous send errors
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : "Send failed"
						// Only set error if we are still connected, otherwise it might be confusing
						if (ws.readyState === WsModule.OPEN) {
							setError(`Send error: ${msg}`)
						}
					}
				}, 100) // Small delay to ensure server is ready

				// Setup Ping Interval for KeepAlive
				const pingInterval = setInterval(() => {
					if (ws.readyState === WsModule.OPEN) {
						ws.ping()
					}
				}, 30000)
				
				ws.on("close", () => clearInterval(pingInterval))
				ws.on("error", () => clearInterval(pingInterval))
			})

			ws.on("message", (data: WsData) => {
				try {
					const text = typeof data === "string" ? data : data.toString("utf-8")
					const msg = JSON.parse(text) as ServerMessage
					// console.log("RX:", msg.type)
					onMessageRef.current?.(msg)
				} catch (err) {
					const e = err instanceof Error ? err.message : "Unknown"
					console.error("Message handling error:", err)
					setError(`Msg Error: ${e}`)
				}
			})

			ws.on("error", (err: Error) => {
				clearTimeout(connectionTimeout)
				const errorMessage = err instanceof Error ? err.message : "Connection error"
				setError(errorMessage)
				onErrorRef.current?.(err instanceof Error ? err : new Error(errorMessage))
			})

			ws.on("close", (code, reason) => {
				clearTimeout(connectionTimeout)
				if (wsRef.current === ws) {
					wsRef.current = null
				}
				setStatus("disconnected")
				closeCodeRef.current = code
				closeReasonRef.current = reason ? reason.toString() : (code === 1005 ? "No Status Received" : null)

				// Only reset attempt counter if connection was stable
				const wasStable = connectedAtRef.current !== null && 
					(Date.now() - connectedAtRef.current) > STABLE_CONNECTION_MS
				if (wasStable) {
					attemptRef.current = 0
				}
				connectedAtRef.current = null

				if (autoReconnect && !stopRequestedRef.current) {
					const backoffMs = Math.min(15000, 500 * Math.pow(2, Math.min(5, attemptRef.current)))
					
					// Clear any existing timer just in case
					if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
					
					reconnectTimerRef.current = setTimeout(() => {
						reconnectTimerRef.current = null
						if (!stopRequestedRef.current) {
							connect()
						}
					}, backoffMs)
				}
			})
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Failed to create connection"
			setError(errorMessage)
			setStatus("disconnected")
		}
	}, [autoReconnect])

	const reconnect = useCallback(() => {
		// cleanup happens in connect()
		attemptRef.current = 0
		connect()
	}, [connect])

	// Initial connection
	useEffect(() => {
		stopRequestedRef.current = false
		connect()

		return () => {
			stopRequestedRef.current = true
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current)
				reconnectTimerRef.current = null
			}
			if (wsRef.current) {
				wsRef.current.close()
				wsRef.current = null
			}
		}
	}, [connect])

	return { status, error, reconnect, closeCode: closeCodeRef.current, closeReason: closeReasonRef.current }
}
