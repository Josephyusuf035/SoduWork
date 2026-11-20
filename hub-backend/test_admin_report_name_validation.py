"""Isolated HTTP regressions for report dates and professional profile names."""
import importlib
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin, work_catalog
from app.db import Base, get_session
from app.deps import current_user
from app.permissions import ALL_KEYS
from app.services import daily_report, team_daily_report, llm

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class AdminReportNameValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.users = {
            "admin": models.User(id="validation-admin", username="validation-admin", is_super=True,
                                 is_active=True, org_id="validation-org"),
            "manager": models.User(id="validation-manager", username="validation-manager",
                                   is_active=True, org_id="validation-org"),
            "denied": models.User(id="validation-denied", username="validation-denied", is_active=True),
        }
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="validation-org", name="Synthetic organization"),
                models.OrgUnit(id="validation-other", name="Other organization"),
                models.User(id="validation-outsider", username="validation-outsider",
                            org_id="validation-other", is_active=True),
                *self.users.values(),
            ])
            await session.commit()
        self.users["admin"]._perms = set(ALL_KEYS)
        self.users["manager"]._perms = {"task.view", "work.catalog.manage", "position.manage"}
        self.users["denied"]._perms = set()
        app = FastAPI()
        app.include_router(admin.router)
        app.include_router(work_catalog.admin_router)

        async def identity(request: Request):
            user = self.users.get(request.headers.get("X-Test-User"))
            if user is None:
                raise HTTPException(401, "Synthetic authentication required")
            return user

        async def db():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides.update({current_user: identity, get_session: db})
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                      base_url="http://isolated")
        self.addAsyncCleanup(self.http.aclose)
        model = patch.object(llm, "chat", new=AsyncMock(return_value=None))
        self.model = model.start()
        self.addCleanup(model.stop)
        publisher = patch("app.realtime.hub.publish", new_callable=AsyncMock)
        publisher.start()
        self.addCleanup(publisher.stop)

    async def call(self, method, path, *, who="admin", **kwargs):
        headers = {"X-Test-User": who} if who else {}
        return await self.http.request(method, "/api/v1/admin/" + path, headers=headers, **kwargs)

    async def counts(self):
        async with self.sessions() as session:
            return [await session.scalar(select(func.count()).select_from(model))
                    for model in (models.DailyReport, models.TeamDailyReport, models.AuditLog, models.Position)]

    async def test_invalid_dates_fail_before_generation_or_audit(self):
        before = await self.counts()
        invalid = ["not-a-date", "2026-02-30", "2025-02-29", "2026-13-01", "2026-11-20T00:00:00"]
        with patch.object(daily_report, "generate_for", new_callable=AsyncMock) as personal, \
             patch.object(team_daily_report, "generate_scope", new_callable=AsyncMock) as teams:
            for value in invalid:
                with self.subTest(value=value):
                    for method in ("GET", "POST"):
                        response = await self.call(method, "daily-reports" if method == "GET" else "daily-reports/generate",
                            **({"params": {"date": value}} if method == "GET" else {"json": {"date": value}}))
                        self.assertEqual(response.status_code, 400, response.text)
                        self.assertIn("YYYY-MM-DD", response.json()["detail"])
            for value in ({}, {"a": 1}, [], ["2026-11-20"], 0, 1, True, False):
                response = await self.call("POST", "daily-reports/generate", json={"date": value})
                self.assertEqual(response.status_code, 400, response.text)
            personal.assert_not_awaited()
            teams.assert_not_awaited()
        self.assertEqual(await self.counts(), before)

    async def test_valid_dates_and_defaults_keep_existing_contract(self):
        with patch.object(daily_report, "today_str", return_value="2026-11-20"):
            for body in ({}, {"date": None}, {"date": ""}, {"date": " \t "},
                         {"date": "2024-02-29"}, {"date": "20261120"}, {"date": "2026-W47-5"}):
                with self.subTest(body=body):
                    response = await self.call("POST", "daily-reports/generate", json=body)
                    self.assertEqual(response.status_code, 200, response.text)
                    expected = (body.get("date") or "").strip() or "2026-11-20"
                    self.assertEqual(response.json()["date"], expected)
                    response = await self.call("GET", "daily-reports", params={"date": expected})
                    self.assertEqual(response.status_code, 200, response.text)
            for params in ({}, {"date": ""}, {"date": " \t "}):
                response = await self.call("GET", "daily-reports", params=params)
                self.assertEqual(response.status_code, 200, response.text)

    async def test_report_permissions_scope_and_internal_errors_are_preserved(self):
        for who, status in ((None, 401), ("denied", 403)):
            for method, path, kwargs in (("GET", "daily-reports", {"params": {"date": "bad"}}),
                                         ("POST", "daily-reports/generate", {"json": {"date": "bad"}})):
                response = await self.call(method, path, who=who, **kwargs)
                self.assertEqual(response.status_code, status, response.text)
        response = await self.call("POST", "daily-reports/generate", who="manager",
                                   json={"date": "2026-11-20", "userId": "validation-outsider"})
        self.assertEqual(response.status_code, 403, response.text)
        with patch.object(team_daily_report, "overview", side_effect=ValueError("Synthetic internal error")):
            response = await self.call("GET", "daily-reports", params={"date": "2026-11-20"})
            self.assertEqual(response.status_code, 500)

    async def test_profile_name_types_rejected_on_new_and_legacy_routes(self):
        for path in ("work-catalog/professions", "positions"):
            created = await self.call("POST", path, json={"name": path, "orgId": "validation-org"})
            self.assertEqual(created.status_code, 200, created.text)
            tid = created.json()["id"]
            before = await self.counts()
            for value in ({}, {"a": 1}, [], ["name"], 0, 1, 1.5, True, False):
                with self.subTest(path=path, value=value):
                    response = await self.call("POST", path, json={"name": value, "orgId": "validation-org"})
                    self.assertEqual(response.status_code, 400, response.text)
                    response = await self.call("PATCH", path + "/" + tid,
                                               json={"name": value, "description": "Must not persist"})
                    self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(await self.counts(), before)
            async with self.sessions() as session:
                row = await session.get(models.Position, tid)
                self.assertEqual(row.name, path)
                self.assertEqual(row.description, "")

    async def test_profile_normal_names_partial_updates_and_scoped_duplicates(self):
        path = "work-catalog/professions"
        for value in (None, "", " \t "):
            response = await self.call("POST", path, json={"name": value})
            self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual((await self.call("POST", path, json={})).status_code, 400)
        name = "职业 Profile " + "长" * 50
        created = await self.call("POST", path, json={"name": "  " + name, "orgId": "validation-org"})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["name"], name[:48])
        tid = created.json()["id"]
        response = await self.call("PATCH", path + "/" + tid, json={"description": "Updated"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["name"], name[:48])
        for value in (None, "", " \t "):
            response = await self.call("PATCH", path + "/" + tid, json={"name": value})
            self.assertEqual(response.status_code, 400, response.text)
        duplicate = await self.call("POST", path, json={"name": name.lower(), "orgId": "validation-org"})
        self.assertEqual(duplicate.status_code, 400, duplicate.text)
        other = await self.call("POST", path, json={"name": name, "orgId": "validation-other"})
        self.assertEqual(other.status_code, 200, other.text)
        denied = await self.call("POST", path, who="manager", json={"name": "Valid", "orgId": "validation-other"})
        self.assertEqual(denied.status_code, 403, denied.text)


if __name__ == "__main__":
    unittest.main()
