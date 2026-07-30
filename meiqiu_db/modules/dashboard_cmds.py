"""
仪表盘最近 SQL 命令捕获（基于临时文件 + 图表刷新写入）

设计：
- dashboard_capture_top_cmds：每次图表刷新时调用，从 events_statements_history_long
  聚合最近 N 秒的 SQL 列表，写到临时文件 logs/recent_cmds_{session_id}.json
- dashboard_read_recent_cmds：面板打开/刷新时调用，**只读文件**，不查 DB
- dashboard_reset_recent_cmds：点击「重置」时调用，删除文件
"""
import eel
import time
import threading
import traceback
import json
import os
import sys
from urllib.parse import quote_plus
from sqlalchemy import create_engine, text


# ★ 临时文件目录：<exe所在目录>/logs/recent_cmds/（开发时 = 项目根目录）
if getattr(sys, 'frozen', False):
    _BASE_DIR = os.path.dirname(sys.executable)
else:
    _BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TMP_DIR = os.path.join(_BASE_DIR, 'logs', 'recent_cmds')
try:
    os.makedirs(_TMP_DIR, exist_ok=True)
except Exception:
    pass

# ★ 文件写入锁：防止多个 cmd_type 同时 capture 导致同一个 json 损坏
_FILE_LOCKS = {}
_FILE_LOCKS_LOCK = threading.Lock()


def _normalize_conn_data(conn_info: dict) -> dict:
    """统一规范化连接参数：兼容 src_ 前缀格式"""
    cdata = dict(conn_info)
    if "host" not in cdata or not cdata.get("host"):
        cdata["host"] = cdata.get("src_host", "")
    if "port" not in cdata or not cdata.get("port"):
        cdata["port"] = cdata.get("src_port", "3306")
    if "user" not in cdata or not cdata.get("user"):
        cdata["user"] = cdata.get("src_user", "")
    if "password" not in cdata or not cdata.get("password"):
        cdata["password"] = cdata.get("src_pwd", "")
    if "database" not in cdata or not cdata.get("database"):
        cdata["database"] = cdata.get("src_db", "")
    return cdata


def _tmp_path(session_id):
    """根据 session id 生成临时文件路径"""
    safe = ''.join(c if c.isalnum() else '_' for c in (session_id or 'global'))[:64] or 'global'
    return os.path.join(_TMP_DIR, f'recent_cmds_{safe}.json')


def clean_recent_cmds_tmp():
    """应用退出时调用：清理所有临时文件"""
    try:
        for f in os.listdir(_TMP_DIR):
            if f.startswith('recent_cmds_') and f.endswith('.json'):
                try:
                    os.remove(os.path.join(_TMP_DIR, f))
                except Exception:
                    pass
    except Exception:
        pass


@eel.expose
def dashboard_capture_top_cmds(conn_info, session_id='', cmd_type='DELETE', minutes=1, top_n=20):
    """
    每次图表刷新调用：
    - 从 events_statements_history_long 取最近 minutes 分钟内的 SQL 实际执行聚合
    - 写到临时文件 logs/recent_cmds_{session_id}.json（按 cmd_type 分类存放）
    """
    try:
        cdata = _normalize_conn_data(conn_info)
        url = cdata.get("url") or ""
        if not url:
            host = cdata.get("host", "127.0.0.1")
            port = cdata.get("port", 3306)
            user = cdata.get("user", "root")
            password = cdata.get("password", "")
            db = cdata.get("database", "")
            pwd = quote_plus(password) if password else ""
            url = f"mysql+pymysql://{user}:{pwd}@{host}:{port}/{db}?charset=utf8mb4"

        engine = create_engine(url, pool_pre_ping=True,
                               connect_args={"connect_timeout": 10})
        with engine.connect() as conn:
            type_sql = {
                'SELECT': 'SELECT%',
                'INSERT': 'INSERT%',
                'UPDATE': 'UPDATE%',
                'DELETE': 'DELETE%',
            }.get(cmd_type.upper(), '%')
            try:
                conn.execute(text(
                    "UPDATE performance_schema.setup_consumers SET ENABLED='YES' "
                    "WHERE NAME='events_statements_history_long'"
                ))
                conn.execute(text(
                    "SET GLOBAL performance_schema_events_statements_history_long_size = 100000"
                ))
            except Exception:
                pass

            schema_filter = ""
            if db:
                schema_filter = "AND (SC.SCHEMA_NAME = :db OR SC.SCHEMA_NAME IS NULL)"
            # ★ 排除 MySQL 连接时自动跑的 system 查询（避免污染真实业务 SQL 视图）
            #    只过滤 DIGEST_TEXT 模式，不依赖 SC.EVENT_NAME（summary_by_digest 表没有该列）
            system_filter = """
                AND SC.DIGEST_TEXT NOT LIKE 'SELECT @@%'
                AND SC.DIGEST_TEXT NOT LIKE 'SET @@%'
                AND SC.DIGEST_TEXT NOT LIKE 'SET CHARACTER%'
                AND SC.DIGEST_TEXT NOT LIKE 'SET NAMES %'
                AND SC.DIGEST_TEXT NOT LIKE 'SET SESSION%'
                AND SC.DIGEST_TEXT NOT LIKE 'SET autocommit%'
                AND SC.DIGEST_TEXT NOT LIKE 'SHOW %'
                AND SC.DIGEST_TEXT NOT LIKE 'USE %'
            """
            time_filter = """
                AND HL.TIMER_END >= (
                    SELECT MAX(TIMER_END) - (:minutes * 60 * 1000000000000)
                    FROM performance_schema.events_statements_history_long
                    WHERE DIGEST_TEXT LIKE :type_pattern2
                      AND DIGEST_TEXT IS NOT NULL
                )
            """
            sql = text(f"""
                SELECT
                    SUBSTRING(SC.DIGEST_TEXT, 1, 500) AS sql_text,
                    COUNT(*) AS exec_count,
                    ROUND(SUM(HL.TIMER_WAIT)/1000000, 2) AS total_ms,
                    ROUND(AVG(HL.TIMER_WAIT)/1000000, 2) AS avg_ms,
                    SUM(HL.ROWS_EXAMINED) AS rows_examined,
                    SUM(HL.ROWS_SENT) AS rows_sent
                FROM performance_schema.events_statements_history_long HL
                JOIN performance_schema.events_statements_summary_by_digest SC
                  ON HL.DIGEST = SC.DIGEST
                WHERE SC.DIGEST_TEXT LIKE :type_pattern
                  AND SC.DIGEST_TEXT IS NOT NULL
                  AND SC.SCHEMA_NAME NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
                  {schema_filter}
                  {system_filter}
                  {time_filter}
                GROUP BY SC.DIGEST_TEXT
                ORDER BY exec_count DESC
                LIMIT :top_n
            """)
            result = conn.execute(sql, {
                "type_pattern": type_sql,
                "type_pattern2": type_sql,
                "minutes": max(1, minutes),
                "top_n": top_n,
                **({"db": db} if db else {})
            })
            raw_rows = [dict(zip(list(result.keys()), r)) for r in result.fetchall()]
        engine.dispose()

        rows = []
        for r in raw_rows:
            total_ms = float(r.get('total_ms') or 0)
            avg_ms = float(r.get('avg_ms') or 0)
            rows.append({
                "sql_text": r["sql_text"],
                "cmd_type": cmd_type.upper(),
                "exec_count": int(r.get('exec_count') or 0),
                "total_s": round(total_ms / 1000.0, 2),
                "avg_s": round(avg_ms / 1000.0, 4),
                "rows_examined": int(r.get('rows_examined') or 0),
                "rows_sent": int(r.get('rows_sent') or 0),
            })

        # ★ 写到临时文件（按 cmd_type 分别存放），文件级锁防并发损坏
        fp = _tmp_path(session_id)
        # ★ 获取/创建该文件的锁
        with _FILE_LOCKS_LOCK:
            lock = _FILE_LOCKS.setdefault(fp, threading.Lock())
        with lock:
            try:
                if os.path.exists(fp):
                    with open(fp, 'r', encoding='utf-8') as f:
                        all_data = json.load(f)
                else:
                    all_data = {"captured_at": "", "rows_by_type": {}}
            except Exception:
                all_data = {"captured_at": "", "rows_by_type": {}}
            all_data.setdefault("rows_by_type", {})
            all_data["rows_by_type"][cmd_type.upper()] = rows
            all_data["captured_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            with open(fp, 'w', encoding='utf-8') as f:
                json.dump(all_data, f, ensure_ascii=False, indent=2)
        return {"ok": True, "rows": rows, "note": f"已写入 {fp}"}
    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "msg": str(e)}


@eel.expose
def dashboard_read_recent_cmds(session_id='', cmd_type=''):
    """
    面板打开/点击刷新时调用：只读临时文件，不查 DB
    cmd_type 为空 → 返回全部 cmd_type 的合并数据
    """
    fp = _tmp_path(session_id)
    if not os.path.exists(fp):
        return {"ok": True, "captured_at": "", "rows": [],
                "note": "尚无数据（请打开监控面板，让图表刷新一次后再来看）"}
    # ★ 与 capture 共用同一把锁，防止读半截的脏数据
    with _FILE_LOCKS_LOCK:
        lock = _FILE_LOCKS.setdefault(fp, threading.Lock())
    try:
        with lock:
            with open(fp, 'r', encoding='utf-8') as f:
                data = json.load(f)
    except json.JSONDecodeError:
        try: os.remove(fp)
        except Exception: pass
        return {"ok": True, "captured_at": "", "rows": [],
                "note": "文件已损坏，已自动删除，等待下次图表刷新写入新数据"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
    # ✅ 正常解析成功后的数据处理（必须在 except 块之外）
    if cmd_type:
        rows = data.get('rows_by_type', {}).get(cmd_type.upper(), [])
    else:
        rows = []
        for ct, rs in data.get('rows_by_type', {}).items():
            for r in rs:
                rows.append({**r, 'cmd_type': ct})
    return {
        "ok": True,
        "captured_at": data.get("captured_at", ""),
        "rows": rows,
        "note": f"读取自 {fp}"
    }


@eel.expose
def dashboard_reset_recent_cmds(session_id=''):
    """点击「重置」时调用：删除临时文件"""
    fp = _tmp_path(session_id)
    try:
        if os.path.exists(fp):
            os.remove(fp)
        return {"ok": True, "msg": f"已清空 {fp}"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
