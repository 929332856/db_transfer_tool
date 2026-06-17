"""
数据库连接工具：URL 构建、安全标识符、友好错误
"""
from urllib.parse import quote_plus
import re
from sqlalchemy import create_engine, text

def _connect_args(db_type='mysql', timeout=10):
    """返回 create_engine 的 connect_args，MySQL 禁用 SSL
    注意：oracledb 不支持 connect_timeout 参数，Oracle 不使用此参数
    """
    if db_type == 'oracle':
        # oracledb 驱动不支持 connect_timeout，返回空字典
        return {}
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
    base = f"mysql+pymysql://{u}:{p}@{h}:{port}"
    return f"{base}/{db}?charset=utf8mb4" if db else f"{base}/?charset=utf8mb4"
