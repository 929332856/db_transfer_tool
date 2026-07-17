"""
Flask 应用工厂 + PyWebView 桌面窗口
替代 Eel 框架，解决：
1. 多连接测试互相阻塞（Flask 多线程天然支持并发）
2. 关闭窗口残留进程（PyWebView 用系统 WebView，关闭即清理）
"""
import os, sys, json, threading, time
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

# ★ 路径设置（兼容 PyInstaller）
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR  = os.path.join(BASE_DIR, "web")

def create_app():
    app = Flask(__name__, static_folder=WEB_DIR, static_url_path='')
    CORS(app)

    # ★ 主页
    @app.route('/')
    def index():
        return send_from_directory(WEB_DIR, 'index.html')

    # ★ 健康检查
    @app.route('/api/ping')
    def health_check():
        return jsonify({"ok": True, "msg": "pong"})

    # ★ 异步任务管理（替代 Eel 的 _query_jobs + poll_query_result）
    app.config['ASYNC_JOBS'] = {}
    app.config['ASYNC_LOCK'] = threading.Lock()

    @app.route('/api/poll/<job_id>')
    def poll_job(job_id):
        jobs = app.config['ASYNC_JOBS']
        with app.config['ASYNC_LOCK']:
            result = jobs.get(job_id)
        if result is None:
            return jsonify({"_pending": True})
        # 结果就绪，清理
        with app.config['ASYNC_LOCK']:
            jobs.pop(job_id, None)
        return jsonify(result)

    # 注册所有业务路由
    from app.routes import register_routes
    register_routes(app)

    return app


def _run_flask(app, port):
    """在独立线程中运行 Flask（不阻塞主线程）"""
    from waitress import serve
    serve(app, host='127.0.0.1', port=port, threads=10)


def start_webview(port):
    """启动 PyWebView 桌面窗口"""
    import webview
    # 等 Flask 就绪
    import urllib.request
    for _ in range(30):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.5)
            break
        except Exception:
            time.sleep(0.3)
    # ★ 窗口图标：mqdb.ico（Windows 任务栏/标题栏图标）
    ico_path = os.path.join(WEB_DIR, 'mqdb.ico')
    icon_path = ico_path if os.path.isfile(ico_path) else None
    window = webview.create_window(
        "MQDB",
        f"http://127.0.0.1:{port}",
        width=1280,
        height=860,
        resizable=True,
        min_size=(900, 600),
        **({'icon': icon_path} if icon_path else {}),
    )
    webview.start()
    # 窗口关闭后清理
    print("[app] 窗口已关闭，清理中...")
    os._exit(0)


def main():
    """主入口"""
    import socket

    # 找一个空闲端口
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()

    app = create_app()

    # Flask 在独立线程运行
    flask_thread = threading.Thread(target=_run_flask, args=(app, port), daemon=True)
    flask_thread.start()

    # PyWebView 在主线程运行（macOS 要求）
    start_webview(port)
