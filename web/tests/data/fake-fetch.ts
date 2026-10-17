import { ApiClient } from "../../src/data/api-client.ts"

export interface Call {
	method: string
	url: string
	headers: Readonly<Record<string, string>>
	body: unknown
}

export function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

/** An ApiClient whose fetch answers each call from `handler`, recording the calls. */
export function scripted(
	handler: (call: Call) => Response | Promise<Response>,
	baseUrl?: string,
): { api: ApiClient; calls: Call[] } {
	const calls: Call[] = []
	const api = new ApiClient({
		...(baseUrl !== undefined ? { baseUrl } : {}),
		fetch: async (url, init) => {
			const call: Call = {
				method: init?.method ?? "GET",
				url,
				headers: { ...(init?.headers as Record<string, string> | undefined) },
				body:
					typeof init?.body === "string"
						? (JSON.parse(init.body) as unknown)
						: undefined,
			}
			calls.push(call)
			return handler(call)
		},
	})
	return { api, calls }
}
