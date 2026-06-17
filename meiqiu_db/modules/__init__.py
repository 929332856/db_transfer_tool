"""
数据库高速传输工具 — 模块化拆分
共享状态和全局变量
"""
import queue
import threading
import os
import sys

# ===== 必须在所有 import 之前：gevent 猴子补丁 =====
from gevent import monkey
monkey.patch_all(thread=False)

# ==================== 配置路径 ====================
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
PROFILES_FILE = os.path.join(BASE_DIR, "db_profiles.json")

# ==================== 全局状态 ====================
_progress_q = queue.Queue()
_engine = None
_worker = None
_query_cancel = threading.Event()
_query_columns = []
_query_rows = []
_query_conn_id = None       # 当前查询的数据库连接 ID（用于 kill）
_query_src_data = None       # 当前查询的源库连接信息


