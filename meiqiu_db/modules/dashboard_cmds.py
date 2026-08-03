"""
仪表盘最近 SQL 命令捕获（快照历史 + 时间窗口增量）

设计：
- 数据源：performance_schema.events_statements_summary_by_digest（累计计数表）
- 快照历史：从连接仪表盘那一刻起（dashboard_capture_baseline），后端定期保存
  COUNT_STAR 快照到内存（_SNAP_HISTORY），每类命令一条时间线
- 查询"最近 N 分钟"：当前累计值 - N 分钟前最近的一份快照 = 窗口内的真实增量
  若历史不足 N 分钟（刚连接），则用最早的快照 → 等价于"从连接时刻起累计"
- dashboard_capture_top_cmds：每次图表刷新时调用，计算窗口增量并写临时文件
- dashboard_read_recent_cmds：面板打开/刷新时调用，只读文件，不查 DB
- dashboard_reset_recent_cmds：点击「重置计数基准」时调用，清空快照历史重新开始
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

# ★ 快照历史：{session_id: {cmd_type: [(timestamp, {digest: (count, timer, examined, sent)}), ...]}}
#   - 第一份快照在连接仪表盘时捕获（dashboard_capture_baseline）
#   - 之后间隔 >= _SNAP_MIN_INTERVAL 秒追加一份（dashboard_capture_top_cmds 内）
#   - 只保留最近 _HISTORY_KEEP_SEC 秒的快照
_SNAP_HISTORY = {}
_SNAP_HISTORY_LOCK = threading.Lock()
_SNAP_MIN_INTERVAL = 50        # 快照最小间隔（秒），控制内存占用
_HISTORY_KEEP_SEC = 35 * 60    # 快照最长保留 35 分钟（支持最大 30 分钟窗口）

# ★ 系统查询过滤（DIGEST_TEXT 中标识符带反引号，需两种写法都排除）
_SYSTEM_FILTER = """
    AND DIGEST_TEXT NOT LIKE 'SELECT @@%'
    AND DIGEST_TEXT NOT LIKE 'SELECT VERSION%'
    AND DIGEST_TEXT NOT LIKE 'SELECT `VERSION`%'
    AND DIGEST_TEXT NOT LIKE 'SELECT SCHEMA%'
    AND DIGEST_TEXT NOT LIKE 'SELECT `SCHEMA`%'
    AND DIGEST_TEXT NOT LIKE 'SELECT DATABASE%'
    AND DIGEST_TEXT NOT LIKE 'SELECT `DATABASE`%'
    AND DIGEST_TEXT NOT LIKE 'SELECT CAST%'
    AND DIGEST_TEXT NOT LIKE 'SELECT `CAST`%'
    AND DIGEST_TEXT NOT LIKE '%COLLATION_NAME%'
    AND DIGEST_TEXT NOT LIKE '%CHARACTER_SET_NAME%'
    AND DIGEST_TEXT NOT LIKE 'SET @@%'
    AND DIGEST_TEXT NOT LIKE 'SET CHARACTER%'
    AND DIGEST_TEXT NOT LIKE 'SET NAMES %'
    AND DIGEST_TEXT NOT LIKE 'SET SESSION%'
    AND DIGEST_TEXT NOT LIKE 'SET autocommit%'
    AND DIGEST_TEXT NOT LIKE 'SHOW %'
    AND DIGEST_TEXT NOT LIKE 'USE %'
"""


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


def _build_url(cdata: dict) -> str:
    """根据连接参数拼接 SQLAlchemy URL"""
    url = cdata.get("url") or ""
    if not url:
        host = cdata.get("host", "127.0.0.1")
        port = cdata.get("port", 3306)
        user = cdata.get("user", "root")
        password = cdata.get("password", "")
        db = cdata.get("database", "")
        pwd = quote_plus(password) if password else ""
        url = f"mysql+pymysql://{user}:{pwd}@{host}:{port}/{db}?charset=utf8mb4"
    return url


def _tmp_path(session_id):
    """根据 session id 生成临时文件路径"""
    safe = ''.join(c if c.isalnum() else '_' for c in (session_id or 'global'))[:64] or 'global'
    return os.path.join(_TMP_DIR, f'recent_cmds_{safe}.json')


def clean_recent_cmds_tmp():
    """应用退出时调用：清理所有临时文件 + 快照历史"""
    try:
        for f in os.listdir(_TMP_DIR):
            if f.startswith('recent_cmds_') and f.endswith('.json'):
                try:
                    os.remove(os.path.join(_TMP_DIR, f))
                except Exception:
                    pass
    except Exception:
        pass
    with _SNAP_HISTORY_LOCK:
        _SNAP_HISTORY.clear()


def _query_digest_state(conn, type_sql, db, with_text=False):
    """
    查询 summary_by_digest 当前累计状态
    返回 {digest: (count, timer, examined, sent)}；
    with_text=True 时返回 {digest: (count, timer, examined, sent, sql_text)}
    """
    schema_filter = "AND SCHEMA_NAME = :db" if db else ""
    text_col = ", SUBSTRING(DIGEST_TEXT, 1, 500)" if with_text else ""
    sql = text(f"""
        SELECT DIGEST,
               COUNT_STAR, IFNULL(SUM_TIMER_WAIT, 0),
               IFNULL(SUM_ROWS_EXAMINED, 0), IFNULL(SUM_ROWS_SENT, 0)
               {text_col}
        FROM performance_schema.events_statements_summary_by_digest
        WHERE DIGEST_TEXT LIKE :type_pattern
          AND DIGEST_TEXT IS NOT NULL
          AND SCHEMA_NAME NOT IN ('mysql','sys','performance_schema','information_schema')
          {schema_filter}
          {_SYSTEM_FILTER}
        LIMIT 50000
    """)
    result = conn.execute(sql, {
        "type_pattern": type_sql,
        **({"db": db} if db else {})
    })
    state = {}
    for r in result.fetchall():
        if with_text:
            state[r[0]] = (int(r[1] or 0), int(r[2] or 0), int(r[3] or 0), int(r[4] or 0), r[5])
        else:
            state[r[0]] = (int(r[1] or 0), int(r[2] or 0), int(r[3] or 0), int(r[4] or 0))
    return state


def _append_snapshot(session_id, cmd_type, state, now=None, force=False):
    """
    追加一份快照到历史（间隔不足 _SNAP_MIN_INTERVAL 秒则跳过，除非 force）
    state 中若带 sql_text（5元组）会被裁剪为 4 元组以节省内存
    """
    now = now or time.time()
    slim = {}
    for k, v in state.items():
        slim[k] = (v[0], v[1], v[2], v[3])
    with _SNAP_HISTORY_LOCK:
        hist = _SNAP_HISTORY.setdefault(session_id, {}).setdefault(cmd_type, [])
        if hist and not force and (now - hist[-1][0]) < _SNAP_MIN_INTERVAL:
            return hist
        hist.append((now, slim))
        # 清理过期快照（始终保留至少 1 份最早的做兜底）
        while len(hist) > 2 and (now - hist[0][0]) > _HISTORY_KEEP_SEC:
            hist.pop(0)
        return hist


def _pick_baseline(session_id, cmd_type, minutes, now=None):
    """
    选取时间窗口对应的基线快照：
    - 找 "now - minutes 分钟" 之前最近的一份快照
    - 若历史不足（刚连接），返回最早的快照 → 等价于从连接时刻起累计
    - 无任何历史时返回 None
    """
    now = now or time.time()
    target_ts = now - minutes * 60
    with _SNAP_HISTORY_LOCK:
        hist = _SNAP_HISTORY.get(session_id, {}).get(cmd_type, [])
        if not hist:
            return None
        baseline = hist[0][1]
        for ts, st in hist:
            if ts <= target_ts:
                baseline = st
            else:
                break
        return baseline


@eel.expose
def dashboard_capture_top_cmds(conn_info, session_id='', cmd_type='DELETE', minutes=1, top_n=20):
    """
    每次图表刷新 / 面板操作时调用：
    - 查询 summary_by_digest 当前累计值，追加快照到历史
    - 计算 "最近 minutes 分钟" 的窗口增量（当前值 - 窗口起点快照）
    - 写到临时文件 logs/recent_cmds_{session_id}.json（按 cmd_type 分类存放）
    """
    try:
        cdata = _normalize_conn_data(conn_info)
        url = _build_url(cdata)
        db = cdata.get("database", "")
        ct = cmd_type.upper()
        type_sql = {
            'SELECT': 'SELECT%',
            'INSERT': 'INSERT%',
            'UPDATE': 'UPDATE%',
            'DELETE': 'DELETE%',
        }.get(ct, '%')

        engine = create_engine(url, pool_pre_ping=True,
                               connect_args={"connect_timeout": 10})
        with engine.connect() as conn:
            # ★ 确保 performance_schema 消费者已启用
            try:
                conn.execute(text(
                    "UPDATE performance_schema.setup_consumers SET ENABLED='YES' "
                    "WHERE NAME='events_statements_summary_by_digest'"
                ))
            except Exception:
                pass

            # ★ 查询当前累计状态（带 SQL 文本）
            now = time.time()
            cur_state = _query_digest_state(conn, type_sql, db, with_text=True)
        engine.dispose()

        # ★ 选基线（必须在追加本次快照之前选，避免拿到刚追加的自己）
        baseline = _pick_baseline(session_id, ct, max(1, int(minutes or 1)), now=now)
        # ★ 追加本次快照到历史
        _append_snapshot(session_id, ct, cur_state, now=now)

        raw_rows = []
        if baseline is not None:
            for digest_key, cur in cur_state.items():
                cur_count, cur_timer, cur_examined, cur_sent = cur[0], cur[1], cur[2], cur[3]
                sql_text_val = cur[4] if len(cur) > 4 else ''
                b = baseline.get(digest_key, (0, 0, 0, 0))
                d_count = cur_count - b[0]
                d_timer = cur_timer - b[1]
                d_examined = cur_examined - b[2]
                d_sent = cur_sent - b[3]
                if d_count <= 0:
                    continue  # 窗口内没有新执行（或 digest 被驱逐后计数回退）
                avg_ps = d_timer / d_count if d_count > 0 else 0
                raw_rows.append({
                    'sql_text': sql_text_val,
                    'exec_count': d_count,
                    'total_ms': round(d_timer / 1000000000.0, 2),
                    'avg_ms': round(avg_ps / 1000000000.0, 2),
                    'rows_examined': d_examined,
                    'rows_sent': d_sent,
                })
            raw_rows.sort(key=lambda x: x['exec_count'], reverse=True)
            raw_rows = raw_rows[:top_n]
        # baseline is None → 第一次调用（连接后首次），刚建立快照，增量为 0

        rows = []
        for r in raw_rows:
            total_ms = float(r.get('total_ms') or 0)
            avg_ms = float(r.get('avg_ms') or 0)
            rows.append({
                "sql_text": r["sql_text"],
                "cmd_type": ct,
                "exec_count": int(r.get('exec_count') or 0),
                "total_s": round(total_ms / 1000.0, 2),
                "avg_s": round(avg_ms / 1000.0, 4),
                "rows_examined": int(r.get('rows_examined') or 0),
                "rows_sent": int(r.get('rows_sent') or 0),
            })

        # ★ 写到临时文件（按 cmd_type + minutes 分别存放），文件级锁防并发损坏
        fp = _tmp_path(session_id)
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
            all_data["rows_by_type"][ct] = rows
            all_data.setdefault("minutes_by_type", {})
            all_data["minutes_by_type"][ct] = max(1, int(minutes or 1))
            all_data["captured_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            with open(fp, 'w', encoding='utf-8') as f:
                json.dump(all_data, f, ensure_ascii=False, indent=2)
        return {"ok": True, "rows": rows, "note": f"已写入 {fp}"}
    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "msg": str(e)}


@eel.expose
def dashboard_capture_baseline(session_id='', conn_info=None):
    """
    连接仪表盘时调用：对 4 种 cmd_type 各拍一份初始快照（快照历史的起点）
    之后所有"最近 N 分钟"的增量都以快照历史为基准，从连接时刻起累计
    """
    try:
        if not conn_info:
            return {"ok": False, "msg": "缺少连接信息"}
        cdata = _normalize_conn_data(conn_info)
        url = _build_url(cdata)
        db = cdata.get("database", "")

        engine = create_engine(url, pool_pre_ping=True,
                               connect_args={"connect_timeout": 10})
        with engine.connect() as conn:
            # 启用 summary_by_digest 消费者
            try:
                conn.execute(text(
                    "UPDATE performance_schema.setup_consumers SET ENABLED='YES' "
                    "WHERE NAME='events_statements_summary_by_digest'"
                ))
            except Exception:
                pass

            # ★ 对 4 种 cmd_type 分别拍初始快照（若该类型已有历史则跳过，避免重复清零）
            now = time.time()
            captured = 0
            for ct in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'):
                with _SNAP_HISTORY_LOCK:
                    has_hist = bool(_SNAP_HISTORY.get(session_id, {}).get(ct))
                if has_hist:
                    continue
                try:
                    state = _query_digest_state(conn, ct + '%', db, with_text=False)
                    _append_snapshot(session_id, ct, state, now=now, force=True)
                    captured += 1
                except Exception:
                    pass
        engine.dispose()
        return {"ok": True, "msg": f"初始快照已捕获 ({captured} 种类型)"}
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
def dashboard_reset_recent_cmds(session_id='', conn_info=None):
    """点击「重置计数基准」时调用：删除临时文件 + 清空快照历史（重新从当前时刻开始累计）"""
    fp = _tmp_path(session_id)
    try:
        if os.path.exists(fp):
            os.remove(fp)
        # ★ 清空该会话的快照历史
        with _SNAP_HISTORY_LOCK:
            _SNAP_HISTORY.pop(session_id, None)
        # ★ 立即重建初始快照（从当前时刻重新开始累计）
        if conn_info:
            result = dashboard_capture_baseline(session_id, conn_info)
            msg = result.get('msg', '')
        else:
            msg = ''
        return {"ok": True, "msg": f"已清空 {fp}，快照历史已重置。{msg}"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
