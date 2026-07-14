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
        print("[oracledb] ✅ 已启用 Thick 模式（Oracle Client C 驱动）")
    except Exception:
        # Oracle Client 未安装或配置不正确，使用默认 Thin 模式
        print("[oracledb] ⚠️ Thick 模式不可用，使用 Thin 模式（安装 Oracle Instant Client 可提速）")
        pass
except ImportError:
    pass

# ==================== 配置路径 ====================
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILES_FILE = os.path.join(BASE_DIR, "db_profiles.json")
SETTINGS_FILE = os.path.join(BASE_DIR, "settings.json")

# ==================== 数据库操作日志 ====================
import logging

_LOG_FILE = os.path.join(BASE_DIR, "db_operation.log")

_db_op_logger = logging.getLogger("db_operation")
_db_op_logger.setLevel(logging.INFO)
_db_op_logger.propagate = False

if not _db_op_logger.handlers:
    _handler = logging.FileHandler(_LOG_FILE, encoding="utf-8")
    _handler.setFormatter(logging.Formatter('%(asctime)s | %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
    _db_op_logger.addHandler(_handler)


def _log_db_select(sql: str):
    """记录查询 SQL"""
    _db_op_logger.info(f"[SELECT] {sql}")


def _log_db_insert(sql: str):
    """记录新增 SQL"""
    _db_op_logger.info(f"[INSERT] {sql}")


def _log_db_update(sql: str, rollback_sql: str = ""):
    """记录修改 SQL + 回退 SQL"""
    _db_op_logger.info(f"[UPDATE] {sql}")
    if rollback_sql:
        _db_op_logger.info(f"[ROLLBACK] {rollback_sql}")


def _log_db_delete(sql: str, rollback_sql: str = ""):
    """记录删除 SQL + 回退 SQL"""
    _db_op_logger.info(f"[DELETE] {sql}")
    if rollback_sql:
        _db_op_logger.info(f"[ROLLBACK] {rollback_sql}")


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
_query_conn_cancel_flags = {}  # {conn_id: True} 记录哪些连接被取消了（用于线程内检查）
_query_job_conn = {}           # {job_id: conn_id} 记录哪个 job 属于哪个连接
_query_conn_data_map = {}      # {conn_id: conn_data} 保存连接数据用于 cancel 时 kill
_query_columns = []
_query_rows = []
_query_conn_id = None       # 当前查询的数据库连接 ID（用于 kill）
_query_src_data = None       # 当前查询的源库连接信息


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
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    @property
    def src_url(self) -> str:
        u = quote_plus(self.src_user)
        p = quote_plus(self.src_pwd)
        return f"mysql+mysqldb://{u}:{p}@{self.src_host}:{self.src_port}/{self.src_db}?charset=utf8mb4"

    @property
    def dst_url(self) -> str:
        u = quote_plus(self.dst_user)
        p = quote_plus(self.dst_pwd)
        return f"mysql+mysqldb://{u}:{p}@{self.dst_host}:{self.dst_port}/{self.dst_db}?charset=utf8mb4"

    @property
    def dst_url_no_db(self) -> str:
        u = quote_plus(self.dst_user)
        p = quote_plus(self.dst_pwd)
        return f"mysql+mysqldb://{u}:{p}@{self.dst_host}:{self.dst_port}?charset=utf8mb4"

    def _create_dst_database(self):
        tmp_engine = create_engine(self.dst_url_no_db, connect_args=_connect_args("mysql", timeout=10))
        with tmp_engine.connect() as conn:
            conn.execute(text("COMMIT"))
            conn.execute(text(
                f"CREATE DATABASE IF NOT EXISTS `{self.dst_db}` "
                f"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            ))
        _progress_q.put(("log", f"📦 目标数据库 [{self.dst_db}] 已就绪"))
        tmp_engine.dispose()

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
        result = conn.execute(text(f"SHOW CREATE TABLE `{table_name}`"))
        row = result.fetchone()
        return row[1] if row else ""

    def _create_all_tables(self, src_engine, dst_engine, tables: List[str]):
        _progress_q.put(("log", "📋 阶段1：创建所有表结构..."))
        ddls = {}
        with src_engine.connect() as src_conn:
            for table_name in tables:
                if self._stop_event.is_set():
                    return
                ddl = self._get_table_ddl(src_conn, table_name)
                if ddl:
                    ddls[table_name] = ddl
        with dst_engine.connect() as dst_conn:
            dst_conn.execute(text("COMMIT"))
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
            for table_name in tables:
                if self._stop_event.is_set():
                    break
                if table_name in ddls:
                    dst_conn.execute(text(f"DROP TABLE IF EXISTS `{table_name}`"))
                    # 清理 OceanBase 专有语法后执行
                    safe_ddl = self._sanitize_ddl(ddls[table_name])
                    dst_conn.execute(text(safe_ddl))
                    _progress_q.put(("log", f"  ✅ 表 [{table_name}] 结构已创建"))
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        _progress_q.put(("log", "✅ 所有表结构创建完成"))

    def _transfer_single_table(self, src_engine, dst_engine,
                               table_name: str, table_index: int,
                               total_tables: int, dst_conn) -> int:
        prefix = f"[{table_index}/{total_tables}]" if total_tables > 1 else ""
        _progress_q.put(("log", f"{prefix} 📊 表 [{table_name}] 开始传输..."))
        src_conn = src_engine.connect().execution_options(stream_results=True)
        result = src_conn.execute(text(f"SELECT * FROM `{table_name}`"))
        columns = list(result.keys())
        col_list = ', '.join(f'`{c}`' for c in columns)
        placeholder_list = ', '.join(f':{c}' for c in columns)
        insert_sql = text(f"INSERT INTO `{table_name}` ({col_list}) VALUES ({placeholder_list})")
        transferred = 0
        while not self._stop_event.is_set():
            rows = result.fetchmany(self.batch_size)
            if not rows:
                break
            batch = [dict(zip(columns, row)) for row in rows]
            dst_conn.execute(insert_sql, batch)
            transferred += len(rows)
            _progress_q.put(("table_progress", {"count": transferred, "table": table_name}))
        src_conn.close()
        _progress_q.put(("log", f"{prefix} ✅ 表 [{table_name}] 传输完成 ({transferred:,} 行)"))
        return transferred

    def run(self):
        try:
            _progress_q.put(("log", "🔗 正在连接源库..."))
            src_engine = create_engine(self.src_url, pool_pre_ping=True,
                                       connect_args=_connect_args("mysql", timeout=10))
            with src_engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            _progress_q.put(("log", "✅ 源库连接成功"))

            _progress_q.put(("log", "🔗 正在连接目标库..."))
            self._create_dst_database()
            dst_engine = create_engine(self.dst_url, pool_pre_ping=True,
                                       connect_args=_connect_args("mysql", timeout=10))
            _progress_q.put(("log", "✅ 目标库连接成功"))

            if self.table_name:
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
                with dst_engine.begin() as dst_conn:
                    dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
                    total_rows = 0
                    for i, table in enumerate(tables, 1):
                        if self._stop_event.is_set():
                            _progress_q.put(("log", "⏸ 用户停止传输"))
                            break
                        rows = self._transfer_single_table(
                            src_engine, dst_engine, table, i, len(tables), dst_conn)
                        total_rows += rows
                    dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))

                if not self._stop_event.is_set():
                    elapsed = time.time() - start_time
                    speed = total_rows / elapsed if elapsed > 0 else 0
                    msg = (f"✅ 全部完成！共 {len(tables)} 张表，{total_rows:,} 行，"
                           f"耗时 {elapsed:.1f}s (平均 {speed:,.0f} 行/秒)")
                    _progress_q.put(("done", msg))
                    _progress_q.put(("total", total_rows))

            src_engine.dispose()
            dst_engine.dispose()
        except Exception as e:
            _progress_q.put(("error", f"❌ 传输失败: {str(e)}"))


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
    """测试连接"""
    try:
        if side == "src":
            src_db = data.get('src_db', '').strip()
            if src_db:
                url = (f"mysql+mysqldb://{quote_plus(data['src_user'])}:"
                       f"{quote_plus(data['src_pwd'])}@{data['src_host']}:"
                       f"{data['src_port']}/{src_db}?charset=utf8mb4")
            else:
                # 不指定数据库，仅测试服务器连通性
                url = (f"mysql+mysqldb://{quote_plus(data['src_user'])}:"
                       f"{quote_plus(data['src_pwd'])}@{data['src_host']}:"
                       f"{data['src_port']}/?charset=utf8mb4")
            label = "源库"
            engine = create_engine(url, connect_args=_connect_args("mysql", timeout=5))
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            engine.dispose()
            return {"ok": True, "msg": f"{label}连接成功！"}
        else:
            # 目标库：先连服务器，再检查数据库是否存在
            label = "目标库"
            url_no_db = (f"mysql+mysqldb://{quote_plus(data['dst_user'])}:"
                         f"{quote_plus(data['dst_pwd'])}@{data['dst_host']}:"
                         f"{data['dst_port']}?charset=utf8mb4")
            engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=5))
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
                db_name = data.get('dst_db', '').strip()
                if db_name:
                    result = conn.execute(
                        text(f"SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA "
                             f"WHERE SCHEMA_NAME = :db"), {"db": db_name}
                    )
                    if not result.fetchone():
                        engine.dispose()
                        return {"ok": False,
                                "msg": f"服务器可连接，但数据库 [{db_name}] 不存在"}
            engine.dispose()
            return {"ok": True, "msg": f"{label}连接成功！"}
    except Exception as e:
        return {"ok": False, "msg": f"{label}连接失败: {str(e)}"}


@eel.expose
def start_transfer(data: dict):
    """开始传输"""
    global _engine, _worker
    _progress_q.queue.clear()

    _engine = TransferEngine(data)
    _worker = threading.Thread(target=_engine.run, daemon=True)
    _worker.start()
    return True


@eel.expose
def stop_transfer():
    """停止传输"""
    global _engine
    if _engine:
        _engine.stop()
    return True


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
    """检查当前查询是否已被取消（全局取消 OR 该连接被取消）"""
    if _query_cancel.is_set():
        return True
    if conn_key and _query_conn_cancel_flags.get(conn_key):
        return True
    return False


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
    global _query_columns, _query_rows, _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = data  # 保存源库信息用于 cancel 时 kill
    # ★ 保存连接数据映射（用于 cancel_query(conn_id) 时 kill 该连接的查询）
    if conn_key:
        _query_conn_data_map[conn_key] = data
        _query_job_conn[job_id] = conn_key
    DEFAULT_PAGE_SIZE = 200  # 首屏默认显示行数
    BATCH = 1000             # 每次从结果集取 1000 行进行处理

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
        # ★ 增加 read_timeout=120 以适应复杂慢查询
        if db_type in ('mysql', 'ob-mysql'):
            url = url.replace("?charset=utf8mb4", "?charset=utf8mb4&read_timeout=120") if "?" in url else url + "?charset=utf8mb4&read_timeout=120"
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            if _is_cancelled(conn_key):
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            # 记录连接 ID，用于 cancel 时 kill query（支持 MySQL/PG/Oracle/MSSQL）
            _query_conn_id = _get_backend_pid(conn, db_type)
            # ★ 增加 MySQL 服务器端执行超时为 120 秒（30秒对复杂查询太短）
            try:
                conn.execute(text("SET SESSION MAX_EXECUTION_TIME = 120000"))
            except Exception:
                pass

            import time as _time
            _t0 = _time.perf_counter()
            # ★ 先用 stream_results=True 让 execute() 不缓冲全量行（只获取元数据），
            #    再用 fetchmany 按批从服务端拉取，每批限量 max_fetch_rows 保护
            result = conn.execution_options(stream_results=True).execute(text(sql))
            _t_exec = _time.perf_counter()  # 查询提交 + 元数据接收完成

            if _is_cancelled(conn_key):
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            if result.returns_rows:
                _query_columns = list(result.keys())
                # ★ 批量 fetchmany 从服务端逐批拉取：
                #    避免了默认 Cursor 在 execute() 时一次性反序列化全量行
                #    → 大结果集（万行级 × Decimal 列）下可提速 5-10 倍
                _query_rows = []
                while True:
                    if _is_cancelled(conn_key):
                        result.close()
                        return {"ok": False, "msg": "查询已取消", "cancelled": True}
                    batch = result.fetchmany(BATCH)
                    if not batch:
                        break
                    for row in batch:
                        _query_rows.append(list(row))
                result.close()
            else:
                # INSERT/UPDATE/DELETE 等写入操作：提交并返回影响行数
                conn.commit()
                rc = result.rowcount
            _t1 = _time.perf_counter()
            _server_ms = round((_t1 - _t0) * 1000, 1)
            _exec_ms = round((_t_exec - _t0) * 1000, 1)
            _fetch_ms = round((_t1 - _t_exec) * 1000, 1)
        engine.dispose()
        # 写入操作提前返回（无需序列化行数据）
        if not result.returns_rows:
            return {"ok": True, "msg": f"成功执行，影响 {rc} 行", "columns": [], "rows": [], "total": rc,
                    "server_ms": _server_ms}

        if _is_cancelled(conn_key):
            return {"ok": False, "msg": "查询已取消", "cancelled": True}

        # ★ 将全量原始行存入持久存储，供后续按需加载
        total_rows = len(_query_rows)
        if job_id:
            # 清理旧的同名缓存（防止内存泄漏）
            _query_result_store.pop(job_id, None)
            _query_result_store[job_id] = {
                "columns": _query_columns,
                "rows_raw": _query_rows,
                "total": total_rows,
                "db_type": db_type
            }

        # ★ 首屏只 JSON 化前 DEFAULT_PAGE_SIZE 行（200行）；其余按需通过 get_query_page 加载
        _ts0 = _time.perf_counter()
        first_page_rows = _query_rows[:DEFAULT_PAGE_SIZE]
        safe_rows = [_row_to_json(r) for r in first_page_rows]
        _serial_ms = round((_time.perf_counter() - _ts0) * 1000, 1)

        return {
            "ok": True,
            "columns": _query_columns,
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
            "_job_id": job_id  # 回传 job_id 供后续加载使用
        }
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, data.get('db_type','mysql'))}


# ★ 异步查询结果存储（job_id → result or None=等待中）
_query_jobs = {}
# ★ 查询结果行数据持久存储（job_id → {columns, rows_raw, total, db_type}）
#    用于按需加载：首屏返回 200 行，后续通过 get_query_page 加载更多行
_query_result_store = {}

@eel.expose
def execute_sql_query(sql: str, data: dict):
    """执行 SQL 查询（异步模式：立即返回 job_id，不阻塞 Eel 主线程）
    
    JS 侧收到 _async=True 后，应轮询 poll_query_result(job_id) 获取结果。
    这样做彻底解决 future.result() 阻塞 bottle 单线程服务器问题，
    让执行 SQL 期间仍能打开数据库连接、切换查询 Tab 等。
    """
    import uuid
    job_id = str(uuid.uuid4())[:8]
    _query_jobs[job_id] = None  # None = 等待中

    # ★ 生成连接标识，用于后续 cancel_query(conn_id) 只取消该连接的查询
    conn_key = _make_conn_key(data)

    def _run():
        try:
            result = _do_execute_sql_query(sql, data, job_id=job_id, conn_key=conn_key)
        except Exception as e:
            result = {"ok": False, "msg": str(e)}
        _query_jobs[job_id] = result

    _get_db_thread_pool().submit(_run)
    return {"ok": True, "_async": True, "_job_id": job_id}

def _make_conn_key(data):
    """从连接数据生成唯一标识（用于区分不同连接的查询）"""
    return f"{data.get('host','')}:{data.get('port','')}:{data.get('user','')}:{data.get('db','')}"


@eel.expose
def poll_query_result(job_id: str):
    """轮询异步查询结果。返回 _pending=True 表示仍在执行中。"""
    if job_id not in _query_jobs:
        return {"ok": False, "msg": "未知的查询 ID"}
    result = _query_jobs[job_id]
    if result is None:
        return {"_pending": True}
    # 返回结果后清理 _query_jobs（但保留 _query_result_store 供分页使用）
    del _query_jobs[job_id]
    return result


@eel.expose
def get_query_page(job_id: str, offset: int = 0, limit: int = 200):
    """从已完成的查询中按偏移量获取指定行（用于按需加载/显示全部）。

    调用时机：前端已通过 poll_query_result 拿到首屏结果后，
    用户调整显示行数或点击"显示全部"时调用此接口。

    注意：单次最多返回 500 行，小批次响应快（每批 <0.3s），
    配合前端虚拟滚动异步递归加载，不会阻塞 bottle 主线程。
    """
    if job_id not in _query_result_store:
        return {"ok": False, "msg": "查询结果已过期，请重新执行"}
    store = _query_result_store[job_id]
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
    _query_result_store.pop(job_id, None)
    return True



@eel.expose
def clear_cancel():
    """清除取消标记（新操作开始前调用）"""
    _query_cancel.clear()
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
        _query_conn_cancel_flags[conn_id] = True
        # 清理该连接下的待完成任务
        for jid in list(_query_jobs.keys()):
            if _query_job_conn.get(jid) == conn_id and _query_jobs[jid] is None:
                _query_jobs[jid] = {"ok": False, "msg": "查询已取消", "cancelled": True}
        # 清理该连接的结果缓存
        for jid in list(_query_result_store.keys()):
            if _query_job_conn.get(jid) == conn_id:
                _query_result_store.pop(jid, None)
        # 杀掉该连接的数据库查询（如果有）
        _kill_db_query_for_conn(conn_id)
        print(f"[cancel_query] 已取消连接 {conn_id} 的查询")
    else:
        # 全局取消（兼容旧的 cancelExport / cancelExecQuery 等调用）
        _query_cancel.set()
        try:
            import modules
            modules._query_cancel.set()
        except Exception:
            pass
        for jid in list(_query_jobs.keys()):
            if _query_jobs[jid] is None:
                _query_jobs[jid] = {"ok": False, "msg": "查询已取消", "cancelled": True}
        for jid in list(_query_result_store.keys()):
            _query_result_store.pop(jid, None)
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
                # 获取该连接当前的 PID
                cid = _get_backend_pid(kc, db_type)
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
    global _query_conn_id, _query_src_data
    cid = _query_conn_id
    src = _query_src_data
    if not cid or not src:
        return
    try:
        db_type = src.get('db_type', 'mysql')
        kill_engine = create_engine(_conn_url(src), connect_args=_connect_args(db_type, timeout=5))
        try:
            with kill_engine.connect() as kc:
                # ★ 设置极短超时（kill 不应等太久）
                try:
                    if db_type == 'mysql' or db_type == 'ob-mysql':
                        kc.execute(text(f"KILL QUERY {cid}"))
                    elif db_type == 'postgresql':
                        kc.execute(text(f"SELECT pg_terminate_backend({cid})"))
                    elif db_type == 'oracle':
                        # Oracle: ALTER SYSTEM KILL SESSION 'sid,serial#'
                        kc.execute(text(f"ALTER SYSTEM KILL SESSION '{cid}' IMMEDIATE"))
                    elif db_type == 'mssql':
                        kc.execute(text(f"KILL {cid}"))
                except Exception:
                    pass
        finally:
            kill_engine.dispose()
    except Exception:
        pass


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


def _connect_args(db_type='mysql', timeout=10):
    """返回 create_engine 的 connect_args，MySQL 禁用 SSL"""
    if db_type == 'oracle':
        # oracledb tcp_connect_timeout 单位是秒（float），不是毫秒
        return {"tcp_connect_timeout": float(timeout)}
    args = {"connect_timeout": timeout}
    if db_type in ('mysql', 'ob-mysql'):
        # mysqlclient (MySQLdb) 用 ssl=False 禁用 SSL（不是 pymysql 的 ssl_disabled）
        args["ssl"] = False
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
    
    不阻塞 Eel 主线程：提交到线程池后立即返回 job_id，
    由 JS 侧轮询 poll_query_result 获取结果。
    从根本上解决 future.result() 阻塞 bottle 单线程服务器的问题，
    让执行慢查询期间仍能测试连接、展开数据库列表等。
    """
    import uuid
    job_id = str(uuid.uuid4())[:8]
    _query_jobs[job_id] = None  # None = 等待中

    def _run():
        try:
            result = func(*args, **kwargs)
        except Exception as e:
            result = {"ok": False, "msg": str(e)}
        # 只有当前 job 还未被 cancel 时才写入结果
        if job_id in _query_jobs:
            _query_jobs[job_id] = result

    _get_db_thread_pool().submit(_run)
    return {"ok": True, "_async": True, "_job_id": job_id}

# ==================== 表操作 ====================
def _safe_ident(ident, db_type='mysql'):
    """安全化列名：检测含特殊字符则用反引号/引号包裹"""
    if not ident: return ident
    if re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', ident):
        return ident
    if db_type in ('mysql', 'ob-mysql'):
        return f'`{ident}`'
    elif db_type in ('postgresql', 'oracle'):
        return f'"{ident}"'
    elif db_type == 'mssql':
        return f'[{ident}]'
    return ident

def _build_table_ref(conn_data, database, table_name, schema=''):
    """构建带正确引号的全限定表名（如 `db`.`tbl` / \"sch\".\"tbl\" / [db].[tbl]）"""
    db_type = conn_data.get("db_type", "mysql")
    if db_type in ('mysql', 'ob-mysql'):
        return f"`{database}`.`{table_name}`"
    elif db_type == 'postgresql':
        q = schema if schema else database
        return f'"{q}"."{table_name}"'
    elif db_type == 'oracle':
        return f'"{database}"."{table_name}"'
    elif db_type == 'mssql':
        return f"[{database}].[{table_name}]"
    return f"`{database}`.`{table_name}`"

@eel.expose
def table_preview_data(conn_data, database, table_name, schema='', order_col='', order_dir='', limit=None):
    """加载表数据（全量或限量）。limit 为空时全量，否则只取前 N 行"""
    global _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = None
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') == 'postgresql':
            cdata["db"] = database  # ★ PG 必须切到目标数据库
        elif cdata.get('db_type') != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        db_type = cdata.get('db_type', 'mysql')
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
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}


@eel.expose
def table_preview_data_fast(conn_data, database, table_name, schema='', order_col='', order_dir='', where_clause=''):
    """快速预览：取 51 行，不用 COUNT(*)（超大表 COUNT 太慢），用第51行判断是否有更多。支持可选 WHERE 筛选"""
    global _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = None
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'oracle':
            cdata["db"] = database  # ★ PG/MySQL 都要切到目标库
        tbl = _build_table_ref(cdata, database, table_name, schema)
        db_type = cdata.get('db_type', 'mysql')
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
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}


@eel.expose
def table_load_page(conn_data, database, table_name, schema='', offset=0, limit=50, order_col='', order_dir='', where_clause=''):
    """服务端分页加载：取 limit+1 行代替 COUNT(*)，用多出的一行判断是否还有更多。支持可选 WHERE 筛选"""
    global _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = cdata_saved = None
    try:
        cdata = dict(conn_data)
        cdata_saved = cdata  # for error handler
        if cdata.get('db_type') != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        db_type = cdata.get('db_type', 'mysql')
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
        return {"ok": False, "msg": _friendly_error(e, cdata_saved.get('db_type','mysql') if cdata_saved else 'mysql')}


def _sanitize_where_clause(where_clause):
    """在 WHERE 子句中，给 = / != / <> 操作符右侧未加引号的值自动加单引号，
    确保字符串精确匹配（如 securitycode = 000045 → securitycode = '000045'）。
    比较运算符 > / < / >= / <= 保持原样（数字比较）。"""
    if not where_clause:
        return where_clause

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
    where_clause = _sanitize_where_clause(where_clause)
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












def _get_where_columns(c, db_type, database, table_name):
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
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS "
            "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl AND NON_UNIQUE=0 AND INDEX_NAME!='PRIMARY' "
            "ORDER BY INDEX_NAME, SEQ_IN_INDEX"
        ), {"db": database, "tbl": table_name}).fetchall()
        if uniqs:
            return [r[0] for r in uniqs]
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
            "SELECT kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name "
            "WHERE tc.table_name=:tbl AND tc.constraint_type='UNIQUE' "
            "ORDER BY tc.constraint_name, kcu.ordinal_position"
        ), {"tbl": table_name}).fetchall()
        if uniqs:
            return [r[0] for r in uniqs]
    # 3. 兜底：返回 None，调用方使用所有列
    return None


def _build_where_clause(tbl, db_type, where_cols, columns, orig_row):
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
            if val == 'NULL' or val is None or str(val).upper() == 'NULL':
                where_parts.append(f"{_safe_ident(cname, db_type)} IS NULL")
            else:
                where_parts.append(f"{_safe_ident(cname, db_type)} = {_escape_str_val(str(val))}")
        except ValueError:
            pass
    return " AND ".join(where_parts) if where_parts else "1=1"


def _escape_str_val(val_str):
    """将字符串值安全地转为 SQL 字符串字面量（始终加引号）"""
    return "'" + val_str.replace("\\", "\\\\").replace("'", "\\'") + "'"


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
            where_cols = _get_where_columns(c, db_type, database, table_name)

        sqls = []
        for ch in changes:
            col = ch["col"]
            new_val = ch["newVal"]
            orig_row = ch.get("origRow", [])
            columns = ch.get("columns", [])
            set_clause = f"{_safe_ident(col, db_type)} = {_sql_value(new_val, db_type)}"
            where_clause = _build_where_clause(tbl, db_type, where_cols, columns, orig_row)
            sqls.append(f"UPDATE {tbl} SET {set_clause} WHERE {where_clause};")
        engine.dispose()
        return {"ok": True, "sql": "\n".join(sqls), "count": len(sqls)}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def table_exec_save(conn_data, database, table_name, schema, changes):
    """执行 UPDATE 修改（支持取消：循环中检测 _query_cancel，并记录连接 PID 供 Kill）"""
    global _query_conn_id, _query_src_data, _query_cancel
    _query_cancel.clear()
    cdata = dict(conn_data)
    db_type = cdata.get('db_type', 'mysql')
    if db_type != 'oracle':
        cdata["db"] = database
    tbl = _build_table_ref(cdata, database, table_name, schema)
    engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
    try:
        with engine.connect() as c:
            where_cols = _get_where_columns(c, db_type, database, table_name)
        with engine.begin() as c:
            # ★ 记录连接 PID，供 cancel 时 Kill
            _query_conn_id = _get_backend_pid(c, db_type)
            _query_src_data = cdata
            for ch in changes:
                if _query_cancel.is_set():
                    _kill_db_query()
                    return {"ok": False, "msg": "操作已取消", "cancelled": True}
                col = ch["col"]
                new_val = ch["newVal"]
                orig_row = ch.get("origRow", [])
                columns = ch.get("columns", [])
                set_clause = f"{_safe_ident(col, db_type)} = {_sql_value(new_val, db_type)}"
                where_clause = _build_where_clause(tbl, db_type, where_cols, columns, orig_row)
                update_sql = f"UPDATE {tbl} SET {set_clause} WHERE {where_clause}"
                result = c.execute(text(update_sql))
                # ★ 检查 rowcount：如果 WHERE 条件未匹配到行，说明 origRow 数据可能已过期
                rc = result.rowcount
                if rc == 0:
                    # 回退日志中只保留一条警告
                    _log_db_update(update_sql, f"-- WARNING: 0 rows affected, WHERE may not match")
                else:
                    # 生成回退 SQL：恢复到原值
                    old_val = orig_row[columns.index(col)] if col in columns else None
                    rollback_set = f"{_safe_ident(col, db_type)} = {_sql_value(old_val, db_type)}"
                    rollback_sql = f"UPDATE {tbl} SET {rollback_set} WHERE {where_clause};"
                    _log_db_update(update_sql, rollback_sql)
        return {"ok": True, "msg": f"成功修改 {len(changes)} 处"}
    except Exception as e:
        if _query_cancel.is_set():
            return {"ok": False, "msg": "操作已取消", "cancelled": True}
        return {"ok": False, "msg": str(e)}
    finally:
        _query_conn_id = None
        _query_src_data = None
        engine.dispose()


def _sql_value(val, db_type):
    if val is None or val == 'NULL':
        return 'NULL'
    val = str(val)
    # 尝试数字
    try:
        float(val)
        return val
    except:
        pass
    return "'" + val.replace("\\", "\\\\").replace("'", "\\'") + "'"


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
            where_cols = _get_where_columns(c, db_type, database, table_name)
        sqls = []
        for rd in rows_data:
            orig_row = rd.get("origRow", [])
            columns = rd.get("columns", [])
            where_clause = _build_where_clause(tbl, db_type, where_cols, columns, orig_row)
            sqls.append(f"DELETE FROM {tbl} WHERE {where_clause};")
        engine.dispose()
        return {"ok": True, "sql": "\n".join(sqls), "count": len(sqls)}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def table_exec_delete(conn_data, database, table_name, schema, rows_data):
    """执行 DELETE 删除"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as c:
            where_cols = _get_where_columns(c, db_type, database, table_name)
        with engine.begin() as c:
            for rd in rows_data:
                orig_row = rd.get("origRow", [])
                columns = rd.get("columns", [])
                where_clause = _build_where_clause(tbl, db_type, where_cols, columns, orig_row)
                delete_sql = f"DELETE FROM {tbl} WHERE {where_clause}"
                result = c.execute(text(delete_sql))
                # ★ 检查 rowcount：如果未删除任何行，可能数据已变化
                if result.rowcount == 0:
                    _log_db_delete(delete_sql, "-- WARNING: 0 rows affected, WHERE may not match")
                else:
                    # 生成回退 SQL：INSERT 恢复被删除的行
                    rollback_sql = _gen_rollback_insert(tbl, db_type, columns, orig_row)
                    _log_db_delete(delete_sql, rollback_sql)
        engine.dispose()
        return {"ok": True, "msg": f"成功删除 {len(rows_data)} 行"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


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
                row = conn.execute(text(f"SHOW CREATE TABLE `{database}`.`{table_name}`")).fetchone()
            ddl = row[1] if row else ""
        elif db_type == 'postgresql':
            q = schema if schema else database
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
                lines = [f'CREATE TABLE "{q}"."{table_name}" (']
                col_defs = []
                for c in cols:
                    null = ' NOT NULL' if c[5]=='NO' else ''
                    dflt = f' DEFAULT {c[6]}' if c[6] else ''
                    col_defs.append(f'  "{c[0]}" {c[1]}{dflt}{null}')
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
                        pk_cols = ', '.join(f'"{r[0]}"' for r in pk_rows)
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
                        col_defs.append(f'  CONSTRAINT "{fk[0]}" FOREIGN KEY ("{fk[1]}") REFERENCES "{q}"."{fk[2]}" ("{fk[3]}")')
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
                        lines.append(f'COMMENT ON COLUMN "{q}"."{table_name}"."{cr[0]}" IS \'{cmt}\';')
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
                        lines.append(f'COMMENT ON TABLE "{q}"."{table_name}" IS \'{tcmt}\';')
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
        else:
            with engine.connect() as conn:
                row = conn.execute(text(f"SHOW CREATE TABLE `{database}`.`{table_name}`")).fetchone()
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
                for r in cols:
                    result["columns"].append({
                        "name": r[0], "col_type": r[1], "data_type": r[1],
                        "length": r[2], "precision": r[3], "scale": r[4],
                        "nullable": r[5] == "YES",
                        "default_val": str(r[6]) if r[6] is not None else None,
                        "auto_increment": False,
                        "comment": pg_col_cmt.get(r[0], ""), "position": r[7]
                    })
                # ★ 获取索引
                try:
                    idx_r = conn.execute(text(
                        "SELECT i.relname, am.amname, array_agg(a.attname ORDER BY k.n) "
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
                            "name": ir[0], "type": "INDEX",
                            "columns": list(ir[2]) if ir[2] else [],
                            "method": ir[1] or "BTREE"
                        })
                except Exception:
                    pass
                # ★ 获取主键索引标记
                try:
                    pk_r = conn.execute(text(
                        "SELECT i.relname, array_agg(a.attname ORDER BY k.n) "
                        "FROM pg_index x "
                        "JOIN pg_class c ON c.oid=x.indrelid "
                        "JOIN pg_class i ON i.oid=x.indexrelid "
                        "JOIN pg_namespace n ON n.oid=c.relnamespace "
                        "JOIN LATERAL unnest(x.indkey) WITH ORDINALITY k(attnum, n) ON true "
                        "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum "
                        "WHERE n.nspname=:sch AND c.relname=:tbl AND x.indisprimary "
                        "GROUP BY i.relname"
                    ), {"sch": sch, "tbl": table_name}).fetchall()
                    for pr in pk_r:
                        result["indexes"].append({
                            "name": pr[0], "type": "PRIMARY",
                            "columns": list(pr[1]) if pr[1] else [], "method": "BTREE"
                        })
                except Exception:
                    pass
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

            else:
                # MSSQL 等暂返回基础列信息
                result["table_options"] = {"engine": "", "collation": "", "comment": ""}

        engine.dispose()
        return {"ok": True, "design": result}
    except Exception as e:
        db_t = cdata.get('db_type', 'mysql') if cdata else 'mysql'
        return {"ok": False, "msg": _friendly_error(e, db_t)}


@eel.expose
def table_apply_design(conn_data, database, table_name, design, schema='', execute=True):
    """应用表设计修改（生成并执行 ALTER TABLE），execute=False 时仅返回 SQL"""
    cdata = {}
    db_type = 'mysql'
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        tbl = _build_table_ref(cdata, database, table_name)

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
            existing_cols = set(r[0] for r in existing_rows)
            # 构建现有列详情
            existing_detail = {}
            for r in existing_detail_rows:
                existing_detail[r[0]] = {
                    "col_type": r[1] or "",
                    "nullable": r[2] == "YES",
                    "default_val": str(r[3]) if r[3] is not None else None,
                    "auto_increment": "auto_increment" in (r[4] or ""),
                    "comment": r[5] or ""
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
            # 现有表属性
            existing_opts = {}
            if existing_opt:
                existing_opts = {
                    "engine": (existing_opt[0] or "InnoDB").lower(),
                    "collation": (existing_opt[1] or "").lower(),
                    "comment": existing_opt[2] or ""
                }

            # ===== 三阶段 ALTER TABLE：先删索引 → 再改列 → 最后加索引 =====
            new_col_names = set(col.get("name", "") for col in columns)
            dropped_col_names = set(n for n in existing_detail if n not in new_col_names)

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
                    old_itype = "UNIQUE" if old_idx_info["type"] == "UNIQUE" else "INDEX"
                    pre_parts.append(f"DROP {old_itype} {_safe_ident(old_idx_name, db_type)}")

            # 1b. 删除被修改的已有索引（先DROP再在阶段3 ADD）
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    continue
                idx_name = idx["name"]
                if idx_name in existing_detail_idx and idx_name not in dropped_col_names:
                    old_idx = existing_detail_idx[idx_name]
                    new_cols = sorted(idx.get("columns", []))
                    old_cols = sorted(old_idx.get("columns", [])) if old_idx else []
                    idx_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                    old_idx_type = old_idx.get("type", "")
                    if new_cols != old_cols or idx_type != old_idx_type:
                        pre_parts.append(f"DROP {idx_type} {_safe_ident(idx_name, db_type)}")

            # 1c. 删除完全移除的索引
            new_idx_names = set(idx.get("name", "") for idx in indexes)
            for old_idx_name in existing_detail_idx:
                if old_idx_name == "PRIMARY":
                    continue
                if old_idx_name not in new_idx_names and old_idx_name not in dropped_col_names:
                    old_it = existing_detail_idx[old_idx_name]
                    old_itype = "UNIQUE" if old_it["type"] == "UNIQUE" else "INDEX"
                    pre_parts.append(f"DROP {old_itype} {_safe_ident(old_idx_name, db_type)}")

            # -- 阶段2：列操作 --
            for i, col in enumerate(columns):
                col_name = col.get("name", "")
                name = _safe_ident(col_name, db_type)
                col_type = col.get("col_type", col.get("data_type", "VARCHAR(255)"))
                nullable = " NULL" if col.get("nullable", True) else " NOT NULL"
                default = f" DEFAULT {col['default_val']}" if col.get("default_val") else ""
                auto_inc = " AUTO_INCREMENT" if col.get("auto_increment") else ""
                cmt_raw = col.get('comment', '')
                if cmt_raw:
                    cmt_esc = cmt_raw.replace("'", "\\'")
                    comment = f" COMMENT '{cmt_esc}'"
                else:
                    comment = ""
                after_clause = ""
                if i == 0:
                    after_clause = " FIRST"
                elif i > 0:
                    after_clause = f" AFTER {_safe_ident(columns[i-1]['name'], db_type)}"
                col_def = f"{name} {col_type}{nullable}{default}{auto_inc}{comment}"

                if col_name and col_name in existing_detail:
                    old = existing_detail[col_name]
                    new_type = (col.get("col_type") or col.get("data_type", "")).lower()
                    old_type = (old["col_type"] or "").lower()
                    changed = (
                        new_type != old_type
                        or col.get("nullable", True) != old["nullable"]
                        or col.get("default_val") != old["default_val"]
                        or col.get("auto_increment", False) != old["auto_increment"]
                        or col.get("comment", "") != old["comment"]
                    )
                    if changed:
                        mid_parts.append(f"MODIFY COLUMN {col_def}{after_clause}")
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
            old_pk_cols = set(old_pk.get("columns", []))
            new_pk_cols = set(pk_idx.get("columns", [])) if pk_idx else set()
            if pk_idx and new_pk_cols and (not old_pk_cols or new_pk_cols != old_pk_cols):
                pk_cols = ", ".join(_safe_ident(c, db_type) for c in pk_idx.get("columns", []))
                mid_parts.append(f"DROP PRIMARY KEY, ADD PRIMARY KEY ({pk_cols})")

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
                new_cols = sorted(idx_col_names)
                old_idx = existing_detail_idx.get(idx_name, {})
                old_cols = sorted(old_idx.get("columns", [])) if old_idx else []
                if idx_name in existing_detail_idx and new_cols == old_cols and idx_type == old_idx.get("type", ""):
                    continue
                post_parts.append(f"ADD {idx_type} {_safe_ident(idx_name, db_type)} ({', '.join(_safe_ident(c, db_type) for c in idx_col_names)})")

            # 表属性
            opts = table_options
            if opts.get("engine") and (opts["engine"].lower() != existing_opts.get("engine", "")):
                post_parts.append(f"ENGINE={opts['engine']}")
            if opts.get("collation") and (opts["collation"].lower() != existing_opts.get("collation", "")):
                post_parts.append(f"COLLATE={opts['collation']}")
            if opts.get("comment") is not None and opts.get("comment", "") != existing_opts.get("comment", ""):
                cmt = opts['comment'].replace("'", "\\'")
                post_parts.append(f"COMMENT='{cmt}'")

            alter_parts = pre_parts + mid_parts + post_parts

            if alter_parts:
                sqls.append(f"ALTER TABLE {tbl} {', '.join(alter_parts)}")

        elif db_type == 'postgresql':
            columns = design.get("columns", [])
            for col in columns:
                name = _safe_ident(col["name"], db_type)
                col_type = col.get("col_type", col.get("data_type", "VARCHAR(255)"))
                nullable = " DROP NOT NULL" if col.get("nullable", True) else " SET NOT NULL"
                default = f" SET DEFAULT {col['default_val']}" if col.get("default_val") else " DROP DEFAULT"
                sqls.append(f"ALTER TABLE {tbl} ALTER COLUMN {name} TYPE {col_type}, ALTER COLUMN {name}{nullable}, ALTER COLUMN {name}{default}")

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
                }

            # 构建现有索引详情
            existing_detail_idx = {}
            for r in existing_idx_rows:
                key_name = r[0]
                if key_name not in existing_detail_idx:
                    existing_detail_idx[key_name] = {
                        "type": "UNIQUE" if r[1] == 'UNIQUE' else "INDEX",
                        "columns": [], "method": r[3] or "BTREE"
                    }
                existing_detail_idx[key_name]["columns"].append(r[2])
            # 主键列
            old_pk_cols = set(r[0] for r in pk_rows)

            # 新列名集合
            new_col_names = set(col.get("name", "").upper() for col in columns)
            dropped_col_names = set(n for n in existing_detail if n.upper() not in new_col_names)

            # ===== 阶段1：删除受影响的索引（DROP INDEX 是独立语句）=====
            new_idx_names = set(idx.get("name", "").upper() for idx in indexes)
            for old_idx_name, old_idx_info in existing_detail_idx.items():
                # 跳过主键自动创建的索引（由主键约束管理）
                if old_idx_name in old_pk_cols or old_idx_name.startswith('SYS_'):
                    continue
                idx_cols = set(c.upper() for c in old_idx_info.get("columns", []))
                # 引用被删列的索引 / 完全移除的索引 → 删除
                if (idx_cols & dropped_col_names) or (old_idx_name not in new_idx_names):
                    sqls.append(f'DROP INDEX "{old_idx_name}"')
                else:
                    # 检查是否需要重建（列或类型变化）
                    for idx in indexes:
                        if idx.get("name", "").upper() == old_idx_name:
                            new_cols = sorted(c.upper() for c in idx.get("columns", []))
                            old_cols = sorted(c.upper() for c in old_idx_info.get("columns", []))
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
            for col in columns:
                col_name = col.get("name", "")
                col_name_up = col_name.upper()
                col_type = col.get("col_type", col.get("data_type", "VARCHAR2(255)"))
                # ★ 防护：无长度类型去掉多余的括号（如 DATE(7) → DATE）
                _base_type = col_type.split('(')[0].strip().upper()
                if _base_type in _ORA_NO_LEN:
                    col_type = _base_type

                if col_name_up in existing_detail:
                    old = existing_detail[col_name_up]
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
            new_pk_cols = set(c.upper() for c in pk_idx.get("columns", [])) if pk_idx else set()
            if pk_idx and new_pk_cols and new_pk_cols != old_pk_cols:
                if old_pk_cols:
                    sqls.append(f'ALTER TABLE {tbl} DROP PRIMARY KEY')
                pk_cols = ", ".join(f'"{c}"' for c in pk_idx.get("columns", []))
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
                    new_cols = sorted(c.upper() for c in idx_col_names)
                    old_cols = sorted(c.upper() for c in old_idx.get("columns", []))
                    new_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                    if new_cols == old_cols and new_type == old_idx["type"]:
                        continue
                unique_kw = "UNIQUE " if idx.get("type") == "UNIQUE" else ""
                idx_cols = ", ".join(f'"{c}"' for c in idx_col_names)
                sqls.append(f'CREATE {unique_kw}INDEX "{idx_name_up}" ON {tbl} ({idx_cols})')

            # ===== 阶段5：列注释 =====
            for col in columns:
                cmt = col.get("comment", "")
                if cmt:
                    cmt_esc = cmt.replace("'", "''")
                    col_name_up = col.get("name", "").upper()
                    sqls.append(f'COMMENT ON COLUMN {tbl}."{col_name_up}" IS \'{cmt_esc}\'')

            # 表注释
            opts = design.get("table_options", {})
            if opts.get("comment"):
                cmt_esc = opts["comment"].replace("'", "''")
                sqls.append(f'COMMENT ON TABLE {tbl} IS \'{cmt_esc}\'')

        else:
            engine.dispose()
            return {"ok": False, "msg": f"数据库类型 [{db_type}] 暂不支持表设计器"}

        if not sqls:
            engine.dispose()
            return {"ok": True, "msg": "无变更", "sqls": []}

        if execute:
            with engine.begin() as conn:
                for sql in sqls:
                    conn.execute(text(sql))
            engine.dispose()
            return {"ok": True, "msg": f"表 [{table_name}] 设计已更新"}
        else:
            engine.dispose()
            return {"ok": True, "msg": f"共 {len(sqls)} 条变更", "sqls": sqls, "preview": True}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type or 'mysql')}


@eel.expose
def table_truncate(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'oracle': cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        sql = f"TRUNCATE TABLE {tbl}"
        with engine.begin() as conn: conn.execute(text(sql))
        engine.dispose()
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已截断"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}

@eel.expose
def table_delete(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'oracle': cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        sql = f"DROP TABLE {tbl}"
        with engine.begin() as conn: conn.execute(text(sql))
        engine.dispose()
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已删除"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}

@eel.expose
def table_clear(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') != 'oracle': cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        sql = f"DELETE FROM {tbl}"
        with engine.begin() as conn: conn.execute(text(sql))
        engine.dispose()
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已清空"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}


@eel.expose
def table_rename(conn_data, database, old_name, new_name, schema=''):
    """重命名表"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        old_tbl = _build_table_ref(cdata, database, old_name, schema)
        new_tbl = _build_table_ref(cdata, database, new_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type == 'mssql':
            sql = f"EXEC sp_rename '{old_tbl}', '{new_name}'"
        elif db_type in ('mysql', 'ob-mysql'):
            # MySQL: RENAME TABLE 不需要列级引用
            sql = f"RENAME TABLE `{database}`.`{old_name}` TO `{database}`.`{new_name}`"
        elif db_type == 'postgresql':
            q = schema if schema else database
            sql = f'ALTER TABLE "{q}"."{old_name}" RENAME TO "{new_name}"'
        elif db_type == 'oracle':
            sql = f'ALTER TABLE "{database}"."{old_name}" RENAME TO "{new_name}"'
        else:
            sql = f"RENAME TABLE `{database}`.`{old_name}` TO `{database}`.`{new_name}`"
        with engine.begin() as conn:
            conn.execute(text(sql))
        engine.dispose()
        _db_op_logger.info(f"[RENAME] {old_tbl} → {new_tbl}")
        return {"ok": True, "msg": f"表 [{old_name}] 已重命名为 [{new_name}]"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


@eel.expose
def table_backup(conn_data, database, table_name, schema=''):
    """备份表：创建结构+数据相同的副本，表名=当前日期(MMDD_HH)，重名追加_1"""
    try:
        from datetime import datetime as dt
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        src_tbl = _build_table_ref(cdata, database, table_name, schema)
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
            if db_type in ('mysql', 'ob-mysql'):
                conn.execute(text(f"CREATE TABLE `{database}`.`{backup_name}` LIKE `{database}`.`{table_name}`"))
                conn.execute(text(f"INSERT INTO `{database}`.`{backup_name}` SELECT * FROM `{database}`.`{table_name}`"))
            elif db_type == 'postgresql':
                q = schema if schema else database
                conn.execute(text(f'CREATE TABLE "{q}"."{backup_name}" (LIKE "{q}"."{table_name}" INCLUDING ALL)'))
                conn.execute(text(f'INSERT INTO "{q}"."{backup_name}" SELECT * FROM "{q}"."{table_name}"'))
            elif db_type == 'oracle':
                conn.execute(text(f'CREATE TABLE "{database}"."{backup_name}" AS SELECT * FROM "{database}"."{table_name}"'))
            elif db_type == 'mssql':
                conn.execute(text(f"SELECT * INTO [{database}].[{backup_name}] FROM [{database}].[{table_name}]"))
            else:
                conn.execute(text(f"CREATE TABLE `{database}`.`{backup_name}` LIKE `{database}`.`{table_name}`"))
                conn.execute(text(f"INSERT INTO `{database}`.`{backup_name}` SELECT * FROM `{database}`.`{table_name}`"))
        engine.dispose()
        _db_op_logger.info(f"[BACKUP] {src_tbl} → {dst_tbl}")
        return {"ok": True, "msg": f"表 [{table_name}] 已备份为 [{backup_name}]"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


# ==================== 新建表 / 执行建表 SQL ====================
@eel.expose
def table_execute_sql(conn_data, database, sql, schema=''):
    """执行一个 SQL 语句（用于新建表等操作）"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.begin() as conn:
            conn.execute(text(sql))
        engine.dispose()
        _db_op_logger.info(f"[EXEC_SQL] 执行成功: {sql[:200]}...")
        return {"ok": True, "msg": "操作成功"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


# ==================== 删除字段 / 索引 / 外键 ====================
@eel.expose
def table_drop_column(conn_data, database, table_name, column_name, schema=''):
    """删除表中某个字段"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        # SQLDbx compatible quoting
        q = '"' if db_type in ('postgresql', 'oracle') else '`'
        sql = f"ALTER TABLE {tbl} DROP COLUMN {q}{column_name}{q}"
        with engine.begin() as conn:
            conn.execute(text(sql))
        engine.dispose()
        _db_op_logger.info(f"[DROP_COL] {tbl}.{column_name}")
        return {"ok": True, "msg": f"字段 [{column_name}] 已删除"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


@eel.expose
def table_drop_index(conn_data, database, table_name, index_name, schema=''):
    """删除表中某个索引"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        q = '"' if db_type in ('postgresql', 'oracle') else '`'
        if db_type == 'postgresql':
            sch = schema if schema else database
            sql = f'DROP INDEX {q}{sch}{q}.{q}{index_name}{q}'
        elif db_type == 'oracle':
            sql = f'DROP INDEX {q}{index_name}{q}'
        else:
            sql = f"ALTER TABLE {tbl} DROP INDEX {q}{index_name}{q}"
        with engine.begin() as conn:
            conn.execute(text(sql))
        engine.dispose()
        _db_op_logger.info(f"[DROP_IDX] {tbl}.{index_name}")
        return {"ok": True, "msg": f"索引 [{index_name}] 已删除"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


@eel.expose
def table_drop_foreign_key(conn_data, database, table_name, fk_name, schema=''):
    """删除表中某个外键"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        q = '"' if db_type in ('postgresql', 'oracle') else '`'
        if db_type in ('postgresql', 'oracle'):
            sql = f'ALTER TABLE {tbl} DROP CONSTRAINT {q}{fk_name}{q}'
        else:
            sql = f"ALTER TABLE {tbl} DROP FOREIGN KEY {q}{fk_name}{q}"
        with engine.begin() as conn:
            conn.execute(text(sql))
        engine.dispose()
        _db_op_logger.info(f"[DROP_FK] {tbl}.{fk_name}")
        return {"ok": True, "msg": f"外键 [{fk_name}] 已删除"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


# ==================== 树形栏目持久化（含自动备份恢复） ====================
_tree_lock = threading.RLock()  # 可重入锁，防止并发写竞争导致数据丢失（tree_delete_folder 有递归调用）
_tree_cache_data = None  # ★ _load_tree 内存缓存
_tree_cache_mtime = 0    # ★ 缓存对应的文件修改时间
if getattr(sys, 'frozen', False):
    # 打包exe环境：exe在dist/目录，直接读取同目录下的文件
    TREE_FILE = os.path.join(BASE_DIR, "navicat_tree.json")
else:
    # 源码运行环境：从dist/目录读取
    TREE_FILE = os.path.join(BASE_DIR, "dist", "navicat_tree.json")
TREE_BACKUP_DIR = os.path.join(BASE_DIR, ".tree_backups")
MAX_BACKUPS = 5  # 最多保留 5 份备份


# 确保目录存在
try:
    os.makedirs(TREE_BACKUP_DIR, exist_ok=True)
except Exception:
    pass

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

def _backup_tree():
    """备份当前的 navicat_tree.json（如果文件有有效数据）"""
    try:
        if not os.path.exists(TREE_FILE) or os.path.getsize(TREE_FILE) == 0:
            return
        with open(TREE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not _validate_tree(data):
            return
        # 检查是否有实际内容值得备份
        if not _tree_has_content(data):
            return
        # 生成备份文件名
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = os.path.join(TREE_BACKUP_DIR, f"navicat_tree_{timestamp}.json")
        with open(backup_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # 清理旧备份：只保留最新的 MAX_BACKUPS 份
        backups = sorted(
            [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")],
            reverse=True
        )
        for old_bak in backups[MAX_BACKUPS:]:
            try:
                os.remove(os.path.join(TREE_BACKUP_DIR, old_bak))
            except Exception:
                pass
    except Exception:
        pass  # 备份失败不影响主流程

_LAST_AUTO_BACKUP = 0  # 上次自动备份的时间戳

def _maybe_auto_backup():
    """每隔一定时间自动备份（仅在 _load_tree 时调用）"""
    global _LAST_AUTO_BACKUP
    now = time.time()
    if now - _LAST_AUTO_BACKUP < 3600:  # 1小时
        return
    try:
        _backup_tree()
        _LAST_AUTO_BACKUP = now
    except Exception:
        pass

def _recover_from_backup():
    """尝试从 .tree_backups/ 备份恢复数据"""
    try:
        if os.path.exists(TREE_BACKUP_DIR):
            backups = sorted(
                [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")],
                reverse=True
            )
            for bak_file in backups:
                bak_path = os.path.join(TREE_BACKUP_DIR, bak_file)
                try:
                    with open(bak_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if _validate_tree(data) and _tree_has_content(data):
                        # 恢复成功：用备份覆盖主文件
                        with open(TREE_FILE, "w", encoding="utf-8") as f:
                            json.dump(data, f, ensure_ascii=False, indent=2)
                        print("[tree] 已从备份恢复数据:", bak_file)
                        return data
                except Exception:
                    continue
    except Exception:
        pass
    return None

# 初始化：文件不存在就创建；存在但为空/损坏则尝试恢复
try:
    print(f"[tree] 初始化: frozen={getattr(sys, 'frozen', False)}, TREE_FILE={TREE_FILE}")
    if not os.path.exists(TREE_FILE):
        print("[tree] 初始化: TREE_FILE 不存在，尝试从备份恢复")
        recovered = _recover_from_backup()
        if not recovered:
            print("[tree] 初始化: 无可用备份，创建空文件")
            with open(TREE_FILE, "w", encoding="utf-8") as f:
                json.dump({"folders": [], "connections": {}, "saved_queries": []}, f, ensure_ascii=False, indent=2)
        else:
            print("[tree] 初始化: 从备份恢复成功")
    else:
        file_size = os.path.getsize(TREE_FILE)
        print(f"[tree] 初始化: 文件已存在，size={file_size} bytes")
        # 文件存在但内容为空或只有空壳数据 → 尝试恢复
        try:
            if file_size < 200:
                print("[tree] 初始化: 文件<200字节，检查是否空壳")
                with open(TREE_FILE, "r", encoding="utf-8") as f:
                    init_data = json.load(f)
                if _is_empty_shell(init_data):
                    print("[tree] 初始化: 空壳数据，尝试从备份恢复")
                    recovered = _recover_from_backup()
        except Exception as e:
            print(f"[tree] 初始化: 检查文件时异常 {e}")
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
            print("[tree] _load_tree: 文件为空，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                _tree_cache_data, _tree_cache_mtime = recovered, cur_mtime
                return recovered
            # ★ 空文件且无备份，不缓存，下次重新读
            return {"folders": [], "connections": {}, "saved_queries": []}
        data = json.loads(content)
        conn_count = len(data.get("connections", {}))
        print(f"[tree] _load_tree: 解析成功，connections={conn_count}, folders={len(data.get('folders',[]))}, queries={len(data.get('saved_queries',[]))}")
        if not _validate_tree(data):
            print("[tree] _load_tree: 数据格式不正确，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                _tree_cache_data, _tree_cache_mtime = recovered, cur_mtime
                return recovered
            return {"folders": [], "connections": {}, "saved_queries": []}
        # 【关键】结构合法但内容为空（空壳），尝试恢复
        if _is_empty_shell(data):
            print("[tree] _load_tree: 空壳数据，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                _tree_cache_data, _tree_cache_mtime = recovered, cur_mtime
                return recovered
        # 正常加载
        # ★ 迁移旧 saved_queries 到文件系统（仅首次加载时执行）
        if data.get("saved_queries"):
            _migrate_old_queries(tree=data)
            # 重新加载（迁移后 saved_queries 已被清除）
            return _load_tree()
        _tree_cache_data, _tree_cache_mtime = data, cur_mtime
        return data
    except json.JSONDecodeError as e:
        print(f"[tree] _load_tree JSON解析失败: {e}")
        recovered = _recover_from_backup()
        if recovered:
            _tree_cache_data, _tree_cache_mtime = recovered, cur_mtime
            return recovered
        # ★ JSON 解析失败不缓存空数据，下次重新读文件（文件可能正在写入中）
        return {"folders": [], "connections": {}, "saved_queries": []}
    except FileNotFoundError:
        print(f"[tree] _load_tree: 文件不存在 TREE_FILE={TREE_FILE}")
        recovered = _recover_from_backup()
        if recovered:
            _tree_cache_data, _tree_cache_mtime = recovered, cur_mtime
            return recovered
        return {"folders": [], "connections": {}, "saved_queries": []}
    except Exception as e:
        print(f"[tree] _load_tree 异常: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        # ★ 异常时不缓存，下次重试
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
        # 保存前先备份
        _backup_tree()
        # 原子写入：先写临时文件，再替换（防止写入中途崩溃损坏数据）
        tmp_file = TREE_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
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
        "backup_dir": TREE_BACKUP_DIR,
        "backup_dir_exists": os.path.exists(TREE_BACKUP_DIR),
    }
    if info["tree_file_exists"] and info["tree_file_size"] > 0:
        try:
            with open(TREE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            info["connections_count"] = len(data.get("connections", {}))
            info["folders_count"] = len(data.get("folders", []))
            # 查询已迁移到文件系统，统计 queries/ 目录下的文件数
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
    info["backups"] = []
    try:
        if os.path.exists(TREE_BACKUP_DIR):
            backups = sorted([b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_")], reverse=True)[:5]
            info["backups"] = backups
    except Exception:
        pass
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
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
    except Exception:
        pass
    return {"theme": "dark"}

def _save_settings_disk(data):
    """保存用户设置到磁盘"""
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[settings] 保存失败: {e}")
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
    return {
        "tree_file": TREE_FILE,
        "profiles_file": PROFILES_FILE,
        "log_file": _LOG_FILE,
        "settings_file": SETTINGS_FILE
    }

@eel.expose
def tree_backup_now():
    """手动触发备份"""
    try:
        _backup_tree()
        return {"ok": True, "msg": "备份完成"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
@eel.expose
def tree_get_backups():
    """获取备份文件列表"""
    try:
        if not os.path.exists(TREE_BACKUP_DIR):
            return {"ok": True, "backups": []}
        backups = sorted(
            [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")],
            reverse=True
        )
        result = []
        for b in backups:
            path = os.path.join(TREE_BACKUP_DIR, b)
            try:
                size = os.path.getsize(path)
                ts_str = b.replace("navicat_tree_", "").replace(".json", "")
                result.append({"name": b, "size": size, "ts": ts_str})
            except Exception:
                pass
        return {"ok": True, "backups": result}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
@eel.expose
def tree_force_recover():
    """强制从备份或 dist/ 恢复数据，返回恢复结果"""
    try:
        recovered = _recover_from_backup()
        if recovered:
            conn_count = len(recovered.get("connections", {}))
            return {"ok": True, "msg": f"已恢复 {conn_count} 个连接", "connections": conn_count}
        return {"ok": False, "msg": "未找到可恢复的备份文件", "connections": 0}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
@eel.expose
def tree_check_integrity():
    """检查 navicat_tree.json 完整性，返回诊断信息"""
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
            # 检查是否有备份可用
            has_backup = False
            if os.path.exists(TREE_BACKUP_DIR):
                backups = [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")]
                has_backup = len(backups) > 0
            result["has_backup"] = has_backup
        else:
            result["file_size"] = 0
            result["issues"].append("navicat_tree.json 不存在")
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

def _conn_url(conn_data):
    u = quote_plus(conn_data["user"]); p = quote_plus(conn_data["pwd"])
    h = conn_data['host']; port = conn_data.get('port', '3306')
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

@eel.expose
def db_explore_get_tables(conn_data, database, schema=''):
    cdata = dict(conn_data)
    if cdata.get("db_type") != 'oracle':
        cdata["db"] = database
    db_type = cdata.get("db_type", "mysql")
    try:
        def _get_tables():
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
            try:
                with engine.connect() as c:
                    if db_type == 'oracle':
                        print(f"[Oracle get_tables] database={database!r}, user={cdata.get('user','')!r}")
                        # ★ 用 USER_SEGMENTS 替代 ALL_SEGMENTS（ZX 等普通用户无 ALL_SEGMENTS 权限会导致 ORA-00942）
                        rows = c.execute(text(
                            "SELECT t.TABLE_NAME, t.NUM_ROWS, "
                            "COALESCE((SELECT SUM(s.BYTES) FROM USER_SEGMENTS s WHERE s.SEGMENT_NAME=t.TABLE_NAME),0), "
                            "COALESCE((SELECT c.COMMENTS FROM USER_TAB_COMMENTS c WHERE c.TABLE_NAME=t.TABLE_NAME AND c.TABLE_TYPE='TABLE'),'') "
                            "FROM USER_TABLES t ORDER BY t.TABLE_NAME"
                        )).fetchall()
                        print(f"[Oracle get_tables] found {len(rows)} tables for user={database!r}")
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
        return _with_db_timeout(_get_tables, timeout=15)

    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}


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
                    "AND STATUS='VALID' ORDER BY OBJECT_NAME"
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
            else:
                row = c.execute(text(f"SHOW CREATE TABLE `{database}`.`{table_name}`")).fetchone()
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
                conn.execute(text(f"DROP DATABASE IF EXISTS `{database}`"))
            elif db_type == 'postgresql':
                conn.execute(text("COMMIT"))
                conn.execute(text(f"DROP DATABASE IF EXISTS \"{database}\""))
            elif db_type == 'mssql':
                conn.execute(text(f"DROP DATABASE IF EXISTS [{database}]"))
            elif db_type == 'oracle':
                conn.execute(text(f"DROP USER {database} CASCADE"))
        engine.dispose()
        return {"ok": True, "msg": f"数据库 [{database}] 已删除"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, db_type)}


@eel.expose
def db_run_sql_file(conn_data, database, file_path, content=''):
    """在指定数据库上运行 SQL 文件（支持直接传内容或文件路径）"""
    def _check_db_prefix(content, db_type, target_db):
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
        try:
            cdata = dict(conn_data)
            db_type = cdata.get('db_type', 'mysql')
            if db_type != 'oracle':
                cdata["db"] = database
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
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
                for stmt in statements:
                    try:
                        conn.execute(text(stmt)); done += 1
                        if done % 50 == 0:
                            _progress_q.put(("sql_run_progress", {"total": total, "processed": done}))
                    except Exception as se:
                        _progress_q.put(("sql_run_log", str(se)[:200]))
            engine.dispose()
            _progress_q.put(("sql_run_done", {"total": total, "processed": done}))
        except Exception as e:
            _progress_q.put(("sql_run_error", {"msg": str(e)}))
    _progress_q.queue.clear()
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
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type in ('mysql', 'ob-mysql'):
            raw = engine.raw_connection()
            try:
                raw.cursor().execute(f"CREATE DATABASE `{db_name}` CHARACTER SET {charset} COLLATE {collation}")
                raw.commit()
            finally:
                raw.close()
        elif db_type == 'postgresql':
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10),
                                   isolation_level="AUTOCOMMIT")
            with engine.connect() as conn:
                conn.execute(text(f"CREATE DATABASE \"{db_name}\""))
        else:
            with engine.begin() as conn:
                conn.execute(text(f"CREATE DATABASE \"{db_name}\""))
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
    """将 navicat_tree.json 中的旧 saved_queries 迁移到 queries/ 文件夹
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
                        # SQL 内容从第一个空行后开始
                        sql = ''
                        lines = content.split('\n')
                        for i, line in enumerate(lines):
                            if line.strip() == '' and i > 3:
                                sql = '\n'.join(lines[i+1:]).strip()
                                break
                        if not sql and lines:
                            # 如果找不到空行，从第5行开始取
                            sql = '\n'.join(lines[4:]).strip() if len(lines) > 4 else ''
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
            "IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE "
            "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
        ), {"db": db_name, "tbl": table_name}).fetchall()
        return [{"name": r[0], "type": r[7] or r[1], "nullable": r[5] == 'YES', "default": r[6]} for r in rows]
    elif db_type == 'postgresql':
        rows = conn.execute(text(
            "SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, "
            "is_nullable, column_default, udt_name "
            "FROM information_schema.columns WHERE table_schema=:sch AND table_name=:tbl ORDER BY ordinal_position"
        ), {"sch": db_name, "tbl": table_name}).fetchall()
        cols = []
        for r in rows:
            dt = r[1]
            if r[2]: dt += f"({r[2]})"
            elif r[3] and r[5]: dt += f"({r[3]},{r[5]})"
            elif r[3]: dt += f"({r[3]})"
            cols.append({"name": r[0], "type": dt, "nullable": r[5] == 'YES', "default": r[6]})
        return cols
    elif db_type == 'oracle':
        rows = conn.execute(text(
            "SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, "
            "NULLABLE, DATA_DEFAULT "
            "FROM ALL_TAB_COLUMNS WHERE OWNER=:db AND TABLE_NAME=:tbl ORDER BY COLUMN_ID"
        ), {"db": db_name, "tbl": table_name}).fetchall()
        cols = []
        for r in rows:
            dt = r[1]
            if dt in ('NUMBER',) and r[3] and r[4]:
                dt += f"({r[3]},{r[4]})"
            elif r[2]:
                dt += f"({int(r[2])})"
            cols.append({"name": r[0], "type": dt, "nullable": r[5] == 'Y', "default": r[6]})
        return cols
    elif db_type == 'mssql':
        rows = conn.execute(text(
            "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, "
            "IS_NULLABLE, COLUMN_DEFAULT "
            "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
        ), {"tbl": table_name}).fetchall()
        cols = []
        for r in rows:
            dt = r[1]
            if r[2]: dt += f"({r[2]})"
            elif r[3] and r[5]: dt += f"({r[3]},{r[5]})"
            elif r[3]: dt += f"({r[3]})"
            cols.append({"name": r[0], "type": dt, "nullable": r[5] == 'YES', "default": r[6]})
        return cols
    return []


def _get_index_info(conn, db_type, db_name, table_name):
    """从源表获取索引信息（PRIMARY KEY / UNIQUE / 普通索引），支持 MySQL/PG/Oracle/MSSQL。
    返回格式: {
        "primary_key": ["col1", "col2"],  # 主键列名列表，可能为空
        "unique": [{"name":"idx_name","columns":["col1","col2"]}, ...],
        "indexes": [{"name":"idx_name","columns":["col1","col2"]}, ...]
    }
    """
    result = {"primary_key": [], "unique": [], "indexes": []}
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
    except Exception:
        pass
    return result

def _generate_create_table(db_type, tbl, cols, indexes=None):
    """根据目标数据库类型生成 CREATE TABLE 语句（含主键/唯一/索引约束）"""
    if not cols:
        raise ValueError("无列信息")
    if indexes is None:
        indexes = {}

    # 每列 SQL
    col_lines = []
    for c in cols:
        col_name = _safe_ident(c["name"], db_type)
        null = '' if c.get("nullable", True) else ' NOT NULL'
        dflt = f' DEFAULT {c["default"]}' if c.get("default") else ''
        col_lines.append(f"  {col_name} {c['type']}{null}{dflt}")

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
            index_ddls.append(f"CREATE INDEX \"{idx['name']}\" ON {tbl} ({idx_cols})")
        elif db_type == 'mssql':
            index_ddls.append(f"CREATE INDEX [{idx['name']}] ON {tbl} ({idx_cols});")

    inner = ',\n'.join(col_lines)

    if db_type in ('mysql', 'ob-mysql'):
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
    elif db_type == 'postgresql':
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n);"
    elif db_type == 'oracle':
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n)"
    elif db_type == 'mssql':
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n);"
    else:
        ddl = f"CREATE TABLE {tbl} (\n{inner}\n);"

    # 追加索引 DDL
    if index_ddls:
        ddl += "\n" + "\n".join(index_ddls)
    return ddl

@eel.expose
def drag_copy_table(src_conn_data, src_db, table_name, dst_conn_data, dst_db, copy_data=True):
    """拖拽复制表：支持跨数据库类型（MySQL/OB/PG/Oracle/MSSQL 互相同步）"""
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
        dst_tbl = _build_table_ref(dst_data, dst_db, table_name)
        dst_url = _conn_url(dst_data)
        if dst_db_type in ('mysql', 'ob-mysql'):
            dst_url = dst_url.replace("?charset=utf8mb4", "?charset=utf8mb4&connect_timeout=10&read_timeout=30") if "?" in dst_url else dst_url + "?connect_timeout=10&read_timeout=30"
        dst_engine = create_engine(dst_url, connect_args=_connect_args(dst_db_type, timeout=10))

        _progress_q.put(("drag_progress", {"percent": 3, "status": "已连接，检查目标表..."}))

        # 1. 检查目标表是否已存在
        try:
            with dst_engine.connect() as dc:
                if dst_db_type == 'oracle':
                    dc.execute(text(f"SELECT 1 FROM {dst_tbl} WHERE ROWNUM <= 1"))
                elif dst_db_type == 'mssql':
                    dc.execute(text(f"SELECT TOP 1 1 FROM {dst_tbl}"))
                else:
                    dc.execute(text(f"SELECT 1 FROM {dst_tbl} LIMIT 1"))
            return {"ok": False, "msg": f"目标库中表 [{table_name}] 已存在"}
        except Exception:
            pass

        # 2. 同类型同服务器：用 CREATE TABLE LIKE（最快最可靠）
        _progress_q.put(("drag_progress", {"percent": 5, "status": "正在创建表结构..."}))
        same_type = src_db_type == dst_db_type
        same_server = (src_data.get("host") == dst_data.get("host") and
                       src_data.get("port") == dst_data.get("port"))
        if same_type and same_server and src_db_type in ('mysql', 'ob-mysql'):
            try:
                with dst_engine.begin() as dconn:
                    dconn.execute(text(f"CREATE TABLE {dst_tbl} LIKE {src_tbl}"))
            except Exception as e:
                src_engine.dispose(); dst_engine.dispose()
                return {"ok": False, "msg": f"创建表结构失败: {str(e)}"}
        elif same_type and same_server and src_db_type == 'postgresql':
            # PG 语法：CREATE TABLE ... (LIKE ... INCLUDING ALL)
            try:
                with dst_engine.begin() as dconn:
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

                ddl = _generate_create_table(dst_db_type, dst_tbl, cols, idx_info)

                with dst_engine.begin() as dconn:
                    for stmt in ddl.split(';'):
                        stmt = stmt.strip()
                        if stmt: dconn.execute(text(stmt))
            except Exception as e:
                src_engine.dispose(); dst_engine.dispose()
                return {"ok": False, "msg": f"创建表结构失败: {str(e)}"}

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
                        if _query_cancel.is_set():
                            _kill_db_query()
                        _progress_q.put(("drag_progress", {"percent": 15, "status": "正在统计行数...（大表请耐心等待）"}))
                        threading.Event().wait(5)
                _hb_thread = threading.Thread(target=_hb_count, daemon=True)
                _hb_thread.start()
                try:
                    with src_engine.connect() as sconn:
                        # ★ 记录源库连接 ID，用于 cancel 时 KILL COUNT(*) 查询
                        _query_conn_id = _get_backend_pid(sconn, src_db_type)
                        _query_src_data = src_data
                        total_rows = sconn.execute(text(f"SELECT COUNT(*) FROM {src_tbl}")).scalar()
                except Exception:
                    if _query_cancel.is_set():
                        _progress_q.put(("drag_progress", {"percent": 100, "status": "已取消"}))
                        return {"ok": False, "msg": "操作已取消", "cancelled": True}
                    raise
                finally:
                    _query_conn_id = None
                    _query_src_data = None
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
                                if _query_cancel.is_set():
                                    _kill_db_query()  # ★ 杀掉数据库中的 SELECT * 查询
                                    data_ok = False
                                    break
                            if batch and not _query_cancel.is_set():
                                _batch_insert(dconn, dst_tbl, columns, batch)
                                total += len(batch)
                                _last_total[0] = total
                                _last_sent[0] = time.time()
                                _progress_q.put(("drag_progress", {"percent": 98, "status": f"已复制 {total:,} / {total_rows:,} 行"}))
                                del batch
                                gc.collect()
                except Exception:
                    if _query_cancel.is_set():
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
                if _query_cancel.is_set():
                    _progress_q.put(("drag_progress", {"percent": 100, "status": "已取消"}))
                    return {"ok": False, "msg": "操作已取消", "cancelled": True}
                _progress_q.put(("drag_progress", {"percent": 100, "status": f"错误: {e}"}))
                # 表结构已创建，数据复制失败
                return {"ok": True, "msg": f"表结构已创建，但数据复制失败: {e}", "partial": True}

        src_engine.dispose()
        dst_engine.dispose()
        msg = f"表 [{table_name}] 已复制到 [{dst_db}]"
        if copy_data and data_ok:
            msg += f"，共 {total} 行" if 'total' in dir() else ""
        return {"ok": True, "msg": msg}
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
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type != 'oracle':
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        tables = db_explore_get_tables(cdata, database, schema or '')
        engine.dispose()
        if isinstance(tables, dict) and tables.get("ok"):
            return {"ok": True, "tables": [t["name"] for t in tables["tables"]]}
        return {"ok": False, "msg": "获取失败"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def export_wizard_get_columns(conn_data, database, table_name, schema=''):
    """获取表的列信息"""
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
                rows = conn.execute(text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
                ), {"db": database, "tbl": table_name}).fetchall()
        engine.dispose()
        return {"ok": True, "columns": [r[0] for r in rows]}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _export_run(data, tables, settings, out_path):
    """后台执行导出（SQL / CSV）"""
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
                f.write("SET FOREIGN_KEY_CHECKS = 0;\n\n")

            for ti, tn in enumerate(tables):
                tbl = _build_table_ref(cdata, data.get("db", ""), tn)
                # 输出 SQL 中使用裸表名（不含数据库前缀）
                if db_type in ('mysql', 'ob-mysql'):
                    tbl_out = f"`{tn}`"
                elif db_type == 'postgresql':
                    tbl_out = f'"{tn}"'
                elif db_type == 'mssql':
                    tbl_out = f"[{tn}]"
                else:
                    tbl_out = tn
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
                            cols = []

                if not cols:
                    continue

                col_quoted = ", ".join(_safe_ident(c, db_type) for c in cols)
                col_plain = ", ".join(cols)

                if scope in ("structure", "full") and export_fmt == "sql":
                    # 结构和数据
                    with engine.connect() as conn:
                        row = conn.execute(text(f"SHOW CREATE TABLE `{data.get('db','')}`.`{tn}`")).fetchone()
                        ddl = row[1] if row else ""
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
                                    f.write(f"INSERT INTO {tbl_out} ({col_plain}) VALUES\n")
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
                                f.write(f"INSERT INTO {tbl_out} ({col_plain}) VALUES\n")
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

            if export_fmt == "sql":
                f.write("\nSET FOREIGN_KEY_CHECKS = 1;\n")

        engine.dispose()
        _progress_q.put(("export_done", {"path": out_path}))
    except Exception as e:
        _progress_q.put(("export_error", {"msg": str(e)}))


@eel.expose
def export_wizard_start(conn_data, database, tables, settings, schema=''):
    """启动导出（后台线程，自动生成文件名到桌面）"""
    data = dict(conn_data)
    if data.get('db_type') not in ('postgresql',):
        data["db"] = database
    ext = ".sql" if settings.get("format", "sql") == "sql" else ".csv"
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(BASE_DIR, f"export_{database}_{ts}{ext}")
    _progress_q.queue.clear()
    threading.Thread(target=_export_run, args=(data, tables, settings, out_path), daemon=True).start()
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
    _progress_q.queue.clear()
    threading.Thread(target=_export_query_write, args=(path, content, rows), daemon=True).start()
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
    """智能拆分 SQL 语句：识别引号和注释内的分号，正确切分多行 INSERT"""
    stmts = []
    buf = []
    in_single = False
    in_double = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\\' and in_single:
            buf.append(ch)
            if i + 1 < len(text):
                buf.append(text[i + 1])
                i += 1
        elif ch == "'" and not in_double:
            in_single = not in_single
            buf.append(ch)
        elif ch == '"' and not in_single:
            in_double = not in_double
            buf.append(ch)
        elif ch == ';' and not in_single and not in_double:
            stmt = ''.join(buf).strip()
            if stmt and not stmt.startswith('--') and not stmt.startswith('#'):
                stmts.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    stmt = ''.join(buf).strip()
    if stmt and not stmt.startswith('--') and not stmt.startswith('#'):
        stmts.append(stmt)
    return stmts


@eel.expose
def save_import_file(content, filename):
    """将前端读取的文件内容保存到临时文件，返回路径"""
    try:
        tmpdir = os.path.join(BASE_DIR, "temp")
        os.makedirs(tmpdir, exist_ok=True)
        path = os.path.join(tmpdir, filename)
        with open(path, "w", encoding="utf-8", errors="replace") as f:
            f.write(content)
        return path
    except Exception as e:
        return ""


@eel.expose
def import_wizard_run(conn_data, database, file_path, file_type, schema='', content=''):
    """执行导入（后台线程），支持直接传内容或文件路径"""
    def _check_db_prefix(content, db_type, target_db):
        """检查 SQL 文件中是否包含数据库前缀，如果有且与目标库不一致则返回错误"""
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
        try:
            cdata = dict(conn_data)
            db_type = cdata.get('db_type', 'mysql')
            if db_type != 'oracle':
                cdata["db"] = database
            engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))

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
                    for stmt in statements:
                        try:
                            conn.execute(text(stmt))
                            done += 1
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
                            _progress_q.put(("import_log", str(se)[:200]))
                _progress_q.put(("import_done", {"total": total, "processed": done}))

            elif file_type == "csv":
                import csv, io
                reader = csv.reader(io.StringIO(content))
                header = next(reader, None)
                if not header:
                    _progress_q.put(("import_error", {"msg": "CSV 文件无标题行"}))
                    return
                # 用文件名作为表名
                tbl_name = os.path.splitext(os.path.basename(file_path))[0]
                tbl = _build_table_ref(cdata, database, tbl_name)
                cols = ", ".join(_safe_ident(h, db_type) for h in header)
                ph = ", ".join(":" + h for h in header)
                rows = list(reader)
                total = len(rows)
                _progress_q.put(("import_progress", {"total": total, "processed": 0, "time": time.strftime("%H:%M:%S")}))
                batch = []
                batch_size = 5000
                processed = 0
                with engine.begin() as conn:
                    # 自动建表
                    conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))
                    _log_db_delete(f"DROP TABLE IF EXISTS {tbl}")
                    col_defs = ", ".join(f"{_safe_ident(h, db_type)} TEXT" for h in header)
                    create_sql = f"CREATE TABLE {tbl} ({col_defs})"
                    conn.execute(text(create_sql))
                    _db_op_logger.info(f"[DDL] {create_sql}")
                    insert_template = f"INSERT INTO {tbl} ({cols}) VALUES ({ph})"
                    _log_db_insert(f"{insert_template}  -- 共 {total} 行（批量导入）")
                    for row in rows:
                        batch.append(dict(zip(header, row)))
                        processed += 1
                        if len(batch) >= batch_size:
                            conn.execute(text(insert_template), batch)
                            batch = []
                            _progress_q.put(("import_progress", {"total": total, "processed": processed, "time": time.strftime("%H:%M:%S")}))
                    if batch:
                        conn.execute(text(insert_template), batch)
                _progress_q.put(("import_done", {"total": total, "processed": processed}))

            engine.dispose()
        except Exception as e:
            _progress_q.put(("import_error", {"msg": str(e)}))

    _progress_q.queue.clear()
    threading.Thread(target=_run, daemon=True).start()
    return True


# ==================== 慢 SQL 查询分析 ====================

@eel.expose
def slow_query_get_databases(data: dict):
    """获取慢查询可用的数据库列表（需要连接信息）"""
    try:
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": cdata.get("src_db", ""), "db_type": cdata.get("db_type", "mysql")
            }
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
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }
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
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }
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
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }

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
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }

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
        cdata = dict(conn_data)
        # 兼容两种格式：{user,host,...} 和 {src_user,src_host,...}
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }
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
        cdata = dict(conn_data)
        # 兼容两种格式：{user,host,...} 和 {src_user,src_host,...}
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": cdata.get("src_db", ""), "db_type": cdata.get("db_type", "mysql")
            }
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
        cdata = dict(conn_data)
        # 兼容两种格式：{user,host,...} 和 {src_user,src_host,...}
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": cdata.get("src_db", ""), "db_type": cdata.get("db_type", "mysql")
            }
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
        cdata = dict(conn_data)
        # 兼容两种格式
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": cdata.get("src_db", ""), "db_type": cdata.get("db_type", "mysql")
            }
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

                    # ★ 6. 状态变量列表（按名字排序）
                    status_list = sorted(
                        [{"name": n, "value": str(v)} for n, v in status.items()],
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
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get("db_type", "mysql")) if 'db_type' in conn_data else str(e)}


# ==================== 右侧信息面板：连接/数据库详情 ====================

@eel.expose
def get_connection_info(conn_data):
    """获取连接级别的详情信息（版本、状态等）
    支持: mysql / ob-mysql / oracle / postgresql / redis"""
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
            info = r.info('server')
            db_count = int(r.config_get('databases').get('databases', 16))
            db_count = min(db_count, 16)
            keys_total = 0
            for i in range(db_count):
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
                try:
                    keys_total += _r2.dbsize()
                except Exception:
                    pass
            return {"ok": True, "info": {
                "type": "Redis",
                "version": info.get('redis_version', ''),
                "os": info.get('os', ''),
                "arch": info.get('arch_bits', '') + ' bits',
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
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


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
def get_database_info(conn_data, database):
    """获取数据库级别的详情（大小、对象数量等）
    支持: mysql / ob-mysql / oracle / postgresql / redis
    ★ 异步执行，避免 INFO_SCHEMA 查询阻塞 Eel 主线程
    """
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
                dbsize = r.dbsize()
                info_result = r.info('keyspace')
                db_key = f"db{database}"
                keyspace_info = info_result.get(db_key, {}) if isinstance(info_result, dict) else {}
                return {"ok": True, "info": {
                    "name": f"DB{database}",
                    "type": "Redis DB",
                    "key_count": dbsize,
                    "expires": keyspace_info.get('expires', 0) if isinstance(keyspace_info, dict) else 0,
                    "avg_ttl": keyspace_info.get('avg_ttl', 0) if isinstance(keyspace_info, dict) else 0,
                    "db_index": int(database),
                }}
            return _with_db_timeout(_redis_info, timeout=15)

        cdata = dict(conn_data)
        if db_type != 'oracle':
            cdata["db"] = database

        def _get_db_info():
            engine = create_engine(
                _conn_url(cdata),
                connect_args=_connect_args(db_type, timeout=10)
            )
            try:
                info = {"name": database, "type": db_type.upper() if db_type == 'ob-mysql' else db_type.title()}
                with engine.connect() as c:
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

        return _with_db_timeout(_get_db_info, timeout=15)

    except Exception as e:
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

    # ③ 最后手段：os._exit
    os._exit(0)


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
    # 导入 DataGrip 导入模块（注册 eel 暴露函数）
    import modules.datagrip_import
    eel.init(web_dir)
    # ★ 启动时记录已存在的浏览器进程，退出时只杀新增的，防止误杀用户其他浏览器
    if sys.platform == 'win32':
        _record_existing_browser_pids()
    try:
        eel.start("index.html", size=(1280, 860), port=0, cmdline_args=[])
    finally:
        _force_cleanup_and_exit()
