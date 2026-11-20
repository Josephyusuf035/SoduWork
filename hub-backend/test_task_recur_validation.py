"""Recurrence input validation, atomic rejection, and legacy PUT replay."""
import unittest

from sqlalchemy import func, select

import test_unified_requirements as fixture
from app import models


class TaskRecurValidationTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.UnifiedRequirementTests.asyncSetUp
    asyncTearDown = fixture.UnifiedRequirementTests.asyncTearDown
    call = fixture.UnifiedRequirementTests.call

    async def snapshot(self):
        async with self.sessions() as session:
            rows = (await session.execute(select(models.Task).order_by(models.Task.id))).scalars().all()
            tasks = [(t.id, t.title, t.note, t.recur, t.recur_at, t.status) for t in rows]
            counts = [await session.scalar(select(func.count()).select_from(model))
                      for model in (models.TaskEvent, models.MateMessage, models.TaskNotificationOutbox)]
            return tasks, counts

    async def test_unknown_strings_rejected_on_create_patch_put_and_batch(self):
        for value in ("every-blue-moon", "DAILY", " daily ", " "):
            for method, path, body in (
                ("POST", "tasks", {"title": "Rejected", "recur": value}),
                ("PUT", "tasks/offline-new", {"title": "Rejected", "recur": value}),
                ("PUT", "tasks/private", {"title": "Rejected", "recur": value}),
                ("PATCH", "tasks/private", {"note": "Must not persist", "recur": value}),
                ("POST", "tasks/batch-update", {"ids": ["private", "shared"],
                                               "patch": {"note": "Must not persist", "recur": value}}),
            ):
                with self.subTest(value=value, method=method, path=path):
                    before = await self.snapshot()
                    response = await self.call(method, path, json=body)
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("recur", response.json()["detail"])
                    self.assertEqual(await self.snapshot(), before)

    async def test_non_string_types_keep_schema_rejection(self):
        for value in ({}, [], 0, 1, True, False):
            for method, path in (("POST", "tasks"), ("PUT", "tasks/new-type"), ("PATCH", "tasks/private")):
                before = await self.snapshot()
                response = await self.call(method, path, json={"recur": value})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(await self.snapshot(), before)

    async def test_valid_rules_clearing_and_empty_values_keep_existing_storage(self):
        for value in ("daily", "weekly", "monthly", None, ""):
            with self.subTest(value=value):
                body = {"title": "Synthetic recurrence", "recur": value}
                response = await self.call("POST", "tasks", json=body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["recur"], value or None)
                tid = response.json()["id"]
                for method in ("PATCH", "PUT"):
                    response = await self.call(method, "tasks/" + tid, json={"recur": value})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["recur"], value)
                response = await self.call("POST", "tasks/batch-update",
                    json={"ids": [tid, "private"], "patch": {"recur": value}})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["updated"], 2)
        response = await self.call("POST", "tasks", json={"title": "No recurrence"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["recur"])

    async def seed_legacy(self):
        async with self.sessions() as session:
            row = await session.get(models.Task, "private")
            row.recur = "every-blue-moon"
            await session.commit()

    async def test_valid_offline_undo_keeps_rule_schedule_and_complete_text(self):
        for rule in ("daily", "weekly", "monthly"):
            tid = "valid-undo-" + rule
            body = {"title": "Historical " + "\U0001f680" * 210, "source": "source" * 30,
                    "note": "Keep offline content", "recur": rule, "recurAt": 1795248000000}
            created = await self.call("PUT", "tasks/" + tid, json=body)
            self.assertEqual(created.status_code, 200, created.text)
            deleted = await self.call("DELETE", "tasks/" + tid)
            self.assertEqual(deleted.status_code, 200, deleted.text)
            for _ in range(2):
                restored = await self.call("PUT", "tasks/" + tid, json=body)
                self.assertEqual(restored.status_code, 200, restored.text)
                for field, value in body.items():
                    self.assertEqual(restored.json()[field], value, field)
            async with self.sessions() as session:
                self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task).where(
                    models.Task.id == tid)), 1)

    async def test_unrelated_edits_and_same_value_put_preserve_legacy_rule(self):
        await self.seed_legacy()
        for method, body in (("PATCH", {"note": "Edited"}), ("PUT", {"note": "Replay without recur"}),
                             ("PUT", {"note": "Replay", "recur": "every-blue-moon"})):
            response = await self.call(method, "tasks/private", json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["recur"], "every-blue-moon")
        before = await self.snapshot()
        for method, value in (("PUT", "another-invalid-rule"), ("PATCH", "every-blue-moon")):
            response = await self.call(method, "tasks/private", json={"recur": value, "note": "Rejected"})
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(await self.snapshot(), before)
        response = await self.call("POST", "tasks/batch-update",
            json={"ids": ["private", "shared"], "patch": {"note": "Unrelated batch edit"}})
        self.assertEqual(response.status_code, 200, response.text)
        response = await self.call("PATCH", "tasks/private", json={"recur": None})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["recur"])

    async def test_legacy_value_does_not_allow_partial_batch_or_identity_bypass(self):
        await self.seed_legacy()
        before = await self.snapshot()
        response = await self.call("POST", "tasks/batch-update", json={"ids": ["private", "shared"],
            "patch": {"recur": "every-blue-moon", "note": "Must not persist"}})
        self.assertEqual(response.status_code, 400, response.text)
        for who in ("peer", "outsider"):
            response = await self.call("PUT", "tasks/private", who,
                                       json={"recur": "every-blue-moon", "note": "Forbidden"})
            self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(await self.snapshot(), before)

    async def test_offline_and_undo_invalid_rules_require_explicit_correction(self):
        # PUT has no trustworthy legacy marker for missing IDs. Do not silently
        # discard the rule or permit new invalid writes through offline replay.
        for tid in ("offline-recovery", "undo-recovery"):
            if tid == "undo-recovery":
                async with self.sessions() as session:
                    session.add(models.Task(id=tid, title="Historical", owner_client_id="owner",
                                            recur="every-blue-moon", origin="local"))
                    await session.commit()
                deleted = await self.call("DELETE", "tasks/" + tid)
                self.assertEqual(deleted.status_code, 200, deleted.text)
            original = {"title": "Historical", "note": "Keep all other content", "recur": "every-blue-moon"}
            before = await self.snapshot()
            response = await self.call("PUT", "tasks/" + tid, json=original)
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(await self.snapshot(), before)
            for _ in range(2):
                response = await self.call("PUT", "tasks/" + tid, json={**original, "recur": "weekly"})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["note"], original["note"])
                self.assertEqual(response.json()["recur"], "weekly")
            async with self.sessions() as session:
                self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task).where(
                    models.Task.id == tid)), 1)


if __name__ == "__main__":
    unittest.main()
