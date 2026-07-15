"""
MQDB 主入口（Flask + PyWebView）
替代 Eel 框架，解决：
- 多连接测试互相阻塞（Flask 多线程）
- 关闭窗口残留进程（PyWebView 系统 WebView）
"""
import sys, os, threading, socket, time

if getattr(sys, 'frozen', False):
    # PyInstaller 打包：exe 所在目录放用户数据，_MEIPASS 放源码
    BASE_DIR = os.path.dirname(sys.executable)
    SRC_DIR = sys._MEIPASS
    os.chdir(BASE_DIR)
    sys.path.insert(0, SRC_DIR)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    SRC_DIR = BASE_DIR
    os.chdir(BASE_DIR)

sys.path.insert(0, SRC_DIR)

# ★ 显式 import 让 PyInstaller 分析依赖链时包含这些模块
import db_transfer_eel          # noqa: F401
import modules                  # noqa: F401
import modules.datagrip_import  # noqa: F401

from app import create_app


def find_free_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def run_flask(app, port):
    """在独立线程中运行 Flask"""
    from waitress import serve
    serve(app, host='127.0.0.1', port=port, threads=20)


def start_webview(port):
    """启动 PyWebView 桌面窗口"""
    import webview
    import urllib.request

    # 等 Flask 就绪
    url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{url}/api/ping", timeout=0.5)
            break
        except Exception:
            time.sleep(0.3)

    webview.create_window(
        "MQDB",
        url,
        width=1280,
        height=860,
        resizable=True,
        min_size=(900, 600),
    )
    webview.start()
    print("[main] 窗口已关闭，退出")
    os._exit(0)


def main():
    port = find_free_port()
    app = create_app()

    flask_thread = threading.Thread(target=run_flask, args=(app, port), daemon=True)
    flask_thread.start()

    start_webview(port)


if __name__ == "__main__":
    main()
