"""
拖拽复制表
"""
import eel
from urllib.parse import quote_plus
from sqlalchemy import text, create_engine
from modules import _progress_q, _query_cancel
from modules.conn_utils import _connect_args, _conn_url, _safe_ident, _build_table_ref

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
