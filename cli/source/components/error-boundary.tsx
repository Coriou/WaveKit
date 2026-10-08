import { Text } from "ink"
import { Component, type ReactNode } from "react"
import { sanitize } from "../ui/text.js"

interface Props {
	children: ReactNode
}
interface State {
	error: Error | null
}

/** Mounted inside the frame; the app keys stay live, and `r` remounts it via a new key. */
export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null }

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	override render(): ReactNode {
		if (this.state.error) {
			return (
				<Text wrap="truncate-end">
					wavekit: render error · {sanitize(this.state.error.message).trim()} ·
					q quit
				</Text>
			)
		}
		return this.props.children
	}
}
