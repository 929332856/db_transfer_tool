"""
Flask 路由注册
采用自动桥接模式：扫描 db_transfer_eel 中所有 @eel.expose 函数，
自动创建对应的 /api/<func_name> 路由。
"""
import sys, os, json, threading, time, re
from functools import wraps
from flask import request, jsonify

# ★ 兼容 PyInstaller：sys._MEIPASS 是临时解压目录
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE_DIR)


def async_route(timeout=15):
    """装饰器：将函数包装为异步执行（线程池 + job_id 轮询）
    函数在请求上下文中被调用，结果在线程中计算
    """
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            import uuid
            from flask import current_app
            # 先执行 f 获取结果（在请求上下文），如果 f 只是参数解析器则调用它
            # 然后在线程中执行真正的业务逻辑
            job_id = str(uuid.uuid4())[:8]
            app = current_app._get_current_object()
            jobs = app.config['ASYNC_JOBS']
            with app.config['ASYNC_LOCK']:
                jobs[job_id] = None

            def _run():
                with app.app_context():
                    try:
                        result = f(*args, **kwargs)
                    except Exception as e:
                        result = {"ok": False, "msg": str(e)}
                    with app.config['ASYNC_LOCK']:
                        if job_id in jobs and jobs[job_id] is None:
                            jobs[job_id] = result

            def _watchdog():
                time.sleep(timeout + 5)
                with app.app_context():
                    with app.config['ASYNC_LOCK']:
                        if job_id in jobs and jobs[job_id] is None:
                            jobs[job_id] = {"ok": False, "msg": f"操作超时（{timeout}秒）"}

            threading.Thread(target=_run, daemon=True).start()
            threading.Thread(target=_watchdog, daemon=True).start()
            return jsonify({"ok": True, "_async": True, "_job_id": job_id})
        return wrapper
    return decorator


# ★ 需要异步执行的函数列表（连接测试、慢查询、仪表盘等）
ASYNC_FUNCTIONS = {
    'tree_test_conn', 'test_connection',
    'slow_query_check_enabled', 'slow_query_get_list', 'slow_query_get_log',
    'slow_query_get_detail', 'slow_query_get_running', 'slow_query_enable',
    'slow_query_get_databases', 'slow_query_kill_processlist',
    'dashboard_get_metrics',
    'get_database_info', 'get_connection_info',
    'db_explore_get_databases', 'db_explore_get_schemas',
    'db_explore_get_tables', 'db_explore_get_views', 'db_explore_get_procedures',
    'execute_sql_query',
}


def _resolve_args(func, data):
    """解析参数并调用函数，返回结果（可在任意线程中调用）"""
    import inspect
    sig = inspect.signature(func)
    param_names = list(sig.parameters.keys())

    if not param_names:
        return func()
    elif len(param_names) == 1:
        try:
            return func(data)
        except TypeError:
            try:
                return func(**data)
            except TypeError:
                return func()
    else:
        try:
            return func(**data)
        except TypeError:
            if len(param_names) == 2:
                p2 = param_names[1]
                side_val = data.get(p2, data.get('side', ''))
                return func(data, side_val)
            else:
                return func(data)


def _make_route_handler(func, func_name):
    """为 eel 函数创建 Flask 路由处理器（智能参数匹配）"""
    import inspect
    sig = inspect.signature(func)
    param_names = list(sig.parameters.keys())

    def handler():
        try:
            # 获取 JSON body
            data = request.get_json(force=True, silent=True) or {}
            # 合并 query params
            for k, v in request.args.items():
                if k not in data:
                    data[k] = v

            result = _resolve_args(func, data)
            return jsonify(result)
        except Exception as e:
            return jsonify({"ok": False, "msg": str(e)})

    return handler


def _import_main_module():
    """获取 db_transfer_eel 模块（由 main.py 预加载到 sys.modules）"""
    import db_transfer_eel
    return db_transfer_eel


def register_routes(app):
    """自动注册所有 @eel.expose 函数为 Flask 路由（从 Eel 内部注册表读取）"""
    import eel
    main_module = _import_main_module()

    # ★ Eel 将所有 @eel.expose 函数存在 _exposed_functions 中
    exposed_names = set(eel._exposed_functions.keys()) if hasattr(eel, '_exposed_functions') else set()

    if not exposed_names:
        # 回退：扫描模块函数
        for name in dir(main_module):
            obj = getattr(main_module, name, None)
            if callable(obj) and not name.startswith('_'):
                exposed_names.add(name)

    exposed_funcs = {}
    for name in exposed_names:
        obj = getattr(main_module, name, None)
        if callable(obj):
            exposed_funcs[name] = obj

    print(f"[routes] 发现 {len(exposed_funcs)} 个函数")

    registered = 0
    for func_name, func in exposed_funcs.items():
        route_path = f'/api/{func_name}'

        if func_name in ASYNC_FUNCTIONS:
            # ★ 异步函数：wrapper 内解析参数并提交线程任务
            fn = func  # 捕获引用
            @wraps(fn)
            def async_handler():
                import uuid
                from flask import current_app
                # 在请求上下文中解析参数
                data = request.get_json(force=True, silent=True) or {}
                for k, v in request.args.items():
                    if k not in data:
                        data[k] = v
                # 创建 job
                job_id = str(uuid.uuid4())[:8]
                app = current_app._get_current_object()
                jobs = app.config['ASYNC_JOBS']
                with app.config['ASYNC_LOCK']:
                    jobs[job_id] = None
                # 线程中执行（不访问 request）
                def _run():
                    with app.app_context():
                        try:
                            result = _resolve_args(fn, data)
                        except Exception as e:
                            result = {"ok": False, "msg": str(e)}
                        with app.config['ASYNC_LOCK']:
                            if job_id in jobs and jobs[job_id] is None:
                                jobs[job_id] = result
                def _watchdog():
                    time.sleep(20)  # timeout+5
                    with app.app_context():
                        with app.config['ASYNC_LOCK']:
                            if job_id in jobs and jobs[job_id] is None:
                                jobs[job_id] = {"ok": False, "msg": "操作超时（15秒）"}
                threading.Thread(target=_run, daemon=True).start()
                threading.Thread(target=_watchdog, daemon=True).start()
                return jsonify({"ok": True, "_async": True, "_job_id": job_id})
            handler = async_handler
        else:
            handler = _make_route_handler(func, func_name)

        try:
            app.add_url_rule(route_path, func_name, handler, methods=['GET', 'POST'])
            registered += 1
        except AssertionError:
            pass

    print(f"[routes] 已注册 {registered} 个路由")
