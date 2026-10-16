import type { SocketFactory, SocketLike } from "../../src/data/events-client.ts"

/** A WebSocket stand-in driven by the test: open(), receive(), drop(). */
export class FakeSocket implements SocketLike {
	readyState = 0
	onopen: ((event: unknown) => void) | null = null
	onclose: ((event: unknown) => void) | null = null
	onerror: ((event: unknown) => void) | null = null
	onmessage: ((event: { data: unknown }) => void) | null = null
	readonly sent: unknown[] = []
	readonly url: string

	constructor(url: string) {
		this.url = url
	}

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("not open")
		this.sent.push(JSON.parse(data) as unknown)
	}

	close(): void {
		this.readyState = 3
	}

	open(): void {
		this.readyState = 1
		this.onopen?.({})
	}

	receive(message: unknown): void {
		this.onmessage?.({ data: JSON.stringify(message) })
	}

	drop(): void {
		this.readyState = 3
		this.onerror?.({})
		this.onclose?.({})
	}
}

export function fakeSockets(): {
	sockets: FakeSocket[]
	factory: SocketFactory
	last(): FakeSocket
} {
	const sockets: FakeSocket[] = []
	return {
		sockets,
		factory: url => {
			const s = new FakeSocket(url)
			sockets.push(s)
			return s
		},
		last() {
			const s = sockets[sockets.length - 1]
			if (!s) throw new Error("no socket")
			return s
		},
	}
}
