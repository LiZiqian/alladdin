"""增量写入实现包。外部调用统一经过 server_modules.mutation_services。

依赖方向：服务入口 → 校验/副作用 → 公共事务工具；不反向导入 server.py。
"""
