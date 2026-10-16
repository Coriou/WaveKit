#!/bin/sh
# Publish only Caddy's local root certificate for the core.
# The data volume stays on this container and holds CA private keys.
# Nothing copied to /trust may be a private key.
set -eu

trust_dir=/trust
cert_src=/data/caddy/pki/authorities/local/root.crt
cert_dst="$trust_dir/root.crt"

caddy_pid=
stop() {
	if [ -n "$caddy_pid" ]; then
		kill -TERM "$caddy_pid" 2>/dev/null || true
		wait "$caddy_pid" 2>/dev/null || true
	fi
	exit 0
}
trap stop TERM INT

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

publish_root() {
	if [ ! -f "$cert_src" ]; then
		return 0
	fi
	if [ -f "$cert_dst" ] && cmp -s "$cert_src" "$cert_dst"; then
		return 0
	fi
	tmp="$trust_dir/root.crt.tmp"
	if ! cp "$cert_src" "$tmp"; then
		rm -f "$tmp"
		echo "wavekit: cannot write $tmp; root.crt not published" >&2
		return 0
	fi
	if grep -q "PRIVATE KEY" "$tmp"; then
		rm -f "$tmp"
		echo "wavekit: refusing to publish private key material" >&2
		return 1
	fi
	if ! grep -q "BEGIN CERTIFICATE" "$tmp"; then
		rm -f "$tmp"
		return 0
	fi
	chmod 644 "$tmp"
	mv -f "$tmp" "$cert_dst"
	echo "wavekit: published $cert_dst" >&2
}

while kill -0 "$caddy_pid" 2>/dev/null; do
	if ! publish_root; then
		kill -TERM "$caddy_pid" 2>/dev/null || true
		wait "$caddy_pid" 2>/dev/null || true
		exit 1
	fi
	sleep 1
done
wait "$caddy_pid"
