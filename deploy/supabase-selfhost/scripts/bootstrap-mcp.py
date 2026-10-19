#!/usr/bin/env python3
"""Prepare the local MCP identity/config without storing admin keys in MCP."""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

SYSTEM_EMAIL = "crp-mcp-system@internal.invalid"
SYSTEM_MARKER = "crp-mcp-system-v1"
DEFAULT_MODEL = "glm5.3-flash"


class BootstrapError(Exception):
    pass


def read_env(path, compose=False, only=None):
    if not path.exists():
        return {}
    if path.is_symlink():
        raise BootstrapError("配置文件不能是符号链接：" + str(path))
    values = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, raw = line.partition("=")
        key, raw = key.strip(), raw.strip()
        if only is not None and key not in only:
            continue
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise BootstrapError(f"配置第 {number} 行格式不合法；未输出该行内容")
        if key in values:
            raise BootstrapError("配置项重复：" + key)
        single_quoted = raw.startswith("'")
        try:
            if raw.startswith('"'):
                value = json.loads(raw)
            elif single_quoted:
                if not raw.endswith("'") or len(raw) < 2:
                    raise ValueError()
                value = raw[1:-1].replace("\\'", "'")
            else:
                value = raw.split(" #", 1)[0].rstrip()
        except (ValueError, json.JSONDecodeError):
            raise BootstrapError("配置引号或转义不合法：" + key) from None
        if not isinstance(value, str) or any(ord(c) < 32 for c in value):
            raise BootstrapError("配置值必须是单行文本：" + key)
        if compose and not single_quoted:
            escaped = value.replace("$$", "\0")
            if re.search(r"\$(?:[A-Za-z_]|\{)", escaped):
                raise BootstrapError("配置含环境变量插值；请使用单引号保存字面值：" + key)
            value = escaped.replace("\0", "$")
        values[key] = value
    return values


def save_env(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise BootstrapError("拒绝覆盖符号链接配置文件")
    # JSON double quotes cover spaces, quotes and backslashes; $$ protects
    # literal dollars from Compose interpolation. Never include admin keys.
    text = "".join(
        key + "=" + json.dumps(value, ensure_ascii=False).replace("$", "$$") + "\n"
        for key, value in values.items()
    )
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".mcp-env-", delete=False) as out:
            temporary = Path(out.name)
            os.chmod(out.name, 0o600)
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BootstrapError("本机 Supabase 接口发生重定向，已停止以保护凭证")


class LocalApi:
    def __init__(self, url, anon, service_key):
        parts = urlsplit(url)
        if (parts.scheme not in ("http", "https") or
                parts.hostname not in ("127.0.0.1", "localhost", "::1") or
                parts.username or parts.password or parts.query or parts.fragment or
                parts.path not in ("", "/")):
            raise BootstrapError("初始化只允许连接本机回环 Supabase URL")
        self.url = url.rstrip("/")
        self.anon = anon
        self.service_key = service_key
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None, token=None, admin=False):
        key = self.service_key if admin else self.anon
        request = Request(self.url + path, method=method,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"apikey": key, "Authorization": "Bearer " + (token or key),
                                   "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=15) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except HTTPError as error:
            # Auth responses can contain submitted data. Report only route and
            # status; never echo response bodies, passwords or access tokens.
            raise BootstrapError(f"本机接口 {path.split('?')[0]} 返回 HTTP {error.code}；请检查账号/服务状态") from None
        except (URLError, TimeoutError, json.JSONDecodeError):
            raise BootstrapError("本机 Supabase 请求失败或结果不明；配置已保留，可复核后重试") from None

    def find_system_user(self):
        for page in range(1, 101):
            result = self.request("GET", "/auth/v1/admin/users?" + urlencode({"page": page, "per_page": 1000}), admin=True)
            users = result.get("users") if isinstance(result, dict) else None
            if not isinstance(users, list):
                raise BootstrapError("Auth 用户清单格式异常")
            matches = [user for user in users if str(user.get("email", "")).lower() == SYSTEM_EMAIL]
            if len(matches) > 1:
                raise BootstrapError("存在重复的 MCP 系统账号，已停止")
            if matches:
                user = matches[0]
                if user.get("app_metadata", {}).get("crp_system_account") != SYSTEM_MARKER:
                    raise BootstrapError("MCP 系统邮箱已被非托管账号占用；不会接管或重置密码")
                return user
            if len(users) < 1000:
                return None
        raise BootstrapError("Auth 用户清单超出初始化查询上限")


def resolve_model(models, wanted):
    usable = [row for row in models if row.get("has_api_key") is not False and row.get("enabled") is not False]
    for field in ("id", "model_name", "display_name"):
        matches = [row for row in usable if str(row.get(field, "")).casefold() == wanted.casefold()]
        if len(matches) > 1:
            raise BootstrapError("MCP 默认模型匹配到多个配置，请用模型配置 id 明确指定")
        if matches:
            return matches[0]
    raise BootstrapError("MCP 默认模型不可用：" + wanted + "；请在模型管理启用该模型并配置密钥")


def verify_account(api, values, expected_user_id=None):
    session = api.request("POST", "/auth/v1/token?grant_type=password",
                          {"email": values["CRP_EMAIL"], "password": values["CRP_PASSWORD"]})
    token = session.get("access_token") if isinstance(session, dict) else None
    user_id = session.get("user", {}).get("id") if isinstance(session, dict) else None
    if not token or not user_id:
        raise BootstrapError("MCP 账号登录未返回有效用户会话")
    try:
        if expected_user_id is not None and user_id != expected_user_id:
            raise BootstrapError("MCP 账号登录身份与托管身份不符")
        query = urlencode({"id": "eq." + user_id, "select": "id,role"})
        profiles = api.request("GET", "/rest/v1/user_profile?" + query, token=token)
        role = profiles[0].get("role") if isinstance(profiles, list) and len(profiles) == 1 else None
        allowed = ("REVIEWER",) if expected_user_id else ("ADMIN", "REVIEWER")
        if role not in allowed:
            raise BootstrapError("MCP 账号权限不符合预期；不会自动提升或恢复管理员修改的角色")
        models = api.request("POST", "/rest/v1/rpc/list_enabled_model_configs", {}, token=token)
        if not isinstance(models, list):
            raise BootstrapError("可用模型清单格式异常")
        model = resolve_model(models, values["CRP_DEFAULT_MODEL"])
        if not model.get("id"):
            raise BootstrapError("可用模型缺少配置 id")
        return model
    finally:
        try:
            api.request("POST", "/auth/v1/logout?scope=local", token=token)
        except BootstrapError:
            pass


@contextmanager
def config_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.parent / ".mcp-bootstrap.lock", "a", encoding="utf-8") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def prepare(supabase_env, config_file, api_url, apply=False, api_factory=LocalApi):
    server = read_env(supabase_env, only={"ANON_KEY", "SERVICE_ROLE_KEY"})
    if not server.get("ANON_KEY") or not server.get("SERVICE_ROLE_KEY"):
        raise BootstrapError("Supabase .env 缺少 ANON_KEY 或 SERVICE_ROLE_KEY")

    def run():
        previous = read_env(config_file, compose=True)
        if any("SERVICE_ROLE" in key or key == "CRP_MCP_ENV_FILE" for key in previous):
            raise BootstrapError("MCP 运行配置不能包含管理密钥或重定向配置文件")
        values = dict(previous)
        values["CRP_SUPABASE_ANON_KEY"] = server["ANON_KEY"]
        values["CRP_EMAIL"] = values.get("CRP_EMAIL") or SYSTEM_EMAIL
        values["CRP_DEFAULT_MODEL"] = values.get("CRP_DEFAULT_MODEL") or DEFAULT_MODEL
        values["CRP_PLATFORM_WEB_URL"] = values.get("CRP_PLATFORM_WEB_URL") or "http://crp-review.kingdee.com"
        managed = values["CRP_EMAIL"].lower() == SYSTEM_EMAIL
        if not managed and not values.get("CRP_PASSWORD"):
            raise BootstrapError("已有自定义 MCP 邮箱但没有密码；不会覆盖为系统账号")
        if not apply:
            print("MCP 初始化预览：" + ("将创建或复用专用 REVIEWER 系统账号" if managed else "保留自定义平台账号"))
            print("MCP 默认模型：" + values["CRP_DEFAULT_MODEL"] + "；正式发布时校验登录及模型可用性。")
            return values

        api = api_factory(api_url, server["ANON_KEY"], server["SERVICE_ROLE_KEY"])
        user = api.find_system_user() if managed else None
        if user is not None and not values.get("CRP_PASSWORD"):
            raise BootstrapError("系统账号已存在但本地密码缺失；请恢复原 MCP 配置，不会自动重置密码")
        if managed and not values.get("CRP_PASSWORD"):
            values["CRP_PASSWORD"] = secrets.token_urlsafe(36)
        if not values.get("CRP_MCP_TOKENS"):
            values["CRP_MCP_TOKENS"] = "crp-default:" + secrets.token_urlsafe(32)

        # Persist BEFORE creating the user: even if the response is lost, the
        # next run can reconcile the identity using the same saved password.
        if values != previous:
            save_env(config_file, values)
        else:
            os.chmod(config_file, 0o600)
        if managed and user is None:
            user = api.request("POST", "/auth/v1/admin/users", {
                "email": SYSTEM_EMAIL, "password": values["CRP_PASSWORD"], "email_confirm": True,
                "app_metadata": {"crp_system_account": SYSTEM_MARKER},
                "user_metadata": {"name": "MCP 系统账号"},
            }, admin=True)
            if not isinstance(user, dict) or not user.get("id"):
                raise BootstrapError("系统账号创建结果不明；凭证已保存，下次发布会复核")
        model = verify_account(api, values, user["id"] if managed else None)
        # The already-built MCP image understands IDs/display names. Resolve a
        # Model value such as glm5.3-flash here, then pin its exact config ID.
        if values["CRP_DEFAULT_MODEL"] != model["id"]:
            values["CRP_DEFAULT_MODEL"] = model["id"]
            save_env(config_file, values)
        print("MCP 系统账号/配置已就绪；登录、权限和默认模型检查通过。")
        return values

    if apply:
        with config_lock(config_file):
            return run()
    return run()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    parser.add_argument("--supabase-dir", type=Path, default=Path("/home/kduser/crp/supabase"))
    parser.add_argument("--config-file", type=Path, default=Path(__file__).resolve().parents[3] / ".docker/mcp.selfhost.env")
    parser.add_argument("--api-url", default="http://127.0.0.1:54341")
    args = parser.parse_args()
    try:
        prepare(args.supabase_dir / ".env", args.config_file, args.api_url, args.apply)
    except (BootstrapError, OSError) as error:
        parser.exit(1, "MCP 初始化失败：" + str(error) + "\n")


if __name__ == "__main__":
    main()
