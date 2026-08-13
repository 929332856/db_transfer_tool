"""
MQDB 主入口（Flask + PyWebView）
替代 Eel 框架，解决：
- 多连接测试互相阻塞（Flask 多线程）
- 关闭窗口残留进程（PyWebView 系统 WebView）
"""
import sys, os, threading, socket, time, json
from urllib.parse import quote

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
    SRC_DIR = sys._MEIPASS
    os.chdir(BASE_DIR)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    SRC_DIR = BASE_DIR
    os.chdir(BASE_DIR)

sys.path.insert(0, SRC_DIR)

# ★ PyInstaller frozen 模式下，db_transfer_eel 被编译进 PYZ archive，
# 需要用 importlib 从 _MEIPASS 中直接加载源码
def _load_main_module():
    import importlib.util
    # 先尝试正常 import（开发模式）
    try:
        import db_transfer_eel
        return db_transfer_eel
    except ImportError:
        pass
    # frozen 模式：从 _MEIPASS 中加载
    for name in ('db_transfer_eel.py', 'db_transfer_eel.pyc'):
        fpath = os.path.join(SRC_DIR, name)
        if os.path.exists(fpath):
            spec = importlib.util.spec_from_file_location('db_transfer_eel', fpath)
            mod = importlib.util.module_from_spec(spec)
            sys.modules['db_transfer_eel'] = mod
            spec.loader.exec_module(mod)
            return mod
    raise ImportError(f"无法加载 db_transfer_eel 模块 (SRC_DIR={SRC_DIR})")

_db_transfer_eel = _load_main_module()

from app import create_app


def find_free_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _get_startup_theme():
    """读取启动时主题，供原生窗口和页面首帧同时使用。"""
    try:
        settings_path = os.path.join(BASE_DIR, "mqdb_settings.json")
        if not os.path.exists(settings_path):
            settings_path = os.path.join(BASE_DIR, "settings.json")
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


def run_flask(app, port):
    """在独立线程中运行 Flask"""
    from waitress import serve
    serve(app, host='127.0.0.1', port=port, threads=20)


def start_webview(port):
    """启动 PyWebView 桌面窗口"""
    import webview
    import urllib.request

    # 等 Flask 就绪
    base_url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{base_url}/api/ping", timeout=0.5)
            break
        except Exception:
            time.sleep(0.3)

    # PyWebView 默认 private_mode=True，每次启动 localStorage 都是空的。
    # 直接把主题放进首个页面 URL，避免页面先按深色绘制再切换到浅色。
    url = f"{base_url}/?theme={quote(_get_startup_theme())}"

    window = webview.create_window(
        "MQDB",
        url,
        width=1280,
        height=860,
        resizable=True,
        min_size=(900, 600),
        # 原生窗口会先于 HTML/CSS 绘制；这里必须设置成当前主题的颜色，
        # 否则浅色主题会经历“黑色原生底 → 白色页面”的闪烁。
        background_color=_get_startup_background_color(),
        hidden=True,  # ★ 先隐藏，等页面渲染完成再显示，避免闪黑
    )

    # 页面加载完成后立即显示窗口。DOMContentLoaded 可能早于 pywebview API 注入，
    # 所以不能只依赖前端事件，否则会落到固定的 3 秒兜底延迟。
    shown = threading.Event()

    def show_window():
        if shown.is_set():
            return
        try:
            window.show()
            shown.set()
        except Exception:
            pass

    def show_on_loaded(window):
        show_window()

    try:
        window.events.loaded += show_on_loaded
        window.expose(show_window)
    except Exception:
        pass

    # 仅用于异常兜底；正常情况下会由 loaded 事件立即显示。
    def _fallback_show():
        time.sleep(10)
        show_window()

    threading.Thread(target=_fallback_show, daemon=True).start()

    webview.start()
    print("[main] 窗口已关闭，退出")
    return


def main():
    port = find_free_port()
    app = create_app()

    flask_thread = threading.Thread(target=run_flask, args=(app, port), daemon=True)
    flask_thread.start()

    start_webview(port)


if __name__ == "__main__":
    main()
