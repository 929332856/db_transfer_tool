"""
配置管理、数据库操作日志、ProfileManager
★ 日志函数统一从 db_transfer_eel 导入，避免重复初始化
"""
import eel
import re
import threading
import queue
import time
import json
import os
import sys
from urllib.parse import quote_plus
from typing import Optional, List
from datetime import datetime
import sqlalchemy as sa
from sqlalchemy import text, inspect, create_engine

# ==================== 配置路径 ====================
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILES_FILE = os.path.join(BASE_DIR, "db_profiles.json")

# ★ 日志函数和工具函数：从主模块导入（主模块已初始化 logs/ 目录和按日期轮转的 logger）
try:
    from db_transfer_eel import (_log_db_select, _log_db_insert, _log_db_update, _log_db_delete,
                                 _log_db_error, _db_op_logger, _sql_value, _safe_ident)
except ImportError:
    # 兼容独立运行（如测试），回退到简单 console 日志
    import logging
    _db_op_logger = logging.getLogger("db_operation")
    _db_op_logger.setLevel(logging.INFO)
    if not _db_op_logger.handlers:
        _db_op_logger.addHandler(logging.StreamHandler())
    def _log_db_select(sql: str): _db_op_logger.info(f"[SELECT] {sql}")
    def _log_db_insert(sql: str): _db_op_logger.info(f"[INSERT] {sql}")
    def _log_db_update(sql: str, rollback_sql: str = ""):
        _db_op_logger.info(f"[UPDATE] {sql}")
        if rollback_sql: _db_op_logger.info(f"[ROLLBACK] {rollback_sql}")
    def _log_db_delete(sql: str, rollback_sql: str = ""):
        _db_op_logger.info(f"[DELETE] {sql}")
        if rollback_sql: _db_op_logger.info(f"[ROLLBACK] {rollback_sql}")
    def _log_db_error(label: str, msg: str): _db_op_logger.warning(f"[{label}] {msg}")


def _gen_rollback_update(tbl: str, db_type: str, columns: list, orig_row: list, where_cols: list = None):
    """根据原始行数据生成 UPDATE 回退 SQL
    将修改后的值回退到原始值（仅在 table_exec_save 中用于单个字段修改时可用）
    """
    pass  # 具体实现嵌入 table_exec_save


def _gen_rollback_insert(tbl: str, db_type: str, columns: list, orig_row: list):
    """根据原始行数据生成 INSERT 回退 SQL（用于 DELETE 回退）"""
    parts = []
    for i, col in enumerate(columns):
        val = orig_row[i] if i < len(orig_row) else None
        parts.append(_sql_value(val, db_type))
    col_names = ", ".join(_safe_ident(c, db_type) for c in columns)
    values = ", ".join(parts)
    return f"INSERT INTO {tbl} ({col_names}) VALUES ({values});"


# ==================== 配置管理（复用原版） ====================
class ProfileManager:
    @staticmethod
    def _read_json() -> dict:
        if not os.path.exists(PROFILES_FILE):
            return {"profiles": [], "last_used": ""}
        try:
            with open(PROFILES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {"profiles": [], "last_used": ""}

    @staticmethod
    def _write_json(data: dict):
        # 原子写入：先写临时文件，再替换
        tmp_file = PROFILES_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        if os.path.exists(PROFILES_FILE):
            os.replace(tmp_file, PROFILES_FILE)
        else:
            os.rename(tmp_file, PROFILES_FILE)

    @staticmethod
    def load_all() -> List[dict]:
        return ProfileManager._read_json().get("profiles", [])

    @staticmethod
    def save(profile: dict):
        data = ProfileManager._read_json()
        profiles = data.get("profiles", [])
        existing = [p for p in profiles if p["name"] == profile["name"]]
        if existing:
            idx = profiles.index(existing[0])
            profiles[idx] = profile
        else:
            profiles.append(profile)
        data["profiles"] = profiles
        ProfileManager._write_json(data)

    @staticmethod
    def delete(name: str):
        data = ProfileManager._read_json()
        data["profiles"] = [p for p in data.get("profiles", []) if p["name"] != name]
        if data.get("last_used") == name:
            data["last_used"] = ""
        ProfileManager._write_json(data)

    @staticmethod
    def get_names() -> List[str]:
        return [p["name"] for p in ProfileManager.load_all()]

    @staticmethod
    def find(name: str) -> Optional[dict]:
        for p in ProfileManager.load_all():
            if p["name"] == name:
                return p
        return None

    @staticmethod
    def get_last_used() -> str:
        return ProfileManager._read_json().get("last_used", "")

    @staticmethod
    def set_last_used(name: str):
        data = ProfileManager._read_json()
        data["last_used"] = name
        ProfileManager._write_json(data)


# ==================== 全局状态 ====================
_progress_q = queue.Queue()
_engine = None
_worker = None
_query_cancel = threading.Event()
_query_columns = []
_query_rows = []
_query_conn_id = None       # 当前查询的数据库连接 ID（用于 kill）
_query_src_data = None       # 当前查询的源库连接信息
