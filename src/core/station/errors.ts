import type {
	StationErrorBody,
	StationErrorCode,
	StationField,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"

const STATUS_BY_CODE: Record<StationErrorCode, number> = {
	STATION_UPDATE_INVALID: 400,
	STATION_FIELD_PINNED: 409,
	STATION_REVISION_MISMATCH: 412,
	STATION_STORE_UNAVAILABLE: 503,
}

const ERROR_BY_STATUS: Record<number, string> = {
	400: "Bad Request",
	409: "Conflict",
	412: "Precondition Failed",
	503: "Service Unavailable",
}

/** A rejected station update (400, 409, 412, 503); state is unchanged when thrown. */
export class StationUpdateError extends WaveKitError {
	readonly statusCode: number
	declare readonly code: StationErrorCode
	readonly fields?: StationField[]

	constructor(
		code: StationErrorCode,
		message: string,
		fields?: StationField[],
		cause?: Error,
	) {
		super(message, code, cause)
		this.name = "StationUpdateError"
		this.statusCode = STATUS_BY_CODE[code]
		if (fields !== undefined) this.fields = fields
	}

	toBody(): StationErrorBody {
		const body: StationErrorBody = {
			error: ERROR_BY_STATUS[this.statusCode] ?? "Error",
			code: this.code,
			message: this.message,
		}
		if (this.fields !== undefined) body.fields = [...this.fields]
		return body
	}
}
