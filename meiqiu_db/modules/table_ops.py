"""
表操作：预览、保存、删除、DDL
"""
import eel
import re
from sqlalchemy import text, create_engine
from modules import _query_cancel
from modules.conn_utils import _connect_args, _conn_url, _safe_ident, _build_table_ref, _friendly_error
from modules.serializers import _json_safe, _row_to_json
from modules.config_state import _log_db_select, _log_db_insert, _log_db_update, _log_db_delete, _gen_rollback_insert

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
            col_types = _load_column_types(conn, db_type, database, table_name, schema)
        engine.dispose()
        return {"ok": True, "columns": columns, "rows": rows, "comments": comments, "col_types": col_types}
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
            col_types = _load_column_types(conn, db_type, database, table_name, schema)
        engine.dispose()
        return {"ok": True, "columns": columns, "rows": rows, "comments": comments,
                "col_types": col_types, "fast": True, "total_hint": len(rows)}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, cdata.get('db_type','mysql'))}


@eel.expose
def table_get_col_types(conn_data, database, table_name, schema=''):
    """供查询窗口获取列类型和注释"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql',):
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
    if not table_name or not table_name.strip():
        return {"ok": False, "msg": "无法识别表名，请确保查询指定了 FROM 子句"}
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
    if not table_name or not table_name.strip():
        return {"ok": False, "msg": "无法识别表名，请确保查询指定了 FROM 子句"}
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
    if not table_name or not table_name.strip():
        return {"ok": False, "msg": "无法识别表名，请确保查询指定了 FROM 子句"}
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
    if not table_name or not table_name.strip():
        return {"ok": False, "msg": "无法识别表名，请确保查询指定了 FROM 子句"}
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
