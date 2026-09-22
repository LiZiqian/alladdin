"""Strict JSON ingress shared by HTTP requests and imported documents."""

from __future__ import annotations

import json
import math


def _finite_int(text: str) -> int:
    value = int(text)
    try:
        finite = math.isfinite(float(value))
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError("JSON 数值超出有限数值范围")
    return value


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("JSON 数值超出有限数值范围")
    return value


def _reject_constant(text: str):
    raise ValueError(f"JSON 不允许非有限数值：{text}")


def _unique_object(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 对象包含重复字段")
        result[key] = value
    return result


def loads(text: str | bytes | bytearray):
    """Return interoperable JSON, rejecting silent overwrites and bad Unicode.

    Python accepts NaN/Infinity and unpaired escaped UTF-16 surrogates by
    default. Persisting either can make a later fetch response unreadable by
    the browser. Check before dispatching any write or import operation.
    """
    try:
        value = json.loads(text, parse_int=_finite_int, parse_float=_finite_float,
                           parse_constant=_reject_constant, object_pairs_hook=_unique_object)
    except RecursionError as exc:
        raise ValueError("JSON 嵌套过深，请简化数据后重试") from exc
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, str):
            try:
                item.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise ValueError("JSON 字符串包含无效的 Unicode 字符") from exc
    return value
