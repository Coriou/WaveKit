/**
 * Decoder Registry - Plugin system for registering decoder factories
 *
 * Requirements:
 * - 5.1: WHEN a decoder type is registered, THE Decoder_Registry SHALL store the factory function for that type
 * - 5.2: WHEN a decoder is requested by type, THE Decoder_Registry SHALL create an instance using the registered factory
 * - 5.3: WHEN an unregistered decoder type is requested, THE Decoder_Registry SHALL return an error
 * - 5.4: THE Decoder_Registry SHALL provide a list of all registered decoder types
 */

import type { Decoder, DecoderConfig } from "./types.js"
import type { Logger } from "../utils/logger.js"
import { RegistryError } from "../utils/errors.js"

/**
 * Factory function type for creating decoder instances.
 * Each decoder type registers a factory that creates instances with the given config and logger.
 */
export type DecoderFactory = (config: DecoderConfig, logger: Logger) => Decoder

/**
 * DecoderRegistry - Plugin system for registering and creating decoder instances.
 *
 * Provides a factory pattern for decoder creation, allowing new decoder types
 * to be registered at runtime without modifying core code.
 */
export class DecoderRegistry {
	private factories: Map<string, DecoderFactory> = new Map()

	/**
	 * Registers a decoder factory for a given type.
	 * Requirement 5.1: Store the factory function for the type.
	 *
	 * @param type - Unique identifier for the decoder type (e.g., 'dsd-fme', 'multimon-ng')
	 * @param factory - Factory function that creates decoder instances
	 */
	register(type: string, factory: DecoderFactory): void {
		this.factories.set(type, factory)
	}

	/**
	 * Unregisters a decoder factory for a given type.
	 *
	 * @param type - The decoder type to unregister
	 * @returns true if the type was registered and removed, false if it wasn't registered
	 */
	unregister(type: string): boolean {
		return this.factories.delete(type)
	}

	/**
	 * Creates a decoder instance using the registered factory.
	 * Requirement 5.2: Create an instance using the registered factory.
	 * Requirement 5.3: Return an error for unregistered types.
	 *
	 * @param config - Configuration for the decoder instance
	 * @param logger - Logger instance for the decoder
	 * @returns A new decoder instance
	 * @throws RegistryError if the decoder type is not registered
	 */
	create(config: DecoderConfig, logger: Logger): Decoder {
		const factory = this.factories.get(config.type)
		if (!factory) {
			throw new RegistryError(config.type)
		}
		return factory(config, logger)
	}

	/**
	 * Checks if a decoder type is registered.
	 *
	 * @param type - The decoder type to check
	 * @returns true if the type is registered, false otherwise
	 */
	has(type: string): boolean {
		return this.factories.has(type)
	}

	/**
	 * Gets a list of all registered decoder types.
	 * Requirement 5.4: Provide a list of all registered decoder types.
	 *
	 * @returns Array of registered decoder type names
	 */
	getRegisteredTypes(): string[] {
		return Array.from(this.factories.keys())
	}
}
