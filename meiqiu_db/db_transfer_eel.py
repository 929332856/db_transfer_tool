"""
数据库高速传输工具 — Eel 版
前后端分离：Python 纯业务逻辑，HTML/CSS/JS 负责界面
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
import gc
import concurrent.futures
import uuid
import sqlalchemy as sa
from sqlalchemy import text, inspect, create_engine

# ==================== Oracle 驱动加速：厚模式 (Thick Mode) ====================
# oracledb 默认使用薄模式 (Thin, 纯 Python)。Thick 模式使用 Oracle Client 库（C 层）
# 可提速 2-5 倍，尤其是大结果集的 Decimal 反序列化。
# 如果 Oracle Client 未安装，自动回退到 Thin 模式。
try:
    import oracledb
    try:
        oracledb.init_oracle_client()
        print("[oracledb] Thick mode enabled (Oracle Client C driver)")
    except Exception:
        print("[oracledb] Thick mode unavailable, using Thin mode")
        pass
except ImportError:
    pass

# ==================== 配置路径 ====================
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILES_FILE = os.path.join(BASE_DIR, "db_profiles.json")
SETTINGS_FILE = os.path.join(BASE_DIR, "mqdb_settings.json")
LEGACY_SETTINGS_FILE = os.path.join(BASE_DIR, "settings.json")

# ==================== 数据库操作日志（logs/ 目录，按日期分文件） ====================
import logging
import base64
from functools import wraps


def _dpapi_transform(value, protect=True):
    """使用 Windows DPAPI 保护本地配置中的密码；非 Windows 保持兼容。"""
    if not value or os.name != 'nt':
        return value
    try:
        import ctypes
        from ctypes import wintypes

        class _Blob(ctypes.Structure):
            _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_byte))]

        raw = value.encode('utf-8') if protect else base64.b64decode(str(value)[len('dpapi:'):])
        buf = ctypes.create_string_buffer(raw)
        src = _Blob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
        dst = _Blob()
        fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
        ok = fn(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst))
        if not ok:
            return value
        out = ctypes.string_at(dst.pbData, dst.cbData)
        ctypes.windll.kernel32.LocalFree(dst.pbData)
        return 'dpapi:' + base64.b64encode(out).decode('ascii') if protect else out.decode('utf-8')
    except Exception:
        return value


def _transform_secrets(value, protect=True):
    """递归保护/解密 pwd、password 等配置字段，兼容旧明文配置。"""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            key_text = str(key).lower()
            if key_text in ('pwd', 'src_pwd', 'dst_pwd', 'password', 'src_password', 'dst_password') and isinstance(item, str):
                if protect and not item.startswith('dpapi:'):
                    result[key] = _dpapi_transform(item, True)
                elif not protect and item.startswith('dpapi:'):
                    result[key] = _dpapi_transform(item, False)
                else:
                    result[key] = item
            else:
                result[key] = _transform_secrets(item, protect)
        return result
    if isinstance(value, list):
        return [_transform_secrets(item, protect) for item in value]
    return value


def _has_plaintext_secrets(value):
    """检查配置中是否仍有未使用 DPAPI 保护的密码字段。"""
    secret_keys = {'pwd', 'src_pwd', 'dst_pwd', 'password', 'src_password', 'dst_password'}
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in secret_keys and isinstance(item, str):
                if item and not item.startswith('dpapi:'):
                    return True
            elif _has_plaintext_secrets(item):
                return True
    elif isinstance(value, list):
        return any(_has_plaintext_secrets(item) for item in value)
    return False

_LOG_BASE_DIR = os.path.join(BASE_DIR, "logs")
_LOG_OP_DIR   = os.path.join(_LOG_BASE_DIR, "db_operations")
_LOG_RB_DIR   = os.path.join(_LOG_BASE_DIR, "rollback")
os.makedirs(_LOG_OP_DIR, exist_ok=True)
os.makedirs(_LOG_RB_DIR, exist_ok=True)

# 统一的日志格式
_log_fmt = logging.Formatter('%(asctime)s | %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

def _init_logger(name, dir_path, suffix):
    """创建按天轮转的日志 logger，文件名: 2026-07-15_<suffix>.log"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    # 每次检查：如果 handler 的 baseFilename 已经过时（跨天），则清空重建
    if logger.handlers:
        h = logger.handlers[0]
        if hasattr(h, 'baseFilename') and os.path.exists(h.baseFilename):
            return logger  # 当前 handler 有效，复用
        # 跨天了，移除旧 handler
        for old_h in list(logger.handlers):
            old_h.close()
            logger.removeHandler(old_h)
    # 创建新 handler，文件命名: 2026-07-15_op.log / 2026-07-15_rb.log
    today = datetime.now().strftime("%Y-%m-%d")
    log_file = os.path.join(dir_path, f"{today}_{suffix}.log")
    handler = logging.FileHandler(log_file, encoding="utf-8")
    handler.setFormatter(_log_fmt)
    logger.addHandler(handler)
    return logger

# 三个独立 logger
_db_op_logger = _init_logger("db_op",        _LOG_OP_DIR, "op")  # 数据库操作 + 错误
_db_rb_logger = _init_logger("db_rollback",  _LOG_RB_DIR, "rb")  # 回滚 SQL
_db_err_logger = _init_logger("db_error",    _LOG_OP_DIR, "err") # 操作错误（WARNING 级别）

# ★ 将 _db_op_logger 作为主 logger 暴露给 modules/ 使用（保持向后兼容）
# modules/config_state.py 会导入这个 logger


def _log_db_select(sql: str):
    """记录查询 SQL"""
    _db_op_logger.info(f"[SELECT] {sql}")


def _log_db_insert(sql: str):
    """记录新增 SQL"""
    _db_op_logger.info(f"[INSERT] {sql}")


def _log_db_update(sql: str, rollback_sql: str = ""):
    """记录修改 SQL + 回退 SQL（回退 SQL 单独写入 rollback 日志）"""
    _db_op_logger.info(f"[UPDATE] {sql}")
    if rollback_sql:
        _db_rb_logger.info(f"[ROLLBACK] {rollback_sql}")


def _log_db_delete(sql: str, rollback_sql: str = ""):
    """记录删除 SQL + 回退 SQL（回退 SQL 单独写入 rollback 日志）"""
    _db_op_logger.info(f"[DELETE] {sql}")
    if rollback_sql:
        _db_rb_logger.info(f"[ROLLBACK] {rollback_sql}")


def _log_db_error(label: str, msg: str):
    """记录数据库操作错误"""
    _db_err_logger.warning(f"[{label}] {msg}")


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
                raw_data = json.load(f)
            data = _transform_secrets(raw_data, protect=False)
            # 兼容旧版本明文配置：读取成功后立即用 DPAPI 回写，避免文件长期保持明文。
            protected_data = _transform_secrets(data, protect=True)
            if protected_data != raw_data:
                ProfileManager._write_protected_json(protected_data)
            return data
        except Exception:
            return {"profiles": [], "last_used": ""}

    @staticmethod
    def _write_protected_json(data: dict):
        # 原子写入：先写临时文件，再替换
        tmp_file = PROFILES_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        if os.path.exists(PROFILES_FILE):
            os.replace(tmp_file, PROFILES_FILE)
        else:
            os.rename(tmp_file, PROFILES_FILE)

    @staticmethod
    def _write_json(data: dict):
        ProfileManager._write_protected_json(_transform_secrets(data, protect=True))

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
class _DroppingProgressQueue(queue.Queue):
    """有界进度队列，前端失联时丢弃最旧消息而不是无限占用内存。"""

    def __init__(self, maxsize=2000):
        super().__init__(maxsize=maxsize)

    def put(self, item, block=True, timeout=None):
        # 进度消息是瞬时状态，不能因为 UI 停止轮询而阻塞数据库任务。
        try:
            queue.Queue.put(self, item, block=False)
            return
        except queue.Full:
            pass
        try:
            self.get_nowait()
        except queue.Empty:
            pass
        try:
            queue.Queue.put(self, item, block=False)
        except queue.Full:
            pass


_progress_q = _DroppingProgressQueue()
_progress_task_lock = threading.Lock()
_progress_task_name = None
_engine = None
_worker = None
_query_cancel = threading.Event()
_query_conn_cancel_flags = {}  # {conn_id: True} 记录哪些连接被取消了（用于线程内检查）
_query_job_conn = {}           # {job_id: conn_id} 记录哪个 job 属于哪个连接
_query_conn_data_map = {}      # {conn_id: conn_data} 保存连接数据用于 cancel 时 kill
_query_conn_pid_map = {}       # {conn_id: backend_pid} 保存真实查询连接 PID
_query_state_lock = threading.RLock()
_query_state_time = {}         # {job_id: last_activity_timestamp}
_db_operation_states = {}       # {operation_id: {cancel_event, sessions, ...}}
_db_operation_lock = threading.RLock()
_QUERY_STATE_TTL = 15 * 60
_MYSQL_NORMAL_READ_TIMEOUT = 120
# DDL may spend hours on the server without sending a packet back to the client.
_MYSQL_DDL_READ_TIMEOUT = 24 * 60 * 60
_query_columns = []
_query_rows = []
_query_conn_id = None       # 当前查询的数据库连接 ID（用于 kill）
_query_src_data = None       # 当前查询的源库连接信息

# 表级 DROP/TRUNCATE 操作的独立取消状态。不能复用查询状态，否则取消表操作
# 可能误杀正在执行的查询或传输连接。
_table_op_lock = threading.RLock()
_table_op_state = None       # {op_id, conn_data, pid, cancel_requested}

# TransferEngine 当前的实现使用 MySQL 方言（SHOW CREATE TABLE、
# FOREIGN_KEY_CHECKS、INSERT IGNORE 等）。其他数据库类型由拖拽复制等
# 独立路径处理，不能在“全量同步”入口中静默按 MySQL 执行。
TRANSFER_DB_TYPES = frozenset(('mysql', 'ob-mysql'))


def _claim_progress_task(name):
    """进度队列是兼容旧前端的单通道；同一时间只允许一个进度任务。"""
    global _progress_task_name
    with _progress_task_lock:
        if _progress_task_name is not None:
            return False
        _progress_task_name = name
        return True


def _release_progress_task(name):
    global _progress_task_name
    with _progress_task_lock:
        if _progress_task_name == name:
            _progress_task_name = None


def _progress_guard(name):
    def decorator(func):
        @wraps(func)
        def wrapped(*args, **kwargs):
            if not _claim_progress_task(name):
                return {"ok": False, "msg": "已有导入、导出或同步任务正在运行，请稍后再试"}
            try:
                return func(*args, **kwargs)
            finally:
                _release_progress_task(name)
        return wrapped
    return decorator


# ==================== JSON 序列化辅助 ====================
def _json_safe(val):
    """将 datetime / Decimal / NaN / Inf / UUID / bytes 等非 JSON 类型转为安全值。
    特别注意：超出 JS 安全整数范围 (2^53) 的 int 转为字符串，避免 JSON 精度丢失。"""
    import datetime, decimal, math
    if val is None:
        return None
    # bool 必须在 int 之前判断（Python 中 bool 是 int 子类）
    if isinstance(val, bool):
        return val
    if isinstance(val, (datetime.datetime, datetime.date, datetime.time)):
        return str(val)
    if isinstance(val, decimal.Decimal):
        return str(val)
    # bytes / bytearray / memoryview → 安全解码
    if isinstance(val, (bytes, bytearray, memoryview)):
        try:
            b = bytes(val)
        except Exception:
            return str(val)
        return b.decode('utf-8', errors='replace')
    # 超大整数 → 字符串（避免 JS 精度丢失）
    if isinstance(val, int):
        if val > 9007199254740991 or val < -9007199254740991:
            return str(val)
        return val
    # NaN / Inf / -Inf → 字符串（标准 JSON 不支持）
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return str(val)
        return val
    # str → 直接返回
    if isinstance(val, str):
        return val
    # list/dict/tuple → 递归处理（防止嵌套非 JSON 安全值）
    if isinstance(val, (list, tuple)):
        return [_json_safe(v) for v in val]
    if isinstance(val, dict):
        return {str(k): _json_safe(v) for k, v in val.items()}
    # 其余不可 JSON 序列化的类型 → 转字符串（UUID, set, frozenset 等）
    return str(val)


def _row_to_json(row):
    return [_json_safe(v) for v in row]


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


# ==================== 传输引擎 ====================
def _dst_table_exists(conn, table_name: str, database: str = '') -> bool:
    """检查 MySQL/OceanBase 目标库中的表是否存在。

    该函数只接受 MySQL 方言连接；调用方必须先根据数据库类型选择
    对应实现，避免把 MySQL 的 information_schema 语义误用于其他数据库。
    """
    try:
        if database:
            sql = ("SELECT COUNT(*) FROM information_schema.tables "
                   "WHERE table_schema = :db AND table_name = :t")
            params = {"db": database, "t": table_name}
        else:
            sql = ("SELECT COUNT(*) FROM information_schema.tables "
                   "WHERE table_schema = DATABASE() AND table_name = :t")
            params = {"t": table_name}
        return bool(conn.execute(text(sql), params).scalar())
    except Exception:
        return False


def _dst_table_exists_for_type(conn, table_name, database, db_type, schema=''):
    """按目标数据库类型检查表存在性，供同步前检查使用。"""
    try:
        if db_type in ('mysql', 'ob-mysql'):
            return _dst_table_exists(conn, table_name, database)
        if db_type == 'postgresql':
            sch = schema or 'public'
            return bool(conn.execute(text(
                "SELECT COUNT(*) FROM information_schema.tables "
                "WHERE table_schema=:sch AND table_name=:tbl"
            ), {"sch": sch, "tbl": table_name}).scalar())
        if db_type == 'oracle':
            owner = (schema or '').upper()
            if not owner:
                owner = str(conn.execute(text("SELECT USER FROM DUAL")).scalar() or '').upper()
            return bool(conn.execute(text(
                "SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER=:own AND TABLE_NAME=:tbl"
            ), {"own": owner, "tbl": str(table_name).upper()}).scalar())
        if db_type == 'mssql':
            sch = schema or 'dbo'
            return bool(conn.execute(text(
                "SELECT COUNT(*) FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id "
                "WHERE s.name=:sch AND t.name=:tbl"
            ), {"sch": sch, "tbl": table_name}).scalar())
    except Exception:
        return False
    return False


def _get_pk_columns(engine, table_name: str):
    """获取表的单列主键或唯一索引列（用于分页拉取）；无则返回空列表"""
    insp = None
    try:
        insp = inspect(engine)
        pk = insp.get_pk_constraint(table_name)
        cols = list(pk.get('constrained_columns') or [])
        if len(cols) == 1:
            return cols
        for idx in insp.get_indexes(table_name):
            if idx.get('unique') and idx.get('column_names'):
                return list(idx['column_names'])
    except Exception:
        pass
    finally:
        # ★ 显式关闭 Inspector 持有的连接，避免连接滞留池外（旧版 SQLAlchemy 会缓存连接）
        if insp is not None:
            try:
                insp.close()
            except Exception:
                pass
    return []


class TransferEngine:
    def __init__(self, config: dict):
        self.src_host = config["src_host"]
        self.src_port = config["src_port"] or "3306"
        self.src_user = config["src_user"]
        self.src_pwd = config["src_pwd"]
        self.src_db = config["src_db"]
        self.dst_host = config["dst_host"]
        self.dst_port = config["dst_port"] or "3306"
        self.dst_user = config["dst_user"]
        self.dst_pwd = config["dst_pwd"]
        self.dst_db = config["dst_db"]
        self.table_name = config.get("table_name", "")
        self.batch_size = config.get("batch_size", 10000)
        # ★ 传输前检查控制：drop_existing=False 时不删除目标已存在的表
        # 默认保留目标已有表。删除模式必须由用户显式选择并传入 True。
        self.drop_existing = bool(config.get("drop_existing", False))
        # 手动指定要同步的表名列表（用于「只同步不存在的表」场景，优先于 table_name）
        self.manual_tables = config.get("tables", None)
        # ★ 多表并行传输开关：多张表时每表独立连接同时传输（默认关闭）
        self.parallel = config.get("parallel", False)
        self._stop_event = threading.Event()
        # ★ 保存 (线程ID, SQLAlchemy连接对象)，停止时只处理仍打开的连接
        self._src_conn_ids = []
        self._dst_conn_ids = []
        self._conn_ids_lock = threading.Lock()
        self._dst_database_ready = False

    def _clear_conn_records(self):
        """同步结束后释放已关闭 Connection 对象的引用。"""
        with self._conn_ids_lock:
            self._src_conn_ids.clear()
            self._dst_conn_ids.clear()

    def _record_src_conn_id(self, src_conn):
        """记录源库连接的服务端线程 ID，供 stop() 时 KILL QUERY 立即中断"""
        try:
            pid = src_conn.exec_driver_sql("SELECT CONNECTION_ID()").scalar()
            if pid:
                with self._conn_ids_lock:
                    self._src_conn_ids = [
                        (old_pid, conn) for old_pid, conn in self._src_conn_ids
                        if not getattr(conn, "closed", True)
                    ]
                    self._src_conn_ids.append((int(pid), src_conn))
                    stopped = self._stop_event.is_set()
                if stopped:
                    self._kill_server_sessions(
                        self.src_host, self.src_port, self.src_user, self.src_pwd,
                        self.src_db, [int(pid)], kill_connection=False
                    )
        except Exception:
            pass

    def _record_dst_conn_id(self, dst_conn):
        """记录目标库连接的服务端线程 ID，供 stop() 时 KILL CONNECTION"""
        try:
            pid = dst_conn.exec_driver_sql("SELECT CONNECTION_ID()").scalar()
            if pid:
                with self._conn_ids_lock:
                    self._dst_conn_ids = [
                        (old_pid, conn) for old_pid, conn in self._dst_conn_ids
                        if not getattr(conn, "closed", True)
                    ]
                    self._dst_conn_ids.append((int(pid), dst_conn))
                    stopped = self._stop_event.is_set()
                if stopped:
                    self._kill_server_sessions(
                        self.dst_host, self.dst_port, self.dst_user, self.dst_pwd,
                        self.dst_db, [int(pid)], kill_connection=True
                    )
        except Exception:
            pass

    @staticmethod
    def _live_conn_ids(records):
        """只返回仍由本次传输持有的打开连接，避免误杀已复用的线程 ID。"""
        return [pid for pid, conn in records
                if not getattr(conn, "closed", True)]

    def _kill_server_sessions(self, host, port, user, pwd, db, pids, kill_connection=False):
        """用独立连接中断本次传输留下的数据库会话。"""
        if not pids:
            return
        try:
            u = quote_plus(user)
            p = quote_plus(pwd)
            kurl = (f"mysql+mysqldb://{u}:{p}@{host}:{port}/{db}"
                    "?charset=utf8mb4&read_timeout=10")
            keng = create_engine(kurl, connect_args=_connect_args("mysql", timeout=5))
            try:
                with keng.connect() as kconn:
                    command = "KILL CONNECTION" if kill_connection else "KILL QUERY"
                    for pid in sorted(set(pids)):
                        try:
                            kconn.exec_driver_sql(f"{command} {int(pid)}")
                        except Exception:
                            pass  # 会话可能已自行结束，忽略即可
            finally:
                keng.dispose()
        except Exception:
            pass

    def stop(self):
        self._stop_event.set()
        # ★ 中断源库查询 + 杀掉目标库 DROP/CREATE/INSERT 会话。
        #    目标库使用 KILL CONNECTION，确保停止后不会留下 Waiting for table metadata lock。
        with self._conn_ids_lock:
            src_pids = self._live_conn_ids(self._src_conn_ids)
            dst_pids = self._live_conn_ids(self._dst_conn_ids)
        self._kill_server_sessions(
            self.src_host, self.src_port, self.src_user, self.src_pwd,
            self.src_db, src_pids, kill_connection=False
        )
        self._kill_server_sessions(
            self.dst_host, self.dst_port, self.dst_user, self.dst_pwd,
            self.dst_db if self._dst_database_ready else "",
            dst_pids, kill_connection=True
        )

    @property
    def src_url(self) -> str:
        u = quote_plus(self.src_user)
        p = quote_plus(self.src_pwd)
        return f"mysql+mysqldb://{u}:{p}@{self.src_host}:{self.src_port}/{self.src_db}?charset=utf8mb4&read_timeout=3600"

    @property
    def dst_url(self) -> str:
        u = quote_plus(self.dst_user)
        p = quote_plus(self.dst_pwd)
        return f"mysql+mysqldb://{u}:{p}@{self.dst_host}:{self.dst_port}/{self.dst_db}?charset=utf8mb4&read_timeout=3600"

    @property
    def dst_url_no_db(self) -> str:
        u = quote_plus(self.dst_user)
        p = quote_plus(self.dst_pwd)
        return f"mysql+mysqldb://{u}:{p}@{self.dst_host}:{self.dst_port}?charset=utf8mb4&read_timeout=3600"

    def _create_dst_database(self):
        tmp_engine = None
        try:
            tmp_engine = create_engine(self.dst_url_no_db, connect_args=_connect_args("mysql", timeout=10, read_timeout=3600))
            with tmp_engine.connect() as conn:
                self._record_dst_conn_id(conn)
                conn.execute(text("COMMIT"))
                conn.execute(text(
                    f"CREATE DATABASE IF NOT EXISTS {_safe_ident(self.dst_db, 'mysql')} "
                    f"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                ))
            self._dst_database_ready = True
            _progress_q.put(("log", f"📦 目标数据库 [{self.dst_db}] 已就绪"))
        finally:
            # ★ 无论成功/异常都必须关闭连接：否则残留连接会持有元数据锁
            if tmp_engine is not None:
                try:
                    tmp_engine.dispose()
                except Exception:
                    pass

    def _sanitize_ddl(self, ddl: str) -> str:
        """清除 OceanBase 专有语法，适配 MySQL"""
        import re
        ddl = re.sub(r'\s+AUTO_INCREMENT_MODE\s*=\s*\S+', '', ddl)
        ddl = re.sub(r'\s+COMPRESSION\s*=\s*\S+', '', ddl)
        ddl = re.sub(r'\s+REPLICA_NUM\s*=\s*\d+', '', ddl)
        ddl = re.sub(r'\s+USE_BLOOM_FILTER\s*=\s*\S+', '', ddl)
        ddl = re.sub(r'\s+TABLET_SIZE\s*=\s*\d+', '', ddl)
        ddl = re.sub(r'\s+PCTFREE\s*=\s*\d+', '', ddl)
        # BLOCK_SIZE 多种变体
        ddl = re.sub(r'\s+BLOCK_SIZE\s*=\s*\d+\s+LOCAL', '', ddl)
        ddl = re.sub(r'\s+BLOCK_SIZE\s*=\s*\d+', '', ddl)
        ddl = re.sub(r'\s+BLOCK_SIZE\s+\d+\s+LOCAL', '', ddl)
        ddl = re.sub(r'\s+BLOCK_SIZE\s+\d+', '', ddl)
        # 清理多余空白/逗号
        ddl = re.sub(r',\s*,', ',', ddl)
        ddl = re.sub(r'\s+', ' ', ddl)
        return ddl.strip()

    def _get_table_ddl(self, conn, table_name: str) -> str:
        result = conn.execute(text(f"SHOW CREATE TABLE {_safe_ident(table_name, 'mysql')}"))
        row = result.fetchone()
        return row[1] if row else ""

    def _exec_ddl_timeout(self, dst_conn, stmt, table_name, action):
        """在当前传输线程执行 DDL。

        旧实现把 SQLAlchemy Connection 跨线程提交到线程池，再从当前线程等待
        future。MySQLdb 连接不是这样设计的，遇到元数据锁时很容易表现为整个
        传输没有任何新日志。锁等待由目标库会话参数负责限制，连接始终留在
        创建它的传输线程中。
        """
        try:
            dst_conn.execute(stmt)
        except Exception as exc:
            err_text = str(exc)
            lock_words = (
                "lock wait timeout", "metadata lock", "table metadata lock",
                "等待表级锁", "元数据锁"
            )
            if any(word.lower() in err_text.lower() for word in lock_words):
                raise Exception(
                    f"{action}表 [{table_name}] 失败：目标库锁等待超时。"
                    f"{self._collect_mdl_diag()} 原始错误：{err_text}"
                ) from exc
            raise

    def _collect_mdl_diag(self) -> str:
        """收集目标库未结束事务诊断（用独立短连接查 innodb_trx，不被表级锁阻塞）"""
        try:
            u = quote_plus(self.dst_user)
            p = quote_plus(self.dst_pwd)
            diag_url = (f"mysql+mysqldb://{u}:{p}@{self.dst_host}:{self.dst_port}/"
                        f"{self.dst_db}?charset=utf8mb4&read_timeout=10")
            deng = create_engine(diag_url, connect_args=_connect_args("mysql", timeout=5))
            try:
                with deng.connect() as dconn:
                    rows = dconn.execute(text(
                        "SELECT trx_mysql_thread_id, trx_state, trx_started "
                        "FROM information_schema.innodb_trx ORDER BY trx_started LIMIT 5"
                    )).fetchall()
                    if rows:
                        info = "；".join(f"线程{r[0]}({r[1]},{r[2]})" for r in rows[:3])
                        return (f"目标库存在 {len(rows)} 个未结束事务：{info}。"
                                f"请 SHOW FULL PROCESSLIST 找到这些线程后 KILL")
            finally:
                deng.dispose()
        except Exception:
            pass
        return "请检查目标库残留连接（SHOW FULL PROCESSLIST / 重启 MySQL）"

    def _check_dst_trx(self, dst_engine):
        """传输开始前检查目标库未结束事务（可能导致 DDL 被元数据锁阻塞）。"""
        rows = []
        try:
            with dst_engine.connect() as conn:
                rows = conn.execute(text(
                    "SELECT trx_mysql_thread_id, trx_state, trx_started "
                    "FROM information_schema.innodb_trx ORDER BY trx_started LIMIT 5"
                )).fetchall()
                if rows:
                    _progress_q.put(("log", f"⚠️ 目标库存在 {len(rows)} 个未结束事务（可能阻塞建表/传输）："))
                    for r in rows[:3]:
                        _progress_q.put(("log",
                                         f"   ⚠️ 线程 {r[0]} 状态={r[1]} 开始={r[2]}，"
                                         f"可在目标库执行 KILL {r[0]}"))
        except Exception:
            return []
        return rows

    def _create_all_tables(self, src_engine, dst_engine, tables: List[str]):
        _progress_q.put(("log", "📋 阶段1：创建所有表结构..."))
        ddls = {}
        with src_engine.connect() as src_conn:
            # SHOW CREATE TABLE 也可能被元数据锁阻塞，停止时必须能 KILL。
            self._record_src_conn_id(src_conn)
            for table_name in tables:
                if self._stop_event.is_set():
                    return
                ddl = self._get_table_ddl(src_conn, table_name)
                if ddl:
                    ddls[table_name] = ddl
        with dst_engine.connect() as dst_conn:
            self._record_dst_conn_id(dst_conn)
            dst_conn.execute(text("COMMIT"))
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
            # DDL 遇到目标库元数据锁时快速失败，避免界面长时间停在“就绪”。
            # 两个参数分别覆盖元数据锁和 InnoDB 行锁等待。
            try:
                dst_conn.execute(text("SET SESSION lock_wait_timeout = 15"))
            except Exception:
                pass
            try:
                dst_conn.execute(text("SET SESSION innodb_lock_wait_timeout = 15"))
            except Exception:
                pass
            for table_name in tables:
                if self._stop_event.is_set():
                    break
                if table_name in ddls:
                    _progress_q.put(("log", f"  ⏳ 正在处理表 [{table_name}] 结构..."))
                    if self.drop_existing:
                        # 删除目标已存在的同名表再重建
                        self._exec_ddl_timeout(dst_conn, text(f"DROP TABLE IF EXISTS {_safe_ident(table_name, 'mysql')}"),
                                               table_name, "删除")
                    # 清理 OceanBase 专有语法后执行（不删除模式下，若表已存在则跳过建表避免冲突）
                    safe_ddl = self._sanitize_ddl(ddls[table_name])
                    if not self.drop_existing and _dst_table_exists(dst_conn, table_name):
                        _progress_q.put(("log", f"  ⏭ 表 [{table_name}] 目标已存在，跳过建表（保留原表）"))
                        continue
                    self._exec_ddl_timeout(dst_conn, text(safe_ddl), table_name, "创建")
                    _progress_q.put(("log", f"  ✅ 表 [{table_name}] 结构已创建"))
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        _progress_q.put(("log", "✅ 所有表结构创建完成"))

    def _transfer_single_table(self, src_engine, dst_engine,
                               table_name: str, table_index: int,
                               total_tables: int, dst_conn) -> int:
        prefix = f"[{table_index}/{total_tables}]" if total_tables > 1 else ""
        _progress_q.put(("log", f"{prefix} 📊 表 [{table_name}] 开始传输..."))
        # ★ 主键分页拉取：每次查询是独立短往返且 buffered 读取，I/O 等待期间不持有 GIL。
        #    源库为公网/大表时，流式读取（SSCursor fetch 不释放 GIL）会锁死整个进程导致 UI 无响应；
        #    无主键/唯一索引的表回退流式读取（批次减半缓解卡顿）
        # 不把元数据查询再套一层“可返回但不可取消”的 future。
        # 连接本身由数据库驱动控制超时，避免同步主流程报错后后台查询仍占用
        # 共享数据库线程池。
        pk_cols = _get_pk_columns(src_engine, table_name)
        if pk_cols:
            transferred, skipped = self._transfer_by_pk(src_engine, dst_conn, table_name, pk_cols)
        else:
            transferred, skipped = self._transfer_stream(src_engine, dst_conn, table_name)
        skip_msg = f"，跳过 {skipped:,} 行重复键" if skipped else ""
        _progress_q.put(("log", f"{prefix} ✅ 表 [{table_name}] 传输完成 ({transferred:,} 行{skip_msg})"))
        return transferred

    def _insert_batch(self, dst_conn, table_name, columns, col_list, values_tmpl, rows):
        """多值 INSERT IGNORE 一批行（每条约 800 行/512KB），返回跳过的行数"""
        qtable = _safe_ident(table_name, 'mysql')
        skipped = 0
        i = 0
        n_rows = len(rows)
        while i < n_rows:
            part = []
            part_rows = 0
            part_bytes = 0
            while i < n_rows and part_rows < 800 and part_bytes < 512 * 1024:
                row = rows[i]
                part.append(row)
                part_rows += 1
                i += 1
                part_bytes += sum(len(str(v)) if v is not None else 4 for v in row)
            sql = f"INSERT IGNORE INTO {qtable} ({col_list}) VALUES " + ", ".join([values_tmpl] * part_rows)
            flat = [v for row in part for v in row]
            # ★ 参数必须是「tuple 列表」（每组一个 tuple）：扁平 list 会被 SQLAlchemy
            #    误判为 executemany 参数组而报 "List argument must consist only of tuples"
            r = dst_conn.exec_driver_sql(sql, [tuple(flat)])
            # ★ rowcount 为实际受影响行数；小于本片行数 = 重复键被跳过
            affected = r.rowcount
            if affected is not None and affected >= 0:
                skipped += max(0, part_rows - affected)
            # ★ 每批提交：避免单表大事务撑爆 undo log → 磁盘满 → 服务器卡死 → SSH 断连
            #    每批 800 行事务极小，undo 可忽略；INSERT IGNORE 幂等，分批提交断点续传安全
            dst_conn.commit()
        return skipped

    def _transfer_by_pk(self, src_engine, dst_conn, table_name, pk_cols):
        """主键分页传输：WHERE pk > last ORDER BY pk LIMIT n（索引游标，不慢于流式）。
        每次查询是独立短往返 + buffered 读取，I/O 期间不持有 GIL，UI 保持响应"""
        pk = pk_cols[0]
        batch = max(self.batch_size or 10000, 1000)
        transferred = 0
        skipped = 0
        last = None
        with src_engine.connect() as src_conn:
            # ★ 记录服务端线程 ID，停止时可 KILL QUERY 立即中断
            self._record_src_conn_id(src_conn)
            # 先取列名：LIMIT 0 快速返回，不拉数据
            qtable = _safe_ident(table_name, 'mysql')
            result = src_conn.exec_driver_sql(f"SELECT * FROM {qtable} LIMIT 0")
            columns = list(result.keys())
            col_list = ', '.join(_safe_ident(c, 'mysql') for c in columns)
            values_tmpl = "(" + ", ".join(["%s"] * len(columns)) + ")"
            pk_index = columns.index(pk) if pk in columns else None
            while not self._stop_event.is_set():
                if last is None:
                    sql = f"SELECT * FROM {qtable} ORDER BY {_safe_ident(pk, 'mysql')} LIMIT {batch}"
                    rows = src_conn.exec_driver_sql(sql).fetchall()
                else:
                    sql = f"SELECT * FROM {qtable} WHERE {_safe_ident(pk, 'mysql')} > %s ORDER BY {_safe_ident(pk, 'mysql')} LIMIT {batch}"
                    rows = src_conn.exec_driver_sql(sql, [(last,)]).fetchall()
                if not rows:
                    break
                if pk_index is not None:
                    last = rows[-1][pk_index]
                transferred += len(rows)
                skipped += self._insert_batch(dst_conn, table_name, columns, col_list, values_tmpl, rows)
                _progress_q.put(("table_progress", {"count": transferred, "table": table_name}))
        return transferred, skipped

    def _transfer_stream(self, src_engine, dst_conn, table_name):
        """流式读取传输（无主键表回退）：批次调小以缓解 UI 卡顿"""
        batch = min(self.batch_size or 10000, 2000) if self.batch_size else 2000
        transferred = 0
        skipped = 0
        src_conn = src_engine.connect().execution_options(stream_results=True)
        # ★ 记录服务端线程 ID，停止时可 KILL QUERY 立即中断
        self._record_src_conn_id(src_conn)
        try:
            qtable = _safe_ident(table_name, 'mysql')
            result = src_conn.execute(text(f"SELECT * FROM {qtable}"))
            columns = list(result.keys())
            col_list = ', '.join(_safe_ident(c, 'mysql') for c in columns)
            values_tmpl = "(" + ", ".join(["%s"] * len(columns)) + ")"
            while not self._stop_event.is_set():
                rows = result.fetchmany(batch)
                if not rows:
                    break
                transferred += len(rows)
                skipped += self._insert_batch(dst_conn, table_name, columns, col_list, values_tmpl, rows)
                _progress_q.put(("table_progress", {"count": transferred, "table": table_name}))
        finally:
            src_conn.close()
        return transferred, skipped

    def _transfer_one_table_parallel(self, src_engine, dst_engine,
                                     table_name, table_index, total_tables):
        """并行传输单张表：独立连接 + 独立事务（导完即提交，互不影响）"""
        conn = dst_engine.connect()
        try:
            self._record_dst_conn_id(conn)
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
            rows = self._transfer_single_table(
                src_engine, dst_engine, table_name, table_index, total_tables, conn)
            conn.commit()
            return table_name, rows
        finally:
            # ★ 恢复外键检查并提交（避免连接回池后外键检查仍处于关闭状态）
            try:
                conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
                conn.commit()
            except Exception:
                pass
            conn.close()

    def run(self):
        src_engine = None
        dst_engine = None
        try:
            _progress_q.put(("log", "🔗 正在连接源库..."))
            src_engine = create_engine(self.src_url, pool_pre_ping=True,
                                       connect_args=_connect_args("mysql", timeout=10, read_timeout=3600))
            with src_engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            _progress_q.put(("log", "✅ 源库连接成功"))

            _progress_q.put(("log", "🔗 正在连接目标库..."))
            # 连接参数本身已有 connect_timeout；这里直接执行，避免 future
            # 超时后底层连接线程仍继续占用共享数据库线程池。
            self._create_dst_database()
            dst_engine = create_engine(self.dst_url, pool_pre_ping=True,
                                       connect_args=_connect_args("mysql", timeout=10, read_timeout=3600))
            _progress_q.put(("log", "✅ 目标库连接成功"))
            # ★ 检查目标库未结束事务（上次同步异常/程序强杀残留 → 元数据锁 → 建表阻塞）
            # innodb_trx 中有记录不代表一定持有会阻塞 DDL 的元数据锁，
            # 这里只做提示，不再因为活动事务记录直接终止传输。
            # 真正执行 DDL 时已设置 lock_wait_timeout=15，若确实被锁住会快速报错。
            pending_trx = self._check_dst_trx(dst_engine)
            if pending_trx:
                _progress_q.put((
                    "log",
                    f"ℹ️ 检测到 {len(pending_trx)} 个活动事务，但未确认其阻塞建表；"
                    "继续传输（DDL 锁等待上限 15 秒）"
                ))

            if self.manual_tables:
                # ★ 前端已按「只同步不存在的表」过滤好的表列表
                tables = [t.strip() for t in self.manual_tables if t.strip()]
                _progress_q.put(("log", f"📋 待同步表（已排除目标已存在）: {', '.join(tables) if tables else '（无）'}"))
                if not tables:
                    raise Exception("所有目标表都已存在，且未选择删除，无需传输")
            elif self.table_name:
                tables = [t.strip() for t in self.table_name.split(',') if t.strip()]
            else:
                _progress_q.put(("log", "📋 表名为空，将导入整个数据库..."))
                inspector = inspect(src_engine)
                tables = inspector.get_table_names()
                if not tables:
                    raise Exception("源数据库中未找到任何表")
                _progress_q.put(("log", f"📋 发现 {len(tables)} 张表: {', '.join(tables)}"))

            start_time = time.time()
            self._create_all_tables(src_engine, dst_engine, tables)

            if self._stop_event.is_set():
                _progress_q.put(("log", "⏸ 用户停止传输"))
            else:
                _progress_q.put(("log", "📊 阶段2：传输数据..."))
                total_rows = 0
                failed_tables = []
                if self.parallel and len(tables) > 1:
                    # ★ 多表并行：每表独立连接同时传输（每表独立事务，导完一张提交一张）
                    max_workers = min(len(tables), 4)
                    _progress_q.put(("log", f"⚡ 多表并行传输已开启（{max_workers} 路并发，每表独立连接）"))
                    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
                        futures = {ex.submit(self._transfer_one_table_parallel,
                                             src_engine, dst_engine, t, i, len(tables)): t
                                   for i, t in enumerate(tables, 1)}
                        for fut in concurrent.futures.as_completed(futures):
                            if self._stop_event.is_set():
                                _progress_q.put(("log", "⏸ 用户停止传输"))
                                break
                            try:
                                tn, rows = fut.result()
                                total_rows += rows
                            except Exception as e:
                                if self._stop_event.is_set():
                                    # ★ 停止引发的查询中断不算错误
                                    _progress_q.put(("log", "⏸ 用户停止传输"))
                                else:
                                    failed_tables.append(futures[fut])
                                    _progress_q.put(("error", f"❌ 表 [{futures[fut]}] 传输失败: {e}"))
                else:
                    # ★ 串行模式：共享连接，每导完一张表 commit 一次，避免一张表失败导致全部回滚
                    with dst_engine.connect() as dst_conn:
                        self._record_dst_conn_id(dst_conn)
                        dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
                        try:
                            for i, table in enumerate(tables, 1):
                                if self._stop_event.is_set():
                                    _progress_q.put(("log", "⏸ 用户停止传输"))
                                    break
                                rows = self._transfer_single_table(
                                    src_engine, dst_engine, table, i, len(tables), dst_conn)
                                total_rows += rows
                                dst_conn.commit()  # ★ 导完一张提交一张
                        finally:
                            # ★ 恢复外键检查并提交（避免连接回池后外键检查仍处于关闭状态）
                            try:
                                dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
                                dst_conn.commit()
                            except Exception:
                                pass

                if not self._stop_event.is_set() and not failed_tables:
                    elapsed = time.time() - start_time
                    speed = total_rows / elapsed if elapsed > 0 else 0
                    msg = (f"✅ 全部完成！共 {len(tables)} 张表，{total_rows:,} 行，"
                           f"耗时 {elapsed:.1f}s (平均 {speed:,.0f} 行/秒)")
                    _progress_q.put(("done", msg))
                    _progress_q.put(("total", total_rows))
                elif not self._stop_event.is_set() and failed_tables:
                    _progress_q.put((
                        "error",
                        f"❌ 同步未完成，失败表：{', '.join(failed_tables)}"
                    ))

            src_engine.dispose()
            dst_engine.dispose()
        except Exception as e:
            if self._stop_event.is_set():
                # ★ 停止引发的查询中断（KILL QUERY）不算错误，不弹失败弹窗
                _progress_q.put(("log", "⏸ 用户停止传输"))
            else:
                _progress_q.put(("error", f"❌ 传输失败: {str(e)}"))
        finally:
            # ★ 关键：无论成功/异常/超时，都必须关闭连接池。
            #    否则残留连接上的未提交事务会持有 MySQL 元数据锁（schema metadata lock），
            #    导致目标库的所有新连接全部阻塞在 "Waiting for schema metadata lock"
            for eng in (src_engine, dst_engine):
                if eng is not None:
                    try:
                        eng.dispose()
                    except Exception:
                        pass
            self._clear_conn_records()


# ==================== Eel 暴露接口 ====================

@eel.expose
def get_profiles():
    """获取所有配置列表"""
    return ProfileManager.load_all()


@eel.expose
def get_last_used():
    """获取上次使用的配置名"""
    return ProfileManager.get_last_used()


@eel.expose
def save_profile(data: dict, name: str):
    """保存配置"""
    data["name"] = name
    ProfileManager.save(data)
    ProfileManager.set_last_used(name)
    return True


@eel.expose
def delete_profile(name: str):
    """删除配置"""
    ProfileManager.delete(name)
    return True


@eel.expose
def find_profile(name: str):
    """查找配置"""
    return ProfileManager.find(name)


@eel.expose
def test_connection(data: dict, side: str):
    """测试连接（同步兼容接口，内部调用 tree_test_conn）
    ★ 改用异步线程池，不再阻塞 Eel 主线程
    """
    try:
        prefix = "src_" if side == "src" else "dst_"
        label = "源库" if side == "src" else "目标库"
        db_type = data.get(f'{prefix}db_type', 'mysql')
        # 测试连接只验证服务器/实例可达，不把目标库名放入连接串。
        # MySQL/OceanBase/MSSQL 均支持无具体数据库建立连接；真正同步时
        # 再由 TransferEngine 创建目标库并连接到它。
        test_db = data.get(f'{prefix}db', '')
        if db_type in ('mysql', 'ob-mysql', 'mssql'):
            test_db = ''
        conn_data = {
            'user': data.get(f'{prefix}user', ''),
            'pwd':  data.get(f'{prefix}pwd', ''),
            'host': data.get(f'{prefix}host', ''),
            'port': data.get(f'{prefix}port', '3306'),
            'db':   test_db,
            'db_type': db_type,
        }
        if not conn_data['host'] or not conn_data['user']:
            return {"ok": False, "msg": f"{label}连接信息不完整"}
        return tree_test_conn(conn_data)
    except Exception as e:
        return {"ok": False, "msg": f"{label}连接失败: {str(e)}"}


@eel.expose
def start_transfer(data: dict):
    """开始传输"""
    global _engine, _worker

    src_type = (data.get("src_db_type") or "mysql").lower()
    dst_type = (data.get("dst_db_type") or "mysql").lower()
    if src_type not in TRANSFER_DB_TYPES or dst_type not in TRANSFER_DB_TYPES:
        return {"ok": False, "msg": "全量同步当前仅支持 MySQL/OceanBase（MySQL 协议），请使用拖拽复制进行其他数据库类型转换"}
    if src_type != dst_type:
        return {"ok": False, "msg": "全量同步暂不支持不同数据库类型之间直接同步，请使用拖拽复制或导出导入"}

    # 不再清空全局队列：清空会丢失其他任务的进度消息。当前同步入口
    # 仍为单任务模型，重复启动由前端禁用按钮并在服务端再次拒绝。
    if _worker is not None and _worker.is_alive():
        return {"ok": False, "msg": "已有同步任务正在运行，请先停止当前任务"}
    if not _claim_progress_task('transfer'):
        return {"ok": False, "msg": "已有导入或导出任务正在运行，请稍后再试"}

    _engine = TransferEngine(data)
    def _run_transfer():
        global _engine
        engine = _engine
        try:
            if engine is not None:
                engine.run()
        finally:
            if engine is not None:
                engine._clear_conn_records()
            if _engine is engine:
                _engine = None
            _release_progress_task('transfer')
    _worker = threading.Thread(target=_run_transfer, daemon=True)
    _worker.start()
    return {"ok": True}


@eel.expose
def stop_transfer():
    """停止传输"""
    global _engine
    if _engine:
        _engine.stop()
    return True


@eel.expose
def check_target_tables(data: dict):
    """传输前检查：连接目标库，返回输入表列表中已存在的表"""
    dst_engine = None
    try:
        dst_user = data.get("dst_user") or ""
        dst_pwd = data.get("dst_pwd") or ""
        dst_host = data.get("dst_host") or ""
        dst_port = data.get("dst_port") or "3306"
        dst_db = data.get("dst_db") or ""
        dst_db_type = data.get("dst_db_type") or "mysql"
        u = quote_plus(dst_user)
        p = quote_plus(dst_pwd)
        # 这里只检查服务器是否可连接，不能把一个尚未创建的目标库
        # 放入 URL；真正的目标库创建在 TransferEngine.run() 中完成。
        if dst_db_type in ('mysql', 'ob-mysql'):
            url = f"mysql+mysqldb://{u}:{p}@{dst_host}:{dst_port}/?charset=utf8mb4"
        else:
            url = _conn_url({
                "user": dst_user, "pwd": dst_pwd, "host": dst_host,
                "port": dst_port, "db": "", "db_type": dst_db_type
            })
        dst_engine = create_engine(url, pool_pre_ping=True,
                                   connect_args=_connect_args(dst_db_type, timeout=10, read_timeout=60))
        tables_to_check = data.get("tables") or []
        if isinstance(tables_to_check, str):
            tables_to_check = [t.strip() for t in tables_to_check.split(",") if t.strip()]
        existing = []
        with dst_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            for t in tables_to_check:
                if _dst_table_exists_for_type(conn, t, dst_db, dst_db_type, data.get("dst_schema", "")):
                    existing.append(t)
        missing = [t for t in tables_to_check if t not in existing]
        return {"ok": True, "existing": existing, "missing": missing}
    except Exception as e:
        return {"ok": False, "msg": str(e), "existing": [], "missing": []}
    finally:
        # ★ 任何路径都释放连接，防止检查泄漏连接
        if dst_engine is not None:
            try:
                dst_engine.dispose()
            except Exception:
                pass


@eel.expose
def poll_queue():
    """前端轮询：获取所有待处理的进度消息"""
    msgs = []
    while not _progress_q.empty():
        try:
            msgs.append(_progress_q.get_nowait())
        except queue.Empty:
            break
    return msgs


def _is_cancelled(conn_key=''):
    """检查当前查询是否已被取消。

    有连接标识时只读取该连接的取消标记，避免新查询清理全局事件时
    误解除其他查询，或一个查询取消后影响所有页面。
    """
    if conn_key:
        return bool(_query_conn_cancel_flags.get(conn_key))
    return _query_cancel.is_set()


def _is_long_running_sql(sql: str) -> bool:
    """Return whether SQL is a schema-changing statement that may run for a long time."""
    if not isinstance(sql, str):
        return False
    # Ignore leading whitespace and common SQL comments before checking the verb.
    stripped = re.sub(
        r"^(?:\s|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|/\*.*?\*/)*",
        "", sql, flags=re.DOTALL,
    )
    return bool(re.match(
        r"(?is)^(?:ALTER|CREATE|DROP|TRUNCATE|RENAME|OPTIMIZE|REPAIR|ANALYZE)\b",
        stripped,
    ))


def _set_mysql_read_timeout(url: str, seconds: int) -> str:
    """Set the MySQL driver's socket read timeout in a SQLAlchemy URL."""
    seconds = max(1, int(seconds))
    if re.search(r"([?&])read_timeout=", url, flags=re.IGNORECASE):
        return re.sub(
            r"([?&])read_timeout=\d+",
            rf"\g<1>read_timeout={seconds}",
            url,
            flags=re.IGNORECASE,
        )
    return f"{url}&read_timeout={seconds}" if "?" in url else f"{url}?read_timeout={seconds}"


def _do_execute_sql_query(sql: str, data: dict, job_id: str = '', conn_key: str = ''):
    """在独立线程中执行 SQL 查询（核心逻辑）。

    性能优化：
    - 使用 fetchmany 分批取数，避免一次性 fetchall() 在纯 Python
      实现下对大结果集（数千行 × 数十列 Decimal）反序列化耗时爆炸
    - 返回详细计时分解（server_ms / exec_ms / fetch_ms / serial_ms）
    - 首屏只返回前 200 行；全量原始行存入 _query_result_store 供按需加载

    取数机制：
    - 所有原始行存入 _query_result_store[job_id]
    - poll_query_result 返回首屏 200 行
    - 前端通过 get_query_page(job_id, offset, limit) 按需取更多行，
      支持"显示全部"（无行数上限）
    """
    global _query_conn_id, _query_src_data
    # 取消标记按连接隔离；开始同一连接的新查询时仅清除自己的旧标记。
    if conn_key:
        _query_conn_cancel_flags.pop(conn_key, None)
    _query_conn_id = None
    _query_src_data = data  # 保存源库信息用于 cancel 时 kill
    # ★ 保存连接数据映射（用于 cancel_query(conn_id) 时 kill 该连接的查询）
    if conn_key:
        with _query_state_lock:
            _query_conn_data_map[conn_key] = data
            _query_job_conn[job_id] = conn_key
    DEFAULT_PAGE_SIZE = 200  # 首屏默认显示行数
    BATCH = 1000             # 每次从结果集取 1000 行进行处理
    # ★ 最大拉取行数保护：防止大表 SELECT 把全量行堆进内存导致 OOM 崩溃
    #   （进程崩溃时若正执行写入/DDL，残留连接同样会引发元数据锁问题）
    MAX_FETCH_ROWS = 500000
    engine = None
    truncated = False
    query_columns = []
    query_rows = []
    query_pid = None

    try:
        # 兼容两种数据格式：{host,user,pwd} 和 {src_host,src_user,src_pwd}
        if "user" not in data:
            data = {
                "host": data.get("src_host", ""), "port": data.get("src_port", "3306"),
                "user": data.get("src_user", ""), "pwd": data.get("src_pwd", ""),
                "db": data.get("src_db", ""), "db_type": data.get("db_type", "mysql"),
                "ora_mode": data.get("ora_mode", "service_name")
            }
        db_type = data.get("db_type", "mysql")
        url = _conn_url(data)
        if db_type in ('mysql', 'ob-mysql'):
            read_timeout = (_MYSQL_DDL_READ_TIMEOUT if _is_long_running_sql(sql)
                            else _MYSQL_NORMAL_READ_TIMEOUT)
            url = _set_mysql_read_timeout(url, read_timeout)
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            if _is_cancelled(conn_key):
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            # 记录连接 ID，用于 cancel 时 kill query（支持 MySQL/PG/Oracle/MSSQL）
            query_pid = _get_backend_pid(conn, db_type)
            _query_conn_id = query_pid
            if conn_key and query_pid:
                with _query_state_lock:
                    _query_conn_pid_map[conn_key] = query_pid
            # ★ 增加 MySQL 服务器端执行超时为 120 秒（30秒对复杂查询太短）
            try:
                if not _is_long_running_sql(sql):
                    conn.execute(text("SET SESSION MAX_EXECUTION_TIME = 120000"))
            except Exception:
                pass
            # ★ PG：自动回滚失败的事务，然后开启新事务（避免 "current transaction is aborted" 和 "DECLARE CURSOR" 错误）
            if db_type == 'postgresql':
                try:
                    conn.execute(text("ROLLBACK"))
                    conn.execute(text("BEGIN"))
                except Exception:
                    pass

            import time as _time
            _t0 = _time.perf_counter()
            # ★ 先用 stream_results=True 让 execute() 不缓冲全量行（只获取元数据），
            #    再用 fetchmany 按批从服务端拉取，每批限量 max_fetch_rows 保护
            # ★ 用 exec_driver_sql 直接执行原生 SQL：避免 text() 把 SQL 文本中的
            #    ":7004"（如 JSON 字符串 "port":7004 的值）误解析为命名绑定参数
            result = conn.execution_options(stream_results=True).exec_driver_sql(sql)
            _t_exec = _time.perf_counter()  # 查询提交 + 元数据接收完成

            if _is_cancelled(conn_key):
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            if result.returns_rows:
                query_columns = list(result.keys())
                # ★ 批量 fetchmany 从服务端逐批拉取：
                #    避免了默认 Cursor 在 execute() 时一次性反序列化全量行
                #    → 大结果集（万行级 × Decimal 列）下可提速 5-10 倍
                query_rows = []
                while True:
                    if _is_cancelled(conn_key):
                        result.close()
                        return {"ok": False, "msg": "查询已取消", "cancelled": True}
                    batch = result.fetchmany(BATCH)
                    if not batch:
                        break
                    for row in batch:
                        query_rows.append(list(row))
                    # ★ 行数保护：达到上限停止拉取；with 退出时连接关闭，
                    #    服务器端查询自动终止（不残留任何锁/事务）
                    if len(query_rows) >= MAX_FETCH_ROWS:
                        truncated = True
                        break
                result.close()
            else:
                # INSERT/UPDATE/DELETE 等写入操作：提交并返回影响行数
                conn.commit()
                rc = result.rowcount
            _t1 = _time.perf_counter()
            _server_ms = round((_t1 - _t0) * 1000, 1)
            _exec_ms = round((_t_exec - _t0) * 1000, 1)
            _fetch_ms = round((_t1 - _t_exec) * 1000, 1)
        # 写入操作提前返回（无需序列化行数据）
        if not result.returns_rows:
            return {"ok": True, "msg": f"成功执行，影响 {rc} 行", "columns": [], "rows": [], "total": rc,
                    "server_ms": _server_ms}

        if _is_cancelled(conn_key):
            return {"ok": False, "msg": "查询已取消", "cancelled": True}

        # ★ 将全量原始行存入持久存储，供后续按需加载
        total_rows = len(query_rows)
        if job_id:
            # 清理旧的同名缓存（防止内存泄漏）
            with _query_state_lock:
                if job_id not in _query_jobs:
                    # 前端已经关闭 Tab/释放结果，放弃保存迟到的大结果。
                    return {"ok": False, "msg": "查询结果已释放", "cancelled": True}
                _query_result_store.pop(job_id, None)
                _query_result_store[job_id] = {
                    "columns": query_columns,
                    "rows_raw": query_rows,
                    "total": total_rows,
                    "db_type": db_type
                }
                _query_state_time[job_id] = time.time()

        # ★ 首屏只 JSON 化前 DEFAULT_PAGE_SIZE 行（200行）；其余按需通过 get_query_page 加载
        _ts0 = _time.perf_counter()
        first_page_rows = query_rows[:DEFAULT_PAGE_SIZE]
        safe_rows = [_row_to_json(r) for r in first_page_rows]
        _serial_ms = round((_time.perf_counter() - _ts0) * 1000, 1)

        return {
            "ok": True,
            "columns": query_columns,
            "rows": safe_rows,
            "total": total_rows,
            "server_ms": _server_ms,
            "exec_ms": _exec_ms,
            "fetch_ms": _fetch_ms,
            "serial_ms": _serial_ms,
            # ★ 行数元数据（前端据此渲染行数选择器）
            "page": 0,
            "page_size": DEFAULT_PAGE_SIZE,
            "page_total": min(total_rows, DEFAULT_PAGE_SIZE),  # 首屏已显示的行数
            "_job_id": job_id,  # 回传 job_id 供后续加载使用
            "truncated": truncated  # ★ 行数超上限被截断（前端可提示）
        }
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, data.get('db_type','mysql'))}
    finally:
        # ★ 任何路径（成功/异常/取消）都释放连接池，防止连接积压
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                pass


# ★ 异步查询结果存储（job_id → result or None=等待中）
_query_jobs = {}
# ★ 查询结果行数据持久存储（job_id → {columns, rows_raw, total, db_type}）
#    用于按需加载：首屏返回 200 行，后续通过 get_query_page 加载更多行
_query_result_store = {}


def _cleanup_query_state():
    """定期回收客户端异常关闭后遗留的查询状态和大结果集。"""
    while True:
        time.sleep(60)
        cutoff = time.time() - _QUERY_STATE_TTL
        with _query_state_lock:
            for jid, touched in list(_query_state_time.items()):
                if touched < cutoff:
                    conn_key = _query_job_conn.pop(jid, None)
                    _query_jobs.pop(jid, None)
                    _query_result_store.pop(jid, None)
                    _query_state_time.pop(jid, None)
                    if conn_key and not any(v == conn_key for v in _query_job_conn.values()):
                        _query_conn_data_map.pop(conn_key, None)
                        _query_conn_pid_map.pop(conn_key, None)
                        _query_conn_cancel_flags.pop(conn_key, None)


threading.Thread(target=_cleanup_query_state, daemon=True, name="query_state_cleanup").start()

@eel.expose
def execute_sql_query(sql: str, data: dict):
    """执行 SQL 查询（异步模式：立即返回 job_id，不阻塞 Eel 主线程）

    JS 侧收到 _async=True 后，应轮询 poll_query_result(job_id) 获取结果。
    这样做彻底解决 future.result() 阻塞 bottle 单线程服务器问题，
    让执行 SQL 期间仍能打开数据库连接、切换查询 Tab 等。
    """
    import uuid
    job_id = str(uuid.uuid4())
    conn_key = _make_conn_key(data)
    with _query_state_lock:
        _query_jobs[job_id] = None  # None = 等待中
        _query_job_conn[job_id] = conn_key
        _query_state_time[job_id] = time.time()

    # ★ 生成连接标识，用于后续 cancel_query(conn_id) 只取消该连接的查询

    def _run():
        engine = None
        try:
            result = _do_execute_sql_query(sql, data, job_id=job_id, conn_key=conn_key)
        except Exception as e:
            result = {"ok": False, "msg": str(e)}
        with _query_state_lock:
            if job_id in _query_jobs:
                _query_jobs[job_id] = result
                _query_state_time[job_id] = time.time()

    _get_db_thread_pool().submit(_run)
    return {"ok": True, "_async": True, "_job_id": job_id}

def _make_conn_key(data):
    """从连接数据生成唯一标识（用于区分不同连接的查询）"""
    # SQL editor calls use src_* fields. Do not collapse all of them into :::;
    # cancellation must only affect the selected database connection.
    host = data.get('host') or data.get('src_host', '')
    port = data.get('port') or data.get('src_port', '3306')
    user = data.get('user') or data.get('src_user', '')
    database = data.get('db') or data.get('src_db', '')
    db_type = data.get('db_type', 'mysql')
    return f"{db_type}:{host}:{port}:{user}:{database}"


@eel.expose
def poll_query_result(job_id: str):
    """轮询异步查询结果。返回 _pending=True 表示仍在执行中。"""
    with _query_state_lock:
        if job_id not in _query_jobs:
            return {"ok": False, "msg": "未知的查询 ID"}
        result = _query_jobs[job_id]
        _query_state_time[job_id] = time.time()
    if result is None:
        return {"_pending": True}
    # 返回结果后清理 _query_jobs（但保留 _query_result_store 供分页使用）
    with _query_state_lock:
        del _query_jobs[job_id]
        _query_state_time[job_id] = time.time()
        # 任务已经完成，立即移除 job -> connection 映射；结果缓存仍由
        # release_query_result()/TTL 管理，避免连接信息额外保留 15 分钟。
        conn_key = _query_job_conn.pop(job_id, None)
        if conn_key and not any(v == conn_key for v in _query_job_conn.values()):
            _query_conn_data_map.pop(conn_key, None)
            _query_conn_pid_map.pop(conn_key, None)
            _query_conn_cancel_flags.pop(conn_key, None)
    return result


@eel.expose
def get_query_page(job_id: str, offset: int = 0, limit: int = 200):
    """从已完成的查询中按偏移量获取指定行（用于按需加载/显示全部）。

    调用时机：前端已通过 poll_query_result 拿到首屏结果后，
    用户调整显示行数或点击"显示全部"时调用此接口。

    注意：单次最多返回 500 行，小批次响应快（每批 <0.3s），
    配合前端虚拟滚动异步递归加载，不会阻塞 bottle 主线程。
    """
    with _query_state_lock:
        if job_id not in _query_result_store:
            return {"ok": False, "msg": "查询结果已过期，请重新执行"}
        store = _query_result_store[job_id]
        _query_state_time[job_id] = time.time()
    rows_raw = store.get("rows_raw", [])
    total = len(rows_raw)
    # ★ 单次上限 500 行：_row_to_json 小批次快速完成，不阻塞 bottle 主线程
    limit = min(max(limit, 1), 500)
    end = min(offset + limit, total)
    slice_rows = rows_raw[offset:end]
    safe_rows = [_row_to_json(r) for r in slice_rows]
    return {
        "ok": True,
        "rows": safe_rows,
        "offset": offset,
        "limit": limit,
        "total": total,
        "page_end": end
    }


@eel.expose
def release_query_result(job_id: str):
    """释放查询结果缓存（用户关闭查询 tab 或执行新查询时调用）"""
    cancel_conn = None
    with _query_state_lock:
        pending = job_id in _query_jobs and _query_jobs[job_id] is None
        conn_key = _query_job_conn.get(job_id)
        other_jobs_on_conn = bool(
            conn_key and any(
                jid != job_id and value == conn_key
                for jid, value in _query_job_conn.items()
            )
        )
        if pending and conn_key and not other_jobs_on_conn:
            # 关闭仍在执行的查询时，先标记并在锁外 KILL，避免后台 SQL
            # 在前端已经释放 job 后继续占用数据库连接。
            _query_conn_cancel_flags[conn_key] = True
            cancel_conn = conn_key
        _query_jobs.pop(job_id, None)
        _query_result_store.pop(job_id, None)
        _query_job_conn.pop(job_id, None)
        _query_state_time.pop(job_id, None)
        if conn_key and not other_jobs_on_conn and cancel_conn is None:
            _query_conn_data_map.pop(conn_key, None)
            _query_conn_pid_map.pop(conn_key, None)
            _query_conn_cancel_flags.pop(conn_key, None)
    if cancel_conn:
        _kill_db_query_for_conn(cancel_conn)
        with _query_state_lock:
            if not any(v == cancel_conn for v in _query_job_conn.values()):
                _query_conn_data_map.pop(cancel_conn, None)
                _query_conn_pid_map.pop(cancel_conn, None)
                _query_conn_cancel_flags.pop(cancel_conn, None)
    return True



@eel.expose
def clear_cancel():
    """清除取消标记（新操作开始前调用）"""
    _query_cancel.clear()
    _query_conn_cancel_flags.clear()
    # ★ 同时清除 modules 包的取消标记
    try:
        import modules
        modules._query_cancel.clear()
    except Exception:
        pass
    return True

@eel.expose
def cancel_query(conn_id=None):
    """取消查询。conn_id 可选：指定则只取消该连接的查询，否则取消全部（兼容旧调用）"""
    if conn_id:
        # ★ 只取消指定连接的查询，不影响其他连接
        with _query_state_lock:
            _query_conn_cancel_flags[conn_id] = True
            # 清理该连接下的待完成任务
            for jid in list(_query_jobs.keys()):
                if _query_job_conn.get(jid) == conn_id and _query_jobs[jid] is None:
                    _query_jobs[jid] = {"ok": False, "msg": "查询已取消", "cancelled": True}
                    _query_state_time[jid] = time.time()
            # 清理该连接的结果缓存
            for jid in list(_query_result_store.keys()):
                if _query_job_conn.get(jid) == conn_id:
                    _query_result_store.pop(jid, None)
                    _query_state_time.pop(jid, None)
        # 杀掉该连接的数据库查询（如果有）
        _kill_db_query_for_conn(conn_id)
        print(f"[cancel_query] 已取消连接 {conn_id} 的查询")
    else:
        # 全局取消（兼容旧的 cancelExport / cancelExecQuery 等调用）
        _query_cancel.set()
        with _query_state_lock:
            for key in list(_query_conn_data_map.keys()):
                _query_conn_cancel_flags[key] = True
        try:
            import modules
            modules._query_cancel.set()
        except Exception:
            pass
        with _query_state_lock:
            for jid in list(_query_jobs.keys()):
                if _query_jobs[jid] is None:
                    _query_jobs[jid] = {"ok": False, "msg": "查询已取消", "cancelled": True}
                    _query_state_time[jid] = time.time()
            for jid in list(_query_result_store.keys()):
                _query_result_store.pop(jid, None)
                _query_state_time.pop(jid, None)
        # 同时取消 UPDATE/DELETE/DDL/同步等非查询接口，并终止它们登记的会话。
        _cancel_registered_db_operations()
        _kill_db_query()
    return True


def _kill_db_query_for_conn(conn_id):
    """尝试杀掉指定连接的数据库查询。用保存的连接信息创建新连接执行 KILL。"""
    src = _query_conn_data_map.get(conn_id)
    if not src:
        return
    try:
        db_type = src.get('db_type', 'mysql')
        kill_engine = create_engine(_conn_url(src), connect_args=_connect_args(db_type, timeout=5))
        try:
            with kill_engine.connect() as kc:
                # 使用查询连接实际记录的 PID；不能读取 killer 自己的 PID。
                cid = _query_conn_pid_map.get(conn_id)
                if not cid:
                    return
                try:
                    if db_type == 'mysql' or db_type == 'ob-mysql':
                        kc.execute(text(f"KILL QUERY {cid}"))
                    elif db_type == 'postgresql':
                        kc.execute(text(f"SELECT pg_terminate_backend({cid})"))
                    elif db_type == 'oracle':
                        kc.execute(text(f"ALTER SYSTEM KILL SESSION '{cid}' IMMEDIATE"))
                    elif db_type == 'mssql':
                        kc.execute(text(f"KILL {cid}"))
                except Exception:
                    pass
        finally:
            kill_engine.dispose()
    except Exception:
        pass





def _kill_db_query():
    """尝试杀掉当前正在运行的数据库查询（支持 MySQL/PostgreSQL/Oracle/MSSQL）"""
    with _query_state_lock:
        conn_ids = list(_query_conn_pid_map.keys())
    for conn_id in conn_ids:
        _kill_db_query_for_conn(conn_id)


def _get_backend_pid(conn, db_type: str):
    """获取当前数据库连接的后端 PID（用于 cancel 时 KILL SESSION）。
    支持 MySQL/OB-MySQL/PostgreSQL/Oracle/MSSQL。"""
    try:
        if db_type in ('mysql', 'ob-mysql'):
            return conn.execute(text("SELECT CONNECTION_ID()")).scalar()
        elif db_type == 'postgresql':
            return conn.execute(text("SELECT pg_backend_pid()")).scalar()
        elif db_type == 'oracle':
            row = conn.execute(text(
                "SELECT SID||','||SERIAL# FROM V$SESSION WHERE AUDSID = SYS_CONTEXT('USERENV','SESSIONID')"
            )).fetchone()
            return row[0] if row else None
        elif db_type == 'mssql':
            return conn.execute(text("SELECT @@SPID")).scalar()
    except Exception:
        pass
    return None


def _register_db_operation(operation_id, conn_data, kind='query'):
    """登记一个可取消的数据库操作。

    一个同步操作可能同时持有源库 SELECT 和目标库 INSERT 两个会话，
    因此 sessions 使用列表而不是单个全局 PID。
    """
    op_id = str(operation_id or ('db_op_' + str(time.time_ns())))
    state = {
        'operation_id': op_id,
        'conn_data': dict(conn_data or {}),
        'kind': kind,
        'cancel_event': threading.Event(),
        'sessions': [],
    }
    with _db_operation_lock:
        _db_operation_states[op_id] = state
    return state


def _finish_db_operation(state):
    if not state:
        return
    with _db_operation_lock:
        if _db_operation_states.get(state.get('operation_id')) is state:
            _db_operation_states.pop(state.get('operation_id'), None)


def _add_db_operation_session(state, conn_data, pid, kill_connection=False):
    if not state or not pid:
        return
    session = {
        'conn_data': dict(conn_data or state.get('conn_data') or {}),
        'pid': pid,
        'kill_connection': bool(kill_connection),
    }
    with _db_operation_lock:
        state.setdefault('sessions', []).append(session)


def _clear_db_operation_sessions(state):
    if state:
        with _db_operation_lock:
            state['sessions'] = []


def _db_operation_cancelled(state):
    return bool(state and state.get('cancel_event') and state['cancel_event'].is_set())


def _kill_db_session(conn_data, pid, kill_connection=False):
    """用独立连接终止指定数据库会话/语句，失败时返回 False。"""
    if not conn_data or not pid:
        return False
    cdata = dict(conn_data)
    db_type = cdata.get('db_type', 'mysql')
    killer = None
    try:
        killer = create_engine(_conn_url(cdata),
                               connect_args=_connect_args(db_type, timeout=5))
        with killer.connect() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                command = 'KILL CONNECTION' if kill_connection else 'KILL QUERY'
                conn.exec_driver_sql(f"{command} {int(pid)}")
            elif db_type == 'postgresql':
                conn.execute(text("SELECT pg_terminate_backend(:pid)"), {'pid': int(pid)})
            elif db_type == 'oracle':
                conn.exec_driver_sql(f"ALTER SYSTEM KILL SESSION '{str(pid)}' IMMEDIATE")
            elif db_type == 'mssql':
                conn.exec_driver_sql(f"KILL {int(pid)}")
            else:
                return False
        return True
    except Exception:
        return False
    finally:
        if killer is not None:
            try:
                killer.dispose()
            except Exception:
                pass


def _kill_db_operation(state):
    killed = False
    if not state:
        return killed
    with _db_operation_lock:
        sessions = list(state.get('sessions') or [])
    for session in sessions:
        killed = _kill_db_session(
            session.get('conn_data'), session.get('pid'),
            session.get('kill_connection', False)
        ) or killed
    return killed


def _cancel_registered_db_operations():
    with _db_operation_lock:
        states = list(_db_operation_states.values())
        for state in states:
            state['cancel_event'].set()
    for state in states:
        _kill_db_operation(state)


def _cancel_registered_db_operation(operation_id):
    """取消指定的数据库操作，供信息面板切换连接时释放旧请求。"""
    if not operation_id:
        return False
    with _db_operation_lock:
        state = _db_operation_states.get(str(operation_id))
        if state is None:
            return False
        state['cancel_event'].set()
    _kill_db_operation(state)
    return True


def _connect_args(db_type='mysql', timeout=10, read_timeout=None):
    """返回 create_engine 的 connect_args，MySQL 禁用 SSL"""
    if db_type == 'oracle':
        # oracledb tcp_connect_timeout 单位是秒（float），不是毫秒
        return {"tcp_connect_timeout": float(timeout)}
    args = {"connect_timeout": timeout}
    if db_type in ('mysql', 'ob-mysql'):
        # mysqlclient (MySQLdb) 用 ssl=False 禁用 SSL（不是 pymysql 的 ssl_disabled）
        args["ssl"] = False
        # ★ mysqlclient (MySQLdb) 支持 read_timeout（秒），用于大表读取/长查询
        if read_timeout:
            args["read_timeout"] = read_timeout
    return args

# 数据库连接线程池：所有数据库操作都在独立 OS 线程中执行，
# 带硬超时。彻底避免 C 扩展（oracledb/psycopg2/pymysql）阻塞主线程。
_db_thread_pool = None

def _get_db_thread_pool():
    global _db_thread_pool
    if _db_thread_pool is None:
        _db_thread_pool = concurrent.futures.ThreadPoolExecutor(max_workers=6, thread_name_prefix="db_worker_")
    return _db_thread_pool

def _with_db_timeout(func, *args, timeout=15, **kwargs):
    """在独立 OS 线程中执行数据库操作（异步非阻塞模式）。

    立即返回 job_id，实际工作在独立线程中执行。
    JS 侧轮询 poll_query_result 获取结果。
    看门狗线程确保任务不会永久卡住。
    """
    import uuid
    job_id = str(uuid.uuid4())  # 完整 UUID 避免冲突
    with _query_state_lock:
        _query_jobs[job_id] = None  # None = 等待中
        _query_state_time[job_id] = time.time()

    def _run():
        try:
            result = func(*args, **kwargs)
        except Exception as e:
            result = {"ok": False, "msg": str(e)}
        with _query_state_lock:
            if job_id in _query_jobs and _query_jobs[job_id] is None:
                _query_jobs[job_id] = result
                _query_state_time[job_id] = time.time()

    _get_db_thread_pool().submit(_run)
    # 不再启动“假超时”看门狗：Python 线程无法安全取消正在执行的数据库
    # 调用，提前返回失败会让前端误以为任务结束，而底层 SQL 仍占用连接和
    # worker。数据库驱动自身的 connect/read timeout 负责真正的超时控制。
    return {"ok": True, "_async": True, "_job_id": job_id}

# ==================== 表操作 ====================
def _safe_ident(ident, db_type='mysql'):
    """按数据库方言安全引用标识符。

    标识符不能用值参数绑定，因此必须在拼接 SQL 前严格校验并转义
    包围符。这里统一始终引用，既能处理保留字，也避免名称中包含
    引号时破坏 SQL 语法。
    """
    if ident is None:
        raise ValueError("标识符不能为空")
    ident = str(ident)
    if not ident or len(ident) > 255 or any(ord(ch) < 32 for ch in ident):
        raise ValueError("标识符为空、过长或包含控制字符")
    if db_type in ('mysql', 'ob-mysql'):
        return f'`{ident.replace("`", "``")}`'
    if db_type in ('postgresql', 'oracle', 'sqlite'):
        return f'"{ident.replace(chr(34), chr(34) * 2)}"'
    if db_type == 'mssql':
        return f'[{ident.replace("]", "]]" )}]'
    raise ValueError(f"不支持的数据库类型: {db_type}")


def _sql_literal(value):
    """Quote a string literal for DDL generated by this module.

    Identifiers are handled by ``_safe_ident``; values in generated DDL must
    use the SQL-standard doubled quote form so this also works on PostgreSQL,
    Oracle and SQL Server.
    """
    return "'" + str(value).replace("'", "''") + "'"


def _validate_design_payload(design):
    """Validate the untrusted table-design payload before generating DDL."""
    if not isinstance(design, dict):
        raise ValueError("无效的表设计数据")
    columns = design.get("columns")
    if not isinstance(columns, list) or not columns:
        raise ValueError("至少保留一个字段，不能提交空字段列表")
    names = []
    for col in columns:
        if not isinstance(col, dict):
            raise ValueError("字段定义格式错误")
        name = str(col.get("name", "")).strip()
        if not name:
            raise ValueError("字段名不能为空")
        names.append(name.casefold())
        col_type = str(col.get("col_type", col.get("data_type", ""))).strip()
        if not col_type:
            raise ValueError(f"字段 [{name}] 的类型不能为空")
        if any(token in col_type for token in (";", "--", "/*", "*/")) or any(ord(ch) < 32 for ch in col_type):
            raise ValueError(f"字段 [{name}] 的类型包含非法 SQL 内容")
    if len(names) != len(set(names)):
        raise ValueError("字段名不能重复")
    indexes = design.get("indexes", [])
    if not isinstance(indexes, list):
        raise ValueError("索引定义格式错误")
    idx_names = []
    for idx in indexes:
        if not isinstance(idx, dict):
            raise ValueError("索引定义格式错误")
        if idx.get("type") == "PRIMARY":
            continue
        name = str(idx.get("name", "")).strip()
        cols = idx.get("columns") or []
        if not name or not isinstance(cols, list) or not cols:
            raise ValueError("索引名和索引字段不能为空")
        idx_names.append(name.casefold())
    if len(idx_names) != len(set(idx_names)):
        raise ValueError("索引名不能重复")
    options = design.get("table_options") or {}
    for key in ("engine", "collation"):
        value = str(options.get(key) or "")
        if any(token in value for token in (";", "--", "/*", "*/")):
            raise ValueError(f"表属性 [{key}] 包含非法 SQL 内容")


def _infer_column_renames(existing_names, new_columns):
    """Infer safe renames only when the complete column order is unchanged.

    The UI historically sent only the new name. Requiring equal column counts
    and matching positions avoids mistaking an add/drop operation for a
    rename, while preserving data for the common rename-only case.
    """
    new_names = [str(c.get("name", "")).strip() for c in new_columns]
    if len(existing_names) != len(new_names):
        return {}
    old_set = {str(n).casefold() for n in existing_names}
    new_set = {n.casefold() for n in new_names}
    renames = {}
    for old, new in zip(existing_names, new_names):
        if str(old).casefold() != new.casefold() and str(old).casefold() not in new_set and new.casefold() not in old_set:
            renames[new] = old
    return renames


def _valid_fk_action(value):
    value = str(value or "RESTRICT").upper()
    return value if value in {"RESTRICT", "CASCADE", "SET NULL", "NO ACTION", "SET DEFAULT"} else "RESTRICT"


def _defaults_equal(left, right):
    left = "" if left is None else str(left).strip()
    right = "" if right is None else str(right).strip()
    # MySQL exposes DEFAULT '' as an empty string, while the designer sends
    # the explicit literal '' so that it can be distinguished from no default.
    if left in ("''", '""') and right == "":
        left = right
    if right in ("''", '""') and left == "":
        right = left
    return left == right

def _build_table_ref(conn_data, database, table_name, schema=''):
    """构建带正确引号的全限定表名（如 `db`.`tbl` / \"sch\".\"tbl\" / [db].[tbl]）"""
    db_type = conn_data.get("db_type", "mysql")
    if db_type in ('mysql', 'ob-mysql'):
        return f"{_safe_ident(database, db_type)}.{_safe_ident(table_name, db_type)}"
    elif db_type == 'postgresql':
        q = schema if schema else database
        return f'{_safe_ident(q, db_type)}.{_safe_ident(table_name, db_type)}'
    elif db_type == 'oracle':
        return f'{_safe_ident(database, db_type)}.{_safe_ident(table_name, db_type)}'
    elif db_type == 'mssql':
        return f'{_safe_ident(database, db_type)}.{_safe_ident(table_name, db_type)}'
    elif db_type == 'sqlite':
        return _safe_ident(table_name, db_type)
    raise ValueError(f"不支持的数据库类型: {db_type}")

@eel.expose
def table_preview_data(conn_data, database, table_name, schema='', order_col='', order_dir='', limit=None, operation_id=None):
    """加载表数据（全量或限量）。limit 为空时全量，否则只取前 N 行"""
    global _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = None
    op_state = None
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'postgresql' and cdata.get('db_type') != 'oracle':
            # ★ PG 和 Oracle：database 参数实际是 schema，不要覆盖原连接的 database 名
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        db_type = cdata.get('db_type', 'mysql')
        op_state = _register_db_operation(operation_id, cdata, 'table_preview')
        # 构建 ORDER BY
        order_clause = ''
        if order_col and order_dir:
            safe_col = _safe_ident(order_col, db_type)
            direction = 'DESC' if order_dir == 'desc' else 'ASC'
            order_clause = f' ORDER BY {safe_col} {direction}'
        if _query_cancel.is_set():
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        # ★ 如果传入了 limit 参数则限量，否则全量（兼容旧调用）
        actual_limit = int(limit) if limit is not None else None
        limit_sql = _build_full_table_sql(tbl, db_type, order_clause, limit=actual_limit)
        # ★ 保存连接数据，用于 cancel 时 kill query
        _query_src_data = cdata
        url = _conn_url(cdata)
        if db_type in ('mysql', 'ob-mysql'):
            url = url.replace("?charset=utf8mb4", "?charset=utf8mb4&read_timeout=60") if "?" in url else url + "?charset=utf8mb4&read_timeout=60"
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=30))
        try:
            with engine.connect() as conn:
                # ★ 记录连接 ID（所有数据库类型），用于 cancel 时 kill query
                try:
                    if db_type in ('mysql', 'ob-mysql'):
                        _query_conn_id = conn.execute(text("SELECT CONNECTION_ID()")).scalar()
                        try:
                            conn.execute(text("SET SESSION MAX_EXECUTION_TIME = 120000"))
                        except Exception:
                            pass
                    elif db_type == 'postgresql':
                        _query_conn_id = conn.execute(text("SELECT pg_backend_pid()")).scalar()
                        # 设置语句超时 2 分钟
                        try:
                            conn.execute(text("SET statement_timeout = '120000'"))
                        except Exception:
                            pass
                    elif db_type == 'oracle':
                        row = conn.execute(text("SELECT SID||','||SERIAL# FROM V$SESSION WHERE AUDSID = SYS_CONTEXT('USERENV','SESSIONID')")).fetchone()
                        if row:
                            _query_conn_id = row[0]
                    elif db_type == 'mssql':
                        _query_conn_id = conn.execute(text("SELECT @@SPID")).scalar()
                except Exception:
                    pass
                _add_db_operation_session(op_state, cdata, _query_conn_id, kill_connection=False)
                if _query_cancel.is_set():
                    engine.dispose()
                    return {"ok": False, "msg": "查询已取消", "cancelled": True}
                _log_db_select(limit_sql)
                result = conn.execute(text(limit_sql))
                columns = list(result.keys())
                rows = [_row_to_json(row) for row in result.fetchall()]
                # ★ 全量查询可能耗时很长，fetchall 后检查用户是否取消了
                if _query_cancel.is_set():
                    engine.dispose()
                    return {"ok": False, "msg": "查询已取消", "cancelled": True}
                # 查询列注释
                comments = {}
                comments = _load_column_comments(conn, db_type, database, table_name, schema)
                col_types = _load_column_types(conn, db_type, database, table_name, schema)
            engine.dispose()
            return {"ok": True, "columns": columns, "rows": rows, "comments": comments, "col_types": col_types}
        except Exception as e:
            engine.dispose()
            raise
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}
    finally:
        _finish_db_operation(op_state)


@eel.expose
def table_preview_data_fast(conn_data, database, table_name, schema='', order_col='', order_dir='', where_clause='', operation_id=None):
    """快速预览：取 51 行，不用 COUNT(*)（超大表 COUNT 太慢），用第51行判断是否有更多。支持可选 WHERE 筛选"""
    global _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = None
    op_state = None
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'oracle':
            cdata["db"] = database  # ★ PG/MySQL 都要切到目标库
        tbl = _build_table_ref(cdata, database, table_name, schema)
        db_type = cdata.get('db_type', 'mysql')
        op_state = _register_db_operation(operation_id, cdata, 'table_preview_fast')
        order_clause = ''
        if order_col and order_dir:
            safe_col = _safe_ident(order_col, db_type)
            direction = 'DESC' if order_dir == 'desc' else 'ASC'
            order_clause = f' ORDER BY {safe_col} {direction}'
        if _query_cancel.is_set():
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        # ★ 取 51 行，多一行用于判断是否还有更多数据（省掉慢 COUNT）
        limit_sql = _build_full_table_sql(tbl, db_type, order_clause, limit=51, where_clause=where_clause)
        # ★ 保存连接数据，用于 cancel 时 kill query
        _query_src_data = cdata
        url = _conn_url(cdata)
        if db_type in ('mysql', 'ob-mysql'):
            url = url.replace("?charset=utf8mb4", "?charset=utf8mb4&read_timeout=30") if "?" in url else url + "?charset=utf8mb4&read_timeout=30"
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
        try:
            with engine.connect() as conn:
                # ★ 记录连接 ID（所有数据库类型），用于 cancel 时 kill query
                try:
                    if db_type in ('mysql', 'ob-mysql'):
                        _query_conn_id = conn.execute(text("SELECT CONNECTION_ID()")).scalar()
                        try:
                            conn.execute(text("SET SESSION MAX_EXECUTION_TIME = 30000"))
                        except Exception:
                            pass
                    elif db_type == 'postgresql':
                        _query_conn_id = conn.execute(text("SELECT pg_backend_pid()")).scalar()
                        try:
                            conn.execute(text("SET statement_timeout = '30000'"))
                        except Exception:
                            pass
                    elif db_type == 'oracle':
                        row = conn.execute(text("SELECT SID||','||SERIAL# FROM V$SESSION WHERE AUDSID = SYS_CONTEXT('USERENV','SESSIONID')")).fetchone()
                        if row:
                            _query_conn_id = row[0]
                    elif db_type == 'mssql':
                        _query_conn_id = conn.execute(text("SELECT @@SPID")).scalar()
                except Exception:
                    pass
                _add_db_operation_session(op_state, cdata, _query_conn_id, kill_connection=False)
                if _query_cancel.is_set():
                    engine.dispose()
                    return {"ok": False, "msg": "查询已取消", "cancelled": True}
                _log_db_select(limit_sql + "  -- [FAST] 前50行")
                result = conn.execute(text(limit_sql))
                columns = list(result.keys())
                rows = [_row_to_json(row) for row in result.fetchall()]
                # ★ 检查取消标记（虽然快速查询通常很快，但大表也可能耗时）
                if _query_cancel.is_set():
                    engine.dispose()
                    return {"ok": False, "msg": "查询已取消", "cancelled": True}
                has_more = len(rows) > 50
                if has_more:
                    rows = rows[:50]  # 只暴露前50行给前端
                comments = _load_column_comments(conn, db_type, database, table_name, schema)
                col_types = _load_column_types(conn, db_type, database, table_name, schema)
            engine.dispose()
            return {"ok": True, "columns": columns, "rows": rows, "comments": comments,
                    "col_types": col_types, "fast": True, "total_count": len(rows),
                    "has_more": has_more}
        except Exception as e:
            engine.dispose()
            raise
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}
    finally:
        _finish_db_operation(op_state)


@eel.expose
def table_load_page(conn_data, database, table_name, schema='', offset=0, limit=50, order_col='', order_dir='', where_clause='', operation_id=None):
    """服务端分页加载：取 limit+1 行代替 COUNT(*)，用多出的一行判断是否还有更多。支持可选 WHERE 筛选"""
    global _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = cdata_saved = None
    op_state = None
    try:
        cdata = dict(conn_data)
        cdata_saved = cdata  # for error handler
        if cdata.get('db_type') != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        db_type = cdata.get('db_type', 'mysql')
        op_state = _register_db_operation(operation_id, cdata, 'table_page')
        order_clause = ''
        if order_col and order_dir:
            safe_col = _safe_ident(order_col, db_type)
            direction = 'DESC' if order_dir == 'desc' else 'ASC'
            order_clause = f' ORDER BY {safe_col} {direction}'
        if _query_cancel.is_set():
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        offset = int(offset)
        limit = int(limit)
        # ★ 取 limit+1 行，多一行用于判断是否还有更多（省掉慢 COUNT）
        page_sql = _build_full_table_sql(tbl, db_type, order_clause, limit=limit + 1, offset=offset, where_clause=where_clause)
        # ★ 保存连接数据，用于 cancel 时 kill query
        _query_src_data = cdata
        url = _conn_url(cdata)
        if db_type in ('mysql', 'ob-mysql'):
            url = url.replace("?charset=utf8mb4", "?charset=utf8mb4&read_timeout=30") if "?" in url else url + "?charset=utf8mb4&read_timeout=30"
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
        try:
            with engine.connect() as conn:
                # ★ 记录连接 ID，用于 cancel 时 kill query（支持 MySQL/PG/Oracle/MSSQL）
                _query_conn_id = _get_backend_pid(conn, db_type)
                _add_db_operation_session(op_state, cdata, _query_conn_id, kill_connection=False)
                if db_type in ('mysql', 'ob-mysql'):
                    try:
                        conn.execute(text("SET SESSION MAX_EXECUTION_TIME = 30000"))
                    except Exception:
                        pass
                if _query_cancel.is_set():
                    engine.dispose()
                    return {"ok": False, "msg": "查询已取消", "cancelled": True}
                _log_db_select(f"{page_sql}  -- [PAGE] offset={offset} limit={limit}")
                result = conn.execute(text(page_sql))
                columns = list(result.keys())
                rows = [_row_to_json(row) for row in result.fetchall()]
                # ★ 检查取消标记
                if _query_cancel.is_set():
                    engine.dispose()
                    return {"ok": False, "msg": "查询已取消", "cancelled": True}
                has_more = len(rows) > limit
                if has_more:
                    rows = rows[:limit]  # 只暴露 limit 行给前端
                comments = _load_column_comments(conn, db_type, database, table_name, schema)
                col_types = _load_column_types(conn, db_type, database, table_name, schema)
            engine.dispose()
            return {"ok": True, "columns": columns, "rows": rows,
                    "total_count": offset + len(rows), "has_more": has_more,
                    "offset": offset, "limit": limit, "comments": comments, "col_types": col_types}
        except Exception as e:
            engine.dispose()
            raise
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, cdata_saved.get('db_type','mysql') if cdata_saved else 'mysql')}
    finally:
        _finish_db_operation(op_state)


def _sanitize_where_clause(where_clause, db_type='mysql'):
    """在 WHERE 子句中，给 = / != / <> 操作符右侧未加引号的值自动加单引号，
    确保字符串精确匹配（如 securitycode = 000045 → securitycode = '000045'）。
    比较运算符 > / < / >= / <= 保持原样（数字比较）。"""
    if not where_clause:
        return where_clause

    # MySQL 默认未开启 ANSI_QUOTES 时，双引号会被当成字符串引号。
    # WHERE 编辑器/旧版本可能生成："server_soc" = '121.36.221.7'，
    # 这会实际比较字符串 "server_soc"，因此匹配不到任何记录。
    # 这里只转换运算符左侧的双引号标识符，不改动右侧字符串值。
    def _mysql_identifier(m):
        return f"`{m.group(1)}` {m.group(2)}"

    if db_type in ('mysql', 'ob-mysql') and where_clause and '"' in where_clause:
        where_clause = re.sub(
            r'"([^"\\]+)"\s*(=|!=|<>|>=|<=|>|<|LIKE|NOT\s+LIKE)',
            _mysql_identifier,
            where_clause,
            flags=re.IGNORECASE
        )

    def _add_quotes(m):
        col = m.group(1)
        op = m.group(2).strip()
        val = m.group(3).strip()
        # 已有引号包裹的值不处理
        if val and val[0] in ("'", '"'):
            return m.group(0)
        # NULL 不处理
        if val.upper() == 'NULL':
            return m.group(0)
        # = / != / <> → 自动加引号
        if op in ('=', '!=', '<>'):
            return f"{col} {op} '{val}'"
        # > / < / >= / <= / LIKE → 保持原样
        return m.group(0)

    result = re.sub(
        r'(\w+)\s*(=|!=|<>|>=|<=|>|<|LIKE|NOT\s+LIKE)\s*(\S+)',
        _add_quotes,
        where_clause,
        flags=re.IGNORECASE
    )
    return result


def _build_full_table_sql(tbl, db_type, order_clause, limit=None, offset=0, where_clause=''):
    """构建 SELECT * FROM tbl 的 SQL，支持各数据库方言、可选 LIMIT/OFFSET/WHERE"""
    where_clause = _sanitize_where_clause(where_clause, db_type)
    where_str = f" WHERE {where_clause}" if where_clause else ''
    base_sql = f"SELECT * FROM {tbl}{where_str}{order_clause}"
    if limit is None:
        # 无限制 — 全量查询
        if db_type == 'oracle':
            base_sql = f"SELECT * FROM (SELECT * FROM {tbl}{order_clause})"
        elif db_type == 'mssql':
            pass  # SQL Server 无限制也用基础 SQL
        return base_sql

    # 带限制
    n = int(limit)
    off = int(offset) if offset else 0

    if off > 0:
        # 带偏移的翻页查询
        if db_type == 'oracle':
            return (f"SELECT * FROM (SELECT t.*, ROWNUM rn FROM "
                    f"(SELECT * FROM {tbl}{order_clause}) t WHERE ROWNUM <= {off+n}) "
                    f"WHERE rn > {off}")
        elif db_type == 'mssql':
            return f"SELECT * FROM {tbl}{order_clause} OFFSET {off} ROWS FETCH NEXT {n} ROWS ONLY"
        elif db_type in ('mysql', 'ob-mysql', 'postgresql', 'sqlite'):
            return f"{base_sql} LIMIT {n} OFFSET {off}"
        else:
            return f"{base_sql} LIMIT {n} OFFSET {off}"
    else:
        # 不带偏移，只限制行数
        if db_type == 'oracle':
            return f"SELECT * FROM (SELECT * FROM {tbl}{order_clause}) WHERE ROWNUM <= {n}"
        elif db_type == 'mssql':
            return f"SELECT TOP {n} * FROM {tbl}{order_clause}"
        elif db_type in ('mysql', 'ob-mysql', 'postgresql', 'sqlite'):
            return f"{base_sql} LIMIT {n}"
        else:
            return f"{base_sql} LIMIT {n}"


def _load_column_comments(conn, db_type, database, table_name, schema=''):
    """加载列注释"""
    comments = {}
    if db_type in ('mysql', 'ob-mysql'):
        col_rows = conn.execute(text(
            "SELECT COLUMN_NAME, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
        ), {"db": database, "tbl": table_name}).fetchall()
        for cr in col_rows:
            if cr[1]:
                comments[cr[0]] = cr[1]
    elif db_type == 'postgresql':
        sch = schema if schema else 'public'
        col_rows = conn.execute(text(
            "SELECT a.attname, pg_catalog.col_description(a.attrelid, a.attnum) "
            "FROM pg_catalog.pg_attribute a "
            "JOIN pg_catalog.pg_class c ON a.attrelid = c.oid "
            "JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid "
            "WHERE c.relname=:tbl AND n.nspname=:sch AND a.attnum>0 AND NOT a.attisdropped "
            "ORDER BY a.attnum"
        ), {"tbl": table_name, "sch": sch}).fetchall()
        for cr in col_rows:
            if cr[1]:
                comments[cr[0]] = cr[1]
    elif db_type == 'oracle':
        # ★ Oracle 使用 USER_COL_COMMENTS 获取列注释
        col_rows = conn.execute(text(
            "SELECT COLUMN_NAME, COMMENTS FROM USER_COL_COMMENTS WHERE TABLE_NAME=:tbl"
        ), {"tbl": table_name}).fetchall()
        for cr in col_rows:
            if cr[1]:
                comments[cr[0]] = cr[1]
    return comments


def _load_column_types(conn, db_type, database, table_name, schema=''):
    """加载列类型（用于表头展示）"""
    types = {}
    try:
        if db_type in ('mysql', 'ob-mysql'):
            col_rows = conn.execute(text(
                "SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
            ), {"db": database, "tbl": table_name}).fetchall()
            for cr in col_rows:
                types[cr[0]] = cr[1]
        elif db_type == 'postgresql':
            sch = schema if schema else 'public'
            col_rows = conn.execute(text(
                "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) "
                "FROM pg_catalog.pg_attribute a "
                "JOIN pg_catalog.pg_class c ON a.attrelid = c.oid "
                "JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid "
                "WHERE c.relname=:tbl AND n.nspname=:sch AND a.attnum>0 AND NOT a.attisdropped "
                "ORDER BY a.attnum"
            ), {"tbl": table_name, "sch": sch}).fetchall()
            for cr in col_rows:
                types[cr[0]] = cr[1]
        elif db_type == 'oracle':
            # ★ Oracle 使用 USER_TAB_COLUMNS 获取列类型，表名转大写
            owner = database
            tbl = table_name.upper()
            col_rows = conn.execute(text(
                "SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE "
                "FROM USER_TAB_COLUMNS WHERE TABLE_NAME=:tbl ORDER BY COLUMN_ID"
            ), {"tbl": tbl}).fetchall()
            for cr in col_rows:
                dt = cr[1]
                if dt == 'NUMBER' and cr[3] is not None and cr[4] is not None:
                    col_type = f"NUMBER({cr[3]},{cr[4]})"
                elif dt == 'NUMBER' and cr[3] is not None:
                    col_type = f"NUMBER({cr[3]})"
                elif cr[2] and dt in ('VARCHAR', 'VARCHAR2', 'CHAR', 'NCHAR', 'NVARCHAR2', 'RAW'):
                    col_type = f"{dt}({int(cr[2])})"
                else:
                    col_type = dt
                types[cr[0]] = col_type
        elif db_type == 'mssql':
            col_rows = conn.execute(text(
                "SELECT COLUMN_NAME, DATA_TYPE + "
                "CASE WHEN CHARACTER_MAXIMUM_LENGTH IS NOT NULL AND DATA_TYPE IN ('varchar','nvarchar','char','nchar') "
                "THEN '('+CAST(CHARACTER_MAXIMUM_LENGTH AS VARCHAR)+')' "
                "WHEN DATA_TYPE IN ('decimal','numeric') "
                "THEN '('+CAST(NUMERIC_PRECISION AS VARCHAR)+','+CAST(NUMERIC_SCALE AS VARCHAR)+')' "
                "ELSE '' END AS COLUMN_TYPE "
                "FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_CATALOG=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
            ), {"db": database, "tbl": table_name}).fetchall()
            for cr in col_rows:
                types[cr[0]] = cr[1]
        elif db_type == 'sqlite':
            col_rows = conn.execute(text(f"PRAGMA table_info('{table_name}')")).fetchall()
            for cr in col_rows:
                # cr = (cid, name, type, notnull, dflt_value, pk)
                types[cr[1]] = cr[2]
    except Exception:
        pass  # 获取类型失败不阻塞主流程
    return types


@eel.expose
def table_get_col_types(conn_data, database, table_name, schema=''):
    """供查询窗口获取列类型和注释"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            col_types = _load_column_types(conn, db_type, database, table_name, schema)
            comments = _load_column_comments(conn, db_type, database, table_name, schema)
        engine.dispose()
        return {"ok": True, "col_types": col_types, "comments": comments}
    except Exception as e:
        return {"ok": False, "msg": str(e)}












def _get_where_columns(c, db_type, database, table_name, schema=''):
    """获取用于 WHERE 条件的列：主键 > 唯一索引 > 所有列"""
    if db_type in ('mysql', 'ob-mysql'):
        # 1. 主键
        pks = c.execute(text(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl AND COLUMN_KEY='PRI' "
            "ORDER BY ORDINAL_POSITION"
        ), {"db": database, "tbl": table_name}).fetchall()
        if pks:
            return [r[0] for r in pks]
        # 2. 唯一索引（取第一个唯一索引的所有列）
        uniqs = c.execute(text(
            "SELECT INDEX_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS "
            "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl AND NON_UNIQUE=0 AND INDEX_NAME!='PRIMARY' "
            "ORDER BY INDEX_NAME, SEQ_IN_INDEX"
        ), {"db": database, "tbl": table_name}).fetchall()
        if uniqs:
            # 只能使用一个完整的唯一索引，不能把多个唯一索引的列混成一组。
            first_name = uniqs[0][0]
            return [r[1] for r in uniqs if r[0] == first_name]
    elif db_type == 'postgresql':
        # 1. 主键
        pks = c.execute(text(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name "
            "WHERE tc.table_name=:tbl AND tc.constraint_type='PRIMARY KEY' "
            "ORDER BY kcu.ordinal_position"
        ), {"tbl": table_name}).fetchall()
        if pks:
            return [r[0] for r in pks]
        # 2. 唯一索引
        uniqs = c.execute(text(
            "SELECT tc.constraint_name, kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name "
            "WHERE tc.table_name=:tbl AND tc.constraint_type='UNIQUE' "
            "ORDER BY tc.constraint_name, kcu.ordinal_position"
        ), {"tbl": table_name}).fetchall()
        if uniqs:
            # PostgreSQL 结果同样可能包含多个 UNIQUE constraint，只取第一个。
            first_name = c.execute(text(
                "SELECT tc.constraint_name FROM information_schema.table_constraints tc "
                "WHERE tc.table_name=:tbl AND tc.constraint_type='UNIQUE' "
                "ORDER BY tc.constraint_name LIMIT 1"
            ), {"tbl": table_name}).scalar()
            if first_name:
                return [r[1] for r in uniqs if r[0] == first_name]
    elif db_type == 'oracle':
        owner = str(database or '').upper()
        pks = c.execute(text(
            "SELECT acc.COLUMN_NAME FROM ALL_CONSTRAINTS ac "
            "JOIN ALL_CONS_COLUMNS acc ON ac.OWNER=acc.OWNER AND ac.CONSTRAINT_NAME=acc.CONSTRAINT_NAME "
            "WHERE ac.OWNER=:owner AND ac.TABLE_NAME=:tbl AND ac.CONSTRAINT_TYPE='P' ORDER BY acc.POSITION"
        ), {"owner": owner, "tbl": table_name.upper()}).fetchall()
        if pks:
            return [r[0] for r in pks]
        uniqs = c.execute(text(
            "SELECT ac.CONSTRAINT_NAME, acc.COLUMN_NAME FROM ALL_CONSTRAINTS ac "
            "JOIN ALL_CONS_COLUMNS acc ON ac.OWNER=acc.OWNER AND ac.CONSTRAINT_NAME=acc.CONSTRAINT_NAME "
            "WHERE ac.OWNER=:owner AND ac.TABLE_NAME=:tbl AND ac.CONSTRAINT_TYPE='U' "
            "ORDER BY ac.CONSTRAINT_NAME, acc.POSITION"
        ), {"owner": owner, "tbl": table_name.upper()}).fetchall()
        if uniqs:
            first = uniqs[0][0]
            return [r[1] for r in uniqs if r[0] == first]
    elif db_type == 'mssql':
        obj = f"{schema or 'dbo'}.{table_name}"
        pks = c.execute(text(
            "SELECT c.name FROM sys.indexes i "
            "JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id "
            "JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id "
            "WHERE i.object_id=OBJECT_ID(:obj) AND i.is_primary_key=1 ORDER BY ic.key_ordinal"
        ), {"obj": obj}).fetchall()
        if pks:
            return [r[0] for r in pks]
        uniqs = c.execute(text(
            "SELECT i.name, c.name FROM sys.indexes i "
            "JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id "
            "JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id "
            "WHERE i.object_id=OBJECT_ID(:obj) AND i.is_unique=1 AND i.is_primary_key=0 "
            "ORDER BY i.name, ic.key_ordinal"
        ), {"obj": obj}).fetchall()
        if uniqs:
            first = uniqs[0][0]
            return [r[1] for r in uniqs if r[0] == first]
    # 3. 兜底：返回 None，调用方使用所有列
    return None


def _is_text_column_type(col_type):
    """判断数据库列是否为文本/二进制类型，避免把 00123 当成数字。"""
    if not col_type:
        return False
    t = str(col_type).strip().lower()
    return bool(re.match(
        r"^(char|varchar|character|character varying|nchar|nvarchar|text|tinytext|"
        r"mediumtext|longtext|enum|set|json|uuid|xml|clob|nclob|raw|binary|"
        r"varbinary|blob|tinyblob|mediumblob|longblob)\b", t
    ))


def _is_numeric_column_type(col_type):
    """判断数据库列是否为数值类型。"""
    if not col_type:
        return False
    t = str(col_type).strip().lower()
    return bool(re.match(
        r"^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|"
        r"float|double|double precision|real|number|serial|bigserial|"
        r"smallserial|money|bit)\b", t
    ))


def _find_col_type(col_types, col_name):
    if not col_types:
        return ""
    if col_name in col_types:
        return col_types[col_name]
    wanted = str(col_name).lower()
    for name, value in col_types.items():
        if str(name).lower() == wanted:
            return value
    return ""


def _build_where_clause(tbl, db_type, where_cols, columns, orig_row, col_types=None):
    """构建 UPDATE/DELETE 的 WHERE 子句，优先使用主键/唯一索引。
    WHERE 值始终以字符串引用（不用 _sql_value），避免：
    1. VARCHAR PK 含纯数字时被误判为数字导致隐式类型转换不匹配
    2. BIGINT/Decimal 经 JS 往返后精度丢失（_json_safe 已转字符串）
    """
    if where_cols:
        target_cols = where_cols
    else:
        target_cols = columns
    where_parts = []
    for cname in target_cols:
        try:
            idx = columns.index(cname)
            val = orig_row[idx] if idx < len(orig_row) else 'NULL'
            col_type = _find_col_type(col_types, cname)
            # 新版前端保留真正的 null；兼容旧版前端的 NULL 哨兵，但文本列
            # 中的字面量 "NULL" 不能被误判成 SQL NULL。
            is_null = val is None or (
                str(val).upper() == 'NULL' and not _is_text_column_type(col_type)
            )
            if is_null:
                where_parts.append(f"{_safe_ident(cname, db_type)} IS NULL")
            else:
                where_parts.append(
                    f"{_safe_ident(cname, db_type)} = "
                    f"{_sql_value(val, db_type, col_type, null_sentinel=False)}"
                )
        except ValueError:
            pass
    return " AND ".join(where_parts) if where_parts else "1=1"


def _escape_str_val(val_str, db_type='mysql'):
    """将字符串值安全地转为 SQL 字符串字面量（始终加引号）"""
    if db_type in ('mysql', 'ob-mysql'):
        return "'" + val_str.replace("\\", "\\\\").replace("'", "\\'") + "'"
    return _sql_literal(val_str)


def _group_table_changes(changes):
    """按原始行合并修改项，使同一行多列修改只执行一条 UPDATE。"""
    groups = []
    by_key = {}
    for ch in changes or []:
        # 新版前端提供 rowIdx；旧版调用方没有该字段时，用原始行内容兜底。
        row_idx = ch.get("rowIdx")
        if row_idx is not None:
            key = ("row", str(row_idx))
        else:
            try:
                key = ("values", json.dumps(
                    ch.get("origRow", []), ensure_ascii=False,
                    sort_keys=True, default=str
                ))
            except Exception:
                key = ("values", repr(ch.get("origRow", [])))
        group = by_key.get(key)
        if group is None:
            group = {
                "origRow": ch.get("origRow", []),
                "columns": ch.get("columns", []),
                "rowIdx": row_idx,
                "changes": [],
            }
            by_key[key] = group
            groups.append(group)
        group["changes"].append(ch)
    return groups


def _build_update_sql(tbl, db_type, group, where_cols, col_types):
    columns = group.get("columns", [])
    orig_row = group.get("origRow", [])
    set_by_col = {}
    for ch in group.get("changes", []):
        col = ch.get("col")
        if not col or col not in columns:
            raise ValueError(f"无效的修改列：{col}")
        # 同一行同一列只应有一项；如有旧版重复请求，以最后一次为准。
        set_by_col[col] = ch.get("newVal")
    if not set_by_col:
        raise ValueError("没有有效的修改内容")
    set_parts = []
    for col, new_val in set_by_col.items():
        col_type = _find_col_type(col_types, col)
        set_parts.append(
            f"{_safe_ident(col, db_type)} = {_sql_value(new_val, db_type, col_type)}"
        )
    where_clause = _build_where_clause(
        tbl, db_type, where_cols, columns, orig_row, col_types
    )
    if where_clause == "1=1":
        raise ValueError("无法根据原始行数据生成安全的 WHERE 条件，已拒绝保存")
    return f"UPDATE {tbl} SET {', '.join(set_parts)} WHERE {where_clause}"


@eel.expose
def table_save_changes(conn_data, database, table_name, schema, changes):
    """生成 UPDATE SQL 预览，不执行"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as c:
            where_cols = _get_where_columns(c, db_type, database, table_name, schema)
            col_types = _load_column_types(c, db_type, database, table_name, schema)

        groups = _group_table_changes(changes)
        sqls = [
            _build_update_sql(tbl, db_type, group, where_cols, col_types) + ";"
            for group in groups
        ]
        engine.dispose()
        return {"ok": True, "sql": "\n".join(sqls), "count": len(changes or []),
                "statement_count": len(sqls)}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def table_exec_save(conn_data, database, table_name, schema, changes, operation_id=None):
    """执行 UPDATE 修改（支持取消：循环中检测 _query_cancel，并记录连接 PID 供 Kill）"""
    global _query_conn_id, _query_src_data
    cdata = dict(conn_data)
    db_type = cdata.get('db_type', 'mysql')
    if db_type != 'oracle':
        cdata["db"] = database
    tbl = _build_table_ref(cdata, database, table_name, schema)
    op_state = _register_db_operation(operation_id, cdata, 'update')
    engine = None
    try:
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if _db_operation_cancelled(op_state):
            raise RuntimeError("操作已取消")
        with engine.connect() as c:
            where_cols = _get_where_columns(c, db_type, database, table_name, schema)
            col_types = _load_column_types(c, db_type, database, table_name, schema)
        groups = _group_table_changes(changes)
        with engine.begin() as c:
            # ★ 记录连接 PID，供 cancel 时 Kill
            _query_conn_id = _get_backend_pid(c, db_type)
            _query_src_data = cdata
            _add_db_operation_session(op_state, cdata, _query_conn_id, kill_connection=False)
            for group in groups:
                if _db_operation_cancelled(op_state):
                    _kill_db_operation(op_state)
                    raise RuntimeError("操作已取消")
                orig_row = group.get("origRow", [])
                columns = group.get("columns", [])
                # ★ 禁止修改主键列（会引发 Duplicate entry）
                if False:  # legacy guard retained for compatibility; active guard is below
                    return {"ok": False, "msg": f"不能修改主键列 '{col}'，请用 DELETE + INSERT 替代"}
                changed_cols = {
                    str(ch.get("col")).lower() for ch in group["changes"]
                }
                if where_cols:
                    where_lower = {str(col).lower() for col in where_cols}
                    blocked = changed_cols & where_lower
                    if blocked:
                        bad_col = next(iter(blocked))
                        raise ValueError(
                            f"不能修改主键/唯一键列 '{bad_col}'，请用 DELETE + INSERT 替代"
                        )
                update_sql = _build_update_sql(
                    tbl, db_type, group, where_cols, col_types
                )
                # update_sql 已是完整 SQL；使用驱动直执行，避免 JSON 中的
                # "port":7004 被 SQLAlchemy text() 误识别为 :7004 参数。
                result = c.exec_driver_sql(update_sql)
                if _db_operation_cancelled(op_state):
                    _kill_db_operation(op_state)
                    raise RuntimeError("操作已取消")
                # ★ 检查 rowcount：如果 WHERE 条件未匹配到行，说明 origRow 数据可能已过期
                rc = result.rowcount
                unchanged_update = all(
                    str(ch.get("newVal")) == str(orig_row[columns.index(ch.get("col"))])
                    for ch in group["changes"] if ch.get("col") in columns
                )
                # MySQL 默认 CLIENT_FOUND_ROWS 未开启时，匹配到但值未变化会返回 0。
                if rc == 0 and db_type in ('mysql', 'ob-mysql') and unchanged_update:
                    rc = 1
                if rc != 1:
                    raise RuntimeError(
                        f"保存失败：第 {group.get('rowIdx', '?')} 行 WHERE 条件影响了 {rc} 行，"
                        "为避免误修改，已回滚本次全部保存"
                    )
                rollback_parts = []
                for ch in group["changes"]:
                    col = ch.get("col")
                    old_val = orig_row[columns.index(col)]
                    col_type = _find_col_type(col_types, col)
                    rollback_parts.append(
                        f"{_safe_ident(col, db_type)} = "
                        f"{_sql_value(old_val, db_type, col_type, null_sentinel=False)}"
                    )
                where_clause = _build_where_clause(
                    tbl, db_type, where_cols, columns, orig_row, col_types
                )
                rollback_sql = (
                    f"UPDATE {tbl} SET {', '.join(rollback_parts)} "
                    f"WHERE {where_clause};"
                )
                _log_db_update(update_sql, rollback_sql)
        return {"ok": True, "msg": f"成功修改 {len(changes)} 处"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": str(e)}
    finally:
        _query_conn_id = None
        _query_src_data = None
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


def _sql_value(val, db_type, col_type=None, null_sentinel=True):
    if val is None or (null_sentinel and val == 'NULL'):
        return 'NULL'
    val = str(val)
    # 尝试数字
    if _is_numeric_column_type(col_type) and re.fullmatch(
        r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", val.strip()
    ):
        return val.strip()
    return _escape_str_val(val, db_type)


@eel.expose
def table_delete_rows(conn_data, database, table_name, schema, rows_data):
    """生成 DELETE SQL 预览，不执行。rows_data: [{origRow, columns}]"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as c:
            where_cols = _get_where_columns(c, db_type, database, table_name, schema)
            col_types = _load_column_types(c, db_type, database, table_name, schema)
        sqls = []
        for rd in rows_data:
            orig_row = rd.get("origRow", [])
            columns = rd.get("columns", [])
            where_clause = _build_where_clause(
                tbl, db_type, where_cols, columns, orig_row, col_types
            )
            sqls.append(f"DELETE FROM {tbl} WHERE {where_clause};")
        engine.dispose()
        return {"ok": True, "sql": "\n".join(sqls), "count": len(sqls)}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def table_exec_delete(conn_data, database, table_name, schema, rows_data, operation_id=None):
    """执行 DELETE 删除"""
    global _query_conn_id, _query_src_data
    op_state = None
    engine = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        op_state = _register_db_operation(operation_id, cdata, 'delete')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if _db_operation_cancelled(op_state):
            raise RuntimeError("操作已取消")
        with engine.connect() as c:
            where_cols = _get_where_columns(c, db_type, database, table_name, schema)
            col_types = _load_column_types(c, db_type, database, table_name, schema)
        with engine.begin() as c:
            _query_conn_id = _get_backend_pid(c, db_type)
            _query_src_data = cdata
            _add_db_operation_session(op_state, cdata, _query_conn_id, kill_connection=False)
            for rd in rows_data:
                if _db_operation_cancelled(op_state):
                    _kill_db_operation(op_state)
                    raise RuntimeError("操作已取消")
                orig_row = rd.get("origRow", [])
                columns = rd.get("columns", [])
                where_clause = _build_where_clause(
                    tbl, db_type, where_cols, columns, orig_row, col_types
                )
                delete_sql = f"DELETE FROM {tbl} WHERE {where_clause}"
                # 同样避免 DELETE 条件中的 URL/时间/JSON 冒号被识别成绑定参数。
                result = c.exec_driver_sql(delete_sql)
                if _db_operation_cancelled(op_state):
                    _kill_db_operation(op_state)
                    raise RuntimeError("操作已取消")
                # ★ 检查 rowcount：如果未删除任何行，可能数据已变化
                if result.rowcount == 0:
                    _log_db_delete(delete_sql, "-- WARNING: 0 rows affected, WHERE may not match")
                else:
                    # 生成回退 SQL：INSERT 恢复被删除的行
                    rollback_sql = _gen_rollback_insert(tbl, db_type, columns, orig_row)
                    _log_db_delete(delete_sql, rollback_sql)
        return {"ok": True, "msg": f"成功删除 {len(rows_data)} 行"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": str(e)}
    finally:
        _query_conn_id = None
        _query_src_data = None
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


@eel.expose
def _format_oracle_ddl(ddl):
    """轻量美化 Oracle DDL（DBMS_METADATA.GET_DDL 返回的原始字符串）

    策略：
      1) 合并多余空白
      2) 顶层段关键字前换行（PCTFREE / TABLESPACE / STORAGE / LOGGING 等）
      3) 括号深度感知：仅在最外层（第 1 深度，CREATE TABLE 后的"列定义"括号）内逗号换行；
         类型参数括号内 (NUMBER(4,0) 等) 不换行。
      4) 顶层括号（前一个字符不是空白）前换行
      5) 重新按括号深度加缩进

    性能：对于超长 DDL (>100KB) 仅做轻量换行，避免字符级扫描开销。
    """
    if not ddl:
        return ddl
    import re
    s = ddl.strip()
    s = re.sub(r'\s+', ' ', s)

    # ★ 超大 DDL：只做简单的逗号后换行 + 顶层关键字换行，不做逐字符扫描
    if len(s) > 100000:
        top_kw = [
            'CREATE', 'ALTER', 'DROP', 'ORGANIZATION', 'PCTFREE', 'PCTUSED',
            'INITRANS', 'MAXTRANS', 'STORAGE', 'TABLESPACE', 'BUFFER_POOL',
            'LOGGING', 'NOLOGGING', 'COMPRESS', 'NOCOMPRESS',
            'SEGMENT', 'CREATION', 'IMMEDIATE', 'DEFERRED',
            'ENABLE', 'DISABLE', 'PARALLEL', 'NOPARALLEL', 'MONITORING', 'NOMONITORING',
        ]
        # 顶层关键字前换行
        p = r'(^|\s)(' + '|'.join(sorted(top_kw, key=len, reverse=True)) + r')\b'
        s = re.sub(p, lambda m: ('\n' if m.group(1) else '') + m.group(2), s)
        # 简单缩进
        lines = s.split('\n')
        out_lines = []
        depth = 0
        for ln in lines:
            line = ln.rstrip()
            if not line:
                out_lines.append('')
                continue
            if line.startswith(')'):
                depth = max(0, depth - 1)
            indent = depth
            out_lines.append(('  ' * indent) + line.strip())
            opens = line.count('(')
            closes = line.count(')')
            depth = max(0, depth + opens - closes)
        return '\n'.join(out_lines)

    # 顶层段关键字（句首出现时换行，括号内不换）
    # ★ 优化：按长度降序排序，让长关键字优先匹配，减少回溯
    top_keywords = [
        'NOMONITORING', 'MONITORING', 'NOPARALLEL', 'NOLOGGING', 'NOCOMPRESS',
        'TABLESPACE', 'ORGANIZATION', 'BUFFER_POOL', 'PCTINCREASE', 'MAXEXTENTS',
        'MINEXTENTS', 'FREELISTS', 'PCTTHRESHOLD', 'SUBSTITUTABLE',
        'CREATION', 'STORAGE', 'PCTFREE', 'PCTUSED', 'INITRANS', 'MAXTRANS',
        'LOGGING', 'COMPRESS', 'SEGMENT', 'ENABLE', 'DISABLE', 'PARALLEL',
        'REFERENCES', 'INCLUDING', 'OVERFLOW', 'MAPPING', 'NOMAPPING',
        'VALIDATE', 'NOVALIDATE', 'CACHE', 'NOCACHE', 'INDEX', 'USING',
        'CREATE', 'ALTER', 'DROP', 'STORE', 'COMPUTE', 'STATISTICS',
        'DEFERRED', 'IMMEDIATE', 'INITIAL',
    ]
    # ★ 预编译正则
    _kw_re = re.compile(r'(^|\s)(' + '|'.join(top_keywords) + r')\b')
    s = _kw_re.sub(lambda m: ('\n' if m.group(1) else '') + m.group(2), s)

    # 字符级扫描：仅在"顶层括号"内的逗号才换行
    out = []
    depth = 0
    in_quote = None  # None / '"' / "'"
    top_depth_open = -1  # CREATE TABLE 之后第一个 "深度=1" 的左括号位置
    for i, ch in enumerate(s):
        if in_quote:
            out.append(ch)
            if ch == in_quote:
                in_quote = None
            continue
        if ch in ('"', "'"):
            in_quote = ch
            out.append(ch)
            continue
        if ch == '(':
            depth += 1
            # CREATE TABLE ... ( 即顶层括号，其内逗号换行
            if top_depth_open == -1 and depth == 1:
                top_depth_open = i
                out.append(ch)
                out.append('\n  ')
                continue
            out.append(ch)
            continue
        if ch == ')':
            depth -= 1
            # 只在"顶层括号关闭"时换行
            if top_depth_open != -1 and depth == 0:
                if out and out[-1] != '\n':
                    out.append('\n')
                out.append(ch)
                out.append('\n')
                top_depth_open = -1
                continue
            out.append(ch)
            continue
        if ch == ',' and top_depth_open != -1 and depth == 1:
            out.append(',\n  ')
            continue
        out.append(ch)
    s = ''.join(out)

    # 重新整理缩进：基于括号深度
    lines = s.split('\n')
    result = []
    depth = 0
    for raw in lines:
        line = raw.rstrip()
        if not line:
            result.append('')
            continue
        if line.startswith(')'):
            indent = max(0, depth - 1)
        else:
            indent = depth
        result.append(('  ' * indent) + line.strip())
        opens = line.count('(')
        closes = line.count(')')
        depth = max(0, depth + opens - closes)
    return '\n'.join(result)


def _get_mssql_table_ddl(engine, table_name, schema=''):
    """从 SQL Server 系统目录生成表 DDL（含默认值、identity、注释和索引）。"""
    db_type = 'mssql'
    owner = schema or 'dbo'
    table_ref = f"{_safe_ident(owner, db_type)}.{_safe_ident(table_name, db_type)}"
    with engine.connect() as conn:
        col_rows = conn.execute(text(
            "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, "
            "c.is_nullable, c.is_identity, dc.definition, ep.value "
            "FROM sys.tables tb JOIN sys.schemas s ON s.schema_id=tb.schema_id "
            "JOIN sys.columns c ON c.object_id=tb.object_id "
            "JOIN sys.types ty ON ty.user_type_id=c.user_type_id "
            "LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id "
            "AND dc.parent_column_id=c.column_id "
            "LEFT JOIN sys.extended_properties ep ON ep.major_id=c.object_id "
            "AND ep.minor_id=c.column_id AND ep.name='MS_Description' "
            "WHERE s.name=:sch AND tb.name=:tbl ORDER BY c.column_id"
        ), {"sch": owner, "tbl": table_name}).fetchall()
        pk_rows = conn.execute(text(
            "SELECT c.name FROM sys.indexes i "
            "JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id "
            "JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id "
            "JOIN sys.tables tb ON tb.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=tb.schema_id "
            "WHERE s.name=:sch AND tb.name=:tbl AND i.is_primary_key=1 ORDER BY ic.key_ordinal"
        ), {"sch": owner, "tbl": table_name}).fetchall()
        idx_rows = conn.execute(text(
            "SELECT i.name, i.is_unique, c.name FROM sys.indexes i "
            "JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id "
            "JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id "
            "JOIN sys.tables tb ON tb.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=tb.schema_id "
            "WHERE s.name=:sch AND tb.name=:tbl AND i.is_primary_key=0 "
            "AND i.is_unique_constraint=0 AND i.name IS NOT NULL ORDER BY i.name, ic.key_ordinal"
        ), {"sch": owner, "tbl": table_name}).fetchall()
        table_comment = conn.execute(text(
            "SELECT CAST(ep.value AS nvarchar(max)) FROM sys.tables tb "
            "JOIN sys.schemas s ON s.schema_id=tb.schema_id "
            "LEFT JOIN sys.extended_properties ep ON ep.major_id=tb.object_id "
            "AND ep.minor_id=0 AND ep.name='MS_Description' "
            "WHERE s.name=:sch AND tb.name=:tbl"
        ), {"sch": owner, "tbl": table_name}).fetchone()

    def _mssql_type(row):
        type_name = str(row[1]).upper()
        max_length, precision, scale = row[2], row[3], row[4]
        if type_name in ('VARCHAR', 'CHAR', 'VARBINARY', 'BINARY'):
            type_name += '(MAX)' if max_length == -1 else f'({max_length})'
        elif type_name in ('NVARCHAR', 'NCHAR'):
            type_name += '(MAX)' if max_length == -1 else f'({int(max_length / 2)})'
        elif type_name in ('DECIMAL', 'NUMERIC'):
            type_name += f'({precision},{scale})'
        elif type_name in ('DATETIME2', 'DATETIMEOFFSET', 'TIME') and scale is not None:
            type_name += f'({scale})'
        return type_name

    lines = []
    for row in col_rows:
        default = f" DEFAULT {row[7]}" if row[7] is not None else ''
        identity = ' IDENTITY(1,1)' if row[6] else ''
        nullable = ' NULL' if row[5] else ' NOT NULL'
        lines.append(f"  {_safe_ident(row[0], db_type)} {_mssql_type(row)}{identity}{default}{nullable}")
    if pk_rows:
        pk_cols = ', '.join(_safe_ident(r[0], db_type) for r in pk_rows)
        lines.append(f"  PRIMARY KEY ({pk_cols})")
    ddl = f"CREATE TABLE {table_ref} (\n" + ',\n'.join(lines) + "\n);"
    if table_comment and table_comment[0]:
        ddl += "\n" + _mssql_comment_upsert_sql(table_comment[0], owner, table_name)
    for row in col_rows:
        if row[8]:
            ddl += "\n" + _mssql_comment_upsert_sql(row[8], owner, table_name, row[0])
    grouped_indexes = {}
    for idx_name, is_unique, col_name in idx_rows:
        grouped_indexes.setdefault((idx_name, bool(is_unique)), []).append(col_name)
    for (idx_name, is_unique), idx_cols in grouped_indexes.items():
        unique = 'UNIQUE ' if is_unique else ''
        ddl += f"\nCREATE {unique}INDEX {_safe_ident(idx_name, db_type)} ON {table_ref} ({', '.join(_safe_ident(c, db_type) for c in idx_cols)});"
    return ddl


@eel.expose
def table_get_ddl(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'oracle':
            cdata["db"] = database
        db_type = cdata.get('db_type', 'mysql')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type in ('mysql', 'ob-mysql'):
            with engine.connect() as conn:
                row = conn.execute(text(f"SHOW CREATE TABLE {_safe_ident(database, 'mysql')}.{_safe_ident(table_name, 'mysql')}")).fetchone()
            ddl = row[1] if row else ""
        elif db_type == 'postgresql':
            q = schema if schema else database
            q_ident = _safe_ident(q, db_type)
            table_ident = _safe_ident(table_name, db_type)
            # ★ PostgreSQL：生成完整 DDL（列+主键+索引+外键+注释）
            q = schema if schema else database
            with engine.connect() as conn:
                # 列信息
                cols = conn.execute(text(
                    "SELECT column_name,data_type,character_maximum_length,numeric_precision,numeric_scale,"
                    "is_nullable,column_default "
                    "FROM information_schema.columns WHERE table_schema=:sch AND table_name=:tbl "
                    "ORDER BY ordinal_position"
                ), {"sch":q,"tbl":table_name}).fetchall()
                lines = [f'CREATE TABLE {q_ident}.{table_ident} (']
                col_defs = []
                for c in cols:
                    null = ' NOT NULL' if c[5]=='NO' else ''
                    dflt = f' DEFAULT {c[6]}' if c[6] is not None else ''
                    col_defs.append(f'  {_safe_ident(c[0], db_type)} {c[1]}{dflt}{null}')
                # 主键
                try:
                    pk_rows = conn.execute(text(
                        "SELECT kcu.column_name FROM information_schema.table_constraints tc "
                        "JOIN information_schema.key_column_usage kcu "
                        "ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema "
                        "WHERE tc.table_schema=:sch AND tc.table_name=:tbl AND tc.constraint_type='PRIMARY KEY' "
                        "ORDER BY kcu.ordinal_position"
                    ), {"sch":q,"tbl":table_name}).fetchall()
                    if pk_rows:
                        pk_cols = ', '.join(_safe_ident(r[0], db_type) for r in pk_rows)
                        col_defs.append(f'  PRIMARY KEY ({pk_cols})')
                except Exception:
                    pass
                # 外键
                try:
                    fk_rows = conn.execute(text(
                        "SELECT tc.constraint_name, kcu.column_name, ccu.table_name, ccu.column_name "
                        "FROM information_schema.table_constraints tc "
                        "JOIN information_schema.key_column_usage kcu "
                        "ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema "
                        "JOIN information_schema.constraint_column_usage ccu "
                        "ON tc.constraint_name=ccu.constraint_name "
                        "WHERE tc.table_schema=:sch AND tc.table_name=:tbl AND tc.constraint_type='FOREIGN KEY'"
                    ), {"sch":q,"tbl":table_name}).fetchall()
                    for fk in fk_rows:
                        col_defs.append(f'  CONSTRAINT {_safe_ident(fk[0], db_type)} FOREIGN KEY ({_safe_ident(fk[1], db_type)}) REFERENCES {q_ident}.{_safe_ident(fk[2], db_type)} ({_safe_ident(fk[3], db_type)})')
                except Exception:
                    pass
                lines.append(',\n'.join(col_defs))
                lines.append(');')
                # 索引
                try:
                    idx_rows = conn.execute(text(
                        "SELECT indexname, indexdef FROM pg_indexes "
                        "WHERE schemaname=:sch AND tablename=:tbl ORDER BY indexname"
                    ), {"sch":q}).fetchall()
                    for ir in idx_rows:
                        if 'PRIMARY KEY' not in (ir[1] or ''):
                            lines.append(ir[1] + ';')
                except Exception:
                    pass
                # 列注释
                try:
                    cmt_rows = conn.execute(text(
                        "SELECT cols.column_name, pg_catalog.col_description(c.oid, cols.ordinal_position::int) "
                        "FROM pg_catalog.pg_class c "
                        "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                        "JOIN information_schema.columns cols ON cols.table_schema=n.nspname AND cols.table_name=c.relname "
                        "WHERE n.nspname=:sch AND c.relname=:tbl AND pg_catalog.col_description(c.oid, cols.ordinal_position::int) IS NOT NULL"
                    ), {"sch":q,"tbl":table_name}).fetchall()
                    for cr in cmt_rows:
                        cmt = cr[1].replace("'", "''")
                        lines.append(f'COMMENT ON COLUMN {q_ident}.{table_ident}.{_safe_ident(cr[0], db_type)} IS \'{cmt}\';')
                except Exception:
                    pass
                # 表注释
                try:
                    tc_row = conn.execute(text(
                        "SELECT pg_catalog.obj_description(c.oid,'pg_class') "
                        "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                        "WHERE n.nspname=:sch AND c.relname=:tbl"
                    ), {"sch":q,"tbl":table_name}).fetchone()
                    if tc_row and tc_row[0]:
                        tcmt = tc_row[0].replace("'", "''")
                        lines.append(f'COMMENT ON TABLE {q_ident}.{table_ident} IS \'{tcmt}\';')
                except Exception:
                    pass
                ddl = '\n'.join(lines)
        elif db_type == 'oracle':
            # ★ Oracle 使用 DBMS_METADATA.GET_DDL 获取 DDL，表名和 owner 统一转大写
            owner = (cdata.get("user", database) or '').upper()
            tbl = table_name.upper()
            with engine.connect() as conn:
                # ★ 减少输出体积，提升速度：去掉 SEGMENT_ATTRIBUTES / STORAGE
                try:
                    conn.execute(text(
                        "BEGIN"
                        " DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'STORAGE',false);"
                        " DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SEGMENT_ATTRIBUTES',false);"
                        " END;"
                    ))
                except Exception:
                    pass  # 低权限用户可能无法调用
                result = conn.execute(text("SELECT DBMS_METADATA.GET_DDL('TABLE', :tbl, :owner) FROM DUAL"),
                                     {"tbl": tbl, "owner": owner})
                row = result.fetchone()
                ddl = row[0] if row else ""
            # 轻量美化
            ddl = _format_oracle_ddl(ddl)
        elif db_type == 'mssql':
            ddl = _get_mssql_table_ddl(engine, table_name, schema)
        else:
            with engine.connect() as conn:
                row = conn.execute(text(f"SHOW CREATE TABLE {_safe_ident(database, 'mysql')}.{_safe_ident(table_name, 'mysql')}")).fetchone()
            ddl = row[1] if row else ""
        engine.dispose()
        return {"ok": True, "ddl": ddl}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

# ==================== 表设计器 ====================
@eel.expose
def table_get_design_info(conn_data, database, table_name, schema=''):
    """获取表完整设计信息（字段、索引、外键、表属性）"""
    cdata = {}
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))

        result = {"columns": [], "indexes": [], "foreign_keys": [], "table_options": {}}

        with engine.connect() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                # 列信息
                cols = conn.execute(text(
                    "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, "
                    "NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION "
                    "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl "
                    "ORDER BY ORDINAL_POSITION"
                ), {"db": database, "tbl": table_name}).fetchall()
                for r in cols:
                    result["columns"].append({
                        "name": r[0], "col_type": r[1], "data_type": r[2],
                        "length": r[3], "precision": r[4], "scale": r[5],
                        "nullable": r[6] == "YES",
                        "default_val": str(r[7]) if r[7] is not None else None,
                        "auto_increment": "auto_increment" in (r[8] or ""),
                        "comment": r[9] or "", "position": r[10]
                    })

                # 索引信息（用 INFORMATION_SCHEMA.STATISTICS 替代 SHOW INDEX FROM）
                idxs = conn.execute(text(
                    "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE "
                    "FROM INFORMATION_SCHEMA.STATISTICS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl "
                    "ORDER BY INDEX_NAME, SEQ_IN_INDEX"
                ), {"db": database, "tbl": table_name}).fetchall()
                idx_map = {}
                for r in idxs:
                    key_name = r[0]
                    if key_name not in idx_map:
                        idx_map[key_name] = {
                            "name": key_name,
                            "type": "PRIMARY" if key_name == "PRIMARY" else ("UNIQUE" if r[1] == 0 else "INDEX"),
                            "columns": [], "method": r[3] or "BTREE"
                        }
                    idx_map[key_name]["columns"].append(r[2])
                result["indexes"] = list(idx_map.values())

                # 外键
                fks = conn.execute(text(
                    "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, "
                    "r.UPDATE_RULE, r.DELETE_RULE "
                    "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k "
                    "JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r "
                    "ON k.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA "
                    "WHERE k.TABLE_SCHEMA=:db AND k.TABLE_NAME=:tbl AND k.REFERENCED_TABLE_NAME IS NOT NULL"
                ), {"db": database, "tbl": table_name}).fetchall()
                for r in fks:
                    result["foreign_keys"].append({
                        "name": r[0], "column": r[1], "ref_table": r[2],
                        "ref_column": r[3], "on_update": r[4] or "RESTRICT", "on_delete": r[5] or "RESTRICT"
                    })

                # 表属性
                opts = conn.execute(text(
                    "SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl"
                ), {"db": database, "tbl": table_name}).fetchone()
                if opts:
                    result["table_options"] = {
                        "engine": opts[0] or "InnoDB",
                        "collation": opts[1] or "",
                        "comment": opts[2] or ""
                    }

            elif db_type == 'postgresql':
                sch = schema if schema else database
                cols = conn.execute(text(
                    "SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, "
                    "is_nullable, column_default, ordinal_position "
                    "FROM information_schema.columns WHERE table_schema=:sch AND table_name=:tbl ORDER BY ordinal_position"
                ), {"sch": sch, "tbl": table_name}).fetchall()
                # ★ 获取列注释
                pg_col_cmt = {}
                try:
                    cmt_r = conn.execute(text(
                        "SELECT cols.column_name, pg_catalog.col_description(c.oid, cols.ordinal_position::int) "
                        "FROM pg_catalog.pg_class c "
                        "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                        "JOIN information_schema.columns cols ON cols.table_schema=n.nspname AND cols.table_name=c.relname "
                        "WHERE n.nspname=:sch AND c.relname=:tbl"
                    ), {"sch": sch, "tbl": table_name}).fetchall()
                    for cr in cmt_r:
                        if cr[1]: pg_col_cmt[cr[0]] = cr[1]
                except Exception:
                    pass
                pg_type_aliases = {
                    "character varying": "VARCHAR",
                    "character": "CHAR",
                    "timestamp without time zone": "TIMESTAMP",
                    "timestamp with time zone": "TIMESTAMPTZ",
                    "time without time zone": "TIME",
                    "time with time zone": "TIME WITH TIME ZONE",
                    "double precision": "DOUBLE PRECISION",
                }
                for r in cols:
                    raw_type = str(r[1] or "")
                    display_type = pg_type_aliases.get(raw_type.lower(), raw_type)
                    col_type = raw_type
                    if r[2] is not None and raw_type.lower() in ("character varying", "character"):
                        col_type = f"{raw_type}({r[2]})"
                    elif r[3] is not None and raw_type.lower() in ("numeric", "decimal"):
                        col_type = f"{raw_type}({r[3]},{r[4]})" if r[4] is not None else f"{raw_type}({r[3]})"
                    result["columns"].append({
                        "name": r[0], "col_type": col_type, "data_type": display_type,
                        "length": r[2], "precision": r[3], "scale": r[4],
                        "nullable": r[5] == "YES",
                        "default_val": str(r[6]) if r[6] is not None else None,
                        "auto_increment": False,
                        "comment": pg_col_cmt.get(r[0], ""), "position": r[7]
                    })
                # ★ 获取索引
                try:
                    idx_r = conn.execute(text(
                        "SELECT i.relname, am.amname, x.indisunique, x.indisprimary, array_agg(a.attname ORDER BY k.n) "
                        "FROM pg_index x "
                        "JOIN pg_class c ON c.oid=x.indrelid "
                        "JOIN pg_class i ON i.oid=x.indexrelid "
                        "JOIN pg_namespace n ON n.oid=c.relnamespace "
                        "JOIN pg_am am ON am.oid=i.relam "
                        "JOIN LATERAL unnest(x.indkey) WITH ORDINALITY k(attnum, n) ON true "
                        "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum "
                        "WHERE n.nspname=:sch AND c.relname=:tbl "
                        "GROUP BY i.relname, am.amname, x.indisunique, x.indisprimary "
                        "ORDER BY i.relname"
                    ), {"sch": sch, "tbl": table_name}).fetchall()
                    for ir in idx_r:
                        idx_type = 'PRIMARY' if ir[1] == 'btree' and False else ('UNIQUE' if False else 'INDEX')
                        # 用 indisunique/isprimary 判断更可靠
                        result["indexes"].append({
                            "name": ir[0], "type": "PRIMARY" if ir[3] else ("UNIQUE" if ir[2] else "INDEX"),
                            "columns": list(ir[4]) if ir[4] else [],
                            "method": ir[1] or "BTREE"
                        })
                except Exception:
                    pass
                # ★ 获取主键索引标记
                # ★ 表注释
                pg_tbl_cmt = ""
                try:
                    tc_r = conn.execute(text(
                        "SELECT pg_catalog.obj_description(c.oid,'pg_class') "
                        "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                        "WHERE n.nspname=:sch AND c.relname=:tbl"
                    ), {"sch": sch, "tbl": table_name}).fetchone()
                    if tc_r and tc_r[0]: pg_tbl_cmt = tc_r[0]
                except Exception:
                    pass
                result["table_options"] = {"engine": "", "collation": "", "comment": pg_tbl_cmt}

            elif db_type == 'oracle':
                # ★ Oracle 使用 ALL_TAB_COLUMNS（支持跨 schema），表名/owner 转大写
                # ★ 优先用 database（当前浏览的 schema），其次用连接用户名
                owner = (database or cdata.get("user", "") or "").upper()
                tbl = table_name.upper()
                # ★ 无长度类型（DATE/CLOB/BLOB 等）不带括号；TIMESTAMP 支持精度参数
                _ORA_NO_LEN = ('DATE', 'CLOB', 'NCLOB', 'LONG',
                               'BLOB', 'LONG RAW', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'ROWID')
                cols = conn.execute(text(
                    "SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, "
                    "NULLABLE, DATA_DEFAULT, COLUMN_ID "
                    "FROM ALL_TAB_COLUMNS WHERE OWNER=:own AND TABLE_NAME=:tbl ORDER BY COLUMN_ID"
                ), {"own": owner, "tbl": tbl}).fetchall()
                # ★ 获取列注释
                col_cmt_map = {}
                try:
                    cmt_rows = conn.execute(text(
                        "SELECT COLUMN_NAME, COMMENTS FROM ALL_COL_COMMENTS "
                        "WHERE OWNER=:own AND TABLE_NAME=:tbl"
                    ), {"own": owner, "tbl": tbl}).fetchall()
                    for cr in cmt_rows:
                        col_cmt_map[cr[0]] = cr[1] or ""
                except Exception:
                    pass
                # ★ 获取主键列（通过 ALL_CONSTRAINTS）
                pk_cols_set = set()
                try:
                    pk_rows_info = conn.execute(text(
                        "SELECT cc.COLUMN_NAME FROM ALL_CONSTRAINTS c "
                        "JOIN ALL_CONS_COLUMNS cc ON c.CONSTRAINT_NAME=cc.CONSTRAINT_NAME AND c.OWNER=cc.OWNER "
                        "WHERE c.OWNER=:own AND c.TABLE_NAME=:tbl AND c.CONSTRAINT_TYPE='P' "
                        "ORDER BY cc.POSITION"
                    ), {"own": owner, "tbl": tbl}).fetchall()
                    for pr in pk_rows_info:
                        pk_cols_set.add(pr[0].upper())
                except Exception:
                    pass
                # ★ 获取主键约束名（用于索引列表标记 PRIMARY）
                pk_constraint_name = None
                if pk_cols_set:
                    try:
                        pk_name_row = conn.execute(text(
                            "SELECT CONSTRAINT_NAME FROM ALL_CONSTRAINTS "
                            "WHERE OWNER=:own AND TABLE_NAME=:tbl AND CONSTRAINT_TYPE='P'"
                        ), {"own": owner, "tbl": tbl}).fetchone()
                        if pk_name_row:
                            pk_constraint_name = pk_name_row[0].upper()
                    except Exception:
                        pass

                for r in cols:
                    dt = r[1]
                    length = int(r[2]) if r[2] else None
                    if dt.upper() in _ORA_NO_LEN:
                        col_type = dt
                        length = None
                    elif dt == 'NUMBER' and r[3] is not None and r[4] is not None:
                        col_type = f"NUMBER({r[3]},{r[4]})"
                    elif dt == 'NUMBER' and r[3] is not None:
                        col_type = f"NUMBER({r[3]})"
                    elif length and dt in ('VARCHAR', 'VARCHAR2', 'CHAR', 'NCHAR', 'NVARCHAR2', 'RAW'):
                        col_type = f"{dt}({length})"
                    else:
                        col_type = dt
                    # ★ 保留 DATA_DEFAULT 原始值（含引号），前端会处理显示
                    raw_default = str(r[6]).strip() if r[6] is not None else None
                    result["columns"].append({
                        "name": r[0], "col_type": col_type, "data_type": dt,
                        "length": length, "precision": r[3], "scale": r[4],
                        "nullable": r[5] == 'Y',
                        "default_val": raw_default,
                        "auto_increment": False,
                        "comment": col_cmt_map.get(r[0], ""), "position": r[7]
                    })
                # 获取索引信息
                idxs = conn.execute(text(
                    "SELECT i.INDEX_NAME, i.UNIQUENESS, ic.COLUMN_NAME "
                    "FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS ic "
                    "ON i.INDEX_NAME=ic.INDEX_NAME AND i.OWNER=ic.INDEX_OWNER "
                    "WHERE i.TABLE_OWNER=:own AND i.TABLE_NAME=:tbl "
                    "ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION"
                ), {"own": owner, "tbl": tbl}).fetchall()
                idx_map = {}
                for r in idxs:
                    key_name = r[0]
                    if key_name not in idx_map:
                        # ★ 主键索引用约束名匹配，不用 SYS_ 前缀猜测
                        is_pk = (pk_constraint_name and key_name.upper() == pk_constraint_name)
                        idx_map[key_name] = {
                            "name": key_name,
                            "type": "PRIMARY" if is_pk else ("UNIQUE" if r[1] == 'UNIQUE' else "INDEX"),
                            "columns": [], "method": "BTREE"
                        }
                    idx_map[key_name]["columns"].append(r[2])
                result["indexes"] = list(idx_map.values())
                # ★ 获取表注释
                tbl_comment = ""
                try:
                    tc_row = conn.execute(text(
                        "SELECT COMMENTS FROM ALL_TAB_COMMENTS "
                        "WHERE OWNER=:own AND TABLE_NAME=:tbl AND TABLE_TYPE='TABLE'"
                    ), {"own": owner, "tbl": tbl}).fetchone()
                    if tc_row:
                        tbl_comment = tc_row[0] or ""
                except Exception:
                    pass
                result["table_options"] = {"engine": "", "collation": "", "comment": tbl_comment}

            elif db_type == 'mssql':
                owner = schema or 'dbo'
                cols = conn.execute(text(
                    "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, "
                    "c.is_nullable, c.is_identity, dc.definition, ep.value "
                    "FROM sys.tables tb JOIN sys.schemas s ON s.schema_id=tb.schema_id "
                    "JOIN sys.columns c ON c.object_id=tb.object_id "
                    "JOIN sys.types ty ON ty.user_type_id=c.user_type_id "
                    "LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id "
                    "AND dc.parent_column_id=c.column_id "
                    "LEFT JOIN sys.extended_properties ep ON ep.major_id=c.object_id "
                    "AND ep.minor_id=c.column_id AND ep.name='MS_Description' "
                    "WHERE s.name=:sch AND tb.name=:tbl ORDER BY c.column_id"
                ), {"sch": owner, "tbl": table_name}).fetchall()
                for r in cols:
                    type_name = str(r[1]).upper()
                    if type_name in ('VARCHAR', 'CHAR', 'VARBINARY', 'BINARY'):
                        type_name += '(MAX)' if r[2] == -1 else f'({r[2]})'
                    elif type_name in ('NVARCHAR', 'NCHAR'):
                        type_name += '(MAX)' if r[2] == -1 else f'({int(r[2] / 2)})'
                    elif type_name in ('DECIMAL', 'NUMERIC'):
                        type_name += f'({r[3]},{r[4]})'
                    result["columns"].append({
                        "name": r[0], "col_type": type_name, "data_type": str(r[1]).lower(),
                        "length": r[2], "precision": r[3], "scale": r[4],
                        "nullable": bool(r[5]), "default_val": str(r[7]) if r[7] is not None else None,
                        "auto_increment": bool(r[6]), "comment": r[8] or "", "position": len(result["columns"]) + 1,
                    })
                idxs = conn.execute(text(
                    "SELECT i.name, i.is_unique, i.is_primary_key, c.name "
                    "FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id "
                    "JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id "
                    "JOIN sys.tables tb ON tb.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=tb.schema_id "
                    "WHERE s.name=:sch AND tb.name=:tbl AND i.name IS NOT NULL ORDER BY i.name, ic.key_ordinal"
                ), {"sch": owner, "tbl": table_name}).fetchall()
                idx_map = {}
                for r in idxs:
                    idx_map.setdefault(r[0], {"name": r[0], "type": "PRIMARY" if r[2] else ("UNIQUE" if r[1] else "INDEX"), "columns": [], "method": "BTREE"})["columns"].append(r[3])
                result["indexes"] = list(idx_map.values())
                tc = conn.execute(text(
                    "SELECT CAST(ep.value AS nvarchar(max)) FROM sys.tables tb "
                    "JOIN sys.schemas s ON s.schema_id=tb.schema_id "
                    "LEFT JOIN sys.extended_properties ep ON ep.major_id=tb.object_id AND ep.minor_id=0 AND ep.name='MS_Description' "
                    "WHERE s.name=:sch AND tb.name=:tbl"
                ), {"sch": owner, "tbl": table_name}).fetchone()
                result["table_options"] = {"engine": "", "collation": "", "comment": tc[0] if tc else ""}
            else:
                result["table_options"] = {"engine": "", "collation": "", "comment": ""}

        engine.dispose()
        return {"ok": True, "design": result}
    except Exception as e:
        db_t = cdata.get('db_type', 'mysql') if cdata else 'mysql'
        return {"ok": False, "msg": _friendly_error(e, db_t)}


@eel.expose
def table_apply_design(conn_data, database, table_name, design, schema='', execute=True, operation_id=None):
    """应用表设计修改（生成并执行 ALTER TABLE），execute=False 时仅返回 SQL"""
    cdata = {}
    db_type = 'mysql'
    engine = None
    op_state = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        op_state = _register_db_operation(operation_id, cdata, 'table_design')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if _db_operation_cancelled(op_state):
            raise RuntimeError("操作已取消")
        _validate_design_payload(design)
        tbl = _build_table_ref(cdata, database, table_name, schema)

        sqls = []
        if db_type in ('mysql', 'ob-mysql'):
            columns = design.get("columns", [])
            indexes = design.get("indexes", [])
            foreign_keys = design.get("foreign_keys", [])
            table_options = design.get("table_options", {})

            # 获取数据库中现有列名 + 索引详情 + 表属性（用于 diff）
            with engine.connect() as curconn:
                existing_rows = curconn.execute(text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl"
                ), {"db": database, "tbl": table_name}).fetchall()
                # 现有列详情
                existing_detail_rows = curconn.execute(text(
                    "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT "
                    "FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
                ), {"db": database, "tbl": table_name}).fetchall()
                # 现有索引详情（名称+类型+列+方法）
                existing_idx_rows = curconn.execute(text(
                    "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE "
                    "FROM INFORMATION_SCHEMA.STATISTICS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl "
                    "ORDER BY INDEX_NAME, SEQ_IN_INDEX"
                ), {"db": database, "tbl": table_name}).fetchall()
                # 现有表属性
                existing_opt = curconn.execute(text(
                    "SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT "
                    "FROM INFORMATION_SCHEMA.TABLES "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl"
                ), {"db": database, "tbl": table_name}).fetchone()
                existing_fk_rows = curconn.execute(text(
                    "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, "
                    "k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE "
                    "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k "
                    "JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r "
                    "ON k.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA "
                    "WHERE k.TABLE_SCHEMA=:db AND k.TABLE_NAME=:tbl AND k.REFERENCED_TABLE_NAME IS NOT NULL "
                    "ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
                ), {"db": database, "tbl": table_name}).fetchall()
            existing_cols = set(r[0] for r in existing_rows)
            # 构建现有列详情
            existing_detail = {}
            for pos, r in enumerate(existing_detail_rows, 1):
                existing_detail[r[0]] = {
                    "col_type": r[1] or "",
                    "nullable": r[2] == "YES",
                    "default_val": str(r[3]) if r[3] is not None else None,
                    "auto_increment": "auto_increment" in (r[4] or ""),
                    "comment": r[5] or "",
                    "position": pos
                }
            # 构建现有索引详情 {name: {type, columns, method}}
            existing_detail_idx = {}
            for r in existing_idx_rows:
                if r[0] not in existing_detail_idx:
                    existing_detail_idx[r[0]] = {
                        "type": "PRIMARY" if r[0] == "PRIMARY" else ("UNIQUE" if r[1] == 0 else "INDEX"),
                        "columns": [], "method": r[3] or "BTREE"
                    }
                existing_detail_idx[r[0]]["columns"].append(r[2])
            existing_fks = {}
            for r in existing_fk_rows:
                existing_fks.setdefault(r[0], []).append({
                    "column": r[1], "ref_table": r[2], "ref_column": r[3],
                    "on_update": _valid_fk_action(r[4]), "on_delete": _valid_fk_action(r[5])
                })
            # 现有表属性
            existing_opts = {}
            if existing_opt:
                existing_opts = {
                    "engine": (existing_opt[0] or "InnoDB").lower(),
                    "collation": (existing_opt[1] or "").lower(),
                    "comment": existing_opt[2] or ""
                }

            # ===== 三阶段 ALTER TABLE：先删索引 → 再改列 → 最后加索引 =====
            existing_order = [r[0] for r in existing_detail_rows]
            rename_map = _infer_column_renames(existing_order, columns)
            new_col_names = set(col.get("name", "") for col in columns)
            new_col_names.update(rename_map.values())
            dropped_col_names = set(n for n in existing_detail if n not in new_col_names)
            if existing_detail and not (set(new_col_names) & set(existing_detail)):
                raise ValueError("设计字段与目标表完全不匹配，已拒绝执行，避免误删字段")

            pre_parts = []   # 阶段1：删除索引
            mid_parts = []   # 阶段2：列操作 + 主键
            post_parts = []  # 阶段3：新建索引 + 表属性

            # -- 阶段1：删除所有受影响的索引（先删索引才能安全删列）--
            # 1a. 删除引用被删列的已有索引
            for old_idx_name, old_idx_info in existing_detail_idx.items():
                if old_idx_name == "PRIMARY":
                    continue
                idx_cols = set(old_idx_info.get("columns", []))
                if idx_cols & dropped_col_names:
                    pre_parts.append(f"DROP INDEX {_safe_ident(old_idx_name, db_type)}")

            # 1b. 删除被修改的已有索引（先DROP再在阶段3 ADD）
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    continue
                idx_name = idx["name"]
                if idx_name in existing_detail_idx and idx_name not in dropped_col_names:
                    old_idx = existing_detail_idx[idx_name]
                    new_cols = list(idx.get("columns", []))
                    old_cols = list(old_idx.get("columns", [])) if old_idx else []
                    idx_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                    old_idx_type = old_idx.get("type", "")
                    if (new_cols != old_cols or idx_type != old_idx_type or
                            str(idx.get("method", "BTREE")).upper() != str(old_idx.get("method", "BTREE")).upper()):
                        pre_parts.append(f"DROP INDEX {_safe_ident(idx_name, db_type)}")

            # 1c. 删除完全移除的索引
            new_idx_names = set(idx.get("name", "") for idx in indexes)
            for old_idx_name in existing_detail_idx:
                if old_idx_name == "PRIMARY":
                    continue
                if old_idx_name not in new_idx_names and old_idx_name not in dropped_col_names:
                    pre_parts.append(f"DROP INDEX {_safe_ident(old_idx_name, db_type)}")

            # 外键也纳入 diff：先删除变更/移除的外键，再在最后新增。
            new_fk_map = {}
            for fk in foreign_keys:
                fk_name = str(fk.get("name", "")).strip()
                if not fk_name:
                    continue
                new_fk_map.setdefault(fk_name, []).append({
                    "column": fk.get("column", ""),
                    "ref_table": fk.get("ref_table", ""),
                    "ref_column": fk.get("ref_column", ""),
                    "on_update": _valid_fk_action(fk.get("on_update")),
                    "on_delete": _valid_fk_action(fk.get("on_delete")),
                })
            for fk_name, old_fk in existing_fks.items():
                if old_fk != new_fk_map.get(fk_name):
                    pre_parts.append(f"DROP FOREIGN KEY {_safe_ident(fk_name, db_type)}")
            for fk_name, new_fk in new_fk_map.items():
                if existing_fks.get(fk_name) == new_fk:
                    continue
                first = new_fk[0]
                cols_sql = ", ".join(_safe_ident(fk["column"], db_type) for fk in new_fk)
                ref_cols_sql = ", ".join(_safe_ident(fk["ref_column"], db_type) for fk in new_fk)
                post_parts.append(
                    f"ADD CONSTRAINT {_safe_ident(fk_name, db_type)} FOREIGN KEY ({cols_sql}) REFERENCES "
                    f"{_safe_ident(first['ref_table'], db_type)} ({ref_cols_sql}) "
                    f"ON DELETE {first['on_delete']} ON UPDATE {first['on_update']}"
                )

            # -- 阶段2：列操作 --
            for i, col in enumerate(columns):
                col_name = col.get("name", "")
                name = _safe_ident(col_name, db_type)
                col_type = col.get("col_type", col.get("data_type", "VARCHAR(255)"))
                nullable = " NULL" if col.get("nullable", True) else " NOT NULL"
                has_default = "default_val" in col and col.get("default_val") is not None
                default = (
                    f" DEFAULT {_format_migrated_default(col.get('default_val'), col_type)}"
                    if has_default else ""
                )
                auto_inc = " AUTO_INCREMENT" if col.get("auto_increment") else ""
                cmt_raw = col.get('comment', '')
                if cmt_raw:
                    cmt_esc = cmt_raw.replace("\\", "\\\\").replace("'", "\\'")
                    comment = f" COMMENT '{cmt_esc}'"
                else:
                    comment = ""
                after_clause = ""
                if i == 0:
                    after_clause = " FIRST"
                elif i > 0:
                    after_clause = f" AFTER {_safe_ident(columns[i-1]['name'], db_type)}"
                col_def = f"{name} {col_type}{nullable}{default}{auto_inc}{comment}"

                old_name = rename_map.get(col_name, col_name)
                if col_name and old_name in existing_detail:
                    old = existing_detail[old_name]
                    new_type = (col.get("col_type") or col.get("data_type", "")).lower()
                    old_type = (old["col_type"] or "").lower()
                    changed = (
                        new_type != old_type
                        or col.get("nullable", True) != old["nullable"]
                        or not _defaults_equal(col.get("default_val"), old["default_val"])
                        or col.get("auto_increment", False) != old["auto_increment"]
                        or col.get("comment", "") != old["comment"]
                        or old.get("position") != i + 1
                    )
                    if changed:
                        op = "CHANGE COLUMN " + _safe_ident(old_name, db_type) + " " if old_name != col_name else "MODIFY COLUMN "
                        mid_parts.append(f"{op}{col_def}{after_clause}")
                else:
                    mid_parts.append(f"ADD COLUMN {col_def}{after_clause}")

            # 删除列
            for old_name in dropped_col_names:
                mid_parts.append(f"DROP COLUMN {_safe_ident(old_name, db_type)}")

            # 主键
            pk_idx = None
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    pk_idx = idx
                    break
            old_pk = existing_detail_idx.get("PRIMARY", {})
            old_pk_cols = list(old_pk.get("columns", []))
            new_pk_cols = list(pk_idx.get("columns", [])) if pk_idx else []
            if old_pk_cols != new_pk_cols:
                if old_pk_cols and not new_pk_cols:
                    mid_parts.append("DROP PRIMARY KEY")
                elif new_pk_cols and old_pk_cols:
                    pk_cols = ", ".join(_safe_ident(c, db_type) for c in new_pk_cols)
                    mid_parts.append(f"DROP PRIMARY KEY, ADD PRIMARY KEY ({pk_cols})")
                elif new_pk_cols:
                    pk_cols = ", ".join(_safe_ident(c, db_type) for c in new_pk_cols)
                    mid_parts.append(f"ADD PRIMARY KEY ({pk_cols})")

            # -- 阶段3：新建/重建索引 --
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    continue
                idx_name = idx["name"]
                idx_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                idx_col_names = idx.get("columns", [])
                # 跳过引用被删列的索引
                if set(idx_col_names) & dropped_col_names:
                    continue
                # 跳过旧索引没变化的
                new_cols = list(idx_col_names)
                old_idx = existing_detail_idx.get(idx_name, {})
                old_cols = list(old_idx.get("columns", [])) if old_idx else []
                method = str(idx.get("method", "BTREE")).upper()
                if (idx_name in existing_detail_idx and new_cols == old_cols and
                        idx_type == old_idx.get("type", "") and
                        method == str(old_idx.get("method", "BTREE")).upper()):
                    continue
                using = f" USING {method}" if method in {"BTREE", "HASH", "RTREE"} else ""
                post_parts.append(f"ADD {idx_type} {_safe_ident(idx_name, db_type)} ({', '.join(_safe_ident(c, db_type) for c in idx_col_names)}){using}")

            # 表属性
            opts = table_options
            if opts.get("engine") and (opts["engine"].lower() != existing_opts.get("engine", "")):
                post_parts.append(f"ENGINE={opts['engine']}")
            if opts.get("collation") and (opts["collation"].lower() != existing_opts.get("collation", "")):
                post_parts.append(f"COLLATE={opts['collation']}")
            if opts.get("comment") is not None and opts.get("comment", "") != existing_opts.get("comment", ""):
                post_parts.append(f"COMMENT={_sql_literal(opts['comment'])}")

            alter_parts = pre_parts + mid_parts + post_parts

            if alter_parts:
                sqls.append(f"ALTER TABLE {tbl} {', '.join(alter_parts)}")

        elif db_type == 'postgresql':
            columns = design.get("columns", [])
            sch = schema if schema else database
            with engine.connect() as curconn:
                existing_col_rows = curconn.execute(text(
                    "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), "
                    "a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), a.attnum "
                    "FROM pg_catalog.pg_attribute a "
                    "JOIN pg_catalog.pg_class c ON c.oid=a.attrelid "
                    "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                    "LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum "
                    "WHERE n.nspname=:sch AND c.relname=:tbl AND a.attnum>0 AND NOT a.attisdropped "
                    "ORDER BY a.attnum"
                ), {"sch": sch, "tbl": table_name}).fetchall()
                comment_rows = curconn.execute(text(
                    "SELECT a.attname, pg_catalog.col_description(a.attrelid, a.attnum) "
                    "FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid "
                    "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                    "WHERE n.nspname=:sch AND c.relname=:tbl AND a.attnum>0 AND NOT a.attisdropped"
                ), {"sch": sch, "tbl": table_name}).fetchall()
                pk_rows = curconn.execute(text(
                    "SELECT tc.constraint_name, kcu.column_name "
                    "FROM information_schema.table_constraints tc "
                    "JOIN information_schema.key_column_usage kcu "
                    "ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema "
                    "WHERE tc.table_schema=:sch AND tc.table_name=:tbl AND tc.constraint_type='PRIMARY KEY' "
                    "ORDER BY kcu.ordinal_position"
                ), {"sch": sch, "tbl": table_name}).fetchall()
                idx_rows = curconn.execute(text(
                    "SELECT i.relname, x.indisprimary, x.indisunique, am.amname, "
                    "array_agg(a.attname ORDER BY k.n) "
                    "FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class c ON c.oid=x.indrelid "
                    "JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid "
                    "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                    "JOIN pg_catalog.pg_am am ON am.oid=i.relam "
                    "JOIN LATERAL unnest(x.indkey) WITH ORDINALITY k(attnum,n) ON true "
                    "JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum "
                    "WHERE n.nspname=:sch AND c.relname=:tbl "
                    "GROUP BY i.relname, x.indisprimary, x.indisunique, am.amname"
                ), {"sch": sch, "tbl": table_name}).fetchall()
                table_comment_row = curconn.execute(text(
                    "SELECT obj_description(c.oid, 'pg_class') FROM pg_class c "
                    "JOIN pg_namespace n ON n.oid=c.relnamespace "
                    "WHERE n.nspname=:sch AND c.relname=:tbl"
                ), {"sch": sch, "tbl": table_name}).fetchone()
                pg_fk_rows = curconn.execute(text(
                    "SELECT tc.constraint_name, kcu.column_name, ccu.table_name, ccu.column_name, "
                    "rc.update_rule, rc.delete_rule "
                    "FROM information_schema.table_constraints tc "
                    "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema "
                    "JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name AND tc.table_schema=ccu.table_schema "
                    "JOIN information_schema.referential_constraints rc ON tc.constraint_name=rc.constraint_name AND tc.table_schema=rc.constraint_schema "
                    "WHERE tc.table_schema=:sch AND tc.table_name=:tbl AND tc.constraint_type='FOREIGN KEY' "
                    "ORDER BY tc.constraint_name, kcu.ordinal_position"
                ), {"sch": sch, "tbl": table_name}).fetchall()

            existing_detail = {
                r[0]: {"col_type": r[1], "nullable": not bool(r[2]),
                       "default_val": r[3], "position": r[4]}
                for r in existing_col_rows
            }
            existing_comments = {r[0]: (r[1] or "") for r in comment_rows}
            existing_order = [r[0] for r in existing_col_rows]
            rename_map = _infer_column_renames(existing_order, columns)
            new_names = {str(c.get("name", "")).strip() for c in columns}
            new_names.update(rename_map.values())
            if existing_detail and not (new_names & set(existing_detail)):
                raise ValueError("设计字段与目标表完全不匹配，已拒绝执行，避免误删字段")
            dropped = [n for n in existing_detail if n not in new_names]
            pk_name = pk_rows[0][0] if pk_rows else None
            old_pk = [r[1] for r in pk_rows]
            existing_indexes = {}
            for r in idx_rows:
                existing_indexes[r[0]] = {
                    "type": "PRIMARY" if r[1] else ("UNIQUE" if r[2] else "INDEX"),
                    "columns": list(r[4] or []), "method": (r[3] or "btree").upper()
                }

            # Rename first so subsequent ALTER statements address the new name.
            for new_name, old_name in rename_map.items():
                sqls.append(f"ALTER TABLE {tbl} RENAME COLUMN {_safe_ident(old_name, db_type)} TO {_safe_ident(new_name, db_type)}")

            for i, col in enumerate(columns):
                col_name = str(col.get("name", "")).strip()
                name = _safe_ident(col_name, db_type)
                old_name = rename_map.get(col_name, col_name)
                old = existing_detail.get(old_name)
                col_type = str(col.get("col_type", col.get("data_type", "VARCHAR(255)"))).strip()
                has_default = col.get("default_val") is not None
                default_sql = _format_migrated_default(col.get("default_val"), col_type) if has_default else None
                if old is None:
                    nullable = " NULL" if col.get("nullable", True) else " NOT NULL"
                    identity = " GENERATED BY DEFAULT AS IDENTITY" if col.get("auto_increment") and "SERIAL" not in col_type.upper() else ""
                    default = f" DEFAULT {default_sql}" if default_sql is not None and not identity else ""
                    sqls.append(f"ALTER TABLE {tbl} ADD COLUMN {name} {col_type}{identity}{default}{nullable}")
                    if col.get("comment"):
                        sqls.append(f"COMMENT ON COLUMN {tbl}.{name} IS {_sql_literal(col['comment'])}")
                    continue
                if str(old.get("col_type", "")).lower() != col_type.lower():
                    sqls.append(f"ALTER TABLE {tbl} ALTER COLUMN {name} TYPE {col_type} USING {name}::{col_type}")
                if col.get("nullable", True) != old.get("nullable", True):
                    sqls.append(f"ALTER TABLE {tbl} ALTER COLUMN {name}{' DROP NOT NULL' if col.get('nullable', True) else ' SET NOT NULL'}")
                old_default = str(old.get("default_val") or "").strip()
                new_default = str(default_sql or "").strip()
                if old_default != new_default:
                    sqls.append(f"ALTER TABLE {tbl} ALTER COLUMN {name}{' SET DEFAULT ' + default_sql if default_sql is not None else ' DROP DEFAULT'}")
                old_comment = existing_comments.get(old_name, "")
                new_comment = str(col.get("comment") or "")
                if old_comment != new_comment:
                    sqls.append(f"COMMENT ON COLUMN {tbl}.{name} IS {_sql_literal(new_comment) if new_comment else 'NULL'}")

            for old_name in dropped:
                sqls.append(f"ALTER TABLE {tbl} DROP COLUMN {_safe_ident(old_name, db_type)}")

            new_pk_idx = next((i for i in design.get("indexes", []) if i.get("type") == "PRIMARY"), None)
            new_pk = list(new_pk_idx.get("columns", [])) if new_pk_idx else []
            if old_pk != new_pk:
                if old_pk and pk_name:
                    sqls.append(f"ALTER TABLE {tbl} DROP CONSTRAINT {_safe_ident(pk_name, db_type)}")
                if new_pk:
                    sqls.append(f"ALTER TABLE {tbl} ADD PRIMARY KEY ({', '.join(_safe_ident(c, db_type) for c in new_pk)})")

            design_indexes = {i.get("name"): i for i in design.get("indexes", []) if i.get("type") != "PRIMARY"}
            for idx_name, old_idx in existing_indexes.items():
                if old_idx["type"] == "PRIMARY":
                    continue
                new_idx = design_indexes.get(idx_name)
                if new_idx is None or list(new_idx.get("columns", [])) != old_idx["columns"] or ("UNIQUE" if new_idx.get("type") == "UNIQUE" else "INDEX") != old_idx["type"]:
                    sqls.append(f"DROP INDEX {_safe_ident(sch, db_type)}.{_safe_ident(idx_name, db_type)}")
            for idx_name, idx in design_indexes.items():
                if not idx_name or not idx.get("columns"):
                    continue
                old_idx = existing_indexes.get(idx_name)
                idx_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                if old_idx and old_idx["type"] == idx_type and old_idx["columns"] == list(idx.get("columns", [])):
                    continue
                sqls.append(f"CREATE {idx_type} {_safe_ident(idx_name, db_type)} ON {tbl} ({', '.join(_safe_ident(c, db_type) for c in idx.get('columns', []))})")

            opts = design.get("table_options", {})
            old_table_comment = (table_comment_row[0] or "") if table_comment_row else ""
            new_table_comment = str(opts.get("comment") or "")
            if old_table_comment != new_table_comment:
                sqls.append(f"COMMENT ON TABLE {tbl} IS {_sql_literal(new_table_comment) if new_table_comment else 'NULL'}")

            existing_fks = {}
            for r in pg_fk_rows:
                existing_fks.setdefault(r[0], []).append({
                    "column": r[1], "ref_table": r[2], "ref_column": r[3],
                    "on_update": _valid_fk_action(r[4]), "on_delete": _valid_fk_action(r[5])
                })
            new_fk_map = {}
            for fk in design.get("foreign_keys", []) or []:
                fk_name = str(fk.get("name", "")).strip()
                if fk_name:
                    new_fk_map.setdefault(fk_name, []).append({
                        "column": fk.get("column", ""), "ref_table": fk.get("ref_table", ""),
                        "ref_column": fk.get("ref_column", ""),
                        "on_update": _valid_fk_action(fk.get("on_update")),
                        "on_delete": _valid_fk_action(fk.get("on_delete")),
                    })
            for fk_name, old_fk in existing_fks.items():
                if old_fk != new_fk_map.get(fk_name):
                    sqls.append(f"ALTER TABLE {tbl} DROP CONSTRAINT {_safe_ident(fk_name, db_type)}")
            for fk_name, fk_rows in new_fk_map.items():
                if existing_fks.get(fk_name) == fk_rows:
                    continue
                first = fk_rows[0]
                cols_sql = ", ".join(_safe_ident(f["column"], db_type) for f in fk_rows)
                ref_cols_sql = ", ".join(_safe_ident(f["ref_column"], db_type) for f in fk_rows)
                sqls.append(
                    f"ALTER TABLE {tbl} ADD CONSTRAINT {_safe_ident(fk_name, db_type)} FOREIGN KEY ({cols_sql}) "
                    f"REFERENCES {_safe_ident(sch, db_type)}.{_safe_ident(first['ref_table'], db_type)} ({ref_cols_sql}) "
                    f"ON DELETE {first['on_delete']} ON UPDATE {first['on_update']}"
                )

        elif db_type == 'oracle':
            # ★ Oracle 表设计器：生成 ALTER TABLE + 独立 DDL 语句
            columns = design.get("columns", [])
            indexes = design.get("indexes", [])
            tbl_upper = table_name.upper()
            owner = database.upper() if database else (cdata.get("user", "") or "").upper()

            # 获取现有列和索引信息（用于 diff）
            with engine.connect() as curconn:
                existing_col_rows = curconn.execute(text(
                    "SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, "
                    "NULLABLE, DATA_DEFAULT, COLUMN_ID "
                    "FROM ALL_TAB_COLUMNS WHERE OWNER=:own AND TABLE_NAME=:tbl ORDER BY COLUMN_ID"
                ), {"own": owner, "tbl": tbl_upper}).fetchall()
                existing_idx_rows = curconn.execute(text(
                    "SELECT i.INDEX_NAME, i.UNIQUENESS, ic.COLUMN_NAME, i.INDEX_TYPE "
                    "FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS ic "
                    "ON i.INDEX_NAME=ic.INDEX_NAME AND i.OWNER=ic.INDEX_OWNER "
                    "WHERE i.TABLE_OWNER=:own AND i.TABLE_NAME=:tbl "
                    "ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION"
                ), {"own": owner, "tbl": tbl_upper}).fetchall()
                # 获取主键列
                try:
                    pk_rows = curconn.execute(text(
                        "SELECT cc.COLUMN_NAME FROM ALL_CONSTRAINTS c "
                        "JOIN ALL_CONS_COLUMNS cc ON c.CONSTRAINT_NAME=cc.CONSTRAINT_NAME AND c.OWNER=cc.OWNER "
                        "WHERE c.OWNER=:own AND c.TABLE_NAME=:tbl AND c.CONSTRAINT_TYPE='P' "
                        "ORDER BY cc.POSITION"
                    ), {"own": owner, "tbl": tbl_upper}).fetchall()
                except Exception:
                    pk_rows = []
                try:
                    pk_name_row = curconn.execute(text(
                        "SELECT CONSTRAINT_NAME FROM ALL_CONSTRAINTS "
                        "WHERE OWNER=:own AND TABLE_NAME=:tbl AND CONSTRAINT_TYPE='P'"
                    ), {"own": owner, "tbl": tbl_upper}).fetchone()
                    pk_constraint_name = pk_name_row[0] if pk_name_row else None
                except Exception:
                    pk_constraint_name = None
                try:
                    oracle_comment_rows = curconn.execute(text(
                        "SELECT COLUMN_NAME, COMMENTS FROM ALL_COL_COMMENTS "
                        "WHERE OWNER=:own AND TABLE_NAME=:tbl"
                    ), {"own": owner, "tbl": tbl_upper}).fetchall()
                    oracle_comments = {r[0]: (r[1] or "") for r in oracle_comment_rows}
                except Exception:
                    oracle_comments = {}
                try:
                    oracle_table_comment_row = curconn.execute(text(
                        "SELECT COMMENTS FROM ALL_TAB_COMMENTS "
                        "WHERE OWNER=:own AND TABLE_NAME=:tbl AND TABLE_TYPE='TABLE'"
                    ), {"own": owner, "tbl": tbl_upper}).fetchone()
                    oracle_table_comment = (oracle_table_comment_row[0] or "") if oracle_table_comment_row else ""
                except Exception:
                    oracle_table_comment = ""

            # 构建现有列详情
            _ORA_NO_LEN = ('DATE', 'CLOB', 'NCLOB', 'LONG',
                           'BLOB', 'LONG RAW', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'ROWID')
            existing_detail = {}
            for r in existing_col_rows:
                dt = r[1]
                length = int(r[2]) if r[2] else None
                if dt.upper() in _ORA_NO_LEN:
                    col_type = dt
                elif dt == 'NUMBER' and r[3] is not None and r[4] is not None:
                    col_type = f"NUMBER({r[3]},{r[4]})"
                elif dt == 'NUMBER' and r[3] is not None:
                    col_type = f"NUMBER({r[3]})"
                elif length and dt in ('VARCHAR', 'VARCHAR2', 'CHAR', 'NCHAR', 'NVARCHAR2', 'RAW'):
                    col_type = f"{dt}({length})"
                else:
                    col_type = dt
                existing_detail[r[0]] = {
                    "col_type": col_type,
                    "nullable": r[5] == 'Y',
                    "default_val": str(r[6]).strip() if r[6] is not None else None,
                    "position": r[7],
                }

            # 构建现有索引详情
            existing_detail_idx = {}
            for r in existing_idx_rows:
                key_name = r[0]
                if key_name not in existing_detail_idx:
                    existing_detail_idx[key_name] = {
                        "type": "PRIMARY" if pk_constraint_name and r[0] == pk_constraint_name else ("UNIQUE" if r[1] == 'UNIQUE' else "INDEX"),
                        "columns": [], "method": r[3] or "BTREE"
                    }
                existing_detail_idx[key_name]["columns"].append(r[2])
            # 主键列
            old_pk_cols = [r[0] for r in pk_rows]

            # 新列名集合
            existing_order = [r[0] for r in existing_col_rows]
            rename_map = {k.upper(): str(v).upper() for k, v in _infer_column_renames(existing_order, columns).items()}
            new_col_names = set(col.get("name", "").upper() for col in columns)
            new_col_names.update(rename_map.values())
            dropped_col_names = set(n for n in existing_detail if n.upper() not in new_col_names)
            if existing_detail and not (new_col_names & {n.upper() for n in existing_detail}):
                raise ValueError("设计字段与目标表完全不匹配，已拒绝执行，避免误删字段")

            # ===== 阶段1：删除受影响的索引（DROP INDEX 是独立语句）=====
            new_idx_names = set(idx.get("name", "").upper() for idx in indexes)
            for old_idx_name, old_idx_info in existing_detail_idx.items():
                # 跳过主键自动创建的索引（由主键约束管理）
                if old_idx_info.get("type") == "PRIMARY" or old_idx_name.startswith('SYS_'):
                    continue
                idx_cols = set(c.upper() for c in old_idx_info.get("columns", []))
                # 引用被删列的索引 / 完全移除的索引 → 删除
                if (idx_cols & dropped_col_names) or (old_idx_name not in new_idx_names):
                    sqls.append(f'DROP INDEX "{old_idx_name}"')
                else:
                    # 检查是否需要重建（列或类型变化）
                    for idx in indexes:
                        if idx.get("name", "").upper() == old_idx_name:
                            new_cols = list(c.upper() for c in idx.get("columns", []))
                            old_cols = list(c.upper() for c in old_idx_info.get("columns", []))
                            new_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                            if new_cols != old_cols or new_type != old_idx_info["type"]:
                                sqls.append(f'DROP INDEX "{old_idx_name}"')
                            break

            # ===== 阶段2：列操作（ADD / MODIFY / DROP）=====
            # ★ Oracle 无长度类型列表（DATE/CLOB/BLOB 等不允许多余的 (length) 参数）
            # TIMESTAMP 支持精度参数，不在此列表中
            _ORA_NO_LEN = ('DATE', 'CLOB', 'NCLOB', 'LONG',
                           'BLOB', 'LONG RAW', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'ROWID')
            # ★ Oracle 默认值无需引号的关键字/函数
            _ORA_DEFAULT_KEYWORDS = (
                'SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIMESTAMP',
                'CURRENT_TIME', 'LOCALTIMESTAMP', 'USER', 'UID', 'NULL',
                'TRUE', 'FALSE', 'SESSIONTIMEZONE', 'DBTIMEZONE',
                'SYSGUID', 'SYS_GUID', 'SYSDATE', 'SYSTIMESTAMP',
            )

            def _ora_default_clause(val):
                """生成 Oracle DEFAULT 子句，字符串值自动加引号"""
                if not val:
                    return ""
                v = str(val).strip()
                if not v:
                    return ""
                # 已带引号 → 原样使用
                if v.startswith("'") and v.endswith("'"):
                    return f" DEFAULT {v}"
                # 纯数字 → 原样使用
                if re.match(r'^-?\d+(\.\d+)?$', v):
                    return f" DEFAULT {v}"
                # Oracle 关键字/函数 → 原样使用
                if v.upper() in _ORA_DEFAULT_KEYWORDS:
                    return f" DEFAULT {v}"
                # 函数调用（含括号）→ 原样使用
                if '(' in v:
                    return f" DEFAULT {v}"
                # 其他 → 当字符串字面量，加单引号
                return f" DEFAULT '{v.replace(chr(39), chr(39)+chr(39))}'"

            add_parts = []
            modify_parts = []
            for new_name, old_name in rename_map.items():
                sqls.append(f'ALTER TABLE {tbl} RENAME COLUMN "{old_name}" TO "{new_name}"')
            for col in columns:
                col_name = col.get("name", "")
                col_name_up = col_name.upper()
                col_type = col.get("col_type", col.get("data_type", "VARCHAR2(255)"))
                # ★ 防护：无长度类型去掉多余的括号（如 DATE(7) → DATE）
                _base_type = col_type.split('(')[0].strip().upper()
                if _base_type in _ORA_NO_LEN:
                    col_type = _base_type

                old_name_up = rename_map.get(col_name_up, col_name_up)
                if old_name_up in existing_detail:
                    old = existing_detail[old_name_up]
                    # ★ 用清理后的 col_type 比较，避免 DATE(7) vs DATE 误判为变更
                    new_type = col_type.upper()
                    old_type = (old["col_type"] or "").upper()
                    # ★ 默认值比较：去掉首尾空格和引号差异
                    new_def = (col.get("default_val") or "").strip().strip("'")
                    old_def = (old["default_val"] or "").strip().strip("'")
                    type_changed = new_type != old_type
                    nullable_changed = col.get("nullable", True) != old["nullable"]
                    default_changed = new_def.upper() != old_def.upper()

                    if type_changed or nullable_changed or default_changed:
                        # ★ 只拼接变化的部分，避免 ORA-01442（NOT NULL 无变化时不能加）
                        parts = [f'"{col_name_up}"']
                        if type_changed:
                            parts.append(col_type)
                        if default_changed:
                            parts.append(_ora_default_clause(col.get("default_val")).strip())
                        if nullable_changed:
                            parts.append("NOT NULL" if not col.get("nullable", True) else "NULL")
                        modify_parts.append(" ".join(parts))
                else:
                    # 新增列：完整定义
                    nullable = " NULL" if col.get("nullable", True) else " NOT NULL"
                    default = _ora_default_clause(col.get("default_val"))
                    col_def = f'"{col_name_up}" {col_type}{default}{nullable}'
                    add_parts.append(col_def)

            # Oracle 可以合并同类操作
            if add_parts:
                sqls.append(f'ALTER TABLE {tbl} ADD ({", ".join(add_parts)})')
            if modify_parts:
                sqls.append(f'ALTER TABLE {tbl} MODIFY ({", ".join(modify_parts)})')

            # 删除列
            for old_name in dropped_col_names:
                sqls.append(f'ALTER TABLE {tbl} DROP COLUMN "{old_name}"')

            # ===== 阶段3：主键操作 =====
            pk_idx = None
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    pk_idx = idx
                    break
            new_pk_cols = [c.upper() for c in pk_idx.get("columns", [])] if pk_idx else []
            if new_pk_cols != old_pk_cols:
                if old_pk_cols:
                    sqls.append(f'ALTER TABLE {tbl} DROP PRIMARY KEY')
                if new_pk_cols:
                    pk_cols = ", ".join(_safe_ident(c, db_type) for c in new_pk_cols)
                    sqls.append(f'ALTER TABLE {tbl} ADD PRIMARY KEY ({pk_cols})')

            # ===== 阶段4：创建/重建索引 =====
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    continue
                idx_name = idx.get("name", "")
                idx_name_up = idx_name.upper()
                idx_col_names = idx.get("columns", [])
                # 跳过引用被删列的索引
                if set(c.upper() for c in idx_col_names) & dropped_col_names:
                    continue
                # 跳过已存在且无变化的索引
                old_idx = existing_detail_idx.get(idx_name_up)
                if old_idx and not idx_name_up.startswith('SYS_'):
                    new_cols = list(c.upper() for c in idx_col_names)
                    old_cols = list(c.upper() for c in old_idx.get("columns", []))
                    new_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                    if new_cols == old_cols and new_type == old_idx["type"]:
                        continue
                unique_kw = "UNIQUE " if idx.get("type") == "UNIQUE" else ""
                idx_cols = ", ".join(_safe_ident(c, db_type) for c in idx_col_names)
                sqls.append(f'CREATE {unique_kw}INDEX {_safe_ident(idx_name_up, db_type)} ON {tbl} ({idx_cols})')

            # ===== 阶段5：列注释 =====
            for col in columns:
                cmt = str(col.get("comment") or "")
                col_name_up = col.get("name", "").upper()
                if oracle_comments.get(col_name_up, "") != cmt:
                    sqls.append(f'COMMENT ON COLUMN {tbl}.{_safe_ident(col_name_up, db_type)} IS {_sql_literal(cmt) if cmt else "NULL"}')

            # 表注释
            opts = design.get("table_options", {})
            new_table_comment = str(opts.get("comment") or "")
            if oracle_table_comment != new_table_comment:
                sqls.append(f'COMMENT ON TABLE {tbl} IS {_sql_literal(new_table_comment) if new_table_comment else "NULL"}')

        elif db_type == 'mssql':
            owner = schema or 'dbo'
            tbl = f"{_safe_ident(owner, db_type)}.{_safe_ident(table_name, db_type)}"
            columns = design.get("columns", [])
            indexes = design.get("indexes", [])
            with engine.connect() as conn:
                existing_rows = conn.execute(text(
                    "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, "
                    "c.is_identity, dc.name, dc.definition, ep.value "
                    "FROM sys.tables tb JOIN sys.schemas s ON s.schema_id=tb.schema_id "
                    "JOIN sys.columns c ON c.object_id=tb.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id "
                    "LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id "
                    "LEFT JOIN sys.extended_properties ep ON ep.major_id=c.object_id AND ep.minor_id=c.column_id AND ep.name='MS_Description' "
                    "WHERE s.name=:sch AND tb.name=:tbl ORDER BY c.column_id"
                ), {"sch": owner, "tbl": table_name}).fetchall()
                index_rows = conn.execute(text(
                    "SELECT i.name, i.is_unique, i.is_primary_key, c.name, ic.key_ordinal "
                    "FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id "
                    "JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id "
                    "JOIN sys.tables tb ON tb.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=tb.schema_id "
                    "WHERE s.name=:sch AND tb.name=:tbl AND i.name IS NOT NULL "
                    "ORDER BY i.name, ic.key_ordinal"
                ), {"sch": owner, "tbl": table_name}).fetchall()
                table_comment_row = conn.execute(text(
                    "SELECT CAST(ep.value AS nvarchar(max)) FROM sys.tables tb "
                    "JOIN sys.schemas s ON s.schema_id=tb.schema_id "
                    "LEFT JOIN sys.extended_properties ep ON ep.major_id=tb.object_id AND ep.minor_id=0 "
                    "AND ep.name='MS_Description' WHERE s.name=:sch AND tb.name=:tbl"
                ), {"sch": owner, "tbl": table_name}).fetchone()
            existing = {r[0]: r for r in existing_rows}
            existing_order = [r[0] for r in existing_rows]
            rename_map = _infer_column_renames(existing_order, columns)
            new_names = {str(c.get("name", "")).strip() for c in columns}
            new_names.update(rename_map.values())
            if existing and not (new_names & set(existing)):
                raise ValueError("设计字段与目标表完全不匹配，已拒绝执行，避免误删字段")

            existing_indexes = {}
            for r in index_rows:
                existing_indexes.setdefault(r[0], {
                    "type": "PRIMARY" if r[2] else ("UNIQUE" if r[1] else "INDEX"),
                    "columns": []
                })["columns"].append(r[3])

            def _mssql_existing_type(row):
                type_name = str(row[1]).upper()
                if type_name in ('VARCHAR', 'CHAR', 'VARBINARY', 'BINARY'):
                    type_name += '(MAX)' if row[2] == -1 else f'({row[2]})'
                elif type_name in ('NVARCHAR', 'NCHAR'):
                    type_name += '(MAX)' if row[2] == -1 else f'({int(row[2] / 2)})'
                elif type_name in ('DECIMAL', 'NUMERIC'):
                    type_name += f'({row[3]},{row[4]})'
                return type_name

            for new_name, old_name in rename_map.items():
                old_ref = f"{owner}.{table_name}.{old_name}"
                sqls.append(f"EXEC sys.sp_rename N'{old_ref.replace(chr(39), chr(39) * 2)}', N'{new_name.replace(chr(39), chr(39) * 2)}', N'COLUMN'")

            def _mssql_design_type(col):
                return str(col.get("col_type", col.get("data_type", "nvarchar(255)"))).upper()

            for col in columns:
                name_raw = str(col.get("name", "")).strip()
                if not name_raw:
                    continue
                name = _safe_ident(name_raw, db_type)
                ctype = _mssql_design_type(col)
                nullable = " NULL" if col.get("nullable", True) else " NOT NULL"
                has_default = "default_val" in col and col.get("default_val") is not None
                default_sql = _format_migrated_default(col.get("default_val"), ctype) if has_default else None
                old = existing.get(rename_map.get(name_raw, name_raw))
                if old is None:
                    identity = " IDENTITY(1,1)" if col.get("auto_increment") else ""
                    default = f" DEFAULT {default_sql}" if default_sql is not None else ""
                    sqls.append(f"ALTER TABLE {tbl} ADD {name} {ctype}{identity}{default}{nullable}")
                else:
                    if bool(old[6]) != bool(col.get("auto_increment")):
                        raise ValueError(f"SQL Server 不支持直接修改已有字段 [{name_raw}] 的 IDENTITY 属性，请重建字段")
                    if _mssql_existing_type(old) != ctype or bool(old[5]) != bool(col.get("nullable", True)):
                        sqls.append(f"ALTER TABLE {tbl} ALTER COLUMN {name} {ctype}{nullable}")
                    old_constraint, old_definition = old[7], old[8]
                    normalize_default = lambda v: str(v or '').strip().strip('()').replace(' ', '').upper()
                    default_changed = normalize_default(old_definition) != normalize_default(default_sql if has_default else None)
                    if old_constraint and (not has_default or default_changed):
                        sqls.append(f"ALTER TABLE {tbl} DROP CONSTRAINT {_safe_ident(old_constraint, db_type)}")
                    if has_default and (not old_constraint or default_changed):
                        constraint_name = f"DF_{table_name}_{name_raw}"[:120]
                        sqls.append(f"ALTER TABLE {tbl} ADD CONSTRAINT {_safe_ident(constraint_name, db_type)} DEFAULT {default_sql} FOR {name}")
                old_comment = str(old[9] or '') if old is not None else ''
                new_comment = str(col.get("comment") or '')
                if new_comment:
                    sqls.append(_mssql_comment_upsert_sql(
                        new_comment, owner, table_name, name_raw
                    ))
                elif old_comment:
                    sqls.append(_mssql_comment_drop_sql(owner, table_name, name_raw))

            for old_name in existing:
                if old_name not in new_names:
                    sqls.append(f"ALTER TABLE {tbl} DROP COLUMN {_safe_ident(old_name, db_type)}")

            new_pk = next((i for i in indexes if i.get("type") == "PRIMARY"), None)
            old_pk_name = next((n for n, i in existing_indexes.items() if i["type"] == "PRIMARY"), None)
            old_pk_cols = existing_indexes.get(old_pk_name, {}).get("columns", []) if old_pk_name else []
            new_pk_cols = list(new_pk.get("columns", [])) if new_pk else []
            if old_pk_cols != new_pk_cols:
                if old_pk_name:
                    sqls.append(f"ALTER TABLE {tbl} DROP CONSTRAINT {_safe_ident(old_pk_name, db_type)}")
                if new_pk_cols:
                    pk_name = str(new_pk.get("name") or f"PK_{table_name}")
                    sqls.append(f"ALTER TABLE {tbl} ADD CONSTRAINT {_safe_ident(pk_name, db_type)} PRIMARY KEY ({', '.join(_safe_ident(c, db_type) for c in new_pk_cols)})")

            design_indexes = {i.get("name"): i for i in indexes if i.get("type") != "PRIMARY"}
            for idx_name, old_idx in existing_indexes.items():
                if old_idx["type"] == "PRIMARY":
                    continue
                new_idx = design_indexes.get(idx_name)
                if new_idx is None or old_idx["columns"] != list(new_idx.get("columns", [])) or old_idx["type"] != ("UNIQUE" if new_idx.get("type") == "UNIQUE" else "INDEX"):
                    sqls.append(f"DROP INDEX {_safe_ident(idx_name, db_type)} ON {tbl}")
            for idx in indexes:
                if idx.get("type") == "PRIMARY" or not idx.get("name") or not idx.get("columns"):
                    continue
                unique = "UNIQUE " if idx.get("type") == "UNIQUE" else ""
                idx_name = _safe_ident(idx["name"], db_type)
                idx_cols = ", ".join(_safe_ident(c, db_type) for c in idx["columns"])
                old_idx = existing_indexes.get(idx["name"])
                if old_idx and old_idx["type"] == ("UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX") and old_idx["columns"] == list(idx["columns"]):
                    continue
                sqls.append(f"CREATE {unique}INDEX {idx_name} ON {tbl} ({idx_cols})")
            table_comment = str(design.get("table_options", {}).get("comment") or "")
            old_table_comment = str(table_comment_row[0] or '') if table_comment_row else ''
            if table_comment != old_table_comment:
                if table_comment:
                    sqls.append(_mssql_comment_upsert_sql(table_comment, owner, table_name))
                elif old_table_comment:
                    sqls.append(_mssql_comment_drop_sql(owner, table_name))

        else:
            engine.dispose()
            return {"ok": False, "msg": f"数据库类型 [{db_type}] 暂不支持表设计器"}

        if _db_operation_cancelled(op_state):
            raise RuntimeError("操作已取消")
        if not sqls:
            engine.dispose()
            return {"ok": True, "msg": "无变更", "sqls": []}

        if execute:
            with engine.begin() as conn:
                pid = _get_backend_pid(conn, db_type)
                _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
                if _db_operation_cancelled(op_state):
                    _kill_db_operation(op_state)
                    raise RuntimeError("操作已取消")
                for sql in sqls:
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
                    conn.execute(text(sql))
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
            engine.dispose()
            return {"ok": True, "msg": f"表 [{table_name}] 设计已更新"}
        else:
            engine.dispose()
            return {"ok": True, "msg": f"共 {len(sqls)} 条变更", "sqls": sqls, "preview": True}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            if engine is not None:
                try:
                    engine.dispose()
                except Exception:
                    pass
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                pass
        return {"ok": False, "msg": _friendly_error(e, db_type or 'mysql')}
    finally:
        _finish_db_operation(op_state)


def _kill_table_operation_session(state):
    """仅终止当前 DROP/TRUNCATE 操作记录的数据库会话。"""
    if not state or not state.get('pid') or not state.get('conn_data'):
        return False
    return _kill_db_session(
        state['conn_data'], state['pid'], kill_connection=True
    )


@eel.expose
def cancel_table_operation(op_id=None):
    """取消当前表级 DROP/TRUNCATE，并只杀掉该操作自己的会话。"""
    with _table_op_lock:
        state = _table_op_state
        if not state or (op_id and state.get('op_id') != op_id):
            return {"ok": False, "cancelled": False, "msg": "没有正在执行的表操作"}
        state['cancel_requested'] = True
        state_copy = dict(state)
    killed = _kill_table_operation_session(state_copy)
    return {"ok": True, "cancelled": True, "killed": killed}


def _run_table_destructive_operation(conn_data, database, table_name, schema,
                                     sql, success_msg, op_id=None):
    """执行可取消的表级 DDL，并记录本次 SQL 对应的服务端连接 ID。"""
    global _table_op_state
    cdata = dict(conn_data)
    db_type = cdata.get('db_type', 'mysql')
    if db_type != 'oracle':
        cdata['db'] = database
    engine = None
    state = {
        'op_id': op_id or ('table_op_' + str(time.time_ns())),
        'conn_data': cdata,
        'pid': None,
        'cancel_requested': False,
    }
    with _table_op_lock:
        _table_op_state = state
    try:
        engine = create_engine(_conn_url(cdata),
                               connect_args=_connect_args(db_type, timeout=10))
        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            with _table_op_lock:
                if _table_op_state is state:
                    state['pid'] = pid
                cancelled = state['cancel_requested']
            if cancelled:
                _kill_table_operation_session(dict(state))
                return {"ok": False, "cancelled": True, "msg": "操作已取消"}
            conn.execute(text(sql))
        _log_db_delete(sql)
        return {"ok": True, "msg": success_msg}
    except Exception as e:
        with _table_op_lock:
            cancelled = state.get('cancel_requested', False)
        if cancelled:
            return {"ok": False, "cancelled": True, "msg": "操作已取消"}
        return {"ok": False, "msg": _friendly_error(e, db_type)}
    finally:
        with _table_op_lock:
            if _table_op_state is state:
                _table_op_state = None
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                pass


@eel.expose
def table_truncate(conn_data, database, table_name, schema='', operation_id=None):
    cdata = dict(conn_data)
    if cdata.get('db_type') != 'oracle':
        cdata['db'] = database
    tbl = _build_table_ref(cdata, database, table_name, schema)
    sql = f"TRUNCATE TABLE {tbl}"
    return _run_table_destructive_operation(
        conn_data, database, table_name, schema, sql,
        f"表 [{table_name}] 已截断", operation_id)


@eel.expose
def table_delete(conn_data, database, table_name, schema='', operation_id=None):
    cdata = dict(conn_data)
    if cdata.get('db_type') != 'oracle':
        cdata['db'] = database
    tbl = _build_table_ref(cdata, database, table_name, schema)
    sql = f"DROP TABLE {tbl}"
    return _run_table_destructive_operation(
        conn_data, database, table_name, schema, sql,
        f"表 [{table_name}] 已删除", operation_id)

@eel.expose
def table_clear(conn_data, database, table_name, schema='', operation_id=None):
    engine = None
    op_state = None
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'oracle': cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        db_type = cdata.get("db_type", "mysql")
        op_state = _register_db_operation(operation_id, cdata, 'clear_table')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        sql = f"DELETE FROM {tbl}"
        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
            conn.execute(text(sql))
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已清空"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}
    finally:
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


@eel.expose
def table_rename(conn_data, database, old_name, new_name, schema='', operation_id=None):
    """重命名表"""
    engine = None
    op_state = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        old_tbl = _build_table_ref(cdata, database, old_name, schema)
        new_tbl = _build_table_ref(cdata, database, new_name, schema)
        op_state = _register_db_operation(operation_id, cdata, 'rename_table')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type == 'mssql':
            sql = f"EXEC sp_rename N'{str(old_tbl).replace(chr(39), chr(39) * 2)}', N'{str(new_name).replace(chr(39), chr(39) * 2)}'"
        elif db_type in ('mysql', 'ob-mysql'):
            sql = f"RENAME TABLE {old_tbl} TO {new_tbl}"
        elif db_type == 'postgresql':
            sql = f'ALTER TABLE {old_tbl} RENAME TO {_safe_ident(new_name, db_type)}'
        elif db_type == 'oracle':
            sql = f'ALTER TABLE {old_tbl} RENAME TO {_safe_ident(new_name, db_type)}'
        else:
            sql = f"RENAME TABLE {old_tbl} TO {new_tbl}"
        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
            conn.execute(text(sql))
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
        _db_op_logger.info(f"[RENAME] {old_tbl} → {new_tbl}")
        return {"ok": True, "msg": f"表 [{old_name}] 已重命名为 [{new_name}]"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}
    finally:
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


@eel.expose
def table_backup(conn_data, database, table_name, schema='', operation_id=None):
    """备份表：创建结构+数据相同的副本，表名=当前日期(MMDD_HH)，重名追加_1"""
    engine = None
    op_state = None
    try:
        from datetime import datetime as dt
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        src_tbl = _build_table_ref(cdata, database, table_name, schema)
        op_state = _register_db_operation(operation_id, cdata, 'backup_table')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=30))

        # 生成备份表名: 原表名_MMDD_HH
        base_name = f"{table_name}_{dt.now().strftime('%m%d_%H')}"
        backup_name = base_name
        # 检测重名，追加 _1, _2 ...
        existing = set()
        try:
            insp = inspect(engine)
            schema_name = schema if db_type == 'postgresql' else (database if db_type == 'oracle' else None)
            args = [schema_name] if schema_name else []
            existing = set(insp.get_table_names(*args))
        except Exception:
            pass
        suffix = 0
        orig_backup = backup_name
        while backup_name in existing:
            suffix += 1
            backup_name = f"{orig_backup}_{suffix}"
        dst_tbl = _build_table_ref(cdata, database, backup_name, schema)

        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
            if db_type in ('mysql', 'ob-mysql'):
                conn.execute(text(f"CREATE TABLE {dst_tbl} LIKE {src_tbl}"))
                if _db_operation_cancelled(op_state):
                    _kill_db_operation(op_state)
                    raise RuntimeError("操作已取消")
                conn.execute(text(f"INSERT INTO {dst_tbl} SELECT * FROM {src_tbl}"))
            elif db_type == 'postgresql':
                conn.execute(text(f'CREATE TABLE {dst_tbl} (LIKE {src_tbl} INCLUDING ALL)'))
                if _db_operation_cancelled(op_state):
                    _kill_db_operation(op_state)
                    raise RuntimeError("操作已取消")
                conn.execute(text(f'INSERT INTO {dst_tbl} SELECT * FROM {src_tbl}'))
            elif db_type == 'oracle':
                conn.execute(text(f'CREATE TABLE {dst_tbl} AS SELECT * FROM {src_tbl}'))
            elif db_type == 'mssql':
                # SELECT INTO 会丢失 identity、默认值、注释、主键和索引；
                # 先从系统目录生成结构，再复制数据，避免备份表退化成纯数据快照。
                design_result = table_get_design_info(cdata, database, table_name, schema)
                if not design_result.get("ok"):
                    raise RuntimeError(design_result.get("msg", "读取 SQL Server 表结构失败"))
                source_design = design_result.get("design", {})
                columns = []
                has_identity = False
                for col in source_design.get("columns", []):
                    item = dict(col)
                    item["type"] = item.get("col_type") or item.get("data_type") or "nvarchar(255)"
                    item["default"] = item.get("default_val")
                    columns.append(item)
                    has_identity = has_identity or bool(item.get("auto_increment"))
                index_info = {"primary_key": [], "unique": [], "indexes": []}
                for idx in source_design.get("indexes", []):
                    idx = dict(idx)
                    if idx.get("type") == "PRIMARY":
                        index_info["primary_key"] = list(idx.get("columns", []))
                    elif idx.get("type") == "UNIQUE":
                        index_info["unique"].append({
                            "name": idx.get("name", ""),
                            "columns": list(idx.get("columns", [])),
                        })
                    else:
                        index_info["indexes"].append(idx)
                options = dict(source_design.get("table_options", {}))
                options.update({"table_name": backup_name, "schema": schema or "dbo"})
                ddl = _generate_create_table("mssql", dst_tbl, columns, index_info, options)
                for stmt in _split_sql_statements(ddl):
                    if stmt.strip():
                        conn.exec_driver_sql(stmt)
                if has_identity:
                    conn.exec_driver_sql(f"SET IDENTITY_INSERT {dst_tbl} ON")
                try:
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
                    conn.execute(text(f"INSERT INTO {dst_tbl} SELECT * FROM {src_tbl}"))
                finally:
                    if has_identity:
                        conn.exec_driver_sql(f"SET IDENTITY_INSERT {dst_tbl} OFF")
            else:
                conn.execute(text(f"CREATE TABLE `{database}`.`{backup_name}` LIKE `{database}`.`{table_name}`"))
                conn.execute(text(f"INSERT INTO `{database}`.`{backup_name}` SELECT * FROM `{database}`.`{table_name}`"))
        _db_op_logger.info(f"[BACKUP] {src_tbl} → {dst_tbl}")
        return {"ok": True, "msg": f"表 [{table_name}] 已备份为 [{backup_name}]"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}
    finally:
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


# ==================== 新建表 / 执行建表 SQL ====================
@eel.expose
def table_execute_sql(conn_data, database, sql, schema='', operation_id=None):
    """执行一个 SQL 语句（用于新建表等操作）"""
    engine = None
    op_state = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        op_state = _register_db_operation(operation_id, cdata, 'execute_sql')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
            # ★ exec_driver_sql 直接执行原生 SQL：避免 text() 把 SQL 中的 ":7004"
            #    （如 JSON 字符串 "port":7004 的值）误解析为绑定参数
            conn.exec_driver_sql(sql)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
        _db_op_logger.info(f"[EXEC_SQL] 执行成功: {sql[:200]}...")
        return {"ok": True, "msg": "操作成功"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}
    finally:
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


# ==================== 删除字段 / 索引 / 外键 ====================
@eel.expose
def table_drop_column(conn_data, database, table_name, column_name, schema='', operation_id=None):
    """删除表中某个字段"""
    engine = None
    op_state = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        op_state = _register_db_operation(operation_id, cdata, 'drop_column')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        sql = f"ALTER TABLE {tbl} DROP COLUMN {_safe_ident(column_name, db_type)}"
        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
            conn.execute(text(sql))
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
        _db_op_logger.info(f"[DROP_COL] {tbl}.{column_name}")
        return {"ok": True, "msg": f"字段 [{column_name}] 已删除"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}
    finally:
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


@eel.expose
def table_drop_index(conn_data, database, table_name, index_name, schema='', operation_id=None):
    """删除表中某个索引"""
    engine = None
    op_state = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        op_state = _register_db_operation(operation_id, cdata, 'drop_index')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type == 'postgresql':
            sch = schema if schema else database
            sql = f'DROP INDEX {_safe_ident(sch, db_type)}.{_safe_ident(index_name, db_type)}'
        elif db_type == 'oracle':
            sql = f'DROP INDEX {_safe_ident(index_name, db_type)}'
        elif db_type == 'mssql':
            sql = f'DROP INDEX {_safe_ident(index_name, db_type)} ON {tbl}'
        else:
            sql = f"ALTER TABLE {tbl} DROP INDEX {_safe_ident(index_name, db_type)}"
        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
            conn.execute(text(sql))
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
        _db_op_logger.info(f"[DROP_IDX] {tbl}.{index_name}")
        return {"ok": True, "msg": f"索引 [{index_name}] 已删除"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}
    finally:
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


@eel.expose
def table_drop_foreign_key(conn_data, database, table_name, fk_name, schema='', operation_id=None):
    """删除表中某个外键"""
    engine = None
    op_state = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        op_state = _register_db_operation(operation_id, cdata, 'drop_foreign_key')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type in ('postgresql', 'oracle'):
            sql = f'ALTER TABLE {tbl} DROP CONSTRAINT {_safe_ident(fk_name, db_type)}'
        elif db_type == 'mssql':
            sql = f'ALTER TABLE {tbl} DROP CONSTRAINT {_safe_ident(fk_name, db_type)}'
        else:
            sql = f"ALTER TABLE {tbl} DROP FOREIGN KEY {_safe_ident(fk_name, db_type)}"
        with engine.begin() as conn:
            pid = _get_backend_pid(conn, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
            conn.execute(text(sql))
            if _db_operation_cancelled(op_state):
                _kill_db_operation(op_state)
                raise RuntimeError("操作已取消")
        _db_op_logger.info(f"[DROP_FK] {tbl}.{fk_name}")
        return {"ok": True, "msg": f"外键 [{fk_name}] 已删除"}
    except Exception as e:
        if _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}
    finally:
        _finish_db_operation(op_state)
        if engine is not None:
            engine.dispose()


# ==================== 树形栏目持久化（含自动备份恢复） ====================
_tree_lock = threading.RLock()  # 可重入锁，防止并发写竞争导致数据丢失（tree_delete_folder 有递归调用）
_tree_cache_data = None  # ★ _load_tree 内存缓存
_tree_cache_mtime = 0    # ★ 缓存对应的文件修改时间
if getattr(sys, 'frozen', False):
    # 打包exe环境：exe在dist/目录，直接读取同目录下的文件
    TREE_FILE = os.path.join(BASE_DIR, "mqdb_tree.json")
else:
    # 源码运行环境：从dist/目录读取
    TREE_FILE = os.path.join(BASE_DIR, "dist", "mqdb_tree.json")
def _validate_tree(data):
    """校验树数据结构完整性（仅检查结构，不检查内容）"""
    if not isinstance(data, dict):
        return False
    # 必须包含两个关键字段（saved_queries 已迁移到文件系统，不再强制要求）
    for key in ("folders", "connections"):
        if key not in data:
            data[key] = [] if key != "connections" else {}
    if not isinstance(data.get("folders"), list):
        return False
    if not isinstance(data.get("connections"), dict):
        return False
    return True

def _tree_has_content(data):
    """检查树数据是否有实际内容（不只是空壳）"""
    if not isinstance(data, dict):
        return False
    has_conns = bool(data.get("connections") and len(data.get("connections", {})) > 0)
    has_folders = bool(data.get("folders") and len(data.get("folders", [])) > 0)
    return has_conns or has_folders

def _is_empty_shell(data):
    """检查是否是结构合法但内容为空的'空壳'数据"""
    return _validate_tree(data) and not _tree_has_content(data)



# 初始化：文件不存在就创建
try:
    print(f"[tree] 初始化: frozen={getattr(sys, 'frozen', False)}, TREE_FILE={TREE_FILE}")
    if not os.path.exists(TREE_FILE):
        print("[tree] 初始化: TREE_FILE 不存在，创建空文件")
        with open(TREE_FILE, "w", encoding="utf-8") as f:
            json.dump({"folders": [], "connections": {}, "saved_queries": []}, f, ensure_ascii=False, indent=2)
    else:
        print(f"[tree] 初始化: 文件已存在，size={os.path.getsize(TREE_FILE)} bytes")
except Exception as e:
    print(f"[tree] 初始化: 异常 {e}")

def _load_tree():
    """加载树数据，带内存缓存（文件 mtime 变化时自动刷新）"""
    global _tree_cache_data, _tree_cache_mtime
    try:
        cur_mtime = os.path.getmtime(TREE_FILE) if os.path.exists(TREE_FILE) else 0
        if _tree_cache_data is not None and _tree_cache_mtime == cur_mtime:
            return _tree_cache_data
        print(f"[tree] _load_tree: reading TREE_FILE={TREE_FILE}")
        print(f"[tree] _load_tree: file exists={os.path.exists(TREE_FILE)}")
        with open(TREE_FILE, "r", encoding="utf-8") as f:
            content = f.read()
        print(f"[tree] _load_tree: file size={len(content)} bytes")
        if not content.strip():
            print("[tree] _load_tree: 文件为空")
            return {"folders": [], "connections": {}, "saved_queries": []}
        raw_data = json.loads(content)
        data = _transform_secrets(raw_data, protect=False)
        conn_count = len(data.get("connections", {}))
        print(f"[tree] _load_tree: 解析成功，connections={conn_count}, folders={len(data.get('folders',[]))}, queries={len(data.get('saved_queries',[]))}")
        if not _validate_tree(data):
            print("[tree] _load_tree: 数据格式不正确")
            return {"folders": [], "connections": {}, "saved_queries": []}
        # 兼容旧版本树文件：读取旧明文后立即用 DPAPI 回写，避免连接密码继续明文落盘。
        if _transform_secrets(data, protect=True) != raw_data:
            _save_tree(data)
        # ★ 迁移旧 saved_queries 到文件系统（仅首次加载时执行）
        if data.get("saved_queries"):
            _migrate_old_queries(tree=data)
            return _load_tree()
        _tree_cache_data, _tree_cache_mtime = data, cur_mtime
        return data
    except json.JSONDecodeError as e:
        print(f"[tree] _load_tree JSON解析失败: {e}")
        return {"folders": [], "connections": {}, "saved_queries": []}
    except FileNotFoundError:
        print(f"[tree] _load_tree: 文件不存在 TREE_FILE={TREE_FILE}")
        return {"folders": [], "connections": {}, "saved_queries": []}
    except Exception as e:
        print(f"[tree] _load_tree 异常: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return {"folders": [], "connections": {}, "saved_queries": []}

def _save_tree(data):
    try:
        # 数据校验
        if not _validate_tree(data):
            print("[tree] _save_tree: 数据校验失败，拒绝保存")
            return False
        # 【防覆盖】如果新数据是空壳，但当前文件有实际内容 → 拒绝（防止误覆盖）
        if _is_empty_shell(data) and os.path.exists(TREE_FILE):
            try:
                with open(TREE_FILE, "r", encoding="utf-8") as f:
                    current = json.load(f)
                if _tree_has_content(current):
                    print("[tree] _save_tree: 拒绝用空壳数据覆盖现有 %d 个连接" 
                          % len(current.get("connections", {})))
                    return False
            except Exception:
                pass  # 当前文件读不了就算了，让写入继续
        # 原子写入：先写临时文件，再替换（防止写入中途崩溃损坏数据）
        tmp_file = TREE_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(_transform_secrets(data, protect=True), f, ensure_ascii=False, indent=2)
        # Windows 需要先删除目标文件再重命名
        if os.path.exists(TREE_FILE):
            os.replace(tmp_file, TREE_FILE)
        else:
            os.rename(tmp_file, TREE_FILE)
        print(f"[tree] _save_tree: 保存成功，connections={len(data.get('connections',{}))}, queries={len(data.get('saved_queries',[]))}")
        # ★ 保存成功后刷新缓存
        global _tree_cache_data, _tree_cache_mtime
        _tree_cache_data = data
        _tree_cache_mtime = os.path.getmtime(TREE_FILE)
        return True
    except Exception as e:
        print(f"[tree] _save_tree 异常: {e}")
        import traceback
        traceback.print_exc()
        # 清理临时文件
        try:
            if os.path.exists(TREE_FILE + ".tmp"):
                os.remove(TREE_FILE + ".tmp")
        except Exception:
            pass
        return False


@eel.expose
def ping():
    """诊断用：确认 Eel WebSocket 通信正常"""
    return "pong"

@eel.expose
def tree_diag():
    """返回树文件诊断信息（打包 exe 无控制台时调试用）"""
    info = {
        "frozen": getattr(sys, 'frozen', False),
        "tree_file": TREE_FILE,
        "tree_file_exists": os.path.exists(TREE_FILE),
        "tree_file_size": os.path.getsize(TREE_FILE) if os.path.exists(TREE_FILE) else -1,
    }
    if info["tree_file_exists"] and info["tree_file_size"] > 0:
        try:
            with open(TREE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            info["connections_count"] = len(data.get("connections", {}))
            info["folders_count"] = len(data.get("folders", []))
            q_count = 0
            qdir = QUERIES_DIR
            if os.path.isdir(qdir):
                for root, dirs, files in os.walk(qdir):
                    q_count += sum(1 for f in files if f.endswith('.sql'))
            info["queries_count"] = q_count
            info["valid"] = _validate_tree(data)
            info["has_content"] = _tree_has_content(data)
        except Exception as e:
            info["parse_error"] = f"{type(e).__name__}: {e}"
    return info

@eel.expose
def tree_load():
    data = _load_tree()
    return data
@eel.expose
def tree_save(data):
    with _tree_lock:
        _save_tree(data)
    return {"ok": True, "msg": "保存成功"}

# ==================== 用户设置 ====================
def _load_settings():
    """加载用户设置，不存在则返回默认值"""
    for settings_path in (SETTINGS_FILE, LEGACY_SETTINGS_FILE):
        try:
            if not os.path.exists(settings_path):
                continue
            with open(settings_path, "r", encoding="utf-8") as f:
                raw_data = json.load(f)
            if not isinstance(raw_data, dict):
                continue
            data = _transform_secrets(raw_data, protect=False)
            if settings_path != SETTINGS_FILE or _has_plaintext_secrets(raw_data):
                if _save_settings_disk(data) and settings_path != SETTINGS_FILE:
                    try:
                        os.remove(settings_path)
                    except OSError:
                        pass
            return data
        except Exception:
            continue
    return {"theme": "dark"}

def _save_settings_disk(data):
    """保存用户设置到磁盘"""
    tmp_file = SETTINGS_FILE + ".tmp"
    try:
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(_transform_secrets(data, protect=True), f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, SETTINGS_FILE)
        return True
    except Exception as e:
        print(f"[settings] 保存失败: {e}")
        try:
            if os.path.exists(tmp_file):
                os.remove(tmp_file)
        except OSError:
            pass
        return False

@eel.expose
def settings_get():
    """获取当前用户设置"""
    return _load_settings()

@eel.expose
def settings_save(data):
    """保存用户设置"""
    try:
        if not isinstance(data, dict):
            return {"ok": False, "msg": "数据格式错误"}
        if _save_settings_disk(data):
            return {"ok": True, "msg": "保存成功"}
        return {"ok": False, "msg": "写入文件失败"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}

@eel.expose
def settings_get_paths():
    """返回各配置文件的路径"""
    # 操作日志按日期写入 logs/db_operations，取当前 logger 实际绑定的文件，
    # 避免引用已经不存在的旧版 _LOG_FILE 导致整个路径接口失败。
    log_file = os.path.join(_LOG_OP_DIR, f"{datetime.now().strftime('%Y-%m-%d')}_op.log")
    try:
        handlers = getattr(_db_op_logger, "handlers", [])
        if handlers and getattr(handlers[0], "baseFilename", ""):
            log_file = handlers[0].baseFilename
    except Exception:
        pass
    return {
        "tree_file": TREE_FILE,
        "profiles_file": PROFILES_FILE,
        "log_file": log_file,
        "settings_file": SETTINGS_FILE
    }

@eel.expose
def tree_check_integrity():
    """检查 mqdb_tree.json 完整性，返回诊断信息"""
    result = {"file_exists": os.path.exists(TREE_FILE), "issues": []}
    try:
        if result["file_exists"]:
            result["file_size"] = os.path.getsize(TREE_FILE)
            data = _load_tree()
            result["connections"] = len(data.get("connections", {}))
            result["folders"] = len(data.get("folders", []))
            q_count = 0
            if os.path.isdir(QUERIES_DIR):
                for root, dirs, files in os.walk(QUERIES_DIR):
                    q_count += sum(1 for f in files if f.endswith('.sql'))
            result["queries"] = q_count
            if _is_empty_shell(data) and result["file_size"] > 0:
                result["issues"].append("空壳数据：文件存在但无连接/文件夹/查询")
            if not _validate_tree(data):
                result["issues"].append("数据结构校验失败")
        else:
            result["file_size"] = 0
            result["issues"].append("mqdb_tree.json 不存在")
        result["ok"] = len(result["issues"]) == 0
    except Exception as e:
        result["issues"].append(str(e))
        result["ok"] = False
    return result

@eel.expose
def tree_add_folder(parent_id, name):
    with _tree_lock:
        tree = _load_tree()
        fid = f"f_{int(time.time() * 1000)}"
        tree.setdefault("folders", []).append({"id": fid, "name": name, "parent": parent_id or ""})
        _save_tree(tree)
        return {"ok": True, "id": fid}

@eel.expose
def tree_delete_folder(fid):
    with _tree_lock:
        tree = _load_tree()
        kids = [f["id"] for f in tree.get("folders", []) if f.get("parent") == fid]
        for k in kids: tree_delete_folder(k)
        tree["folders"] = [f for f in tree.get("folders", []) if f["id"] != fid]
        to_del = [k for k, v in tree.get("connections", {}).items() if v.get("parent") == fid]
        for k in to_del: del tree["connections"][k]
        _save_tree(tree)
        return True

@eel.expose
def tree_rename_folder(fid, name):
    with _tree_lock:
        tree = _load_tree()
        for f in tree.get("folders", []):
            if f["id"] == fid: f["name"] = name
        _save_tree(tree)
        return True

@eel.expose
def tree_add_connection(parent_id, conn_data):
    with _tree_lock:
        tree = _load_tree()
        cid = f"c_{int(time.time() * 1000)}"
        conn_data["id"] = cid; conn_data["parent"] = parent_id or ""
        tree.setdefault("connections", {})[cid] = conn_data
        _save_tree(tree)
        return {"ok": True, "id": cid}

@eel.expose
def tree_update_connection(cid, conn_data):
    with _tree_lock:
        tree = _load_tree()
        if cid in tree.get("connections", {}):
            conn_data["id"] = cid
            conn_data["parent"] = tree["connections"][cid].get("parent", "")
            tree["connections"][cid] = conn_data
            _save_tree(tree)
        return True

@eel.expose
def tree_delete_connection(cid):
    with _tree_lock:
        tree = _load_tree()
        tree.get("connections", {}).pop(cid, None)
        _save_tree(tree)
        return True

@eel.expose
def tree_move_connection(cid, new_parent_id):
    """将连接移动到指定文件夹下（new_parent_id 为空则移到根）"""
    with _tree_lock:
        tree = _load_tree()
        if cid not in tree.get("connections", {}):
            return {"ok": False, "msg": "连接不存在"}
        tree["connections"][cid]["parent"] = new_parent_id or ""
        _save_tree(tree)
        return {"ok": True}

_DRIVER_HINTS = {
    'mysql':      'pymysql',
    'ob-mysql':   'pymysql',
    'postgresql': 'psycopg2-binary',
    'oracle':     'oracledb',
    'mssql':      'pymssql',
}

def _friendly_error(err, db_type='mysql'):
    """将常见依赖错误转为带安装提示的友好信息"""
    msg = str(err)
    hint = _DRIVER_HINTS.get(db_type, '')
    if "No module named" in msg or "ModuleNotFoundError" in msg:
        return f"缺少驱动 [{hint}]: {msg}\n请安装: pip install {hint}" if hint else msg
    # ★ oracledb thin 模式缺少 cryptography 依赖 (DPY-3016)
    if 'DPY-3016' in msg or ('cryptography' in msg and 'cannot be imported' in msg):
        return f"Oracle 驱动缺少加密库: {msg}\n\n请确保已安装兼容版本:\n  pip install cryptography==41.0.7"
    # ★ ORA-01109: PDB 未打开 — 提供具体修复步骤
    if 'ORA-01109' in msg or 'database not open' in msg.lower():
        return (
            f"Oracle PDB 数据库未打开: {msg}\n\n"
            "🔧 修复步骤（在 Oracle 服务器上执行）:\n"
            "  1. sqlplus / as sysdba\n"
            "  2. ALTER PLUGGABLE DATABASE ALL OPEN;\n"
            "  3. ALTER PLUGGABLE DATABASE ALL SAVE STATE;  (下次重启自动打开)\n"
            "或单开指定 PDB: ALTER PLUGGABLE DATABASE orclpdb OPEN;"
        )
    # ★ 通用依赖提示（根据 db_type 附加 pip install 命令）
    if "No module named" in msg or "ModuleNotFoundError" in msg:
        return f"缺少驱动 [{hint}]: {msg}" if hint else msg
    return msg

@eel.expose
def debug_python_info():
    """诊断：返回 Python 环境信息"""
    import sys, importlib
    info = {"executable": sys.executable, "version": sys.version}
    for mod in ["pymysql","psycopg2","oracledb","pymssql","sqlalchemy","eel"]:
        try:
            m = importlib.import_module(mod)
            info[mod] = getattr(m, "__version__", "installed")
        except Exception as e:
            info[mod] = f"NOT FOUND: {e}"
    return info

@eel.expose
def tree_test_conn(conn_data):
    # ★ 兼容两种格式：{user,host,port,pwd} 和 {src_user,src_host,src_port,src_pwd}
    # 关键：检查 host 字段是否存在（不是 user），因为 host 是必填的
    if 'host' not in conn_data or not conn_data.get('host'):
        # 需要从 src_ 前缀字段补全
        conn_data = {
            'user': conn_data.get('user') or conn_data.get('src_user', ''),
            'pwd':  conn_data.get('pwd') or conn_data.get('src_pwd', ''),
            'host': conn_data.get('host') or conn_data.get('src_host', ''),
            'port': conn_data.get('port') or conn_data.get('src_port', '3306'),
            'db':   conn_data.get('db') or conn_data.get('src_db', ''),
            'db_type': conn_data.get('db_type', 'mysql'),
            'ora_mode': conn_data.get('ora_mode') or conn_data.get('src_ora_mode', 'service_name'),
        }
    db_type = conn_data.get("db_type", "mysql")
    try:
        if db_type == 'redis':
            def _redis_test():
                try:
                    r = _get_redis(conn_data)
                    r.ping()
                    return {"ok": True, "msg": "连接成功"}
                except Exception as e:
                    return {"ok": False, "msg": _friendly_error(e, db_type)}
            return _with_db_timeout(_redis_test, timeout=10)

        url = _conn_url(conn_data)
        def _db_test():
            engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
            try:
                with engine.connect() as c:
                    if db_type == 'oracle':
                        c.execute(text("SELECT 1 FROM DUAL"))
                    else:
                        c.execute(text("SELECT 1"))
                return {"ok": True, "msg": "连接成功"}
            except Exception as e:
                return {"ok": False, "msg": _friendly_error(e, db_type)}
            finally:
                engine.dispose()
        return _with_db_timeout(_db_test, timeout=15)

    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}

def _normalize_conn_data(data: dict) -> dict:
    """统一规范化连接参数：兼容 src_ 前缀格式，校验必填字段"""
    cdata = dict(data)
    # 兼容两种格式：{user,host,...} 和 {src_user,src_host,...}
    if "user" not in cdata:
        cdata = {
            "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
            "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
            "db": cdata.get("src_db", ""), "db_type": cdata.get("db_type", "mysql")
        }
    # 校验必填字段
    if not cdata.get("host"):
        raise ValueError("连接参数不完整：缺少主机地址（host）")
    if not cdata.get("user"):
        raise ValueError("连接参数不完整：缺少用户名（user）")
    return cdata


def _conn_url(conn_data):
    # ★ 用 .get() 提供默认值，避免 KeyError
    u = quote_plus(conn_data.get("user", ""))
    p = quote_plus(conn_data.get("pwd", ""))
    h = conn_data.get("host", "")
    port = conn_data.get("port", "3306")
    db = conn_data.get("db", "")
    db_type = conn_data.get("db_type", "mysql")
    if db_type in ('mysql', 'ob-mysql'):
        base = f"mysql+mysqldb://{u}:{p}@{h}:{port}"
        return f"{base}/{db}?charset=utf8mb4" if db else f"{base}/?charset=utf8mb4"
    elif db_type == 'postgresql':
        base = f"postgresql+psycopg2://{u}:{p}@{h}:{port}"
        return f"{base}/{db}" if db else base
    elif db_type == 'oracle':
        ora_mode = conn_data.get("ora_mode", "service_name")
        base = f"oracle+oracledb://{u}:{p}@{h}:{port}"
        if db:
            if ora_mode == "sid":
                return f"{base}/?sid={db}"
            else:
                # ★ 显式用 service_name 参数，避免 oracledb thin 模式把 Easy Connect 路径当成 SID
                return f"{base}/?service_name={db}"
        return base
    elif db_type == 'mssql':
        base = f"mssql+pymssql://{u}:{p}@{h}:{port}"
        return f"{base}/{db}" if db else base
    # fallback mysql
    base = f"mysql+mysqldb://{u}:{p}@{h}:{port}"
    return f"{base}/{db}?charset=utf8mb4" if db else f"{base}/?charset=utf8mb4"

@eel.expose
def db_explore_get_databases(conn_data):
    db_type = conn_data.get("db_type", "mysql")
    try:
        print(f"[get_databases] db_type={db_type}, user={conn_data.get('user','')}, host={conn_data.get('host','')}, db={conn_data.get('db','')}")

        def _get_dbs():
            engine = create_engine(_conn_url(conn_data), connect_args=_connect_args(db_type, timeout=10))
            try:
                with engine.connect() as c:
                    if db_type == 'oracle':
                        # ★ 只显示当前登录用户自己的 schema（对齐 Navicat/PL/SQL Developer 行为）
                        rows = c.execute(text("SELECT USERNAME FROM USER_USERS")).fetchall()
                        databases = [r[0] for r in rows]
                    elif db_type in ('mysql', 'ob-mysql'):
                        rows = c.execute(text("SHOW DATABASES")).fetchall()
                        databases = [r[0] for r in rows if r[0] not in ("information_schema","mysql","performance_schema","sys","oceanbase")]
                    elif db_type == 'postgresql':
                        rows = c.execute(text("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname")).fetchall()
                        databases = [r[0] for r in rows]
                    elif db_type == 'mssql':
                        rows = c.execute(text("SELECT name FROM sys.databases WHERE database_id>4 ORDER BY name")).fetchall()
                        databases = [r[0] for r in rows]
                    else:
                        rows = c.execute(text("SHOW DATABASES")).fetchall()
                        databases = [r[0] for r in rows if r[0] not in ("information_schema","mysql","performance_schema","sys","oceanbase")]
                return {"ok": True, "databases": databases}
            except Exception as e:
                return {"ok": False, "msg": _friendly_error(e, db_type)}
            finally:
                engine.dispose()
        return _with_db_timeout(_get_dbs, timeout=15)

    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}

@eel.expose
def db_explore_get_schemas(conn_data, database):
    """PostgreSQL: 获取数据库下的 schema 列表"""
    try:
        cdata = dict(conn_data)
        if cdata.get("db_type") != 'oracle':
            cdata["db"] = database

        def _get_schemas():
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
            try:
                with engine.connect() as c:
                    rows = c.execute(text("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name")).fetchall()
                return {"ok": True, "schemas": [r[0] for r in rows]}
            except Exception as e:
                return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}
            finally:
                engine.dispose()
        return _with_db_timeout(_get_schemas, timeout=15)

    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

def _format_size(size_bytes):
    if size_bytes is None: return ""
    try: s = int(size_bytes)
    except: return ""
    if s >= 1073741824: return f"{s/1073741824:.1f} GB"
    if s >= 1048576: return f"{s/1048576:.0f} MB"
    if s >= 1024: return f"{s/1024:.0f} KB"
    return f"{s} B"

def _db_explore_get_tables_sync(conn_data, database, schema=''):
    """同步获取数据库表列表（内部调用：导出向导等，避免拿到异步包装结构）"""
    cdata = dict(conn_data)
    if cdata.get("db_type") != 'oracle':
        cdata["db"] = database
    db_type = cdata.get("db_type", "mysql")
    try:
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        try:
            with engine.connect() as c:
                if db_type == 'oracle':
                    # ★ 用 USER_SEGMENTS 替代 ALL_SEGMENTS（ZX 等普通用户无 ALL_SEGMENTS 权限会导致 ORA-00942）
                    rows = c.execute(text(
                        "SELECT t.TABLE_NAME, t.NUM_ROWS, "
                        "COALESCE((SELECT SUM(s.BYTES) FROM USER_SEGMENTS s WHERE s.SEGMENT_NAME=t.TABLE_NAME),0), "
                        "COALESCE((SELECT c.COMMENTS FROM USER_TAB_COMMENTS c WHERE c.TABLE_NAME=t.TABLE_NAME AND c.TABLE_TYPE='TABLE'),'') "
                        "FROM USER_TABLES t ORDER BY t.TABLE_NAME"
                    )).fetchall()
                    tables = [{"name":r[0],"rows":r[1] or 0,"data_size":_format_size(r[2]) if r[2] else "","update_time":"","comment":r[3] or ""} for r in rows]
                elif db_type in ('mysql', 'ob-mysql'):
                    rows = c.execute(text("SELECT TABLE_NAME,TABLE_ROWS,DATA_LENGTH,UPDATE_TIME,TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"), {"db":database}).fetchall()
                    tables = [{"name":r[0],"rows":r[1] or 0,"data_size":_format_size(r[2]),"update_time":str(r[3]) if r[3] else "","comment":r[4] or ""} for r in rows]
                elif db_type == 'postgresql':
                    sch = schema if schema else 'public'
                    rows = c.execute(text(
                        "SELECT c.relname, c.reltuples::bigint, pg_total_relation_size(c.oid), "
                        "COALESCE(pg_catalog.obj_description(c.oid,'pg_class'),'') "
                        "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                        "WHERE c.relkind='r' AND n.nspname=:sch ORDER BY c.relname"
                    ), {"sch":sch}).fetchall()
                    tables = [{"name":r[0],"rows":r[1] or 0,"data_size":_format_size(r[2]),"update_time":"","comment":r[3] or ""} for r in rows]
                elif db_type == 'mssql':
                    rows = c.execute(text(
                        "SELECT t.NAME, p.rows, SUM(ISNULL(a.used_pages,0))*8192, "
                        "CAST(ISNULL(ep.value,'') AS NVARCHAR(4000)) "
                        "FROM sys.tables t "
                        "LEFT JOIN sys.partitions p ON t.object_id=p.object_id AND p.index_id IN (0,1) "
                        "LEFT JOIN sys.allocation_units a ON p.partition_id=a.container_id "
                        "LEFT JOIN sys.extended_properties ep ON ep.major_id=t.object_id AND ep.minor_id=0 AND ep.name='MS_Description' "
                        "GROUP BY t.NAME, t.object_id, p.rows, CAST(ep.value AS NVARCHAR(4000)) "
                        "ORDER BY t.NAME"
                    )).fetchall()
                    tables = [{"name":r[0],"rows":r[1] or 0,"data_size":_format_size(r[2]) if r[2] else "","update_time":"","comment":r[3] or ""} for r in rows]
                else:
                    rows = c.execute(text("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"), {"db":database}).fetchall()
                    tables = [{"name":r[0],"rows":"","data_size":"","update_time":"","comment":""} for r in rows]
            return {"ok": True, "tables": tables}
        except Exception as e:
            return {"ok": False, "msg": _friendly_error(e, db_type)}
        finally:
            engine.dispose()
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}


@eel.expose
def db_explore_get_tables(conn_data, database, schema=''):
    """获取数据库中的表列表（异步非阻塞：返回 job_id，前端轮询 poll_query_result）"""
    cdata = dict(conn_data)
    if cdata.get("db_type") != 'oracle':
        cdata["db"] = database
    return _with_db_timeout(_db_explore_get_tables_sync, cdata, database, schema, timeout=15)


# ==================== Redis 操作 ====================
def _get_redis(conn_data, db=None):
    import redis as rds
    target_db = db if db is not None else int(conn_data.get('db','0') or '0')
    try:
        return rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                         password=conn_data.get('pwd') or None,
                         db=target_db,
                         socket_connect_timeout=5, socket_timeout=30,
                         decode_responses=False,
                         protocol=2)
    except TypeError:
        return rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                         password=conn_data.get('pwd') or None,
                         db=target_db,
                         socket_connect_timeout=5, socket_timeout=30,
                         decode_responses=False)


def _smart_decode(raw):
    """智能解码 Redis 返回的 bytes，依次尝试 UTF-8 / GBK / Latin-1"""
    if isinstance(raw, str):
        return raw
    if not isinstance(raw, bytes):
        return str(raw)
    for enc in ('utf-8', 'gbk', 'gb2312', 'gb18030', 'latin-1'):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', errors='replace')


def _decode_all(obj):
    """递归解码 Redis 返回结果中所有 bytes（支持 dict/list/tuple/set）"""
    if isinstance(obj, dict):
        return {_smart_decode(k): _decode_all(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_decode_all(item) for item in obj]
    elif isinstance(obj, set):
        return {_smart_decode(item) for item in obj}
    elif isinstance(obj, (bytes, bytearray)):
        return _smart_decode(obj)
    return obj


@eel.expose
def redis_get_databases(conn_data):
    """获取 Redis 的所有数据库列表及键数量"""
    import redis as rds
    try:
        r = rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                       password=conn_data.get('pwd') or None,
                       socket_connect_timeout=5, socket_timeout=10,
                       decode_responses=True, encoding='utf-8', encoding_errors='replace')
        # 获取数据库数量配置
        try:
            db_count = int(r.config_get('databases').get('databases', 16))
        except Exception:
            db_count = 16
        db_count = min(db_count, 16)  # 最多扫描16个

        databases = []
        for db_idx in range(db_count):
            key_count = 0
            try:
                r2 = rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                                password=conn_data.get('pwd') or None,
                                db=db_idx,
                                socket_connect_timeout=3, socket_timeout=5,
                                decode_responses=True, encoding='utf-8', encoding_errors='replace',
                                protocol=2)
                key_count = r2.dbsize()
            except TypeError:
                try:
                    r2 = rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                                    password=conn_data.get('pwd') or None,
                                    db=db_idx,
                                    socket_connect_timeout=3, socket_timeout=5,
                                    decode_responses=True, encoding='utf-8', encoding_errors='replace')
                    key_count = r2.dbsize()
                except Exception:
                    pass
            except Exception:
                # 如果 dbsize 失败，尝试通过 SELECT + DBSIZE 在主连接上查询
                try:
                    r.execute_command('SELECT', db_idx)
                    key_count = r.dbsize()
                except Exception:
                    pass
            databases.append({"db": db_idx, "keys": key_count})

        return {"ok": True, "databases": databases}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_get_keys(conn_data, pattern='*', limit=100, db=None):
    """获取 Redis 的 key 列表，按分组组织，使用 SCAN 避免阻塞"""
    # 日志记录辅助函数（同时输出到控制台和文件）
    def _log_redis(msg):
        # 打印到控制台（exe运行时不可见，除非console=True）
        print(f"[Redis] {msg}")
        # 强制写入 exe/脚本目录下的 redis_debug.log 文件
        try:
            import os, sys, time

            # 确定目标目录
            if getattr(sys, 'frozen', False):
                # 打包exe环境：exe所在目录
                base_dir = os.path.dirname(sys.executable)
                print(f"[Redis] EXE环境，基目录: {base_dir}")
            else:
                # Python脚本环境：脚本所在目录
                base_dir = os.path.dirname(os.path.abspath(__file__))
                print(f"[Redis] Python环境，脚本目录: {base_dir}")

            log_file = os.path.join(base_dir, "redis_debug.log")
            print(f"[Redis] 日志文件目标路径: {log_file}")

            # 确保目录存在
            os.makedirs(base_dir, exist_ok=True)

            # 写入日志（追加模式）
            with open(log_file, "a", encoding="utf-8") as f:
                timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                f.write(f"{timestamp} [Redis] {msg}\n")
                f.flush()  # 立即刷新，确保数据写入磁盘

            # 存储日志路径到全局变量
            if '__redis_log_path' not in globals():
                globals()['__redis_log_path'] = log_file
                print(f"[Redis] 日志文件已创建: {log_file}")

        except Exception as e:
            print(f"[Redis] 严重错误: 无法写入日志文件 {log_file}: {e}")
            # 尝试备用方案：写入临时目录
            try:
                import tempfile
                temp_log = os.path.join(tempfile.gettempdir(), "redis_debug.log")
                with open(temp_log, "a", encoding="utf-8") as f:
                    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                    f.write(f"{timestamp} [Redis] {msg}\n")
                print(f"[Redis] 已写入临时文件: {temp_log}")
            except Exception as e2:
                print(f"[Redis] 备用日志写入也失败: {e2}")

    # 首次调用时显示日志文件位置
    if not hasattr(_log_redis, '_initialized'):
        _log_redis._initialized = True
        if '__redis_log_path' in globals():
            print(f"[Redis] 日志文件位置: {globals()['__redis_log_path']}")

    try:
        import time
        start_time = time.time()
        _log_redis(f"开始获取 keys，pattern={pattern}, limit={limit}, db={db}")
        r = _get_redis(conn_data, db=db)
        # 测试连接是否真的可用
        try:
            r.ping()
            _log_redis("连接测试成功")
        except Exception as ping_err:
            _log_redis(f"连接测试失败: {ping_err}")
            return {"ok": False, "msg": f"Redis连接失败: {ping_err}"}

        keys = []
        cursor = 0
        max_iterations = 10  # 最多迭代10次，防止无限循环
        iteration = 0
        max_scantime = 8.0  # SCAN操作最多8秒，超时则返回已获取的keys

        # 使用 SCAN 命令增量获取 keys，避免 KEYS 命令阻塞
        _log_redis("开始 SCAN 迭代")
        while iteration < max_iterations:
            iteration += 1
            try:
                cursor, batch = r.scan(cursor=cursor, match=pattern, count=300)  # 每次扫描300个key
                keys.extend(batch)
                _log_redis(f"迭代 {iteration}: cursor={cursor}, 本次获取 {len(batch)} keys, 累计 {len(keys)} keys")

                # 达到限制或扫描完成
                if len(keys) >= limit or cursor == 0:
                    if cursor == 0:
                        _log_redis("SCAN 完成，cursor=0")
                    else:
                        _log_redis(f"达到限制 {limit} keys")
                    break

                # 检查是否超时
                if time.time() - start_time > max_scantime:
                    _log_redis(f"SCAN 超时（{max_scantime}秒），返回已获取的keys")
                    break

            except Exception as scan_err:
                _log_redis(f"SCAN 出错: {scan_err}")
                # 如果扫描出错，返回已获取的keys
                break

        scan_time = time.time() - start_time
        _log_redis(f"SCAN 完成，耗时 {scan_time:.2f} 秒，共获取 {len(keys)} keys")

        # 如果实际获取的键超过限制，截断
        has_more = len(keys) > limit
        if has_more:
            keys = keys[:limit]

        # 所有 key 统一放入一个"键"文件夹，不做按前缀分组
        result = [{"group": "键", "keys": [_smart_decode(k) for k in keys]}]

        # 获取总键数（可能较慢，但提供近似值）
        try:
            total = r.dbsize()
            _log_redis(f"dbsize() 成功，总键数: {total}")
        except Exception as dbsize_err:
            _log_redis(f"dbsize() 失败: {dbsize_err}")
            total = len(keys)  # 失败时使用当前获取的数量作为近似值

        total_time = time.time() - start_time
        _log_redis(f"函数总耗时 {total_time:.2f} 秒，返回 {len(result)} 个分组")
        return_result = {"ok": True, "groups": result, "total": total}
        _log_redis(f"返回数据结构: ok={return_result['ok']}, groups数量={len(result)}, total={total}")
        # 调试：打印返回值摘要
        print(f"[DEBUG] Redis函数准备返回: ok=True, total={total}, groups={len(result)}")

        # 详细调试：检查返回值是否可序列化
        try:
            import json
            test_json = json.dumps(return_result)
            _log_redis(f"返回值JSON序列化测试通过，长度: {len(test_json)} 字符")
        except Exception as json_err:
            _log_redis(f"返回值JSON序列化失败: {json_err}")
            # 尝试诊断哪个字段有问题
            for key, value in return_result.items():
                try:
                    json.dumps({key: value})
                except Exception as field_err:
                    _log_redis(f"字段 '{key}' 无法序列化: {field_err}, 类型: {type(value)}")
                    if key == 'groups':
                        for i, group in enumerate(value):
                            try:
                                json.dumps(group)
                            except Exception as group_err:
                                _log_redis(f"分组 {i} ('{group.get('group', '未知')}') 无法序列化: {group_err}")
                                if 'keys' in group:
                                    for j, k in enumerate(group['keys'][:3]):  # 只检查前3个key
                                        try:
                                            json.dumps(k)
                                        except Exception as key_err:
                                            _log_redis(f"key {j} ('{k[:50]}...') 无法序列化: {key_err}, 类型: {type(k)}")

        # 记录返回值摘要到日志
        _log_redis(f"准备返回: total={total}, groups={len(result)}, keys示例={sum(len(g['keys']) for g in result)}")

        # Eel调试信息
        print(f"[EEL-DEBUG] 返回值类型: {type(return_result)}")
        print(f"[EEL-DEBUG] 返回值键: {list(return_result.keys())}")
        print(f"[EEL-DEBUG] groups数量: {len(return_result.get('groups', []))}")

        return return_result
    except Exception as e:
        _log_redis(f"异常: {e}")
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_get_key_info(conn_data, key, db=None):
    """获取单个 key 的详细信息（类型、TTL、值）"""
    try:
        r = _get_redis(conn_data, db=db)
        ktype = _smart_decode(r.type(key))  # decode_responses=False 返回 bytes，需解码
        ttl = r.ttl(key)
        info = {"key": key, "type": ktype, "ttl": ttl, "ttl_str": _format_ttl(ttl)}
        if ktype == 'string':
            info["value"] = _smart_decode(r.get(key))
        elif ktype == 'hash':
            info["value"] = {_smart_decode(k): _smart_decode(v) for k, v in r.hgetall(key).items()}
        elif ktype == 'list':
            vals = r.lrange(key, 0, 99)
            info["value"] = [_smart_decode(v) for v in vals]
            info["length"] = r.llen(key)
        elif ktype == 'set':
            members = r.smembers(key)
            info["value"] = [_smart_decode(m) for m in list(members)[:100]]
            info["length"] = r.scard(key)
        elif ktype == 'zset':
            items = r.zrange(key, 0, 99, withscores=True)
            info["value"] = [(_smart_decode(it[0]), it[1]) for it in items]
            info["length"] = r.zcard(key)
        return {"ok": True, "info": info}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_get_keys_meta(conn_data, keys, db=None):
    """批量获取 key 的元数据（类型、TTL、大小），使用 pipeline 优化"""
    try:
        r = _get_redis(conn_data, db=db)
        if not keys:
            return {"ok": True, "meta": {}}
        # 使用 pipeline 批量获取
        pipe = r.pipeline(transaction=False)
        for k in keys:
            pipe.type(k)
            pipe.ttl(k)
        results = pipe.execute()
        meta = {}
        for i, k in enumerate(keys):
            idx = i * 2
            ktype = _smart_decode(results[idx])
            ttl_val = results[idx + 1]
            size_str = ''
            # 根据类型获取大小
            try:
                if ktype == 'string':
                    size_str = r.strlen(k)
                elif ktype == 'hash':
                    size_str = r.hlen(k)
                elif ktype == 'list':
                    size_str = r.llen(k)
                elif ktype == 'set':
                    size_str = r.scard(k)
                elif ktype == 'zset':
                    size_str = r.zcard(k)
            except:
                pass
            # 格式化 TTL 显示
            if ttl_val < 0:
                ttl_str = 'No TTL'
            elif ttl_val == 0:
                ttl_str = '已过期'
            else:
                ttl_str = _format_ttl(ttl_val)
            meta[k] = {
                'type': ktype,
                'ttl': ttl_val,
                'ttl_str': ttl_str,
                'size': size_str,
                'size_str': format_size(size_str) if isinstance(size_str, int) else str(size_str),
            }
        return {"ok": True, "meta": meta}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _redis_check_type(r, key, expected_type, cmd_name, alt_cmd):
    """检查 Redis key 类型，如果不匹配返回友好错误提示"""
    try:
        ktype = r.type(key)
        if isinstance(ktype, bytes):
            ktype = ktype.decode()
        if ktype and ktype != 'none' and ktype != expected_type:
            return {"ok": False, "msg": f"Key 类型为 {ktype}，不能使用 {cmd_name} 命令。请使用: {alt_cmd}"}
    except Exception:
        pass  # 类型检查失败不阻塞，让原命令报错
    return None


@eel.expose
def redis_execute(conn_data, command):
    """执行 Redis 命令并返回结果"""
    try:
        r = _get_redis(conn_data)
        parts = command.strip().split()
        if not parts:
            return {"ok": False, "msg": "空命令"}
        cmd = parts[0].upper()
        args = parts[1:]
        if cmd == 'GET':
            if args:
                key = args[0]
                chk = _redis_check_type(r, key, 'string', 'GET',
                    f'HGETALL {key} / LRANGE {key} 0 -1 / SMEMBERS {key} / ZRANGE {key} 0 -1 WITHSCORES')
                if chk: return chk
                result = r.get(key)
            else:
                result = None
        elif cmd == 'SET':
            r.set(*args)
            result = "OK"
        elif cmd == 'DEL':
            result = r.delete(*args)
        elif cmd == 'KEYS':
            result = r.keys(args[0] if args else '*')
        elif cmd == 'TYPE':
            result = r.type(args[0]) if args else None
        elif cmd == 'TTL':
            result = r.ttl(args[0]) if args else None
        elif cmd == 'EXISTS':
            result = r.exists(*args)
        elif cmd == 'DBSIZE':
            result = r.dbsize()
        elif cmd == 'FLUSHDB':
            result = "危险操作，请在 redis-cli 中手动执行"
        elif cmd == 'SCAN':
            cursor = int(args[0]) if args else 0
            match = args[1] if len(args) > 1 else '*'
            result = list(r.scan(cursor=cursor, match=match, count=50))
        elif cmd == 'PING':
            result = r.ping()
        elif cmd == 'INFO':
            section = args[0] if args else 'server'
            result = r.info(section)
        elif cmd == 'HGETALL':
            if args:
                chk = _redis_check_type(r, args[0], 'hash', 'HGETALL',
                    f'GET {args[0]} / LRANGE {args[0]} 0 -1 / SMEMBERS {args[0]} / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
                result = r.hgetall(args[0])
            else:
                result = {}
        elif cmd == 'HGET':
            if len(args) >= 2:
                chk = _redis_check_type(r, args[0], 'hash', 'HGET',
                    f'GET {args[0]} / LRANGE {args[0]} 0 -1 / SMEMBERS {args[0]} / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
                result = r.hget(args[0], args[1])
            else:
                result = None
        elif cmd == 'LRANGE':
            if args:
                chk = _redis_check_type(r, args[0], 'list', 'LRANGE',
                    f'GET {args[0]} / HGETALL {args[0]} / SMEMBERS {args[0]} / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
            key = args[0] if args else ''
            start = int(args[1]) if len(args) > 1 else 0
            end = int(args[2]) if len(args) > 2 else -1
            result = r.lrange(key, start, end)
        elif cmd == 'SMEMBERS':
            if args:
                chk = _redis_check_type(r, args[0], 'set', 'SMEMBERS',
                    f'GET {args[0]} / HGETALL {args[0]} / LRANGE {args[0]} 0 -1 / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
            result = list(r.smembers(args[0])) if args else []
        elif cmd == 'ZRANGE':
            if args:
                chk = _redis_check_type(r, args[0], 'zset', 'ZRANGE',
                    f'GET {args[0]} / HGETALL {args[0]} / LRANGE {args[0]} 0 -1 / SMEMBERS {args[0]}')
                if chk: return chk
            key = args[0] if args else ''
            start = int(args[1]) if len(args) > 1 else 0
            end = int(args[2]) if len(args) > 2 else -1
            result = r.zrange(key, start, end, withscores=True)
        elif cmd == 'LPUSH':
            r.lpush(*args)
            result = "OK"
        elif cmd == 'RPUSH':
            r.rpush(*args)
            result = "OK"
        elif cmd == 'SADD':
            r.sadd(*args)
            result = "OK"
        elif cmd == 'ZADD':
            r.zadd(*args)
            result = "OK"
        else:
            # 通用执行（注意安全）
            result = r.execute_command(cmd, *args)
        return {"ok": True, "result": _decode_all(result)}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_delete_key(conn_data, key, db=None):
    """删除 Redis key"""
    try:
        r = _get_redis(conn_data, db=db)
        count = r.delete(key)
        return {"ok": True, "msg": f"已删除 {count} 个 key"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


# ==================== Redis 值编辑 ====================

@eel.expose
def redis_set_string(conn_data, key, value, db=None):
    """保存 Redis string 类型的值"""
    try:
        r = _get_redis(conn_data, db=db)
        r.set(key, value)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_hash(conn_data, key, fields, deletes, db=None):
    """修改 Redis hash：fields={field:value,...} 批量更新，deletes=[field,...] 批量删除"""
    try:
        r = _get_redis(conn_data, db=db)
        if deletes:
            for f in deletes:
                r.hdel(key, f)
        if fields:
            r.hset(key, mapping=fields)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_list(conn_data, key, items, db=None):
    """覆盖 Redis list 的全部内容"""
    try:
        r = _get_redis(conn_data, db=db)
        r.delete(key)
        if items:
            r.rpush(key, *items)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_set(conn_data, key, members, db=None):
    """覆盖 Redis set 的全部成员"""
    try:
        r = _get_redis(conn_data, db=db)
        r.delete(key)
        if members:
            r.sadd(key, *members)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_zset(conn_data, key, items, db=None):
    """覆盖 Redis zset 的全部成员，items=[(member,score),...]"""
    try:
        r = _get_redis(conn_data, db=db)
        r.delete(key)
        if items:
            r.zadd(key, dict(items))
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_append_list(conn_data, key, value, db=None):
    """往 Redis list 尾部追加元素"""
    try:
        r = _get_redis(conn_data, db=db)
        r.rpush(key, value)
        return {"ok": True, "msg": "追加成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_append_set(conn_data, key, member, db=None):
    """往 Redis set 添加成员"""
    try:
        r = _get_redis(conn_data, db=db)
        r.sadd(key, member)
        return {"ok": True, "msg": "添加成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_append_zset(conn_data, key, member, score, db=None):
    """往 Redis zset 添加成员"""
    try:
        r = _get_redis(conn_data, db=db)
        r.zadd(key, {member: score})
        return {"ok": True, "msg": "添加成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _format_ttl(ttl):
    if ttl == -1: return "永久"
    if ttl == -2: return "已过期"
    if ttl > 86400: return f"{ttl//86400} 天"
    if ttl > 3600: return f"{ttl//3600} 小时"
    if ttl > 60: return f"{ttl//60} 分钟"
    return f"{ttl} 秒"


def format_size(size_val):
    """格式化大小显示（字节→KB/MB）"""
    if not isinstance(size_val, (int, float)) or size_val < 0:
        return str(size_val) if size_val else '0 B'
    if size_val < 1024:
        return f"{size_val} B"
    elif size_val < 1024 * 1024:
        return f"{size_val / 1024:.1f} KB"
    else:
        return f"{size_val / (1024*1024):.1f} MB"


@eel.expose
def db_explore_get_views(conn_data, database, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get("db_type") != 'oracle':
            cdata["db"] = database
        db_type = cdata.get("db_type", "mysql")
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as c:
            if db_type in ('mysql', 'ob-mysql'):
                rows = c.execute(text("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='VIEW' ORDER BY TABLE_NAME"), {"db":database}).fetchall()
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                rows = c.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema=:sch AND table_type='VIEW' ORDER BY table_name"), {"sch":sch}).fetchall()
            elif db_type == 'oracle':
                rows = c.execute(text("SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER=:db ORDER BY VIEW_NAME"), {"db":database}).fetchall()
            elif db_type == 'mssql':
                rows = c.execute(text("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='VIEW' ORDER BY TABLE_NAME")).fetchall()
            else:
                rows = c.execute(text("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='VIEW' ORDER BY TABLE_NAME"), {"db":database}).fetchall()
        engine.dispose()
        return {"ok": True, "views": [r[0] for r in rows]}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

@eel.expose
def db_explore_get_procedures(conn_data, database, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get("db_type") != 'oracle':
            cdata["db"] = database
        db_type = cdata.get("db_type", "mysql")
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as c:
            if db_type in ('mysql', 'ob-mysql'):
                rows = c.execute(text("SELECT ROUTINE_NAME,ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=:db ORDER BY ROUTINE_NAME"), {"db":database}).fetchall()
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                rows = c.execute(text("SELECT proname,'FUNCTION' FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname=:sch ORDER BY proname"), {"sch":sch}).fetchall()
            elif db_type == 'oracle':
                # ★ Oracle：owner 用 database（当前 schema），大写
                owner = (database or cdata.get("user", "") or "").upper()
                rows = c.execute(text(
                    "SELECT OBJECT_NAME,OBJECT_TYPE FROM ALL_OBJECTS "
                    "WHERE OWNER=:own AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION') "
                    "ORDER BY OBJECT_NAME"
                ), {"own": owner}).fetchall()
            elif db_type == 'mssql':
                rows = c.execute(text("SELECT ROUTINE_NAME,ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES ORDER BY ROUTINE_NAME")).fetchall()
            else:
                rows = c.execute(text("SELECT ROUTINE_NAME,ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=:db ORDER BY ROUTINE_NAME"), {"db":database}).fetchall()
        engine.dispose()
        return {"ok": True, "procedures": [{"name":r[0],"type":r[1]} for r in rows]}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

@eel.expose
def db_explore_get_triggers(conn_data, database, schema=''):
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as c:
            if db_type == 'oracle':
                # ★ Oracle：查 ALL_TRIGGERS（INFORMATION_SCHEMA.TRIGGERS 不存在）
                owner = (database or cdata.get("user", "") or "").upper()
                rows = c.execute(text(
                    "SELECT TRIGGER_NAME, TRIGGERING_EVENT, TABLE_NAME, TRIGGER_TYPE "
                    "FROM ALL_TRIGGERS WHERE OWNER=:own ORDER BY TRIGGER_NAME"
                ), {"own": owner}).fetchall()
                # ALL_TRIGGERS 没有 ACTION_TIMING 列，用 TRIGGER_TYPE 替代
                triggers = [{"name": r[0], "event": r[1] or "", "table": r[2] or "", "timing": r[3] or ""} for r in rows]
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                rows = c.execute(text(
                    "SELECT tgname, t.tgenabled, c.relname, 'AFTER' "
                    "FROM pg_trigger t JOIN pg_class c ON t.tgrelid=c.oid "
                    "JOIN pg_namespace n ON c.relnamespace=n.oid "
                    "WHERE n.nspname=:sch AND NOT tgisinternal ORDER BY tgname"
                ), {"sch": sch}).fetchall()
                triggers = [{"name": r[0], "event": r[1] or "", "table": r[2] or "", "timing": r[3] or ""} for r in rows]
            else:
                rows = c.execute(text(
                    "SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_TIMING "
                    "FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=:db ORDER BY TRIGGER_NAME"
                ), {"db": database}).fetchall()
                triggers = [{"name": r[0], "event": r[1], "table": r[2], "timing": r[3]} for r in rows]
        engine.dispose()
        return {"ok": True, "triggers": triggers}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, db_type)}

@eel.expose
def db_explore_get_objlist(conn_data, database, cat, schema=''):
    """获取通用对象列表（序列/同义词/包/物化视图/索引等）"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        items = []
        with engine.connect() as c:
            if db_type == 'oracle':
                owner = (database or cdata.get("user", "") or "").upper()
                if cat == 'sequences':
                    rows = c.execute(text(
                        "SELECT SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, LAST_NUMBER "
                        "FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER=:own ORDER BY SEQUENCE_NAME"
                    ), {"own": owner}).fetchall()
                    items = [{"name": r[0], "min": str(r[1]), "max": str(r[2]), "incr": r[3], "last": r[4]} for r in rows]
                elif cat == 'synonyms':
                    rows = c.execute(text(
                        "SELECT SYNONYM_NAME, TABLE_OWNER, TABLE_NAME "
                        "FROM ALL_SYNONYMS WHERE OWNER=:own ORDER BY SYNONYM_NAME"
                    ), {"own": owner}).fetchall()
                    items = [{"name": r[0], "table_owner": r[1], "table_name": r[2]} for r in rows]
                elif cat == 'packages':
                    rows = c.execute(text(
                        "SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER=:own "
                        "AND OBJECT_TYPE='PACKAGE' AND STATUS='VALID' ORDER BY OBJECT_NAME"
                    ), {"own": owner}).fetchall()
                    items = [{"name": r[0]} for r in rows]
                elif cat == 'mviews':
                    rows = c.execute(text(
                        "SELECT MVIEW_NAME FROM ALL_MVIEWS WHERE OWNER=:own ORDER BY MVIEW_NAME"
                    ), {"own": owner}).fetchall()
                    items = [{"name": r[0]} for r in rows]
                elif cat == 'indexes':
                    rows = c.execute(text(
                        "SELECT INDEX_NAME, TABLE_NAME, UNIQUENESS "
                        "FROM ALL_INDEXES WHERE TABLE_OWNER=:own ORDER BY INDEX_NAME"
                    ), {"own": owner}).fetchall()
                    items = [{"name": r[0], "table": r[1], "unique": r[2]} for r in rows]
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                if cat == 'sequences':
                    rows = c.execute(text(
                        "SELECT sequence_name FROM information_schema.sequences "
                        "WHERE sequence_schema=:sch ORDER BY sequence_name"
                    ), {"sch": sch}).fetchall()
                    items = [{"name": r[0]} for r in rows]
                elif cat == 'indexes':
                    rows = c.execute(text(
                        "SELECT indexname, tablename FROM pg_indexes "
                        "WHERE schemaname=:sch ORDER BY indexname"
                    ), {"sch": sch}).fetchall()
                    items = [{"name": r[0], "table": r[1]} for r in rows]
            else:
                # MySQL 等：仅支持索引
                if cat == 'indexes':
                    rows = c.execute(text(
                        "SELECT INDEX_NAME, TABLE_NAME FROM INFORMATION_SCHEMA.STATISTICS "
                        "WHERE TABLE_SCHEMA=:db GROUP BY INDEX_NAME, TABLE_NAME ORDER BY INDEX_NAME"
                    ), {"db": database}).fetchall()
                    items = [{"name": r[0], "table": r[1]} for r in rows]
        engine.dispose()
        return {"ok": True, "items": items}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, db_type)}

@eel.expose
def db_explore_get_proc_source(conn_data, database, obj_name, obj_type, schema=''):
    """获取存储过程/函数/触发器/序列的源码或 DDL"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        source = ""
        with engine.connect() as c:
            if db_type == 'oracle':
                owner = (database or cdata.get("user", "") or "").upper()
                obj_up = obj_name.upper()
                ot = (obj_type or '').upper()
                # 减小 DBMS_METADATA 输出
                try:
                    c.execute(text(
                        "BEGIN"
                        " DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'STORAGE',false);"
                        " DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SEGMENT_ATTRIBUTES',false);"
                        " END;"
                    ))
                except Exception:
                    pass
                if ot in ('PROCEDURE', 'FUNCTION'):
                    ora_type = 'PROCEDURE' if ot == 'PROCEDURE' else 'FUNCTION'
                    row = c.execute(text(
                        "SELECT DBMS_METADATA.GET_DDL(:typ, :name, :own) FROM DUAL"
                    ), {"typ": ora_type, "name": obj_up, "own": owner}).fetchone()
                    source = row[0] if row else ""
                elif ot == 'TRIGGER':
                    row = c.execute(text(
                        "SELECT DBMS_METADATA.GET_DDL('TRIGGER', :name, :own) FROM DUAL"
                    ), {"name": obj_up, "own": owner}).fetchone()
                    source = row[0] if row else ""
                elif ot == 'SEQUENCE':
                    row = c.execute(text(
                        "SELECT DBMS_METADATA.GET_DDL('SEQUENCE', :name, :own) FROM DUAL"
                    ), {"name": obj_up, "own": owner}).fetchone()
                    source = row[0] if row else ""
                elif ot in ('PACKAGE', 'PACKAGE_BODY'):
                    ora_type = 'PACKAGE_BODY' if ot == 'PACKAGE_BODY' else 'PACKAGE'
                    row = c.execute(text(
                        "SELECT DBMS_METADATA.GET_DDL(:typ, :name, :own) FROM DUAL"
                    ), {"typ": ora_type, "name": obj_up, "own": owner}).fetchone()
                    source = row[0] if row else ""
                elif ot == 'MVIEW':
                    row = c.execute(text(
                        "SELECT DBMS_METADATA.GET_DDL('MATERIALIZED_VIEW', :name, :own) FROM DUAL"
                    ), {"name": obj_up, "own": owner}).fetchone()
                    source = row[0] if row else ""
                else:
                    # 尝试通用方式
                    row = c.execute(text(
                        "SELECT TEXT FROM ALL_SOURCE WHERE OWNER=:own AND NAME=:name "
                        "AND TYPE=:typ ORDER BY LINE"
                    ), {"own": owner, "name": obj_up, "typ": ot}).fetchall()
                    source = ''.join(r[0] for r in row) if row else ""
            elif db_type in ('mysql', 'ob-mysql'):
                # MySQL：ROUTINE_DEFINITION
                row = c.execute(text(
                    "SELECT ROUTINE_DEFINITION FROM INFORMATION_SCHEMA.ROUTINES "
                    "WHERE ROUTINE_SCHEMA=:db AND ROUTINE_NAME=:name"
                ), {"db": database, "name": obj_name}).fetchone()
                source = row[0] if row else ""
                # MySQL 触发器
                if not source and obj_type == 'TRIGGER':
                    row = c.execute(text(
                        "SELECT ACTION_STATEMENT FROM INFORMATION_SCHEMA.TRIGGERS "
                        "WHERE TRIGGER_SCHEMA=:db AND TRIGGER_NAME=:name"
                    ), {"db": database, "name": obj_name}).fetchone()
                    source = row[0] if row else ""
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                # PG：pg_proc.prosrc
                row = c.execute(text(
                    "SELECT pg_get_functiondef(p.oid) FROM pg_proc p "
                    "JOIN pg_namespace n ON p.pronamespace=n.oid "
                    "WHERE n.nspname=:sch AND p.proname=:name"
                ), {"sch": sch, "name": obj_name}).fetchone()
                source = row[0] if row else ""
                # PG 触发器
                if not source and obj_type == 'TRIGGER':
                    row = c.execute(text(
                        "SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t "
                        "JOIN pg_class c ON t.tgrelid=c.oid "
                        "JOIN pg_namespace n ON c.relnamespace=n.oid "
                        "WHERE n.nspname=:sch AND t.tgname=:name"
                    ), {"sch": sch, "name": obj_name}).fetchone()
                    source = row[0] if row else ""
        engine.dispose()
        return {"ok": True, "source": source}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, db_type)}

@eel.expose
def db_explore_get_proc_params(conn_data, database, obj_name, obj_type='PROCEDURE', schema=''):
    """获取存储过程/函数的参数列表"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        params = []
        with engine.connect() as c:
            if db_type == 'oracle':
                owner = (database or cdata.get("user", "") or "").upper()
                obj_up = obj_name.upper()

                # ★ 1. 先用 ALL_OBJECTS 看对象是否真的存在，便于给出友好提示
                obj_row = c.execute(text(
                    "SELECT OBJECT_TYPE, STATUS FROM ALL_OBJECTS "
                    "WHERE OWNER=:own AND OBJECT_NAME=:name AND ROWNUM=1"
                ), {"own": owner, "name": obj_up}).fetchone()
                if not obj_row:
                    engine.dispose()
                    return {"ok": False, "msg": f"对象 {owner}.{obj_up} 不存在或当前用户无访问权限"}
                obj_type_real = (obj_row[0] or '').upper()
                # INVALID 状态的对象没法取参数——同时返回 ALL_ERRORS 让用户知道原因
                if (obj_row[1] or '').upper() == 'INVALID':
                    try:
                        err_rows = c.execute(text(
                            "SELECT LINE, POSITION, TEXT FROM ALL_ERRORS "
                            "WHERE OWNER=:own AND NAME=:name ORDER BY LINE, POSITION"
                        ), {"own": owner, "name": obj_up}).fetchall()
                        errs = [f"第{r[0]}行(列{r[1]}): {(r[2] or '').strip()[:200]}" for r in err_rows]
                        err_detail = "\n".join(errs[:15]) if errs else "无具体错误信息"
                        msg = f"对象 {obj_type_real} {owner}.{obj_up} 当前状态为 INVALID，请先重新编译。\n\n编译错误详情：\n{err_detail}"
                    except Exception:
                        msg = f"对象 {obj_type_real} {owner}.{obj_up} 当前状态为 INVALID，请重新编译后再测试"
                    engine.dispose()
                    return {"ok": False, "msg": msg}

                # ★ 2. 用 ALL_ARGUMENTS 取参数（兼容 PACKAGE 内的子程序与 standalone）
                #    列 PACKAGE_NAME 在所有 10g+ 版本都有；若不存在则降级不带此列
                try:
                    rows = c.execute(text(
                        "SELECT ARGUMENT_NAME, DATA_TYPE, IN_OUT, POSITION, PACKAGE_NAME "
                        "FROM ALL_ARGUMENTS WHERE OWNER=:own AND OBJECT_NAME=:name "
                        "ORDER BY PACKAGE_NAME NULLS FIRST, POSITION"
                    ), {"own": owner, "name": obj_up}).fetchall()
                    has_pkg_col = True
                except Exception:
                    # ★ 极少数版本 ALL_ARGUMENTS 没有 PACKAGE_NAME 列
                    has_pkg_col = False
                    rows = c.execute(text(
                        "SELECT ARGUMENT_NAME, DATA_TYPE, IN_OUT, POSITION "
                        "FROM ALL_ARGUMENTS WHERE OWNER=:own AND OBJECT_NAME=:name "
                        "ORDER BY POSITION"
                    ), {"own": owner, "name": obj_up}).fetchall()

                # ★ 3. 选取最匹配的一组（PACKAGE_NAME 优先 NULL=standalone，其次取第一个非空值）
                if has_pkg_col and rows:
                    null_pkg_rows = [r for r in rows if (r[4] or '') == '']
                    if null_pkg_rows:
                        rows = null_pkg_rows
                    else:
                        first_pkg = rows[0][4]
                        rows = [r for r in rows if r[4] == first_pkg]

                for r in rows:
                    name, dtype, inout, pos = r[0], r[1], r[2], r[3]
                    if pos == 0:
                        # 函数返回值（PARAMETER=0）
                        if name is None:
                            continue  # 真正的返回值，不展示
                    if name is None and (dtype or '') != 'REFCURSOR':
                        continue
                    display_name = name or ('<返回值>' if pos == 0 else f'arg{pos}')
                    io = (inout or 'IN').upper()
                    if pos == 0 and (name or '') == '':
                        io = 'OUT'
                        display_name = 'RETURN_VALUE'
                    params.append({
                        "name": display_name,
                        "type": dtype or "",
                        "io": io
                    })
            elif db_type in ('mysql', 'ob-mysql'):
                rows = c.execute(text(
                    "SELECT PARAMETER_NAME, DATA_TYPE, PARAMETER_MODE, ORDINAL_POSITION "
                    "FROM INFORMATION_SCHEMA.PARAMETERS "
                    "WHERE SPECIFIC_SCHEMA=:db AND SPECIFIC_NAME=:name "
                    "ORDER BY ORDINAL_POSITION"
                ), {"db": database, "name": obj_name}).fetchall()
                for r in rows:
                    name, dtype, mode, pos = r
                    params.append({"name": name or "", "type": dtype or "", "io": (mode or "IN").upper()})
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                rows = c.execute(text(
                    "SELECT p.proargnames, p.proargmodes, "
                    "ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS type_arr "
                    "FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid "
                    "WHERE n.nspname=:sch AND p.proname=:name "
                    "ORDER BY p.oid LIMIT 1"
                ), {"sch": sch, "name": obj_name}).fetchone()
                if rows:
                    names = rows[0] or []
                    modes = rows[1] or []
                    types = rows[2] or []
                    if names is None:
                        names = []
                    for i in range(len(names) if names else 0):
                        io = {'o': 'OUT', 'b': 'IN/OUT', 'i': 'IN'}.get((modes[i] if i < len(modes) else 'i'), 'IN')
                        dtype = types[i] if i < len(types) else ''
                        params.append({"name": names[i] or f'${i+1}', "type": dtype, "io": io})
            # MSSQL 暂不实现参数获取
        engine.dispose()
        return {"ok": True, "params": params}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}

@eel.expose
def db_explore_test_proc(conn_data, database, proc_name, inputs, schema=''):
    """测试执行存储过程/函数（目前仅支持 Oracle）
    inputs: list of {name, io, value, data_type(可选), enabled(可选)}
    """
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            return {"ok": False, "msg": "存储过程测试目前仅支持 Oracle"}
        # ★ 确保 inputs 是列表
        if isinstance(inputs, dict):
            inputs = list(inputs.values())
        elif not isinstance(inputs, list):
            inputs = []
        # ★ 用户输入映射（name.upper() → {data_type, value, enabled}）
        user_input_map = {}
        for it in inputs:
            if not isinstance(it, dict):
                continue
            nm = (it.get('name', '') or '').upper()
            if nm:
                user_input_map[nm] = it
        import oracledb as _oracledb
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        outputs = []
        msg = "执行成功"

        def _parse_user_value(val, user_dt, oracle_dtype):
            """根据用户指定类型或 Oracle 类型转换输入值"""
            if val == '' or val is None:
                return val
            # 类型必须以存储过程在 ALL_ARGUMENTS 中定义的 DATA_TYPE 为准，
            # 不接受前端传入的可变类型，避免用户用错误类型覆盖 Oracle 定义。
            dt = (oracle_dtype or user_dt or 'STRING').upper()
            if dt in ('FLOAT', 'NUMBER', 'NUMERIC', 'DECIMAL'):
                try:
                    return float(val) if '.' in str(val) else int(val)
                except Exception:
                    return val
            if dt == 'INTEGER':
                try:
                    return int(val)
                except Exception:
                    return val
            if dt in ('DATE', 'TIMESTAMP'):
                if hasattr(val, 'year'):
                    return val
                s = str(val)[:19]
                try:
                    from datetime import datetime as _dt
                    return _dt.strptime(s, '%Y-%m-%d %H:%M:%S')
                except Exception:
                    try:
                        return _dt.strptime(s, '%Y-%m-%d')
                    except Exception:
                        return str(val)
            return str(val)

        with engine.connect() as c:
            owner = (database or cdata.get("user", "") or "").upper()
            proc_up = proc_name.upper()
            # ★ 1. 从 ALL_ARGUMENTS 取 PACKAGE_NAME（兼容此 Oracle 版本的列）
            pkg_row = c.execute(text(
                "SELECT PACKAGE_NAME FROM ALL_ARGUMENTS "
                "WHERE OWNER=:own AND OBJECT_NAME=:name AND ROWNUM=1"
            ), {"own": owner, "name": proc_up}).fetchone()
            package_name = (pkg_row[0] or '').upper() if pkg_row and pkg_row[0] else ''
            in_package = bool(package_name)

            # ★ 2. 看是不是 FUNCTION（standalone 时 ALL_OBJECTS 有 FUNCTION/PROCEDURE 行）
            is_function = False
            if not in_package:
                obj_row = c.execute(text(
                    "SELECT OBJECT_TYPE FROM ALL_OBJECTS "
                    "WHERE OWNER=:own AND OBJECT_NAME=:name AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') AND ROWNUM=1"
                ), {"own": owner, "name": proc_up}).fetchone()
                is_function = (obj_row and (obj_row[0] or '').upper() == 'FUNCTION')

            # ★ 3. 取参数（如果属于 PACKAGE 则按 PACKAGE_NAME 过滤）
            if in_package:
                rows = c.execute(text(
                    "SELECT ARGUMENT_NAME, DATA_TYPE, IN_OUT, POSITION "
                    "FROM ALL_ARGUMENTS WHERE OWNER=:own AND OBJECT_NAME=:name "
                    "AND PACKAGE_NAME=:pkg ORDER BY POSITION"
                ), {"own": owner, "name": proc_up, "pkg": package_name}).fetchall()
            else:
                rows = c.execute(text(
                    "SELECT ARGUMENT_NAME, DATA_TYPE, IN_OUT, POSITION "
                    "FROM ALL_ARGUMENTS WHERE OWNER=:own AND OBJECT_NAME=:name "
                    "ORDER BY POSITION"
                ), {"own": owner, "name": proc_up}).fetchall()

            if is_function:
                # 函数：用 SELECT 直接调用
                func_args = []
                for r in rows:
                    name, dtype, inout, pos = r
                    if pos == 0 or name is None:
                        continue
                    user = user_input_map.get((name or '').upper())
                    if user and user.get('enabled', True):
                        val = user.get('value', '')
                        val = _parse_user_value(val, user.get('data_type', ''), dtype)
                    else:
                        val = ''
                    func_args.append(val)
                func_ref = f"{owner}.{proc_up}" if not in_package else f"{owner}.{package_name}.{proc_up}"
                plsql = f"SELECT {func_ref}(" + ",".join(f":a{i}" for i in range(len(func_args))) + ") FROM DUAL"
                bind = {f"a{i}": v for i, v in enumerate(func_args)}
                row = c.execute(text(plsql), bind).fetchone()
                if row:
                    outputs.append({"name": "RETURN_VALUE", "value": row[0]})
            else:
                # 存储过程：使用底层 DBAPI callproc
                cursor = c.connection.connection.cursor()
                proc_args = []
                for r in rows:
                    name, dtype, inout, pos = r
                    if pos == 0 or name is None:
                        continue
                    io = (inout or 'IN').upper()
                    arg_name = name or f'arg{pos}'
                    if io in ('OUT', 'IN/OUT', 'INOUT'):
                        dt = (dtype or 'VARCHAR2').upper()
                        if 'VARCHAR' in dt or 'CHAR' in dt or 'CLOB' in dt or 'LONG' in dt:
                            var = cursor.var(_oracledb.STRING)
                        elif 'NUMBER' in dt or 'INTEGER' in dt or 'FLOAT' in dt or 'BINARY' in dt or 'DECIMAL' in dt or 'NUMERIC' in dt:
                            var = cursor.var(_oracledb.NUMBER)
                        elif 'DATE' in dt or 'TIMESTAMP' in dt:
                            var = cursor.var(_oracledb.DATE)
                        elif 'BLOB' in dt or 'RAW' in dt:
                            var = cursor.var(_oracledb.BLOB)
                        elif 'CURSOR' in dt:
                            var = cursor.var(_oracledb.CURSOR)
                        else:
                            var = cursor.var(_oracledb.STRING)
                        proc_args.append(var)
                        outputs.append({"name": arg_name, "value": None, "_var_index": len(proc_args) - 1})
                    else:
                        user = user_input_map.get(arg_name.upper())
                        if user and user.get('enabled', True):
                            val = user.get('value', '')
                            val = _parse_user_value(val, user.get('data_type', ''), dtype)
                        else:
                            val = ''
                        proc_args.append(val)
                proc_ref = f"{owner}.{proc_up}" if not in_package else f"{owner}.{package_name}.{proc_up}"
                cursor.callproc(proc_ref, proc_args)
                # 回读 OUT 参数
                for o in outputs:
                    if '_var_index' in o:
                        idx = o['_var_index']
                        v = proc_args[idx].getvalue()
                        o['value'] = v
                        del o['_var_index']
                cursor.close()
                msg = f"已执行 {proc_ref}"
        engine.dispose()
        return {"ok": True, "outputs": outputs, "msg": msg}
    except Exception as e:
        return {"ok": False, "msg": str(e)}

@eel.expose
def db_explore_drop_object(conn_data, database, obj_name, obj_type, schema=''):
    """删除存储过程/函数/触发器/包/序列/视图/物化视图等对象"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.begin() as c:
            ot = (obj_type or 'PROCEDURE').upper()
            if db_type == 'oracle':
                owner = (database or cdata.get("user", "") or "").upper()
                obj_up = obj_name.upper()
                # 查真实对象类型
                row = c.execute(text(
                    "SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER=:own AND OBJECT_NAME=:name"
                ), {"own": owner, "name": obj_up}).fetchone()
                real_ot = row[0] if row else ot
                sql = f"DROP {real_ot} {owner}.{obj_up}"
                c.execute(text(sql))
            elif db_type in ('mysql', 'ob-mysql'):
                if ot in ('PROCEDURE', 'FUNCTION'):
                    sql = f"DROP {ot} IF EXISTS `{database}`.`{obj_name}`"
                elif ot == 'TRIGGER':
                    sql = f"DROP TRIGGER IF EXISTS `{database}`.`{obj_name}`"
                elif ot == 'VIEW':
                    sql = f"DROP VIEW IF EXISTS `{database}`.`{obj_name}`"
                else:
                    sql = f"DROP {ot} IF EXISTS `{database}`.`{obj_name}`"
                c.execute(text(sql))
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                if ot == 'TRIGGER':
                    sql = f"DROP TRIGGER IF EXISTS {obj_name} ON {sch}.{obj_name} CASCADE"
                elif ot in ('PROCEDURE', 'FUNCTION'):
                    sql = f"DROP {ot} IF EXISTS {sch}.{obj_name} CASCADE"
                elif ot == 'VIEW':
                    sql = f"DROP VIEW IF EXISTS {sch}.{obj_name} CASCADE"
                elif ot == 'SEQUENCE':
                    sql = f"DROP SEQUENCE IF EXISTS {sch}.{obj_name} CASCADE"
                else:
                    sql = f"DROP {ot} IF EXISTS {sch}.{obj_name} CASCADE"
                c.execute(text(sql))
            elif db_type == 'mssql':
                sql = f"DROP {ot} [{schema or database}].[{obj_name}]"
                c.execute(text(sql))
        engine.dispose()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}

@eel.expose
def db_explore_compile_object(conn_data, database, obj_name, obj_type='PROCEDURE', schema=''):
    """重新编译 Oracle 存储过程/函数/包/触发器/视图等"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            return {"ok": False, "msg": "重新编译目前仅支持 Oracle"}
        owner = (database or cdata.get("user", "") or "").upper()
        obj_up = obj_name.upper()
        # ★ 查真实对象类型
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        ot = (obj_type or 'PROCEDURE').upper()
        sqls = []
        with engine.connect() as c:
            row = c.execute(text(
                "SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER=:own AND OBJECT_NAME=:name AND ROWNUM=1"
            ), {"own": owner, "name": obj_up}).fetchone()
            real_ot = (row[0] or ot).upper() if row else ot
            if real_ot == 'PACKAGE':
                sqls = [
                    f"ALTER PACKAGE {owner}.{obj_up} COMPILE SPECIFICATION",
                    f"ALTER PACKAGE {owner}.{obj_up} COMPILE BODY"
                ]
            elif real_ot == 'PACKAGE BODY':
                sqls = [f"ALTER PACKAGE {owner}.{obj_up} COMPILE BODY"]
            elif real_ot == 'MATERIALIZED VIEW':
                sqls = [f"ALTER MATERIALIZED VIEW {owner}.{obj_up} COMPILE"]
            else:
                sqls = [f"ALTER {real_ot} {owner}.{obj_up} COMPILE"]
        # ★ 编译
        for s in sqls:
            with engine.begin() as c2:
                c2.execute(text(s))
        # ★ 验证：检查编译后状态
        with engine.connect() as c:
            verify_row = c.execute(text(
                "SELECT STATUS FROM ALL_OBJECTS "
                "WHERE OWNER=:own AND OBJECT_NAME=:name AND ROWNUM=1"
            ), {"own": owner, "name": obj_up}).fetchone()
            new_status = (verify_row[0] or '').upper() if verify_row else ''
        engine.dispose()
        if new_status and new_status != 'VALID':
            # ★ 编译未真正成功，提取 ALL_ERRORS 的具体错误信息
            with engine.connect() as c:
                err_rows = c.execute(text(
                    "SELECT LINE, POSITION, TEXT FROM ALL_ERRORS "
                    "WHERE OWNER=:own AND NAME=:name ORDER BY LINE, POSITION"
                ), {"own": owner, "name": obj_up}).fetchall()
                errs = [f"第{r[0]}行(列{r[1]}): {(r[2] or '').strip()[:200]}" for r in err_rows]
            err_msg = "\n".join(errs[:15]) if errs else "无具体错误信息"
            return {"ok": False, "msg": f"{owner}.{obj_up} 编译未通过（状态={new_status}）：\n\n{err_msg}"}
        return {"ok": True, "msg": f"已重新编译 {owner}.{obj_up}"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}

@eel.expose
def db_explore_get_table_ddl(conn_data, database, table_name):
    try:
        cdata = dict(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as c:
            if db_type == 'oracle':
                # ★ Oracle 使用 DBMS_METADATA.GET_DDL 获取 DDL，表名和 owner 统一转大写
                owner = (cdata.get("user", database) or '').upper()
                tbl = table_name.upper()
                result = c.execute(text("SELECT DBMS_METADATA.GET_DDL('TABLE', :tbl, :owner) FROM DUAL"),
                                   {"tbl": tbl, "owner": owner})
                row = result.fetchone()
                ddl = row[0] if row else ""
            elif db_type in ('postgresql', 'mssql'):
                result = table_get_ddl(cdata, database, table_name)
                if not result.get('ok'):
                    raise RuntimeError(result.get('msg', '获取表结构失败'))
                ddl = result.get('ddl', '')
            else:
                row = c.execute(text(f"SHOW CREATE TABLE {_safe_ident(database, 'mysql')}.{_safe_ident(table_name, 'mysql')}")).fetchone()
                ddl = row[1] if row else ""
        engine.dispose()
        return {"ok": True, "ddl": ddl}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, db_type)}

# ==================== 数据库管理 ====================
@eel.expose
def db_get_info(conn_data, database):
    """获取数据库信息（字符集、排序规则）"""
    try:
        cdata = dict(conn_data); db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                row = conn.execute(text(
                    "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME "
                    "FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=:db"
                ), {"db": database}).fetchone()
            else:
                row = conn.execute(text("SELECT 'utf8mb4','utf8mb4_unicode_ci'")).fetchone()
        engine.dispose()
        if row:
            return {"ok": True, "charset": row[0] or "", "collation": row[1] or ""}
        return {"ok": False, "msg": "未找到"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, db_type)}


@eel.expose
def db_delete(conn_data, database):
    """删除数据库"""
    try:
        cdata = dict(conn_data); db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle': cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.begin() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                conn.execute(text(f"DROP DATABASE IF EXISTS {_safe_ident(database, 'mysql')}"))
            elif db_type == 'postgresql':
                conn.execute(text("COMMIT"))
                conn.execute(text(f"DROP DATABASE IF EXISTS {_safe_ident(database, 'postgresql')}"))
            elif db_type == 'mssql':
                conn.execute(text(f"DROP DATABASE IF EXISTS {_safe_ident(database, 'mssql')}"))
            elif db_type == 'oracle':
                conn.execute(text(f"DROP USER {_safe_ident(database, 'oracle')} CASCADE"))
        engine.dispose()
        return {"ok": True, "msg": f"数据库 [{database}] 已删除"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, db_type)}


@eel.expose
def db_run_sql_file(conn_data, database, file_path, content='', operation_id=None):
    """在指定数据库上运行 SQL 文件（支持直接传内容或文件路径）"""
    op_data = dict(conn_data or {})
    op_db_type = op_data.get('db_type', 'mysql')
    if op_db_type != 'oracle':
        op_data['db'] = database
    op_state = _register_db_operation(operation_id, op_data, 'sql_file')

    def _check_db_prefix(content, db_type, target_db):
        if re.search(r'(?im)^\s*(DROP|CREATE|ALTER)\s+DATABASE\b', content):
            return (False, "SQL 文件包含数据库级管理语句，禁止执行 DROP/CREATE/ALTER DATABASE")
        if re.search(r'(?im)^\s*SET\s+search_path\s*=', content):
            return (False, "SQL 文件包含 SET search_path，可能切换目标 schema")
        for _, used_db in re.findall(r'(?im)^\s*USE\s+([`\"\[]?)([^`\"\]\s;]+)[`\"\]]?\s*;?', content):
            if used_db != target_db:
                return (False, f"SQL 文件尝试切换到数据库 [{used_db}]，与当前目标数据库 [{target_db}] 不一致")
        imported_dbs = set()
        if db_type in ('mysql', 'ob-mysql'):
            matches = re.findall(r'`([^`]+)`\.`([^`]+)`', content)
            imported_dbs = {m[0] for m in matches}
        elif db_type == 'postgresql':
            matches = re.findall(r'"([^"]+)"\."([^"]+)"', content)
            imported_dbs = {m[0] for m in matches}
        elif db_type == 'mssql':
            matches = re.findall(r'\[([^\]]+)\]\.\[([^\]]+)\]', content)
            imported_dbs = {m[0] for m in matches}
        if imported_dbs:
            for imp_db in imported_dbs:
                if imp_db != target_db:
                    return (False, f"SQL 文件中引用了数据库 [{imp_db}]，与当前目标数据库 [{target_db}] 不一致，请更换数据库后重试")
        return (True, "")

    def _run():
        engine = None
        try:
            cdata = dict(conn_data)
            db_type = cdata.get('db_type', 'mysql')
            if db_type != 'oracle':
                cdata["db"] = database
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
            if _db_operation_cancelled(op_state):
                raise RuntimeError("操作已取消")
            if content:
                sql_content = content
            else:
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    sql_content = f.read()
            # 检查数据库前缀是否匹配
            ok, err = _check_db_prefix(sql_content, db_type, database)
            if not ok:
                _progress_q.put(("sql_run_error", {"msg": err}))
                engine.dispose()
                return
            statements = _split_sql_statements(sql_content)
            total = len(statements); done = 0
            _progress_q.put(("sql_run_progress", {"total": total, "processed": 0}))
            with engine.begin() as conn:
                pid = _get_backend_pid(conn, db_type)
                _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
                for stmt in statements:
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
                    try:
                        conn.execute(text(stmt)); done += 1
                        if _db_operation_cancelled(op_state):
                            _kill_db_operation(op_state)
                            raise RuntimeError("操作已取消")
                        if done % 50 == 0:
                            _progress_q.put(("sql_run_progress", {"total": total, "processed": done}))
                    except Exception as se:
                        raise RuntimeError(f"第 {done + 1} 条 SQL 执行失败，事务已回滚：{str(se)[:200]}") from se
            _progress_q.put(("sql_run_done", {"total": total, "processed": done}))
        except Exception as e:
            if _db_operation_cancelled(op_state):
                _progress_q.put(("sql_run_error", {"msg": "操作已取消", "cancelled": True}))
            else:
                _progress_q.put(("sql_run_error", {"msg": str(e)}))
        finally:
            if engine is not None:
                try:
                    engine.dispose()
                except Exception:
                    pass
            _finish_db_operation(op_state)
    threading.Thread(target=_run, daemon=True).start()
    return True


@eel.expose
def pick_sql_file():
    """选择 SQL 文件"""
    import tkinter.filedialog as fd, tkinter
    root = tkinter.Tk(); root.withdraw(); root.attributes('-topmost', True)
    path = fd.askopenfilename(title="选择 SQL 文件", filetypes=[("SQL文件", "*.sql"), ("所有文件", "*.*")])
    root.destroy()
    return path or ""


@eel.expose
def db_get_collations(conn_data, database):
    """获取可用排序规则"""
    try:
        cdata = dict(conn_data); db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                rows = conn.execute(text(
                    "SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLLATIONS "
                    "WHERE CHARACTER_SET_NAME=(SELECT DEFAULT_CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=:db) "
                    "ORDER BY COLLATION_NAME"
                ), {"db": database}).fetchall()
            else:
                rows = conn.execute(text("SELECT 'utf8mb4_unicode_ci'")).fetchall()
        engine.dispose()
        return {"ok": True, "collations": [r[0] for r in rows]}
    except Exception as e: return {"ok": False, "msg": str(e)}


@eel.expose
def db_create(conn_data, db_name, charset='utf8mb4', collation='utf8mb4_unicode_ci'):
    """创建数据库"""
    try:
        cdata = dict(conn_data); db_type = cdata.get('db_type', 'mysql')
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', str(charset or '')):
            return {"ok": False, "msg": "字符集名称不合法"}
        if not re.fullmatch(r'[A-Za-z0-9_]+', str(collation or '')):
            return {"ok": False, "msg": "排序规则名称不合法"}
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type in ('mysql', 'ob-mysql'):
            raw = engine.raw_connection()
            try:
                raw.cursor().execute(f"CREATE DATABASE {_safe_ident(db_name, 'mysql')} CHARACTER SET {charset} COLLATE {collation}")
                raw.commit()
            finally:
                raw.close()
        elif db_type == 'postgresql':
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10),
                                   isolation_level="AUTOCOMMIT")
            with engine.connect() as conn:
                conn.execute(text(f"CREATE DATABASE {_safe_ident(db_name, 'postgresql')}"))
        else:
            with engine.begin() as conn:
                conn.execute(text(f"CREATE DATABASE {_safe_ident(db_name, db_type)}"))
        engine.dispose()
        return {"ok": True, "msg": f"数据库 {db_name} 创建成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}



# ==================== 查询文件存储 ====================
QUERIES_DIR = os.path.join(BASE_DIR, "queries")

def _get_query_dir(conn_id, db, tree=None):
    """获取连接+数据库对应的查询文件夹路径"""
    # 用连接名+数据库名作为文件夹名，清理非法字符
    if tree is None:
        tree = _load_tree()
    conn = tree.get("connections", {}).get(conn_id, {})
    conn_name = conn.get("name", conn_id) if conn else conn_id
    # 清理文件名非法字符
    safe_conn = re.sub(r'[\\/:*?"<>|]', '_', str(conn_name))
    safe_db = re.sub(r'[\\/:*?"<>|]', '_', str(db or 'default'))
    return os.path.join(QUERIES_DIR, safe_conn, safe_db)

def _migrate_old_queries(tree=None):
    """将 mqdb_tree.json 中的旧 saved_queries 迁移到 queries/ 文件夹
    Args:
        tree: 可选，已加载的树数据。不传则内部调用 _load_tree()
    """
    if tree is None:
        tree = _load_tree()
    old_queries = tree.get("saved_queries", [])
    if not old_queries:
        return
    print(f"[queries] 检测到 {len(old_queries)} 个旧格式查询，开始迁移...")
    migrated = 0
    for q in old_queries:
        try:
            qid = q.get("id", "")
            name = q.get("name", "未命名")
            sql = q.get("sql", "")
            conn_id = q.get("conn_id", "")
            db = q.get("db", "")
            # 生成文件路径（传入 tree 避免重复调用 _load_tree）
            qdir = _get_query_dir(conn_id, db, tree=tree)
            os.makedirs(qdir, exist_ok=True)
            # 用查询名作为文件名（清理后）
            safe_name = re.sub(r'[\\/:*?"<>|]', '_', str(name))
            fpath = os.path.join(qdir, f"{safe_name}.sql")
            # 避免重名：如果已存在则追加 ID
            if os.path.exists(fpath):
                fpath = os.path.join(qdir, f"{safe_name}_{qid}.sql")
            # 写入文件头部注释 + SQL
            content = f"-- name: {name}\n-- id: {qid}\n-- conn_id: {conn_id}\n-- db: {db}\n\n{sql}"
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(content)
            migrated += 1
        except Exception as e:
            print(f"[queries] 迁移查询失败 ({q.get('name','?')}): {e}")
    # 迁移完成后清除旧字段
    if migrated:
        tree.pop("saved_queries", None)
        _save_tree(tree)
        print(f"[queries] 迁移完成: {migrated}/{len(old_queries)} 个查询已保存到 {QUERIES_DIR}")

@eel.expose
def tree_save_query(qid, name, sql, conn_id, db=''):
    with _tree_lock:
        try:
            if not qid: qid = f"q_{int(time.time() * 1000)}"
            # ★ 防御：如果 Eel 传输时把换行符变成了字面量 \\n，还原回去
            if sql and '\\n' in sql and '\n' not in sql:
                sql = sql.replace('\\n', '\n').replace('\\t', '\t')
            qdir = _get_query_dir(conn_id, db)
            os.makedirs(qdir, exist_ok=True)
            # 先删除旧文件（按 ID 匹配）
            tree_list_queries(conn_id, db)  # 只是触发扫描
            for fname in os.listdir(qdir):
                if not fname.endswith('.sql'):
                    continue
                fpath = os.path.join(qdir, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read()
                    # 从文件头部注释中提取 id
                    match = re.search(r'^--\s*id:\s*(.+)$', content, re.MULTILINE)
                    if match and match.group(1).strip() == qid:
                        os.remove(fpath)
                        break
                except Exception:
                    pass
            # 写入新文件
            safe_name = re.sub(r'[\\/:*?"<>|]', '_', str(name or '未命名'))
            fpath = os.path.join(qdir, f"{safe_name}.sql")
            if os.path.exists(fpath):
                fpath = os.path.join(qdir, f"{safe_name}_{qid}.sql")
            content = f"-- name: {name or '未命名'}\n-- id: {qid}\n-- conn_id: {conn_id or ''}\n-- db: {db or ''}\n\n{sql or ''}"
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"[queries] 保存查询: {fpath}")
            return {"ok": True, "id": qid}
        except Exception as e:
            print(f"[queries] tree_save_query 异常: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            return {"ok": False, "msg": f"保存查询失败: {str(e)}"}

@eel.expose
def tree_delete_query(qid):
    with _tree_lock:
        try:
            # 扫描所有 queries 子目录
            if not os.path.isdir(QUERIES_DIR):
                return {"ok": True}
            for root, dirs, files in os.walk(QUERIES_DIR):
                for fname in files:
                    if not fname.endswith('.sql'):
                        continue
                    fpath = os.path.join(root, fname)
                    try:
                        with open(fpath, "r", encoding="utf-8") as f:
                            content = f.read()
                        match = re.search(r'^--\s*id:\s*(.+)$', content, re.MULTILINE)
                        if match and match.group(1).strip() == qid:
                            os.remove(fpath)
                            print(f"[queries] 删除查询: {fpath}")
                            return {"ok": True}
                    except Exception:
                        pass
            return {"ok": True}  # 文件不存在也算成功
        except Exception as e:
            return {"ok": False, "msg": f"删除查询失败: {str(e)}"}

@eel.expose
def tree_get_query(qid):
    """获取单个查询（用于打开查询编辑器）"""
    try:
        if not os.path.isdir(QUERIES_DIR):
            return None
        for root, dirs, files in os.walk(QUERIES_DIR):
            for fname in files:
                if not fname.endswith('.sql'):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read()
                    match = re.search(r'^--\s*id:\s*(.+)$', content, re.MULTILINE)
                    if match and match.group(1).strip() == qid:
                        # 解析元数据
                        name_match = re.search(r'^--\s*name:\s*(.+)$', content, re.MULTILINE)
                        conn_match = re.search(r'^--\s*conn_id:\s*(.+)$', content, re.MULTILINE)
                        db_match = re.search(r'^--\s*db:\s*(.+)$', content, re.MULTILINE)
                        # SQL 内容从第一个空行后开始（保留尾部换行，不做 strip）
                        sql = ''
                        lines = content.split('\n')
                        for i, line in enumerate(lines):
                            if line.strip() == '' and i > 3:
                                sql = '\n'.join(lines[i+1:])
                                break
                        if not sql and lines:
                            sql = '\n'.join(lines[4:]) if len(lines) > 4 else ''
                        return {
                            "id": qid,
                            "name": name_match.group(1).strip() if name_match else fname.replace('.sql',''),
                            "sql": sql,
                            "conn_id": conn_match.group(1).strip() if conn_match else '',
                            "db": db_match.group(1).strip() if db_match else ''
                        }
                except Exception:
                    pass
        return None
    except Exception as e:
        print(f"[queries] tree_get_query 异常: {e}")
        return None

@eel.expose
def tree_list_queries(conn_id, db=''):
    """列出指定连接+数据库下的所有查询（用于树节点展开和右侧面板）
    ★ 只读文件头部元数据，避免大文件拖慢展开速度
    """
    try:
        qdir = _get_query_dir(conn_id, db)
        if not os.path.isdir(qdir):
            return []
        results = []
        for fname in sorted(os.listdir(qdir)):
            if not fname.endswith('.sql'):
                continue
            fpath = os.path.join(qdir, fname)
            try:
                # ★ 只读文件头部（前2KB足够包含元数据注释），大文件不再拖慢列表
                with open(fpath, "r", encoding="utf-8") as f:
                    content = f.read(2048)
                # 解析元数据
                name_match = re.search(r'^--\s*name:\s*(.+)$', content, re.MULTILINE)
                id_match = re.search(r'^--\s*id:\s*(.+)$', content, re.MULTILINE)
                qid = id_match.group(1).strip() if id_match else ''
                qname = name_match.group(1).strip() if name_match else fname.replace('.sql','')
                results.append({"id": qid, "name": qname, "conn_id": conn_id, "db": db or ''})
            except Exception as e:
                print(f"[queries] 读取查询文件失败 {fpath}: {e}")
        return results
    except Exception as e:
        print(f"[queries] tree_list_queries 异常: {e}")
        return []

# ==================== 拖拽复制表 ====================
def _get_column_info(conn, db_type, db_name, table_name):
    """从源表获取列信息（统一接口，支持所有数据库类型）"""
    if db_type in ('mysql', 'ob-mysql'):
        rows = conn.execute(text(
            "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, "
            "IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE, EXTRA, COLUMN_COMMENT "
            "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
        ), {"db": db_name, "tbl": table_name}).fetchall()
        return [{
            "name": r[0], "type": r[7] or r[1], "nullable": r[5] == 'YES', "default": r[6],
            "auto_increment": "auto_increment" in (r[8] or '').lower(), "comment": r[9] or ''
        } for r in rows]
    elif db_type == 'postgresql':
        rows = conn.execute(text(
            "SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, "
            "is_nullable, column_default, udt_name "
            "FROM information_schema.columns WHERE table_schema=:sch AND table_name=:tbl ORDER BY ordinal_position"
        ), {"sch": db_name, "tbl": table_name}).fetchall()
        identity_columns = set()
        try:
            identity_rows = conn.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema=:sch AND table_name=:tbl AND is_identity='YES'"
            ), {"sch": db_name, "tbl": table_name}).fetchall()
            identity_columns = {r[0] for r in identity_rows}
        except Exception:
            # PostgreSQL 9.x 没有 is_identity，serial 列仍可通过 nextval 默认值识别。
            pass
        comments = {}
        try:
            comment_rows = conn.execute(text(
                "SELECT cols.column_name, pg_catalog.col_description(c.oid, cols.ordinal_position::int) "
                "FROM pg_catalog.pg_class c "
                "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                "JOIN information_schema.columns cols "
                "  ON cols.table_schema=n.nspname AND cols.table_name=c.relname "
                "WHERE n.nspname=:sch AND c.relname=:tbl"
            ), {"sch": db_name, "tbl": table_name}).fetchall()
            comments = {r[0]: (r[1] or '') for r in comment_rows}
        except Exception:
            pass
        cols = []
        for r in rows:
            dt = r[1]
            if r[2] is not None and str(r[1]).lower() in ('character varying', 'character'):
                dt += f"({r[2]})"
            elif r[3] is not None and r[4] is not None: dt += f"({r[3]},{r[4]})"
            elif r[3] is not None: dt += f"({r[3]})"
            default = r[6]
            cols.append({
                "name": r[0], "type": dt, "nullable": r[5] == 'YES', "default": default,
                "auto_increment": r[0] in identity_columns or 'nextval(' in str(default or '').lower(),
                "comment": comments.get(r[0], '')
            })
        return cols
    elif db_type == 'oracle':
        rows = conn.execute(text(
            "SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, "
            "NULLABLE, DATA_DEFAULT "
            "FROM ALL_TAB_COLUMNS WHERE OWNER=:db AND TABLE_NAME=:tbl ORDER BY COLUMN_ID"
        ), {"db": db_name, "tbl": table_name}).fetchall()
        identity_columns = set()
        try:
            identity_rows = conn.execute(text(
                "SELECT COLUMN_NAME FROM ALL_TAB_COLUMNS "
                "WHERE OWNER=:db AND TABLE_NAME=:tbl AND IDENTITY_COLUMN='YES'"
            ), {"db": db_name.upper(), "tbl": table_name.upper()}).fetchall()
            identity_columns = {r[0] for r in identity_rows}
        except Exception:
            pass
        comments = {}
        try:
            comment_rows = conn.execute(text(
                "SELECT COLUMN_NAME, COMMENTS FROM ALL_COL_COMMENTS "
                "WHERE OWNER=:db AND TABLE_NAME=:tbl"
            ), {"db": db_name.upper(), "tbl": table_name.upper()}).fetchall()
            comments = {r[0]: (r[1] or '') for r in comment_rows}
        except Exception:
            pass
        cols = []
        for r in rows:
            dt = r[1]
            if dt in ('NUMBER',) and r[3] is not None and r[4] is not None:
                dt += f"({r[3]},{r[4]})"
            elif r[2] and dt in ('VARCHAR', 'VARCHAR2', 'CHAR', 'NCHAR', 'NVARCHAR2', 'RAW'):
                dt += f"({int(r[2])})"
            cols.append({"name": r[0], "type": dt, "nullable": r[5] == 'Y', "default": r[6],
                         "auto_increment": r[0] in identity_columns, "comment": comments.get(r[0], '')})
        return cols
    elif db_type == 'mssql':
        rows = conn.execute(text(
            "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, "
            "IS_NULLABLE, COLUMN_DEFAULT "
            "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
        ), {"tbl": table_name}).fetchall()
        identity_columns = set()
        comments = {}
        try:
            identity_rows = conn.execute(text(
                "SELECT c.name FROM sys.columns c "
                "JOIN sys.tables t ON t.object_id=c.object_id "
                "WHERE t.name=:tbl AND c.is_identity=1"
            ), {"tbl": table_name}).fetchall()
            identity_columns = {r[0] for r in identity_rows}
        except Exception:
            pass
        try:
            comment_rows = conn.execute(text(
                "SELECT c.name, CONVERT(nvarchar(max), ep.value) "
                "FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id "
                "LEFT JOIN sys.extended_properties ep "
                "  ON ep.class=1 AND ep.major_id=t.object_id AND ep.minor_id=c.column_id "
                "  AND ep.name='MS_Description' WHERE t.name=:tbl"
            ), {"tbl": table_name}).fetchall()
            comments = {r[0]: (r[1] or '') for r in comment_rows}
        except Exception:
            pass
        cols = []
        for r in rows:
            dt = r[1]
            if r[2] is not None and r[2] != -1 and str(r[1]).lower() in ('varchar', 'char', 'varbinary', 'binary', 'nvarchar', 'nchar'):
                length = int(r[2] / 2) if str(r[1]).lower() in ('nvarchar', 'nchar') else r[2]
                dt += f"({length})"
            elif r[2] == -1 and str(r[1]).lower() in ('varchar', 'nvarchar', 'varbinary'):
                dt += "(MAX)"
            elif r[3] is not None and r[4] is not None: dt += f"({r[3]},{r[4]})"
            elif r[3]: dt += f"({r[3]})"
            cols.append({"name": r[0], "type": dt, "nullable": r[5] == 'YES', "default": r[6],
                         "auto_increment": r[0] in identity_columns, "comment": comments.get(r[0], '')})
        return cols
    return []


def _get_table_sync_info(conn, db_type, db_name, table_name):
    """读取拖拽建表需要的表级元数据。"""
    info = {"comment": ""}
    try:
        if db_type in ('mysql', 'ob-mysql'):
            row = conn.execute(text(
                "SELECT TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES "
                "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl"
            ), {"db": db_name, "tbl": table_name}).fetchone()
        elif db_type == 'postgresql':
            row = conn.execute(text(
                "SELECT pg_catalog.obj_description(c.oid, 'pg_class') "
                "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname=:sch AND c.relname=:tbl"
            ), {"sch": db_name, "tbl": table_name}).fetchone()
        elif db_type == 'oracle':
            row = conn.execute(text(
                "SELECT COMMENTS FROM ALL_TAB_COMMENTS "
                "WHERE OWNER=:own AND TABLE_NAME=:tbl AND TABLE_TYPE='TABLE'"
            ), {"own": db_name.upper(), "tbl": table_name.upper()}).fetchone()
        elif db_type == 'mssql':
            row = conn.execute(text(
                "SELECT CONVERT(nvarchar(max), ep.value) FROM sys.tables t "
                "LEFT JOIN sys.extended_properties ep "
                "  ON ep.class=1 AND ep.major_id=t.object_id AND ep.minor_id=0 "
                "  AND ep.name='MS_Description' WHERE t.name=:tbl"
            ), {"tbl": table_name}).fetchone()
        else:
            row = None
        info["comment"] = (row[0] or '') if row else ''
    except Exception:
        # 注释权限/版本不兼容不应阻断整张表的同步。
        pass
    return info


def _get_index_info(conn, db_type, db_name, table_name):
    """从源表获取索引信息（PRIMARY KEY / UNIQUE / 普通索引），支持 MySQL/PG/Oracle/MSSQL。
    返回格式: {
        "primary_key": ["col1", "col2"],  # 主键列名列表，可能为空
        "unique": [{"name":"idx_name","columns":["col1","col2"]}, ...],
        "indexes": [{"name":"idx_name","columns":["col1","col2"]}, ...]
    }
    """
    result = {"primary_key": [], "unique": [], "indexes": [], "foreign_keys": []}
    try:
        if db_type in ('mysql', 'ob-mysql'):
            rows = conn.execute(text(
                "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX "
                "FROM INFORMATION_SCHEMA.STATISTICS "
                "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY INDEX_NAME, SEQ_IN_INDEX"
            ), {"db": db_name, "tbl": table_name}).fetchall()
            # 按索引名分组
            idx_map = {}
            for r in rows:
                idx_name = r[0]
                col_name = r[1]
                non_unique = r[2]
                if idx_name not in idx_map:
                    idx_map[idx_name] = {"name": idx_name, "columns": [], "non_unique": non_unique}
                idx_map[idx_name]["columns"].append(col_name)
            for idx in idx_map.values():
                if idx["name"] == "PRIMARY":
                    result["primary_key"] = idx["columns"]
                elif idx["non_unique"] == 0:
                    result["unique"].append({"name": idx["name"], "columns": idx["columns"]})
                else:
                    result["indexes"].append({"name": idx["name"], "columns": idx["columns"]})

        elif db_type == 'postgresql':
            rows = conn.execute(text(
                "SELECT i.relname AS index_name, a.attname AS column_name, "
                "ix.indisprimary, ix.indisunique "
                "FROM pg_class t "
                "JOIN pg_index ix ON t.oid = ix.indrelid "
                "JOIN pg_class i ON i.oid = ix.indexrelid "
                "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) "
                "WHERE t.relname=:tbl AND t.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=:sch) "
                "ORDER BY ix.indisprimary DESC, i.relname, a.attnum"
            ), {"tbl": table_name, "sch": db_name}).fetchall()
            idx_map = {}
            for r in rows:
                idx_name = r[0]
                col_name = r[1]
                is_pk = r[2]
                is_unique = r[3]
                if idx_name not in idx_map:
                    idx_map[idx_name] = {"name": idx_name, "columns": [], "is_pk": is_pk, "is_unique": is_unique}
                idx_map[idx_name]["columns"].append(col_name)
            # PK 索引名通常自动生成（如 table_pkey），统一标识
            pk_name = f"{table_name}_pkey"
            for idx in idx_map.values():
                if idx["is_pk"]:
                    result["primary_key"] = idx["columns"]
                elif idx["is_unique"]:
                    result["unique"].append({"name": idx["name"], "columns": idx["columns"]})
                else:
                    result["indexes"].append({"name": idx["name"], "columns": idx["columns"]})

        elif db_type == 'oracle':
            # 查询约束（主键/唯一）
            pk_rows = conn.execute(text(
                "SELECT cc.column_name FROM all_cons_columns cc "
                "JOIN all_constraints c ON cc.constraint_name=c.constraint_name AND cc.owner=c.owner "
                "WHERE c.owner=:owner AND c.table_name=:tbl AND c.constraint_type='P' ORDER BY cc.position"
            ), {"owner": db_name.upper(), "tbl": table_name.upper()}).fetchall()
            result["primary_key"] = [r[0] for r in pk_rows]

            uq_rows = conn.execute(text(
                "SELECT c.constraint_name, cc.column_name, cc.position "
                "FROM all_cons_columns cc "
                "JOIN all_constraints c ON cc.constraint_name=c.constraint_name AND cc.owner=c.owner "
                "WHERE c.owner=:owner AND c.table_name=:tbl AND c.constraint_type='U' ORDER BY c.constraint_name, cc.position"
            ), {"owner": db_name.upper(), "tbl": table_name.upper()}).fetchall()
            uq_map = {}
            for r in uq_rows:
                cn = r[0]; col = r[1]
                if cn not in uq_map:
                    uq_map[cn] = {"name": cn, "columns": []}
                uq_map[cn]["columns"].append(col)
            result["unique"] = list(uq_map.values())

            # 普通索引
            idx_rows = conn.execute(text(
                "SELECT i.index_name, ic.column_name, ic.column_position "
                "FROM all_indexes i JOIN all_ind_columns ic ON i.index_name=ic.index_name AND i.owner=ic.index_owner "
                "WHERE i.owner=:owner AND i.table_name=:tbl AND i.uniqueness='NONUNIQUE' ORDER BY i.index_name, ic.column_position"
            ), {"owner": db_name.upper(), "tbl": table_name.upper()}).fetchall()
            idx_map = {}
            for r in idx_rows:
                iname = r[0]; col = r[1]
                if iname not in idx_map:
                    idx_map[iname] = {"name": iname, "columns": []}
                idx_map[iname]["columns"].append(col)
            result["indexes"] = list(idx_map.values())

        elif db_type == 'mssql':
            # 主键
            pk_rows = conn.execute(text(
                "SELECT c.name AS column_name FROM sys.indexes i "
                "JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id "
                "JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id "
                "WHERE i.object_id=OBJECT_ID(:tbl) AND i.is_primary_key=1 ORDER BY ic.key_ordinal"
            ), {"tbl": table_name}).fetchall()
            result["primary_key"] = [r[0] for r in pk_rows]

            # 唯一索引（非主键）
            uq_rows = conn.execute(text(
                "SELECT i.name AS index_name, c.name AS column_name "
                "FROM sys.indexes i "
                "JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id "
                "JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id "
                "WHERE i.object_id=OBJECT_ID(:tbl) AND i.is_unique=1 AND i.is_primary_key=0 ORDER BY i.name, ic.key_ordinal"
            ), {"tbl": table_name}).fetchall()
            uq_map = {}
            for r in uq_rows:
                iname = r[0]; col = r[1]
                if iname not in uq_map:
                    uq_map[iname] = {"name": iname, "columns": []}
                uq_map[iname]["columns"].append(col)
            result["unique"] = list(uq_map.values())

            # 普通索引
            idx_rows = conn.execute(text(
                "SELECT i.name AS index_name, c.name AS column_name "
                "FROM sys.indexes i "
                "JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id "
                "JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id "
                "WHERE i.object_id=OBJECT_ID(:tbl) AND i.is_unique=0 AND i.is_primary_key=0 ORDER BY i.name, ic.key_ordinal"
            ), {"tbl": table_name}).fetchall()
            idx_map = {}
            for r in idx_rows:
                iname = r[0]; col = r[1]
                if iname not in idx_map:
                    idx_map[iname] = {"name": iname, "columns": []}
                idx_map[iname]["columns"].append(col)
            result["indexes"] = list(idx_map.values())
        # 外键是表结构的一部分，拖动复制不能只复制列和索引。
        if db_type in ('mysql', 'ob-mysql'):
            fk_rows = conn.execute(text(
                "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, "
                "k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE "
                "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k "
                "JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r "
                "ON k.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA "
                "WHERE k.TABLE_SCHEMA=:db AND k.TABLE_NAME=:tbl AND k.REFERENCED_TABLE_NAME IS NOT NULL "
                "ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
            ), {"db": db_name, "tbl": table_name}).fetchall()
        elif db_type == 'postgresql':
            fk_rows = conn.execute(text(
                "SELECT tc.constraint_name, kcu.column_name, ccu.table_name, ccu.column_name, "
                "rc.update_rule, rc.delete_rule FROM information_schema.table_constraints tc "
                "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema "
                "JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name AND tc.table_schema=ccu.table_schema "
                "JOIN information_schema.referential_constraints rc ON tc.constraint_name=rc.constraint_name AND tc.table_schema=rc.constraint_schema "
                "WHERE tc.table_schema=:sch AND tc.table_name=:tbl AND tc.constraint_type='FOREIGN KEY' "
                "ORDER BY tc.constraint_name, kcu.ordinal_position"
            ), {"sch": db_name, "tbl": table_name}).fetchall()
        else:
            fk_rows = []
        fk_map = {}
        for r in fk_rows:
            fk_map.setdefault(r[0], []).append({
                "column": r[1], "ref_table": r[2], "ref_column": r[3],
                "on_update": _valid_fk_action(r[4]), "on_delete": _valid_fk_action(r[5])
            })
        result["foreign_keys"] = [{"name": name, **row} for name, rows in fk_map.items() for row in rows]
    except Exception:
        pass
    return result

def _mysql_type_row_bytes(type_text):
    """Estimate the maximum bytes occupied by one MySQL column in a row."""
    t = str(type_text or '').strip().lower()
    if re.match(r'^(?:tiny|medium|long)?(?:text|blob)\b', t):
        return 20

    match = re.match(r'^(varchar|char)\s*\(\s*(\d+)\s*\)', t)
    if match:
        chars = int(match.group(2))
        return chars * 4 + (2 if match.group(1) == 'varchar' else 0)

    match = re.match(r'^(varbinary|binary)\s*\(\s*(\d+)\s*\)', t)
    if match:
        size = int(match.group(2))
        return size + (2 if match.group(1) == 'varbinary' else 0)

    match = re.match(r'^bit\s*\(\s*(\d+)\s*\)', t)
    if match:
        return (int(match.group(1)) + 7) // 8

    if t.startswith('bigint'):
        return 8
    if t.startswith(('tinyint', 'smallint', 'mediumint', 'int', 'integer')):
        return 4
    if t.startswith(('decimal', 'numeric')):
        return 32
    if t.startswith(('double', 'float')):
        return 8
    if t.startswith('datetime'):
        return 8
    if t.startswith(('timestamp', 'date', 'time', 'year')):
        return 5
    if t.startswith(('enum', 'set')):
        return 4
    return 100


def _mysql_text_type_for(type_text):
    """Return a TEXT-family type for a large VARCHAR/CHAR, if applicable."""
    match = re.match(r'^\s*(varchar|char)\s*\(\s*(\d+)\s*\)', str(type_text or ''), re.I)
    if not match:
        return None
    return 'TEXT' if int(match.group(2)) <= 16000 else 'MEDIUMTEXT'


def _format_migrated_default(value, col_type):
    """格式化跨库迁移的默认值，避免 Oracle 的字符串默认值被当成标识符。"""
    if value is None:
        return ''
    raw = str(value)
    v = raw.strip()
    if not v:
        # 空字符串也是有效默认值，不能与 NULL（无默认值）混淆。
        return "'" + raw.replace("'", "''") + "'"
    if (len(v) >= 2 and v[0] == "'" and v[-1] == "'") or (len(v) >= 2 and v[0] == '"' and v[-1] == '"'):
        return v
    # PostgreSQL information_schema often returns literals with an explicit
    # cast, e.g. 'x'::character varying. Preserve the expression verbatim.
    if v.startswith("'") and "::" in v:
        return v
    if re.fullmatch(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?", v):
        return v
    upper = v.upper()
    if upper in ('NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
                 'LOCALTIME', 'LOCALTIMESTAMP', 'SYSDATE', 'SYSTIMESTAMP', 'GETDATE()',
                 'GETUTCDATE()', 'NOW()', 'UUID()'):
        return v
    if re.match(r'^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIME|LOCALTIMESTAMP)\s*\(', upper):
        return v
    if 'NEXTVAL' in upper or upper.startswith('NEXT VALUE FOR '):
        return v
    if re.match(r'^[A-Z_][A-Z0-9_$]*(?:\.[A-Z_][A-Z0-9_$]*)?\s*\(', upper):
        return v
    # Oracle DATA_DEFAULT 可能返回 NONE、v1 等不带引号的字符串，目标库必须按字符串处理。
    return "'" + v.replace("'", "''") + "'"


def _mssql_comment_upsert_sql(value, schema, table_name, column_name=None):
    """生成可重复执行的 SQL Server MS_Description 写入语句。"""
    schema = str(schema or 'dbo')
    table_name = str(table_name)
    value = str(value).replace("'", "''")
    schema_lit = schema.replace("'", "''")
    table_lit = table_name.replace("'", "''")
    object_ref = f"{_safe_ident(schema, 'mssql')}.{_safe_ident(table_name, 'mssql')}"
    if column_name is None:
        level = (
            f"@level0type=N'SCHEMA', @level0name=N'{schema_lit}', "
            f"@level1type=N'TABLE', @level1name=N'{table_lit}'"
        )
        exists = (
            f"major_id=OBJECT_ID(N'{object_ref}') AND minor_id=0 "
            "AND name=N'MS_Description'"
        )
    else:
        column_lit = str(column_name).replace("'", "''")
        level = (
            f"@level0type=N'SCHEMA', @level0name=N'{schema_lit}', "
            f"@level1type=N'TABLE', @level1name=N'{table_lit}', "
            f"@level2type=N'COLUMN', @level2name=N'{column_lit}'"
        )
        exists = (
            f"major_id=OBJECT_ID(N'{object_ref}') "
            f"AND minor_id=COLUMNPROPERTY(OBJECT_ID(N'{object_ref}'), N'{column_lit}', 'ColumnId') "
            "AND name=N'MS_Description'"
        )
    return (
        f"IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE {exists})\n"
        f"    EXEC sys.sp_updateextendedproperty @name=N'MS_Description', @value=N'{value}', {level}\n"
        f"ELSE\n"
        f"    EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'{value}', {level};"
    )


def _mssql_comment_drop_sql(schema, table_name, column_name=None):
    schema = str(schema or 'dbo')
    table_name = str(table_name)
    schema_lit = schema.replace("'", "''")
    table_lit = table_name.replace("'", "''")
    object_ref = f"{_safe_ident(schema, 'mssql')}.{_safe_ident(table_name, 'mssql')}"
    if column_name is None:
        level = (
            f"@level0type=N'SCHEMA', @level0name=N'{schema_lit}', "
            f"@level1type=N'TABLE', @level1name=N'{table_lit}'"
        )
        exists = f"major_id=OBJECT_ID(N'{object_ref}') AND minor_id=0 AND name=N'MS_Description'"
    else:
        column_lit = str(column_name).replace("'", "''")
        level = (
            f"@level0type=N'SCHEMA', @level0name=N'{schema_lit}', "
            f"@level1type=N'TABLE', @level1name=N'{table_lit}', "
            f"@level2type=N'COLUMN', @level2name=N'{column_lit}'"
        )
        exists = (
            f"major_id=OBJECT_ID(N'{object_ref}') "
            f"AND minor_id=COLUMNPROPERTY(OBJECT_ID(N'{object_ref}'), N'{column_lit}', 'ColumnId') "
            "AND name=N'MS_Description'"
        )
    return (
        f"IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE {exists})\n"
        f"    EXEC sys.sp_dropextendedproperty @name=N'MS_Description', {level};"
    )


def _generate_create_table(db_type, tbl, cols, indexes=None, table_options=None):
    """根据目标数据库类型生成 CREATE TABLE 语句（含主键/唯一/索引约束）"""
    if not cols:
        raise ValueError("无列信息")
    if indexes is None:
        indexes = {}
    table_options = dict(table_options or {})
    table_comment = str(table_options.get("comment") or "")

    # 每列 SQL
    column_types = {str(c.get("name")): c.get("type", "") for c in cols}
    converted_text = set()
    if db_type in ('mysql', 'ob-mysql'):
        protected = set()
        for name in indexes.get("primary_key", []):
            protected.add(str(name).casefold())
        for group in indexes.get("unique", []) + indexes.get("indexes", []):
            for name in group.get("columns", []):
                protected.add(str(name).casefold())

        row_size = sum(_mysql_type_row_bytes(t) for t in column_types.values())
        candidates = []
        for c in cols:
            name = str(c.get("name", ""))
            if name.casefold() in protected:
                continue
            new_type = _mysql_text_type_for(c.get("type", ""))
            if new_type:
                candidates.append((
                    _mysql_type_row_bytes(c.get("type", "")), name, new_type
                ))

        for old_size, name, new_type in sorted(candidates, reverse=True):
            if row_size <= 60000:
                break
            column_types[name] = new_type
            converted_text.add(name.casefold())
            row_size -= max(old_size - 20, 0)

        if row_size > 65535:
            raise ValueError(
                "目标 MySQL 表行宽仍超过 65535 字节；请缩短未加索引的 VARCHAR/CHAR，"
                "或移除超大字段的索引后重试"
            )

    col_lines = []
    for c in cols:
        col_name = _safe_ident(c["name"], db_type)
        null = '' if c.get("nullable", True) else ' NOT NULL'
        name_key = str(c.get("name", "")).casefold()
        col_type = column_types.get(str(c.get("name")), c.get("type", ""))
        # Older MySQL versions reject defaults on TEXT/MEDIUMTEXT. An identity
        # column must not also receive the source database's sequence default.
        auto_increment = bool(c.get("auto_increment"))
        has_default = (c.get("default") is not None
                       and not auto_increment and name_key not in converted_text)
        dflt = f' DEFAULT {_format_migrated_default(c["default"], col_type)}' if has_default else ''
        if auto_increment and db_type in ('mysql', 'ob-mysql'):
            auto_clause = ' AUTO_INCREMENT'
        elif auto_increment and db_type in ('postgresql', 'oracle'):
            auto_clause = ' GENERATED BY DEFAULT AS IDENTITY'
        elif auto_increment and db_type == 'mssql':
            auto_clause = ' IDENTITY(1,1)'
        else:
            auto_clause = ''
        if c.get("comment") and db_type in ('mysql', 'ob-mysql'):
            cmt = str(c["comment"]).replace('\\', '\\\\').replace("'", "\\'")
            comment_clause = f" COMMENT '{cmt}'"
        else:
            comment_clause = ''
        col_lines.append(f"  {col_name} {col_type}{auto_clause}{null}{dflt}{comment_clause}")

    # 主键约束
    pk_cols = indexes.get("primary_key", [])
    if pk_cols:
        pk_sql = ", ".join(_safe_ident(pk, db_type) for pk in pk_cols)
        col_lines.append(f"  PRIMARY KEY ({pk_sql})")

    # 唯一约束（在 CREATE TABLE 内部）
    for uq in indexes.get("unique", []):
        uq_cols = ", ".join(_safe_ident(u, db_type) for u in uq["columns"])
        # Oracle 和 MSSQL 约束名用引号保护，MySQL/PG 用反引号
        if db_type == 'oracle':
            col_lines.append(f"  CONSTRAINT \"{uq['name']}\" UNIQUE ({uq_cols})")
        elif db_type == 'mssql':
            col_lines.append(f"  CONSTRAINT [{uq['name']}] UNIQUE ({uq_cols})")
        else:
            col_lines.append(f"  UNIQUE ({uq_cols})")

    # 普通索引不在 CREATE TABLE 内生成（有些 DB 不支持），而是返回额外 ALTER 语句
    index_ddls = []
    for idx in indexes.get("indexes", []):
        idx_cols = ", ".join(_safe_ident(i, db_type) for i in idx["columns"])
        if db_type in ('mysql', 'ob-mysql'):
            index_ddls.append(f"ALTER TABLE {tbl} ADD INDEX `{idx['name']}` ({idx_cols});")
        elif db_type == 'postgresql':
            index_ddls.append(f"CREATE INDEX \"{idx['name']}\" ON {tbl} ({idx_cols});")
        elif db_type == 'oracle':
            index_ddls.append(f"CREATE INDEX \"{idx['name']}\" ON {tbl} ({idx_cols});")
        elif db_type == 'mssql':
            index_ddls.append(f"CREATE INDEX [{idx['name']}] ON {tbl} ({idx_cols});")

    inner = ',\n'.join(col_lines)

    if db_type in ('mysql', 'ob-mysql'):
        table_comment_clause = ''
        if table_comment:
            cmt = table_comment.replace('\\', '\\\\').replace("'", "\\'")
            table_comment_clause = f" COMMENT='{cmt}'"
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4{table_comment_clause};"
    elif db_type == 'postgresql':
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n);"
    elif db_type == 'oracle':
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n);"
    elif db_type == 'mssql':
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n);"
    else:
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n);"

    # 追加索引 DDL
    if index_ddls:
        ddl += "\n" + "\n".join(index_ddls)

    # 追加外键 DDL。外键按约束名分组，支持复合外键。
    fk_map = {}
    for fk in indexes.get("foreign_keys", []) or []:
        fk_map.setdefault(fk.get("name"), []).append(fk)
    for fk_name, fk_rows in fk_map.items():
        if not fk_name or not fk_rows:
            continue
        first = fk_rows[0]
        cols_sql = ", ".join(_safe_ident(f["column"], db_type) for f in fk_rows)
        ref_cols_sql = ", ".join(_safe_ident(f["ref_column"], db_type) for f in fk_rows)
        ref_table = _safe_ident(first["ref_table"], db_type)
        action_delete = _valid_fk_action(first.get("on_delete"))
        action_update = _valid_fk_action(first.get("on_update"))
        if db_type == 'mssql':
            constraint = _safe_ident(fk_name, db_type)
        else:
            constraint = _safe_ident(fk_name, db_type)
        ddl += (
            f"\nALTER TABLE {tbl} ADD CONSTRAINT {constraint} FOREIGN KEY ({cols_sql}) "
            f"REFERENCES {ref_table} ({ref_cols_sql}) ON DELETE {action_delete} ON UPDATE {action_update};"
        )

    # PostgreSQL/Oracle don't support MySQL's inline COMMENT syntax.
    if table_comment and db_type in ('postgresql', 'oracle'):
        escaped = table_comment.replace("'", "''")
        ddl += f"\nCOMMENT ON TABLE {tbl} IS '{escaped}';"
    if db_type in ('postgresql', 'oracle'):
        for c in cols:
            if c.get("comment"):
                escaped = str(c["comment"]).replace("'", "''")
                ddl += f"\nCOMMENT ON COLUMN {tbl}.{_safe_ident(c['name'], db_type)} IS '{escaped}';"

    # SQL Server stores comments as extended properties. Use an upsert so
    # applying the same design/export more than once remains safe.
    if db_type == 'mssql':
        table_name = table_options.get("table_name")
        schema_name = table_options.get("schema") or 'dbo'
        if table_name:
            if table_comment:
                ddl += "\n" + _mssql_comment_upsert_sql(table_comment, schema_name, table_name)
            for c in cols:
                if c.get("comment"):
                    ddl += "\n" + _mssql_comment_upsert_sql(
                        c["comment"], schema_name, table_name, c.get("name")
                    )
    return ddl

def _drag_copy_table_impl(src_conn_data, src_db, table_name, dst_conn_data, dst_db,
                    copy_data=True, new_table_name=None, drop_existing=False, operation_id=None):
    """拖拽复制表：支持跨数据库类型（MySQL/OB/PG/Oracle/MSSQL 互相同步）
    new_table_name: 可选，指定目标表名（用于同库备份场景，备份为带时间戳的副本）
    """
    """拖拽复制表：支持跨数据库类型（MySQL/OB/PG/Oracle/MSSQL 互相同步）"""
    op_state = None
    src_engine = None
    dst_engine = None
    try:
        # 来源连接
        src_data = dict(src_conn_data)
        src_data["db"] = src_db
        src_db_type = src_data.get("db_type", "mysql")
        src_tbl = _build_table_ref(src_data, src_db, table_name)
        src_url = _conn_url(src_data)
        if src_db_type in ('mysql', 'ob-mysql'):
            src_url = src_url.replace("?charset=utf8mb4", "?charset=utf8mb4&connect_timeout=10&read_timeout=30") if "?" in src_url else src_url + "?connect_timeout=10&read_timeout=30"
        src_engine = create_engine(src_url, connect_args=_connect_args(src_db_type, timeout=10))

        # 目标连接
        dst_data = dict(dst_conn_data)
        dst_data["db"] = dst_db
        dst_db_type = dst_data.get("db_type", "mysql")
        op_state = _register_db_operation(operation_id, src_data, 'drag_copy')
        op_state['dst_data'] = dst_data
        # ★ 如果指定了 new_table_name（如同库备份带时间戳的副本），用新表名
        target_table_name = new_table_name if new_table_name else table_name
        dst_tbl = _build_table_ref(dst_data, dst_db, target_table_name)
        dst_url = _conn_url(dst_data)
        if dst_db_type in ('mysql', 'ob-mysql'):
            dst_url = dst_url.replace("?charset=utf8mb4", "?charset=utf8mb4&connect_timeout=10&read_timeout=30") if "?" in dst_url else dst_url + "?connect_timeout=10&read_timeout=30"
        dst_engine = create_engine(dst_url, connect_args=_connect_args(dst_db_type, timeout=10))

        _progress_q.put(("drag_progress", {"percent": 3, "status": "已连接，检查目标表..."}))

        # 1. 检查目标表是否已存在。删除选项只在目标连接/目标数据库上执行，
        #    源连接从未参与 DROP，避免误删源库表。
        target_exists = False
        try:
            with dst_engine.connect() as dc:
                if dst_db_type == 'oracle':
                    dc.execute(text(f"SELECT 1 FROM {dst_tbl} WHERE ROWNUM <= 1"))
                elif dst_db_type == 'mssql':
                    dc.execute(text(f"SELECT TOP 1 1 FROM {dst_tbl}"))
                else:
                    dc.execute(text(f"SELECT 1 FROM {dst_tbl} LIMIT 1"))
            target_exists = True
        except Exception:
            pass

        if target_exists:
            if not drop_existing:
                src_engine.dispose()
                dst_engine.dispose()
                return {"ok": False, "msg": f"目标库中表 [{table_name}] 已存在"}
            try:
                with dst_engine.begin() as dconn:
                    pid = _get_backend_pid(dconn, dst_db_type)
                    _add_db_operation_session(op_state, dst_data, pid, kill_connection=True)
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
                    dconn.execute(text(f"DROP TABLE {dst_tbl}"))
                _progress_q.put(("drag_progress", {"percent": 3, "status": f"已删除目标库同名表 [{table_name}]"}))
            except Exception as e:
                src_engine.dispose()
                dst_engine.dispose()
                return {"ok": False, "msg": f"删除目标库同名表 [{table_name}] 失败: {e}"}

        # 2. 同类型同服务器：用 CREATE TABLE LIKE（最快最可靠）
        _progress_q.put(("drag_progress", {"percent": 5, "status": "正在创建表结构..."}))
        same_type = src_db_type == dst_db_type
        same_server = (src_data.get("host") == dst_data.get("host") and
                       src_data.get("port") == dst_data.get("port"))
        if same_type and same_server and src_db_type in ('mysql', 'ob-mysql'):
            try:
                with src_engine.connect() as sconn:
                    source_table_options = _get_table_sync_info(sconn, src_db_type, src_db, table_name)
                with dst_engine.begin() as dconn:
                    pid = _get_backend_pid(dconn, dst_db_type)
                    _add_db_operation_session(op_state, dst_data, pid, kill_connection=True)
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
                    dconn.execute(text(f"CREATE TABLE {dst_tbl} LIKE {src_tbl}"))
                    # LIKE 会复制列属性（默认值/自增/字段注释），显式补写表注释，兼容不同 MySQL/OB 版本。
                    if source_table_options.get("comment"):
                        dconn.execute(
                            text(f"ALTER TABLE {dst_tbl} COMMENT = :table_comment"),
                            {"table_comment": source_table_options["comment"]}
                        )
            except Exception as e:
                src_engine.dispose(); dst_engine.dispose()
                return {"ok": False, "msg": f"创建表结构失败: {str(e)}"}
        elif same_type and same_server and src_db_type == 'postgresql':
            # PG 语法：CREATE TABLE ... (LIKE ... INCLUDING ALL)
            try:
                with dst_engine.begin() as dconn:
                    pid = _get_backend_pid(dconn, dst_db_type)
                    _add_db_operation_session(op_state, dst_data, pid, kill_connection=True)
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
                    dconn.execute(text(f"CREATE TABLE {dst_tbl} (LIKE {src_tbl} INCLUDING ALL)"))
            except Exception as e:
                src_engine.dispose(); dst_engine.dispose()
                return {"ok": False, "msg": f"创建表结构失败: {str(e)}"}
        else:
            # 跨类型或非 MySQL：统一从源表读取列信息，生成目标方言 DDL
            try:
                with src_engine.connect() as sconn:
                    cols = _get_column_info(sconn, src_db_type, src_db, table_name)
                    # ★ 同时获取索引信息（主键/唯一/普通索引），跨类型迁移不丢失索引
                    idx_info = _get_index_info(sconn, src_db_type, src_db, table_name)
                    table_options = _get_table_sync_info(sconn, src_db_type, src_db, table_name)
                table_options["table_name"] = target_table_name
                if dst_db_type == 'mssql':
                    table_options["schema"] = dst_data.get("schema") or "dbo"

                ddl = _generate_create_table(dst_db_type, dst_tbl, cols, idx_info, table_options)

                with dst_engine.begin() as dconn:
                    pid = _get_backend_pid(dconn, dst_db_type)
                    _add_db_operation_session(op_state, dst_data, pid, kill_connection=True)
                    if _db_operation_cancelled(op_state):
                        _kill_db_operation(op_state)
                        raise RuntimeError("操作已取消")
                    # 注释内容可能包含分号，不能直接使用 str.split(';')。
                    for stmt in _split_sql_statements(ddl):
                        stmt = stmt.strip()
                        if _db_operation_cancelled(op_state):
                            _kill_db_operation(op_state)
                            raise RuntimeError("操作已取消")
                        if stmt: dconn.execute(text(stmt))
            except Exception as e:
                src_engine.dispose(); dst_engine.dispose()
                return {"ok": False, "msg": f"创建表结构失败: {str(e)}"}

        _clear_db_operation_sessions(op_state)
        _progress_q.put(("drag_progress", {"percent": 12, "status": "表结构已创建"}))

        # 仅结构同步：直接完成
        if not copy_data:
            _progress_q.put(("drag_progress", {"percent": 100, "status": "表结构复制完成！"}))
            src_engine.dispose()
            dst_engine.dispose()
            return {"ok": True, "msg": f"表 [{table_name}] 结构已复制到 [{dst_db}]"}

        # 3. 复制数据
        data_ok = True
        if copy_data:
            try:
                _progress_q.put(("drag_progress", {"percent": 15, "status": "正在统计行数..."}))
                # ★ 大表 COUNT(*) 可能很慢，心跳线程检测取消并 kill 数据库会话
                _count_done = threading.Event()
                def _hb_count():
                    while not _count_done.is_set():
                        if _query_cancel.is_set() or _db_operation_cancelled(op_state):
                            _kill_db_operation(op_state)
                        _progress_q.put(("drag_progress", {"percent": 15, "status": "正在统计行数...（大表请耐心等待）"}))
                        threading.Event().wait(5)
                _hb_thread = threading.Thread(target=_hb_count, daemon=True)
                _hb_thread.start()
                try:
                    with src_engine.connect() as sconn:
                        # ★ 记录源库连接 ID，用于 cancel 时 KILL COUNT(*) 查询
                        _query_conn_id = _get_backend_pid(sconn, src_db_type)
                        _query_src_data = src_data
                        _add_db_operation_session(op_state, src_data, _query_conn_id, kill_connection=False)
                        if _db_operation_cancelled(op_state):
                            _kill_db_operation(op_state)
                            raise RuntimeError("操作已取消")
                        total_rows = sconn.execute(text(f"SELECT COUNT(*) FROM {src_tbl}")).scalar()
                except Exception:
                    if _query_cancel.is_set():
                        _progress_q.put(("drag_progress", {"percent": 100, "status": "已取消"}))
                        return {"ok": False, "msg": "操作已取消", "cancelled": True}
                    raise
                finally:
                    _query_conn_id = None
                    _query_src_data = None
                    _clear_db_operation_sessions(op_state)
                    _count_done.set()
                    _hb_thread.join(timeout=1)
                _progress_q.put(("drag_progress", {"percent": 20, "status": f"共 {total_rows:,} 行，开始复制..."}))

                # ★ 每 10000 行更新一次进度，心跳线程也带实际行数（不裸显示"复制中"）
                # ★ 使用 stream_results + yield_per 避免 SQLAlchemy 一次缓冲全部行（大表可达数 GB）
                _copy_done = threading.Event()
                _last_pct = [20]
                _last_total = [0]
                _last_sent = [time.time()]
                _total_rows = total_rows
                def _hb_copy():
                    while not _copy_done.is_set():
                        threading.Event().wait(3)
                        if not _copy_done.is_set() and time.time() - _last_sent[0] > 2.5:
                            _progress_q.put(("drag_progress", {"percent": _last_pct[0], "status": f"已复制 {_last_total[0]:,} / {_total_rows:,} 行..."}))
                _hb_copy_thread = threading.Thread(target=_hb_copy, daemon=True)
                _hb_copy_thread.start()
                try:
                    with src_engine.connect() as sconn:
                        # ★ 记录新连接 PID（与 COUNT(*) 是不同的连接），用于 cancel 时 KILL SELECT * 查询
                        _query_conn_id = _get_backend_pid(sconn, src_db_type)
                        _query_src_data = src_data
                        _add_db_operation_session(op_state, src_data, _query_conn_id, kill_connection=False)
                        if _db_operation_cancelled(op_state):
                            _kill_db_operation(op_state)
                            raise RuntimeError("操作已取消")
                        # stream_results + yield_per：只从服务器逐批取 2000 行，不全量缓冲
                        result = sconn.execution_options(
                            stream_results=True, yield_per=2000
                        ).execute(text(f"SELECT * FROM {src_tbl}"))
                        columns = list(result.keys())
                        cols_str = tuple(columns)
                        batch = []
                        batch_size = 5000
                        total = 0
                        with dst_engine.begin() as dconn:
                            dst_pid = _get_backend_pid(dconn, dst_db_type)
                            _add_db_operation_session(op_state, dst_data, dst_pid, kill_connection=True)
                            if _db_operation_cancelled(op_state):
                                _kill_db_operation(op_state)
                                raise RuntimeError("操作已取消")
                            for row in result:
                                row_dict = dict(zip(cols_str, row))
                                batch.append(row_dict)
                                if len(batch) >= batch_size:
                                    _batch_insert(dconn, dst_tbl, columns, batch)
                                    total += len(batch)
                                    pct = 20 + int((total / max(total_rows, 1)) * 75)
                                    _last_pct[0] = min(pct, 95)
                                    _last_total[0] = total
                                    _last_sent[0] = time.time()
                                    _progress_q.put(("drag_progress", {"percent": _last_pct[0], "status": f"已复制 {total:,} / {total_rows:,} 行"}))
                                    # ★ 主动释放旧 batch 内存，避免 GC 惰性导致积压
                                    del batch
                                    gc.collect()
                                    batch = []
                                if _query_cancel.is_set() or _db_operation_cancelled(op_state):
                                    _kill_db_operation(op_state)
                                    raise RuntimeError("操作已取消")
                            if batch and not _query_cancel.is_set() and not _db_operation_cancelled(op_state):
                                _batch_insert(dconn, dst_tbl, columns, batch)
                                total += len(batch)
                                _last_total[0] = total
                                _last_sent[0] = time.time()
                                _progress_q.put(("drag_progress", {"percent": 98, "status": f"已复制 {total:,} / {total_rows:,} 行"}))
                                del batch
                                gc.collect()
                except Exception:
                    if _query_cancel.is_set() or _db_operation_cancelled(op_state):
                        data_ok = False  # 已取消，数据库会话已被 kill
                    else:
                        raise
                finally:
                    _query_conn_id = None
                    _query_src_data = None
                    _copy_done.set()
                    _hb_copy_thread.join(timeout=1)
                _progress_q.put(("drag_progress", {"percent": 100, "status": "复制完成！"}))
            except Exception as e:
                data_ok = False
                if _query_cancel.is_set() or _db_operation_cancelled(op_state):
                    _progress_q.put(("drag_progress", {"percent": 100, "status": "已取消"}))
                    return {"ok": False, "msg": "操作已取消", "cancelled": True}
                _progress_q.put(("drag_progress", {"percent": 100, "status": f"错误: {e}"}))
                # 表结构已创建，数据复制失败
                return {"ok": True, "msg": f"表结构已创建，但数据复制失败: {e}", "partial": True}

        if _query_cancel.is_set() or _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        src_engine.dispose()
        dst_engine.dispose()
        msg = f"表 [{table_name}] 已复制到 [{dst_db}]"
        if copy_data and data_ok:
            msg += f"，共 {total} 行" if 'total' in dir() else ""
        return {"ok": True, "msg": msg}
    except Exception as e:
        if _query_cancel.is_set() or _db_operation_cancelled(op_state):
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": str(e)}
    finally:
        for eng in (src_engine, dst_engine):
            if eng is not None:
                try:
                    eng.dispose()
                except Exception:
                    pass
        _finish_db_operation(op_state)


@eel.expose
@_progress_guard('drag_copy')
def drag_copy_table(src_conn_data, src_db, table_name, dst_conn_data, dst_db,
                    copy_data=True, new_table_name=None, drop_existing=False):
    """单表拖拽复制入口，和批量复制共享同一进度任务互斥。"""
    return _drag_copy_table_impl(
        src_conn_data, src_db, table_name, dst_conn_data, dst_db,
        copy_data, new_table_name, drop_existing
    )


@eel.expose
@_progress_guard('drag_copy')
def drag_copy_tables(src_conn_data, src_db, table_names, dst_conn_data, dst_db,
                     copy_data=True, drop_existing=False):
    """批量导入表。每张表独立复制，DROP 只针对目标库同名表。"""
    try:
        if isinstance(table_names, str):
            table_names = [table_names]
        names = []
        for name in (table_names or []):
            name = str(name or '').strip()
            if name and name not in names:
                names.append(name)
        if not names:
            return {"ok": False, "msg": "未选择要导入的表"}

        _query_cancel.clear()
        results = []
        total = len(names)

        # 批量导入前一次性检查目标库，避免前面的表已经导入后才在中途发现重名。
        if not drop_existing:
            _progress_q.put(("drag_progress", {
                "percent": 0,
                "status": "正在检查目标库是否存在同名表...",
                "table_total": total
            }))
            dst_data = dict(dst_conn_data)
            dst_data["db"] = dst_db
            dst_db_type = dst_data.get("db_type", "mysql")
            dst_engine = None
            existing = []
            try:
                dst_url = _conn_url(dst_data)
                if dst_db_type in ('mysql', 'ob-mysql'):
                    dst_url = (dst_url.replace("?charset=utf8mb4", "?charset=utf8mb4&connect_timeout=10&read_timeout=30")
                               if "?" in dst_url else dst_url + "?connect_timeout=10&read_timeout=30")
                dst_engine = create_engine(dst_url, connect_args=_connect_args(dst_db_type, timeout=10))
                with dst_engine.connect() as dc:
                    for name in names:
                        dst_tbl = _build_table_ref(dst_data, dst_db, name)
                        try:
                            if dst_db_type == 'oracle':
                                dc.execute(text(f"SELECT 1 FROM {dst_tbl} WHERE ROWNUM <= 1"))
                            elif dst_db_type == 'mssql':
                                dc.execute(text(f"SELECT TOP 1 1 FROM {dst_tbl}"))
                            else:
                                dc.execute(text(f"SELECT 1 FROM {dst_tbl} LIMIT 1"))
                            existing.append(name)
                        except Exception:
                            pass
            except Exception as e:
                return {"ok": False, "precheck": True, "msg": f"导入前检查目标表失败：{e}"}
            finally:
                if dst_engine is not None:
                    dst_engine.dispose()
            if existing:
                msg = "目标库已存在同名表：" + "、".join(f"[{name}]" for name in existing) + \
                      "。请勾选‘导入前删除目标库中同名表’，或先处理这些表后再导入。"
                _progress_q.put(("drag_progress", {
                    "percent": 0,
                    "status": "发现目标库同名表，导入已停止",
                    "table_total": total
                }))
                return {"ok": False, "precheck": True, "existing_tables": existing, "msg": msg}

        for index, name in enumerate(names):
            if _query_cancel.is_set():
                return {"ok": False, "cancelled": True, "msg": "操作已取消",
                        "total": total, "succeeded": len([x for x in results if x.get('ok')]),
                        "failed": len([x for x in results if not x.get('ok')]), "results": results}
            _progress_q.put(("drag_progress", {
                "percent": int(index * 100 / total),
                "status": f"正在导入第 {index + 1}/{total} 张表：{name}",
                "table_index": index + 1,
                "table_total": total,
                "table_name": name
            }))
            result = _drag_copy_table_impl(src_conn_data, src_db, name, dst_conn_data, dst_db,
                                     copy_data, None, drop_existing)
            results.append({"table": name, **(result or {"ok": False, "msg": "无响应"})})
            # drag_copy_table 内部按表使用独立的 begin 事务；函数返回表示该表已提交，
            # 在开始下一张表前明确通知前端，避免用户误以为全部表结束后才提交。
            _progress_q.put(("drag_progress", {
                "percent": int((index + 1) * 100 / total),
                "status": (f"第 {index + 1}/{total} 张表已导入并提交：{name}"
                           if result and result.get("ok") and not result.get("partial")
                           else (f"第 {index + 1}/{total} 张表结构已提交，数据导入部分失败：{name}"
                                 if result and result.get("partial")
                                 else f"第 {index + 1}/{total} 张表处理完成：{name}")),
                "table_index": index + 1,
                "table_total": total,
                "table_name": name,
                "committed": bool(result and result.get("ok") and not result.get("partial"))
            }))
            if result and result.get("cancelled"):
                return {"ok": False, "cancelled": True, "msg": "操作已取消",
                        "total": total, "succeeded": len([x for x in results if x.get('ok')]),
                        "failed": len([x for x in results if not x.get('ok')]), "results": results}

        succeeded = [x for x in results if x.get("ok")]
        failed = [x for x in results if not x.get("ok")]
        _progress_q.put(("drag_progress", {
            "percent": 100,
            "status": f"导入完成：成功 {len(succeeded)} 张，失败 {len(failed)} 张"
        }))
        if failed:
            msg = "；".join(f"[{x['table']}] {x.get('msg', '失败')}" for x in failed)
            return {"ok": False, "partial": bool(succeeded), "msg": msg,
                    "total": total, "succeeded": len(succeeded), "failed": len(failed),
                    "results": results}
        return {"ok": True, "msg": f"已成功导入 {len(succeeded)} 张表到目标库 [{dst_db}]",
                "total": total, "succeeded": len(succeeded), "failed": 0, "results": results}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _batch_insert(conn, tbl, columns, batch):
    """批量插入数据"""
    if not batch:
        return
    col_names = ", ".join(columns)
    placeholders = ", ".join([f":{c}" for c in columns])
    sql = f"INSERT INTO {tbl} ({col_names}) VALUES ({placeholders})"
    conn.execute(text(sql), batch)


# ==================== 导出导入向导 ====================

@eel.expose
def export_wizard_get_tables(conn_data, database, schema=''):
    """获取数据库中的表列表"""
    engine = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        # ★ 用同步版获取表列表：db_explore_get_tables 已改为异步返回 job_id，不能直接消费
        tables = _db_explore_get_tables_sync(cdata, database, schema or '')
        engine.dispose()
        if isinstance(tables, dict) and tables.get("ok"):
            return {"ok": True, "tables": [t["name"] for t in tables["tables"]]}
        return {"ok": False, "msg": "获取失败"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                pass


@eel.expose
def export_wizard_get_columns(conn_data, database, table_name, schema=''):
    """获取表的列信息"""
    engine = None
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                rows = conn.execute(text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
                ), {"db": database, "tbl": table_name}).fetchall()
            else:
                design_result = table_get_design_info(cdata, database, table_name, schema)
                if not design_result.get("ok"):
                    engine.dispose()
                    return {"ok": False, "msg": design_result.get("msg", "获取列信息失败")}
                engine.dispose()
                return {"ok": True, "columns": [c.get("name") for c in design_result.get("design", {}).get("columns", [])]}
        engine.dispose()
        return {"ok": True, "columns": [r[0] for r in rows]}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                pass


def _export_run(data, tables, settings, out_path):
    """后台执行导出（SQL / CSV）"""
    engine = None
    try:
        cdata = dict(data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql',):
            cdata["db"] = data.get("db", "")
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        export_fmt = settings.get("format", "sql")
        scope = settings.get("scope", "full")  # structure / data / full
        col_selections = settings.get("columns", {})  # {table: [col1, col2]}
        csv_header = settings.get("csv_header", False)  # CSV 是否包含标题行

        total_tables = len(tables)
        total_all = 0
        processed_all = 0

        with open(out_path, "w", encoding="utf-8") as f:
            if export_fmt == "sql":
                f.write("-- 导出时间: " + time.strftime("%Y-%m-%d %H:%M:%S") + "\n")
                f.write("-- 数据库: " + str(data.get("db", "")) + "\n\n")
                if db_type in ('mysql', 'ob-mysql'):
                    f.write("SET FOREIGN_KEY_CHECKS = 0;\n\n")

            for ti, tn in enumerate(tables):
                tbl = _build_table_ref(cdata, data.get("db", ""), tn)
                # 输出 SQL 中统一使用方言安全引用，不能直接拼接表名。
                tbl_out = _safe_ident(tn, db_type)
                cols = col_selections.get(tn, [])
                if not cols:
                    with engine.connect() as conn:
                        if db_type in ('mysql', 'ob-mysql'):
                            cr = conn.execute(text(
                                "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                                "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
                            ), {"db": data.get("db", ""), "tbl": tn}).fetchall()
                            cols = [r[0] for r in cr]
                        else:
                            design_result = table_get_design_info(cdata, data.get("db", ""), tn, schema)
                            cols = [c.get("name") for c in (design_result.get("design", {}).get("columns", []) if design_result.get("ok") else [])]

                if not cols:
                    continue

                col_quoted = ", ".join(_safe_ident(c, db_type) for c in cols)
                col_plain = ", ".join(cols)

                if scope in ("structure", "full") and export_fmt == "sql":
                    ddl_result = table_get_ddl(cdata, data.get("db", ""), tn, schema)
                    if not ddl_result.get("ok"):
                        raise RuntimeError(ddl_result.get("msg", "获取表结构失败"))
                    ddl = ddl_result.get("ddl", "")
                    f.write(f"DROP TABLE IF EXISTS {tbl_out};\n")
                    f.write(ddl + ";\n\n")

                if scope in ("data", "full"):
                    with engine.connect() as sconn:
                        result = sconn.execute(text(f"SELECT {col_quoted} FROM {tbl}"))
                        if export_fmt == "csv" and csv_header:
                            f.write(col_plain + "\n")
                        batch = []
                        row_count = 0
                        for row in result:
                            vals = []
                            for v in row:
                                if v is None:
                                    vals.append("NULL")
                                elif isinstance(v, (int, float)):
                                    vals.append(str(v))
                                else:
                                    vals.append("'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'")
                            batch.append("(" + ", ".join(vals) + ")")
                            row_count += 1
                            if len(batch) >= 500:
                                if export_fmt == "sql":
                                    f.write(f"INSERT INTO {tbl_out} ({col_quoted}) VALUES\n")
                                    f.write(",\n".join(batch) + ";\n")
                                else:
                                    f.write("\n".join(batch) + "\n")
                                batch = []
                                processed_all += 500
                                _progress_q.put(("export_progress", {
                                    "table": tn, "table_index": ti + 1, "total_tables": total_tables,
                                    "total": total_all or row_count, "processed": processed_all,
                                    "time": time.strftime("%H:%M:%S")
                                }))
                        if batch:
                            if export_fmt == "sql":
                                f.write(f"INSERT INTO {tbl_out} ({col_quoted}) VALUES\n")
                                f.write(",\n".join(batch) + ";\n")
                            else:
                                f.write("\n".join(batch) + "\n")
                            processed_all += len(batch)
                        total_all += row_count

                _progress_q.put(("export_progress", {
                    "table": tn, "table_index": ti + 1, "total_tables": total_tables,
                    "total": total_all, "processed": processed_all,
                    "time": time.strftime("%H:%M:%S"), "table_done": True
                }))
                _progress_q.put(("export_log", {"msg": f"✅ {tn} 导出完成，共 {total_all} 行", "level": "ok"}))

            if export_fmt == "sql" and db_type in ('mysql', 'ob-mysql'):
                f.write("\nSET FOREIGN_KEY_CHECKS = 1;\n")

        engine.dispose()
        _progress_q.put(("export_done", {"path": out_path}))
    except Exception as e:
        _progress_q.put(("export_error", {"msg": str(e)}))
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                pass


@eel.expose
def export_wizard_start(conn_data, database, tables, settings, schema=''):
    """启动导出（后台线程，自动生成文件名到桌面）"""
    if not _claim_progress_task('export'):
        return {"ok": False, "msg": "已有导入、导出或同步任务正在运行，请稍后再试"}
    data = dict(conn_data)
    if data.get('db_type') not in ('postgresql',):
        data["db"] = database
    ext = ".sql" if settings.get("format", "sql") == "sql" else ".csv"
    ts = time.strftime("%Y%m%d_%H%M%S")
    safe_database = re.sub(r'[^\w\u0080-\uffff.-]+', '_', str(database or 'database')).strip('._') or 'database'
    out_path = os.path.join(BASE_DIR, f"export_{safe_database}_{ts}{ext}")
    def _run_export():
        try:
            _export_run(data, tables, settings, out_path)
        finally:
            _release_progress_task('export')
    threading.Thread(target=_run_export, daemon=True).start()
    return {"ok": True, "msg": "导出已启动"}  


@eel.expose
def export_pick_file(fmt='sql'):
    """打开文件保存对话框，返回路径（fmt: 'csv' | 'sql'）"""
    import tkinter.filedialog as fd, tkinter
    root = tkinter.Tk(); root.withdraw(); root.attributes('-topmost', True)
    if fmt == 'csv':
        def_ext = '.csv'
        filetypes = [("CSV文件", "*.csv"), ("所有文件", "*.*")]
    else:
        def_ext = '.sql'
        filetypes = [("SQL文件", "*.sql"), ("所有文件", "*.*")]
    path = fd.asksaveasfilename(
        title="选择导出位置", defaultextension=def_ext, filetypes=filetypes
    )
    root.destroy()
    return path or ""


@eel.expose
def export_query_save(path, content, rows=0):
    """后台保存查询导出内容，向前端推送写入进度。rows 为导出行数"""
    if not _claim_progress_task('query_export'):
        return {"ok": False, "msg": "已有导入、导出或同步任务正在运行，请稍后再试"}
    def _run_query_export():
        try:
            _export_query_write(path, content, rows)
        finally:
            _release_progress_task('query_export')
    threading.Thread(target=_run_query_export, daemon=True).start()
    return {"ok": True}


def _export_query_write(path, content, rows=0):
    """分块写入文件并推送进度"""
    try:
        total = len(content)
        chunk_size = 512 * 1024  # 512KB chunks
        written = 0
        with open(path, 'w', encoding='utf-8') as f:
            while written < total:
                end = min(written + chunk_size, total)
                f.write(content[written:end])
                written = end
                pct = round((written / total) * 100)
                _progress_q.put(("query_export_progress", {"pct": pct, "written": written, "total": total}))
        _progress_q.put(("export_done", {"path": path, "written": total, "rows": rows}))
    except Exception as e:
        import traceback
        err_detail = traceback.format_exc()
        _progress_q.put(("export_error", {"msg": str(e), "detail": err_detail}))


@eel.expose
def pick_open_file():
    """打开文件选择对话框（用于导入）"""
    import tkinter.filedialog as fd, tkinter
    root = tkinter.Tk(); root.withdraw(); root.attributes('-topmost', True)
    path = fd.askopenfilename(
        title="选择文件", filetypes=[("SQL文件", "*.sql"), ("CSV文件", "*.csv"), ("所有文件", "*.*")]
    )
    root.destroy()
    return path or ""


def _split_sql_statements(text):
    """拆分常见 SQL 方言脚本。

    支持引号、反引号、SQL Server 方括号、行/块注释、PostgreSQL
    dollar quote、MySQL DELIMITER 和 SQL Server 独占行 GO。复杂的
    PL/SQL/存储过程仍建议使用对应数据库客户端导入，不把简单扫描器
    当作完整 SQL 解析器。
    """
    if not text:
        return []
    stmts, buf = [], []
    delimiter = ';'
    in_single = in_double = in_backtick = in_bracket = False
    in_line_comment = in_block_comment = False
    dollar_tag = None
    i = 0

    def flush():
        stmt = ''.join(buf).strip()
        if stmt and not all(line.lstrip().startswith(('--', '#', '/*', '*')) or not line.strip()
                            for line in stmt.splitlines()):
            stmts.append(stmt)
        buf.clear()

    lines = str(text).replace('\r\n', '\n').replace('\r', '\n').splitlines(True)
    content = ''.join(lines)
    while i < len(content):
        # DELIMITER 必须是独占行，且只能在非引号状态下改变分隔符。
        if not any((in_single, in_double, in_backtick, in_bracket, in_block_comment, dollar_tag)):
            line_end = content.find('\n', i)
            if line_end < 0:
                line_end = len(content)
            line = content[i:line_end].strip()
            match = re.match(r'^DELIMITER\s+(\S+)\s*$', line, re.I)
            if match:
                delimiter = match.group(1)
                i = line_end + (1 if line_end < len(content) else 0)
                continue
            if line.upper() == 'GO':
                flush()
                i = line_end + (1 if line_end < len(content) else 0)
                continue

        ch = content[i]
        nxt = content[i + 1] if i + 1 < len(content) else ''
        if in_line_comment:
            buf.append(ch)
            if ch == '\n':
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            buf.append(ch)
            if ch == '*' and nxt == '/':
                buf.append(nxt)
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue
        if not any((in_single, in_double, in_backtick, in_bracket)) and delimiter != ';' and content.startswith(delimiter, i):
            flush()
            i += len(delimiter)
            continue
        if dollar_tag:
            if content.startswith(dollar_tag, i):
                buf.extend(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
            else:
                buf.append(ch)
                i += 1
            continue
        if not any((in_single, in_double, in_backtick, in_bracket)):
            if content.startswith('--', i) or ch == '#':
                in_line_comment = True
                buf.append(ch)
                if content.startswith('--', i):
                    buf.append(nxt)
                    i += 2
                else:
                    i += 1
                continue
            if content.startswith('/*', i):
                in_block_comment = True
                buf.extend(('/*',))
                i += 2
                continue
            if ch == '$':
                tag_match = re.match(r'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$', content[i:])
                if tag_match:
                    dollar_tag = tag_match.group(0)
                    buf.extend(dollar_tag)
                    i += len(dollar_tag)
                    continue
        if ch == '\\' and in_single:
            buf.append(ch)
            if i + 1 < len(content):
                buf.append(content[i + 1])
                i += 2
            else:
                i += 1
            continue
        if ch == "'" and not any((in_double, in_backtick, in_bracket)):
            if in_single and nxt == "'":
                buf.extend((ch, nxt)); i += 2; continue
            in_single = not in_single
        elif ch == '"' and not any((in_single, in_backtick, in_bracket)):
            in_double = not in_double
        elif ch == '`' and not any((in_single, in_double, in_bracket)):
            in_backtick = not in_backtick
        elif ch == '[' and not any((in_single, in_double, in_backtick)):
            in_bracket = True
        elif ch == ']' and in_bracket:
            in_bracket = False
        if not any((in_single, in_double, in_backtick, in_bracket)) and content.startswith(delimiter, i):
            flush()
            i += len(delimiter)
            continue
        buf.append(ch)
        i += 1
    flush()
    return stmts


@eel.expose
def save_import_file(content, filename):
    """将前端读取的文件内容保存到临时文件，返回路径"""
    try:
        tmpdir = os.path.join(BASE_DIR, "temp")
        os.makedirs(tmpdir, exist_ok=True)
        raw_name = str(filename or '')
        safe_name = os.path.basename(raw_name)
        if not safe_name or safe_name in ('.', '..') or safe_name != raw_name:
            return ""
        if os.path.splitext(safe_name)[1].lower() not in ('.sql', '.csv', '.txt'):
            return ""
        # 使用随机前缀，避免不同页面覆盖同名临时文件。
        path = os.path.join(tmpdir, f"{uuid.uuid4().hex}_{safe_name}")
        real_tmpdir = os.path.realpath(tmpdir)
        real_path = os.path.realpath(path)
        if os.path.commonpath((real_tmpdir, real_path)) != real_tmpdir:
            return ""
        with open(real_path, "w", encoding="utf-8", errors="replace") as f:
            f.write(content)
        return real_path
    except Exception as e:
        return ""


@eel.expose
def import_wizard_run(conn_data, database, file_path, file_type, schema='', content='', file_name='', drop_existing=False, operation_id=None):
    """导入向导执行（后台线程）。drop_existing 只删除目标库同名表。"""
    if not _claim_progress_task('import'):
        return {"ok": False, "msg": "已有导入、导出或同步任务正在运行，请稍后再试"}
    op_data = dict(conn_data or {})
    op_db_type = op_data.get('db_type', 'mysql')
    if op_db_type != 'oracle':
        op_data['db'] = database
    op_state = _register_db_operation(operation_id, op_data, 'import_file')
    def _check_db_prefix(content, db_type, target_db):
        """检查脚本是否切换数据库或包含跨库高危管理语句。"""
        if re.search(r'(?im)^\s*(DROP|CREATE|ALTER)\s+DATABASE\b', content):
            return (False, "SQL 文件包含数据库级管理语句，导入向导禁止执行 DROP/CREATE/ALTER DATABASE")
        if re.search(r'(?im)^\s*SET\s+search_path\s*=', content):
            return (False, "SQL 文件包含 SET search_path，可能切换 PostgreSQL 目标 schema，请在目标库中明确设置后再导入")
        use_matches = re.findall(r'(?im)^\s*USE\s+([`\"\[]?)([^`\"\]\s;]+)[`\"\]]?\s*;?', content)
        for quote, used_db in use_matches:
            if used_db != target_db:
                return (False, f"SQL 文件尝试切换到数据库 [{used_db}]，与当前目标数据库 [{target_db}] 不一致")
        imported_dbs = set()
        if db_type in ('mysql', 'ob-mysql'):
            # 匹配 `dbname`.`tablename` 格式
            matches = re.findall(r'`([^`]+)`\.`([^`]+)`', content)
            imported_dbs = {m[0] for m in matches}
        elif db_type == 'postgresql':
            matches = re.findall(r'"([^"]+)"\."([^"]+)"', content)
            imported_dbs = {m[0] for m in matches}
        elif db_type == 'mssql':
            matches = re.findall(r'\[([^\]]+)\]\.\[([^\]]+)\]', content)
            imported_dbs = {m[0] for m in matches}
        if imported_dbs:
            for imp_db in imported_dbs:
                if imp_db != target_db:
                    return (False, f"SQL 文件中引用了数据库 [{imp_db}]，与当前目标数据库 [{target_db}] 不一致，请更换数据库后重试")
            return (True, "")
        return (True, "")

    def _run():
        engine = None
        try:
            cdata = dict(conn_data)
            db_type = cdata.get('db_type', 'mysql')
            if db_type != 'oracle':
                cdata["db"] = database
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
            if _db_operation_cancelled(op_state):
                raise RuntimeError("操作已取消")

            if content:
                sql_content = content
            else:
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    sql_content = f.read()

            if file_type == "sql":
                # 检查数据库前缀是否匹配
                ok, err = _check_db_prefix(sql_content, db_type, database)
                if not ok:
                    _progress_q.put(("import_error", {"msg": err}))
                    engine.dispose()
                    return
                statements = _split_sql_statements(sql_content)
                total = len(statements)
                done = 0
                _progress_q.put(("import_progress", {"total": total, "processed": 0, "time": time.strftime("%H:%M:%S")}))
                with engine.begin() as conn:
                    pid = _get_backend_pid(conn, db_type)
                    _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
                    for stmt in statements:
                        if _db_operation_cancelled(op_state):
                            _kill_db_operation(op_state)
                            raise RuntimeError("操作已取消")
                        try:
                            conn.execute(text(stmt))
                            done += 1
                            if _db_operation_cancelled(op_state):
                                _kill_db_operation(op_state)
                                raise RuntimeError("操作已取消")
                            # 记录 SQL 导入日志
                            stmt_upper = stmt.strip().upper()
                            if stmt_upper.startswith("SELECT"):
                                _log_db_select(stmt)
                            elif stmt_upper.startswith("INSERT"):
                                _log_db_insert(stmt)
                            elif stmt_upper.startswith("UPDATE"):
                                _log_db_update(stmt)
                            elif stmt_upper.startswith("DELETE") or stmt_upper.startswith("TRUNCATE") or stmt_upper.startswith("DROP"):
                                _log_db_delete(stmt)
                            elif stmt_upper.startswith("SET ") or stmt_upper.startswith("COMMIT") or stmt_upper.startswith("ROLLBACK") or stmt_upper.startswith("BEGIN"):
                                pass
                            else:
                                _db_op_logger.info(f"[EXEC] {stmt}")
                            if done % 50 == 0:
                                _progress_q.put(("import_progress", {"total": total, "processed": done, "time": time.strftime("%H:%M:%S")}))
                        except Exception as se:
                            # 默认遇错停止并回滚，避免把“部分成功”误报成完成。
                            raise RuntimeError(
                                f"第 {done + 1} 条 SQL 执行失败，已回滚：{str(se)[:200]}"
                            ) from se
                _progress_q.put(("import_done", {"total": total, "processed": done}))

            elif file_type == "csv":
                import csv, io
                reader = csv.reader(io.StringIO(content))
                header = next(reader, None)
                if not header:
                    _progress_q.put(("import_error", {"msg": "CSV 文件无标题行"}))
                    return
                # ★ 过滤空白/无意义表头列（如行末多余逗号产生的空列），并记录有效列索引
                _strip_n = lambda s: (s or '').strip()
                _valid = [i for i, h in enumerate(header) if _strip_n(h)]
                if len(_valid) < len(header):
                    # 表头被精简，逐行过滤对应列，不能把整个文件再次读入内存。
                    def _filtered_rows(source, valid_indices):
                        for row in source:
                            yield [row[i] if i < len(row) else '' for i in valid_indices]
                    header = [_strip_n(header[i]) for i in _valid]
                    reader = _filtered_rows(reader, _valid)
                else:
                    header = [_strip_n(h) for h in header]
                # ★ 表名推导：优先 file_path，其次 file_name，均为空则用 schema 或默认值
                if file_path:
                    tbl_name = os.path.splitext(os.path.basename(file_path))[0]
                elif file_name:
                    tbl_name = os.path.splitext(os.path.basename(file_name))[0]
                else:
                    tbl_name = schema or 'import_data'
                # 安全标识：只保留原始名称，最终 SQL 由 _safe_ident 负责引用。
                try:
                    tbl_name = re.sub(r'[^\w\u0080-\uffff.-]+', '_', tbl_name).strip('._') or 'import_data'
                except Exception:
                    tbl_name = ''.join(ch for ch in tbl_name if ch.isalnum() or ch == '_') or 'import_data'
                tbl = _build_table_ref(cdata, database, tbl_name)
                cols = ", ".join(_safe_ident(h, db_type) for h in header)
                ph = ", ".join(":" + h for h in header)
                # 流式读取 CSV，避免大文件一次性 materialize 到内存。
                total = None
                _progress_q.put(("import_progress", {"total": total, "processed": 0, "time": time.strftime("%H:%M:%S")}))
                batch = []
                batch_size = 5000
                processed = 0
                with engine.begin() as conn:
                    pid = _get_backend_pid(conn, db_type)
                    _add_db_operation_session(op_state, cdata, pid, kill_connection=False)
                    # 判断表是否已存在（不删除原表模式需要）
                    def _table_exists():
                        try:
                            if db_type == 'oracle':
                                sql = (f"SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER = UPPER('{cdata.get('user','')}') "
                                       f"AND TABLE_NAME = UPPER('{tbl_name}')")
                            elif db_type == 'postgresql':
                                sql = (f"SELECT COUNT(*) FROM information_schema.tables "
                                       f"WHERE table_schema = '{cdata.get('db','public')}' AND table_name = '{tbl_name}'")
                            else:
                                sql = (f"SELECT COUNT(*) FROM information_schema.tables "
                                       f"WHERE table_schema = DATABASE() AND table_name = '{tbl_name}'")
                            return bool(conn.execute(text(sql)).scalar())
                        except Exception:
                            return False
                    existed = _table_exists() if not drop_existing else False

                    if not existed:
                        # 表不存在 → 删除残留（若有）并建表
                        if drop_existing:
                            conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))
                            _log_db_delete(f"DROP TABLE IF EXISTS {tbl}")
                        col_defs = ", ".join(f"{_safe_ident(h, db_type)} TEXT" for h in header)
                        create_sql = f"CREATE TABLE {tbl} ({col_defs})"
                        conn.execute(text(create_sql))
                        _db_op_logger.info(f"[DDL] {create_sql}")
                    else:
                        # 不删除原表：表已存在，直接追加（不建表、不删表）
                        _log_db_insert(f"表 {tbl_name} 已存在，跳过建表，追加导入 {total} 行")

                    insert_template = f"INSERT INTO {tbl} ({cols}) VALUES ({ph})"
                    _log_db_insert(f"{insert_template}  -- 共 {total} 行（批量导入）")
                    for row in reader:
                        if _db_operation_cancelled(op_state):
                            _kill_db_operation(op_state)
                            raise RuntimeError("操作已取消")
                        batch.append(dict(zip(header, row)))
                        processed += 1
                        if len(batch) >= batch_size:
                            conn.execute(text(insert_template), batch)
                            batch = []
                            _progress_q.put(("import_progress", {"total": None, "processed": processed, "time": time.strftime("%H:%M:%S")}))
                    if batch:
                        conn.execute(text(insert_template), batch)
                _progress_q.put(("import_done", {"total": processed, "processed": processed}))

        except Exception as e:
            if _db_operation_cancelled(op_state):
                _progress_q.put(("import_error", {"msg": "操作已取消", "cancelled": True}))
            else:
                _progress_q.put(("import_error", {"msg": str(e)}))
        finally:
            if engine is not None:
                try:
                    engine.dispose()
                except Exception:
                    pass
            _release_progress_task('import')
            _finish_db_operation(op_state)

    threading.Thread(target=_run, daemon=True).start()
    return True


# ==================== 慢 SQL 查询分析 ====================

@eel.expose
def slow_query_get_databases(data: dict):
    """获取慢查询可用的数据库列表（需要连接信息）"""
    try:
        cdata = _normalize_conn_data(data)
        db_type = cdata.get("db_type", "mysql")
        if db_type not in ('mysql', 'ob-mysql'):
            return {"ok": False, "msg": "慢SQL查询仅支持 MySQL / OceanBase 数据库"}
        url_no_db = (f"mysql+mysqldb://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:{cdata.get('port','3306')}"
                     f"?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=10))
        with engine.connect() as conn:
            result = conn.execute(text(
                "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA "
                "ORDER BY SCHEMA_NAME"
            ))
            dbs = [r[0] for r in result.fetchall()]
        engine.dispose()
        return {"ok": True, "databases": dbs}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def slow_query_check_enabled(data: dict):
    """检查慢查询是否已开启（MySQL 用 slow_query_log，OceanBase 用 SQL_AUDIT）"""
    try:
        cdata = _normalize_conn_data(data)
        db_type = cdata.get("db_type", "mysql")
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args("mysql", timeout=10))
        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # OceanBase：检查 ob_enable_sql_audit（审计视图是否可用）
                try:
                    row = conn.execute(text(
                        "SHOW VARIABLES LIKE 'ob_enable_sql_audit'"
                    )).fetchone()
                except Exception:
                    row = None
                enabled = row[1] == 'ON' if row else True  # OB 默认开启 SQL 审计

                # 尝试获取 SQL 审计百分比
                try:
                    pct_row = conn.execute(text(
                        "SHOW VARIABLES LIKE 'ob_sql_audit_percentage'"
                    )).fetchone()
                    audit_pct = int(pct_row[1]) if pct_row else 100
                except Exception:
                    audit_pct = 100

                # OB 阈值用 trace_log_slow_query_watermark
                try:
                    th_row = conn.execute(text(
                        "SHOW VARIABLES LIKE 'trace_log_slow_query_watermark'"
                    )).fetchone()
                except Exception:
                    th_row = None
                if th_row:
                    threshold = _parse_ob_time_to_sec(th_row[1])
                else:
                    threshold = 1.0

                log_file = f"SQL审计采样率: {audit_pct}% (查询 oceanbase.GV$OB_SQL_AUDIT)"
            else:
                # MySQL：检查 slow_query_log 是否开启
                row = conn.execute(text(
                    "SHOW VARIABLES LIKE 'slow_query_log'"
                )).fetchone()
                enabled = row[1] == 'ON' if row else False

                # 获取慢查询阈值
                threshold_row = conn.execute(text(
                    "SHOW VARIABLES LIKE 'long_query_time'"
                )).fetchone()
                threshold = float(threshold_row[1]) if threshold_row else 10.0

                # 慢日志文件路径（如果开启）
                log_file_row = conn.execute(text(
                    "SHOW VARIABLES LIKE 'slow_query_log_file'"
                )).fetchone()
                log_file = log_file_row[1] if log_file_row else ""

        engine.dispose()
        return {
            "ok": True,
            "enabled": enabled,
            "threshold": threshold,
            "log_file": log_file,
        }
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _parse_ob_time_to_sec(val: str) -> float:
    """解析 OceanBase 时间字符串（如 '1s'、'100ms'）为秒"""
    if val is None:
        return 1.0
    v = str(val).strip().lower()
    if v.endswith('ms'):
        return float(v[:-2]) / 1000.0
    if v.endswith('s'):
        return float(v[:-1])
    if v.endswith('m'):
        return float(v[:-1]) * 60
    if v.endswith('h'):
        return float(v[:-1]) * 3600
    if v.endswith('us'):
        return float(v[:-2]) / 1000000.0
    try:
        return float(v)
    except ValueError:
        return 1.0


@eel.expose
def slow_query_enable(data: dict, long_time: float = 2.0):
    """开启慢查询记录（MySQL 用慢日志，OceanBase 用 SQL 审计）"""
    try:
        cdata = _normalize_conn_data(data)
        db_type = cdata.get("db_type", "mysql")
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args("mysql", timeout=10))
        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # OceanBase：确保 SQL 审计已开启 + 设置采样率为 100%
                try:
                    conn.execute(text("SET GLOBAL ob_enable_sql_audit = ON"))
                except Exception:
                    pass  # OB 默认开启，忽略权限不足
                try:
                    conn.execute(text("SET GLOBAL ob_sql_audit_percentage = 100"))
                except Exception:
                    pass
                # 设置慢查询水位线（用于 trace log）
                try:
                    conn.execute(text(
                        f"SET GLOBAL trace_log_slow_query_watermark = '{long_time}s'"
                    ))
                except Exception:
                    pass
                msg = (f"OceanBase SQL 审计已配置，慢查询阈值 {long_time}s\n"
                       f"（通过 oceanbase.GV$OB_SQL_AUDIT 视图查询）")
            else:
                # MySQL：先尝试 FILE 模式，失败则回退到 TABLE 模式
                try:
                    conn.execute(text("SET GLOBAL slow_query_log = 'ON'"))
                except Exception:
                    # 文件路径不存在，改为输出到 mysql.slow_log 表
                    conn.execute(text("SET GLOBAL log_output = 'TABLE'"))
                    conn.execute(text("SET GLOBAL slow_query_log = 'ON'"))
                conn.execute(text(f"SET GLOBAL long_query_time = {long_time}"))
                conn.execute(text("SET GLOBAL log_queries_not_using_indexes = 'ON'"))
                msg = f"慢查询已开启，阈值 {long_time}s"
        engine.dispose()
        return {"ok": True, "msg": msg}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def slow_query_get_list(data: dict, start_time: str = '', end_time: str = '',
                         limit: int = 100):
    """
    获取全局慢查询排行列表（按平均耗时倒序）
    MySQL：从 performance_schema.events_statements_summary_by_digest
    OceanBase：从 oceanbase.GV$OB_SQL_AUDIT 聚合查询
    """
    try:
        cdata = _normalize_conn_data(data)
        db_type = cdata.get("db_type", "mysql")
        if db_type not in ('mysql', 'ob-mysql'):
            return {"ok": False, "msg": "仅支持 MySQL / OceanBase"}

        url_no_db = (f"mysql+mysqldb://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:"
                     f"{cdata.get('port','3306')}?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=30))

        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # ===== OceanBase 路径：从 GV$OB_SQL_AUDIT 聚合 =====
                # 先检查视图是否存在
                try:
                    check = conn.execute(text("""
                        SELECT COUNT(*) FROM information_schema.tables
                        WHERE table_schema='oceanbase'
                          AND table_name='GV$OB_SQL_AUDIT'
                    """)).scalar()
                except Exception:
                    check = 0

                if not check or check == 0:
                    engine.dispose()
                    return {"ok": False, "msg": "当前 OceanBase 不可访问 GV$OB_SQL_AUDIT 视图",
                            "rows": [], "total": 0}

                # OceanBase 聚合：按 QUERY_SQL + DB_NAME 分组，ELAPSED_TIME 单位微秒
                where_parts = ["ELAPSED_TIME > 1000000", "QUERY_SQL IS NOT NULL"]
                params = {"lim": limit}
                if start_time:
                    where_parts.append("REQUEST_TIME >= :st")
                    params["st"] = start_time
                if end_time:
                    where_parts.append("REQUEST_TIME <= :et")
                    params["et"] = end_time

                where_clause = " AND ".join(where_parts)
                sql = text(f"""
                    SELECT
                        DB_NAME as schema_name,
                        SUBSTR(QUERY_SQL, 1, 4000) as digest_text,
                        COUNT(1) as count_star,
                        SUM(ELAPSED_TIME)/1000000.0 as total_time_sec,
                        AVG(ELAPSED_TIME)/1000000.0 as avg_time_sec,
                        MAX(ELAPSED_TIME)/1000000.0 as max_time_sec,
                        SUM(RETURN_ROWS) as rows_sent,
                        SUM(AFFECTED_ROWS) as rows_examined,
                        SUM(CASE WHEN RET_CODE != 0 THEN 1 ELSE 0 END) as errors,
                        0 as warnings,
                        MIN(REQUEST_TIME) as first_seen,
                        MAX(REQUEST_TIME) as last_seen
                    FROM oceanbase.GV$OB_SQL_AUDIT
                    WHERE {where_clause}
                    GROUP BY DB_NAME, SUBSTR(QUERY_SQL, 1, 4000)
                    ORDER BY AVG(ELAPSED_TIME) DESC
                    LIMIT :lim
                """)
                exec_result = conn.execute(sql, params)
                columns, rows = _rows_to_dicts(exec_result)

            else:
                # ===== MySQL 路径：从 performance_schema =====
                check = conn.execute(text("""
                    SELECT COUNT(*) FROM information_schema.tables
                    WHERE table_schema='performance_schema'
                      AND table_name='events_statements_summary_by_digest'
                """)).scalar()

                if not check or check == 0:
                    engine.dispose()
                    return {"ok": False, "msg": "当前数据库不支持 performance_schema 慢查询统计",
                            "rows": [], "total": 0}

                # ★ 勾选了「只看今天」（start_time 非空）时：
                #   events_statements_summary_by_digest 是纯累计表，无时间维度，无法过滤历史。
                #   改用带时间戳的明细表 events_statements_history_long 只聚合时间段内的真实数据。
                #   TIMER_START 是自服务器启动的皮秒数，需换算成墙钟时间（NOW - Uptime + TIMER_START）。
                if start_time:
                    hist_check = conn.execute(text("""
                        SELECT COUNT(*) FROM information_schema.tables
                        WHERE table_schema='performance_schema'
                          AND table_name='events_statements_history_long'
                    """)).scalar()
                    if hist_check and hist_check > 0:
                        hist_where = ["e.TIMER_WAIT > 1000000000000"]
                        params = {"lim": limit}
                        if start_time:
                            hist_where.append("DATE_FORMAT(CAST(FROM_UNIXTIME((SELECT UNIX_TIMESTAMP(NOW(6)) - CAST((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Uptime') AS DECIMAL(20,0)) ) + e.TIMER_START/1000000000000.0) AS DATETIME(6)), '%Y-%m-%d %H:%i:%s') >= :st")
                            params["st"] = start_time
                        if end_time:
                            hist_where.append("DATE_FORMAT(CAST(FROM_UNIXTIME((SELECT UNIX_TIMESTAMP(NOW(6)) - CAST((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Uptime') AS DECIMAL(20,0)) ) + e.TIMER_START/1000000000000.0) AS DATETIME(6)), '%Y-%m-%d %H:%i:%s') <= :et")
                            params["et"] = end_time
                        hist_where_clause = " AND ".join(hist_where)
                        sql = text(f"""
                            SELECT
                                e.SCHEMA_NAME as schema_name,
                                e.DIGEST_TEXT as digest_text,
                                COUNT(1) as count_star,
                                SUM(e.TIMER_WAIT)/1000000000000.0 as total_time_sec,
                                AVG(e.TIMER_WAIT)/1000000000000.0 as avg_time_sec,
                                MAX(e.TIMER_WAIT)/1000000000000.0 as max_time_sec,
                                SUM(e.ROWS_SENT) as rows_sent,
                                SUM(e.ROWS_EXAMINED) as rows_examined,
                                SUM(e.STATEMENT_STATUS='ERROR' AND e.ERRORS>0) as errors,
                                SUM(e.WARNINGS) as warnings,
                                MIN(CAST(FROM_UNIXTIME((SELECT UNIX_TIMESTAMP(NOW(6)) - CAST((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Uptime') AS DECIMAL(20,0)) ) + e.TIMER_START/1000000000000.0) AS DATETIME(6))) as first_seen,
                                MAX(CAST(FROM_UNIXTIME((SELECT UNIX_TIMESTAMP(NOW(6)) - CAST((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Uptime') AS DECIMAL(20,0)) ) + e.TIMER_START/1000000000000.0) AS DATETIME(6))) as last_seen
                            FROM performance_schema.events_statements_history_long e
                            WHERE {hist_where_clause}
                            GROUP BY e.SCHEMA_NAME, e.DIGEST_TEXT
                            ORDER BY AVG(e.TIMER_WAIT) DESC
                            LIMIT :lim
                        """)
                        try:
                            exec_result = conn.execute(sql, params)
                            columns, rows = _rows_to_dicts(exec_result)
                        except Exception:
                            # 兼容旧版本 MySQL（无 Uptime 转换列等），回退到全量累计表
                            exec_result = conn.execute(text("""
                                SELECT SCHEMA_NAME as schema_name, DIGEST_TEXT as digest_text,
                                    COUNT_STAR as count_star, SUM_TIMER_WAIT/1000000000000.0 as total_time_sec,
                                    AVG_TIMER_WAIT/1000000000000.0 as avg_time_sec, MAX_TIMER_WAIT/1000000000000.0 as max_time_sec,
                                    SUM_ROWS_SENT as rows_sent, SUM_ROWS_EXAMINED as rows_examined,
                                    SUM_ERRORS as errors, SUM_WARNINGS as warnings,
                                    FIRST_SEEN as first_seen, LAST_SEEN as last_seen
                                FROM performance_schema.events_statements_summary_by_digest
                                WHERE AVG_TIMER_WAIT > 1000000000000
                                ORDER BY AVG_TIMER_WAIT DESC LIMIT :lim
                            """), {"lim": limit})
                            columns, rows = _rows_to_dicts(exec_result)
                        engine.dispose()
                        return {
                            "ok": True,
                            "columns": columns,
                            "rows": rows,
                            "total": len(rows),
                            "time_window": True,
                        }
                    # history_long 不可用 → 回退累计表（无法按时间精确过滤，保持原逻辑）

                sql = text("""
                    SELECT
                        SCHEMA_NAME as schema_name,
                        DIGEST_TEXT as digest_text,
                        COUNT_STAR as count_star,
                        SUM_TIMER_WAIT/1000000000000.0 as total_time_sec,
                        AVG_TIMER_WAIT/1000000000000.0 as avg_time_sec,
                        MAX_TIMER_WAIT/1000000000000.0 as max_time_sec,
                        SUM_ROWS_SENT as rows_sent,
                        SUM_ROWS_EXAMINED as rows_examined,
                        SUM_ERRORS as errors,
                        SUM_WARNINGS as warnings,
                        FIRST_SEEN as first_seen,
                        LAST_SEEN as last_seen
                    FROM performance_schema.events_statements_summary_by_digest
                    WHERE AVG_TIMER_WAIT > 1000000000000
                    ORDER BY AVG_TIMER_WAIT DESC
                    LIMIT :lim
                """)
                exec_result = conn.execute(sql, {"lim": limit})
                columns, rows = _rows_to_dicts(exec_result)

        engine.dispose()

        return {
            "ok": True,
            "columns": columns,
            "rows": rows,
            "total": len(rows),
        }
    except Exception as e:
        return {"ok": False, "msg": str(e), "rows": [], "total": 0}


@eel.expose
def slow_query_get_log(data: dict, start_time: str = '', end_time: str = '',
                        limit: int = 200):
    """
    读取慢查询原始日志
    MySQL：从 mysql.slow_log 表（需 log_output=TABLE）
    OceanBase：从 GV$OB_SQL_AUDIT 查询
    """
    try:
        cdata = _normalize_conn_data(data)
        db_type = cdata.get("db_type", "mysql")
        if db_type not in ('mysql', 'ob-mysql'):
            return {"ok": False, "msg": "仅支持 MySQL / OceanBase"}

        url_no_db = (f"mysql+mysqldb://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:"
                     f"{cdata.get('port','3306')}?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=30))

        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # ===== OceanBase 路径：GV$OB_SQL_AUDIT 按时间排列 =====
                where_parts = ["ELAPSED_TIME > 1000000", "QUERY_SQL IS NOT NULL"]
                params = {"lim": limit}
                if start_time:
                    where_parts.append("REQUEST_TIME >= :st")
                    params["st"] = start_time
                if end_time:
                    where_parts.append("REQUEST_TIME <= :et")
                    params["et"] = end_time
                where_clause = " AND ".join(where_parts)

                sql = text(f"""
                    SELECT
                        REQUEST_TIME as start_time,
                        CONCAT(USER_NAME, '@', CLIENT_IP) as user_host,
                        ELAPSED_TIME/1000000.0 as query_time,
                        0 as lock_time,
                        RETURN_ROWS as rows_sent,
                        AFFECTED_ROWS as rows_examined,
                        DB_NAME as db,
                        SUBSTR(QUERY_SQL, 1, 4000) as sql_text
                    FROM oceanbase.GV$OB_SQL_AUDIT
                    WHERE {where_clause}
                    ORDER BY ELAPSED_TIME DESC
                    LIMIT :lim
                """)
                exec_result = conn.execute(sql, params)
                columns, rows = _rows_to_dicts(exec_result)

            else:
                # ===== MySQL 路径：mysql.slow_log =====
                check = conn.execute(text("""
                    SELECT COUNT(*) FROM information_schema.tables
                    WHERE table_schema='mysql' AND table_name='slow_log'
                """)).scalar()

                if not check or check == 0:
                    engine.dispose()
                    return {"ok": False, "msg": "mysql.slow_log 表不存在，请先开启慢查询记录并设置 log_output=TABLE",
                            "rows": [], "total": 0}

                # 构建查询
                where_parts = []
                params = {"lim": limit}
                if start_time:
                    where_parts.append("start_time >= :st")
                    params["st"] = start_time
                if end_time:
                    where_parts.append("start_time <= :et")
                    params["et"] = end_time

                where_clause = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

                sql = text(f"""
                    SELECT
                        start_time,
                        user_host,
                        query_time,
                        lock_time,
                        rows_sent,
                        rows_examined,
                        db,
                        sql_text
                    FROM mysql.slow_log
                    {where_clause}
                    ORDER BY query_time DESC
                    LIMIT :lim
                """)
                exec_result = conn.execute(sql, params)
                columns, rows = _rows_to_dicts(exec_result)

        engine.dispose()

        return {
            "ok": True,
            "columns": columns,
            "rows": rows,
            "total": len(rows),
        }
    except Exception as e:
        return {"ok": False, "msg": str(e), "rows": [], "total": 0}


@eel.expose
def slow_query_get_detail(conn_data: dict, database: str, digest_text: str):
    """获取某条慢 SQL 的完整信息和最近执行样本"""
    try:
        cdata = _normalize_conn_data(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type not in ('mysql', 'ob-mysql'):
            return {"ok": False, "msg": "仅支持 MySQL / OceanBase"}

        url_no_db = (f"mysql+mysqldb://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:"
                     f"{cdata.get('port','3306')}?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=15))

        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # ===== OceanBase 路径：GV$OB_SQL_AUDIT 聚合统计 + 最近样本 =====
                sql_prefix = digest_text[:200] if digest_text else ''

                summary_sql = text("""
                    SELECT
                        DB_NAME as schema_name,
                        SUBSTR(QUERY_SQL, 1, 4000) as digest_text,
                        COUNT(1) as count_star,
                        SUM(ELAPSED_TIME)/1000000.0 as total_time,
                        AVG(ELAPSED_TIME)/1000000.0 as avg_time,
                        MAX(ELAPSED_TIME)/1000000.0 as max_time,
                        MIN(ELAPSED_TIME)/1000000.0 as min_time,
                        SUM(RETURN_ROWS) as rows_sent,
                        SUM(AFFECTED_ROWS) as rows_examined,
                        SUM(CASE WHEN RET_CODE != 0 THEN 1 ELSE 0 END) as errors,
                        0 as warnings,
                        MIN(REQUEST_TIME) as first_seen,
                        MAX(REQUEST_TIME) as last_seen
                    FROM oceanbase.GV$OB_SQL_AUDIT
                    WHERE DB_NAME = :db
                      AND SUBSTR(QUERY_SQL, 1, 200) = :prefix
                    GROUP BY DB_NAME, SUBSTR(QUERY_SQL, 1, 4000)
                    LIMIT 1
                """)
                summary = conn.execute(summary_sql, {
                    "db": database, "prefix": sql_prefix
                }).fetchone()

                if not summary:
                    engine.dispose()
                    return {"ok": False, "msg": "未找到该SQL的统计数据"}

                detail = {}
                for k, v in summary._mapping.items():
                    key = k.lower().replace(' ', '_') if isinstance(k, str) else str(k)
                    detail[key] = _json_safe(v)

                # 最近样本：从 GV$OB_SQL_AUDIT 取最新 5 条
                recent_sqls = []
                try:
                    hist_sql = text("""
                        SELECT
                            SUBSTR(QUERY_SQL, 1, 4000) as SQL_TEXT,
                            REQUEST_TIME as TIMER_START,
                            ELAPSED_TIME as TIMER_END_TIME,
                            0 as LOCK_TIME,
                            RETURN_ROWS as ROWS_SENT,
                            AFFECTED_ROWS as ROWS_EXAMINED,
                            CASE WHEN RET_CODE != 0 THEN 1 ELSE 0 END as ERRORS,
                            0 as WARNINGS,
                            TRACE_ID, USER_NAME, CLIENT_IP, RET_CODE, PLAN_ID
                        FROM oceanbase.GV$OB_SQL_AUDIT
                        WHERE DB_NAME = :db
                          AND SUBSTR(QUERY_SQL, 1, 200) = :prefix
                        ORDER BY REQUEST_TIME DESC
                        LIMIT 5
                    """)
                    hist_result = conn.execute(hist_sql, {
                        "db": database, "prefix": sql_prefix
                    }).fetchall()
                    for hr in hist_result:
                        hdict = {}
                        for k, v in hr._mapping.items():
                            key = str(k)
                            if key == 'TIMER_END_TIME' and isinstance(v, (int, float)):
                                hdict['ELAPSED'] = f"{v/1000000.0:.4f}s" if v > 0 else "0"
                                hdict[key] = _json_safe(v)
                            else:
                                hdict[key] = _json_safe(v)
                        recent_sqls.append(hdict)
                except Exception:
                    pass

            else:
                # ===== MySQL 路径 =====
                summary_sql = text("""
                    SELECT
                        SCHEMA_NAME, DIGEST_TEXT, COUNT_STAR,
                        SUM_TIMER_WAIT/1000000000000.0 as total_time,
                        AVG_TIMER_WAIT/1000000000000.0 as avg_time,
                        MAX_TIMER_WAIT/1000000000000.0 as max_time,
                        MIN_TIMER_WAIT/1000000000000.0 as min_time,
                        SUM_ROWS_SENT, SUM_ROWS_EXAMINED, SUM_ROWS_AFFECTED,
                        SUM_CREATED_TMP_TABLES, SUM_CREATED_TMP_DISK_TABLES,
                        SUM_SORT_MERGE_PASSES, SUM_SORT_ROWS,
                        SUM_ERRORS, SUM_WARNINGS,
                        FIRST_SEEN, LAST_SEEN
                    FROM performance_schema.events_statements_summary_by_digest
                    WHERE SCHEMA_NAME = :db AND DIGEST_TEXT = :dtxt
                    LIMIT 1
                """)
                summary = conn.execute(summary_sql, {
                    "db": database, "dtxt": digest_text
                }).fetchone()

                if not summary:
                    engine.dispose()
                    return {"ok": False, "msg": "未找到该SQL的统计数据"}

                detail = {}
                for k, v in summary._mapping.items():
                    key = k.lower().replace(' ', '_') if isinstance(k, str) else str(k)
                    detail[key] = _json_safe(v)

                # 从 events_statements_history 获取最近几次执行的完整SQL
                recent_sqls = []
                try:
                    history_sql = text("""
                        SELECT SQL_TEXT, TIMER_START, TIMER_END, LOCK_TIME,
                               ROWS_SENT, ROWS_EXAMINED, ERRORS, WARNINGS
                        FROM performance_schema.events_statements_history
                        WHERE SCHEMA_NAME = :db
                          AND SUBSTRING(SQL_TEXT, 1, 200) = SUBSTRING(:dtxt, 1, 200)
                        ORDER BY TIMER_START DESC
                        LIMIT 5
                    """)
                    hist_result = conn.execute(history_sql, {
                        "db": database, "dtxt": digest_text
                    }).fetchall()
                    for hr in hist_result:
                        hdict = {}
                        for k, v in hr._mapping.items():
                            key = str(k)
                            if isinstance(v, (int, float)) and key in ('TIMER_START', 'TIMER_END', 'LOCK_TIME'):
                                hdict[key] = f"{v/1000000000000.0:.4f}s" if v > 0 else "0"
                            else:
                                hdict[key] = _json_safe(v)
                        recent_sqls.append(hdict)
                except Exception:
                    pass

        engine.dispose()
        return {"ok": True, "detail": detail, "recent_sqls": recent_sqls}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def slow_query_kill_processlist(conn_data: dict, process_id: int):
    """Kill 指定进程（用于终止慢查询）"""
    try:
        cdata = _normalize_conn_data(conn_data)
        db_type = cdata.get("db_type", "mysql")
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=5))
        with engine.connect() as conn:
            conn.execute(text(f"KILL {int(process_id)}"))
        engine.dispose()
        return {"ok": True, "msg": f"进程 [{process_id}] 已终止"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def slow_query_get_running(conn_data: dict):
    """获取当前正在运行的慢进程列表（运行时间超过阈值的）"""
    try:
        cdata = _normalize_conn_data(conn_data)
        db_type = cdata.get("db_type", "mysql")
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # OceanBase：用 GV$OB_PROCESSLIST 获取更全的信息
                try:
                    exec_result = conn.execute(text(
                        "SELECT /*+ READ_CONSISTENCY(WEAK) */ "
                        "ID as id, USER as user_, HOST as host, DB as db, "
                        "COMMAND as command, TIME as time_, STATE as state, "
                        "SUBSTR(INFO, 1, 500) as info "
                        "FROM oceanbase.GV$OB_PROCESSLIST "
                        "WHERE COMMAND != 'Sleep' AND INFO IS NOT NULL AND INFO != '' "
                        "AND TIME >= 1 "
                        "ORDER BY TIME DESC LIMIT 50"
                    ))
                except Exception:
                    # 回退到标准 INFORMATION_SCHEMA
                    exec_result = conn.execute(text(
                        "SELECT ID as id, USER as user_, HOST as host, DB as db, "
                        "COMMAND as command, TIME as time_, STATE as state, "
                        "INFO as info "
                        "FROM INFORMATION_SCHEMA.PROCESSLIST "
                        "WHERE COMMAND != 'Sleep' AND INFO IS NOT NULL AND INFO != '' "
                        "AND TIME >= 1 "
                        "ORDER BY TIME DESC LIMIT 50"
                    ))
            else:
                exec_result = conn.execute(text(
                    "SELECT ID as id, USER as user_, HOST as host, DB as db, "
                    "COMMAND as command, TIME as time_, STATE as state, "
                    "INFO as info "
                    "FROM INFORMATION_SCHEMA.PROCESSLIST "
                    "WHERE COMMAND != 'Sleep' AND INFO IS NOT NULL AND INFO != '' "
                    "AND TIME >= 1 "
                    "ORDER BY TIME DESC LIMIT 50"
                ))
            columns = list(exec_result.keys())
            rows = [dict(row._mapping) for row in exec_result.fetchall()]
        engine.dispose()
        return {"ok": True, "columns": columns, "rows": rows}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


# ==================== 服务器仪表盘 ====================

@eel.expose
def dashboard_get_metrics(conn_data: dict):
    """获取仪表盘所有指标（关键指标卡片 + 4 个时间序列数组 + 状态变量列表）
    支持: MySQL / OceanBase (其他数据库返回 ok=False)
    ★ 异步执行，避免阻塞 Eel 主线程
    """
    try:
        cdata = _normalize_conn_data(conn_data)
        db_type = cdata.get("db_type", "mysql")
        if db_type not in ('mysql', 'ob-mysql'):
            return {"ok": False, "msg": f"仪表盘暂不支持 {db_type} 数据库"}

        def _do_collect():
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
            try:
                with engine.connect() as conn:
                    # ★ 1. 服务器信息（版本、启动时长等）
                    version_row = conn.execute(text("SELECT VERSION()")).fetchone()
                    version = version_row[0] if version_row else "unknown"
                    server_info = {
                        "version": version,
                        "version_short": version.split('-')[0] if version else "",
                        "version_comment": ""
                    }
                    try:
                        vcomment_row = conn.execute(text("SHOW VARIABLES LIKE 'version_comment'")).fetchone()
                        if vcomment_row: server_info["version_comment"] = vcomment_row[1] or ""
                    except Exception:
                        pass
                    # 启动时间
                    try:
                        up_row = conn.execute(text("SHOW STATUS LIKE 'Uptime'")).fetchone()
                        server_info["uptime_sec"] = int(up_row[1]) if up_row else 0
                    except Exception:
                        server_info["uptime_sec"] = 0

                    # ★ 2. 一次性获取 SHOW GLOBAL STATUS 全部变量（342 个左右）
                    status_rows = conn.execute(text("SHOW GLOBAL STATUS")).fetchall()
                    status = {r[0]: r[1] for r in status_rows}

                    # ★ 3. 一次性获取 SHOW GLOBAL VARIABLES 关键变量
                    var_rows = conn.execute(text("SHOW GLOBAL VARIABLES")).fetchall()
                    variables = {r[0]: r[1] for r in var_rows}

                    def _n(k, default=0):
                        try: return int(status.get(k, default))
                        except: return default
                    def _nv(k, default=0):
                        try: return int(variables.get(k, default))
                        except: return default

                    # ★ 4. 关键指标卡片
                    threads_connected = _n('Threads_connected', 0)
                    threads_running = _n('Threads_running', 0)
                    max_connections = _nv('max_connections', 0)
                    slow_queries = _n('Slow_queries', 0)
                    questions = _n('Questions', 0)
                    uptime = max(server_info.get("uptime_sec", 1), 1)

                    # QPS / TPS（累计值，需要前端 diff）
                    com_select = _n('Com_select', 0)
                    com_insert = _n('Com_insert', 0)
                    com_update = _n('Com_update', 0)
                    com_delete = _n('Com_delete', 0)
                    com_commit = _n('Com_commit', 0)
                    connections_total = _n('Connections', 0)

                    # 网络流量（Bytes_received/sent 是累计字节数）
                    bytes_received = _n('Bytes_received', 0)
                    bytes_sent = _n('Bytes_sent', 0)

                    # InnoDB 命中率
                    innodb_buf_read = _n('Innodb_buffer_pool_read_requests', 0)
                    innodb_buf_disk = _n('Innodb_buffer_pool_reads', 0)
                    if innodb_buf_read > 0:
                        innodb_hit_pct = round((1 - innodb_buf_disk / innodb_buf_read) * 100, 2)
                    else:
                        innodb_hit_pct = 100.0

                    # 锁等待
                    innodb_row_lock_waits = _n('Innodb_row_lock_waits', 0)
                    innodb_row_lock_time = _n('Innodb_row_lock_time', 0)

                    # 临时表
                    created_tmp_tables = _n('Created_tmp_tables', 0)
                    created_tmp_disk = _n('Created_tmp_disk_tables', 0)
                    tmp_disk_pct = round(created_tmp_disk / max(created_tmp_tables, 1) * 100, 2) if created_tmp_tables > 0 else 0

                    # 慢查询开关状态
                    slow_query_log_on = variables.get('slow_query_log', 'OFF') == 'ON'
                    long_query_time = variables.get('long_query_time', '0')

                    kpis = [
                        {"key":"threads_connected", "label":"当前连接数", "value":threads_connected,
                         "unit":"/ "+str(max_connections), "sub":f"运行中: {threads_running}", "level":"good" if threads_connected<max_connections*0.8 else "warn"},
                        {"key":"innodb_hit", "label":"InnoDB 命中率", "value":innodb_hit_pct,
                         "unit":"%", "sub":f"磁盘读: {innodb_buf_disk}", "level":"good" if innodb_hit_pct>=99 else ("warn" if innodb_hit_pct>=95 else "bad")},
                        {"key":"slow_queries", "label":"慢查询数", "value":slow_queries,
                         "unit":"次", "sub":"阈值 {}s {}".format(long_query_time, "✅已开" if slow_query_log_on else "❌未开"),
                         "level":"good" if slow_queries<100 else "warn"},
                        {"key":"qps", "label":"累计 Questions", "value":questions,
                         "unit":"次", "sub":"累计 {:,}".format(questions), "level":""},
                        {"key":"com_select", "label":"累计 SELECT", "value":com_select,
                         "unit":"次", "sub":"INSERT: {}  UPDATE: {}  DELETE: {}".format(com_insert, com_update, com_delete),
                         "level":""},
                        {"key":"tps_estimate", "label":"累计 Com_commit", "value":com_commit,
                         "unit":"次", "sub":"连接累计: {}".format(connections_total), "level":""},
                        {"key":"tmp_disk_pct", "label":"临时表磁盘率", "value":tmp_disk_pct,
                         "unit":"%", "sub":"临时表: {} (磁盘: {})".format(created_tmp_tables, created_tmp_disk),
                         "level":"good" if tmp_disk_pct<10 else "warn"},
                        {"key":"row_lock_waits", "label":"行锁等待次数", "value":innodb_row_lock_waits,
                         "unit":"次", "sub":"等待时长: {}ms".format(innodb_row_lock_time), "level":"good" if innodb_row_lock_waits<100 else "warn"},
                    ]

                    # ★ 5. 时间序列累计值（前端按时间间隔 diff 算出每秒值）
                    # 不在后端做 diff —— 前端已有上一次累计值，可正确计算瞬时速率
                    series = {
                        "qps":          {"cum": questions,           "name":"QPS"},
                        "new_conn":     {"cum": connections_total,   "name":"Connections/s"},
                        "net_in":       {"cum": bytes_received,      "name":"Bytes Received"},
                        "net_out":      {"cum": bytes_sent,          "name":"Bytes Sent"},
                        "cmd_select":   {"cum": com_select,          "name":"SELECT"},
                        "cmd_insert":   {"cum": com_insert,          "name":"INSERT"},
                        "cmd_update":   {"cum": com_update,          "name":"UPDATE"},
                        "cmd_delete":   {"cum": com_delete,          "name":"DELETE"},
                    }

                    # ★ 6. 状态变量列表（按名字排序，附加中文说明 + [累计]/[瞬时] 标注）
                    _STATUS_DESC = {
                        # 连接
                        "Aborted_connects": "连接失败次数（密码错误/权限不足等）[累计]",
                        "Aborted_clients": "客户端未正确关闭连接次数 [累计]",
                        "Connections": "总连接尝试次数 [累计]",
                        "Max_used_connections": "历史最高并发连接数 [瞬时]",
                        "Max_used_connections_time": "达到最大并发连接的时间 [瞬时]",
                        "Threads_cached": "线程缓存中空闲线程数 [瞬时]",
                        "Threads_connected": "当前打开的连接数 [瞬时]",
                        "Threads_created": "创建的线程总数 [累计]",
                        "Threads_running": "当前正在执行命令的线程数 [瞬时]",
                        # 查询/命令
                        "Questions": "客户端发送的总查询数 [累计]",
                        "Queries": "服务器执行的总语句数 [累计]",
                        "Com_select": "SELECT 语句总数 [累计]",
                        "Com_insert": "INSERT 语句总数 [累计]",
                        "Com_update": "UPDATE 语句总数 [累计]",
                        "Com_delete": "DELETE 语句总数 [累计]",
                        "Com_commit": "COMMIT 语句总数 [累计]",
                        "Com_rollback": "ROLLBACK 语句总数 [累计]",
                        "Slow_queries": "慢查询总数 [累计]",
                        # InnoDB Buffer Pool
                        "Innodb_buffer_pool_read_requests": "Buffer Pool 读请求总数 [累计]",
                        "Innodb_buffer_pool_reads": "从磁盘物理读取页次数 [累计]",
                        "Innodb_buffer_pool_pages_total": "Buffer Pool 总页数 [瞬时]",
                        "Innodb_buffer_pool_pages_free": "Buffer Pool 空闲页数 [瞬时]",
                        "Innodb_buffer_pool_pages_dirty": "Buffer Pool 脏页数 [瞬时]",
                        "Innodb_buffer_pool_pages_data": "Buffer Pool 已用数据页数 [瞬时]",
                        "Innodb_buffer_pool_size": "Buffer Pool 当前字节大小 [瞬时]",
                        "Innodb_buffer_pool_wait_free": "等待空闲页的写入次数 [累计]",
                        # InnoDB 行锁
                        "Innodb_row_lock_current_waits": "当前正在等待的行锁数 [瞬时]",
                        "Innodb_row_lock_time": "获取行锁总等待时间(ms) [累计]",
                        "Innodb_row_lock_time_avg": "获取行锁平均等待时间(ms) [累计]",
                        "Innodb_row_lock_time_max": "获取行锁最大等待时间(ms) [累计]",
                        "Innodb_row_lock_waits": "行锁等待总次数 [累计]",
                        # InnoDB 读写
                        "Innodb_rows_read": "读取总行数 [累计]",
                        "Innodb_rows_inserted": "插入总行数 [累计]",
                        "Innodb_rows_updated": "更新总行数 [累计]",
                        "Innodb_rows_deleted": "删除总行数 [累计]",
                        # InnoDB IO
                        "Innodb_data_read": "从磁盘读取总字节数 [累计]",
                        "Innodb_data_reads": "磁盘读取总次数 [累计]",
                        "Innodb_data_writes": "磁盘写入总次数 [累计]",
                        "Innodb_data_written": "写入磁盘总字节数 [累计]",
                        "Innodb_log_waits": "redo log buffer 满导致等待刷盘的次数 [累计]",
                        "Innodb_os_log_written": "redo log 写入字节数 [累计]",
                        # 临时表
                        "Created_tmp_disk_tables": "磁盘临时表创建次数 [累计]",
                        "Created_tmp_tables": "临时表创建总次数（含内存+磁盘）[累计]",
                        "Created_tmp_files": "临时文件创建次数 [累计]",
                        # 表锁
                        "Table_locks_immediate": "立即获得的表锁次数 [累计]",
                        "Table_locks_waited": "需要等待的表锁次数 [累计]",
                        # 表缓存
                        "Open_tables": "当前打开的表数量 [瞬时]",
                        "Opened_tables": "打开过的表总数 [累计]",
                        "Table_open_cache_hits": "表缓存命中次数 [累计]",
                        "Table_open_cache_misses": "表缓存未命中次数 [累计]",
                        # 网络
                        "Bytes_received": "从客户端接收的总字节数 [累计]",
                        "Bytes_sent": "发送给客户端的总字节数 [累计]",
                        # Handler 读
                        "Handler_read_first": "读索引第一条的次数 [累计]",
                        "Handler_read_key": "通过索引读取行次数 [累计]",
                        "Handler_read_next": "按索引顺序读下一行次数 [累计]",
                        "Handler_read_rnd_next": "全表扫描读下一行次数 [累计]",
                        # 排序
                        "Sort_merge_passes": "排序合并次数 [累计]",
                        "Sort_range": "范围扫描排序次数 [累计]",
                        "Sort_rows": "排序总行数 [累计]",
                        "Sort_scan": "全表扫描排序次数 [累计]",
                        # 查询缓存
                        "Qcache_hits": "查询缓存命中次数 [累计]",
                        "Qcache_inserts": "查询缓存插入次数 [累计]",
                        "Qcache_lowmem_prunes": "因内存不足从缓存移除的查询数 [累计]",
                        "Qcache_not_cached": "不可缓存的查询数 [累计]",
                        # 其他
                        "Select_full_join": "无索引 JOIN 次数 [累计]",
                        "Select_full_range_join": "引用表的范围 JOIN 次数 [累计]",
                        "Select_range": "使用第一个表进行范围扫描的次数 [累计]",
                        "Select_range_check": "无索引的 JOIN 估计行数检查次数 [累计]",
                        "Select_scan": "全表扫描次数 [累计]",
                        "Uptime": "MySQL 服务器运行时长（秒）[瞬时]",
                        "Key_read_requests": "索引读请求次数 [累计]",
                        "Key_reads": "从磁盘物理读索引块次数 [累计]",
                        "Key_write_requests": "索引写请求次数 [累计]",
                        "Key_writes": "索引物理写入磁盘次数 [累计]",
                    }
                    status_list = sorted(
                        [{"name": n, "value": str(v), "desc": _STATUS_DESC.get(n, "")}
                         for n, v in status.items()],
                        key=lambda x: x["name"].lower()
                    )

                    return {
                        "ok": True,
                        "server": server_info,
                        "kpis": kpis,
                        "series": series,
                        "status_vars": status_list,
                    }
            finally:
                engine.dispose()

        return _with_db_timeout(_do_collect, timeout=15)
    except ValueError as e:
        return {"ok": False, "msg": str(e)}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, cdata.get("db_type", "mysql"))}


# ==================== 右侧信息面板：连接/数据库详情 ====================

@eel.expose
def get_connection_info(conn_data, operation_id=None):
    op_id = str(operation_id or ('connection_info_' + str(time.time_ns())))
    op_state = _register_db_operation(op_id, conn_data, 'connection_info')
    try:
        return _get_connection_info_impl(conn_data, op_state)
    finally:
        _finish_db_operation(op_state)


def _get_connection_info_impl(conn_data, op_state=None):
    """获取连接级别的详情信息（版本、状态等）
    支持: mysql / ob-mysql / oracle / postgresql / redis"""
    engine = None
    redis_clients = []
    try:
        db_type = conn_data.get("db_type", "mysql")

        if db_type == 'redis':
            import redis as rds
            try:
                r = rds.Redis(
                    host=conn_data['host'], port=int(conn_data.get('port', '6379')),
                    password=conn_data.get('pwd') or None,
                    socket_connect_timeout=5, socket_timeout=10,
                    decode_responses=True, encoding='utf-8', encoding_errors='replace',
                    protocol=2
                )
            except TypeError:
                r = rds.Redis(
                    host=conn_data['host'], port=int(conn_data.get('port', '6379')),
                    password=conn_data.get('pwd') or None,
                    socket_connect_timeout=5, socket_timeout=10,
                    decode_responses=True, encoding='utf-8', encoding_errors='replace'
                )
            redis_clients.append(r)
            if _db_operation_cancelled(op_state):
                for client in redis_clients:
                    try:
                        client.close()
                    except Exception:
                        pass
                return {"ok": False, "msg": "连接信息请求已取消", "cancelled": True}
            info = r.info('server')
            db_count = int(r.config_get('databases').get('databases', 16))
            db_count = min(db_count, 16)
            keys_total = 0
            for i in range(db_count):
                if _db_operation_cancelled(op_state):
                    for client in redis_clients:
                        try:
                            client.close()
                        except Exception:
                            pass
                    return {"ok": False, "msg": "连接信息请求已取消", "cancelled": True}
                try:
                    _r2 = rds.Redis(
                        host=conn_data['host'], port=int(conn_data.get('port', '6379')),
                        password=conn_data.get('pwd') or None, db=i,
                        socket_connect_timeout=3, socket_timeout=5,
                        decode_responses=True, protocol=2
                    )
                except TypeError:
                    _r2 = rds.Redis(
                        host=conn_data['host'], port=int(conn_data.get('port', '6379')),
                        password=conn_data.get('pwd') or None, db=i,
                        socket_connect_timeout=3, socket_timeout=5,
                        decode_responses=True
                    )
                redis_clients.append(_r2)
                try:
                    keys_total += _r2.dbsize()
                except Exception:
                    pass
                finally:
                    try:
                        _r2.close()
                    except Exception:
                        pass
            try:
                r.close()
            except Exception:
                pass
            return {"ok": True, "info": {
                "type": "Redis",
                "version": info.get('redis_version', ''),
                "os": info.get('os', ''),
                "arch": str(info.get('arch_bits', '')) + ' bits',
                "uptime_days": str(int(info.get('uptime_in_seconds', 0)) // 86400) + ' 天',
                "db_count": db_count,
                "keys_total": keys_total,
                "connected_clients": info.get('connected_clients', ''),
                "used_memory": _format_memory(int(info.get('used_memory', 0))),
                "max_memory": _format_memory(int(info.get('maxmemory', 0)) or 0),
                "eviction_policy": info.get('maxmemory_policy', ''),
                "replication_role": info.get('role', 'master') if 'role' in info else '单机',
                "gcc_version": info.get('gcc_version', ''),
                "tcp_port": info.get('tcp_port', conn_data.get('port', '6379')),
            }}

        cdata = dict(conn_data)
        if db_type not in ('oracle', 'redis'):
            cdata.setdefault("db", "")
        engine = create_engine(
            _conn_url(cdata),
            connect_args=_connect_args(db_type, timeout=10)
        )
        info = {"type": db_type.upper() if db_type == 'ob-mysql' else db_type.title()}

        with engine.connect() as c:
            pid = _get_backend_pid(c, db_type)
            _add_db_operation_session(op_state, cdata, pid, kill_connection=True)
            if _db_operation_cancelled(op_state):
                engine.dispose()
                return {"ok": False, "msg": "连接信息请求已取消", "cancelled": True}
            if db_type in ('mysql', 'ob-mysql'):
                ver = c.execute(text("SELECT VERSION()")).fetchone()[0]
                charset = c.execute(text("SELECT @@character_set_server")).fetchone()[0]
                collation = c.execute(text("SELECT @@collation_server")).fetchone()[0]
                info["version"] = ver
                info["charset"] = charset
                info["collation"] = collation
                try:
                    uptime = c.execute(text("SHOW GLOBAL STATUS LIKE 'Uptime'")).fetchone()
                    info["uptime_secs"] = int(uptime[1]) if uptime else 0
                except:
                    info["uptime_secs"] = 0

            elif db_type == 'postgresql':
                ver = c.execute(text("SELECT version()")).fetchone()[0]
                charset = c.execute(text("SHOW server_encoding")).fetchone()[0]
                info["version"] = ver.split(',')[0] if ',' in ver else ver
                info["charset"] = charset
                info["collation"] = ""
                try:
                    uptime = c.execute(text(
                        "SELECT EXTRACT(EPOCH FROM NOW() - pg_postmaster_start_time())::bigint"
                    )).fetchone()[0]
                    info["uptime_secs"] = int(uptime) if uptime else 0
                except:
                    info["uptime_secs"] = 0

            elif db_type == 'oracle':
                ver = c.execute(text("SELECT BANNER FROM v$version WHERE ROWNUM=1")).fetchone()[0]
                info["version"] = ver
                info["charset"] = c.execute(text(
                    "SELECT value FROM nls_database_parameters WHERE parameter='NLS_CHARACTERSET'"
                )).fetchone()[0]
                info["collation"] = c.execute(text(
                    "SELECT value FROM nls_database_parameters WHERE parameter='NLS_SORT'"
                )).fetchone()[0]
                try:
                    uptime = c.execute(text(
                        "SELECT (SYSDATE - STARTUP_TIME) * 86400 FROM v$instance"
                    )).fetchone()[0]
                    info["uptime_secs"] = int(uptime) if uptime else 0
                except:
                    info["uptime_secs"] = 0

            elif db_type == 'mssql':
                ver = c.execute(text("SELECT @@VERSION")).fetchone()[0]
                info["version"] = ver.split('\n')[0] if ver else ''
                info["charset"] = ""
                info["collation"] = c.execute(text("SELECT SERVERPROPERTY('Collation')")).fetchone()[0]
                info["uptime_secs"] = 0

        engine.dispose()
        return {"ok": True, "info": info}
    except Exception as e:
        for client in redis_clients:
            try:
                client.close()
            except Exception:
                pass
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                pass
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


@eel.expose
def cancel_connection_info(operation_id=None):
    """取消右侧信息面板的旧连接请求，并终止其数据库会话。"""
    return _cancel_registered_db_operation(operation_id)


def _format_memory(size_bytes):
    """格式化内存大小"""
    if not size_bytes or size_bytes <= 0:
        return "0 B"
    if size_bytes >= 1073741824:
        return f"{size_bytes / 1073741824:.1f} GB"
    if size_bytes >= 1048576:
        return f"{size_bytes / 1048576:.0f} MB"
    if size_bytes >= 1024:
        return f"{size_bytes / 1024:.0f} KB"
    return f"{size_bytes} B"


@eel.expose
def get_database_info(conn_data, database, operation_id=None):
    """获取数据库级别的详情（大小、对象数量等）
    支持: mysql / ob-mysql / oracle / postgresql / redis
    ★ 异步执行，避免 INFO_SCHEMA 查询阻塞 Eel 主线程
    """
    op_id = str(operation_id or ('database_info_' + str(time.time_ns())))
    op_state = _register_db_operation(operation_id=op_id, conn_data=conn_data, kind='database_info')

    def _run_info(func):
        def _runner():
            try:
                return func()
            finally:
                _finish_db_operation(op_state)
        return _runner

    try:
        db_type = conn_data.get("db_type", "mysql")

        if db_type == 'redis':
            def _redis_info():
                import redis as rds
                try:
                    r = rds.Redis(
                        host=conn_data['host'], port=int(conn_data.get('port', '6379')),
                        password=conn_data.get('pwd') or None,
                        db=int(database) if database else 0,
                        socket_connect_timeout=5, socket_timeout=10,
                        decode_responses=True, encoding='utf-8', encoding_errors='replace',
                        protocol=2
                    )
                except TypeError:
                    r = rds.Redis(
                        host=conn_data['host'], port=int(conn_data.get('port', '6379')),
                        password=conn_data.get('pwd') or None,
                        db=int(database) if database else 0,
                        socket_connect_timeout=5, socket_timeout=10,
                        decode_responses=True, encoding='utf-8', encoding_errors='replace'
                    )
                if _db_operation_cancelled(op_state):
                    r.close()
                    return {"ok": False, "msg": "数据库信息请求已取消", "cancelled": True}
                dbsize = r.dbsize()
                if _db_operation_cancelled(op_state):
                    r.close()
                    return {"ok": False, "msg": "数据库信息请求已取消", "cancelled": True}
                info_result = r.info('keyspace')
                db_key = f"db{database}"
                keyspace_info = info_result.get(db_key, {}) if isinstance(info_result, dict) else {}
                result = {"ok": True, "info": {
                    "name": f"DB{database}",
                    "type": "Redis DB",
                    "key_count": dbsize,
                    "expires": keyspace_info.get('expires', 0) if isinstance(keyspace_info, dict) else 0,
                    "avg_ttl": keyspace_info.get('avg_ttl', 0) if isinstance(keyspace_info, dict) else 0,
                    "db_index": int(database),
                }}
                r.close()
                return result
            return _with_db_timeout(_run_info(_redis_info), timeout=15)

        cdata = dict(conn_data)
        if db_type != 'oracle':
            cdata["db"] = database

        def _get_db_info():
            engine = create_engine(
                _conn_url(cdata),
                connect_args=_connect_args(db_type, timeout=10)
            )
            try:
                if _db_operation_cancelled(op_state):
                    engine.dispose()
                    return {"ok": False, "msg": "数据库信息请求已取消", "cancelled": True}
                info = {"name": database, "type": db_type.upper() if db_type == 'ob-mysql' else db_type.title()}
                with engine.connect() as c:
                    pid = _get_backend_pid(c, db_type)
                    _add_db_operation_session(op_state, cdata, pid, kill_connection=True)
                    if _db_operation_cancelled(op_state):
                        engine.dispose()
                        return {"ok": False, "msg": "数据库信息请求已取消", "cancelled": True}
                    if db_type == 'mysql':
                        charset_row = c.execute(text(
                            "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME "
                            "FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=:db"
                        ), {"db": database}).fetchone()
                        info["charset"] = charset_row[0] if charset_row else ""
                        info["collation"] = charset_row[1] if charset_row else ""

                        tables_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
                            "WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='BASE TABLE'"
                        ), {"db": database}).fetchone()[0]
                        views_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
                            "WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='VIEW'"
                        ), {"db": database}).fetchone()[0]
                        proc_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.ROUTINES "
                            "WHERE ROUTINE_SCHEMA=:db"
                        ), {"db": database}).fetchone()[0]
                        size_row = c.execute(text(
                            "SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) "
                            "FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=:db"
                        ), {"db": database}).fetchone()
                        info["tables_count"] = tables_cnt or 0
                        info["views_count"] = views_cnt or 0
                        info["routines_count"] = proc_cnt or 0
                        info["size_str"] = _format_size(size_row[0] if size_row else 0)

                    elif db_type == 'ob-mysql':
                        charset_row = c.execute(text(
                            "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME "
                            "FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=:db"
                        ), {"db": database}).fetchone()
                        info["charset"] = charset_row[0] if charset_row else ""
                        info["collation"] = charset_row[1] if charset_row else ""

                        tables_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
                            "WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='BASE TABLE'"
                        ), {"db": database}).fetchone()[0]
                        views_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
                            "WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='VIEW'"
                        ), {"db": database}).fetchone()[0]
                        proc_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.ROUTINES "
                            "WHERE ROUTINE_SCHEMA=:db"
                        ), {"db": database}).fetchone()[0]

                        # ★ OceanBase INFORMATION_SCHEMA.TABLES 的 DATA_LENGTH/INDEX_LENGTH 固定为0
                        # 使用 OB 内部表 oceanbase.__all_virtual_table 获取真实数据大小
                        size_bytes = 0
                        try:
                            size_row = c.execute(text(
                                "SELECT COALESCE(SUM(data_size), 0) "
                                "FROM oceanbase.__all_virtual_table "
                                "WHERE table_type IN (0, 3)"
                            )).fetchone()
                            size_bytes = size_row[0] if size_row else 0
                        except Exception:
                            # 降级：尝试 CDB_OB_TABLE_LOCATIONS（部分 OB 版本需 DBA 权限）
                            try:
                                size_row = c.execute(text(
                                    "SELECT COALESCE(SUM(data_size + required_size), 0) "
                                    "FROM oceanbase.CDB_OB_TABLE_LOCATIONS"
                                )).fetchone()
                                size_bytes = size_row[0] if size_row else 0
                            except Exception:
                                # 最终降级：INFORMATION_SCHEMA（可能为0）
                                try:
                                    size_row = c.execute(text(
                                        "SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) "
                                        "FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=:db"
                                    ), {"db": database}).fetchone()
                                    size_bytes = size_row[0] if size_row else 0
                                except Exception:
                                    size_bytes = 0

                        info["tables_count"] = tables_cnt or 0
                        info["views_count"] = views_cnt or 0
                        info["routines_count"] = proc_cnt or 0
                        info["size_str"] = _format_size(size_bytes)

                    elif db_type == 'postgresql':
                        charset_row = c.execute(text("SHOW server_encoding")).fetchone()
                        info["charset"] = charset_row[0] if charset_row else ""
                        info["collation"] = ""

                        tables_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM pg_catalog.pg_class c "
                            "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                            "WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema')"
                        )).fetchone()[0]
                        views_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM pg_catalog.pg_class c "
                            "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                            "WHERE c.relkind='v' AND n.nspname NOT IN ('pg_catalog','information_schema')"
                        )).fetchone()[0]
                        proc_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM pg_proc p "
                            "JOIN pg_namespace n ON n.oid=p.pronamespace "
                            "WHERE n.nspname NOT IN ('pg_catalog','information_schema')"
                        )).fetchone()[0]
                        size_row = c.execute(text(
                            "SELECT pg_database_size(:db)"
                        ), {"db": database}).fetchone()
                        info["tables_count"] = tables_cnt or 0
                        info["views_count"] = views_cnt or 0
                        info["routines_count"] = proc_cnt or 0
                        info["size_str"] = _format_size(size_row[0] if size_row else 0)

                    elif db_type == 'oracle':
                        info["charset"] = c.execute(text(
                            "SELECT value FROM nls_database_parameters "
                            "WHERE parameter='NLS_CHARACTERSET'"
                        )).fetchone()[0]
                        info["collation"] = c.execute(text(
                            "SELECT value FROM nls_database_parameters WHERE parameter='NLS_SORT'"
                        )).fetchone()[0]

                        tables_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER=:db"
                        ), {"db": database}).fetchone()[0]
                        views_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM ALL_VIEWS WHERE OWNER=:db"
                        ), {"db": database}).fetchone()[0]
                        proc_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM ALL_OBJECTS "
                            "WHERE OWNER=:db AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION')"
                        ), {"db": database}).fetchone()[0]
                        size_row = c.execute(text(
                            "SELECT COALESCE(SUM(BYTES),0) FROM DBA_SEGMENTS WHERE OWNER=:db"
                        ), {"db": database}).fetchone()
                        info["tables_count"] = tables_cnt or 0
                        info["views_count"] = views_cnt or 0
                        info["routines_count"] = proc_cnt or 0
                        info["size_str"] = _format_size(size_row[0] if size_row else 0)

                    elif db_type == 'mssql':
                        info["collation"] = c.execute(text(
                            "SELECT collation_name FROM sys.databases WHERE name=:db"
                        ), {"db": database}).fetchone()
                        info["collation"] = info["collation"][0] if info["collation"] else ""
                        info["charset"] = ""
                        tables_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM sys.tables"
                        )).fetchone()[0]
                        views_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM sys.views"
                        )).fetchone()[0]
                        proc_cnt = c.execute(text(
                            "SELECT COUNT(*) FROM sys.procedures"
                        )).fetchone()[0]
                        try:
                            size_row = c.execute(text(
                                "SELECT SUM(size)*8*1024 FROM sys.database_files WHERE type=0"
                            )).fetchone()
                        except:
                            size_row = None
                        info["tables_count"] = tables_cnt or 0
                        info["views_count"] = views_cnt or 0
                        info["routines_count"] = proc_cnt or 0
                        info["size_str"] = _format_size(size_row[0] if size_row else 0)

                engine.dispose()
                return {"ok": True, "info": info}
            except Exception as e:
                engine.dispose()
                return {"ok": False, "msg": _friendly_error(e, db_type)}

        return _with_db_timeout(_run_info(_get_db_info), timeout=15)

    except Exception as e:
        _finish_db_operation(op_state)
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


# ==================== 清理函数 ====================

# 启动时记录已存在的浏览器进程 PIDs，退出时只杀新增的（防止误杀用户其他浏览器窗口）
_known_browser_pids_at_startup = set()

def _record_existing_browser_pids():
    """程序启动时记录当前所有浏览器进程 PID"""
    import subprocess
    browser_names = {'chrome.exe', 'msedge.exe', 'chromium.exe', 'firefox.exe',
                     'brave.exe', 'opera.exe', 'iexplore.exe'}
    try:
        r = subprocess.run(
            ['tasklist', '/FO', 'CSV', '/NH'],
            capture_output=True, text=True, timeout=5,
            creationflags=0x08000000
        )
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                fields = line.replace('"', '').split(',')
                if len(fields) >= 2:
                    pname = fields[0].strip().lower()
                    pid_str = fields[1].strip()
                    if pname in browser_names:
                        _known_browser_pids_at_startup.add(int(pid_str))
            except (ValueError, IndexError):
                continue
    except Exception:
        pass


def _get_descendant_pids(pid):
    """使用 PowerShell 获取 pid 的所有后代进程 ID 列表（递归）
    因为 tasklist 默认不输出 ParentPID，必须用 PowerShell/WMI 才能正确获取父子关系
    """
    import subprocess
    result = []
    try:
        # PowerShell 递归查询所有后代进程
        ps_cmd = (
            f'Get-CimInstance -ClassName Win32_Process '
            f'| Where-Object {{$_.ParentProcessId -eq {pid}}} '
            f'| Select-Object -ExpandProperty ProcessId'
        )
        r = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps_cmd],
            capture_output=True, text=True, timeout=8,
            creationflags=0x08000000
        )
        if r.returncode == 0 and r.stdout.strip():
            for line in r.stdout.strip().splitlines():
                line = line.strip()
                if line.isdigit():
                    child_pid = int(line)
                    result.append(child_pid)
                    # 递归获取孙子进程
                    result.extend(_get_descendant_pids(child_pid))
    except Exception:
        pass
    return result


def _kill_new_browser_processes():
    """杀当前系统中新增的浏览器进程（相比启动时快照）"""
    import subprocess
    browser_names = {'chrome.exe', 'msedge.exe', 'chromium.exe', 'firefox.exe',
                     'brave.exe', 'opera.exe', 'iexplore.exe'}
    try:
        r = subprocess.run(
            ['tasklist', '/FO', 'CSV', '/NH'],
            capture_output=True, text=True, timeout=5,
            creationflags=0x08000000
        )
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                fields = line.replace('"', '').split(',')
                if len(fields) >= 2:
                    pname = fields[0].strip().lower()
                    pid_str = fields[1].strip()
                    cpid = int(pid_str)
                    if pname in browser_names and cpid not in _known_browser_pids_at_startup:
                        subprocess.run(
                            ['taskkill', '/F', '/T', '/PID', str(cpid)],
                            capture_output=True, timeout=3,
                            creationflags=0x08000000
                        )
            except (ValueError, IndexError):
                continue
    except Exception:
        pass


def _force_cleanup_and_exit():
    """关闭窗口后彻底清理所有子进程，防止 Chrome/Edge 后台残留"""
    pid = os.getpid()
    import subprocess

    # ★ 0: 先关闭线程池（让正在执行的 DB 线程尽快结束，避免进程等待退出）
    global _db_thread_pool
    if _db_thread_pool is not None:
        try:
            _db_thread_pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass

    # ★ 0a: 清空仪表盘最近 SQL 临时文件
    try:
        from modules.dashboard_cmds import clean_recent_cmds_tmp
        clean_recent_cmds_tmp()
    except Exception:
        pass

    # ① Windows 清理
    if sys.platform == 'win32':
        # 1a: 按 PID 树递归杀子进程（PowerShell 获取正确父子关系）
        try:
            all_children = _get_descendant_pids(pid)
            for cp in reversed(all_children):
                try:
                    subprocess.run(
                        ['taskkill', '/F', '/T', '/PID', str(cp)],
                        capture_output=True, timeout=3,
                        creationflags=0x08000000
                    )
                except Exception:
                    pass
        except Exception:
            pass

        # 1b: 按名称杀启动后新增的浏览器进程（兜底：PID 树可能因 PyInstaller 而断裂）
        _kill_new_browser_processes()

        # 1c: taskkill /F /T 杀当前进程整棵树
        try:
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(pid)],
                capture_output=True, timeout=3,
                creationflags=0x08000000
            )
        except Exception:
            pass

        # 1d: ★ 延迟自杀脚本 —— 即使上面的 taskkill 没生效，
        #     这个脚本也会在退出后 3 秒再次强制杀进程树
        _launch_delayed_killer(pid)
    else:
        try:
            os.killpg(os.getpgid(pid), 9)
        except Exception:
            try:
                os.kill(pid, 9)
            except Exception:
                pass

    # ② Win32 API 强制终止当前进程
    if sys.platform == 'win32':
        try:
            import ctypes
            ctypes.windll.kernel32.TerminateProcess(
                ctypes.windll.kernel32.GetCurrentProcess(), 0
            )
        except Exception:
            pass

    # Win32 TerminateProcess 已负责兜底；若调用失败则返回，让解释器正常清理。
    return


def _launch_delayed_killer(pid):
    """启动一个独立的延迟杀进程脚本（异步，不等待）"""
    if sys.platform != 'win32':
        return
    import tempfile
    try:
        bat_content = f'''@echo off
ping 127.0.0.1 -n 3 >nul
taskkill /F /T /PID {pid} >nul 2>&1
del "%~f0" >nul 2>&1
'''
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.bat', prefix='mqdb_kill_', delete=False)
        tmp.write(bat_content)
        tmp.close()
        import subprocess
        subprocess.Popen(
            ['cmd.exe', '/C', tmp.name],
            creationflags=0x08000000 | 0x00000008,  # CREATE_NO_WINDOW | DETACHED_PROCESS
            close_fds=True
        )
    except Exception:
        pass


# ==================== 启动 ====================
# ★ 在模块级别导入子模块（确保 @eel.expose 注册到 eel._exposed_functions）
#    不放在 if __name__ == "__main__" 内，因为 Flask 模式不会走 main 分支
try:
    import modules.datagrip_import
except ImportError:
    pass
try:
    import modules.replication_status  # 主从复制监控
    import modules.dashboard_cmds      # 仪表盘命令语句查询
except ImportError:
    pass

if __name__ == "__main__":
    # ★ PyInstaller onefile 在 Windows 上必须调用
    if sys.platform == 'win32' and getattr(sys, 'frozen', False):
        import multiprocessing
        multiprocessing.freeze_support()

    # 开发/打包自适应路径
    if getattr(sys, 'frozen', False):
        web_dir = os.path.join(sys._MEIPASS, "web")
        # 回退：如果 Eel 的 importlib_resources 在冻结环境加载 eel.js 失败，手动加载
        if not hasattr(eel, '_eel_js') or not eel._eel_js or len(eel._eel_js) < 100:
            eel_js_fallback = os.path.join(sys._MEIPASS, "eel", "eel.js")
            if os.path.exists(eel_js_fallback):
                with open(eel_js_fallback, "r", encoding="utf-8") as f:
                    eel._eel_js = f.read()
            elif os.path.exists(os.path.join(web_dir, "eel.js")):
                with open(os.path.join(web_dir, "eel.js"), "r", encoding="utf-8") as f:
                    eel._eel_js = f.read()
    else:
        web_dir = "web"
    eel.init(web_dir)

    # ★ Flask 适配层：自动检测 web/js/eel_adapter.js 存在时，优先用 Flask+PyWebView
    adapter_path = os.path.join(web_dir, "js", "eel_adapter.js")
    use_flask = os.path.exists(adapter_path)
    if use_flask:
        # Flask + PyWebView 模式（多线程、无浏览器残留）
        try:
            from app import create_app
            from main import start_webview, find_free_port
            port = find_free_port()
            app = create_app()
            flask_thread = threading.Thread(
                target=lambda: app.run(host='127.0.0.1', port=port, threaded=True, debug=False, use_reloader=False),
                daemon=True
            )
            flask_thread.start()
            start_webview(port)
            sys.exit(0)
        except Exception as _e:
            print(f"[main] Flask 启动失败，回退到 Eel: {_e}")

    # 回退到 Eel 模式
    if sys.platform == 'win32':
        _record_existing_browser_pids()
    import atexit
    atexit.register(_force_cleanup_and_exit)

    try:
        eel.start("index.html", size=(1280, 860), port=0, cmdline_args=[])
    finally:
        _force_cleanup_and_exit()
