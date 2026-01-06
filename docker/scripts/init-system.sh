#!/bin/sh
# Initialization script: system directories, logging, permissions

set -e

# Create required directories
mkdir -p /var/log/wavekit
mkdir -p /var/run/wavekit
mkdir -p /tmp/wavekit
mkdir -p /recordings

# Set permissions
chmod 755 /var/log/wavekit
chmod 755 /var/run/wavekit
chmod 755 /tmp/wavekit

# Initialize logging
touch /var/log/wavekit/system.log
touch /var/log/wavekit/sdrpp.log
touch /var/log/wavekit/wavekit.log
touch /var/log/wavekit/decoders.log

chmod 644 /var/log/wavekit/*.log

echo "[wavekit-init] Initialization complete" >> /var/log/wavekit/system.log
