#!/usr/bin/env python3
"""Company-Linux release entry point for the DevOps Python node.

The default action is deliberately read-only: resolve the configured target and
open a TCP connection to its SSH port.  It neither authenticates nor changes
the Linux server.  This gives the pipeline a safe, factual answer to the first
deployment question: can this runner reach the target machine at all?

The first target is the agreed Linux address ``172.18.54.40:22``.  A future
CI variable can override it, but this DevOps node does not expose a variable
input, so the initial connectivity probe does not depend on pipeline UI
configuration.  Later actions are intentionally not implemented until this
check and the company's SSH / JumpServer mechanism have both been verified.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys
from dataclasses import dataclass


def fail(message: str) -> "None":
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def setting(name: str, *, required: bool = False, default: str = "") -> str:
    value = os.environ.get(name, default).strip()
    if required and not value:
        fail(f"缺少 CI 变量 {name}。本次只需设置目标 Linux 的主机名或 IP，不要填密码。")
    return value


@dataclass(frozen=True)
class Target:
    host: str
    port: int
    timeout_seconds: float


DEFAULT_TARGET_HOST = "172.18.54.40"
DEFAULT_TARGET_PORT = "22"


def read_target() -> Target:
    # The DevOps Python-node UI currently accepts only a Python-file path, not
    # per-node variables. Keep this read-only probe runnable there. Environment
    # values remain optional overrides for a later platform that supports them.
    host = setting("CRP_DEPLOY_HOST", default=DEFAULT_TARGET_HOST)
    raw_port = setting("CRP_DEPLOY_PORT", default=DEFAULT_TARGET_PORT)
    raw_timeout = setting("CRP_DEPLOY_CONNECT_TIMEOUT_SECONDS", default="5")
    try:
        port = int(raw_port)
        timeout_seconds = float(raw_timeout)
    except ValueError:
        fail("CRP_DEPLOY_PORT 必须是端口号，CRP_DEPLOY_CONNECT_TIMEOUT_SECONDS 必须是秒数。")
    if not 1 <= port <= 65535:
        fail("CRP_DEPLOY_PORT 必须在 1 到 65535 之间。")
    if not 0 < timeout_seconds <= 30:
        fail("CRP_DEPLOY_CONNECT_TIMEOUT_SECONDS 必须大于 0 且不超过 30。")
    return Target(host=host, port=port, timeout_seconds=timeout_seconds)


def resolve_addresses(target: Target) -> list[str]:
    try:
        records = socket.getaddrinfo(target.host, target.port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        fail(f"无法解析 {target.host}：{error}")
    addresses = sorted({record[4][0] for record in records})
    if not addresses:
        fail(f"{target.host} 没有返回可用地址。")
    return addresses


def tcp_check(target: Target, addresses: list[str]) -> None:
    errors: list[str] = []
    for address in addresses:
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        try:
            with socket.socket(family, socket.SOCK_STREAM) as connection:
                connection.settimeout(target.timeout_seconds)
                connection.connect((address, target.port))
            print(f"PASS: TCP {address}:{target.port} 可达。")
            return
        except OSError as error:
            errors.append(f"{address}:{target.port} ({error})")
    fail("目标 SSH 端口不可达：" + "; ".join(errors))


def main() -> None:
    action = setting("CRP_DEPLOY_ACTION", default="tcp-check")
    if action != "tcp-check":
        fail(
            f"当前只支持安全探测动作 tcp-check，收到 {action!r}。"
            "请先让 tcp-check 通过，再配置 SSH/JumpServer 发布方式。"
        )

    target = read_target()
    addresses = resolve_addresses(target)
    printable = ", ".join(str(ipaddress.ip_address(address)) for address in addresses)
    print(f"目标：{target.host}:{target.port}")
    print(f"DNS 解析：{printable}")
    tcp_check(target, addresses)
    print("PASS: 流水线执行器已证明能到达目标 Linux 的 SSH 端口；尚未登录、未执行任何发布操作。")


if __name__ == "__main__":
    main()
