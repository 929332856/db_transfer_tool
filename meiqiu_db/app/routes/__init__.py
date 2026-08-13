"""
Flask 路由注册
采用明确白名单模式：仅为 HTTP_API_ALLOWLIST 中的函数创建
/api/<func_name> 路由，再从 Eel 注册表或指定子模块解析实现。
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
                created_at = time.time()
                app.config['ASYNC_JOB_META'][job_id] = {
                    'created_at': created_at, 'updated_at': created_at,
                    'deadline': created_at + timeout, 'timeout': timeout,
                }

            def _run():
                with app.app_context():
                    try:
                        result = f(*args, **kwargs)
                    except Exception as e:
                        result = {"ok": False, "msg": str(e)}
                    with app.config['ASYNC_LOCK']:
                        if job_id in jobs and jobs[job_id] is None:
                            jobs[job_id] = result
                            app.config['ASYNC_JOB_META'].setdefault(job_id, {})['updated_at'] = time.time()

            threading.Thread(target=_run, daemon=True).start()
            return jsonify({"ok": True, "_async": True, "_job_id": job_id})
        return wrapper
    return decorator


# ★ 需要异步执行的函数列表（连接测试、慢查询、仪表盘等）
HTTP_API_ALLOWLIST = frozenset("""
cancel_query cancel_table_operation check_target_tables clear_cancel
dashboard_capture_baseline dashboard_capture_top_cmds dashboard_get_metrics
dashboard_read_recent_cmds dashboard_reset_recent_cmds datagrip_parse_import
db_create db_delete db_explore_compile_object db_explore_drop_object
db_explore_get_databases db_explore_get_objlist db_explore_get_proc_params
db_explore_get_proc_source db_explore_get_procedures db_explore_get_schemas
db_explore_get_table_ddl db_explore_get_tables db_explore_get_triggers
db_explore_get_views db_explore_test_proc db_get_collations db_get_info
db_run_sql_file debug_python_info delete_profile drag_copy_table drag_copy_tables
execute_sql_query export_pick_file export_query_save export_wizard_get_columns
export_wizard_get_tables export_wizard_start find_profile get_connection_info
get_database_info get_last_used get_profiles get_query_page import_wizard_run
pick_open_file pick_sql_file poll_query_result poll_queue redis_append_list
redis_append_set redis_append_zset redis_delete_key redis_execute redis_get_databases
redis_get_key_info redis_get_keys redis_get_keys_meta redis_set_hash redis_set_list
redis_set_set redis_set_string redis_set_zset release_query_result replication_get_status
save_import_file save_profile settings_get settings_get_paths settings_save
slow_query_check_enabled slow_query_enable slow_query_get_databases
slow_query_get_detail slow_query_get_list slow_query_get_log slow_query_get_running
slow_query_kill_processlist start_transfer stop_transfer table_apply_design
table_backup table_clear table_delete table_delete_rows table_drop_column
table_drop_foreign_key table_drop_index table_exec_delete table_exec_save
table_execute_sql table_get_col_types table_get_ddl table_get_design_info
table_load_page table_preview_data table_preview_data_fast table_rename
table_save_changes table_truncate test_connection tree_add_connection tree_add_folder
tree_check_integrity tree_delete_connection tree_delete_folder tree_delete_query
tree_diag tree_get_query tree_list_queries tree_load tree_move_connection
tree_rename_folder tree_save tree_save_query tree_test_conn tree_update_connection
""".split())

ASYNC_FUNCTIONS = {
    'tree_test_conn', 'test_connection',
    'slow_query_check_enabled', 'slow_query_get_list', 'slow_query_get_log',
    'slow_query_get_detail', 'slow_query_get_running', 'slow_query_enable',
    'slow_query_get_databases', 'slow_query_kill_processlist',
    'dashboard_get_metrics',
    'dashboard_capture_top_cmds',
    'replication_get_status',
    'dashboard_get_top_cmds', 'dashboard_reset_top_cmds_baseline',
    'get_database_info', 'get_connection_info',
    'db_explore_get_databases', 'db_explore_get_schemas',
    'db_explore_get_tables', 'db_explore_get_views', 'db_explore_get_procedures',
    'db_explore_get_proc_source', 'db_explore_get_proc_params', 'db_explore_test_proc', 'db_explore_drop_object', 'db_explore_compile_object',
    'execute_sql_query',
}


def _resolve_args(func, data):
    """解析参数并调用函数，返回结果（可在任意线程中调用）"""
    import inspect
    sig = inspect.signature(func)
    param_names = list(sig.parameters.keys())
    params = list(sig.parameters.values())

    if not param_names:
        # 无参函数
        return func()

    # ★ 处理 arg0, arg1 格式（多参数位置调用）
    if any(k.startswith('arg') for k in data.keys()):
        pos_args = [data[f'arg{i}'] for i in range(len(param_names)) if f'arg{i}' in data]
        if len(pos_args) == len(param_names):
            return func(*pos_args)
        # 不足参数时补 None
        while len(pos_args) < len(param_names):
            pos_args.append(None)
        return func(*pos_args[:len(param_names)])

    if len(param_names) == 1:
        # 单参数函数
        p1 = params[0]
        if not data and p1.default is not inspect.Parameter.empty:
            return func()
        if not data:
            try:
                return func()
            except TypeError:
                pass
        try:
            return func(data)
        except TypeError:
            try:
                return func(**data)
            except TypeError:
                return func()
    else:
        # 多参数函数
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
    """仅注册显式 HTTP 白名单中的 Eel 业务函数。"""
    import eel
    main_module = _import_main_module()

    # ★ Eel 将所有 @eel.expose 函数存在 _exposed_functions 中
    exposed_names = set(eel._exposed_functions.keys()) if hasattr(eel, '_exposed_functions') else set()

    # 不再回退扫描模块的所有 callable；只从明确白名单解析路由。
    exposed_names = (exposed_names & HTTP_API_ALLOWLIST) or set(HTTP_API_ALLOWLIST)

    exposed_funcs = {}
    for name in exposed_names:
        # Eel 内部函数不应自动变成 HTTP API；健康检查也由 app 工厂显式注册。
        if not isinstance(name, str) or name not in HTTP_API_ALLOWLIST:
            continue
        obj = getattr(main_module, name, None)
        if not callable(obj):
            # ★ 子模块中的 @eel.expose 函数（如 modules.replication_status）
            #    在主模块中找不到，去 modules.* 中查找
            for sub in ('modules.datagrip_import', 'modules.replication_status', 'modules.dashboard_cmds'):
                try:
                    sub_mod = __import__(sub, fromlist=[name])
                    obj = getattr(sub_mod, name, None)
                    if callable(obj):
                        break
                except Exception:
                    pass
        if callable(obj):
            exposed_funcs[name] = obj

    with open('logs/routes_debug.log', 'w', encoding='utf-8') as _f:
        _f.write(f"[routes] 发现 {len(exposed_funcs)} 个函数\n")
        for _fn in sorted(exposed_funcs.keys()):
            _f.write(f"  [routes]   {_fn}\n")

    registered = 0
    for func_name, func in exposed_funcs.items():
        route_path = f'/api/{func_name}'

        if func_name in ASYNC_FUNCTIONS:
            # ★ 异步函数：用工厂函数创建 handler（避免闭包延迟绑定）
            def _make_async_handler(fn, fname):
                @wraps(fn)
                def async_handler():
                    import uuid
                    from flask import current_app
                    # 在请求上下文中解析参数
                    data = request.get_json(force=True, silent=True) or {}
                    for k, v in request.args.items():
                        if k not in data:
                            data[k] = v
                    # 创建 job（用完整 UUID 避免冲突）
                    job_id = str(uuid.uuid4())
                    app = current_app._get_current_object()
                    jobs = app.config['ASYNC_JOBS']
                    with app.config['ASYNC_LOCK']:
                        jobs[job_id] = None
                        created_at = time.time()
                        app.config['ASYNC_JOB_META'][job_id] = {
                            'created_at': created_at, 'updated_at': created_at,
                            'deadline': created_at + 15, 'timeout': 15,
                        }
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
                                    app.config['ASYNC_JOB_META'].setdefault(job_id, {})['updated_at'] = time.time()
                    threading.Thread(target=_run, daemon=True).start()
                    return jsonify({"ok": True, "_async": True, "_job_id": job_id})
                return async_handler
            handler = _make_async_handler(func, func_name)
        else:
            handler = _make_route_handler(func, func_name)

        try:
            app.add_url_rule(route_path, func_name, handler, methods=['POST'])
            registered += 1
        except AssertionError:
            pass

    print(f"[routes] 已注册 {registered} 个路由")
