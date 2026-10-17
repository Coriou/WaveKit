/**
 * Unmounted redacted config export route. Main registers this plugin in protected mode only:
 * while CONFIG_EXPORT_REQUIRES_ACCESS is true, registration without authorize fails closed.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import {
	CONFIG_EXPORT_CONTENT_TYPE,
	CONFIG_EXPORT_FILE_NAME,
	CONFIG_EXPORT_REQUIRES_ACCESS,
	CONFIG_EXPORT_ROUTE,
} from "@wavekit/api-types"
import type {
	ConfigExportErrorCode,
	ConfigExportErrorDto,
} from "@wavekit/api-types"
import type { DeniedAdmission } from "../../access/types.js"
import type { Config } from "../../config.js"
import { exportConfig } from "../../core/config-export/export.js"
import { WaveKitError } from "../../utils/errors.js"

export interface ConfigExportRoutesOptions {
	getConfig?: () => Config
	/** Required while CONFIG_EXPORT_REQUIRES_ACCESS is true. */
	authorize?: (request: FastifyRequest) => DeniedAdmission | undefined
	version: string
	secretOptionKeys?: (type: string) => readonly string[]
	maxBytes?: number
	now?: () => Date
}

const MESSAGES: Record<ConfigExportErrorCode, string> = {
	CONFIG_EXPORT_UNAVAILABLE: "Configuration export is unavailable",
	CONFIG_EXPORT_FAILED: "Configuration export failed",
}

function sendDenial(reply: FastifyReply, denied: DeniedAdmission) {
	for (const [name, value] of Object.entries(denied.headers))
		reply.header(name, value)
	return reply
		.status(denied.status)
		.type("application/json")
		.send(JSON.stringify({ code: denied.code }))
}

function sendFailure(
	request: FastifyRequest,
	reply: FastifyReply,
	status: number,
	code: ConfigExportErrorCode,
) {
	// Only the fixed code is logged: never the config, body or caught error message.
	request.log.warn({ code }, "config export failed")
	const body: ConfigExportErrorDto = {
		error: "ConfigExportError",
		code,
		message: MESSAGES[code],
	}
	return reply
		.status(status)
		.header("Cache-Control", "no-store")
		.type("application/json")
		.send(JSON.stringify(body))
}

export const configExportRoutes: FastifyPluginAsync<
	ConfigExportRoutesOptions
> = async (app, options) => {
	const { authorize, getConfig } = options
	if (CONFIG_EXPORT_REQUIRES_ACCESS && !authorize)
		throw new WaveKitError(
			"Config export requires an access authorizer",
			"CONFIG_EXPORT_REQUIRES_ACCESS",
		)
	const now = options.now ?? (() => new Date())

	app.get(
		CONFIG_EXPORT_ROUTE,
		{
			onRequest: (request, reply, done) => {
				let denied: DeniedAdmission | undefined
				try {
					denied = authorize?.(request)
				} catch {
					// Fixed body and code only: the thrown message is never echoed or logged.
					void sendFailure(request, reply, 500, "CONFIG_EXPORT_FAILED")
					return
				}
				if (denied) {
					void sendDenial(reply, denied)
					return
				}
				done()
			},
		},
		(request, reply) => {
			let config: Config
			try {
				if (!getConfig) throw new Error("unavailable")
				config = getConfig()
			} catch {
				return sendFailure(request, reply, 503, "CONFIG_EXPORT_UNAVAILABLE")
			}
			let body: string
			try {
				body = exportConfig(config, {
					version: options.version,
					generatedAt: now().toISOString(),
					...(options.secretOptionKeys
						? { secretOptionKeys: options.secretOptionKeys }
						: {}),
					...(options.maxBytes !== undefined
						? { maxBytes: options.maxBytes }
						: {}),
				})
			} catch {
				return sendFailure(request, reply, 500, "CONFIG_EXPORT_FAILED")
			}
			return reply
				.status(200)
				.header("Cache-Control", "no-store")
				.header(
					"Content-Disposition",
					`attachment; filename="${CONFIG_EXPORT_FILE_NAME}"`,
				)
				.type(CONFIG_EXPORT_CONTENT_TYPE)
				.send(body)
		},
	)
}
