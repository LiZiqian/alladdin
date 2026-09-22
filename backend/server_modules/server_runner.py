from __future__ import annotations

import argparse
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from typing import Callable


def run_server(
    *,
    description: str,
    default_data_dir,
    prepare_runtime_data_root: Callable,
    init_db: Callable[[], None],
    handler_cls,
    runtime_paths: Callable[[], SimpleNamespace],
) -> None:
    parser = argparse.ArgumentParser(prog="python -m backend.server", description=description)
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--port", type=int, default=9398, help="监听端口，默认 9398")
    parser.add_argument(
        "--data-dir",
        default=None,
        help=f"业务数据目录，默认使用项目内 {default_data_dir}",
    )
    args = parser.parse_args()

    try:
        prepare_runtime_data_root(args.data_dir)
    except ValueError as e:
        print(f"[ERROR] {e}")
        raise SystemExit(2) from e

    init_db()
    paths = runtime_paths()

    httpd = ThreadingHTTPServer((args.host, args.port), handler_cls)
    print("=" * 70)
    print("数字治理平台 V7 内网协同版服务器已启动")
    print(f"根目录: {paths.root_dir}")
    print(f"数据目录: {paths.data_dir}")
    print(f"数据库: {paths.db_path}")
    print(f"样机文件目录: {paths.sample_data_dir}")
    print(f"导入预览目录: {paths.import_preview_dir}")
    print(f"导出临时目录: {paths.export_dir}")
    print(f"监听: http://localhost:{args.port}/")
    print("同事访问时请使用这台电脑的内网 IP，例如：http://10.31.118.61:9398/")
    print("停止服务：在此窗口按 Ctrl+C")
    print("=" * 70)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止。")
    finally:
        httpd.server_close()
