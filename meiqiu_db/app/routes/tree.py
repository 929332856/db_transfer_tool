"""
树操作路由：连接管理、文件夹管理、查询文件管理
来源：db_transfer_eel.py 树形栏目持久化部分
关联：app/utils/tree_data.py, app/utils/db.py
"""
from flask import request, jsonify
from app.routes import async_route
from db_transfer_eel import (
    _load_tree, _save_tree, _tree_lock, _get_query_dir,
    _migrate_old_queries, QUERIES_DIR, BASE_DIR,
    _conn_url, _connect_args, _friendly_error, _get_redis,
)
import os, re, time, json


def register(app):
    # ==================== 树数据加载/保存 ====================

    @app.route('/api/tree/load')
    def tree_load():
        data = _load_tree()
        return jsonify(data)

    @app.route('/api/tree/save', methods=['POST'])
    def tree_save():
        data = request.get_json(force=True)
        with _tree_lock:
            _save_tree(data)
        return jsonify({"ok": True, "msg": "保存成功"})

    # ==================== 文件夹操作 ====================

    @app.route('/api/tree/add_folder', methods=['POST'])
    def tree_add_folder():
        data = request.get_json(force=True)
        parent_id = data.get('parent_id', '')
        name = data.get('name', '新文件夹')
        with _tree_lock:
            tree = _load_tree()
            fid = f"f_{int(time.time() * 1000)}"
            tree.setdefault("folders", []).append({"id": fid, "name": name, "parent": parent_id or ""})
            _save_tree(tree)
        return jsonify({"ok": True, "id": fid})

    @app.route('/api/tree/rename_folder', methods=['POST'])
    def tree_rename_folder():
        data = request.get_json(force=True)
        fid = data.get('fid', '')
        new_name = data.get('name', '')
        with _tree_lock:
            tree = _load_tree()
            for f in tree.get("folders", []):
                if f["id"] == fid:
                    f["name"] = new_name
                    break
            _save_tree(tree)
        return jsonify({"ok": True})

    @app.route('/api/tree/delete_folder', methods=['POST'])
    def tree_delete_folder():
        data = request.get_json(force=True)
        fid = data.get('fid', '')
        with _tree_lock:
            _do_delete_folder(fid)
        return jsonify({"ok": True})


    def _do_delete_folder(fid):
        """递归删除文件夹及其内容"""
        tree = _load_tree()
        tree["folders"] = [f for f in tree.get("folders", []) if f["id"] != fid]
        # 删除该文件夹下的连接
        conns_to_del = [cid for cid, c in tree.get("connections", {}).items() if c.get("parent") == fid]
        for cid in conns_to_del:
            del tree["connections"][cid]
        # 递归删除子文件夹
        child_folders = [f["id"] for f in tree.get("folders", []) if f.get("parent") == fid]
        for cf in child_folders:
            _do_delete_folder(cf)
        _save_tree(tree)

    # ==================== 连接操作 ====================

    @app.route('/api/tree/add_connection', methods=['POST'])
    def tree_add_connection():
        data = request.get_json(force=True)
        parent_id = data.get('parent_id', '')
        conn_data = data.get('conn_data', {})
        with _tree_lock:
            tree = _load_tree()
            cid = f"c_{int(time.time() * 1000)}"
            conn_data["id"] = cid
            conn_data["parent"] = parent_id or ""
            tree.setdefault("connections", {})[cid] = conn_data
            _save_tree(tree)
        return jsonify({"ok": True, "id": cid})

    @app.route('/api/tree/update_connection', methods=['POST'])
    def tree_update_connection():
        data = request.get_json(force=True)
        cid = data.get('cid', '')
        conn_data = data.get('conn_data', {})
        with _tree_lock:
            tree = _load_tree()
            if cid in tree.get("connections", {}):
                conn_data["id"] = cid
                conn_data["parent"] = tree["connections"][cid].get("parent", "")
                tree["connections"][cid] = conn_data
                _save_tree(tree)
        return jsonify({"ok": True})

    @app.route('/api/tree/delete_connection', methods=['POST'])
    def tree_delete_connection():
        data = request.get_json(force=True)
        cid = data.get('cid', '')
        with _tree_lock:
            tree = _load_tree()
            if cid in tree.get("connections", {}):
                del tree["connections"][cid]
                _save_tree(tree)
        return jsonify({"ok": True})

    @app.route('/api/tree/move_connection', methods=['POST'])
    def tree_move_connection():
        data = request.get_json(force=True)
        cid = data.get('cid', '')
        target_fid = data.get('target_fid', '')
        with _tree_lock:
            tree = _load_tree()
            if cid in tree.get("connections", {}):
                tree["connections"][cid]["parent"] = target_fid or ""
                _save_tree(tree)
        return jsonify({"ok": True})

    # ==================== 连接测试 ====================

    @app.route('/api/tree/test_conn', methods=['POST'])
    @async_route(timeout=15)
    def tree_test_conn():
        from db_transfer_eel import tree_test_conn as _orig_test
        conn_data = request.get_json(force=True)
        return _orig_test(conn_data)

    # ==================== 查询文件操作 ====================

    @app.route('/api/tree/list_queries', methods=['POST'])
    def tree_list_queries():
        data = request.get_json(force=True)
        conn_id = data.get('conn_id', '')
        db = data.get('db', '')
        from db_transfer_eel import tree_list_queries as _orig
        return jsonify(_orig(conn_id, db))

    @app.route('/api/tree/get_query', methods=['POST'])
    def tree_get_query():
        data = request.get_json(force=True)
        qid = data.get('qid', '')
        from db_transfer_eel import tree_get_query as _orig
        result = _orig(qid)
        return jsonify(result if result else {"ok": False, "msg": "查询不存在"})

    @app.route('/api/tree/save_query', methods=['POST'])
    def tree_save_query():
        data = request.get_json(force=True)
        qid = data.get('qid', '')
        name = data.get('name', '')
        sql = data.get('sql', '')
        conn_id = data.get('conn_id', '')
        db = data.get('db', '')
        from db_transfer_eel import tree_save_query as _orig
        _orig(qid, name, sql, conn_id, db)
        return jsonify({"ok": True})

    @app.route('/api/tree/delete_query', methods=['POST'])
    def tree_delete_query():
        data = request.get_json(force=True)
        qid = data.get('qid', '')
        from db_transfer_eel import tree_delete_query as _orig
        _orig(qid)
        return jsonify({"ok": True})
