// ==================== 对象面板 ====================

/** 解析 tab 提示信息（连接/分组/数据库/表） */
function _buildTabTipInfo(tab) {
    if (!tab) return null;
    var cid = tab.cid || '';
    var db = tab.db || '';
    var name = tab.label || '';
    if (!cid) return null;
    var conn = (treeData && treeData.connections) ? treeData.connections[cid] : null;
    if (!conn) return null;
    var connName = conn.name || conn.host || '未知连接';
    // 分组：递归查找父文件夹链，用 ">" 连接
    var folder = '';
    try {
        var cur = conn.parent || '';
        var segs = [];
        while (cur) {
            var f = (treeData.folders || []).find(function(x){return x.id === cur;});
            if (!f) break;
            segs.unshift(f.name);
            cur = f.parent || '';
        }
        folder = segs.join(' / ') || '根目录';
    } catch (e) {
        folder = '根目录';
    }
    return { conn: connName, folder: folder, db: db || '—', name: name };
}

/** 弹出 tab 提示卡 */
function _showTabTip(e, el) {
    _hideTabTip();
    if (!el || !el.getAttribute('data-tip-conn')) return;
    var tip = document.createElement('div');
    tip.id = '_tab_tip_popup';
    tip.className = 'tab-tip-popup';
    tip.innerHTML =
        '<div class="tab-tip-row"><span class="tab-tip-key">连接：</span><span class="tab-tip-val">' + escapeHtml(el.getAttribute('data-tip-conn')) + '</span></div>' +
        '<div class="tab-tip-row"><span class="tab-tip-key">分组：</span><span class="tab-tip-val">' + escapeHtml(el.getAttribute('data-tip-folder')) + '</span></div>' +
        '<div class="tab-tip-row"><span class="tab-tip-key">数据库：</span><span class="tab-tip-val">' + escapeHtml(el.getAttribute('data-tip-db')) + '</span></div>' +
        '<div class="tab-tip-row"><span class="tab-tip-key">表：</span><span class="tab-tip-val">' + escapeHtml(el.getAttribute('data-tip-name')) + '</span></div>';
    document.body.appendChild(tip);
    // 定位：tab 下方居中
    var rect = el.getBoundingClientRect();
    var tipRect = tip.getBoundingClientRect();
    var left = rect.left + rect.width / 2 - tipRect.width / 2;
    var top = rect.bottom + 6;
    // 防止超出屏幕右边
    if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
    if (left < 4) left = 4;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    _tabTipEnterTimer = setTimeout(function(){ tip.classList.add('show'); }, 60);
}

/** 隐藏 tab 提示卡 */
function _hideTabTip() {
    if (_tabTipEnterTimer) { clearTimeout(_tabTipEnterTimer); _tabTipEnterTimer = null; }
    var tip = document.getElementById('_tab_tip_popup');
    if (tip) tip.remove();
}
var _tabTipEnterTimer = null;

// ★ 全局兜底：鼠标移出 tab 栏区域时强制关闭 tip（避免 tab 被关闭/重建后 tip 残留）
(function initTabTipGlobalHide() {
    function onMove(e) {
        var tip = document.getElementById('_tab_tip_popup');
        if (!tip) return;
        var tabBar = document.getElementById('obj_tabs_bar');
        if (!tabBar) return;
        var t = e.target;
        // 鼠标在 tab 上或 tip 上 → 保留；否则关闭
        if (tabBar.contains(t) || tip.contains(t)) return;
        _hideTabTip();
    }
    document.addEventListener('mousemove', onMove);
})();

function buildObjHomeContent(items, cat, db, schema, cid) {
    var sch = schema || '';
    var h = '';
    if (cat === 'tables') {
        h += '<table class="exp-table"><thead><tr><th style="width:28%">名称</th><th style="width:10%;text-align:right;">行</th><th style="width:12%;text-align:right;">数据长度</th><th style="width:22%">修改日期</th><th style="width:28%">注释</th></tr></thead><tbody>';
        items.forEach(function(t){
            var rowsVal = t.rows === '' || t.rows === null || t.rows === undefined ? '--' : t.rows;
            var sizeVal = t.data_size || '--';
            var timeVal = t.update_time || '--';
            var cmtVal = t.comment || '';
            h += '<tr draggable="true" class="drag-table-item" data-tname="'+escapeAttr(t.name)+'" data-db="'+escapeAttr(db)+'" data-sch="'+escapeAttr(sch)+'" data-cid="'+escapeAttr(cid||'')+'" ondragstart="onTableDragStart(event,\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')" ondragend="onTableDragEnd(event)" ondblclick="addTableDataTab(\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')" oncontextmenu="tableCtx(event,\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')" onclick="objPanelTableClick(event,this)"><td class="tbl-name-cell">'+escapeHtml(t.name)+'</td><td style="text-align:right;">'+escapeHtml(String(rowsVal))+'</td><td style="text-align:right;">'+escapeHtml(sizeVal)+'</td><td>'+escapeHtml(timeVal)+'</td><td>'+escapeHtml(cmtVal)+'</td></tr>';
        });
        h += '</tbody></table>';
    } else if (cat === 'views') {
        h += '<table class="exp-table"><thead><tr><th style="width:60%">名称</th><th style="width:40%">数据库</th></tr></thead><tbody>';
        items.forEach(function(v){h+='<tr><td>'+escapeHtml(v.name)+'</td><td>'+escapeHtml(db)+'</td></tr>';});
        h += '</tbody></table>';
    } else {
        h += '<table class="exp-table"><thead><tr><th style="width:50%">名称</th><th style="width:30%">类型</th><th style="width:20%">数据库</th></tr></thead><tbody>';
        items.forEach(function(p){h+='<tr><td>'+escapeHtml(p.name)+'</td><td>'+escapeHtml(p.type||cat)+'</td><td>'+escapeHtml(db)+'</td></tr>';});
        h += '</tbody></table>';
    }
    if (!items.length) h += '<div style="padding:20px;color:#999;">（无数据）</div>';
    else {
        var catLabel = cat==='tables'?'张表':cat==='views'?'个视图':cat==='procedures'?'个存储过程':cat==='functions'?'个函数':'项';
        h += '<div style="text-align:right;padding:4px 10px;color:#666;font-size:11px;">共 '+items.length+' '+catLabel+'</div>';
    }
    return h;
}

// 对象面板接受拖拽 drop（拖表到对象窗口 = 同步到当前显示的数据库）
function setupObjectPanelDrop() {
    var panel = document.getElementById('object_panel');
    if (!panel || panel._dropReady) return;
    panel._dropReady = true;
    panel.addEventListener('dragover', function(e) {
        if (!_dragInfo || !activeConnId || !activeDatabase) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        // 拖拽源来自对象面板内部时不显示高亮
        if (!panel.contains(e.target) || _dragInfo.src_cid !== activeConnId) {
            panel.classList.add('drop-target');
        }
    });
    panel.addEventListener('dragleave', function(e) {
        // 对象面板内部元素较多，直接用 relatedTarget 判断是否真正离开面板
        if (!panel.contains(e.relatedTarget)) {
            panel.classList.remove('drop-target');
        }
    });
    panel.addEventListener('drop', function(e) {
        e.preventDefault();
        panel.classList.remove('drop-target');
        if (!_dragInfo || !activeConnId || !activeDatabase) return;
        var src = _dragInfo;
        var srcConn = treeData && treeData.connections ? treeData.connections[src.src_cid] : null;
        var dstConn = treeData && treeData.connections ? treeData.connections[activeConnId] : null;
        if (!srcConn || !dstConn) return;
        if (src.src_cid === activeConnId && src.src_db === activeDatabase) {
            showWarnDialog('提示', '不能将表导入到自身所在的目标库');
            _dragInfo = null;
            return;
        }
        showDragCopyDialog(src.table_names || [src.table_name], src.src_db, src.schema, srcConn, activeConnId, activeDatabase, dstConn);
        _dragInfo = null;
    });
}

// ★ 只更新 tab 栏 DOM（不重新渲染内容面板，避免跳转到其他 tab）
function _updateTabBar() {
    var tabBar = document.getElementById('obj_tabs_bar');
    if (!tabBar) return;
    var h = '';
    objectTabs.forEach(function(t){
        var cls = t.id===activeObjTab?'obj-tab active':'obj-tab';
        var icon = t.type==='ddl'?'🔧 ':t.type==='data'?((window.MQ_ICON&&window.MQ_ICON.table)||'📊')+' ':t.type==='query'?'📝 ':'📋 ';
        var ctxAttr = t.id === 'obj_home' ? ' oncontextmenu="event.preventDefault();event.stopPropagation()"' : ' oncontextmenu="objTabContextMenu(event,\''+escapeAttr(t.id)+'\')"';
        var tipAttr = '';
        if (t.type === 'data' || t.type === 'ddl' || t.type === 'query') {
            var info = _buildTabTipInfo(t);
            if (info) {
                tipAttr = ' data-tip-conn="'+escapeAttr(info.conn)+'" data-tip-folder="'+escapeAttr(info.folder)+'" data-tip-db="'+escapeAttr(info.db)+'" data-tip-name="'+escapeAttr(info.name)+'"';
            }
        }
        h += '<span class="'+cls+'" data-tabid="'+t.id+'"'+tipAttr+ctxAttr+' onclick="switchObjTab(\''+t.id+'\')" onmouseenter="_showTabTip(event,this)" onmouseleave="_hideTabTip()">'+icon+escapeHtml(t.label);
        if(t.id!=='obj_home') h += '<span class="tab-close" onclick="event.stopPropagation();closeTab(\''+t.id+'\')">✕</span>';
        h += '</span>';
    });
    var showSearch = (activeObjTab === 'obj_home');
    h += '<div class="obj-search-wrap" style="display:' + (showSearch ? '' : 'none') + '"><input class="obj-search-input" id="obj_search" placeholder="🔍 搜索表名..." oninput="filterObjectTable()"></div>';
    tabBar.innerHTML = h;
    collapseOverflowTabs();
}

// 记录/恢复数据表滚动容器的位置。表格 tab 的内容切换时会重建 DOM，
// 因此不能依赖浏览器自动保留 scrollTop/scrollLeft。
function _saveTableScrollPosition(tabId) {
    if (!tabId || typeof _tableScrollStates === 'undefined') return;
    var contentDiv = document.getElementById('obj_content');
    if (!contentDiv) return;
    var scrollWrap = contentDiv.querySelector('.data-table-scroll');
    if (!scrollWrap) return;
    _tableScrollStates[tabId] = {
        top: scrollWrap.scrollTop,
        left: scrollWrap.scrollLeft
    };
}

function _bindTableScrollPosition(tabId, contentDiv) {
    if (!tabId || !contentDiv || typeof _tableScrollStates === 'undefined') return;
    var scrollWrap = contentDiv.querySelector('.data-table-scroll');
    if (!scrollWrap || scrollWrap.getAttribute('data-scroll-state-tab') === tabId) return;
    scrollWrap.setAttribute('data-scroll-state-tab', tabId);
    scrollWrap.addEventListener('scroll', function() {
        _tableScrollStates[tabId] = {
            top: scrollWrap.scrollTop,
            left: scrollWrap.scrollLeft
        };
    }, {passive: true});
}

function _restoreTableScrollPosition(tabId) {
    if (!tabId || typeof _tableScrollStates === 'undefined') return;
    var state = _tableScrollStates[tabId];
    if (!state) return;
    var apply = function() {
        if (activeObjTab !== tabId) return;
        var contentDiv = document.getElementById('obj_content');
        var scrollWrap = contentDiv && contentDiv.querySelector('.data-table-scroll');
        if (!scrollWrap) return;
        scrollWrap.scrollTop = state.top || 0;
        scrollWrap.scrollLeft = state.left || 0;
    };
    // 本地 render 也会重建 tbody，分几个时机恢复，确保表格高度更新后仍能回到原位置。
    setTimeout(apply, 0);
    setTimeout(apply, 50);
    setTimeout(apply, 150);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
}

function renderObjectPanel() {
    // ★ 保存当前 tab 的编辑状态
    _saveCurrentTabState(activeObjTab);
    // ★ 缓存当前 textarea DOM 元素（保留原生 undo 历史）
    _cacheTextareas();

    // 增量更新 tab 栏和内容区域，避免全量 innerHTML 重建
    var panel = document.getElementById('object_panel');
    var tabBar = document.getElementById('obj_tabs_bar');
    var h = '';
    objectTabs.forEach(function(t){
        var cls = t.id===activeObjTab?'obj-tab active':'obj-tab';
        var icon = t.type==='ddl'?'🔧 ':t.type==='data'?((window.MQ_ICON&&window.MQ_ICON.table)||'📊')+' ':t.type==='query'?'📝 ':'📋 ';
        var ctxAttr = t.id === 'obj_home' ? ' oncontextmenu="event.preventDefault();event.stopPropagation()"' : ' oncontextmenu="objTabContextMenu(event,\''+escapeAttr(t.id)+'\')"';
        var tipAttr = '';
        // ★ data/ddl/query 类型的 tab 添加悬停提示（连接/分组/数据库/表）
        if (t.type === 'data' || t.type === 'ddl' || t.type === 'query') {
            var info = _buildTabTipInfo(t);
            if (info) {
                tipAttr = ' data-tip-conn="'+escapeAttr(info.conn)+'" data-tip-folder="'+escapeAttr(info.folder)+'" data-tip-db="'+escapeAttr(info.db)+'" data-tip-name="'+escapeAttr(info.name)+'"';
            }
        }
        h += '<span class="'+cls+'" data-tabid="'+t.id+'"'+tipAttr+ctxAttr+' onclick="switchObjTab(\''+t.id+'\')" onmouseenter="_showTabTip(event,this)" onmouseleave="_hideTabTip()">'+icon+escapeHtml(t.label);
        if(t.id!=='obj_home') h += '<span class="tab-close" onclick="event.stopPropagation();closeTab(\''+t.id+'\')">✕</span>';
        h += '</span>';
    });
    var showSearch = (activeObjTab === 'obj_home'); 
    h += '<div class="obj-search-wrap" style="display:' + (showSearch ? '' : 'none') + '"><input class="obj-search-input" id="obj_search" placeholder="🔍 搜索表名..." oninput="filterObjectTable()"></div>';

    if (tabBar) {
        // 增量更新 tab 栏（避免 innerHTML 销毁重建事件）
        _updateTabBar();
    } else {
        // 首次渲染：创建完整结构
        var at = objectTabs.find(function(t){return t.id===activeObjTab;});
        panel.innerHTML = '<div class="obj-tabs" id="obj_tabs_bar">' + h + '</div><div class="obj-content" id="obj_content">' + (at ? at.content : '') + '</div>';
        setTimeout(function() {
            collapseOverflowTabs();
            highlightTableRow();
            setupObjectPanelDrop();
            _setupObjPanelCtx();
        }, 50);
        return;
    }

    // 增量更新内容区域
    var contentDiv = document.getElementById('obj_content');
    var at2 = objectTabs.find(function(t){return t.id===activeObjTab;});
    if (contentDiv && at2) {
        contentDiv.innerHTML = at2.content;
        // ★ 恢复缓存的 textarea/results DOM 元素（保留原生 undo 历史）
        _restoreTextareas(contentDiv);
        // ★ data/redis 类型 tab 切换后，重新调用本地 render 填充 tbody
        //    不触发 _serverReload，避免切换连接/数据库时重复请求服务端
        if (at2.type === 'data' || at2.type === 'redis') {
            var tid2 = _tabIdToTid[activeObjTab];
            if (tid2) {
                var renderLocalFn = window['_renderLocal_'+tid2];
                if (renderLocalFn) {
                    setTimeout(function(){ renderLocalFn(); }, 0);
                }
                // ★ 重新绑定排序事件（DOM 重建后旧监听器已丢失）
                var bindSortFn = window['_bindSort_'+tid2];
                if (bindSortFn) {
                    setTimeout(function(){ bindSortFn(); }, 50);
                }
                // ★ 分页按钮已使用内联 onclick，无需重新绑定
            }
        }
        // ★ query 类型 tab 切换后，重新绑定事件 + 恢复结果（保留数据不丢失）
        if (at2.type === 'query') {
            var qm = activeObjTab.match(/^query_(.+)$/);
            if (qm) {
                var qid3 = qm[1];
                // ★ 检查查询是否仍在后端运行（不随意清除 _execRunning）
                var wasRunningRP = !!_execRunning[qid3];
                var elapsedRP = Date.now() - (_execStartTime[qid3] || 0);
                if (wasRunningRP && elapsedRP > 130000) {
                    _execRunning[qid3] = false;
                    _execCancelFlags[qid3] = false;
                    wasRunningRP = false;
                }
                if (wasRunningRP && _execCancelFlags[qid3]) {
                    wasRunningRP = false;
                }
                // ★ 重新绑定 textarea 事件（使用 setTimeout 确保 DOM 完全构建）
                (function(qidX, isRunningRP) {
                    setTimeout(function() {
                        var esX = _queryEditStates[qidX];
                        var sqlTa = document.getElementById('sq_' + qidX);
                        var sqlBtn = document.getElementById('btn_exe_' + qidX);
                        if (!sqlTa || !sqlBtn) return;
                        // ★ 根据运行状态设置按钮
                        if (isRunningRP) {
                            sqlBtn.textContent = '⏹ 取消';
                            sqlBtn.style.background = '#e74c3c';
                        } else {
                            sqlBtn.textContent = '▶ 执行';
                            sqlBtn.style.background = '#2ecc71';
                        }
                        // ★ 先恢复 textarea value
                        if (esX && Object.prototype.hasOwnProperty.call(esX, '_cachedSql')) {
                            sqlTa.value = esX._cachedSql;
                        } else {
                            var cachedTab = objectTabs.find(function(t){ return t.id === 'query_' + qidX; });
                            if (cachedTab && Object.prototype.hasOwnProperty.call(cachedTab, '_cachedSql')) {
                                sqlTa.value = cachedTab._cachedSql;
                            }
                        }
                        // 更新按钮标签 + 绑定所有必要事件
                        var updateBtnLabel = function() {
                            if (!sqlBtn || sqlBtn.textContent.indexOf('⏹') === 0) return;
                            if (!sqlTa) return;
                            var s = sqlTa.selectionStart, e = sqlTa.selectionEnd;
                            sqlBtn.textContent = (s !== e) ? '▶ 执行选中' : '▶ 执行';
                        };
                        sqlTa.addEventListener('mouseup', updateBtnLabel);
                        sqlTa.addEventListener('keyup', updateBtnLabel);
                        sqlTa.addEventListener('input', function(){ _queryTextareaChanged(qidX, sqlTa); _syncLineGutter(qidX, sqlTa); });
                        // ★ 重新绑定 Ctrl+Enter 执行和 Ctrl+S 保存
                        var curTab = objectTabs.find(function(t){ return t.id === 'query_' + qidX; });
                        var cid2 = curTab ? curTab.cid : '';
                        var qdb2 = curTab ? curTab.db : '';
                        sqlTa.addEventListener('keydown', function(e){
                            if(e.ctrlKey && e.key === 'Enter') { e.preventDefault(); execQueryTab(qidX); }
                            if(e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); _handleSaveQuery(qidX, cid2, qdb2); }
                        });
                        updateBtnLabel();
                        // 内容从缓存 textarea 恢复后，重新生成新建的行号栏。
                        if (typeof _syncLineGutter === 'function') {
                            _syncLineGutter(qidX, sqlTa);
                            requestAnimationFrame(function(){ _syncLineGutter(qidX, sqlTa); });
                        }
                    }, 0);
                })(qid3, wasRunningRP);
                // ★ 恢复查询结果：优先从结构化数据重新渲染（最可靠），其次从缓存 HTML 恢复
                var es = _queryEditStates[qid3];
                (function(qidR, esR, isRunningRP2) {
                    function doRestore() {
                        var rdiv = document.getElementById('qr_' + qidR);
                        if (!rdiv) return;
                        // ★ 如果查询仍在运行，显示执行中状态，不渲染旧数据
                        if (isRunningRP2) {
                            rdiv.innerHTML = '<div style="padding:10px;color:#999;display:flex;align-items:center;gap:10px;"><span>⏳ 执行中...</span><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:3px 10px;" onclick="cancelExecQuery(\''+qidR+'\')">⏹ 取消</button></div>';
                            return;
                        }
                        if (esR && esR.columns && esR.columns.length > 0 && !esR._execJustStarted) {
                            _qRenderTable(qidR);
                            return;
                        }
                        var hasResults = rdiv.querySelector('.exp-table') || rdiv.querySelector('table');
                        var textOnly = rdiv.textContent.trim();
                        var hasUsefulText = textOnly && textOnly !== '' && !/^\s*$/.test(textOnly);
                        if (!hasResults && !hasUsefulText && esR && esR._cachedHtml) {
                            rdiv.innerHTML = esR._cachedHtml;
                        }
                    }
                    setTimeout(doRestore, 20);
                    // ★ 二次确认，防止时序导致结果被清空
                    setTimeout(function() {
                        var rdiv2 = document.getElementById('qr_' + qidR);
                        if (!rdiv2) return;
                        if (isRunningRP2) return;
                        var hasTable2 = rdiv2.querySelector('.exp-table') || rdiv2.querySelector('table');
                        var txt2 = rdiv2.textContent.trim();
                        var empty2 = !hasTable2 && (!txt2 || /^\s*$/.test(txt2));
                        if (empty2 && esR && esR.columns && esR.columns.length > 0 && !esR._execJustStarted) {
                            _qRenderTable(qidR);
                        } else if (empty2 && esR && esR._cachedHtml) {
                            rdiv2.innerHTML = esR._cachedHtml;
                        }
                    }, 80);
                })(qid3, es, wasRunningRP);
            }
        }
    }

    // 延迟执行次要任务：恢复 splitter 绑定、溢出 tab 处理等
    requestAnimationFrame(function() {
        collapseOverflowTabs();
        highlightTableRow();
        setupObjectPanelDrop();
        // ★ 重建后重新应用对象面板搜索（保留用户搜索状态）
        _restoreObjSearch();
        // 为所有 query layout 重新绑定分隔线拖动
        var layouts = contentDiv ? contentDiv.querySelectorAll('.query-layout') : [];
        for (var li = 0; li < layouts.length; li++) {
            var layoutEl = layouts[li];
            if (!layoutEl.id || layoutEl.id.indexOf('ql_') !== 0) continue;
            var qid2 = layoutEl.id.substring(3);
            // ★ 先清除标记，因为 innerHTML 已重建 DOM，旧事件监听器已失效
            delete _querySplitterInited['qs_' + qid2];
            initQuerySplitter('ql_' + qid2, 'qs_' + qid2, 'sq_' + qid2, 'qr_' + qid2);
        }
    });
}

// ★ 查询修改状态追踪：{qid: true/false}
var _queryModified = {};
// ★ 查询原始 SQL（打开/保存时的快照，用于判断是否有修改）
var _querySavedSql = {};

function _queryTextareaChanged(qid, ta) {
    if (!qid || !ta) return;
    var es = _qState(qid);
    es._cachedSql = ta.value;
    var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
    if (tab) {
        tab._cachedSql = ta.value;
        // ★ 追踪修改状态：当前 SQL 与保存时的快照对比
        var savedSql = _querySavedSql[qid];
        var isModified = (savedSql === undefined) ? false : (ta.value !== savedSql);
        _setQueryModified(qid, isModified);
    }
}

// ★ 设置查询修改状态并更新 tab 标题
function _setQueryModified(qid, modified) {
    _queryModified[qid] = modified;
    var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
    if (!tab) return;
    var baseLabel = tab._baseLabel || tab.label;
    if (modified) {
        tab.label = baseLabel + ' *';
    } else {
        tab.label = baseLabel;
    }
    // ★ 增量更新 tab 栏中的标题（避免重建整个 tab 栏）
    var tabEl = document.querySelector('.obj-tab[data-tabid="query_' + qid + '"]');
    if (tabEl) {
        var icon = '📝 ';
        var tipContent = tabEl.querySelector('.tab-close') ? tabEl.innerHTML.replace(/<span class="tab-close".*/, '') : tabEl.innerHTML;
        // 保留 icon + label，不破坏 close 按钮
        var closeHtml = tabEl.querySelector('.tab-close');
        tabEl.childNodes.forEach(function(n) {
            if (n.nodeType === 3) { n.textContent = icon + escapeHtml(tab.label); return; }
            if (n === closeHtml) return;
        });
        // 重建内容
        var html = icon + escapeHtml(tab.label);
        if (closeHtml) html += closeHtml.outerHTML;
        tabEl.innerHTML = html;
    }
}

// ★ 对象面板搜索关键词缓存（CV/刷新重建后重新应用过滤）
var _objSearchKw = '';

function filterObjectTable() {
    var kw = (document.getElementById('obj_search')||{}).value||'';
    kw = String(kw).trim();
    _objSearchKw = kw;

    // ★ Redis 面板：服务端搜索，遍历所有 key
    if (_redisPanelCtx && activeObjTab === 'obj_home') {
        clearTimeout(_redisSearchTimer);
        if (!kw) {
            _redisSearchSeq++;
            _restoreRedisKeysPanel(_redisPanelCtx);
            return;
        }
        var searchCtx = {
            cid: _redisPanelCtx.cid,
            dbIdx: _redisPanelCtx.dbIdx,
            dbId: _redisPanelCtx.dbId
        };
        var searchSeq = ++_redisSearchSeq;
        _redisSearchTimer = setTimeout(function() {
            _redisDoServerSearch(searchCtx.cid, searchCtx.dbIdx, searchCtx.dbId, kw, searchSeq);
        }, 300);
        return;
    }

    var content = document.getElementById('obj_content');
    if (!content) return;
    var rows = content.querySelectorAll('.exp-table tbody tr');
    var cnt = 0;
    rows.forEach(function(tr){
        // 找到第一个 td（通常是名称列）
        var td = tr.querySelector('td');
        if (!td) return;
        var text = (td.textContent || '').toLowerCase();
        var match = !kw || text.indexOf(kw.toLowerCase()) !== -1;
        tr.style.display = match ? '' : 'none';
        if (match) cnt++;
    });
    // 更新计数
    var infoEl = content.querySelector('.obj-search-info');
    if (!kw) {
        if (infoEl) infoEl.textContent = '';
    } else {
        if (!infoEl) {
            infoEl = document.createElement('div');
            infoEl.className = 'obj-search-info';
            infoEl.style.cssText = 'padding:2px 10px;color:#888;font-size:11px;text-align:right;';
            var tbl = content.querySelector('.exp-table');
            if (tbl && tbl.parentElement) tbl.parentElement.insertBefore(infoEl, tbl);
        }
        infoEl.textContent = '搜索：' + cnt + ' 个匹配';
    }
}

// ★ 重建对象面板后恢复搜索关键词并重新过滤（CV 表/刷新后不丢搜索状态）
function _restoreObjSearch() {
    if (activeObjTab !== 'obj_home') return;
    var input = document.getElementById('obj_search');
    if (!input) return;
    if (!_objSearchKw) return;
    input.value = _objSearchKw;
    // Redis 搜索结果已经由服务端生成，重建 DOM 时只恢复输入框，不能再次触发搜索。
    if (_redisPanelCtx && activeObjTab === 'obj_home') return;
    filterObjectTable();
}

// ★ 切换其他库/分类时清空对象面板搜索（避免旧关键词过滤到新库的表）
function clearObjSearch() {
    _objSearchKw = '';
    clearTimeout(_redisSearchTimer);
    _redisSearchSeq++;
    var input = document.getElementById('obj_search');
    if (input) input.value = '';
    if (_redisPanelCtx && activeObjTab === 'obj_home') {
        _restoreRedisKeysPanel(_redisPanelCtx);
    }
}

var _redisSearchTimer = null;
var _redisSearchSeq = 0;

// Restore the cached Redis key list without issuing another SCAN request.
function _restoreRedisKeysPanel(ctx) {
    if (!ctx || activeObjTab !== 'obj_home') return;
    if (!_redisPanelCtx || _redisPanelCtx.dbId !== ctx.dbId ||
        _redisPanelCtx.cid !== ctx.cid || _redisPanelCtx.dbIdx !== ctx.dbIdx) return;

    var cache = _redisKeysCache[ctx.dbId];
    if (!cache || !cache.keys) return;
    var home = objectTabs.find(function(t) { return t.id === 'obj_home'; });
    if (!home) return;

    var displayKeys = cache.keys.slice(0, 100);
    home.content = buildRedisKeyListContent(
        ctx.cid, ctx.dbIdx, ctx.dbId, displayKeys, cache.total,
        cache.keys.length < cache.total, cache
    );
    renderObjectPanel();
    redisLoadKeysMeta(ctx.cid, ctx.dbIdx, ctx.dbId, displayKeys);
}
// 服务端搜索：用 SCAN + match pattern 遍历全部 key
function _redisDoServerSearch(cid, dbIdx, dbId, kw, searchSeq) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;

    var pattern = kw ? '*' + kw + '*' : '*';
    // 搜索时限制放宽到 500 条，用 SCAN 遍历全部
    eel.redis_get_keys(conn, pattern, 500, dbIdx)(function(r) {
        if (searchSeq !== _redisSearchSeq || !_redisPanelCtx ||
            _redisPanelCtx.cid !== cid || _redisPanelCtx.dbIdx !== dbIdx ||
            _redisPanelCtx.dbId !== dbId || activeObjTab !== 'obj_home') return;
        if (!r || !r.ok) return;
        var keys = [];
        (r.groups || []).forEach(function(g) { keys = keys.concat(g.keys); });
        var total = keys.length;
        var displayKeys = keys.slice(0, 500);
        var content = '<div style="padding:2px 10px;color:#888;font-size:11px;">搜索 "' + escapeHtml(kw) + '"：共 ' + total + ' 个 key'
            + (keys.length > 500 ? '（显示前 500 个）' : '') + '</div>';
        content += '<table class="exp-table"><thead><tr><th style="width:60%">Key</th><th style="width:40%;text-align:right;">类型</th></tr></thead><tbody>';
        displayKeys.forEach(function(k) {
            content += '<tr class="redis-key-row" style="" ondblclick="redisShowKey(\'' + cid + '\',\'' + escapeAttr(k) + '\',' + dbIdx + ')">'
                + '<td>' + escapeHtml(k) + '</td>'
                + '<td style="text-align:right;color:#888;font-size:10px;">🔑</td>'
                + '</tr>';
        });
        content += '</tbody></table>';

        var home = objectTabs.find(function(t) { return t.id === 'obj_home'; });
        if (home) home.content = content;
        else objectTabs.unshift({ id: 'obj_home', label: '对象', type: 'home', content: content });
        renderObjectPanel();
    });
}

function objTabContextMenu(e, tabId) {
    e.preventDefault();
    e.stopPropagation();
    if (!tabId || tabId === 'obj_home') return;

    var tabIndex = objectTabs.findIndex(function(t) { return t.id === tabId; });
    if (tabIndex < 0) return;

    var closeLeft = objectTabs.slice(0, tabIndex).filter(function(t) { return t.id !== 'obj_home'; }).map(function(t) { return t.id; });
    var closeRight = objectTabs.slice(tabIndex + 1).filter(function(t) { return t.id !== 'obj_home'; }).map(function(t) { return t.id; });
    var closeOthers = objectTabs.filter(function(t) { return t.id !== 'obj_home' && t.id !== tabId; }).map(function(t) { return t.id; });
    var menu = [
        {label:'关闭当前 Tab', action:function(){_closeTabGroup([tabId]);}}
    ];
    if (closeLeft.length) menu.push({label:'关闭左侧 Tab', action:function(){_closeTabGroup(closeLeft);}});
    if (closeRight.length) menu.push({label:'关闭右侧 Tab', action:function(){_closeTabGroup(closeRight);}});
    if (closeOthers.length) menu.push({label:'关闭其他 Tab', action:function(){_closeTabGroup(closeOthers);}});
    // Tab 菜单放到 Tab 栏下方，避免遮挡当前 Tab 的名称
    var tabBar = document.getElementById('obj_tabs_bar');
    var tabBarRect = tabBar ? tabBar.getBoundingClientRect() : null;
    var menuTop = tabBarRect ? Math.max(e.clientY, tabBarRect.bottom + 4) : e.clientY + 24;
    showCtxMenu(e.clientX, menuTop, menu);
}

function _closeTabGroup(tabIds) {
    var ids = (tabIds || []).filter(function(id, index, arr) {
        return id && id !== 'obj_home' && arr.indexOf(id) === index && objectTabs.some(function(t) { return t.id === id; });
    });
    if (!ids.length) return;

    var modified = ids.map(function(id) {
        var m = id.match(/^query_(.+)$/);
        if (!m || !_queryModified[m[1]]) return null;
        var tab = objectTabs.find(function(t) { return t.id === id; });
        return tab ? (tab._baseLabel || tab.label || id) : id;
    }).filter(Boolean);

    var doClose = function() { _closeTabGroupInternal(ids); };
    if (modified.length) {
        showConfirmDialog(
            '关闭标签页',
            '<div>以下 Tab 有未保存修改：</div><div style="margin-top:8px;color:#f39c12;">' + escapeHtml(modified.join('、')) + '</div><div style="margin-top:8px;">关闭后将丢失这些修改，是否继续？</div>',
            doClose,
            null,
            '关闭',
            '取消'
        );
        return;
    }
    doClose();
}

function _closeTabGroupInternal(tabIds) {
    var closing = {};
    tabIds.forEach(function(id) { closing[id] = true; });
    var wasActive = activeObjTab;
    var activeIndex = objectTabs.findIndex(function(t) { return t.id === wasActive; });
    var nextActive = null;

    if (closing[wasActive]) {
        for (var i = activeIndex - 1; i >= 0; i--) {
            if (!closing[objectTabs[i].id] && objectTabs[i].id !== 'obj_home') {
                nextActive = objectTabs[i].id;
                break;
            }
        }
        if (!nextActive) {
            for (var j = activeIndex + 1; j < objectTabs.length; j++) {
                if (!closing[objectTabs[j].id]) {
                    nextActive = objectTabs[j].id;
                    break;
                }
            }
        }
    }

    tabIds.forEach(function(id) { _closeTabInternal(id, true); });
    if (nextActive && objectTabs.some(function(t) { return t.id === nextActive; })) activeObjTab = nextActive;
    else if (!objectTabs.some(function(t) { return t.id === activeObjTab; })) activeObjTab = 'obj_home';
    renderObjectPanel();
}

function closeTab(tabId) {
    if (!tabId || tabId === 'obj_home') return;
    // ★ 关闭前检查是否有未保存的修改
    var qidMatch = tabId.match(/^query_(.+)$/);
    if (qidMatch) {
        var qid = qidMatch[1];
        if (_queryModified[qid]) {
            var tab = objectTabs.find(function(t){ return t.id === tabId; });
            var qname = tab ? (tab._baseLabel || tab.label) : '未命名';
            var isNew = (qid.indexOf('new_') === 0);
            showConfirmDialog('未保存的更改',
                '<div style="text-align:center;"><b>' + escapeHtml(qname) + '</b> 有未保存的修改。<br>是否保存后再关闭？</div>',
                function(){
                    // ★ 保存后关闭：新建的需要先命名，已有的直接保存
                    var cid2 = tab ? tab.cid : '';
                    var db2 = tab ? tab.db : '';
                    if (isNew) {
                        showInputDialog('保存查询', '请输入查询名称：', function(n){
                            if (!n || !n.trim()) { _closeTabInternal(tabId); return; }
                            _doSaveQueryAndClose(qid, cid2, db2, n.trim(), tabId);
                        }, '');
                    } else {
                        _doSaveQueryAndClose(qid, cid2, db2, qname, tabId);
                    }
                },
                function(){
                    // 不保存直接关闭
                    _closeTabInternal(tabId);
                },
                '保存', '不保存', '取消'
            );
            return;
        }
    }
    _closeTabInternal(tabId);
}

// ★ 保存后关闭 tab（处理新建的 ID 变更）
function _doSaveQueryAndClose(qid, cid, db, qname, oldTabId) {
    var isNew = (qid.indexOf('new_') === 0);
    var saveQid = isNew ? '' : qid;
    var ta = document.getElementById('sq_' + qid);
    var sql = ta ? ta.value : '';
    eel.tree_save_query(saveQid, qname, sql, cid, db)(function(r){
        if (r && r.ok) {
            var newQid = isNew ? r.id : qid;
            // 更新 tab
            if (isNew) {
                var tab = objectTabs.find(function(t){ return t.id === oldTabId; });
                if (tab) { tab.id = 'query_' + newQid; tab._baseLabel = qname; tab.label = qname; }
                delete _queryModified[qid];
                delete _querySavedSql[qid];
            }
            // 刷新树
            if (cid && db && typeof refreshQueriesTree === 'function') {
                refreshQueriesTree(cid, db, '');
            }
        }
        // 无论成功失败都关闭
        var finalTabId = isNew ? ('query_' + (r && r.ok ? r.id : qid)) : oldTabId;
        _closeTabInternal(finalTabId);
    });
}

// ★ 内部关闭逻辑（不检查修改）
// 数据表 Tab 的完整 DOM 缓存。切换大表时直接挂回原节点，避免重建数千个单元格。
var _dataTabDomCache = {};

function _cacheDataTabDom(tabId, contentDiv) {
    if (!tabId || !contentDiv) return false;
    var tab = objectTabs.find(function(t) { return t.id === tabId; });
    if (!tab || (tab.type !== 'data' && tab.type !== 'redis')) return false;
    _saveTableScrollPosition(tabId);
    _bindTableScrollPosition(tabId, contentDiv);
    var fragment = document.createDocumentFragment();
    while (contentDiv.firstChild) fragment.appendChild(contentDiv.firstChild);
    _dataTabDomCache[tabId] = fragment;
    return true;
}

function _restoreDataTabDom(tabId, contentDiv) {
    var fragment = _dataTabDomCache[tabId];
    if (!fragment || !contentDiv) return false;
    // obj_content 当前可能还挂着 home/其他 tab 的内容，必须先移除，
    // 否则恢复表格时会把工具栏追加到对象列表下面。
    while (contentDiv.firstChild) contentDiv.removeChild(contentDiv.firstChild);
    contentDiv.appendChild(fragment);
    delete _dataTabDomCache[tabId];
    return true;
}

function _closeTabInternal(tabId, skipRender) {
    // ★ 关闭 tab 时强制隐藏 tab 悬浮提示（避免提示卡残留）
    _hideTabTip();
    // 清理该 tab 对应的 splitter 绑定标记
    var qidMatch2 = tabId.match(/^query_(.+)$/);
    if (qidMatch2) {
        var qid2 = qidMatch2[1];
        delete _querySplitterInited['qs_' + qid2];
        delete _queryModified[qid2];
        delete _querySavedSql[qid2];
        // ★ 清理 textarea 和 results 的 DOM 缓存，防止重新打开时恢复旧内容
        delete _textareaCache['sq_' + qid2];
        delete _textareaCache['qr_' + qid2];
        if (typeof _releaseQueryStore === 'function') {
            _releaseQueryStore(qid2);
        }
        delete _queryEditStates[qid2];
        // ★ 清理高亮防抖定时器
        if (_sqlHighlightTimers && _sqlHighlightTimers[qid2]) {
            clearTimeout(_sqlHighlightTimers[qid2]);
            delete _sqlHighlightTimers[qid2];
        }
    }
    // ★ 清理 data tab 的 _tabIdToTid 和 _whereStates
    var tid2 = _tabIdToTid[tabId];
    if (tid2) { delete _whereStates[tid2]; delete _tabIdToTid[tabId]; }
    if (typeof _tableScrollStates !== 'undefined') delete _tableScrollStates[tabId];
    delete _dataTabDomCache[tabId];
    // ★ 清理 redis tab 的编辑状态
    for (var i = 0; i < objectTabs.length; i++) {
        if (objectTabs[i].id === tabId && objectTabs[i].type === 'redis' && objectTabs[i].tid) {
            delete _redisEditState[objectTabs[i].tid];
            break;
        }
    }
    // ★ 清理新建表的 store
    if (tabId && tabId.indexOf('newtbl_') === 0) {
        delete _newTableStore[tabId];
    }
    objectTabs = objectTabs.filter(function(t){return t.id!==tabId;});
    activeObjTab = objectTabs.length ? objectTabs[objectTabs.length-1].id : 'obj_home';
    if (!skipRender) renderObjectPanel();
}

function switchObjTab(tabId) {
    if (activeObjTab === tabId) return; // 同一个 tab 不做任何事
    // ★ 切换 tab 时强制隐藏 tip（避免上一个 tab 的 tip 残留）
    _hideTabTip();
    var oldId = activeObjTab;
    activeObjTab = tabId;
    // ★ 先保存 textarea 编辑状态（记录 _cachedSql/_cachedHtml）
    _saveCurrentTabState(oldId);
    var oldTab = objectTabs.find(function(t){return t.id===oldId;});
    var contentDiv = document.getElementById('obj_content');
    // 数据表格直接缓存 DOM，避免切换大表时重建 tbody；查询编辑器继续保留原生撤销历史。
    if (oldTab && (oldTab.type === 'data' || oldTab.type === 'redis')) {
        _cacheDataTabDom(oldId, contentDiv);
    } else {
        _cacheTextareas();
    }
    // 只更新 tab 栏 active 类，不重建 DOM
    var tabBar = document.getElementById('obj_tabs_bar');
    if (tabBar) {
        var prevEl = tabBar.querySelector('[data-tabid="' + oldId + '"]');
        var nextEl = tabBar.querySelector('[data-tabid="' + tabId + '"]');
        if (prevEl) prevEl.classList.remove('active');
        if (nextEl) nextEl.classList.add('active');
        var searchWrap = tabBar.querySelector('.obj-search-wrap');
        if (searchWrap) searchWrap.style.display = (tabId === 'obj_home') ? '' : 'none';
    }
    // 替换内容 + 重绑定；命中数据 Tab DOM 缓存时无需重新渲染。
    var at = objectTabs.find(function(t){return t.id===tabId;});
    if (contentDiv && at) {
        var restoredDataDom = (at.type === 'data' || at.type === 'redis') && _restoreDataTabDom(tabId, contentDiv);
        if (restoredDataDom) {
            _bindTableScrollPosition(tabId, contentDiv);
            _restoreTableScrollPosition(tabId);
        } else {
            contentDiv.innerHTML = at.content;
            // ★ 恢复缓存的 textarea DOM 元素（保留浏览器原生 undo 历史）
            _restoreTextareas(contentDiv);
            _afterContentUpdate(at, contentDiv);
        }
    }
}
// ★ 保存当前 contentDiv 中所有 textarea/sql-editor 到缓存（保留 DOM 元素 + 原生 undo 历史）
function _cacheTextareas() {
    var contentDiv = document.getElementById('obj_content');
    if (!contentDiv) return;
    var textareas = contentDiv.querySelectorAll('textarea[id^="sq_"]');
    for (var i = 0; i < textareas.length; i++) {
        var ta = textareas[i];
        if (ta.id) {
            // 将 textarea 从 DOM 移动到缓存容器（防止 innerHTML 替换时被销毁）
            _textareaCache[ta.id] = ta;
            ta.parentNode && ta.parentNode.removeChild(ta);
        }
    }
    // 同时缓存结果区域（避免 innerHTML 丢失实时渲染内容）
    var resultDivs = contentDiv.querySelectorAll('[id^="qr_"]');
    for (var ri = 0; ri < resultDivs.length; ri++) {
        var rd = resultDivs[ri];
        if (rd.id) {
            _textareaCache[rd.id] = rd;
            rd.parentNode && rd.parentNode.removeChild(rd);
        }
    }
}

// ★ 将缓存的 textarea/results DOM 元素恢复到新 contentDiv 中（保留原生 undo 历史）
function _restoreTextareas(contentDiv) {
    if (!contentDiv) return;
    var restored = false;
    // 恢复 textarea 元素
    var allSq = contentDiv.querySelectorAll('textarea[id^="sq_"]');
    for (var i = 0; i < allSq.length; i++) {
        var newTa = allSq[i];
        var cached = _textareaCache[newTa.id];
        if (cached && cached.tagName === 'TEXTAREA') {
            // 用缓存的 textarea 替换新创建的 textarea（保留 undo 历史 + 事件监听器）
            newTa.parentNode.replaceChild(cached, newTa);
            delete _textareaCache[newTa.id];
            restored = true;
        }
    }
    // 恢复结果区域元素
    var allQr = contentDiv.querySelectorAll('[id^="qr_"]');
    for (var j = 0; j < allQr.length; j++) {
        var newRd = allQr[j];
        var cachedRd = _textareaCache[newRd.id];
        if (cachedRd && cachedRd.tagName === 'DIV') {
            newRd.parentNode.replaceChild(cachedRd, newRd);
            delete _textareaCache[newRd.id];
            restored = true;
        }
    }
    // 清理不再需要的缓存
    _textareaCache = {};
    return restored;
}

// 保存当前 tab 的 textarea / query 状态
function _saveCurrentTabState(tabId) {
    var panel = document.getElementById('object_panel');
    if (!panel) return;
    _saveTableScrollPosition(tabId);
    var layouts = panel.querySelectorAll('[id^="ql_"]');
    for (var li = 0; li < layouts.length; li++) {
        var layoutId = layouts[li].id;
        if (layoutId.indexOf('ql_') === 0) _syncQueryContent(layoutId.substring(3));
    }
    var textareas = panel.querySelectorAll('textarea');
    for (var ti = 0; ti < textareas.length; ti++) {
        var ta = textareas[ti];
        if (!ta.id || ta.id.indexOf('sq_') === 0) continue;
        for (var j = 0; j < objectTabs.length; j++) {
            var t = objectTabs[j];
            if (t.content.indexOf('id="' + ta.id + '"') !== -1) {
                t.content = t.content.replace(
                    new RegExp('(<textarea[^>]*id="' + ta.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>)([\\s\\S]*?)(</textarea>)', 'i'),
                    '$1' + escapeHtml(ta.value) + '$3'
                );
                break;
            }
        }
    }
    var qrDivs = panel.querySelectorAll('[id^="qr_"]');
    for (var qi = 0; qi < qrDivs.length; qi++) {
        var qrd = qrDivs[qi];
        var qid2 = qrd.id.replace(/^qr_/, '');
        if (_queryEditStates[qid2]) _queryEditStates[qid2]._cachedHtml = qrd.innerHTML;
    }
}
// 内容替换后的事件重绑定（从 renderObjectPanel 提取）
function _afterContentUpdate(targetTab, contentDiv) {
    if (!targetTab) return;
    if (targetTab.type === 'data' || targetTab.type === 'redis') {
        var tid2 = _tabIdToTid[activeObjTab];
        if (tid2) {
            // ★ 只做本地 DOM 渲染，不触发服务端查询
            var renderLocalFn = window['_renderLocal_'+tid2];
            if (renderLocalFn) setTimeout(function(){ renderLocalFn(); }, 0);
            _bindTableScrollPosition(targetTab.id, contentDiv);
            _restoreTableScrollPosition(targetTab.id);
            var bindSortFn = window['_bindSort_'+tid2];
            if (bindSortFn) setTimeout(function(){ bindSortFn(); }, 50);
            // ★ 分页按钮使用内联 onclick，无需重新绑定
            // ★ 重新初始化列宽拖拽（切 tab 后 innerHTML 重建，拖拽手柄丢失）
            setTimeout(function(){
                var wrap2 = document.getElementById(tid2);
                if (wrap2 && typeof _initResultColResize === 'function') {
                    // ★ 重置 thead 上的标记，允许重新初始化
                    var th2 = wrap2.querySelector('table.exp-table thead');
                    if (th2) th2.removeAttribute('data-colresize');
                    _initResultColResize(wrap2, null);
                }
                // ★ 同步漏斗徽标（DOM 重建后徽标元素回到 display:none，根据 filterList 恢复）
                var st2 = _whereStates[tid2];
                if (st2 && typeof _updateFunnelBadge === 'function') {
                    var fl = st2.filterList || [];
                    var valid = 0;
                    for (var fi = 0; fi < fl.length; fi++) {
                        if (fl[fi] && fl[fi].field && fl[fi].op) valid++;
                    }
                    _updateFunnelBadge(tid2, valid);
                }
                // ★ 回填 WHERE 输入框内容（切 tab 后 innerHTML 重建，input value 丢失）
                var whereInp = document.getElementById(tid2 + '_where');
                var savedWhere = (st2 && st2.whereExpr) ? st2.whereExpr : (window['_activeWhereSql_' + tid2] || '');
                if (whereInp && savedWhere) whereInp.value = savedWhere;
            }, 60);
        }
    }
    if (targetTab.type === 'query') {
        var qm = activeObjTab.match(/^query_(.+)$/);
        if (qm) {
            var qid3 = qm[1];
            // ★ 检查查询是否仍在后端运行（不随意清除 _execRunning，保留真实状态）
            var wasRunning = !!_execRunning[qid3];
            var elapsedMs = Date.now() - (_execStartTime[qid3] || 0);
            // 如果超过 130 秒还没完成，可能是卡死了，强制清除
            if (wasRunning && elapsedMs > 130000) {
                _execRunning[qid3] = false;
                _execCancelFlags[qid3] = false;
                wasRunning = false;
            }
            // 如果被取消标记了，也清除
            if (wasRunning && _execCancelFlags[qid3]) {
                wasRunning = false;
            }
            (function(qidX, isRunning){
                setTimeout(function(){
                    var esX = _queryEditStates[qidX];
                    var sqlTa = document.getElementById('sq_' + qidX);
                    var sqlBtn = document.getElementById('btn_exe_' + qidX);
                    if (!sqlTa || !sqlBtn) return;
                    // ★ 根据运行状态设置按钮文本
                    if (isRunning) {
                        sqlBtn.textContent = '⏹ 取消';
                        sqlBtn.style.background = '#e74c3c';
                    } else {
                        sqlBtn.textContent = '▶ 执行';
                        sqlBtn.style.background = '#2ecc71';
                    }
                    if (esX && Object.prototype.hasOwnProperty.call(esX, '_cachedSql')) {
                        sqlTa.value = esX._cachedSql;
                    } else {
                        var cachedTab = objectTabs.find(function(t){ return t.id === 'query_' + qidX; });
                        if (cachedTab && Object.prototype.hasOwnProperty.call(cachedTab, '_cachedSql')) {
                            sqlTa.value = cachedTab._cachedSql;
                        }
                    }
                    var updateBtnLabel = function(){
                        if (!sqlBtn || sqlBtn.textContent.indexOf('⏹') === 0) return;
                        if (!sqlTa) return;
                        var s = sqlTa.selectionStart, e = sqlTa.selectionEnd;
                        sqlBtn.textContent = (s !== e) ? '▶ 执行选中' : '▶ 执行';
                    };
                    sqlTa.addEventListener('mouseup', updateBtnLabel);
                    sqlTa.addEventListener('keyup', updateBtnLabel);
                    sqlTa.addEventListener('input', function(){ _queryTextareaChanged(qidX, sqlTa); _syncLineGutter(qidX, sqlTa); });
                    var curTab = objectTabs.find(function(t){ return t.id === 'query_' + qidX; });
                    var cid2 = curTab ? curTab.cid : '';
                    var qdb2 = curTab ? curTab.db : '';
                    sqlTa.addEventListener('keydown', function(e){
                        if(e.ctrlKey && e.key === 'Enter') { e.preventDefault(); execQueryTab(qidX); }
                        if(e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); _handleSaveQuery(qidX, cid2, qdb2); }
                    });
                    updateBtnLabel();
                    // 内容从缓存 textarea 恢复后，重新生成新建的行号栏。
                    if (typeof _syncLineGutter === 'function') {
                        _syncLineGutter(qidX, sqlTa);
                        requestAnimationFrame(function(){ _syncLineGutter(qidX, sqlTa); });
                    }
                }, 0);
            })(qid3, wasRunning);
            var es = _queryEditStates[qid3];
            (function(qidR, esR, isRunning){
                function doRestore(){
                    var rdiv = document.getElementById('qr_' + qidR);
                    if (!rdiv) return;
                    // ★ 如果查询仍在运行，显示执行中状态，不渲染旧数据
                    if (isRunning) {
                        rdiv.innerHTML = '<div style="padding:10px;color:#999;display:flex;align-items:center;gap:10px;"><span>⏳ 执行中...</span><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:3px 10px;" onclick="cancelExecQuery(\''+qidR+'\')">⏹ 取消</button></div>';
                        return;
                    }
                    // ★ 只有当确定不是 running 状态时才渲染已完成的查询结果
                    if (esR && esR.columns && esR.columns.length > 0 && !esR._execJustStarted) { _qRenderTable(qidR); return; }
                    var hasResults = rdiv.querySelector('.exp-table') || rdiv.querySelector('table');
                    var textOnly = rdiv.textContent.trim();
                    if (!hasResults && textOnly && textOnly !== '' && esR && esR._cachedHtml) {
                        rdiv.innerHTML = esR._cachedHtml;
                    }
                }
                setTimeout(doRestore, 20);
                setTimeout(function(){
                    var rdiv2 = document.getElementById('qr_' + qidR);
                    if (!rdiv2) return;
                    if (isRunning) return; // 仍在运行，不覆盖
                    var hasTable2 = rdiv2.querySelector('.exp-table') || rdiv2.querySelector('table');
                    var txt2 = rdiv2.textContent.trim();
                    if (!hasTable2 && (!txt2 || /^\s*$/.test(txt2))) {
                        if (esR && esR.columns && esR.columns.length > 0 && !esR._execJustStarted) _qRenderTable(qidR);
                        else if (esR && esR._cachedHtml) rdiv2.innerHTML = esR._cachedHtml;
                    }
                }, 80);
            })(qid3, es, wasRunning);
        }
    }
    requestAnimationFrame(function(){
        collapseOverflowTabs();
        highlightTableRow();
        setupObjectPanelDrop();
        if (contentDiv) {
            var layouts = contentDiv.querySelectorAll('.query-layout');
            for (var li = 0; li < layouts.length; li++) {
                var layoutEl = layouts[li];
                if (!layoutEl.id || layoutEl.id.indexOf('ql_') !== 0) continue;
                var qid2 = layoutEl.id.substring(3);
                delete _querySplitterInited['qs_' + qid2];
                initQuerySplitter('ql_' + qid2, 'qs_' + qid2, 'sq_' + qid2, 'qr_' + qid2);
            }
        }
    });
}

// ==================== 表名内联重命名（对象面板） ====================
var _objPanelRenameState = null; // { tr, oldName, db, schema, cid, nameCell }
var _objPanelLastSelect = null;
var _objPanelRangeAnchor = null;  // Shift 范围选择的起点

// 对象面板表行点击：选择 / 再次点击进入重命名
function objPanelTableClick(e, tr) {
    if (_objPanelRenameState) return; // 正在重命名中，忽略
    var multi = !!(e.ctrlKey || e.metaKey);
    var range = !!e.shiftKey;
    var tbody = tr && tr.parentElement;
    var rows = tbody ? Array.prototype.filter.call(tbody.children, function(row) {
        return row.classList && row.classList.contains('drag-table-item');
    }) : [tr];
    var anchorIndex = rows.indexOf(_objPanelRangeAnchor);
    var targetIndex = rows.indexOf(tr);
    var hasRange = range && anchorIndex >= 0 && targetIndex >= 0;
    // Shift 点击选择连续表行；Ctrl/Command 点击继续支持追加/取消单行。
    if (hasRange) {
        document.querySelectorAll('#obj_content .exp-table tbody tr.drag-table-item').forEach(function(r) { r.classList.remove('table-row-selected'); });
        document.querySelectorAll('.tree-table-item').forEach(function(d) { d.classList.remove('tree-table-selected'); });
        var from = Math.min(anchorIndex, targetIndex), to = Math.max(anchorIndex, targetIndex);
        rows.slice(from, to + 1).forEach(function(row) { row.classList.add('table-row-selected'); });
    } else if (!multi) {
        document.querySelectorAll('#obj_content .exp-table tbody tr.drag-table-item').forEach(function(r) {
            r.classList.remove('table-row-selected');
        });
        document.querySelectorAll('.tree-table-item').forEach(function(d) {
            d.classList.remove('tree-table-selected');
        });
        tr.classList.add('table-row-selected');
    } else {
        tr.classList.toggle('table-row-selected');
    }

    if (!range) _objPanelRangeAnchor = tr;
    // 多选/范围选择时不触发二次点击重命名。
    if (!multi && !range && _objPanelLastSelect === tr) {
        // 同一行再次点击 → 进入重命名模式
        _startObjPanelRename(tr);
        _objPanelLastSelect = null;
    } else {
        _objPanelLastSelect = (multi || range) ? null : tr;
    }
}

// 对象面板 F2 重命名入口
function objPanelRenameByF2() {
    if (_objPanelRenameState) return;
    var sel = document.querySelector('#obj_content .exp-table tbody tr.table-row-selected');
    if (!sel) return;
    _startObjPanelRename(sel);
}

function _startObjPanelRename(tr) {
    var tn = tr.getAttribute('data-tname');
    var db = tr.getAttribute('data-db');
    var sch = tr.getAttribute('data-sch');
    var cid = tr.getAttribute('data-cid');
    if (!tn || !db) return;

    var nameCell = tr.querySelector('td.tbl-name-cell');
    if (!nameCell) return;

    var oldName = nameCell.textContent.trim();
    var input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.className = 'table-rename-input';
    nameCell.textContent = '';
    nameCell.appendChild(input);
    input.focus();
    input.select();

    _objPanelRenameState = {
        tr: tr, oldName: oldName, db: db, schema: sch, cid: cid,
        nameCell: nameCell, input: input
    };

    input.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); _commitObjPanelRename(); }
        if (ev.key === 'Escape') { ev.preventDefault(); _cancelObjPanelRename(); }
    });
    input.addEventListener('blur', function() {
        setTimeout(function() {
            if (_objPanelRenameState) _commitObjPanelRename();
        }, 100);
    });
}

function _commitObjPanelRename() {
    var s = _objPanelRenameState;
    if (!s) return;
    var newName = s.input.value.trim();
    _objPanelRenameState = null;
    // 恢复原始显示（取消编辑状态）
    s.nameCell.textContent = s.oldName;
    s.tr.classList.remove('table-row-selected');

    if (!newName || newName === s.oldName) return;

    var cid = s.cid || activeConnId || '';
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    if (!conn) { showErrorDialog('重命名失败', '未找到连接信息'); return; }

    eel.table_rename(conn, s.db, s.oldName, newName, s.schema)(function(r) {
        if (r && r.ok) {
            showOkDialog('成功', r.msg);
            // 刷新左侧树中的表文件夹
            refreshTableFolder(cid, s.db, s.schema);
            // 刷新对象面板内容
            setTimeout(function() {
                if (activeConnId === cid && activeDatabase === s.db) {
                    loadCategoryItems(conn, s.db, 'tables', function(items) {
                        var home = objectTabs.find(function(t){ return t.id === 'obj_home'; });
                        if (home) {
                            home.content = buildObjHomeContent(items, 'tables', s.db, s.schema, cid);
                            renderObjectPanel();
                        }
                    }, s.schema);
                }
            }, 300);
        } else {
            showErrorDialog('重命名失败', (r && r.msg) ? r.msg : '未知错误');
        }
    });
}

function _cancelObjPanelRename() {
    var s = _objPanelRenameState;
    if (!s) return;
    s.nameCell.textContent = s.oldName;
    _objPanelRenameState = null;
}

// 清除面板选中的行（当 panel 内容变化时调用）
function _clearObjPanelSelection() {
    _objPanelLastSelect = null;
    if (_objPanelRenameState) _cancelObjPanelRename();
}

// ==================== 对象面板空白区域右键刷新 ====================
function _setupObjPanelCtx() {
    var content = document.getElementById('obj_content');
    if (!content || content._objCtxReady) return;
    content._objCtxReady = true;
    content.addEventListener('contextmenu', function(e) {
        // 如果点击在表行/单元格上（已有自己的右键菜单），不处理
        var target = e.target;
        while (target && target !== content) {
            if (target.tagName === 'TR' || target.tagName === 'TD' || target.tagName === 'TH') return;
            target = target.parentElement;
        }
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY, [
            {label:'🔄 刷新', action: refreshObjPanel}
        ]);
    });
}

function refreshObjPanel() {
    if (activeObjTab !== 'obj_home') return;
    if (!_activeObjCat || !activeConnId || !activeDatabase) return;
    var cid = activeConnId;
    var db = activeDatabase;
    var cat = _activeObjCat;
    var sch = _activeObjSchema || '';
    var conn = activeConnData;
    if (!conn) return;

    if (cat === 'tables') {
        clickTableCat(cid, db, sch);
    } else if (cat === 'queries') {
        clickQueries(cid, db, sch);
    } else {
        clickCat(cid, db, cat, sch);
    }
}
