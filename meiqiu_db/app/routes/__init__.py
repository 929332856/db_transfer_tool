"""
Flask 路由注册
采用自动桥接模式：扫描 db_transfer_eel 中所有 @eel.expose 函数，
自动创建对应的 /api/<func_name> 路由。
"""
import sys, os, json, threading, time, re
from functools import wraps
from flask import request, jsonify

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def async_route(timeout=15):
    """装饰器：将函数包装为异步执行（线程池 + job_id 轮询）"""
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            import uuid
            from flask import current_app
            job_id = str(uuid.uuid4())[:8]
            jobs = current_app.config['ASYNC_JOBS']
            with current_app.config['ASYNC_LOCK']:
                jobs[job_id] = None

            def _run():
                try:
                    result = f(*args, **kwargs)
                except Exception as e:
                    result = {"ok": False, "msg": str(e)}
                with current_app.config['ASYNC_LOCK']:
                    if job_id in jobs and jobs[job_id] is None:
                        jobs[job_id] = result

            def _watchdog():
                time.sleep(timeout + 5)
                with current_app.config['ASYNC_LOCK']:
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


def _make_route_handler(func, func_name):
    """为 eel 函数创建 Flask 路由处理器"""
    import inspect
    sig = inspect.signature(func)

    def handler():
        try:
            # 尝试从 JSON body 或 query params 获取参数
            if request.is_json:
                data = request.get_json(force=True)
            else:
                data = {}
            # 尝试从 request.args 补充参数
            for k, v in request.args.items():
                if k not in data:
                    data[k] = v

            # 构造参数列表（匹配函数签名）
            args = []
            kwargs = {}
            for name, param in sig.parameters.items():
                if name == 'self':
                    continue
                if name in data:
                    kwargs[name] = data[name]
                elif param.default is not inspect.Parameter.empty:
                    kwargs[name] = param.default
                else:
                    kwargs[name] = data  # 第一个位置参数可能是整个 dict

            # 简化：如果只有一个参数且不是关键字，传整个 data
            params = list(sig.parameters.keys())
            if len(params) == 1 and params[0] not in kwargs:
                result = func(data)
            elif len(params) == 2 and params[0] not in kwargs and params[1] not in kwargs:
                # 可能是 (data, side) 模式
                result = func(data, kwargs.get(params[1], ''))
            else:
                try:
                    result = func(**kwargs)
                except TypeError:
                    result = func(data)

            return jsonify(result)
        except Exception as e:
            return jsonify({"ok": False, "msg": str(e)})

    return handler


def register_routes(app):
    """自动注册所有 @eel.expose 函数为 Flask 路由"""
    import db_transfer_eel as main_module

    exposed_funcs = {}
    # 扫描模块中的所有函数
    for name in dir(main_module):
        obj = getattr(main_module, name, None)
        if not callable(obj):
            continue
        # 检查是否有 eel.expose 标记
        if hasattr(obj, '_eel_exposed') or (hasattr(obj, '__wrapped__') and hasattr(obj.__wrapped__, '_eel_exposed')):
            exposed_funcs[name] = obj

    print(f"[routes] 发现 {len(exposed_funcs)} 个 eel 暴露函数")

    registered = 0
    for func_name, func in exposed_funcs.items():
        route_path = f'/api/{func_name}'
        handler = _make_route_handler(func, func_name)

        # 异步函数用 async_route 包装
        if func_name in ASYNC_FUNCTIONS:
            handler = async_route(timeout=15)(handler.__wrapped__ if hasattr(handler, '__wrapped__') else handler)
            # 重新创建 handler
            def make_async_h(fn, name):
                @async_route(timeout=15)
                def _h():
                    return _make_route_handler(fn, name)()
                return _h
            handler = make_async_h(func, func_name)

        app.add_url_rule(route_path, func_name, handler, methods=['GET', 'POST'])
        registered += 1

    print(f"[routes] 已注册 {registered} 个路由")
