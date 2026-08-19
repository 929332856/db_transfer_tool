"""
Flask 应用工厂 + PyWebView 桌面窗口
替代 Eel 框架，解决：
1. 多连接测试互相阻塞（Flask 多线程天然支持并发）
2. 关闭窗口残留进程（PyWebView 用系统 WebView，关闭即清理）
"""
import os, sys, json, threading, time, secrets
from urllib.parse import quote
from flask import Flask, request, jsonify, send_from_directory

# ★ 路径设置（兼容 PyInstaller）
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR  = os.path.join(BASE_DIR, "web")


def _async_job_reaper(app):
    """统一处理异步任务超时和 TTL 回收，避免每个请求创建 watchdog 线程。"""
    while True:
        time.sleep(2)
        now = time.time()
        with app.config['ASYNC_LOCK']:
            jobs = app.config['ASYNC_JOBS']
            meta_map = app.config['ASYNC_JOB_META']
            for job_id, meta in list(meta_map.items()):
                result = jobs.get(job_id)
                deadline = meta.get('deadline')
                if result is None and deadline and now >= deadline:
                    # Do not turn a still-running worker into a fake failure.
                    # Python threads cannot be safely cancelled; long DDL must
                    # remain pending until the worker publishes its real result.
                    meta['overdue'] = True
                    continue
                elif result is not None and now - meta.get('updated_at', now) > app.config['ASYNC_JOB_TTL']:
                    jobs.pop(job_id, None)
                    meta_map.pop(job_id, None)

def create_app():
    app = Flask(__name__, static_folder=WEB_DIR, static_url_path='')
    # API 仅供本应用自己的 WebView 使用。随机 token 通过 HttpOnly、
    # SameSite cookie 下发，避免本机其他网页无门槛调用危险接口。
    app.config['API_TOKEN'] = secrets.token_urlsafe(32)
    app.config['ASYNC_JOB_TTL'] = 300

    @app.before_request
    def require_api_token():
        if not request.path.startswith('/api/') or request.path == '/api/ping':
            return None
        supplied = request.headers.get('X-MQDB-Token') or request.cookies.get('mqdb_api_token')
        if not supplied or not secrets.compare_digest(supplied, app.config['API_TOKEN']):
            return jsonify({"ok": False, "msg": "未授权请求"}), 401
        return None

    # ★ 主页
    @app.route('/')
    def index():
        response = send_from_directory(WEB_DIR, 'index.html')
        response.set_cookie(
            'mqdb_api_token', app.config['API_TOKEN'],
            httponly=True, samesite='Strict', secure=False,
        )
        return response

    # ★ 健康检查
    @app.route('/api/ping')
    def health_check():
        return jsonify({"ok": True, "msg": "pong"})

    # ★ 异步任务管理（替代 Eel 的 _query_jobs + poll_query_result）
    app.config['ASYNC_JOBS'] = {}
    app.config['ASYNC_LOCK'] = threading.Lock()
    app.config['ASYNC_JOB_META'] = {}
    threading.Thread(target=_async_job_reaper, args=(app,), daemon=True).start()

    @app.route('/api/poll/<job_id>')
    def poll_job(job_id):
        jobs = app.config['ASYNC_JOBS']
        now = time.time()
        with app.config['ASYNC_LOCK']:
            for stale_id, meta in list(app.config['ASYNC_JOB_META'].items()):
                if now - meta.get('updated_at', meta.get('created_at', now)) > app.config['ASYNC_JOB_TTL']:
                    jobs.pop(stale_id, None)
                    app.config['ASYNC_JOB_META'].pop(stale_id, None)
            result = jobs.get(job_id)
            if job_id in app.config['ASYNC_JOB_META']:
                app.config['ASYNC_JOB_META'][job_id]['updated_at'] = now
        if result is None:
            return jsonify({"_pending": True})
        # 结果就绪，清理
        with app.config['ASYNC_LOCK']:
            jobs.pop(job_id, None)
            app.config['ASYNC_JOB_META'].pop(job_id, None)
        return jsonify(result)

    # 注册所有业务路由
    from app.routes import register_routes
    register_routes(app)

    return app


def _get_startup_theme():
    """读取启动时主题，供原生窗口和页面首帧同时使用。"""
    try:
        settings_dir = os.path.dirname(os.path.dirname(__file__))
        if getattr(sys, 'frozen', False):
            settings_dir = os.path.dirname(sys.executable)
        settings_path = os.path.join(settings_dir, "mqdb_settings.json")
        if not os.path.exists(settings_path):
            settings_path = os.path.join(settings_dir, "settings.json")
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
        if isinstance(settings, dict) and settings.get("theme") == "light":
            return "light"
    except Exception:
        pass
    return "dark"


def _get_startup_background_color():
    """返回与用户主题一致的原生窗口底色，避免 WebView 首帧闪黑。"""
    return "#f5f6fa" if _get_startup_theme() == "light" else "#1e1e2e"


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
    theme = _get_startup_theme()
    window = webview.create_window(
        "MQDB",
        f"http://127.0.0.1:{port}/?theme={quote(theme)}",
        width=1280,
        height=860,
        resizable=True,
        min_size=(900, 600),
        background_color=_get_startup_background_color(),
        **({'icon': icon_path} if icon_path else {}),
    )
    webview.start()
    # 窗口关闭后清理
    print("[app] 窗口已关闭，清理中...")
    try:
        from modules.dashboard_cmds import clean_recent_cmds_tmp
        clean_recent_cmds_tmp()
    except Exception:
        pass
    return


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
