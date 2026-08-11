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


def _get_pk_columns(engine, table_name: str):
    """获取表的单列主键或唯一索引列（用于分页拉取）；无则返回空列表"""
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
        self.batch_size = config.get("batch_size", 50000)
        # ★ 多表并行传输开关：多张表时每表独立连接同时传输（默认关闭）
        self.parallel = config.get("parallel", False)
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

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
            tmp_engine = create_engine(self.dst_url_no_db, connect_args=_connect_args("mysql", timeout=10))
            with tmp_engine.connect() as conn:
                conn.execute(text("COMMIT"))
                conn.execute(text(
                    f"CREATE DATABASE IF NOT EXISTS `{self.dst_db}` "
                    f"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                ))
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
        result = conn.execute(text(f"SHOW CREATE TABLE `{table_name}`"))
        row = result.fetchone()
        return row[1] if row else ""

    def _create_all_tables(self, src_engine, dst_engine, tables: List[str]):
        _progress_q.put(("log", "📋 阶段1：检查/创建表结构..."))
        ddls = {}
        with src_engine.connect() as src_conn:
            for table_name in tables:
                if self._stop_event.is_set():
                    return False
                ddl = self._get_table_ddl(src_conn, table_name)
                if ddl:
                    ddls[table_name] = ddl
        # ★ 先检查目标库是否已存在同名表，存在则报错停止
        existing = []
        inspector = inspect(dst_engine)
        dst_tables = set(inspector.get_table_names())
        for table_name in tables:
            if table_name in dst_tables:
                existing.append(table_name)
        if existing:
            _progress_q.put(("error", f"❌ 目标数据库中已存在以下表，请手动处理后重试：{', '.join(existing)}"))
            _progress_q.put(("done", "同步已取消"))
            return False
        with dst_engine.connect() as dst_conn:
            dst_conn.execute(text("COMMIT"))
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
            for table_name in tables:
                if self._stop_event.is_set():
                    break
                if table_name in ddls:
                    # 清理 OceanBase 专有语法后执行
                    safe_ddl = self._sanitize_ddl(ddls[table_name])
                    dst_conn.execute(text(safe_ddl))
                    _progress_q.put(("log", f"  ✅ 表 [{table_name}] 结构已创建"))
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        _progress_q.put(("log", "✅ 所有表结构创建完成"))
        return True

    def _transfer_single_table(self, src_engine, dst_engine,
                               table_name: str, table_index: int,
                               total_tables: int, dst_conn) -> int:
        prefix = f"[{table_index}/{total_tables}]" if total_tables > 1 else ""
        _progress_q.put(("log", f"{prefix} 📊 表 [{table_name}] 开始传输..."))
        # ★ 优先主键分页拉取：每次查询是独立短往返且 buffered 读取，I/O 等待期间不持有 GIL。
        #    源库为公网/大表时，流式读取（SSCursor fetch 不释放 GIL）会锁死整个进程导致 UI 无响应；
        #    无主键/唯一索引的表回退流式读取（批次减半缓解卡顿）
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
            sql = f"INSERT IGNORE INTO `{table_name}` ({col_list}) VALUES " + ", ".join([values_tmpl] * part_rows)
            flat = [v for row in part for v in row]
            # ★ 参数必须是「tuple 列表」（每组一个 tuple）：扁平 list 会被 SQLAlchemy
            #    误判为 executemany 参数组而报 "List argument must consist only of tuples"
            r = dst_conn.exec_driver_sql(sql, [tuple(flat)])
            # ★ rowcount 为实际受影响行数；小于本片行数 = 重复键被跳过
            affected = r.rowcount
            if affected is not None and affected >= 0:
                skipped += max(0, part_rows - affected)
            # ★ 每批提交：避免单表大事务撑爆 undo log → 磁盘满 → 服务器卡死
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
            # 先取列名：LIMIT 0 快速返回，不拉数据
            result = src_conn.exec_driver_sql(f"SELECT * FROM `{table_name}` LIMIT 0")
            columns = list(result.keys())
            col_list = ', '.join(f'`{c}`' for c in columns)
            values_tmpl = "(" + ", ".join(["%s"] * len(columns)) + ")"
            pk_index = columns.index(pk) if pk in columns else None
            while not self._stop_event.is_set():
                if last is None:
                    sql = f"SELECT * FROM `{table_name}` ORDER BY `{pk}` LIMIT {batch}"
                    rows = src_conn.exec_driver_sql(sql).fetchall()
                else:
                    sql = f"SELECT * FROM `{table_name}` WHERE `{pk}` > %s ORDER BY `{pk}` LIMIT {batch}"
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
        try:
            result = src_conn.execute(text(f"SELECT * FROM `{table_name}`"))
            columns = list(result.keys())
            col_list = ', '.join(f'`{c}`' for c in columns)
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
            # ★ 目标库连接包装硬超时（30s），防止丢包/防火墙场景下无限挂起
            import concurrent.futures as _cf
            _connect_dst_future = _cf.ThreadPoolExecutor(max_workers=1).submit(self._create_dst_database)
            try:
                _connect_dst_future.result(timeout=30)
            except _cf.TimeoutError:
                raise Exception("目标库连接超时（>30s），请检查地址、端口、防火墙")
            dst_engine = create_engine(self.dst_url, pool_pre_ping=True,
                                       connect_args=_connect_args("mysql", timeout=10, read_timeout=3600))
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
            if not self._create_all_tables(src_engine, dst_engine, tables):
                # ★ 建表失败（目标库存在同名表）→ 直接结束
                _progress_q.put(("total", ""))
                return

            if self._stop_event.is_set():
                _progress_q.put(("log", "⏸ 用户停止传输"))
            else:
                _progress_q.put(("log", "📊 阶段2：传输数据..."))
                total_rows = 0
                if self.parallel and len(tables) > 1:
                    # ★ 多表并行：每表独立连接同时传输（每表独立事务，导完一张提交一张）
                    import concurrent.futures
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
                                _progress_q.put(("error", f"❌ 表 [{futures[fut]}] 传输失败: {e}"))
                else:
                    # ★ 串行模式：共享连接，每导完一张表 commit 一次，避免一张表失败导致全部回滚
                    with dst_engine.connect() as dst_conn:
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
