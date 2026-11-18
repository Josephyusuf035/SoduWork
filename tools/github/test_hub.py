"""Exercise the readiness waiter against transient network failures."""
from __future__ import annotations

import http.client
import subprocess
import unittest
from unittest.mock import patch

from hub import wait


class WaitRetriesTransientErrors(unittest.TestCase):
    def test_retries_incomplete_read_then_succeeds(self):
        calls = []

        def check():
            calls.append(1)
            if len(calls) < 3:
                raise http.client.IncompleteRead(b"partial")
            return "ready"

        with patch("hub.time.sleep"):
            self.assertEqual(wait(check, seconds=60), "ready")
        self.assertEqual(len(calls), 3)

    def test_retries_remote_disconnected_then_succeeds(self):
        calls = []

        def check():
            calls.append(1)
            if len(calls) < 2:
                raise http.client.RemoteDisconnected("remote end closed")
            return "ready"

        with patch("hub.time.sleep"):
            self.assertEqual(wait(check, seconds=60), "ready")
        self.assertEqual(len(calls), 2)

    def test_still_retries_value_error_from_require(self):
        """Regression: the pre-existing ValueError retry behaviour is kept."""
        calls = []

        def check():
            calls.append(1)
            if len(calls) < 3:
                raise ValueError("not ready yet")
            return "ready"

        with patch("hub.time.sleep"):
            self.assertEqual(wait(check, seconds=60), "ready")
        self.assertEqual(len(calls), 3)

    def test_still_retries_called_process_error(self):
        calls = []

        def check():
            calls.append(1)
            if len(calls) < 2:
                raise subprocess.CalledProcessError(1, "pg_isready")
            return "ready"

        with patch("hub.time.sleep"):
            self.assertEqual(wait(check, seconds=60), "ready")
        self.assertEqual(len(calls), 2)

    def test_raises_last_http_exception_after_window(self):
        """A permanently failing probe still surfaces the real error at timeout."""
        calls = []
        last = http.client.IncompleteRead(b"partial")

        def check():
            calls.append(1)
            raise last

        # Enter the loop once (monotonic=0 < end=10); after the probe raises,
        # the next monotonic reading is past the deadline so the caught error
        # is re-raised verbatim rather than replaced by TimeoutError.
        # monotonic is read three times: once for `end`, once for the loop
        # condition, and once in the except branch to decide re-raise.
        ticks = iter([0, 0, 11])
        with patch("hub.time.monotonic", side_effect=lambda: next(ticks)), \
                patch("hub.time.sleep"):
            with self.assertRaises(http.client.IncompleteRead) as ctx:
                wait(check, seconds=10)
        self.assertIs(ctx.exception, last)
        self.assertEqual(len(calls), 1)

    def test_non_transient_error_is_not_swallowed(self):
        def check():
            raise TypeError("programmer error")

        with patch("hub.time.sleep"):
            with self.assertRaises(TypeError):
                wait(check, seconds=60)


if __name__ == "__main__":
    unittest.main()
