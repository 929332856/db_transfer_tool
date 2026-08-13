"""
数据库连接工具：URL 构建、安全标识符、友好错误
"""
from urllib.parse import quote_plus
import re
from sqlalchemy import create_engine, text

# ★ Oracle oracledb 驱动加速：尝试 Thick 模式（C 层 Oracle Client，比 Thin 快 2-5 倍）
try:
    import oracledb as _odb
    try:
        _odb.init_oracle_client()
    except Exception:
        pass
except ImportError:
    pass

def _connect_args(db_type='mysql', timeout=10, read_timeout=None):
    """返回 create_engine 的 connect_args，MySQL 禁用 SSL
    注意：oracledb 不支持 connect_timeout 参数，Oracle 不使用此参数
    """
    if db_type == 'oracle':
        # oracledb 驱动不支持 connect_timeout，返回空字典
        return {}
    args = {"connect_timeout": timeout}
    if db_type in ('mysql', 'ob-mysql'):
        # mysqlclient (MySQLdb) 用 ssl=False 禁用 SSL（不是 pymysql 的 ssl_disabled）
        args["ssl"] = False
        if read_timeout:
            args["read_timeout"] = read_timeout
    return args

# ==================== 表操作 ====================
def _safe_ident(ident, db_type='mysql'):
    """按数据库方言安全引用标识符，并转义包围符。"""
    if ident is None:
        raise ValueError('标识符不能为空')
    ident = str(ident)
    if not ident or len(ident) > 255 or any(ord(ch) < 32 for ch in ident):
        raise ValueError('标识符为空、过长或包含控制字符')
    if db_type in ('mysql', 'ob-mysql'):
        return f'`{ident.replace("`", "``")}`'
    elif db_type in ('postgresql', 'oracle', 'sqlite'):
        return f'"{ident.replace(chr(34), chr(34) * 2)}"'
    elif db_type == 'mssql':
        return f'[{ident.replace("]", "]]" )}]'
    raise ValueError(f'不支持的数据库类型: {db_type}')

def _build_table_ref(conn_data, database, table_name, schema=''):
    """构建带正确引号的全限定表名（如 `db`.`tbl` / \"sch\".\"tbl\" / [db].[tbl]）"""
    db_type = conn_data.get("db_type", "mysql")
    if db_type in ('mysql', 'ob-mysql'):
        return f"{_safe_ident(database, db_type)}.{_safe_ident(table_name, db_type)}"
    elif db_type == 'postgresql':
        q = schema if schema else database
        return f'{_safe_ident(q, db_type)}.{_safe_ident(table_name, db_type)}'
    elif db_type == 'oracle':
        return f'{_safe_ident(database, db_type)}.{_safe_ident(table_name, db_type)}'
    elif db_type == 'mssql':
        return f'{_safe_ident(database, db_type)}.{_safe_ident(table_name, db_type)}'
    elif db_type == 'sqlite':
        return _safe_ident(table_name, db_type)
    raise ValueError(f'不支持的数据库类型: {db_type}')


_DRIVER_HINTS = {
    'mysql':      'mysqlclient',
    'ob-mysql':   'mysqlclient',
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
