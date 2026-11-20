"""Approval discovery against a real isolated SQLite database and HTTP routes.

Device authentication is the only dependency substituted; pending permission,
co-sign decisions, evidence and paging use the production implementations.
"""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import approvals
from app.db import Base, get_session
from app.deps import current_client


class ApprovalInboxScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.clients = {}
        async with self.sessions() as session:
            for uid in ("alice", "bob", "outside"):
                session.add(models.User(id=uid, username=uid, display_name=uid, is_active=True))
                self.clients[uid] = models.Client(id=uid, user_ref=uid, auth_state="active")
                session.add(self.clients[uid])
            await session.commit()
        app = FastAPI()
        app.include_router(approvals.router)

        async def identity(request: Request):
            return self.clients[request.headers.get("X-Test-Identity", "alice")]

        async def database():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[current_client] = identity
        app.dependency_overrides[get_session] = database
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    def stage_seed(self, session, name, *, assignees=("alice",), required=1,
                   separated=False, index=0):
        """Stage evidence and immutable assignments without choosing transaction boundaries."""
        task = models.Task(id="task-" + name, title="Review " + name,
            note="Confirm the requirement scope", owner_client_id="alice", created_by="alice",
            assignee_user_id="alice", status="doing")
        artifact = am.ArtifactVersion(id="artifact-" + name, task_id=task.id, kind="requirement", seq=1,
            checksum="checksum-" + name, manifest={"title": task.title, "description": task.note,
                "acceptanceCriteria": ["The scope is clear"], "files": []})
        request = am.ApprovalRequest(id="request-" + name, task_id=task.id,
            artifact_version_id=artifact.id, action="baseline", required_count=required,
            policy_snapshot={"separationOfDuties": separated},
            created_at=datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(seconds=index))
        session.add_all([task, artifact, request])
        assignments = [
            am.ApprovalAssignment(request_id=request.id, user_id=uid, user_name=uid)
            for uid in assignees
        ]
        return request.id, task.id, assignments

    async def seed(self, name, *, assignees=("alice",), required=1, separated=False, index=0):
        async with self.sessions() as session:
            request_id, task_id, assignments = self.stage_seed(
                session, name, assignees=assignees, required=required,
                separated=separated, index=index)
            await session.flush()
            session.add_all(assignments)
            await session.commit()
        return request_id, task_id

    async def inbox(self, who="alice", query=""):
        response = await self.http.get("/api/v1/approvals" + query, headers={"X-Test-Identity": who})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_cosigner_completed_decision_is_not_pending_again(self):
        request_id, task_id = await self.seed("cosign", assignees=("alice", "bob"), required=2)
        response = await self.http.post("/api/v1/approvals/" + request_id + "/decision",
            headers={"X-Test-Identity": "alice"}, json={"decision": "approve", "note": "Scope checked"})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            request = await session.get(am.ApprovalRequest, request_id)
            self.assertEqual(request.status, "pending", "Bob still needs to co-sign")
        alice = await self.inbox()
        self.assertEqual(alice["items"], [])
        self.assertEqual(alice["pendingTasks"], [])
        self.assertEqual(alice["pendingCount"], 0)
        self.assertEqual(alice["doneCount"], 1)
        bob = await self.inbox("bob")
        self.assertEqual(bob["pendingTasks"], [{"taskId": task_id, "id": request_id, "action": "baseline", "artifactVersionId": "artifact-cosign"}])
        self.assertEqual(bob["pendingCount"], 1)
        done = await self.inbox(query="?view=done")
        self.assertEqual(done["items"][0]["myDecision"]["decision"], "approve")
        self.assertEqual(done["pendingTasks"], [])

    async def test_manual_rework_notice_matches_return_to_backlog(self):
        request_id, task_id = await self.seed("manual-rework", assignees=("bob",))
        async with self.sessions() as session:
            request = await session.get(am.ApprovalRequest, request_id)
            request.action = "review"
            # Delivery review is creator-owned; make the test actor the
            # requirement creator while keeping the execution device on Alice
            # so the owner notice path remains covered.
            task = await session.get(models.Task, task_id)
            task.created_by = "bob"
            artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
            artifact.kind = "files"
            artifact.manifest = {"schemaVersion": "2", "complete": True,
                                 "primary": [], "problems": [], "text": "The computed total is six."}
            await session.commit()
        with patch("app.realtime.hub.publish", new_callable=AsyncMock) as publish:
            response = await self.http.post("/api/v1/approvals/" + request_id + "/decision",
                headers={"X-Test-Identity": "bob"},
                json={"decision": "reject", "note": "Add the verification steps", "rework": False})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["rework"]["mode"], "backlog")
        self.assertFalse(response.json()["rework"]["automatic"])
        async with self.sessions() as session:
            task = await session.get(models.Task, task_id)
            self.assertEqual(task.status, "todo")
        notices = [call.args[1]["text"] for call in publish.await_args_list
                   if call.args[0] == "alice" and call.args[1].get("type") == "notice"]
        self.assertEqual(len(notices), 1)
        self.assertIn("已退回待开始", notices[0])
        self.assertNotIn("自动", notices[0])

    async def test_complete_references_are_independent_of_both_page_limits(self):
        assignments = []
        async with self.sessions() as session:
            for index in range(105):
                _request_id, _task_id, staged = self.stage_seed(
                    session, f"paged-{index:03}", index=index)
                assignments.extend(staged)
            await session.flush()
            session.add_all(assignments)
            await session.commit()
        normal = await self.inbox()
        self.assertEqual(len(normal["items"]), 60)
        self.assertEqual(normal["pendingCount"], 105)
        self.assertEqual(len(normal["pendingTasks"]), 105)
        self.assertEqual(normal["pendingTasks"][-1], {"id": "request-paged-104",
            "taskId": "task-paged-104", "action": "baseline", "artifactVersionId": "artifact-paged-104"})
        self.assertTrue(all(set(row) == {"id", "taskId", "action", "artifactVersionId"} for row in normal["pendingTasks"]))
        limited = await self.inbox(query="?limit=1000")
        self.assertEqual(len(limited["items"]), 100)
        self.assertEqual(limited["pendingTasks"], normal["pendingTasks"])
        history = await self.inbox(query="?view=done&limit=1")
        self.assertEqual(history["items"], [])
        self.assertEqual(history["pendingTasks"], normal["pendingTasks"])

    async def test_revoke_forbidden_matches_decision_without_mutating_approval(self):
        request_id, task_id = await self.seed("revoke-forbidden")
        pending_id, _ = await self.seed("decision-forbidden")
        async with self.sessions() as session:
            (await session.get(am.ApprovalRequest, request_id)).status = "approved"
            await session.commit()
        headers = {"X-Test-Identity": "outside"}
        with patch("app.realtime.hub.publish", new_callable=AsyncMock) as publish:
            response = await self.http.post(f"/api/v1/approvals/{request_id}/revoke",
                headers=headers, json={"note": "Fixture revocation"})
            decision = await self.http.post(f"/api/v1/approvals/{pending_id}/decision",
                headers=headers, json={"decision": "approve"})
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(decision.status_code, 403, decision.text)
        self.assertEqual(response.json(), decision.json())
        publish.assert_not_awaited()
        async with self.sessions() as session:
            request = await session.get(am.ApprovalRequest, request_id)
            self.assertEqual(request.status, "approved")
            self.assertIsNone(request.resolved_at)
            self.assertEqual((await session.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == task_id))).scalars().all(), [])

    async def test_revoke_conflicts_and_missing_request_keep_existing_statuses(self):
        for name, status, note, merged in (("no-note", "approved", "", False),
                                            ("pending", "pending", "Fixture", False),
                                            ("merged", "approved", "Fixture", True)):
            with self.subTest(name=name):
                request_id, task_id = await self.seed("revoke-" + name)
                async with self.sessions() as session:
                    request = await session.get(am.ApprovalRequest, request_id)
                    request.status = status
                    if merged:
                        artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
                        artifact.kind, artifact.state = "code", "merged"
                    await session.commit()
                response = await self.http.post(f"/api/v1/approvals/{request_id}/revoke", json={"note": note})
                self.assertEqual(response.status_code, 409, response.text)
                async with self.sessions() as session:
                    self.assertEqual((await session.get(am.ApprovalRequest, request_id)).status, status)
                    self.assertEqual((await session.execute(select(models.TaskEvent).where(
                        models.TaskEvent.task_id == task_id))).scalars().all(), [])
        response = await self.http.post("/api/v1/approvals/missing/revoke", json={"note": "Fixture"})
        self.assertEqual(response.status_code, 404, response.text)

    async def test_revoke_authorized_request_still_preserves_history(self):
        request_id, task_id = await self.seed("revoke-allowed")
        async with self.sessions() as session:
            request = await session.get(am.ApprovalRequest, request_id)
            request.status = "approved"
            (await session.get(am.ArtifactVersion, request.artifact_version_id)).state = "baselined"
            session.add(am.ApprovalDecision(request_id=request_id, user_id="alice", user_name="alice",
                                           decision="approve", note="Original decision"))
            await session.commit()
        with patch("app.realtime.hub.publish", new_callable=AsyncMock):
            response = await self.http.post(f"/api/v1/approvals/{request_id}/revoke",
                                            json={"note": "Fixture revocation"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        async with self.sessions() as session:
            request = await session.get(am.ApprovalRequest, request_id)
            self.assertEqual(request.status, "revoked")
            self.assertIsNotNone(request.resolved_at)
            self.assertEqual((await session.get(am.ArtifactVersion, request.artifact_version_id)).state, "candidate")
            decisions = (await session.execute(select(am.ApprovalDecision).where(
                am.ApprovalDecision.request_id == request_id))).scalars().all()
            self.assertEqual([row.note for row in decisions], ["Original decision"])
            events = (await session.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == task_id, models.TaskEvent.kind == "release.revoked"))).scalars().all()
            self.assertEqual(len(events), 1)

    async def test_references_respect_assignment_and_separation_and_ignore_others_waiting(self):
        await self.seed("mine")
        await self.seed("assigned-to-bob", assignees=("bob",))
        await self.seed("separated", assignees=("alice", "bob"), separated=True)
        alice = await self.inbox()
        self.assertEqual([row["id"] for row in alice["pendingTasks"]], ["request-mine"])
        self.assertEqual(alice["pendingCount"], 1)
        self.assertEqual({row["id"] for row in alice["mineWaiting"]},
                         {"request-assigned-to-bob", "request-separated"})
        bob = await self.inbox("bob")
        self.assertEqual({row["id"] for row in bob["pendingTasks"]},
                         {"request-assigned-to-bob", "request-separated"})
        outsider = await self.inbox("outside")
        self.assertEqual(outsider["items"], [])
        self.assertEqual(outsider["pendingTasks"], [])
        self.assertEqual(outsider["mineWaiting"], [])


if __name__ == "__main__":
    unittest.main()
