import "fastify"
import type {
	ContextConfigDefault,
	FastifyBaseLogger,
	FastifyInstance,
	FastifyRequest,
	FastifySchema,
	FastifyTypeProvider,
	FastifyTypeProviderDefault,
	RawReplyDefaultExpression,
	RawRequestDefaultExpression,
	RawServerBase,
	RawServerDefault,
} from "fastify"
import type { RouteGenericInterface } from "fastify/types/route"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { WebSocket } from "ws"

declare module "fastify" {
	interface FastifySchema {
		/** OpenAPI tags used by @fastify/swagger */
		tags?: string[]
		/** OpenAPI summary used by @fastify/swagger */
		summary?: string
		/** OpenAPI description used by @fastify/swagger */
		description?: string
		/** OpenAPI operationId used by @fastify/swagger */
		operationId?: string
		/** OpenAPI deprecated flag */
		deprecated?: boolean
	}

	interface RouteShorthandOptions<
		RawServer extends RawServerBase = RawServerDefault,
		RawRequest extends RawRequestDefaultExpression<RawServer> =
			RawRequestDefaultExpression<RawServer>,
		RawReply extends RawReplyDefaultExpression<RawServer> =
			RawReplyDefaultExpression<RawServer>,
		RouteGeneric extends RouteGenericInterface = RouteGenericInterface,
		ContextConfig = ContextConfigDefault,
		SchemaCompiler extends FastifySchema = FastifySchema,
		TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
		Logger extends FastifyBaseLogger = FastifyBaseLogger,
	> {
		websocket?: boolean
	}

	interface RouteShorthandMethod<
		RawServer extends RawServerBase = RawServerDefault,
		RawRequest extends RawRequestDefaultExpression<RawServer> =
			RawRequestDefaultExpression<RawServer>,
		RawReply extends RawReplyDefaultExpression<RawServer> =
			RawReplyDefaultExpression<RawServer>,
		TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
		Logger extends FastifyBaseLogger = FastifyBaseLogger,
	> {
		<
			RequestGeneric extends RouteGenericInterface = RouteGenericInterface,
			ContextConfig = ContextConfigDefault,
			SchemaCompiler extends FastifySchema = FastifySchema,
			InnerLogger extends Logger = Logger,
		>(
			path: string,
			opts: RouteShorthandOptions<
				RawServer,
				RawRequest,
				RawReply,
				RequestGeneric,
				ContextConfig,
				SchemaCompiler,
				TypeProvider,
				InnerLogger
			> & { websocket: true },
			handler: (
				this: FastifyInstance<
					Server,
					IncomingMessage,
					ServerResponse<IncomingMessage>
				>,
				socket: WebSocket,
				request: FastifyRequest<
					RequestGeneric,
					RawServer,
					RawRequest,
					SchemaCompiler,
					TypeProvider,
					ContextConfig,
					InnerLogger
				>,
			) => void | Promise<unknown>,
		): FastifyInstance<
			RawServer,
			RawRequest,
			RawReply,
			InnerLogger,
			TypeProvider
		>
	}
}
