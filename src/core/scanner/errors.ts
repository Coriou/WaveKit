import { WaveKitError } from "../../utils/errors.js"

/** A scanner failure with the HTTP status the routes answer with (§ 12.1). */
export class ScannerApiError extends WaveKitError {
	constructor(
		message: string,
		code: string,
		readonly statusCode: number,
		readonly details?: Record<string, unknown>,
	) {
		super(message, code)
		this.name = "ScannerApiError"
	}
}
