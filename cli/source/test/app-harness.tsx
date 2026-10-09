import { App } from "../app.js"
import { StrictFitContext } from "../components/lines.js"
import type { RuntimeHandle } from "../data/runtime.js"
import { createStore } from "../data/store.js"
import type { AppState, WriteIntent } from "../data/types.js"
import type { ViewId } from "../ui/actions.js"
import type { ViewModule } from "../views/types.js"
import { renderAt, type RenderHandle } from "./harness.js"

export interface FakeRuntime extends RuntimeHandle {
	sent: WriteIntent[]
	reconnects: number
}

export function fakeRuntime(state: AppState): FakeRuntime {
	const rt: FakeRuntime = {
		store: createStore(state),
		sent: [],
		reconnects: 0,
		send: intent => {
			rt.sent.push(intent)
		},
		reconnect: () => {
			rt.reconnects++
		},
	}
	return rt
}

export async function renderApp(opts: {
	state: AppState
	views: Partial<Record<ViewId, ViewModule>>
	view: ViewId
	cols: number
	rows: number
	writeRaw?: (s: string) => void
	/** P22: lines that overflow their box throw instead of being clipped by Ink. */
	strict?: boolean
}): Promise<RenderHandle & { runtime: FakeRuntime }> {
	const runtime = fakeRuntime(opts.state)
	const app = (
		<App
			runtime={runtime}
			views={opts.views}
			initialView={opts.view}
			color={false}
			writeRaw={opts.writeRaw ?? (() => undefined)}
		/>
	)
	const h = await renderAt(
		opts.strict === true ? (
			<StrictFitContext.Provider value={{ cols: opts.cols }}>
				{app}
			</StrictFitContext.Provider>
		) : (
			app
		),
		{ cols: opts.cols, rows: opts.rows },
	)
	return Object.assign(h, { runtime })
}
