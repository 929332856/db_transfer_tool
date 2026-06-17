"""
数据库管理：信息查询、删除、创建、排序规则、运行 SQL、保存查询
"""
import eel
import os
import re
import time
import threading
import tkinter.filedialog as fd
import tkinter
from sqlalchemy import text, create_engine
from modules import _progress_q
from modules.conn_utils import _connect_args, _conn_url, _safe_ident, _build_table_ref, _friendly_error
from modules.config_state import _log_db_select, _log_db_insert, _log_db_update, _log_db_delete, _db_op_logger
from modules.tree_manager import _load_tree, _save_tree


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
        elif db_type == 'oracle':
            # Oracle 没有 MySQL 意义上的 CREATE DATABASE
            # 如需创建 Schema，请用 CREATE USER；如需创建 PDB，请用 CREATE PLUGGABLE DATABASE
            engine.dispose()
            return {"ok": False, "msg": "Oracle 不支持 CREATE DATABASE。如需创建 Schema（用户），请使用 CREATE USER 语句"}
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
