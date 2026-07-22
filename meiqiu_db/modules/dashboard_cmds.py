"""
查询最近 1 分钟内 performance_schema 中按命令类型统计的高频 SQL
供"每秒命令数"图表点击查看用
"""
import eel
import traceback
from urllib.parse import quote_plus
from sqlalchemy import create_engine, text


@eel.expose
def dashboard_get_top_cmds(conn_info, cmd_type='UPDATE', minutes=1, top_n=20):
    """
    查询 performance_schema.events_statements_summary_by_digest 中
    最近 minutes 分钟内执行次数最高的指定类型 SQL
    cmd_type: SELECT/INSERT/UPDATE/DELETE
    """
    try:
        url = conn_info.get("url") or ""
        if not url:
            db_type = conn_info.get("db_type", "mysql")
            host = conn_info.get("host", "127.0.0.1")
            port = conn_info.get("port", 3306)
            user = conn_info.get("user", "root")
            password = conn_info.get("password", "")
            db = conn_info.get("database", "")
            pwd = quote_plus(password) if password else ""
            url = f"mysql+pymysql://{user}:{pwd}@{host}:{port}/{db}?charset=utf8mb4"

        engine = create_engine(url, pool_pre_ping=True,
                               connect_args={"connect_timeout": 10})
        with engine.connect() as conn:
            # 命令类型 SQL 标识
            type_sql = {
                'SELECT': 'SELECT%',
                'INSERT': 'INSERT%',
                'UPDATE': 'UPDATE%',
                'DELETE': 'DELETE%',
            }.get(cmd_type.upper(), '%')
            try:
                # ★ 用 events_statements_history 取最近 N 分钟的实时数据（非累计）
                #    MySQL 5.7+ 默认 events_statements_history_size=10（每线程），太小
                #    自动调大到 1000，确保能查到最近几分钟的数据
                try:
                    conn.execute(text("SET GLOBAL performance_schema_events_statements_history_size = 1000"))
                except Exception:
                    pass

                sql = text("""
                    SELECT
                        SUBSTRING(DIGEST_TEXT, 1, 500) AS sql_text,
                        COUNT(*) AS exec_count,
                        ROUND(SUM(TIMER_WAIT)/1000000000, 2) AS total_ms,
                        ROUND(AVG(TIMER_WAIT)/1000000, 2) AS avg_ms,
                        SUM(ROWS_EXAMINED) AS rows_examined,
                        SUM(ROWS_SENT) AS rows_sent
                    FROM performance_schema.events_statements_history
                    WHERE DIGEST_TEXT LIKE :type_pattern
                      AND DIGEST_TEXT IS NOT NULL
                      AND TIMER_END >= DATE_SUB(NOW(6), INTERVAL :seconds SECOND)
                    GROUP BY DIGEST_TEXT
                    ORDER BY exec_count DESC
                    LIMIT :top_n
                """)
                result = conn.execute(sql, {"type_pattern": type_sql, "seconds": minutes * 60, "top_n": top_n})
                rows = [dict(zip(list(result.keys()), r)) for r in result.fetchall()]
            except Exception as e:
                return {"ok": False, "msg": "performance_schema 查询失败: " + str(e)}

        engine.dispose()
        return {"ok": True, "cmd_type": cmd_type.upper(), "minutes": minutes, "rows": rows}
    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "msg": str(e)}
