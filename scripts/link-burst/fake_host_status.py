"""Run the capacity fake rtl_tcp with its statistics in the sdr-host status shape.

The core reads upstream drops only from an sdr-host `/api/status` body
(`rtlmux.stats.clientDetails[].bytesDropped`); without them every interval's
evidence is incomplete and attributed `unknown`.
"""
import sys

sys.path.insert(0, "/opt")
import fake_rtl_tcp  # noqa: E402


def snapshot(self):
    with self.lock:
        return {"rtlmux": {"running": True, "stats": {
            "clients": 1, "bytesPerSec": 0, "totalBytesSent": self.sent,
            "clientDetails": [{"id": 0, "address": "core", "bytesDropped": self.dropped}]}}}


fake_rtl_tcp.StreamStats.snapshot = snapshot
fake_rtl_tcp.main()
