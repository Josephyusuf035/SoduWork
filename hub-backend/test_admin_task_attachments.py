"""Administrator task attachments must each keep their own stored object."""
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-admin-attachment-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import Request
from sqlalchemy import select

from app import models
from app.api import admin
from app.deps import current_user
from app.services import resource_access, storage
import test_unified_requirements as unified


class AdminTaskAttachmentTests(unittest.IsolatedAsyncioTestCase):
    # Reuse the fixture without importing its test class into this module,
    # which would make unittest collect and rerun the whole suite here.
    asyncTearDown = unified.UnifiedRequirementTests.asyncTearDown
    call = unified.UnifiedRequirementTests.call

    async def asyncSetUp(self):
        await unified.UnifiedRequirementTests.asyncSetUp(self)
        self.app.include_router(admin.router)
        async with self.sessions() as session:
            (await session.get(models.User, "owner")).is_super = True
            await session.commit()

        async def administrator(request: Request):
            async with self.sessions() as session:
                user = await session.get(models.User, "owner")
                user._perms = {"task.dispatch"}
                return user
        self.app.dependency_overrides[current_user] = administrator
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.enterContext(patch.object(storage, "_LOCAL_DIR", folder.name))
        self.enterContext(patch.object(storage, "backend_name", return_value="local"))
        self.enterContext(patch("app.services.audit.log", new_callable=AsyncMock))

    async def upload(self, content):
        response = await self.call("POST", "admin/tasks/shared/attachments",
                                   files={"file": ("plan.txt", content, "text/plain")})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_same_filename_uploads_do_not_overwrite_each_other(self):
        first = await self.upload(b"first version")
        second = await self.upload(b"second version, longer")
        async with self.sessions() as session:
            rows = {row.id: row for row in await session.scalars(select(models.Attachment).where(
                models.Attachment.id.in_([first["id"], second["id"]])))}
        keys = {row.storage_key for row in rows.values()}
        self.assertEqual(len(keys), 2, keys)
        for row in rows.values():
            self.assertIn("/" + row.id + "/", row.storage_key)
            self.assertNotIn("/None/", row.storage_key)
        self.assertEqual(storage.get(rows[first["id"]].storage_key, "local"), b"first version")
        self.assertEqual(storage.get(rows[second["id"]].storage_key, "local"), b"second version, longer")
        # Both versions download intact through the public attachment route.
        for uploaded, content in ((first, b"first version"), (second, b"second version, longer")):
            response = await self.http.get(resource_access.attachment_url(uploaded["id"]))
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.content, content)
            self.assertEqual(response.headers["content-length"], str(len(content)))


if __name__ == "__main__":
    unittest.main()
