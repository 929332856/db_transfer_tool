// ==================== 树初始化（从 tree.js 拆出，避免改坏 tree.js 影响回显） ====================
// 负责：等待 eel 就绪 → 手动导入函数（PyInstaller 回退）→ 加载树数据
// 依赖：tree.js 中的 loadTree() 函数必须在调用前已定义

(function _initTreeLoader() {
    var attempts = 0;
    var maxAttempts = 60; // 最多等 60 次（60*500ms = 30秒）
    function _diag(m, c) { try { if (typeof _diag_add === 'function') _diag_add(m, c); } catch(e) {} }
    function tryLoad() {
        try {
            if (typeof eel === 'undefined') {
                if (++attempts < maxAttempts) { setTimeout(tryLoad, 500); }
                else { _diag('[tree_init] eel 30s not ready', 'err'); }
                return;
            }
            _diag('[tree_init] eel found (attempt=' + attempts + ')', attempts > 5 ? 'warn' : 'ok');

            // PyInstaller 回退修复：如果 /eel.js 加载失败回退到静态 js/eel.js，
            // _py_functions 为空，需要手动导入 tree_load
            if (typeof eel.tree_load !== 'function' && typeof eel._import_py_function === 'function') {
                _diag('[tree_init] tree_load missing, manual import...', 'warn');
                // 手动导入关键函数（其余函数按需在主流程中也会触发导入）
                var criticalFns = ['tree_load', 'tree_diag', 'tree_save', 'tree_backup_now', 'tree_add_folder',
                    'tree_rename_folder', 'tree_delete_folder', 'tree_add_connection',
                    'tree_update_connection', 'tree_delete_connection', 'tree_move_connection',
                    'tree_save_query', 'tree_get_query', 'tree_delete_query', 'tree_test_conn',
                    'tree_get_backups', 'tree_force_recover', 'tree_check_integrity',
                    'db_explore_get_databases', 'db_explore_get_schemas', 'db_explore_get_tables',
                    'db_explore_get_views', 'db_explore_get_procedures', 'db_explore_get_triggers',
                    'db_explore_get_table_ddl', 'db_get_info', 'db_get_collations', 'db_delete',
                    'table_preview_data', 'table_preview_data_fast', 'table_load_page', 'table_save_changes', 'table_exec_save',
                    'table_delete_rows', 'table_exec_delete',
                    'table_get_ddl', 'table_get_design_info', 'table_apply_design',
                    'table_truncate', 'table_delete', 'table_clear',
                    'get_connection_info', 'get_database_info',
                    'redis_get_databases', 'redis_get_keys', 'redis_get_key_info',
                    'redis_get_keys_meta', 'redis_execute', 'redis_delete_key',
                    'redis_set_string', 'redis_set_hash', 'redis_set_list',
                    'redis_set_set', 'redis_set_zset', 'redis_append_list',
                    'redis_append_set', 'redis_append_zset',
                    'execute_sql_query', 'cancel_query', 'clear_cancel', 'poll_queue',
                    'drag_copy_table', 'db_run_sql_file',
                    'get_profiles', 'get_last_used', 'save_profile', 'delete_profile',
                    'find_profile', 'test_connection', 'start_transfer', 'stop_transfer',
                    'datagrip_parse_import',
                    'ping', 'debug_python_info'];
                var imported = 0;
                for (var i = 0; i < criticalFns.length; i++) {
                    if (typeof eel[criticalFns[i]] !== 'function') {
                        try { eel._import_py_function(criticalFns[i]); imported++; } catch(e) {}
                    }
                }
                _diag('[tree_init] manual import done, imported=' + imported, 'ok');
            }

            if (typeof eel.tree_load === 'function') {
                // ★ 等待 loadTree() 函数定义后再调用（tree.js 可能尚未解析完成）
                if (typeof loadTree === 'function') {
                    _diag('[tree_init] tree_load + loadTree both ready, calling...', 'ok');
                    // 先 ping 验证通信，再加载树
                    if (typeof eel.ping === 'function') {
                        try { eel.ping()(function(r) { _diag('[tree_init] ping response: ' + (r || 'null'), 'ok'); }); } catch(e) {}
                    }
                    loadTree();
                    // 加载后自动运行诊断（控制台可见，打包 exe 按 F12 查看）
                    if (typeof eel.tree_diag === 'function') {
                        try {
                            eel.tree_diag()(function(d) {
                                if (d) {
                                    console.log('[tree_init] 诊断: frozen=' + d.frozen + ', TREE_FILE=' + d.tree_file + ', exists=' + d.tree_file_exists + ', size=' + d.tree_file_size + ', conns=' + (d.connections_count || '?') + ', valid=' + d.valid + ', hasContent=' + d.has_content);
                                    if (d.parse_error) console.error('[tree_init] 解析错误: ' + d.parse_error);
                                }
                            });
                        } catch(e) { console.warn('[tree_init] tree_diag 调用失败', e); }
                    }
                } else {
                    // loadTree 还未定义，等 100ms 再检查
                    _diag('[tree_init] tree_load ready but loadTree not yet defined, waiting...', 'warn');
                    setTimeout(function() {
                        if (typeof loadTree === 'function') {
                            loadTree();
                        } else {
                            _diag('[tree_init] loadTree still missing, retrying', 'err');
                            if (++attempts < maxAttempts) { setTimeout(tryLoad, 500); }
                        }
                    }, 100);
                }
            } else {
                _diag('[tree_init] tree_load still missing, retry...', 'warn');
                if (++attempts < maxAttempts) { setTimeout(tryLoad, 500); }
                else { _diag('[tree_init] GAVE UP after 30s', 'err'); }
            }
        } catch (err) {
            _diag('[tree_init] exception: ' + (err.message || err), 'err');
            if (++attempts < maxAttempts) { setTimeout(tryLoad, 1000); }
        }
    }
    // 立即尝试，如果 eel 还没就绪则轮询等待
    tryLoad();
})();
