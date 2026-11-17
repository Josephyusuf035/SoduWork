"""Rework policy (onFailure / onReject) normalization for plugin workflows."""
import json
import os
from pathlib import Path
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import plugin_packages


PLUGINS = Path(__file__).resolve().parent / "plugins"


def fixture(on_failure="implement"):
    """A minimal workflow whose quality node carries the given onFailure value."""
    return {
        "schemaVersion": 1,
        "key": "rework-policy", "version": "1.0.0", "name": "返工策略样例",
        "description": "校验工作流节点返工策略的写法。",
        "instructions": "按流程产出可验证结果。",
        "workflow": {"nodes": [
            {"key": "implement", "type": "ai", "config": {
                "prompt": "实现成品", "agentKind": "local:codex"},
             "outputs": [{"key": "result", "kind": "file",
                          "path": "impl/README.md", "required": True}]},
            {"key": "quality", "type": "quality", "dependsOn": ["implement"],
             "config": {"commands": [{"name": "test", "argv": ["python3", "tests.py"]}],
                        "onFailure": on_failure},
             "inputs": [], "outputs": []},
        ]},
    }


class PluginReworkPolicyTests(unittest.TestCase):
    def test_string_on_failure_is_rejected_with_node_key(self):
        manifest = fixture(on_failure="implement")
        with self.assertRaisesRegex(ValueError, "quality"):
            plugin_packages.normalize(manifest)

    def test_string_on_reject_is_rejected_with_node_key(self):
        manifest = fixture(on_failure={"retryFrom": "implement", "maxRounds": 2})
        manifest["workflow"]["nodes"][1]["config"]["onReject"] = "implement"
        with self.assertRaisesRegex(ValueError, "quality"):
            plugin_packages.normalize(manifest)

    def test_non_object_policy_is_rejected(self):
        for bad in ("implement", 3, ["implement"], None):
            with self.subTest(value=bad):
                manifest = fixture(on_failure=bad)
                with self.assertRaisesRegex(ValueError, "quality"):
                    plugin_packages.normalize(manifest)

    def test_empty_retry_from_is_rejected(self):
        for retry_from in ("", "   ", None, 0):
            with self.subTest(retry_from=retry_from):
                manifest = fixture(on_failure={"retryFrom": retry_from, "maxRounds": 2})
                with self.assertRaisesRegex(ValueError, "quality"):
                    plugin_packages.normalize(manifest)

    def test_object_policy_passes(self):
        manifest = fixture(on_failure={"retryFrom": "implement", "maxRounds": 2})
        normalized, workflow, _report = plugin_packages.normalize(manifest)
        self.assertEqual(normalized["key"], "rework-policy")
        quality = next(node for node in workflow["nodes"] if node["key"] == "quality")
        self.assertEqual(quality["config"]["onFailure"],
                         {"retryFrom": "implement", "maxRounds": 2})

    def test_absent_policy_keeps_existing_behavior(self):
        manifest = fixture()
        del manifest["workflow"]["nodes"][1]["config"]["onFailure"]
        normalized, workflow, _report = plugin_packages.normalize(manifest)
        quality = next(node for node in workflow["nodes"] if node["key"] == "quality")
        self.assertNotIn("onFailure", quality["config"])

    def test_all_bundled_plugins_pass_normalize(self):
        for path in sorted(PLUGINS.glob("*.json")):
            with self.subTest(plugin=path.name):
                raw = json.loads(path.read_text(encoding="utf-8"))
                plugin_packages.normalize(raw)


if __name__ == "__main__":
    unittest.main()