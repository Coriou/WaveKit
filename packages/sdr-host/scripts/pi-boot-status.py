#!/usr/bin/python3
"""Bounded read-only setup page available before cloud-init and Docker finish.

Only fixed static assets and a sanitized status record are public. This is not
a general file server or API proxy; boot configuration and logs are never read.
"""
import datetime
import gzip
import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import socket
from socketserver import ThreadingMixIn
import stat
import threading
import time

ROOT = Path('/usr/local/share/wavekit/boot-status')
STATUS = Path('/var/lib/wavekit/status/setup.json')
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
ASSETS = {
    '/': ('boot.html', 'text/html; charset=utf-8'),
    '/boot.js': ('boot.js', 'text/javascript; charset=utf-8'),
    '/boot.css': ('boot.css', 'text/css; charset=utf-8'),
    '/app.css': ('app.css', 'text/css; charset=utf-8'),
    '/fonts/barlow-500.woff2': ('fonts/barlow-500.woff2', 'font/woff2'),
    '/fonts/barlow-600.woff2': ('fonts/barlow-600.woff2', 'font/woff2'),
    '/fonts/barlow-semi-condensed-600.woff2': ('fonts/barlow-semi-condensed-600.woff2', 'font/woff2'),
}
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


def setup_status(path=STATUS, boot_path=BOOT_ID):
    """Allowlist public values again, even if the producer writes extra fields."""
    unknown = {'state': 'waiting', 'phase': None, 'updatedAt': None,
               'updatedAgeMs': None, 'exitCode': None}
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4096:
                return {**unknown, 'state': 'unavailable'}
            record = json.loads(stream.read(4097))
        if not isinstance(record, dict) or record.get('schema') != 1:
            return {**unknown, 'state': 'unavailable'}
        state, phase = record.get('state'), record.get('phase')
        if state not in ('running', 'complete', 'failed') or phase not in (None, 'cloud-init', 'install', 'publish', 'done'):
            return {**unknown, 'state': 'unavailable'}
        updated = record.get('updatedAt')
        if not isinstance(updated, str) or len(updated) > 64:
            return {**unknown, 'state': 'unavailable'}
        timestamp = datetime.datetime.fromisoformat(updated.replace('Z', '+00:00'))
        if timestamp.tzinfo is None:
            return {**unknown, 'state': 'unavailable'}
        age = (datetime.datetime.now(datetime.timezone.utc) - timestamp).total_seconds() * 1000
        exit_code = record.get('exitCode')
        if exit_code is not None and (type(exit_code) is not int or not 0 <= exit_code <= 255):
            return {**unknown, 'state': 'unavailable'}
        try:
            boot_id = boot_path.read_text().strip()
        except OSError:
            boot_id = None
        if state == 'running' and boot_id and record.get('bootId') and record['bootId'] != boot_id:
            state = 'interrupted'
        return {'state': state, 'phase': phase, 'updatedAt': updated,
                'updatedAgeMs': round(age) if age >= 0 else None, 'exitCode': exit_code}
    except FileNotFoundError:
        return unknown
    except (OSError, ValueError, TypeError, OverflowError):
        return {**unknown, 'state': 'unavailable'}


class ReceiverProbe:
    """Check the operator page, not dongle health; one bounded probe per 2 s."""
    def __init__(self, port=8080):
        self.port, self.checked, self.ready = port, float('-inf'), False
        self.lock = threading.Lock()

    def available(self):
        with self.lock:
            if time.monotonic() - self.checked < 2:
                return self.ready
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=0.5)
            try:
                connection.request('HEAD', '/')
                response = connection.getresponse()
                self.ready = response.status == 200 and response.getheader('Content-Type', '').startswith('text/html')
            except (OSError, http.client.HTTPException):
                self.ready = False
            finally:
                connection.close()
                self.checked = time.monotonic()
            return self.ready


class StatusServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 8

    def __init__(self, address, root=ROOT, status=STATUS, boot_id=BOOT_ID, probe=None):
        self.assets = {}
        for route, (filename, content_type) in ASSETS.items():
            body = (root / filename).read_bytes()
            self.assets[route] = (content_type, body, gzip.compress(body) if not content_type.startswith('font/') else None)
        self.status_path, self.boot_id_path = status, boot_id
        self.probe = probe or ReceiverProbe()
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, StatusHandler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(3)
        return connection, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class StatusHandler(BaseHTTPRequestHandler):
    server_version = 'WaveKit'
    sys_version = ''

    def log_message(self, _format, *_args):
        # No request paths, headers or arbitrary client text in the journal.
        pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        route = self.path.split('?', 1)[0]
        compressed = False
        if route == '/api/setup':
            record = setup_status(self.server.status_path, self.server.boot_id_path)
            body = json.dumps({**record, 'receiverPageReady': self.server.probe.available()}).encode()
            content_type = 'application/json; charset=utf-8'
        elif route in self.server.assets:
            content_type, body, gzipped = self.server.assets[route]
            if gzipped and 'gzip' in self.headers.get('Accept-Encoding', '').split(', '):
                body, compressed = gzipped, True
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store' if route in ('/', '/api/setup') else 'no-cache')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Vary', 'Accept-Encoding')
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)


def main():
    # Linux dual-stack socket accepts IPv4 and IPv6, including mDNS AAAA answers.
    class DualStackServer(StatusServer):
        address_family = socket.AF_INET6

        def server_bind(self):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            super().server_bind()

    with DualStackServer(('::', 80)) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
