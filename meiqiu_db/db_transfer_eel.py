"""
数据库高速传输工具 — Eel 版
前后端分离：Python 纯业务逻辑，HTML/CSS/JS 负责界面
"""
# ===== 必须在所有 import 之前：gevent 猴子补丁 =====
from gevent import monkey
monkey.patch_all(thread=False)
# ===============================================
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
_query_columns = []
_query_rows = []
_query_conn_id = None       # 当前查询的数据库连接 ID（用于 kill）
_query_src_data = None       # 当前查询的源库连接信息


# ==================== JSON 序列化辅助 ====================
def _json_safe(val):
    """将 datetime / Decimal 等非 JSON 类型转为字符串"""
    import datetime, decimal
    if val is None:
        return None
    if isinstance(val, (datetime.datetime, datetime.date, datetime.time)):
        return str(val)
    if isinstance(val, decimal.Decimal):
        return float(val)
    if isinstance(val, bytes):
        return val.decode('utf-8', errors='replace')
    return val


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
        self.batch_size = config.get("batch_size", 50000)
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    @property
    def src_url(self) -> str:
        u = quote_plus(self.src_user)
        p = quote_plus(self.src_pwd)
        return f"mysql+pymysql://{u}:{p}@{self.src_host}:{self.src_port}/{self.src_db}?charset=utf8mb4"

    @property
    def dst_url(self) -> str:
        u = quote_plus(self.dst_user)
        p = quote_plus(self.dst_pwd)
        return f"mysql+pymysql://{u}:{p}@{self.dst_host}:{self.dst_port}/{self.dst_db}?charset=utf8mb4"

    @property
    def dst_url_no_db(self) -> str:
        u = quote_plus(self.dst_user)
        p = quote_plus(self.dst_pwd)
        return f"mysql+pymysql://{u}:{p}@{self.dst_host}:{self.dst_port}?charset=utf8mb4"

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
                url = (f"mysql+pymysql://{quote_plus(data['src_user'])}:"
                       f"{quote_plus(data['src_pwd'])}@{data['src_host']}:"
                       f"{data['src_port']}/{src_db}?charset=utf8mb4")
            else:
                # 不指定数据库，仅测试服务器连通性
                url = (f"mysql+pymysql://{quote_plus(data['src_user'])}:"
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
            url_no_db = (f"mysql+pymysql://{quote_plus(data['dst_user'])}:"
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


@eel.expose
def execute_sql_query(sql: str, data: dict):
    """执行 SQL 查询"""
    global _query_columns, _query_rows, _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = data  # 保存源库信息用于 cancel 时 kill

    try:
        # 兼容两种数据格式：{host,user,pwd} 和 {src_host,src_user,src_pwd}
        if "user" not in data:
            data = {
                "host": data.get("src_host", ""), "port": data.get("src_port", "3306"),
                "user": data.get("src_user", ""), "pwd": data.get("src_pwd", ""),
                "db": data.get("src_db", ""), "db_type": data.get("db_type", "mysql")
            }
        db_type = data.get("db_type", "mysql")
        url = _conn_url(data)
        if db_type in ('mysql', 'ob-mysql'):
            url = url.replace("?charset=utf8mb4", "?charset=utf8mb4&read_timeout=30") if "?" in url else url + "?charset=utf8mb4&read_timeout=30"
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as conn:
            if _query_cancel.is_set():
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            # 记录连接 ID，用于 cancel 时 kill query
            try:
                _query_conn_id = conn.execute(text("SELECT CONNECTION_ID()")).scalar()
            except Exception:
                pass
            try:
                conn.execute(text("SET SESSION MAX_EXECUTION_TIME = 30000"))
            except Exception:
                pass
            result = conn.execute(text(sql))
            if _query_cancel.is_set():
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            _query_columns = list(result.keys())
            _query_rows = [list(row) for row in result.fetchall()]
        engine.dispose()

        if _query_cancel.is_set():
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        # 返回前 JSON 化（datetime/Decimal 转字符串）
        safe_rows = [_row_to_json(r) for r in _query_rows[:200]]
        return {
            "ok": True,
            "columns": _query_columns,
            "rows": safe_rows,
            "total": len(_query_rows)
        }
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, data.get('db_type','mysql'))}


@eel.expose
def execute_sql_file(sql: str, data: dict):
    """在目标库执行 SQL 文件（后台线程 + 队列推送进度）"""
    def _run():
        try:
            dst_url = (f"mysql+pymysql://{quote_plus(data['dst_user'])}:"
                       f"{quote_plus(data['dst_pwd'])}@{data['dst_host']}:"
                       f"{data['dst_port']}/{data['dst_db']}?charset=utf8mb4")
            dst_engine = create_engine(dst_url, connect_args=_connect_args("mysql", timeout=10))

            # 智能拆分 SQL：忽略引号内的 ;
            def _split_sql(text):
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
                        if stmt and not stmt.startswith('--'):
                            stmts.append(stmt)
                        buf = []
                    else:
                        buf.append(ch)
                    i += 1
                # 最后残留的
                stmt = ''.join(buf).strip()
                if stmt and not stmt.startswith('--'):
                    stmts.append(stmt)
                return stmts

            statements = _split_sql(sql)
            total = len(statements)
            _progress_q.put(("sql_file_start", {"total": total}))
            done = 0
            errors = 0
            error_samples = []  # 收集错误样本用于弹窗展示
            with dst_engine.connect() as conn:
                conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
                for i, stmt in enumerate(statements):
                    try:
                        conn.execute(text(stmt))
                        conn.execute(text("COMMIT"))
                        done += 1
                        # 记录 SQL 执行日志
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
                            pass  # 不记录事务控制语句
                        else:
                            _db_op_logger.info(f"[EXEC] {stmt}")
                        if done % 100 == 0 or done == total:
                            _progress_q.put(("sql_file_progress", {"done": done, "total": total}))
                    except Exception as se:
                        errors += 1
                        conn.execute(text("ROLLBACK"))
                        if len(error_samples) < 5:
                            error_samples.append(f"第{i+1}条: {str(se)[:200]}")
                conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
            dst_engine.dispose()
            _progress_q.put(("sql_file_done", {
                "ok": True, "count": done, "errors": errors,
                "error_samples": error_samples
            }))
        except Exception as e:
            _progress_q.put(("sql_file_done", {"ok": False, "msg": str(e)}))

    threading.Thread(target=_run, daemon=True).start()
    return True


@eel.expose
def clear_cancel():
    """清除取消标记（新操作开始前调用）"""
    _query_cancel.clear()
    return True

@eel.expose
def cancel_query():
    """取消所有查询 — 设置全局取消标记"""
    _query_cancel.set()
    return True


@eel.expose
def import_query_results(table_name: str, data: dict):
    """导入查询结果到目标库"""
    try:
        dst_url = (f"mysql+pymysql://{quote_plus(data['dst_user'])}:"
                   f"{quote_plus(data['dst_pwd'])}@{data['dst_host']}:"
                   f"{data['dst_port']}/{data['dst_db']}?charset=utf8mb4")
        dst_engine = create_engine(dst_url, connect_args=_connect_args("mysql", timeout=10))

        with dst_engine.begin() as conn:
            conn.execute(text("COMMIT"))
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
            # 自动建表
            col_defs = []
            for col in _query_columns:
                sample = _query_rows[0][_query_columns.index(col)] if _query_rows else None
                if isinstance(sample, int):
                    col_defs.append(f"`{col}` BIGINT")
                elif isinstance(sample, float):
                    col_defs.append(f"`{col}` DOUBLE")
                elif hasattr(sample, 'isoformat'):
                    col_defs.append(f"`{col}` DATETIME")
                else:
                    col_defs.append(f"`{col}` TEXT")
            col_def_str = ", ".join(col_defs)
            conn.execute(text(f"DROP TABLE IF EXISTS `{table_name}`"))
            conn.execute(text(f"CREATE TABLE `{table_name}` ({col_def_str})"))

            # 批量插入
            col_list = ", ".join(f"`{c}`" for c in _query_columns)
            ph_list = ", ".join(f":{c}" for c in _query_columns)
            insert_sql = text(f"INSERT INTO `{table_name}` ({col_list}) VALUES ({ph_list})")
            batch_size = 10000
            for i in range(0, len(_query_rows), batch_size):
                batch = [dict(zip(_query_columns, r)) for r in _query_rows[i:i + batch_size]]
                conn.execute(insert_sql, batch)
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))

        dst_engine.dispose()
        return {"ok": True, "msg": f"查询结果已导入 [{table_name}]，共 {len(_query_rows)} 行",
                "count": len(_query_rows), "table": table_name}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _connect_args(db_type='mysql', timeout=10):
    """返回 create_engine 的 connect_args，MySQL 禁用 SSL"""
    args = {"connect_timeout": timeout}
    if db_type in ('mysql', 'ob-mysql'):
        args["ssl_disabled"] = True
    return args

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
def table_preview_data(conn_data, database, table_name, schema='', order_col='', order_dir=''):
    # 每次调用都清除取消标记（前端已在 applyServerSort 中设置 sortCancelled=false）
    _query_cancel.clear()
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') == 'postgresql':
            pass
        else:
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
        limit_sql = _build_full_table_sql(tbl, db_type, order_clause, limit=None)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=30))
        with engine.connect() as conn:
            _log_db_select(limit_sql)
            result = conn.execute(text(limit_sql))
            columns = list(result.keys())
            rows = [_row_to_json(row) for row in result.fetchall()]
            # 查询列注释
            comments = {}
            comments = _load_column_comments(conn, db_type, database, table_name, schema)
        engine.dispose()
        return {"ok": True, "columns": columns, "rows": rows, "comments": comments}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}


@eel.expose
def table_preview_data_fast(conn_data, database, table_name, schema='', order_col='', order_dir=''):
    """快速预览：只返回前 50 行（用于大表首次打开），避免超时"""
    _query_cancel.clear()
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') == 'postgresql':
            pass
        else:
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
        limit_sql = _build_full_table_sql(tbl, db_type, order_clause, limit=50)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as conn:
            _log_db_select(limit_sql + "  -- [FAST] 前50行")
            result = conn.execute(text(limit_sql))
            columns = list(result.keys())
            rows = [_row_to_json(row) for row in result.fetchall()]
            comments = _load_column_comments(conn, db_type, database, table_name, schema)
        engine.dispose()
        return {"ok": True, "columns": columns, "rows": rows, "comments": comments,
                "fast": True, "total_hint": len(rows)}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}


def _build_full_table_sql(tbl, db_type, order_clause, limit=None):
    """构建 SELECT * FROM tbl 的 SQL，支持各数据库方言和可选 LIMIT"""
    base_sql = f"SELECT * FROM {tbl}{order_clause}"
    if limit is None:
        # 无限制 — 全量查询
        if db_type == 'oracle':
            base_sql = f"SELECT * FROM (SELECT * FROM {tbl}{order_clause})"
        elif db_type == 'mssql':
            pass  # SQL Server 无限制也用基础 SQL
        return base_sql

    # 带限制的快速预览
    n = int(limit)
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
    return comments





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
        sch = 'public'
        pks = c.execute(text(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name "
            "WHERE tc.table_name=:tbl AND tc.constraint_type='PRIMARY KEY' "
            "ORDER BY kcu.ordinal_position"
        ), {"tbl": table_name}).fetchall()
        if pks:
            return [r[0] for r in pks]
    # 3. 兜底：返回 None，调用方使用所有列
    return None


def _build_where_clause(tbl, db_type, where_cols, columns, orig_row):
    """构建 UPDATE/DELETE 的 WHERE 子句，优先使用主键/唯一索引"""
    if where_cols:
        target_cols = where_cols
    else:
        target_cols = columns
    where_parts = []
    for cname in target_cols:
        try:
            idx = columns.index(cname)
            val = orig_row[idx] if idx < len(orig_row) else 'NULL'
            where_parts.append(
                f"{_safe_ident(cname, db_type)} IS NULL" if val == 'NULL'
                else f"{_safe_ident(cname, db_type)} = {_sql_value(val, db_type)}"
            )
        except ValueError:
            pass
    return " AND ".join(where_parts) if where_parts else "1=1"


@eel.expose
def table_save_changes(conn_data, database, table_name, schema, changes):
    """生成 UPDATE SQL 预览，不执行"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql',):
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
    """执行 UPDATE 修改"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql',):
            cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        with engine.connect() as c:
            where_cols = _get_where_columns(c, db_type, database, table_name)
        with engine.begin() as c:
            for ch in changes:
                col = ch["col"]
                new_val = ch["newVal"]
                orig_row = ch.get("origRow", [])
                columns = ch.get("columns", [])
                set_clause = f"{_safe_ident(col, db_type)} = {_sql_value(new_val, db_type)}"
                where_clause = _build_where_clause(tbl, db_type, where_cols, columns, orig_row)
                update_sql = f"UPDATE {tbl} SET {set_clause} WHERE {where_clause}"
                c.execute(text(update_sql))
                # 生成回退 SQL：恢复到原值
                old_val = orig_row[columns.index(col)] if col in columns else None
                rollback_set = f"{_safe_ident(col, db_type)} = {_sql_value(old_val, db_type)}"
                rollback_sql = f"UPDATE {tbl} SET {rollback_set} WHERE {where_clause};"
                _log_db_update(update_sql, rollback_sql)
        engine.dispose()
        return {"ok": True, "msg": f"成功修改 {len(changes)} 处"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


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
        if db_type not in ('postgresql',):
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
        if db_type not in ('postgresql',):
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
                c.execute(text(delete_sql))
                # 生成回退 SQL：INSERT 恢复被删除的行
                rollback_sql = _gen_rollback_insert(tbl, db_type, columns, orig_row)
                _log_db_delete(delete_sql, rollback_sql)
        engine.dispose()
        return {"ok": True, "msg": f"成功删除 {len(rows_data)} 行"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def table_get_ddl(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') == 'postgresql':
            pass
        else:
            cdata["db"] = database
        db_type = cdata.get('db_type', 'mysql')
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        if db_type in ('mysql', 'ob-mysql'):
            with engine.connect() as conn:
                row = conn.execute(text(f"SHOW CREATE TABLE `{database}`.`{table_name}`")).fetchone()
            ddl = row[1] if row else ""
        elif db_type == 'postgresql':
            q = schema if schema else database
            # 用 pg_dump 风格获取 DDL（简化版：列信息 + 索引）
            with engine.connect() as conn:
                cols = conn.execute(text(
                    "SELECT column_name,data_type,character_maximum_length,is_nullable,column_default "
                    "FROM information_schema.columns WHERE table_schema=:sch AND table_name=:tbl "
                    "ORDER BY ordinal_position"
                ), {"sch":q,"tbl":table_name}).fetchall()
                lines = [f'CREATE TABLE "{q}"."{table_name}" (']
                col_defs = []
                for c in cols:
                    null = ' NOT NULL' if c[3]=='NO' else ''
                    dflt = f' DEFAULT {c[4]}' if c[4] else ''
                    col_defs.append(f'  "{c[0]}" {c[1]}{dflt}{null}')
                lines.append(',\n'.join(col_defs))
                lines.append(');')
                ddl = '\n'.join(lines)
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
        if db_type not in ('postgresql',):
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
                for r in cols:
                    result["columns"].append({
                        "name": r[0], "col_type": r[1], "data_type": r[1],
                        "length": r[2], "precision": r[3], "scale": r[4],
                        "nullable": r[5] == "YES",
                        "default_val": str(r[6]) if r[6] is not None else None,
                        "auto_increment": False,
                        "comment": "", "position": r[7]
                    })
                result["table_options"] = {"engine": "", "collation": "", "comment": ""}

            else:
                # Oracle / MSSQL 等暂返回基础列信息
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
        if db_type not in ('postgresql',):
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
        if cdata.get('db_type') != 'postgresql': cdata["db"] = database
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
        if cdata.get('db_type') != 'postgresql': cdata["db"] = database
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
        if cdata.get('db_type') != 'postgresql': cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        sql = f"DELETE FROM {tbl}"
        with engine.begin() as conn: conn.execute(text(sql))
        engine.dispose()
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已清空"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}


# ==================== 树形栏目持久化（含自动备份恢复） ====================
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
    # 必须包含三个关键字段
    for key in ("folders", "connections", "saved_queries"):
        if key not in data:
            data[key] = [] if key != "connections" else {}
    if not isinstance(data.get("folders"), list):
        return False
    if not isinstance(data.get("connections"), dict):
        return False
    if not isinstance(data.get("saved_queries"), list):
        return False
    return True

def _tree_has_content(data):
    """检查树数据是否有实际内容（不只是空壳）"""
    if not isinstance(data, dict):
        return False
    has_conns = bool(data.get("connections") and len(data.get("connections", {})) > 0)
    has_folders = bool(data.get("folders") and len(data.get("folders", [])) > 0)
    has_queries = bool(data.get("saved_queries") and len(data.get("saved_queries", [])) > 0)
    return has_conns or has_folders or has_queries

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
    try:
        print(f"[tree] _load_tree: reading TREE_FILE={TREE_FILE}")
        print(f"[tree] _load_tree: file exists={os.path.exists(TREE_FILE)}")
        with open(TREE_FILE, "r", encoding="utf-8") as f:
            content = f.read()
        print(f"[tree] _load_tree: file size={len(content)} bytes")
        if not content.strip():
            print("[tree] _load_tree: 文件为空，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                return recovered
            return {"folders": [], "connections": {}, "saved_queries": []}
        data = json.loads(content)
        conn_count = len(data.get("connections", {}))
        print(f"[tree] _load_tree: 解析成功，connections={conn_count}, folders={len(data.get('folders',[]))}, queries={len(data.get('saved_queries',[]))}")
        if not _validate_tree(data):
            print("[tree] _load_tree: 数据格式不正确，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                return recovered
            return {"folders": [], "connections": {}, "saved_queries": []}
        # 【关键】结构合法但内容为空（空壳），尝试恢复
        if _is_empty_shell(data):
            print("[tree] _load_tree: 空壳数据，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                return recovered
        # 正常加载，顺便做一次备份（如果距上次备份超过1小时）
        _maybe_auto_backup()
        return data
    except json.JSONDecodeError as e:
        print(f"[tree] _load_tree JSON解析失败: {e}")
        recovered = _recover_from_backup()
        if recovered:
            return recovered
        return {"folders": [], "connections": {}, "saved_queries": []}
    except FileNotFoundError:
        print(f"[tree] _load_tree: 文件不存在 TREE_FILE={TREE_FILE}")
        recovered = _recover_from_backup()
        if recovered:
            return recovered
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
            return
        # 【防覆盖】如果新数据是空壳，但当前文件有实际内容 → 拒绝（防止误覆盖）
        if _is_empty_shell(data) and os.path.exists(TREE_FILE):
            try:
                with open(TREE_FILE, "r", encoding="utf-8") as f:
                    current = json.load(f)
                if _tree_has_content(current):
                    print("[tree] _save_tree: 拒绝用空壳数据覆盖现有 %d 个连接" 
                          % len(current.get("connections", {})))
                    return
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
    except Exception as e:
        print(f"[tree] _save_tree 异常: {e}")
        # 清理临时文件
        try:
            if os.path.exists(TREE_FILE + ".tmp"):
                os.remove(TREE_FILE + ".tmp")
        except Exception:
            pass


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
            info["queries_count"] = len(data.get("saved_queries", []))
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
def tree_save(data): _save_tree(data); return True
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
            result["queries"] = len(data.get("saved_queries", []))
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
    tree = _load_tree()
    fid = f"f_{int(time.time() * 1000)}"
    tree.setdefault("folders", []).append({"id": fid, "name": name, "parent": parent_id or ""})
    _save_tree(tree)
    return {"ok": True, "id": fid}

@eel.expose
def tree_delete_folder(fid):
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
    tree = _load_tree()
    for f in tree.get("folders", []):
        if f["id"] == fid: f["name"] = name
    _save_tree(tree)
    return True

@eel.expose
def tree_add_connection(parent_id, conn_data):
    tree = _load_tree()
    cid = f"c_{int(time.time() * 1000)}"
    conn_data["id"] = cid; conn_data["parent"] = parent_id or ""
    tree.setdefault("connections", {})[cid] = conn_data
    _save_tree(tree)
    return {"ok": True, "id": cid}

@eel.expose
def tree_update_connection(cid, conn_data):
    tree = _load_tree()
    if cid in tree.get("connections", {}):
        conn_data["id"] = cid
        conn_data["parent"] = tree["connections"][cid].get("parent", "")
        tree["connections"][cid] = conn_data
        _save_tree(tree)
    return True

@eel.expose
def tree_delete_connection(cid):
    tree = _load_tree()
    tree.get("connections", {}).pop(cid, None)
    _save_tree(tree)
    return True

@eel.expose
def tree_move_connection(cid, new_parent_id):
    """将连接移动到指定文件夹下（new_parent_id 为空则移到根）"""
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
    """将 ModuleNotFoundError 转为带安装提示的友好信息（同时显示原始错误用于诊断）"""
    msg = str(err)
    hint = _DRIVER_HINTS.get(db_type, '')
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
    try:
        db_type = conn_data.get("db_type", "mysql")
        if db_type == 'redis':
            r = _get_redis(conn_data)
            r.ping()
            return {"ok": True, "msg": "连接成功"}
        url = _conn_url(conn_data)
        if db_type in ('mysql', 'ob-mysql'):
            engine = create_engine(url, connect_args=_connect_args(db_type, timeout=5))
            with engine.connect() as c: c.execute(text("SELECT 1"))
        elif db_type == 'postgresql':
            engine = create_engine(url, connect_args=_connect_args(db_type, timeout=5))
            with engine.connect() as c: c.execute(text("SELECT 1"))
        elif db_type == 'oracle':
            engine = create_engine(url, connect_args=_connect_args(db_type, timeout=5))
            with engine.connect() as c: c.execute(text("SELECT 1 FROM DUAL"))
        elif db_type == 'mssql':
            engine = create_engine(url, connect_args=_connect_args(db_type, timeout=5))
            with engine.connect() as c: c.execute(text("SELECT 1"))
        else:
            engine = create_engine(url, connect_args=_connect_args(db_type, timeout=5))
            with engine.connect() as c: c.execute(text("SELECT 1"))
        engine.dispose()
        return {"ok": True, "msg": "连接成功"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type)}

def _conn_url(conn_data):
    u = quote_plus(conn_data["user"]); p = quote_plus(conn_data["pwd"])
    h = conn_data['host']; port = conn_data.get('port', '3306')
    db = conn_data.get("db", "")
    db_type = conn_data.get("db_type", "mysql")
    if db_type in ('mysql', 'ob-mysql'):
        base = f"mysql+pymysql://{u}:{p}@{h}:{port}"
        return f"{base}/{db}?charset=utf8mb4" if db else f"{base}/?charset=utf8mb4"
    elif db_type == 'postgresql':
        base = f"postgresql+psycopg2://{u}:{p}@{h}:{port}"
        return f"{base}/{db}" if db else base
    elif db_type == 'oracle':
        sid = conn_data.get("sid", db)
        base = f"oracle+oracledb://{u}:{p}@{h}:{port}"
        return f"{base}/{sid}" if sid else base
    elif db_type == 'mssql':
        base = f"mssql+pymssql://{u}:{p}@{h}:{port}"
        return f"{base}/{db}" if db else base
    # fallback mysql
    base = f"mysql+pymysql://{u}:{p}@{h}:{port}"
    return f"{base}/{db}?charset=utf8mb4" if db else f"{base}/?charset=utf8mb4"

@eel.expose
def db_explore_get_databases(conn_data):
    try:
        db_type = conn_data.get("db_type", "mysql")
        engine = create_engine(_conn_url(conn_data), connect_args=_connect_args(conn_data.get("db_type","mysql"), timeout=10))
        with engine.connect() as c:
            if db_type in ('mysql', 'ob-mysql'):
                rows = c.execute(text("SHOW DATABASES")).fetchall()
                databases = [r[0] for r in rows if r[0] not in ("information_schema","mysql","performance_schema","sys","oceanbase")]
            elif db_type == 'postgresql':
                rows = c.execute(text("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname")).fetchall()
                databases = [r[0] for r in rows]
            elif db_type == 'oracle':
                rows = c.execute(text("SELECT DISTINCT OWNER FROM ALL_TABLES ORDER BY OWNER")).fetchall()
                databases = [r[0] for r in rows]
            elif db_type == 'mssql':
                rows = c.execute(text("SELECT name FROM sys.databases WHERE database_id>4 ORDER BY name")).fetchall()
                databases = [r[0] for r in rows]
            else:
                rows = c.execute(text("SHOW DATABASES")).fetchall()
                databases = [r[0] for r in rows if r[0] not in ("information_schema","mysql","performance_schema","sys","oceanbase")]
        engine.dispose()
        return {"ok": True, "databases": databases}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}

@eel.expose
def db_explore_get_schemas(conn_data, database):
    """PostgreSQL: 获取数据库下的 schema 列表"""
    try:
        cdata = dict(conn_data); cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as c:
            rows = c.execute(text("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name")).fetchall()
        engine.dispose()
        return {"ok": True, "schemas": [r[0] for r in rows]}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

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
    try:
        cdata = dict(conn_data); cdata["db"] = database
        db_type = cdata.get("db_type", "mysql")
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as c:
            if db_type in ('mysql', 'ob-mysql'):
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
            elif db_type == 'oracle':
                rows = c.execute(text(
                    "SELECT t.TABLE_NAME, t.NUM_ROWS, "
                    "COALESCE((SELECT SUM(s.BYTES) FROM ALL_SEGMENTS s WHERE s.OWNER=t.OWNER AND s.SEGMENT_NAME=t.TABLE_NAME),0), "
                    "COALESCE((SELECT c.COMMENTS FROM ALL_TAB_COMMENTS c WHERE c.OWNER=t.OWNER AND c.TABLE_NAME=t.TABLE_NAME AND c.TABLE_TYPE='TABLE'),'') "
                    "FROM ALL_TABLES t WHERE t.OWNER=:db ORDER BY t.TABLE_NAME"
                ), {"db":database}).fetchall()
                tables = [{"name":r[0],"rows":r[1] or 0,"data_size":_format_size(r[2]) if r[2] else "","update_time":"","comment":r[3] or ""} for r in rows]
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
        engine.dispose()
        return {"ok": True, "tables": tables}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}


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
        cdata = dict(conn_data); cdata["db"] = database
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
        cdata = dict(conn_data); cdata["db"] = database
        db_type = cdata.get("db_type", "mysql")
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as c:
            if db_type in ('mysql', 'ob-mysql'):
                rows = c.execute(text("SELECT ROUTINE_NAME,ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=:db ORDER BY ROUTINE_NAME"), {"db":database}).fetchall()
            elif db_type == 'postgresql':
                sch = schema if schema else 'public'
                rows = c.execute(text("SELECT proname,'FUNCTION' FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname=:sch ORDER BY proname"), {"sch":sch}).fetchall()
            elif db_type == 'oracle':
                rows = c.execute(text("SELECT OBJECT_NAME,OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER=:db AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION') ORDER BY OBJECT_NAME"), {"db":database}).fetchall()
            elif db_type == 'mssql':
                rows = c.execute(text("SELECT ROUTINE_NAME,ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES ORDER BY ROUTINE_NAME")).fetchall()
            else:
                rows = c.execute(text("SELECT ROUTINE_NAME,ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=:db ORDER BY ROUTINE_NAME"), {"db":database}).fetchall()
        engine.dispose()
        return {"ok": True, "procedures": [{"name":r[0],"type":r[1]} for r in rows]}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

@eel.expose
def db_explore_get_triggers(conn_data, database):
    try:
        cdata = dict(conn_data); cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as c:
            rows = c.execute(text(f"SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_TIMING FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=:db ORDER BY TRIGGER_NAME"), {"db":database}).fetchall()
        engine.dispose()
        return {"ok": True, "triggers": [{"name":r[0],"event":r[1],"table":r[2],"timing":r[3]} for r in rows]}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

@eel.expose
def db_explore_get_table_ddl(conn_data, database, table_name):
    try:
        cdata = dict(conn_data); cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        with engine.connect() as c: row = c.execute(text(f"SHOW CREATE TABLE `{database}`.`{table_name}`")).fetchone()
        engine.dispose()
        return {"ok": True, "ddl": row[1] if row else ""}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}

# ==================== 数据库管理 ====================
@eel.expose
def db_get_info(conn_data, database):
    """获取数据库信息（字符集、排序规则）"""
    try:
        cdata = dict(conn_data); db_type = cdata.get('db_type', 'mysql')
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
        if db_type not in ('postgresql',): cdata["db"] = database
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
            cdata = dict(conn_data); cdata["db"] = database
            db_type = cdata.get('db_type', 'mysql')
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


@eel.expose
def tree_save_query(qid, name, sql, conn_id, db=''):
    tree = _load_tree()
    if not qid: qid = f"q_{int(time.time() * 1000)}"
    tree["saved_queries"] = [q for q in tree.get("saved_queries", []) if q.get("id") != qid]
    tree.setdefault("saved_queries", []).append({"id": qid, "name": name, "sql": sql, "conn_id": conn_id or "", "db": db or ""})
    _save_tree(tree)
    return {"ok": True, "id": qid}

@eel.expose
def tree_delete_query(qid):
    tree = _load_tree()
    tree["saved_queries"] = [q for q in tree.get("saved_queries", []) if q.get("id") != qid]
    _save_tree(tree)
    return True

@eel.expose
def tree_get_query(qid):
    tree = _load_tree()
    for q in tree.get("saved_queries", []):
        if q.get("id") == qid: return q
    return None

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

def _generate_create_table(db_type, tbl, cols):
    """根据目标数据库类型生成 CREATE TABLE 语句"""
    if not cols:
        raise ValueError("无列信息")

    # 每列 SQL
    col_lines = []
    for c in cols:
        col_name = _safe_ident(c["name"], db_type)
        null = '' if c.get("nullable", True) else ' NOT NULL'
        dflt = f' DEFAULT {c["default"]}' if c.get("default") else ''
        col_lines.append(f"  {col_name} {c['type']}{null}{dflt}")

    inner = ',\n'.join(col_lines)

    if db_type in ('mysql', 'ob-mysql'):
        return f"CREATE TABLE {tbl} (\n{inner}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
    elif db_type == 'postgresql':
        return f"CREATE TABLE {tbl} (\n{inner}\n);"
    elif db_type == 'oracle':
        return f"CREATE TABLE {tbl} (\n{inner}\n)"
    elif db_type == 'mssql':
        return f"CREATE TABLE {tbl} (\n{inner}\n);"
    return f"CREATE TABLE {tbl} (\n{inner}\n);"

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

                ddl = _generate_create_table(dst_db_type, dst_tbl, cols)

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
                with src_engine.connect() as sconn:
                    total_rows = sconn.execute(text(f"SELECT COUNT(*) FROM {src_tbl}")).scalar()
                _progress_q.put(("drag_progress", {"percent": 20, "status": f"共 {total_rows:,} 行，开始复制..."}))

                with src_engine.connect() as sconn:
                    result = sconn.execute(text(f"SELECT * FROM {src_tbl}"))
                    columns = list(result.keys())
                    batch = []
                    batch_size = 5000
                    total = 0
                    with dst_engine.begin() as dconn:
                        for row in result:
                            batch.append(dict(zip(columns, row)))
                            if len(batch) >= batch_size:
                                _batch_insert(dconn, dst_tbl, columns, batch)
                                total += len(batch)
                                pct = 20 + int((total / max(total_rows, 1)) * 75)
                                _progress_q.put(("drag_progress", {"percent": min(pct, 95), "status": f"已复制 {total:,} / {total_rows:,} 行"}))
                                batch = []
                            if _query_cancel.is_set():
                                data_ok = False
                                break
                        if batch and not _query_cancel.is_set():
                            _batch_insert(dconn, dst_tbl, columns, batch)
                            total += len(batch)
                            _progress_q.put(("drag_progress", {"percent": 98, "status": f"已复制 {total:,} / {total_rows:,} 行"}))
                _progress_q.put(("drag_progress", {"percent": 100, "status": "复制完成！"}))
            except Exception as e:
                data_ok = False
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
        if db_type not in ('postgresql',):
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
        if db_type not in ('postgresql',):
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
def export_pick_file():
    """打开文件保存对话框，返回路径"""
    import tkinter.filedialog as fd, tkinter
    root = tkinter.Tk(); root.withdraw(); root.attributes('-topmost', True)
    path = fd.asksaveasfilename(
        title="选择导出位置", defaultextension=".sql",
        filetypes=[("SQL文件", "*.sql"), ("CSV文件", "*.csv"), ("所有文件", "*.*")]
    )
    root.destroy()
    return path or ""


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
            if db_type not in ('postgresql',):
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
        url_no_db = (f"mysql+pymysql://{quote_plus(cdata['user'])}:"
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
    """检查慢查询是否已开启"""
    try:
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args("mysql", timeout=10))
        with engine.connect() as conn:
            # 检查 slow_query_log 是否开启
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


@eel.expose
def slow_query_enable(data: dict, long_time: float = 2.0):
    """开启慢查询记录"""
    try:
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args("mysql", timeout=10))
        with engine.connect() as conn:
            # 先尝试 FILE 模式，失败则回退到 TABLE 模式
            try:
                conn.execute(text("SET GLOBAL slow_query_log = 'ON'"))
            except Exception:
                # 文件路径不存在，改为输出到 mysql.slow_log 表
                conn.execute(text("SET GLOBAL log_output = 'TABLE'"))
                conn.execute(text("SET GLOBAL slow_query_log = 'ON'"))
            conn.execute(text(f"SET GLOBAL long_query_time = {long_time}"))
            conn.execute(text("SET GLOBAL log_queries_not_using_indexes = 'ON'"))
        engine.dispose()
        return {"ok": True, "msg": f"慢查询已开启，阈值 {long_time}s"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def slow_query_get_list(data: dict, start_time: str = '', end_time: str = '',
                         limit: int = 100):
    """
    从 performance_schema 获取全局慢查询排行列表（不按数据库过滤）
    返回：按平均耗时倒序排列的 TOP 慢 SQL，标注每条SQL的来源数据库
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

        url_no_db = (f"mysql+pymysql://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:"
                     f"{cdata.get('port','3306')}?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=30))

        with engine.connect() as conn:
            # 先确认 performance_schema.events_statements_summary_by_digest 表是否存在
            check = conn.execute(text("""
                SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema='performance_schema'
                  AND table_name='events_statements_summary_by_digest'
            """)).scalar()

            if not check or check == 0:
                engine.dispose()
                return {"ok": False, "msg": "当前数据库不支持 performance_schema 慢查询统计",
                        "rows": [], "total": 0}

            # 全局查询所有数据库的慢SQL，按 AVG_TIMER > 1秒 过滤
            # 按平均耗时倒序排列，让最慢的SQL排在最前面
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
    从 mysql.slow_log 表读取历史慢日志记录（需 slow_query_log=ON 且 log_output=TABLE）
    与 performance_schema 不同：这是按时间排序的原始日志，每条慢SQL都有精确的开始时间
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

        url_no_db = (f"mysql+pymysql://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:"
                     f"{cdata.get('port','3306')}?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=30))

        with engine.connect() as conn:
            # 检查 slow_log 表是否存在
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
            return {"ok": False, "msg": "仅支持 MySQL"}

        url_no_db = (f"mysql+pymysql://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:"
                     f"{cdata.get('port','3306')}?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=15))

        with engine.connect() as conn:
            # 1. 获取汇总统计
            summary_sql = f"""
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
            """
            summary = conn.execute(text(summary_sql), {
                "db": database, "dtxt": digest_text
            }).fetchone()

            if not summary:
                engine.dispose()
                return {"ok": False, "msg": "未找到该SQL的统计数据"}

            # 使用 _mapping 安全构建 dict，同时处理 Decimal/datetime
            detail = {}
            for k, v in summary._mapping.items():
                key = k.lower().replace(' ', '_') if isinstance(k, str) else str(k)
                detail[key] = _json_safe(v)

            # 2. 从 events_statements_history 获取最近几次执行的完整SQL
            recent_sqls = []
            try:
                history_sql = f"""
                    SELECT SQL_TEXT, TIMER_START, TIMER_END, LOCK_TIME,
                           ROWS_SENT, ROWS_EXAMINED, ERRORS, WARNINGS
                    FROM performance_schema.events_statements_history
                    WHERE SCHEMA_NAME = :db
                      AND SUBSTRING(SQL_TEXT, 1, 200) = SUBSTRING(:dtxt, 1, 200)
                    ORDER BY TIMER_START DESC
                    LIMIT 5
                """
                hist_result = conn.execute(text(history_sql), {
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
                pass  # 历史表可能不可访问

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


# ==================== 启动 ====================
if __name__ == "__main__":
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
    try:
        eel.start("index.html", size=(1280, 860), port=0, cmdline_args=['--disable-dev-tools'])
    finally:
        # 窗口关闭后强制退出，防止 gevent / bottle 后台残留
        os._exit(0)
