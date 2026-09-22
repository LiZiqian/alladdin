from __future__ import annotations

from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Callable

from server_modules import http_api, http_helpers, http_routes


def create_handler(
    *,
    server_version: str,
    now_iso: Callable[[], str],
    json_dumps: Callable[..., str],
    runtime_context: Callable,
    max_upload_bytes: int,
):
    handler_server_version = server_version

    class Handler(BaseHTTPRequestHandler):
        server_version = handler_server_version

        def log_message(self, fmt: str, *args) -> None:
            print(f"[{now_iso()}] {self.client_address[0]} {fmt % args}")

        def _send_json(self, payload: dict, status: int = 200) -> None:
            http_helpers.send_json(self, payload, status=status, json_dumps=json_dumps)

        def _send_bytes(self, data: bytes, content_type: str, status: int = 200, cache: str = "no-store") -> None:
            http_helpers.send_bytes(self, data, content_type, status=status, cache=cache)

        def _send_file(self, target: Path, content_type: str, *, cache: str = http_helpers.STATIC_ASSET_CACHE) -> None:
            http_helpers.send_file(self, target, content_type, cache=cache)

        def _read_body(self, max_bytes: int = max_upload_bytes) -> bytes:
            return http_helpers.read_body(self, max_bytes)

        def _sample_photo_route(self, path: str) -> tuple[str, str | None] | None:
            return http_routes.sample_photo_route(path)

        def _sample_events_route(self, path: str) -> str | None:
            return http_routes.sample_events_route(path)

        def _sample_history_route(self, path: str) -> str | None:
            return http_routes.sample_history_route(path)

        def _sample_archive_route(self, path: str) -> str | None:
            return http_routes.sample_archive_route(path)

        def _stage_tasks_route(self, path: str) -> str | None:
            return http_routes.stage_tasks_route(path)

        def _stage_tasks_batch_route(self, path: str) -> str | None:
            return http_routes.stage_tasks_batch_route(path)

        def _project_detail_route(self, path: str) -> str | None:
            return http_routes.project_detail_route(path)

        def _project_mutation_route(self, path: str) -> str | None:
            return http_routes.project_mutation_route(path)

        def _stage_mutation_route(self, path: str) -> str | None:
            return http_routes.stage_mutation_route(path)

        def _sample_category_samples_route(self, path: str) -> str | None:
            return http_routes.sample_category_samples_route(path)

        def _sample_category_detail_route(self, path: str) -> str | None:
            return http_routes.sample_category_detail_route(path)

        def _task_mutation_route(self, path: str) -> str | None:
            return http_routes.task_mutation_route(path)

        def _sample_mutation_route(self, path: str) -> str | None:
            return http_routes.sample_mutation_route(path)

        def _sample_category_mutation_route(self, path: str) -> str | None:
            return http_routes.sample_category_mutation_route(path)

        @staticmethod
        def _is_public_static_path(path: str) -> bool:
            return http_routes.is_public_static_path(path)

        def do_GET(self) -> None:
            http_api.handle_get(self, runtime_context())

        def _allow_mutation(self) -> bool:
            if http_helpers.request_origin_is_allowed(self.headers):
                return True
            # Do not reuse a connection whose rejected request body is unread.
            self.close_connection = True
            http_helpers.discard_rejected_body(self)
            self._send_json({"ok": False, "error": "请从本平台页面提交修改请求", "errorCode": "CROSS_ORIGIN_WRITE_REJECTED"}, 403)
            return False

        def do_POST(self) -> None:
            if self._allow_mutation():
                http_api.handle_post(self, runtime_context())

        def do_DELETE(self) -> None:
            if self._allow_mutation():
                http_api.handle_delete(self, runtime_context())

        def do_PATCH(self) -> None:
            if self._allow_mutation():
                http_api.handle_patch(self, runtime_context())


    return Handler
