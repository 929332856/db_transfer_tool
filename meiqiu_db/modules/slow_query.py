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
    """检查慢查询是否已开启（MySQL 用 slow_query_log，OceanBase 用 SQL_AUDIT）"""
    try:
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }
        db_type = cdata.get("db_type", "mysql")
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args("mysql", timeout=10))
        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # OceanBase：检查 ob_enable_sql_audit（审计视图是否可用）
                try:
                    row = conn.execute(text(
                        "SHOW VARIABLES LIKE 'ob_enable_sql_audit'"
                    )).fetchone()
                except Exception:
                    row = None
                enabled = row[1] == 'ON' if row else True  # OB 默认开启 SQL 审计

                # 尝试获取 SQL 审计百分比
                try:
                    pct_row = conn.execute(text(
                        "SHOW VARIABLES LIKE 'ob_sql_audit_percentage'"
                    )).fetchone()
                    audit_pct = int(pct_row[1]) if pct_row else 100
                except Exception:
                    audit_pct = 100

                # OB 阈值用 trace_log_slow_query_watermark
                try:
                    th_row = conn.execute(text(
                        "SHOW VARIABLES LIKE 'trace_log_slow_query_watermark'"
                    )).fetchone()
                except Exception:
                    th_row = None
                if th_row:
                    threshold = _parse_ob_time_to_sec(th_row[1])
                else:
                    threshold = 1.0

                log_file = f"SQL审计采样率: {audit_pct}% (查询 oceanbase.GV$OB_SQL_AUDIT)"
            else:
                # MySQL：检查 slow_query_log 是否开启
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


def _parse_ob_time_to_sec(val: str) -> float:
    """解析 OceanBase 时间字符串（如 '1s'、'100ms'）为秒"""
    if val is None:
        return 1.0
    v = str(val).strip().lower()
    if v.endswith('ms'):
        return float(v[:-2]) / 1000.0
    if v.endswith('s'):
        return float(v[:-1])
    if v.endswith('m'):
        return float(v[:-1]) * 60
    if v.endswith('h'):
        return float(v[:-1]) * 3600
    if v.endswith('us'):
        return float(v[:-2]) / 1000000.0
    try:
        return float(v)
    except ValueError:
        return 1.0


@eel.expose
def slow_query_enable(data: dict, long_time: float = 2.0):
    """开启慢查询记录（MySQL 用慢日志，OceanBase 用 SQL 审计）"""
    try:
        cdata = dict(data)
        if "user" not in cdata:
            cdata = {
                "host": cdata.get("src_host", ""), "port": cdata.get("src_port", "3306"),
                "user": cdata.get("src_user", ""), "pwd": cdata.get("src_pwd", ""),
                "db": "", "db_type": cdata.get("db_type", "mysql")
            }
        db_type = cdata.get("db_type", "mysql")
        url = _conn_url(cdata)
        engine = create_engine(url, connect_args=_connect_args("mysql", timeout=10))
        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # OceanBase：确保 SQL 审计已开启 + 设置采样率为 100%
                try:
                    conn.execute(text("SET GLOBAL ob_enable_sql_audit = ON"))
                except Exception:
                    pass  # OB 默认开启，忽略权限不足
                try:
                    conn.execute(text("SET GLOBAL ob_sql_audit_percentage = 100"))
                except Exception:
                    pass
                # 设置慢查询水位线（用于 trace log）
                try:
                    conn.execute(text(
                        f"SET GLOBAL trace_log_slow_query_watermark = '{long_time}s'"
                    ))
                except Exception:
                    pass
                msg = (f"OceanBase SQL 审计已配置，慢查询阈值 {long_time}s\n"
                       f"（通过 oceanbase.GV$OB_SQL_AUDIT 视图查询）")
            else:
                # MySQL：先尝试 FILE 模式，失败则回退到 TABLE 模式
                try:
                    conn.execute(text("SET GLOBAL slow_query_log = 'ON'"))
                except Exception:
                    # 文件路径不存在，改为输出到 mysql.slow_log 表
                    conn.execute(text("SET GLOBAL log_output = 'TABLE'"))
                    conn.execute(text("SET GLOBAL slow_query_log = 'ON'"))
                conn.execute(text(f"SET GLOBAL long_query_time = {long_time}"))
                conn.execute(text("SET GLOBAL log_queries_not_using_indexes = 'ON'"))
                msg = f"慢查询已开启，阈值 {long_time}s"
        engine.dispose()
        return {"ok": True, "msg": msg}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def slow_query_get_list(data: dict, start_time: str = '', end_time: str = '',
                         limit: int = 100):
    """
    获取全局慢查询排行列表（按平均耗时倒序）
    MySQL：从 performance_schema.events_statements_summary_by_digest
    OceanBase：从 oceanbase.GV$OB_SQL_AUDIT 聚合查询
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
            if db_type == 'ob-mysql':
                # ===== OceanBase 路径：从 GV$OB_SQL_AUDIT 聚合 =====
                # 先检查视图是否存在
                try:
                    check = conn.execute(text("""
                        SELECT COUNT(*) FROM information_schema.tables
                        WHERE table_schema='oceanbase'
                          AND table_name='GV$OB_SQL_AUDIT'
                    """)).scalar()
                except Exception:
                    check = 0

                if not check or check == 0:
                    engine.dispose()
                    return {"ok": False, "msg": "当前 OceanBase 不可访问 GV$OB_SQL_AUDIT 视图",
                            "rows": [], "total": 0}

                # OceanBase 聚合：按 QUERY_SQL + DB_NAME 分组，ELAPSED_TIME 单位微秒
                where_parts = ["ELAPSED_TIME > 1000000", "QUERY_SQL IS NOT NULL"]
                params = {"lim": limit}
                if start_time:
                    where_parts.append("REQUEST_TIME >= :st")
                    params["st"] = start_time
                if end_time:
                    where_parts.append("REQUEST_TIME <= :et")
                    params["et"] = end_time

                where_clause = " AND ".join(where_parts)
                sql = text(f"""
                    SELECT
                        DB_NAME as schema_name,
                        SUBSTR(QUERY_SQL, 1, 4000) as digest_text,
                        COUNT(1) as count_star,
                        SUM(ELAPSED_TIME)/1000000.0 as total_time_sec,
                        AVG(ELAPSED_TIME)/1000000.0 as avg_time_sec,
                        MAX(ELAPSED_TIME)/1000000.0 as max_time_sec,
                        SUM(RETURN_ROWS) as rows_sent,
                        SUM(AFFECTED_ROWS) as rows_examined,
                        SUM(CASE WHEN RET_CODE != 0 THEN 1 ELSE 0 END) as errors,
                        0 as warnings,
                        MIN(REQUEST_TIME) as first_seen,
                        MAX(REQUEST_TIME) as last_seen
                    FROM oceanbase.GV$OB_SQL_AUDIT
                    WHERE {where_clause}
                    GROUP BY DB_NAME, SUBSTR(QUERY_SQL, 1, 4000)
                    ORDER BY AVG(ELAPSED_TIME) DESC
                    LIMIT :lim
                """)
                exec_result = conn.execute(sql, params)
                columns, rows = _rows_to_dicts(exec_result)

            else:
                # ===== MySQL 路径：从 performance_schema =====
                check = conn.execute(text("""
                    SELECT COUNT(*) FROM information_schema.tables
                    WHERE table_schema='performance_schema'
                      AND table_name='events_statements_summary_by_digest'
                """)).scalar()

                if not check or check == 0:
                    engine.dispose()
                    return {"ok": False, "msg": "当前数据库不支持 performance_schema 慢查询统计",
                            "rows": [], "total": 0}

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
    读取慢查询原始日志
    MySQL：从 mysql.slow_log 表（需 log_output=TABLE）
    OceanBase：从 oceanbase.GV$OB_SQL_AUDIT（按时间排序的审计记录）
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
            if db_type == 'ob-mysql':
                # ===== OceanBase 路径：GV$OB_SQL_AUDIT 按时间排列 =====
                where_parts = ["ELAPSED_TIME > 1000000", "QUERY_SQL IS NOT NULL"]
                params = {"lim": limit}
                if start_time:
                    where_parts.append("REQUEST_TIME >= :st")
                    params["st"] = start_time
                if end_time:
                    where_parts.append("REQUEST_TIME <= :et")
                    params["et"] = end_time
                where_clause = " AND ".join(where_parts)

                sql = text(f"""
                    SELECT
                        REQUEST_TIME as start_time,
                        CONCAT(USER_NAME, '@', CLIENT_IP) as user_host,
                        ELAPSED_TIME/1000000.0 as query_time,
                        0 as lock_time,
                        RETURN_ROWS as rows_sent,
                        AFFECTED_ROWS as rows_examined,
                        DB_NAME as db,
                        SUBSTR(QUERY_SQL, 1, 4000) as sql_text
                    FROM oceanbase.GV$OB_SQL_AUDIT
                    WHERE {where_clause}
                    ORDER BY ELAPSED_TIME DESC
                    LIMIT :lim
                """)
                exec_result = conn.execute(sql, params)
                columns, rows = _rows_to_dicts(exec_result)

            else:
                # ===== MySQL 路径：mysql.slow_log =====
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
            return {"ok": False, "msg": "仅支持 MySQL / OceanBase"}

        url_no_db = (f"mysql+pymysql://{quote_plus(cdata['user'])}:"
                     f"{quote_plus(cdata['pwd'])}@{cdata['host']}:"
                     f"{cdata.get('port','3306')}?charset=utf8mb4")
        engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=15))

        with engine.connect() as conn:
            if db_type == 'ob-mysql':
                # ===== OceanBase 路径：GV$OB_SQL_AUDIT 聚合统计 + 最近样本 =====
                sql_prefix = digest_text[:200] if digest_text else ''

                summary_sql = text("""
                    SELECT
                        DB_NAME as schema_name,
                        SUBSTR(QUERY_SQL, 1, 4000) as digest_text,
                        COUNT(1) as count_star,
                        SUM(ELAPSED_TIME)/1000000.0 as total_time,
                        AVG(ELAPSED_TIME)/1000000.0 as avg_time,
                        MAX(ELAPSED_TIME)/1000000.0 as max_time,
                        MIN(ELAPSED_TIME)/1000000.0 as min_time,
                        SUM(RETURN_ROWS) as rows_sent,
                        SUM(AFFECTED_ROWS) as rows_examined,
                        SUM(CASE WHEN RET_CODE != 0 THEN 1 ELSE 0 END) as errors,
                        0 as warnings,
                        MIN(REQUEST_TIME) as first_seen,
                        MAX(REQUEST_TIME) as last_seen
                    FROM oceanbase.GV$OB_SQL_AUDIT
                    WHERE DB_NAME = :db
                      AND SUBSTR(QUERY_SQL, 1, 200) = :prefix
                    GROUP BY DB_NAME, SUBSTR(QUERY_SQL, 1, 4000)
                    LIMIT 1
                """)
                summary = conn.execute(summary_sql, {
                    "db": database, "prefix": sql_prefix
                }).fetchone()

                if not summary:
                    engine.dispose()
                    return {"ok": False, "msg": "未找到该SQL的统计数据"}

                detail = {}
                for k, v in summary._mapping.items():
                    key = k.lower().replace(' ', '_') if isinstance(k, str) else str(k)
                    detail[key] = _json_safe(v)

                # 最近样本：从 GV$OB_SQL_AUDIT 取最新 5 条
                recent_sqls = []
                try:
                    hist_sql = text("""
                        SELECT
                            SUBSTR(QUERY_SQL, 1, 4000) as SQL_TEXT,
                            REQUEST_TIME as TIMER_START,
                            ELAPSED_TIME as TIMER_END_TIME,
                            0 as LOCK_TIME,
                            RETURN_ROWS as ROWS_SENT,
                            AFFECTED_ROWS as ROWS_EXAMINED,
                            CASE WHEN RET_CODE != 0 THEN 1 ELSE 0 END as ERRORS,
                            0 as WARNINGS,
                            TRACE_ID, USER_NAME, CLIENT_IP, RET_CODE, PLAN_ID
                        FROM oceanbase.GV$OB_SQL_AUDIT
                        WHERE DB_NAME = :db
                          AND SUBSTR(QUERY_SQL, 1, 200) = :prefix
                        ORDER BY REQUEST_TIME DESC
                        LIMIT 5
                    """)
                    hist_result = conn.execute(hist_sql, {
                        "db": database, "prefix": sql_prefix
                    }).fetchall()
                    for hr in hist_result:
                        hdict = {}
                        for k, v in hr._mapping.items():
                            key = str(k)
                            if key == 'TIMER_END_TIME' and isinstance(v, (int, float)):
                                hdict['ELAPSED'] = f"{v/1000000.0:.4f}s" if v > 0 else "0"
                                hdict[key] = _json_safe(v)
                            else:
                                hdict[key] = _json_safe(v)
                        recent_sqls.append(hdict)
                except Exception:
                    pass

            else:
                # ===== MySQL 路径 =====
                summary_sql = text("""
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
                """)
                summary = conn.execute(summary_sql, {
                    "db": database, "dtxt": digest_text
                }).fetchone()

                if not summary:
                    engine.dispose()
                    return {"ok": False, "msg": "未找到该SQL的统计数据"}

                detail = {}
                for k, v in summary._mapping.items():
                    key = k.lower().replace(' ', '_') if isinstance(k, str) else str(k)
                    detail[key] = _json_safe(v)

                # 从 events_statements_history 获取最近几次执行的完整SQL
                recent_sqls = []
                try:
                    history_sql = text("""
                        SELECT SQL_TEXT, TIMER_START, TIMER_END, LOCK_TIME,
                               ROWS_SENT, ROWS_EXAMINED, ERRORS, WARNINGS
                        FROM performance_schema.events_statements_history
                        WHERE SCHEMA_NAME = :db
                          AND SUBSTRING(SQL_TEXT, 1, 200) = SUBSTRING(:dtxt, 1, 200)
                        ORDER BY TIMER_START DESC
                        LIMIT 5
                    """)
                    hist_result = conn.execute(history_sql, {
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
                    pass

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
            if db_type == 'ob-mysql':
                # OceanBase：用 GV$OB_PROCESSLIST 获取更全的信息
                try:
                    exec_result = conn.execute(text(
                        "SELECT /*+ READ_CONSISTENCY(WEAK) */ "
                        "ID as id, USER as user_, HOST as host, DB as db, "
                        "COMMAND as command, TIME as time_, STATE as state, "
                        "SUBSTR(INFO, 1, 500) as info "
                        "FROM oceanbase.GV$OB_PROCESSLIST "
                        "WHERE COMMAND != 'Sleep' AND INFO IS NOT NULL AND INFO != '' "
                        "AND TIME >= 1 "
                        "ORDER BY TIME DESC LIMIT 50"
                    ))
                except Exception:
                    # 回退到标准 INFORMATION_SCHEMA
                    exec_result = conn.execute(text(
                        "SELECT ID as id, USER as user_, HOST as host, DB as db, "
                        "COMMAND as command, TIME as time_, STATE as state, "
                        "INFO as info "
                        "FROM INFORMATION_SCHEMA.PROCESSLIST "
                        "WHERE COMMAND != 'Sleep' AND INFO IS NOT NULL AND INFO != '' "
                        "AND TIME >= 1 "
                        "ORDER BY TIME DESC LIMIT 50"
                    ))
            else:
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
