"""
Eel 暴露接口：配置管理、传输、SQL 查询
"""
import eel
import threading
import time
from urllib.parse import quote_plus
from sqlalchemy import text, create_engine
from modules import _progress_q, _engine, _worker, _query_cancel, _query_columns, _query_rows, _query_conn_id, _query_src_data
from modules.conn_utils import _connect_args, _conn_url, _friendly_error
from modules.config_state import ProfileManager
from modules.serializers import _json_safe, _row_to_json, _detect_table_from_sql, _rows_to_dicts
from modules.transfer_engine import TransferEngine

@eel.expose
def get_profiles():
    """获取所有配置列表"""
    return ProfileManager.load_all()


@eel.expose
def get_last_used():
    """获取上次使用的配置名"""
    return ProfileManager.get_last_used()


@eel.expose
def save_profile(data: dict, name: str):
    """保存配置"""
    data["name"] = name
    ProfileManager.save(data)
    ProfileManager.set_last_used(name)
    return True


@eel.expose
def delete_profile(name: str):
    """删除配置"""
    ProfileManager.delete(name)
    return True


@eel.expose
def find_profile(name: str):
    """查找配置"""
    return ProfileManager.find(name)


@eel.expose
def test_connection(data: dict, side: str):
    """测试连接"""
    try:
        if side == "src":
            src_db = data.get('src_db', '').strip()
            if src_db:
                url = (f"mysql+pymysql://{quote_plus(data['src_user'])}:"
                       f"{quote_plus(data['src_pwd'])}@{data['src_host']}:"
                       f"{data['src_port']}/{src_db}?charset=utf8mb4")
            else:
                # 不指定数据库，仅测试服务器连通性
                url = (f"mysql+pymysql://{quote_plus(data['src_user'])}:"
                       f"{quote_plus(data['src_pwd'])}@{data['src_host']}:"
                       f"{data['src_port']}/?charset=utf8mb4")
            label = "源库"
            engine = create_engine(url, connect_args=_connect_args("mysql", timeout=5))
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            engine.dispose()
            return {"ok": True, "msg": f"{label}连接成功！"}
        else:
            # 目标库：先连服务器，再检查数据库是否存在
            label = "目标库"
            url_no_db = (f"mysql+pymysql://{quote_plus(data['dst_user'])}:"
                         f"{quote_plus(data['dst_pwd'])}@{data['dst_host']}:"
                         f"{data['dst_port']}?charset=utf8mb4")
            engine = create_engine(url_no_db, connect_args=_connect_args("mysql", timeout=5))
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
                db_name = data.get('dst_db', '').strip()
                if db_name:
                    result = conn.execute(
                        text(f"SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA "
                             f"WHERE SCHEMA_NAME = :db"), {"db": db_name}
                    )
                    if not result.fetchone():
                        engine.dispose()
                        return {"ok": False,
                                "msg": f"服务器可连接，但数据库 [{db_name}] 不存在"}
            engine.dispose()
            return {"ok": True, "msg": f"{label}连接成功！"}
    except Exception as e:
        return {"ok": False, "msg": f"{label}连接失败: {str(e)}"}


@eel.expose
def start_transfer(data: dict):
    """开始传输"""
    global _engine, _worker
    _progress_q.queue.clear()

    _engine = TransferEngine(data)
    _worker = threading.Thread(target=_engine.run, daemon=True)
    _worker.start()
    return True


@eel.expose
def stop_transfer():
    """停止传输"""
    global _engine
    if _engine:
        _engine.stop()
    return True


@eel.expose
def poll_queue():
    """前端轮询：获取所有待处理的进度消息"""
    msgs = []
    while not _progress_q.empty():
        try:
            msgs.append(_progress_q.get_nowait())
        except queue.Empty:
            break
    return msgs


@eel.expose
def execute_sql_query(sql: str, data: dict):
    """执行 SQL 查询"""
    global _query_columns, _query_rows, _query_conn_id, _query_src_data
    _query_cancel.clear()
    _query_conn_id = None
    _query_src_data = data  # 保存源库信息用于 cancel 时 kill

    try:
        # 兼容两种数据格式：{host,user,pwd} 和 {src_host,src_user,src_pwd}
        if "user" not in data:
            data = {
                "host": data.get("src_host", ""), "port": data.get("src_port", "3306"),
                "user": data.get("src_user", ""), "pwd": data.get("src_pwd", ""),
                "db": data.get("src_db", ""), "db_type": data.get("db_type", "mysql")
            }
        db_type = data.get("db_type", "mysql")
        url = _conn_url(data)
        if db_type in ('mysql', 'ob-mysql'):
            url = url.replace("?charset=utf8mb4", "?charset=utf8mb4&read_timeout=30") if "?" in url else url + "?charset=utf8mb4&read_timeout=30"
        engine = create_engine(url, connect_args=_connect_args(db_type, timeout=10))
        comments = {}
        col_types = {}
        with engine.connect() as conn:
            if _query_cancel.is_set():
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            # 记录连接 ID，用于 cancel 时 kill query
            try:
                _query_conn_id = conn.execute(text("SELECT CONNECTION_ID()")).scalar()
            except Exception:
                pass
            try:
                conn.execute(text("SET SESSION MAX_EXECUTION_TIME = 30000"))
            except Exception:
                pass
            result = conn.execute(text(sql))
            if _query_cancel.is_set():
                return {"ok": False, "msg": "查询已取消", "cancelled": True}
            if result.returns_rows:
                _query_columns = list(result.keys())
                _query_rows = [list(row) for row in result.fetchall()]
                table_name = _detect_table_from_sql(sql)
                if table_name:
                    try:
                        comments = _load_column_comments(conn, db_type, data.get("db", ""), table_name, "")
                        col_types = _load_column_types(conn, db_type, data.get("db", ""), table_name, "")
                    except Exception:
                        comments = {}
                        col_types = {}
            else:
                # INSERT/UPDATE/DELETE 等写入操作：提交并返回影响行数
                conn.commit()
                rc = result.rowcount
        engine.dispose()
        # 写入操作提前返回（无需序列化行数据）
        if not result.returns_rows:
            return {"ok": True, "msg": f"成功执行，影响 {rc} 行", "columns": [], "rows": [], "total": rc}

        if _query_cancel.is_set():
            return {"ok": False, "msg": "查询已取消", "cancelled": True}
        # 返回前 JSON 化（datetime/Decimal 转字符串）
        safe_rows = [_row_to_json(r) for r in _query_rows[:200]]
        return {
            "ok": True,
            "columns": _query_columns,
            "rows": safe_rows,
            "total": len(_query_rows),
            "comments": comments,
            "col_types": col_types
        }
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, data.get('db_type','mysql'))}



@eel.expose
def clear_cancel():
    """清除取消标记（新操作开始前调用）"""
    _query_cancel.clear()
    # ★ 同时清除主模块的取消标记
    try:
        import __main__
        if hasattr(__main__, '_query_cancel'):
            __main__._query_cancel.clear()
    except Exception:
        pass
    return True

@eel.expose
def cancel_query():
    """取消所有查询 — 设置全局取消标记"""
    _query_cancel.set()
    # ★ 同时设置主模块的取消标记（确保主模块函数也能感知到）
    try:
        import __main__
        if hasattr(__main__, '_query_cancel'):
            __main__._query_cancel.set()
    except Exception:
        pass
    return True




