"""Synthetic baseband generators for fixtures/compose.py (channelizer T7a).

Each generator module exposes generate(params, duration_s) -> (iq, sample_rate, expected),
where iq is complex128 baseband at the generator's native rate, covering duration_s, with
exact zeros while the transmitter is keyed off, and expected lists the decodes it carries.
Written from the protocol specifications, not ported from other generators.
"""
