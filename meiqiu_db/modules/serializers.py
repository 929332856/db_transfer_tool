"""
JSON 序列化辅助函数
"""
import re
import datetime as _dt
import decimal as _dec

def _json_safe(val):
    """将 datetime / Decimal 等非 JSON 类型转为字符串"""
    if val is None:
        return None
    if isinstance(val, (_dt.datetime, _dt.date, _dt.time)):
        return str(val)
    if isinstance(val, _dec.Decimal):
        return float(val)
    if isinstance(val, bytes):
        return val.decode('utf-8', errors='replace')
    return val


def _row_to_json(row):
    return [_json_safe(v) for v in row]


def _detect_table_from_sql(sql: str) -> str:
    """Best-effort table detection for result metadata; returns empty when ambiguous."""
    if not sql:
        return ""
    cleaned = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    cleaned = re.sub(r"--.*?$", " ", cleaned, flags=re.M)
    match = re.search(
        r"\b(?:FROM|UPDATE|INTO)\s+(?:`[^`]+`|\"[^\"]+\"|\[[^\]]+\]|\w+)"
        r"(?:\s*\.\s*(?:`([^`]+)`|\"([^\"]+)\"|\[([^\]]+)\]|(\w+)))?",
        cleaned,
        flags=re.I,
    )
    if not match:
        return ""
    if match.group(1) or match.group(2) or match.group(3) or match.group(4):
        return match.group(1) or match.group(2) or match.group(3) or match.group(4) or ""
    token = re.search(r"\b(?:FROM|UPDATE|INTO)\s+(`([^`]+)`|\"([^\"]+)\"|\[([^\]]+)\]|(\w+))", cleaned, flags=re.I)
    return (token.group(2) or token.group(3) or token.group(4) or token.group(5) or "") if token else ""


def _rows_to_dicts(exec_result):
    """将 SQLAlchemy 查询结果转为 JSON 安全的 dict 列表（处理 Decimal/datetime 等）"""
    cols = [str(k) for k in exec_result.keys()]
    rows = []
    for row in exec_result.fetchall():
        d = {}
        for c in cols:
            d[c] = _json_safe(row._mapping.get(c))
        rows.append(d)
    return cols, rows
