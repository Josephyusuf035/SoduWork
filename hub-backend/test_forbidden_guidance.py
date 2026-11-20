"""Public 403 guidance stays actionable without exposing upstream details."""
import json
import os
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "forbidden-guidance-isolated-test-secret")
os.environ.setdefault("ADMIN_PASS", "forbidden-guidance-isolated-test-password")

from app.api import ai_proxy
from app.services import model_errors


class ForbiddenGuidanceTests(unittest.TestCase):
    def test_proxy_reports_configuration_choices_without_echoing_provider_body(self):
        raw = json.dumps({"error": {"message": "secret-canary https://private.invalid"}})
        for responses in (False, True):
            response = ai_proxy._proxy_error(model_errors.UpstreamError(403, raw), responses=responses)
            payload = json.loads(response.body)
            self.assertEqual(response.status_code, 403)
            self.assertEqual(payload["error"]["status"], 403)
            message = payload["error"]["message"]
            for hint in ("模型权限", "API Key 类型", "接口地址"):
                self.assertIn(hint, message)
            self.assertNotIn("secret-canary", response.body.decode())
            self.assertNotIn("private.invalid", response.body.decode())

    def test_shared_failure_classifier_retains_the_safe_guidance(self):
        message = model_errors.public_failure('HTTP 403 {"error":{"message":"secret-canary"}}')
        self.assertIn("API Key 类型", message)
        self.assertIn("HTTP 403", message)
        self.assertNotIn("secret-canary", message)

    def test_billing_classification_keeps_its_precedence(self):
        response = ai_proxy._proxy_error(model_errors.UpstreamError(
            403, json.dumps({"error": {"code": "insufficient_quota"}})))
        self.assertEqual(json.loads(response.body)["error"]["code"], "upstream_billing_error")


if __name__ == "__main__":
    unittest.main()
