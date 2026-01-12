import React, { Component } from "react"
import type { ErrorInfo, ReactNode } from "react"
import { Text, Box } from "ink"

interface Props {
	children: ReactNode
}

interface State {
	hasError: boolean
	error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props)
		this.state = { hasError: false, error: null }
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error }
	}

	override componentDidCatch(_error: Error, _errorInfo: ErrorInfo) {
		// You can also log the error to an error reporting service
	}

	override render() {
		if (this.state.hasError) {
			return (
				<Box
					flexDirection="column"
					borderColor="red"
					borderStyle="single"
					padding={1}
				>
					<Text color="red" bold>
						Render Error
					</Text>
					<Text>{this.state.error?.message}</Text>
				</Box>
			)
		}

		return this.props.children
	}
}
