"""
传输引擎 — TransferEngine 类
"""
import threading
import time
import re
from urllib.parse import quote_plus
from typing import List
from sqlalchemy import text, inspect, create_engine
from modules import _progress_q
from modules.conn_utils import _connect_args

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
