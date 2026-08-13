// ==================== 拖拽复制表 ====================
var _dragInfo = null; // {table_name, table_names, src_db, schema, src_cid}
// ==================== 拖拽移动连接 ====================
var _connDragInfo = null; // {cid, fromParent} — 当前正在拖拽的连接
// ★ Ctrl+C/V 复制表（与拖拽逻辑一致：同库直接备份，跨库弹选择框）
var _copyTableInfo = null; // {table_name, src_db, schema, src_cid}

// 全局清理：确保拖拽结束不残留状态
document.addEventListener('dragend', function(e) {
    var el = e.target;
    if (el.classList && el.classList.contains('drag-table-item')) {
        el.classList.remove('dragging');
    }
    // 清理对象窗口残留的高亮
    var panel = document.getElementById('object_panel');
    if (panel) panel.classList.remove('drop-target');
    _dragInfo = null;
});

function onTableDragStart(e, tn, db, schema, cid) {
    var selected = [];
    // 只收集与当前拖拽表来自同一连接/数据库/schema 的选中项，避免把其他列表的选择一起带走。
    document.querySelectorAll('.tree-table-item.tree-table-selected, #obj_content .drag-table-item.table-row-selected').forEach(function(el) {
        if (el.getAttribute('data-cid') !== String(cid || '') ||
            el.getAttribute('data-db') !== String(db || '') ||
            (el.getAttribute('data-sch') || '') !== (schema || '')) return;
        var name = el.getAttribute('data-tname');
        if (name && selected.indexOf(name) < 0) selected.push(name);
    });
    if (selected.indexOf(tn) < 0) selected.unshift(tn);
    _dragInfo = {
        table_name: tn,
        table_names: selected,
        src_db: db,
        schema: schema || '',
        src_cid: cid
    };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', selected.join('\n'));
}

function onTableDragEnd(e) {
    var el = e.target;
    if (el) el.classList.remove('dragging');
    _dragInfo = null;
}

// ★ Ctrl+C 复制当前选中的表（树 + 对象窗口，焦点不在可编辑元素时生效）
function _copyTableShortcut(e) {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'INPUT' || (e.target && e.target.isContentEditable)) return;
    // ★ 树中的表（.tree-table-item.tree-table-selected）
    var sel = document.querySelector('.tree-table-item.tree-table-selected');
    if (sel) {
        var tn = sel.getAttribute('data-tname');
        var db = sel.getAttribute('data-db');
        var sch = sel.getAttribute('data-sch') || '';
        var cid = sel.getAttribute('data-cid');
        if (tn && cid) {
            _copyTableInfo = { table_name: tn, src_db: db, schema: sch, src_cid: cid };
            try { navigator.clipboard.writeText(tn); } catch(_) {}
            showToast('已复制表：' + tn + '\n按 Ctrl+V 粘贴到当前库（同库自动备份/跨库弹出选项）', 2500);
            e.preventDefault(); e.stopPropagation();
            return;
        }
    }
    // ★ 对象窗口中的表（.drag-table-item.table-row-selected）
    var objRow = document.querySelector('#obj_content .drag-table-item.table-row-selected');
    if (objRow) {
        var tn2 = objRow.getAttribute('data-tname');
        var db2 = objRow.getAttribute('data-db');
        var sch2 = objRow.getAttribute('data-sch') || '';
        var cid2 = objRow.getAttribute('data-cid');
        if (tn2 && cid2) {
            _copyTableInfo = { table_name: tn2, src_db: db2, schema: sch2, src_cid: cid2 };
            try { navigator.clipboard.writeText(tn2); } catch(_) {}
            showToast('已复制表：' + tn2 + '\n按 Ctrl+V 粘贴到当前库（同库自动备份/跨库弹出选项）', 2500);
            e.preventDefault(); e.stopPropagation();
            return;
        }
    }
}

// ★ Ctrl+V 粘贴表（同库直接备份，跨库弹出选择框）
function _pasteTableShortcut(e) {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'INPUT' || (e.target && e.target.isContentEditable)) return;
    if (!_copyTableInfo) return;
    e.preventDefault();
    e.stopPropagation();

    var src = _copyTableInfo;
    var srcConn = treeData && treeData.connections ? treeData.connections[src.src_cid] : null;
    var targetCid = src.src_cid;
    var targetDb = activeDatabase || src.src_db;
    var dstConn = srcConn;
    if (!srcConn || !dstConn) { showWarnDialog('提示', '无法获取连接信息'); return; }

    // 同库 → 弹出确认框让用户确认备份名（tn_YYYYMMDD_HHMMSS）
    if (targetCid === src.src_cid && targetDb === src.src_db) {
        var ts = new Date();
        var pad2 = function(n){ return n < 10 ? '0'+n : ''+n; };
        var stamp = ts.getFullYear() + pad2(ts.getMonth()+1) + pad2(ts.getDate()) + '_' + pad2(ts.getHours()) + pad2(ts.getMinutes()) + pad2(ts.getSeconds());
        var newTn = src.table_name + '_' + stamp;
        showConfirmDialog('备份表', '将创建备份表 <b>[' + newTn + ']</b>？',
            function(){
                showModal('💾','正在备份表 <b>'+escapeHtml(src.table_name)+'</b>','<div style="text-align:center;padding:20px 0;"><div style="font-size:28px;margin-bottom:10px;">⏳</div><div style="color:#aaa;font-size:12px;">正在创建备份 <code class="code-inline">'+escapeHtml(newTn)+'</code></div><div style="color:#666;font-size:10px;margin-top:12px;">大表备份可能耗时较长，请耐心等待...</div></div>','#e67e22','<button class="btn btn-red btn-sm" onclick="eel.cancel_query()();this.disabled=true;this.textContent=\'正在终止...\'">⏹ 取消执行</button>');
                eel.drag_copy_table(srcConn, src.src_db, src.table_name, dstConn, targetDb, true, newTn)(function(r) {
                    if (r && r.ok) {
                        document.getElementById('modal_title').innerHTML = '✅ 备份完成';
                        document.getElementById('modal_title').style.color = '#27ae60';
                        document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:20px 0;"><div style="font-size:28px;margin-bottom:10px;">✅</div><div style="color:#ccc;font-size:14px;">已备份为：'+escapeHtml(newTn)+'</div></div>';
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-green btn-sm" onclick="hideModal()">完成</button>';
                        // ★ 无感刷新：表文件夹 + 对象窗口
                        refreshTableFolder(targetCid, targetDb, '');
                        // 备份表创建完成后，刷新当前对象窗口中的表列表，避免新表不显示。
                        setTimeout(function(){ refreshObjPanel(); }, 500);
                        if (activeCatId === 'cat_tables_' + safeBtoa(targetDb)) {
                            loadCategoryItems(srcConn, targetDb, 'tables', function(items) {
                                renderCategoryItems('cat_tables_' + safeBtoa(targetDb), items, 'tables');
                            }, '');
                        }
                    } else {
                        document.getElementById('modal_title').innerHTML = '❌ 备份失败';
                        document.getElementById('modal_title').style.color = '#e74c3c';
                        document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:20px 0;"><div style="font-size:28px;margin-bottom:10px;">❌</div><div style="color:#e74c3c;">'+(r?escapeHtml(r.msg):'未知错误')+'</div></div>';
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';
                    }
                });
            },
            function(){ /* 取消 */ },
            '确定', '取消'
        );
        return;
    }

    // 跨库 → 弹出选择框（复用 showDragCopyDialog）
    showDragCopyDialog(src.table_name, src.src_db, src.schema, srcConn, targetCid, targetDb, dstConn);
}

// ★ 全局 Ctrl+C/V 监听
document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) _copyTableShortcut(e);
    else if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) _pasteTableShortcut(e);
});

function onDbDragOver(e, el, cid, db) {
    if (!_dragInfo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
}

function onDbDragLeave(e, el) {
    el.classList.remove('drop-target');
}

function onDbDrop(e, el, targetCid, targetDb) {
    e.preventDefault();
    el.classList.remove('drop-target');
    if (!_dragInfo) return;

    var src = _dragInfo;
    var srcCid = src.src_cid;
    var srcConn = treeData && treeData.connections ? treeData.connections[srcCid] : null;
    var dstConn = treeData && treeData.connections ? treeData.connections[targetCid] : null;

    if (!srcConn || !dstConn) { showWarnDialog('提示', '无法获取连接信息'); _dragInfo = null; return; }
    if (srcCid === targetCid && src.src_db === targetDb) {
        showWarnDialog('提示', '不能将表导入到自身所在的目标库');
        _dragInfo = null;
        return;
    }

    // 弹出选择框：仅结构 或 结构+数据；支持 Ctrl 多选的表批量导入
    showDragCopyDialog(src.table_names || [src.table_name], src.src_db, src.schema, srcConn, targetCid, targetDb, dstConn);
    _dragInfo = null;
}

// 拖拽表到表文件夹节点（与 onDbDrop 类似，但走文件夹参数）
function onTableFolderDrop(e, el, targetCid, targetDb, targetSchema) {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    if (!_dragInfo) return;

    var src = _dragInfo;
    // 禁止同步到自身所在库
    if (src.src_cid === targetCid && src.src_db === targetDb) {
        showWarnDialog('提示', '不能将表同步到自身所在库');
        _dragInfo = null; return;
    }
    var srcConn = treeData && treeData.connections ? treeData.connections[src.src_cid] : null;
    var dstConn = treeData && treeData.connections ? treeData.connections[targetCid] : null;

    if (!srcConn || !dstConn) { showWarnDialog('提示', '无法获取连接信息'); _dragInfo = null; return; }

    showDragCopyDialog(src.table_names || [src.table_name], src.src_db, src.schema, srcConn, targetCid, targetDb, dstConn);
    _dragInfo = null;
}

function showDragCopyDialog(tableNames, srcDb, schema, srcConn, targetCid, targetDb, dstConn) {
    var names = Array.isArray(tableNames) ? tableNames.filter(function(n){ return !!n; }) : [tableNames];
    if (!names.length) return;
    var titleName = names.length === 1 ? names[0] : (names.length + ' 张表');
    document.getElementById('modal_icon').innerHTML = '📋';
    document.getElementById('modal_title').textContent = '导入表：' + titleName;
    var listHtml = names.length > 1
        ? '<div style="margin-top:8px;max-height:90px;overflow:auto;color:#aaa;font-size:11px;">' + names.map(function(n){ return '• ' + escapeHtml(n); }).join('<br>') + '</div>'
        : '';
    document.getElementById('modal_msg').innerHTML = '<div>源库：<b>' + escapeHtml(srcConn.name||srcConn.host) + '</b> / ' + escapeHtml(srcDb) + '</div><div style="margin-top:4px;">目标库：<b>' + escapeHtml(dstConn.name||dstConn.host) + '</b> / ' + escapeHtml(targetDb) + '</div>' + listHtml +
        '<label style="display:flex;align-items:center;gap:7px;margin-top:12px;font-size:12px;cursor:pointer;">' +
        '<input type="checkbox" id="drag_drop_existing" style="width:15px;height:15px;">' +
        '<span>导入前删除目标库中同名表（只删除目标库，不会删除源库）</span></label>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-blue" style="font-size:12px;" onclick="startDragCopy2(false)">📐 仅表结构</button><button class="btn btn-green" style="font-size:12px;" onclick="startDragCopy2(true)">📊 结构 + 数据</button>';
    document.getElementById('modal_overlay').classList.add('show');

    window.startDragCopy2 = function(copyData) {
        var dropExistingEl = document.getElementById('drag_drop_existing');
        var dropExisting = !!(dropExistingEl && dropExistingEl.checked);
        document.getElementById('modal_icon').innerHTML = '⏳';
        document.getElementById('modal_title').textContent = '导入中...';
        document.getElementById('modal_msg').innerHTML = '<div class="progress-bar" style="margin:8px 0;height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;"><div id="drag_copy_bar" class="progress-fill" style="width:0%;height:100%;background:#4CAF50;border-radius:4px;transition:width 0.3s;"></div></div><div id="drag_copy_table_status" style="margin-top:10px;font-size:13px;font-weight:600;color:#4CAF50;">准备导入...</div><div id="drag_copy_status" style="margin-top:5px;font-size:11px;color:#888;">正在连接...</div><button class="btn btn-sm" style="margin-top:8px;background:#e74c3c;color:#fff;font-size:10px;" onclick="cancelDragCopy()">⏹ 取消</button>';
        document.getElementById('modal_btns').innerHTML = '';

        var done = false;
        window._dragCopyDone = function() { done = true; };
        window.cancelDragCopy = function() {
            if (done) return;
            done = true;
            eel.cancel_query()();
            document.getElementById('modal_overlay').classList.remove('show');
        };

        // 轮询进度（每 200ms）
        var lastProgress = -1;
        var lastProgressTime = Date.now();
        var pollTimer = setInterval(function() {
            if (done) { clearInterval(pollTimer); return; }
            eel.poll_queue()(function(msgs) {
                if (done || !msgs) return;
                for (var i = 0; i < msgs.length; i++) {
                    var m = msgs[i];
                    if (m && m[0] === 'drag_progress') {
                        var d = m[1];
                        var bar = document.getElementById('drag_copy_bar');
                        var st = document.getElementById('drag_copy_status');
                        if (bar && d.percent !== undefined) {
                            bar.style.width = d.percent + '%';
                            if (d.percent !== lastProgress) {
                                lastProgress = d.percent;
                            }
                        }
                        var tableSt = document.getElementById('drag_copy_table_status');
                        if (d.table_index && d.table_total && d.table_name) {
                            if (tableSt) {
                                tableSt.textContent = d.committed
                                    ? '第 ' + d.table_index + '/' + d.table_total + ' 张表已导入并提交：' + d.table_name
                                    : ((d.status && d.status.indexOf('结构已提交') >= 0)
                                        ? '第 ' + d.table_index + '/' + d.table_total + ' 张表处理完成：' + d.table_name
                                        : '正在导入第 ' + d.table_index + '/' + d.table_total + ' 张表：' + d.table_name);
                            }
                        }
                        if (st && d.status) st.textContent = d.status;
                        // ★ 只要收到任意消息就刷新心跳时间（不管 percent 是否变化）
                        lastProgressTime = Date.now();
                    }
                }
            });
            // 卡住检测：进度超过 120 秒没变化则超时（大表复制可能很慢）
            if (!done && lastProgress >= 0 && (Date.now() - lastProgressTime) > 120000) {
                done = true;
                clearInterval(pollTimer);
                document.getElementById('modal_overlay').classList.remove('show');
                showErrorDialog('复制超时', '进度超过30秒未更新，可能连接已断开');
            }
        }, 200);

        eel.drag_copy_tables(srcConn, srcDb, names, dstConn, targetDb, copyData, dropExisting)(function(r) {
            if (done) return;
            done = true;
            clearInterval(pollTimer);
            // 确保进度条到 100%
            var bar = document.getElementById('drag_copy_bar');
            var st = document.getElementById('drag_copy_status');
            if (bar) bar.style.width = '100%';
            if (st) st.textContent = r && r.ok ? '✅ 完成' : '❌ 失败';
            setTimeout(function() {
                document.getElementById('modal_overlay').classList.remove('show');
                if (r && r.ok) {
                    showOkDialog('导入成功', r.msg);
                    setTimeout(function(){ refreshTableFolder(targetCid, targetDb, ''); }, 500);
                } else {
                    showErrorDialog(r && r.precheck ? '导入前检查' : '导入失败', r ? r.msg : '无响应');
                }
            }, 400);
        });
    };
}

function execDragCopy(tn, srcDb, schema, srcConn, targetCid, targetDb, dstConn, copyData) {
    // 兼容旧调用，实际由 startDragCopy2 处理
    showDragCopyDialog(tn, srcDb, schema, srcConn, targetCid, targetDb, dstConn);
}

// ==================== 拖拽移动连接到文件夹 ====================
function onConnDragStart(e, cid) {
    var c = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!c) return;
    _connDragInfo = { cid: cid, fromParent: c.parent || '' };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cid);
    // 视觉反馈
    var el = e.target;
    setTimeout(function(){ if(el) el.style.opacity = '0.5'; }, 0);
}

function onConnDragEnd(e, cid) {
    var el = e.target;
    if (el) el.style.opacity = '';
    // 清理所有文件夹高亮
    var allFolders = document.querySelectorAll('.drop-folder.drop-target');
    for (var i = 0; i < allFolders.length; i++) { allFolders[i].classList.remove('drop-target'); }
    var root = document.getElementById('my_conn_list');
    if (root) root.classList.remove('drop-target');
    _connDragInfo = null;
}

function onConnFolderDragOver(e, el, fid) {
    if (!_connDragInfo) return;
    e.preventDefault();
    e.stopPropagation();
    // 不能拖到自己当前所在文件夹
    if (_connDragInfo.fromParent === fid) {
        e.dataTransfer.dropEffect = 'none';
        return;
    }
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
}

function onConnFolderDragLeave(e, el) {
    el.classList.remove('drop-target');
}

function onConnFolderDrop(e, fid) {
    e.preventDefault();
    e.stopPropagation();
    if (!_connDragInfo) return;
    var cid = _connDragInfo.cid;
    // 清理高亮
    var allFolders = document.querySelectorAll('.drop-folder.drop-target');
    for (var i = 0; i < allFolders.length; i++) { allFolders[i].classList.remove('drop-target'); }

    // 不能拖到自己当前所在文件夹
    if (_connDragInfo.fromParent === fid) {
        _connDragInfo = null;
        return;
    }

    eel.tree_move_connection(cid, fid)(function(r){
        if (r && r.ok) {
            // 更新内存数据
            treeData.connections[cid].parent = fid;
            // DOM 移动
            moveConnNode(cid, fid);
        } else {
            showErrorDialog('移动失败', r ? r.msg : '操作失败');
        }
    });
    _connDragInfo = null;
}

// 拖到根区域（移出所有文件夹）
function onConnRootDragOver(e) {
    if (!_connDragInfo) return;
    e.preventDefault();
    // 不能从根拖到根
    if (!_connDragInfo.fromParent) {
        e.dataTransfer.dropEffect = 'none';
        return;
    }
    e.dataTransfer.dropEffect = 'move';
    document.getElementById('my_conn_list').classList.add('drop-target');
}

function onConnRootDragLeave(e) {
    document.getElementById('my_conn_list').classList.remove('drop-target');
}

function onConnRootDrop(e) {
    e.preventDefault();
    if (!_connDragInfo) return;
    var cid = _connDragInfo.cid;
    document.getElementById('my_conn_list').classList.remove('drop-target');

    if (!_connDragInfo.fromParent) {
        _connDragInfo = null;
        return;
    }

    eel.tree_move_connection(cid, '')(function(r){
        if (r && r.ok) {
            treeData.connections[cid].parent = '';
            moveConnNode(cid, '');
        } else {
            showErrorDialog('移动失败', r ? r.msg : '操作失败');
        }
    });
    _connDragInfo = null;
}

// 计算文件夹在树中的嵌套深度
function getFolderDepth(fid) {
    var depth = 0;
    var current = fid;
    while (current) {
        var parent = '';
        for (var i = 0; i < (treeData.folders || []).length; i++) {
            if (treeData.folders[i].id === current) {
                parent = treeData.folders[i].parent || '';
                break;
            }
        }
        if (parent) { depth++; current = parent; }
        else break;
    }
    return depth;
}

// 从 DOM 中移动连接节点到新位置
function moveConnNode(cid, toFid) {
    var c = treeData.connections[cid];
    if (!c) return;

    // 移除原节点
    var oldNode = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    if (oldNode) oldNode.remove();

    // 重新渲染（带正确缩进）
    var indent = toFid ? getFolderDepth(toFid) * 16 + 16 : 0;
    var html = renderConn(c, indent);

    // 插入目标容器
    if (toFid) {
        var container = document.getElementById('mc_' + toFid);
        if (container) {
            // 如果文件夹未展开则先展开
            if (!container.classList.contains('open')) {
                container.classList.add('open');
                var arrow = document.getElementById('ma_' + toFid);
                if (arrow) { arrow.textContent = '▾'; arrow.style.visibility = 'visible'; }
            } else {
                var arrow = document.getElementById('ma_' + toFid);
                if (arrow) arrow.style.visibility = 'visible';
            }
            container.insertAdjacentHTML('beforeend', html);
        } else {
            // 容器不存在（极端情况），放到根
            document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderConn(c, 0));
        }
    } else {
        document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', html);
    }
}
