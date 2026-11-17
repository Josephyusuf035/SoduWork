"""Regression tests: dict-body numeric fields and timezone keys must fail with 4xx, not 5xx.

Covers the unguarded int() coercions in the schedule contract, the domains sort
column (TEXT silently persisted into an Integer column on SQLite), and the
ZoneInfo ValueError path in clean_time_zone.
"""
import importlib
import os
from pathlib import Path
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import sign_token
from app.db import Base, get_session
from app.services.schedules import DEFAULT_TIME_ZONE, clean_time_zone

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class InputValidationRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="root", username="root", display_name="root",
                                    is_super=True, is_active=True, auth_version=1))
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                     base_url="http://isolated",
                                     headers={"Authorization": "Bearer " + sign_token("root", 1)})

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def test_schedule_numeric_fields_reject_non_integers(self):
        for field, value in (("atHour", "abc"), ("atMinute", "3.5"), ("weekday", "x"),
                             ("retryLimit", {"x": 1}), ("retryDelayMinutes", "1e3")):
            with self.subTest(field=field):
                r = await self.http.post("/api/v1/admin/ai-schedules",
                                         json={"title": "regression", field: value})
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn(field, r.json()["detail"])

    async def test_schedule_numeric_strings_keep_legacy_coercion(self):
        r = await self.http.post("/api/v1/admin/ai-schedules",
                                 json={"title": "regression", "atHour": "9"})
        # Coercion succeeds; the request then fails on the missing assignee, not on int().
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"], "请先选择执行底座")

    async def test_malformed_timezone_falls_back_instead_of_crashing(self):
        for bad in ("../foo", "/etc/passwd", "Bad/Zone"):
            self.assertEqual(clean_time_zone(bad), DEFAULT_TIME_ZONE)
        self.assertEqual(clean_time_zone("Asia/Shanghai"), "Asia/Shanghai")
        r = await self.http.post("/api/v1/admin/ai-schedules",
                                 json={"title": "regression", "timeZone": "../foo"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"], "请先选择执行底座")

    async def test_domain_create_rejects_non_integer_sort(self):
        for value in ("abc", {"x": 1}, "3.5"):
            with self.subTest(value=value):
                r = await self.http.post("/api/v1/admin/domains",
                                         json={"name": "regression", "sort": value})
                self.assertEqual(r.status_code, 400, r.text)

    async def test_domain_patch_rejects_non_integer_sort_and_keeps_column_int(self):
        r = await self.http.post("/api/v1/admin/domains", json={"name": "regression", "sort": 2})
        self.assertEqual(r.status_code, 200, r.text)
        did = r.json()["id"]
        for value in ("abc", {"x": 1}):
            with self.subTest(value=value):
                r = await self.http.patch(f"/api/v1/admin/domains/{did}", json={"sort": value})
                self.assertEqual(r.status_code, 400, r.text)
        r = await self.http.get("/api/v1/admin/domains")
        row = [x for x in r.json() if x["id"] == did][0]
        self.assertEqual(row["sort"], 2)
        self.assertIsInstance(row["sort"], int)
        r = await self.http.patch(f"/api/v1/admin/domains/{did}", json={"sort": 5})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["sort"], 5)
        r = await self.http.patch(f"/api/v1/admin/domains/{did}", json={"name": "renamed"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["sort"], 5)


if __name__ == "__main__":
    unittest.main()