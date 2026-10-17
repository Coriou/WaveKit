/** The `/ws` events socket off the main thread (see events-relay.ts). */
import type { SocketLike } from "./events-client.ts"
import type { EventsWorkerToMain, MainToEventsWorker } from "./events-relay.ts"
import { EventsRelay } from "./events-relay.ts"

interface WorkerScope {
	postMessage(message: EventsWorkerToMain): void
	onmessage: ((event: MessageEvent<MainToEventsWorker>) => void) | null
}

const scope = self as unknown as WorkerScope

const relay = new EventsRelay({
	post: message => scope.postMessage(message),
	openSocket: url => new WebSocket(url) as unknown as SocketLike,
	now: () => performance.now(),
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
})

scope.onmessage = event => relay.handle(event.data)
