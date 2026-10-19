import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bootstrap_mcp", Path(__file__).with_name("bootstrap-mcp.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class FakeApi:
    def __init__(self, test):
        self.test = test
        self.user = None
        self.creates = 0
        self.requests = []
        self.password = None
        self.role = "REVIEWER"
        self.lose_create_response = False
        self.models = [{"id": "model-1", "display_name": "公司默认模型", "model_name": "glm5.3-flash",
                        "enabled": True, "has_api_key": True}]

    def find_system_user(self):
        return self.user

    def request(self, method, path, body=None, token=None, admin=False):
        self.requests.append((method, path, body, admin))
        if path == "/auth/v1/admin/users":
            self.creates += 1
            saved = bootstrap.read_env(self.test.config, compose=True)
            self.test.assertEqual(saved["CRP_PASSWORD"], body["password"])
            self.password = body["password"]
            self.user = {"id": "user-1", "email": bootstrap.SYSTEM_EMAIL,
                         "app_metadata": body["app_metadata"]}
            if self.lose_create_response:
                self.lose_create_response = False
                raise bootstrap.BootstrapError("creation result unknown")
            return self.user
        if path.startswith("/auth/v1/token"):
            self.test.assertEqual(body["password"], self.password)
            return {"access_token": "ordinary-user-session", "user": {"id": "user-1"}}
        if path.startswith("/rest/v1/user_profile"):
            self.test.assertEqual(token, "ordinary-user-session")
            self.test.assertFalse(admin)
            return [{"id": "user-1", "role": self.role}]
        if path == "/rest/v1/rpc/list_enabled_model_configs":
            self.test.assertFalse(admin)
            return self.models
        if path.startswith("/auth/v1/logout"):
            self.test.assertEqual(token, "ordinary-user-session")
            return None
        raise AssertionError("unexpected request " + path)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="crp-bootstrap-test-")
        self.root = Path(self.temporary.name)
        self.server = self.root / "supabase.env"
        self.server.write_text('ANON_KEY=test-anon\nSERVICE_ROLE_KEY=private-admin-key\nUNRELATED="unparsed value" # ignored\n')
        self.config = self.root / ".docker/mcp.selfhost.env"
        self.api = FakeApi(self)
        self.output = io.StringIO()

    def tearDown(self):
        self.temporary.cleanup()

    def prepare(self, apply=True):
        with contextlib.redirect_stdout(self.output):
            return bootstrap.prepare(self.server, self.config, "http://127.0.0.1:54321",
                                     apply=apply, api_factory=lambda *_: self.api)

    def test_first_run_uses_auth_api_reviewer_and_exact_model_id(self):
        values = self.prepare()
        self.assertEqual(self.api.creates, 1)
        self.assertEqual(values["CRP_EMAIL"], bootstrap.SYSTEM_EMAIL)
        self.assertEqual(values["CRP_DEFAULT_MODEL"], "model-1")
        self.assertGreaterEqual(len(values["CRP_PASSWORD"]), 32)
        self.assertTrue(values["CRP_MCP_TOKENS"].startswith("crp-default:"))
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertNotIn("private-admin-key", self.config.read_text())
        self.assertNotIn(values["CRP_PASSWORD"], self.output.getvalue())
        self.assertNotIn(values["CRP_MCP_TOKENS"], self.output.getvalue())
        created = self.api.requests[0][2]
        self.assertTrue(created["email_confirm"])
        self.assertEqual(created["app_metadata"]["crp_system_account"], bootstrap.SYSTEM_MARKER)

    def test_repeat_does_not_reset_identity_password_or_caller_token(self):
        first = self.prepare()
        content = self.config.read_bytes()
        second = self.prepare()
        self.assertEqual(first, second)
        self.assertEqual(content, self.config.read_bytes())
        self.assertEqual(self.api.creates, 1)

    def test_dry_run_does_not_create_files_users_or_sessions(self):
        values = self.prepare(apply=False)
        self.assertEqual(values["CRP_DEFAULT_MODEL"], "glm5.3-flash")
        self.assertFalse(self.config.parent.exists())
        self.assertEqual(self.api.requests, [])
        self.assertEqual(self.api.creates, 0)

    def test_lost_creation_response_reuses_saved_password_next_run(self):
        self.api.lose_create_response = True
        with self.assertRaises(bootstrap.BootstrapError):
            self.prepare()
        password = bootstrap.read_env(self.config, compose=True)["CRP_PASSWORD"]
        result = self.prepare()
        self.assertEqual(result["CRP_PASSWORD"], password)
        self.assertEqual(self.api.creates, 1)

    def test_existing_managed_user_without_saved_password_is_not_reset(self):
        self.api.user = {"id": "user-1"}
        with self.assertRaisesRegex(bootstrap.BootstrapError, "本地密码缺失"):
            self.prepare()
        self.assertFalse(self.config.exists())
        self.assertEqual(self.api.creates, 0)

    def test_admin_changed_role_is_not_elevated(self):
        self.api.role = "VIEWER"
        with self.assertRaisesRegex(bootstrap.BootstrapError, "不会自动提升"):
            self.prepare()
        self.assertFalse(any(method == "PUT" for method, *_ in self.api.requests))

    def test_custom_account_and_tokens_are_preserved(self):
        self.config.parent.mkdir()
        values = {"CRP_EMAIL": "custom@example.invalid", "CRP_PASSWORD": "pass $word ' quote \" \\",
                  "CRP_MCP_TOKENS": "custom:0123456789abcdef", "CRP_DEFAULT_MODEL": "model-1"}
        bootstrap.save_env(self.config, values)
        self.api.password = values["CRP_PASSWORD"]
        self.api.role = "ADMIN"
        result = self.prepare()
        self.assertEqual(result["CRP_EMAIL"], values["CRP_EMAIL"])
        self.assertEqual(result["CRP_PASSWORD"], values["CRP_PASSWORD"])
        self.assertEqual(result["CRP_MCP_TOKENS"], values["CRP_MCP_TOKENS"])
        self.assertEqual(self.api.creates, 0)

    def test_unmanaged_email_collision_is_rejected(self):
        api = bootstrap.LocalApi("http://127.0.0.1:54321", "anon", "admin")
        api.request = lambda *_, **__: {"users": [{"id": "human", "email": bootstrap.SYSTEM_EMAIL,
                                                   "user_metadata": {"crp_system_account": bootstrap.SYSTEM_MARKER}}]}
        with self.assertRaisesRegex(bootstrap.BootstrapError, "非托管账号占用"):
            api.find_system_user()

    def test_model_name_is_unique_and_requires_enabled_key(self):
        model = self.api.models[0]
        self.assertEqual(bootstrap.resolve_model([model], "glm5.3-flash")["id"], "model-1")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "多个配置"):
            bootstrap.resolve_model([model, dict(model, id="model-2")], "glm5.3-flash")
        for row in (dict(model, enabled=False), dict(model, has_api_key=False)):
            with self.assertRaisesRegex(bootstrap.BootstrapError, "不可用"):
                bootstrap.resolve_model([row], "glm5.3-flash")

    def test_default_model_uses_model_value_before_an_unrelated_display_label(self):
        unrelated = {"id": "wrong-model", "display_name": "glm5.3-flash", "model_name": "other-model"}
        result = bootstrap.resolve_model([unrelated, self.api.models[0]], "glm5.3-flash")
        self.assertEqual(result["id"], "model-1")

    def test_no_outbound_admin_key_transport_or_redirects(self):
        for url in ("https://example.com", "http://user:pass@localhost", "http://localhost/other"):
            with self.assertRaises(bootstrap.BootstrapError):
                bootstrap.LocalApi(url, "anon", "admin")
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://example.com")

    def test_env_file_roundtrip_and_admin_key_rejection(self):
        values = {"CRP_PASSWORD": "x $WORD ${VAR} # \" quote ' slash \\"}
        bootstrap.save_env(self.config, values)
        self.assertEqual(bootstrap.read_env(self.config, compose=True), values)
        bootstrap.save_env(self.config, {"SUPABASE_SERVICE_ROLE_KEY": "private-admin-key"})
        with self.assertRaisesRegex(bootstrap.BootstrapError, "管理密钥"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
