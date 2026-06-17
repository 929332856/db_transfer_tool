"""
数据库浏览器 + 连接工具 + 诊断
"""
import eel
import sys
import importlib
from urllib.parse import quote_plus
from sqlalchemy import text, create_engine
from modules.conn_utils import _connect_args, _conn_url, _friendly_error, _DRIVER_HINTS

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
