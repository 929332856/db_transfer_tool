"""
慢 SQL 查询分析
"""
import eel
from urllib.parse import quote_plus
from sqlalchemy import text, create_engine
from modules.conn_utils import _connect_args, _conn_url
from modules.serializers import _rows_to_dicts, _json_safe



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
