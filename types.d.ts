// Type declarations for modules without types

declare module "ws" {
	import { EventEmitter } from "events"
	import { IncomingMessage } from "http"
	import { Duplex } from "stream"

	export interface WebSocket extends EventEmitter {
		readonly readyState: number
		readonly CONNECTING: 0
		readonly OPEN: 1
		readonly CLOSING: 2
		readonly CLOSED: 3

		close(code?: number, reason?: string): void
		ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void
		pong(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void
		send(
			data: unknown,
			options?: {
				compress?: boolean
				binary?: boolean
				fin?: boolean
				mask?: boolean
			},
			cb?: (err?: Error) => void,
		): void
		terminate(): void

		on(event: "close", listener: (code: number, reason: Buffer) => void): this
		on(event: "error", listener: (err: Error) => void): this
		on(event: "message", listener: (data: Buffer | string) => void): this
		on(event: "open", listener: () => void): this
		on(event: "ping" | "pong", listener: (data: Buffer) => void): this
		on(event: string | symbol, listener: (...args: unknown[]) => void): this
	}

	export interface WebSocketServer extends EventEmitter {
		clients: Set<WebSocket>
		close(cb?: (err?: Error) => void): void
		handleUpgrade(
			request: IncomingMessage,
			socket: Duplex,
			head: Buffer,
			callback: (client: WebSocket, request: IncomingMessage) => void,
		): void
	}

	export default WebSocket
}
