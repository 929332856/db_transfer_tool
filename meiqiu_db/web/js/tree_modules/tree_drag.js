// ==================== 拖拽复制表 ====================
var _dragInfo = null; // {table_name, src_db, schema, src_cid}
// ==================== 拖拽移动连接 ====================
var _connDragInfo = null; // {cid, fromParent} — 当前正在拖拽的连接

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
    _dragInfo = { table_name: tn, src_db: db, schema: schema || '', src_cid: cid };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', tn);
}

function onTableDragEnd(e) {
    var el = e.target;
    if (el) el.classList.remove('dragging');
    _dragInfo = null;
}

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

    // 弹出选择框：仅结构 或 结构+数据
    showDragCopyDialog(src.table_name, src.src_db, src.schema, srcConn, targetCid, targetDb, dstConn);
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

    showDragCopyDialog(src.table_name, src.src_db, src.schema, srcConn, targetCid, targetDb, dstConn);
    _dragInfo = null;
}

function showDragCopyDialog(tn, srcDb, schema, srcConn, targetCid, targetDb, dstConn) {
    document.getElementById('modal_icon').innerHTML = '📋';
    document.getElementById('modal_title').textContent = '复制表：' + tn;
    document.getElementById('modal_msg').innerHTML = '<div>从：<b>' + escapeHtml(srcConn.name||srcConn.host) + '</b> / ' + escapeHtml(srcDb) + '</div><div style="margin-top:4px;">到：<b>' + escapeHtml(dstConn.name||dstConn.host) + '</b> / ' + escapeHtml(targetDb) + '</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-blue" style="font-size:12px;" onclick="startDragCopy2(false)">📐 仅表结构</button><button class="btn btn-green" style="font-size:12px;" onclick="startDragCopy2(true)">📊 结构 + 数据</button>';
    document.getElementById('modal_overlay').classList.add('show');

    window.startDragCopy2 = function(copyData) {
        document.getElementById('modal_icon').innerHTML = '⏳';
        document.getElementById('modal_title').textContent = '复制中...';
        document.getElementById('modal_msg').innerHTML = '<div class="progress-bar" style="margin:8px 0;height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;"><div id="drag_copy_bar" class="progress-fill" style="width:0%;height:100%;background:#4CAF50;border-radius:4px;transition:width 0.3s;"></div></div><div id="drag_copy_status" style="font-size:11px;color:#888;">正在连接...</div><button class="btn btn-sm" style="margin-top:8px;background:#e74c3c;color:#fff;font-size:10px;" onclick="cancelDragCopy()">⏹ 取消</button>';
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
                                lastProgressTime = Date.now();
                            }
                        }
                        if (st && d.status) st.textContent = d.status;
                    }
                }
            });
            // 卡住检测：进度超过 30 秒没变化则超时
            if (!done && lastProgress >= 0 && (Date.now() - lastProgressTime) > 30000) {
                done = true;
                clearInterval(pollTimer);
                document.getElementById('modal_overlay').classList.remove('show');
                showErrorDialog('复制超时', '进度超过30秒未更新，可能连接已断开');
            }
        }, 200);

        eel.drag_copy_table(srcConn, srcDb, tn, dstConn, targetDb, copyData)(function(r) {
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
                    showOkDialog('复制成功', r.msg);
                    setTimeout(function(){ refreshTableFolder(targetCid, targetDb, ''); }, 500);
                } else {
                    showErrorDialog('复制失败', r ? r.msg : '无响应');
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
