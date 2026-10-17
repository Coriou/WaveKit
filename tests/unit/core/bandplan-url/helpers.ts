import { EventEmitter } from "node:events"
import type { ClientRequest, IncomingMessage } from "node:http"
import type { RequestOptions } from "node:https"
import { PassThrough } from "node:stream"
import type {
	BandPlanUrlRequest,
	ResolvedAddress,
} from "../../../../src/core/bandplan-url/index.js"

export const HOSTS = ["raw.githubusercontent.com"] as const
export const URL_OK = "https://raw.githubusercontent.com/o/r/main/plan.csv"
export const PUBLIC: readonly ResolvedAddress[] = [
	{ address: "185.199.108.133", family: 4 },
]

export interface FakeResponseSpec {
	readonly status?: number
	readonly headers?: Record<string, string>
	/** Chunks written to the body, then ended unless `hang`. */
	readonly chunks?: readonly Buffer[]
	readonly hang?: boolean
	/** Emit a socket error on the request instead of answering. */
	readonly requestError?: boolean
	/** Emit an error on the response stream after the chunks. */
	readonly responseError?: boolean
}

export interface FakeRequestLog {
	readonly calls: RequestOptions[]
	destroyed: number
	ended: number
	responses: PassThrough[]
}

/** A request seam that never opens a socket. */
export function fakeRequest(spec: FakeResponseSpec): {
	request: BandPlanUrlRequest
	log: FakeRequestLog
} {
	const log: FakeRequestLog = {
		calls: [],
		destroyed: 0,
		ended: 0,
		responses: [],
	}
	const request: BandPlanUrlRequest = (options, onResponse) => {
		log.calls.push(options)
		const req = new EventEmitter() as EventEmitter & {
			end(): void
			destroy(): void
		}
		req.destroy = () => {
			log.destroyed++
		}
		req.end = () => {
			log.ended++
			queueMicrotask(() => {
				if (spec.requestError) {
					req.emit("error", new Error("ECONNRESET secret-body"))
					return
				}
				const res = new PassThrough() as PassThrough & {
					statusCode: number
					headers: Record<string, string>
				}
				res.statusCode = spec.status ?? 200
				res.headers = spec.headers ?? { "content-type": "text/plain" }
				log.responses.push(res)
				onResponse(res as unknown as IncomingMessage)
				for (const chunk of spec.chunks ?? []) res.write(chunk)
				if (spec.responseError) res.destroy(new Error("boom"))
				else if (!spec.hang) res.end()
			})
		}
		return req as unknown as ClientRequest
	}
	return { request, log }
}

export const resolveTo =
	(addresses: readonly ResolvedAddress[]) =>
	(): Promise<readonly ResolvedAddress[]> =>
		Promise.resolve(addresses)
