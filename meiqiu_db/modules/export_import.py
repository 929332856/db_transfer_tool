"""
导出/导入向导
"""
import eel
import os
import re
import time
import csv
import io
import threading
import tkinter.filedialog as fd
import tkinter
from sqlalchemy import text, create_engine
from modules import _progress_q, BASE_DIR
from modules.conn_utils import _connect_args, _conn_url, _safe_ident, _build_table_ref, _friendly_error
from modules.config_state import _log_db_select, _log_db_insert, _log_db_update, _log_db_delete, _db_op_logger

# ==================== 导出导入向导 ====================

@eel.expose
def export_wizard_get_tables(conn_data, database, schema=''):
    """获取数据库中的表列表"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql', 'oracle'):
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
        if db_type not in ('postgresql', 'oracle'):
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
            if db_type not in ('postgresql', 'oracle'):
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
