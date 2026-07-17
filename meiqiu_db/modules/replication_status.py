"""
MySQL 主从复制状态监控
查询 SHOW SLAVE STATUS，返回主从延迟、同步进度、binlog/relaylog 位置等关键信息
"""
import eel
import traceback
from urllib.parse import quote_plus
from sqlalchemy import create_engine, text


@eel.expose
def replication_get_status(conn_info):
    """
    查询 MySQL 主从复制状态
    返回 slave_status 字典（若为空则不是从库）和 channel 列表（多源复制）
    """
    try:
        url = conn_info.get("url") or conn_info.get("conn_url") or ""
        if not url:
            db_type = conn_info.get("db_type", "mysql")
            host = conn_info.get("host", "127.0.0.1")
            port = conn_info.get("port", 3306)
            user = conn_info.get("user", "root")
            password = conn_info.get("password", "")
            db = conn_info.get("database", "")
            if db_type in ("mysql", "ob-mysql"):
                pwd = quote_plus(password) if password else ""
                url = f"mysql+pymysql://{user}:{pwd}@{host}:{port}/{db}?charset=utf8mb4"
            else:
                return {"ok": False, "msg": "当前连接类型不支持主从监控（仅支持 MySQL/OceanBase）"}

        engine = create_engine(url, pool_pre_ping=True,
                               connect_args={"connect_timeout": 10})
        with engine.connect() as conn:
            conn.execute(text("COMMIT"))

            slave_rows, slave_keys = [], []
            master_rows, master_keys = [], []
            is_slave = False
            is_master = False

            # 1) 尝试查询从库状态
            try:
                result = conn.execute(text("SHOW SLAVE STATUS"))
                slave_rows = result.fetchall()
                slave_keys = list(result.keys())
                is_slave = len(slave_rows) > 0
            except Exception:
                pass

            # 2) 查询主库状态（SHOW MASTER STATUS）
            try:
                result = conn.execute(text("SHOW MASTER STATUS"))
                master_rows = result.fetchall()
                master_keys = list(result.keys())
                is_master = len(master_rows) > 0
            except Exception:
                pass

            if not is_slave and not is_master:
                return {"ok": True, "is_slave": False, "is_master": False,
                        "msg": "当前实例既不是主库也不是从库"}

            # 构建从库 channels
            slave_channels = []
            for row in slave_rows:
                slave_channels.append(dict(zip(slave_keys, row)))

            # 构建主库信息
            master_info = {}
            if master_rows:
                master_info = dict(zip(master_keys, master_rows[0]))

            engine.dispose()
            return {
                "ok": True,
                "is_slave": is_slave,
                "is_master": is_master,
                "channels": slave_channels,
                "master": master_info,
            }

    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "msg": str(e)}
