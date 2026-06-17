// ==================== Redis 操作 ====================
// ==================== Redis 值查看/编辑 ====================

// 存储 Redis 编辑状态 {tabId: {info, changed, original}}
var _redisEditState = {};

function redisShowKey(cid, key, dbIdx) {
    activeConnId = cid;
    activeConnData = treeData && treeData.connections ? treeData.connections[cid] : null;
    activeDatabase = key;
    activeCatId = null;
    var db = (dbIdx !== undefined ? dbIdx : 0);
    // ★ 先查找是否已有同连接+同数据库+同key的tab，有则直接跳转
    var existingTab = objectTabs.find(function(t) {
        return t.type === 'redis' && t.cid === cid && t.db === db && t.key === key;
    });
    if (existingTab) {
        activeObjTab = existingTab.id;
        renderObjectPanel();
        return;
    }
    var labelKey = key.length > 6 ? key.substring(0, 6) + '…' : key;
    var label = (dbIdx !== undefined ? '[DB'+dbIdx+'] ' : '') + '🔑 '+labelKey;
    // 用时间戳保证每次打开都是独立tab
    var ts = Date.now();
    var tabId = 'redis_' + ts;
    var tid = 'redis_' + key.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_') + '_' + (dbIdx||0) + '_' + ts;
    // 初始化编辑状态
    _redisEditState[tid] = {info: null, changed: {}, original: null, cid: cid, key: key, dbIdx: dbIdx};
    var html = '<div style="padding:8px 12px;overflow:auto;height:100%;">' +
        '<div style="color:#888;font-size:11px;">⏳ 加载中...</div></div>';
    // ★ 改为新增 tab 而非替换全部
    addOrUpdateTab(tabId, label, 'redis', html, '');
    var newTab = objectTabs.find(function(t){return t.id===tabId;});
    if (newTab) { newTab.key = key; newTab.cid = cid; newTab.db = dbIdx; newTab.tid = tid; }
    eel.redis_get_key_info(activeConnData, key, dbIdx)(function(r) {
        if (!r || !r.ok) {
            var content = '<div style="padding:8px 12px;color:#e74c3c;">❌ '+(r?r.msg:'加载失败')+'</div>';
            updateRedisTab(tid, content);
            return;
        }
        _redisEditState[tid].info = r.info;
        _redisEditState[tid].original = JSON.parse(JSON.stringify(r.info));
        _redisEditState[tid].changed = {};
        renderRedisData(tid, r.info);
    });
}

function updateRedisTab(tid, content) {
    var tab = objectTabs.find(function(t){return (t.tid||'')===tid;});
    if (!tab) { /* 兼容旧逻辑 */ tab = objectTabs.find(function(t){return t.id==='obj_redis'}); }
    if (tab) { tab.content = content; activeObjTab = tab.id; renderObjectPanel(); }
}

function renderRedisData(tid, info) {
    var st = _redisEditState[tid];
    if (!st) return;
    var cid = st.cid, key = st.key, dbIdx = st.dbIdx;
    var typeLabel = info.type.toUpperCase();
    var ttlVal = info.ttl;

    // ===== 整体容器：表单式布局 =====
    var html = '<div class="redis-detail-panel" style="display:flex;flex-direction:column;height:100%;overflow:auto;padding:10px 14px;gap:8px;">';

    // ---- 行1: 键名称 ----
    html += '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
        '<label style="font-size:12px;color:#4fc3f7;width:56px;flex-shrink:0;">键名称:</label>' +
        '<input type="text" id="'+tid+'_keyname" value="'+escapeAttr(info.key)+'" readonly ' +
            'style="flex:1;background:#111;border:1px solid #444;color:#e0e0e0;font-family:Consolas,monospace;font-size:12px;padding:4px 8px;border-radius:3px;" ' +
            'title="'+escapeAttr(key)+'">' +
        '</div>';

    // ---- 行2: 键类型 ----
    html += '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
        '<label style="font-size:12px;color:#4fc3f7;width:56px;flex-shrink:0;">键类型:</label>' +
        '<select id="'+tid+'_typesel" onchange="" disabled style="background:#111;border:1px solid #444;color:#e0e0e0;font-size:12px;padding:3px 6px;border-radius:3px;min-width:120px;">' +
        '<option value="string"'+(info.type==='string'?' selected':'')+'>string</option>' +
        '<option value="hash"'+(info.type==='hash'?' selected':'')+'>hash</option>' +
        '<option value="list"'+(info.type==='list'?' selected':'')+'>list</option>' +
        '<option value="set"'+(info.type==='set'?' selected':'')+'>set</option>' +
        '<option value="zset"'+(info.type==='zset'?' selected':'')+'>zset</option></select>' +
        '</div>';

    // ---- 行3: 值区域（带表格） ----
    html += '<div style="display:flex;flex-direction:column;flex:1;min-height:0;">';
    html += '<label style="font-size:12px;color:#4fc3f7;margin-bottom:2px;">值:</label>';
    html += '<div id="'+tid+'_value" style="flex:1;overflow:auto;border:1px solid #333;border-radius:4px;display:flex;flex-direction:column;">';

    if (info.type === 'string') {
        html += renderRedisString(tid, info);
    } else if (info.type === 'hash') {
        html += renderRedisHashTable(tid, info);
    } else if (info.type === 'list') {
        html += renderRedisListTable(tid, info);
    } else if (info.type === 'set') {
        html += renderRedisSetTable(tid, info);
    } else if (info.type === 'zset') {
        html += renderRedisZSetTable(tid, info);
    } else {
        html += '<pre style="font-family:Consolas,monospace;font-size:12px;color:#e0e0e0;white-space:pre-wrap;word-break:break-all;margin:8px;">' + escapeHtml(JSON.stringify(info.value, null, 2)) + '</pre>';
    }

    html += '</div>'; // value end

    // 值区域下方工具栏：+ - 筛选 | 计数信息
    if (info.type !== 'string') {
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;flex-shrink:0;border-top:1px solid #333;margin-top:2px;">' +
            '<div style="display:flex;align-items:center;gap:4px;">' +
                '<button class="btn btn-sm" onclick="redisDetailAddRow(\''+tid+'\')" title="新增行" style="height:24px;font-size:13px;padding:2px 8px;">＋</button> ' +
                '<button class="btn btn-sm" onclick="redisDetailDelRow(\''+tid+'\')" title="删除选中" style="height:24px;font-size:13px;padding:2px 8px;">－</button> ' +
                '<button class="btn btn-sm" onclick="document.getElementById(\''+tid+'_filter\').focus()" title="筛选" style="height:24px;font-size:12px;padding:2px 8px;">🔍</button> ' +
            '</div>' +
            '<span id="'+tid+'_countInfo" style="color:#888;font-size:11px;"></span>' +
            '</div>';
    }
    html += '</div>'; // 值区域容器 end

    // ---- 行4: TTL + 操作按钮 ----
    html += '<div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding-top:4px;border-top:1px solid #333;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
            '<label style="font-size:12px;color:#4fc3f7;">TTL:</label>' +
            '<select id="'+tid+'_ttlsel" style="background:#111;border:1px solid #444;color:#e0e0e0;font-size:12px;padding:3px 6px;border-radius:3px;min-width:120px;">' +
                '<option value="-1"' + (ttlVal === -1 ? ' selected' : '') + '>无 TTL</option>' +
                '<option value="300">5 分钟</option>' +
                '<option value="1800">30 分钟</option>' +
                '<option value="3600">1 小时</option>' +
                '<option value="86400">1 天</option>' +
                '<option value="604800">7 天</option>' +
                '<option value="2592000">30 天</option>' +
            '</select>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
            '<button class="btn btn-sm btn-green" id="'+tid+'_save_btn" onclick="redisSaveChanges(\''+tid+'\')" disabled style="padding:5px 18px;">应用</button> ' +
            '<button class="btn btn-sm" id="'+tid+'_cancel_btn" onclick="redisCancelChanges(\''+tid+'\')" disabled style="padding:5px 18px;">放弃</button> ' +
            '<button class="btn btn-sm" onclick="redisRefreshKey(\''+escapeAttr(cid)+'\',\''+escapeAttr(key)+'\','+dbIdx+')" style="padding:5px 10px;">🔄 刷新</button>' +
        '</div>' +
        '</div>';

    html += '</div>'; // panel end

    updateRedisTab(tid, html);

    // 更新计数信息
    redisUpdateCountInfo(tid, info);
}

// ---- string 类型 ----
function renderRedisString(tid, info) {
    var v = info.value !== null && info.value !== undefined ? String(info.value) : '';
    return '<textarea id="'+tid+'_str" class="editable-cell" spellcheck="false" ' +
        'style="width:100%;height:100%;min-height:200px;resize:none;background:#111;color:#e0e0e0;font-family:Consolas,monospace;font-size:12px;border:none;outline:none;padding:8px;white-space:pre-wrap;word-break:break-all;" ' +
        'oninput="_redisMarkChanged(\''+tid+'\')">' + escapeHtml(v) + '</textarea>';
}

// ---- hash 类型（字段/值 表格） ----
function renderRedisHashTable(tid, info) {
    var v = info.value || {};
    var keys = Object.keys(v);
    if (!keys.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 Hash）</div>';
    // 隐藏的筛选输入
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:40%;">字段</th>' +
        '<th style="padding:5px 10px;text-align:left;">值</th></tr></thead><tbody id="'+tid+'_tbody">';
    keys.forEach(function(f, i){
        h += '<tr data-field="'+escapeAttr(f)+'" id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;"><input class="editable-cell" placeholder="字段" data-field="'+escapeAttr(f)+'" data-orig-field="'+escapeAttr(f)+'"' +
                ' value="'+escapeAttr(f)+'" oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off" ' +
                'style="background:#111;border:1px solid #2a2a2a;color:#4fc3f7;"></td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-field="'+escapeAttr(f)+'" data-orig="'+escapeAttr(String(v[f]))+'" value="'+escapeAttr(String(v[f]))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    h += '</tbody></table>';
    return h;
}

// ---- list 类型 ----
function renderRedisListTable(tid, info) {
    var arr = Array.isArray(info.value) ? info.value : Object.values(info.value||{});
    var total = info.length || arr.length;
    if (!arr.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 List）</div>';
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:8%;">#</th>' +
        '<th style="padding:5px 10px;text-align:left;">值</th></tr></thead><tbody id="'+tid+'_tbody">';
    arr.forEach(function(item, i){
        h += '<tr id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;color:#555;">'+(i+1)+'</td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-idx="'+i+'" data-orig="'+escapeAttr(String(item))+'" value="'+escapeAttr(String(item))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    if (total > arr.length) {
        h += '<tr><td colspan="2" style="padding:4px 8px;color:#888;text-align:center;">... 共 '+total+' 项，仅显示前 '+arr.length+' 项</td></tr>';
    }
    h += '</tbody></table>';
    return h;
}

// ---- set 类型 ----
function renderRedisSetTable(tid, info) {
    var members = Array.isArray(info.value) ? info.value : Object.values(info.value||{});
    var total = info.length || members.length;
    if (!members.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 Set）</div>';
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:8%;">#</th>' +
        '<th style="padding:5px 10px;text-align:left;">值</th></tr></thead><tbody id="'+tid+'_tbody">';
    members.forEach(function(m, i){
        h += '<tr id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;color:#555;">'+(i+1)+'</td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-idx="'+i+'" data-orig="'+escapeAttr(String(m))+'" value="'+escapeAttr(String(m))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    if (total > members.length) {
        h += '<tr><td colspan="2" style="padding:4px 8px;color:#888;text-align:center;">... 共 '+total+' 项，仅显示前 '+members.length+' 项</td></tr>';
    }
    h += '</tbody></table>';
    return h;
}

// ---- zset 类型 ----
function renderRedisZSetTable(tid, info) {
    var items = Array.isArray(info.value) ? info.value : [];
    var total = info.length || items.length;
    if (!items.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 ZSet）</div>';
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:40%;">Member</th>' +
        '<th style="padding:5px 10px;text-align:left;width:25%;">Score</th></tr></thead><tbody id="'+tid+'_tbody">';
    items.forEach(function(it, i){
        var member = it[0], score = it[1];
        h += '<tr id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-type="member" data-idx="'+i+'" data-orig="'+escapeAttr(String(member))+'" value="'+escapeAttr(String(member))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-type="score" data-idx="'+i+'" data-orig="'+escapeAttr(String(score))+'" value="'+escapeAttr(String(score))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    if (total > items.length) {
        h += '<tr><td colspan="2" style="padding:4px 8px;color:#888;text-align:center;">... 共 '+total+' 项，仅显示前 '+items.length+' 项</td></tr>';
    }
    h += '</tbody></table>';
    return h;
}

// ---- 详情面板辅助函数 ----
function redisUpdateCountInfo(tid, info) {
    var el = document.getElementById(tid+'_countInfo');
    if (!el) return;
    var st = _redisEditState[tid];
    if (!st || !st.info) { el.textContent = ''; return; }
    var type = st.info.type;
    var visible = 0, total = 0;
    var tbody = document.getElementById(tid+'_tbody');
    if (tbody && type !== 'string') {
        var rows = tbody.querySelectorAll('tr');
        total = rows.length;
        rows.forEach(function(r){ if (r.style.display !== 'none') visible++; });
    }
    var label = type === 'hash' ? '个字段' : '个成员';
    var len = info.length || total;
    if (type === 'string') { el.textContent = ''; }
    else if (len > visible) { el.textContent = visible + ' ' + label + '（共 ' + len + ' 个）'; }
    else { el.textContent = total + ' ' + label; }
}

function redisDetailAddRow(tid) {
    var st = _redisEditState[tid];
    if (!st) return;
    var type = st.info.type;
    if (type === 'hash') _redisAddHashRow(tid);
    else if (type === 'list') _redisAddListRow(tid);
    else if (type === 'set') _redisAddSetRow(tid);
    else if (type === 'zset') _redisAddZSetRow(tid);
}

function redisDetailDelRow(tid) {
    // 删除表格中选中的行（当前选中行高亮的）
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    // 找到有背景色的行（选中态）
    var selected = null;
    var rows = tbody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].style.background === 'rgb(42, 58, 74)' || rows[i].style.backgroundColor === '#2a3a4a' ||
            getComputedStyle(rows[i]).backgroundColor === 'rgb(42, 58, 74)' || rows[i].matches(':focus-within')) {
            selected = rows[i]; break;
        }
    }
    // 如果没有显式选中，删除最后一行
    if (!selected && rows.length > 0) selected = rows[rows.length - 1];
    if (selected) {
        var field = selected.getAttribute('data-field') || selected.getAttribute('data-idx');
        var st2 = _redisEditState[tid];
        var t = st2.info.type;
        if (t === 'hash' && field) _redisDelHashRow(tid, field);
        else if (t === 'list' && field) _redisDelListRow(tid, field);
        else if (t === 'set' && field) _redisDelSetRow(tid, field);
        else if (t === 'zset' && field) _redisDelZSetRow(tid, field);
        else selected.remove();
        _redisMarkChanged(tid);
    }
}

// Redis key 右键菜单
function redisKeyCtx(event, cid, key, dbIdx) {
    event.preventDefault();
    var k = key;
    showCtxMenu(event.clientX, event.clientY, [
        {label: '🔍 打开详情', action: function(){ redisShowKey(cid, k, dbIdx); }},
        {label: '📋 复制 Key 名', action: function(){ navigator.clipboard.writeText(k).then(function(){ /* 静默复制 */ }); }},
        '---',
        {label: '🗑️ 删除此 Key', action: function(){
            if (confirm('确定删除 ' + JSON.stringify(k) + ' ?')) {
                eel.redis_delete_key(treeData.connections[cid], k, dbIdx)(function() {
                    redisKLRefresh(cid, dbIdx, _redisPanelCtx.dbId);
                });
            }
        }}
    ]);
}
function redisFilterData(tid) {
    var filter = (document.getElementById(tid+'_filter')||{}).value || '';
    filter = filter.toLowerCase();
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) {
        // string 类型不支持筛选表格
        var ta = document.getElementById(tid+'_str');
        if (!ta) return;
        var st2 = _redisEditState[tid];
        if (!st2 || !st2.original) return;
        var origVal = st2.original.value || '';
        if (filter) {
            var lines = String(origVal).split('\n');
            var filtered = lines.filter(function(l){return l.toLowerCase().indexOf(filter)!==-1;});
            ta.value = filtered.join('\n');
        } else {
            ta.value = String(origVal);
        }
        return;
    }
    var rows = tbody.querySelectorAll('tr');
    rows.forEach(function(row){
        // textContent 不含 <input> 的 value，需手动拼接
        var inputs = row.querySelectorAll('input');
        var inputVals = '';
        inputs.forEach(function(inp) { inputVals += (inp.value || '') + ' '; });
        var text = (row.textContent + ' ' + inputVals).toLowerCase();
        row.style.display = (filter && text.indexOf(filter)===-1) ? 'none' : '';
    });
}

// ---- 标记修改 ----
function _redisMarkChanged(tid) {
    var st = _redisEditState[tid];
    if (!st) return;
    st.changed[tid] = true;
    var saveBtn = document.getElementById(tid+'_save_btn');
    var cancelBtn = document.getElementById(tid+'_cancel_btn');
    if (saveBtn) saveBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
}

// ---- 删除行标记 ----
var _redisDeleteMarks = {};
function _redisMarkDeletedRow(tid, type, key) {
    if (!_redisDeleteMarks[tid]) _redisDeleteMarks[tid] = {};
    if (!_redisDeleteMarks[tid][type]) _redisDeleteMarks[tid][type] = [];
    _redisDeleteMarks[tid][type].push(key);
    _redisMarkChanged(tid);
}

// ---- 新增/删除行操作 ----
function _redisAddHashRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var idx = tbody.querySelectorAll('tr').length;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增 field" data-newfield="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增 value" data-newval="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelHashRow(tid, field) {
    var row = document.querySelector('#'+tid+'_row_'+field.replace(/[^a-zA-Z0-9]/g,'_'));
    // 更好的查找方式
    var tbody = document.getElementById(tid+'_tbody');
    var rows = tbody ? tbody.querySelectorAll('tr') : [];
    rows.forEach(function(r){
        var inp = r.querySelector('input[data-field="'+escapeAttr(field)+'"]');
        if (inp) { r.remove(); }
    });
    _redisMarkDeletedRow(tid, 'deleted_fields', field);
    _redisMarkChanged(tid);
}

function _redisAddListRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增值" data-newitem="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelListRow(tid, idx) {
    var row = document.getElementById(tid+'_row_'+idx);
    if (row) row.remove();
    _redisMarkDeletedRow(tid, 'deleted_idxs', parseInt(idx));
    _redisMarkChanged(tid);
}

function _redisAddSetRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增成员" data-newitem="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelSetRow(tid, idx) {
    var row = document.getElementById(tid+'_row_'+idx);
    if (row) row.remove();
    _redisMarkDeletedRow(tid, 'deleted_idxs', parseInt(idx));
    _redisMarkChanged(tid);
}

function _redisAddZSetRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增 member" data-newmember="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="score" data-newscore="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelZSetRow(tid, idx) {
    var row = document.getElementById(tid+'_row_'+idx);
    if (row) row.remove();
    _redisMarkDeletedRow(tid, 'deleted_idxs', parseInt(idx));
    _redisMarkChanged(tid);
}

// ---- 收集编辑后的数据 ----
function _redisCollectChanges(tid) {
    var st = _redisEditState[tid];
    if (!st || !st.info) return null;
    var info = st.info;
    var result = {type: info.type};

    if (info.type === 'string') {
        var ta = document.getElementById(tid+'_str');
        result.value = ta ? ta.value : '';
    } else if (info.type === 'hash') {
        result.fields = {};
        result.deletes = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_fields) || [];
        var tbody = document.getElementById(tid+'_tbody');
        if (tbody) {
            var rows = tbody.querySelectorAll('tr');
            rows.forEach(function(r){
                var fieldInp = r.querySelector('input[data-field]');
                if (fieldInp) {
                    var f = fieldInp.getAttribute('data-field');
                    var newVal = fieldInp.value;
                    if (result.deletes.indexOf(f) === -1) {
                        result.fields[f] = newVal;
                    }
                }
                // 新增行
                var newField = r.querySelector('input[data-newfield]');
                var newVal2 = r.querySelector('input[data-newval]');
                if (newField && newVal2 && newField.value) {
                    result.fields[newField.value] = newVal2.value;
                }
            });
        }
    } else if (info.type === 'list') {
        var orig = Array.isArray(info.value) ? info.value : [];
        var dels = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_idxs) || [];
        var items = [];
        orig.forEach(function(v, i){
            if (dels.indexOf(i) === -1) items.push(v);
        });
        // 更新修改的值
        var tbody2 = document.getElementById(tid+'_tbody');
        if (tbody2) {
            var rows2 = tbody2.querySelectorAll('tr');
            rows2.forEach(function(r){
                var inp = r.querySelector('input[data-idx]');
                if (inp) {
                    var idx = parseInt(inp.getAttribute('data-idx'));
                    if (idx < items.length) items[idx] = inp.value;
                }
                // 新增
                var newInp = r.querySelector('input[data-newitem]');
                if (newInp && newInp.value) items.push(newInp.value);
            });
        }
        result.items = items;
    } else if (info.type === 'set') {
        var origS = Array.isArray(info.value) ? info.value : [];
        var delsS = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_idxs) || [];
        var members = [];
        origS.forEach(function(v, i){
            if (delsS.indexOf(i) === -1) members.push(v);
        });
        var tbodyS = document.getElementById(tid+'_tbody');
        if (tbodyS) {
            var rowsS = tbodyS.querySelectorAll('tr');
            rowsS.forEach(function(r){
                var inp = r.querySelector('input[data-idx]');
                if (inp) {
                    var idx = parseInt(inp.getAttribute('data-idx'));
                    if (idx < members.length) members[idx] = inp.value;
                }
                var newInp = r.querySelector('input[data-newitem]');
                if (newInp && newInp.value) members.push(newInp.value);
            });
        }
        result.members = members;
    } else if (info.type === 'zset') {
        var origZ = Array.isArray(info.value) ? info.value : [];
        var delsZ = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_idxs) || [];
        var itemsZ = [];
        origZ.forEach(function(it, i){
            if (delsZ.indexOf(i) === -1) itemsZ.push([it[0], parseFloat(it[1])||0]);
        });
        var tbodyZ = document.getElementById(tid+'_tbody');
        if (tbodyZ) {
            var rowsZ = tbodyZ.querySelectorAll('tr');
            rowsZ.forEach(function(r){
                var memInp = r.querySelector('input[data-type="member"]');
                var scrInp = r.querySelector('input[data-type="score"]');
                if (memInp && scrInp) {
                    var idx = parseInt(memInp.getAttribute('data-idx'));
                    if (idx < itemsZ.length) {
                        itemsZ[idx] = [memInp.value, parseFloat(scrInp.value)||0];
                    }
                }
                var nm = r.querySelector('input[data-newmember]');
                var ns = r.querySelector('input[data-newscore]');
                if (nm && ns && nm.value) {
                    itemsZ.push([nm.value, parseFloat(ns.value)||0]);
                }
            });
        }
        result.items = itemsZ;
    }
    return result;
}

// ---- 保存 ----
function redisSaveChanges(tid) {
    var st = _redisEditState[tid];
    if (!st) return;
    var changes = _redisCollectChanges(tid);
    if (!changes) return;
    var conn = treeData && treeData.connections ? treeData.connections[st.cid] : null;
    if (!conn) { showErrorDialog('错误', '连接信息丢失'); return; }

    var saveBtn = document.getElementById(tid+'_save_btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ 保存中...'; }

    var callback = function(r){
        if (saveBtn) { saveBtn.textContent = '💾 保存'; saveBtn.disabled = true; }
        if (r && r.ok) {
            // 刷新显示
            redisRefreshKey(st.cid, st.key, st.dbIdx);
            showOkDialog('成功', r.msg || '保存成功');
        } else {
            showErrorDialog('失败', r ? r.msg : '保存失败');
        }
    };

    if (changes.type === 'string') {
        eel.redis_set_string(conn, st.key, changes.value, st.dbIdx)(callback);
    } else if (changes.type === 'hash') {
        eel.redis_set_hash(conn, st.key, changes.fields, changes.deletes, st.dbIdx)(callback);
    } else if (changes.type === 'list') {
        eel.redis_set_list(conn, st.key, changes.items, st.dbIdx)(callback);
    } else if (changes.type === 'set') {
        eel.redis_set_set(conn, st.key, changes.members, st.dbIdx)(callback);
    } else if (changes.type === 'zset') {
        eel.redis_set_zset(conn, st.key, changes.items, st.dbIdx)(callback);
    }
}

// ---- 取消 ----
function redisCancelChanges(tid) {
    var st = _redisEditState[tid];
    if (!st || !st.original) return;
    _redisDeleteMarks[tid] = {};
    _redisEditState[tid].changed = {};
    renderRedisData(tid, st.original);
}

// ---- 刷新 ----
function redisRefreshKey(cid, key, dbIdx) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    var tid = 'redis_' + key.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_') + '_' + (dbIdx||0);
    var labelKey = key.length > 6 ? key.substring(0, 6) + '…' : key;
    var label = (dbIdx !== undefined ? '[DB'+dbIdx+'] ' : '') + '🔑 '+labelKey;
    _redisDeleteMarks[tid] = {};
    // 更新 tab 状态
    var tab = objectTabs.find(function(t){return t.id==='obj_redis';});
    if (!tab) {
        objectTabs = [{id:'obj_redis',label:label,type:'redis',content:'<div style="padding:8px 12px;color:#888;">⏳ 刷新中...</div>',key:key,cid:cid,db:dbIdx,tid:tid}];
    } else {
        tab.content = '<div style="padding:8px 12px;color:#888;">⏳ 刷新中...</div>';
        tab.key = key; tab.cid = cid; tab.db = dbIdx; tab.tid = tid;
    }
    activeObjTab = 'obj_redis';
    activeCatId = null;
    _redisEditState[tid] = {info: null, changed: {}, original: null, cid: cid, key: key, dbIdx: dbIdx};
    renderObjectPanel();
    eel.redis_get_key_info(conn, key, dbIdx)(function(r) {
        if (!r || !r.ok) {
            updateRedisTab(tid, '<div style="padding:8px 12px;color:#e74c3c;">❌ '+(r?r.msg:'刷新失败')+'</div>');
            return;
        }
        _redisEditState[tid].info = r.info;
        _redisEditState[tid].original = JSON.parse(JSON.stringify(r.info));
        _redisEditState[tid].changed = {};
        renderRedisData(tid, r.info);
    });
}

// ---- 删除（保留用于右键菜单等） ----
function redisDeleteKey(cid, key, dbIdx) {
    showConfirmDialog('确认删除', '确定删除 key ['+key+']？此操作不可恢复！', function(){
        eel.redis_delete_key(activeConnData, key, dbIdx)(function(r) {
            if (r && r.ok) {
                showOkDialog('成功', r.msg);
                objectTabs = [{id:'obj_home',label:'对象',type:'home',content:'<div style="padding:40px;text-align:center;color:#666;"><div style="font-size:36px;margin-bottom:10px;">📄</div><div>已删除</div></div>'}];
                activeObjTab = 'obj_home';
                renderObjectPanel();
            } else {
                showErrorDialog('失败', r ? r.msg : '删除失败');
            }
        });
    });
}

// Redis 命令执行面板
function showRedisCmdPanel(cid) {
    activeConnId = cid;
    activeConnData = treeData && treeData.connections ? treeData.connections[cid] : null;
    var html = '<div style="display:flex;flex-direction:column;height:100%;">' +
        '<div style="display:flex;gap:6px;padding:6px 0;flex-shrink:0;">' +
            '<input type="text" id="redis_cmd_input" placeholder="输入 Redis 命令，如 GET key / KEYS * / TYPE key" ' +
                'style="flex:1;height:30px;background:#0d1117;border:1px solid #333;color:#e0e0e0;padding:4px 8px;font-family:Consolas,monospace;font-size:12px;border-radius:4px;" ' +
                'onkeydown="if(event.key===\'Enter\')redisExecCmd(\''+cid+'\')">' +
            '<button class="btn btn-blue btn-sm" onclick="redisExecCmd(\''+cid+'\')" style="height:30px;">▶ 执行</button>' +
        '</div>' +
        '<div id="redis_cmd_result" style="flex:1;overflow:auto;background:#0d1117;border:1px solid #333;border-radius:4px;padding:8px 12px;font-family:Consolas,monospace;font-size:12px;color:#e0e0e0;min-height:200px;white-space:pre-wrap;">' +
            '<div style="color:#888;">输入命令后按回车或点击执行...</div>' +
        '</div></div>';
    objectTabs = [{id:'obj_redis_cmd',label:'💻 Redis 命令',type:'redis_cmd',content:html,cid:cid}];
    activeObjTab = 'obj_redis_cmd';
    activeCatId = null;
    renderObjectPanel();
}

// Redis 查询 Tab 执行：逐行执行 Redis 命令
function execRedisQueryTab(qid, btnExe, resultsDiv, cmdText) {
    // 按换行拆分，过滤空行和注释行
    var lines = cmdText.split('\n').map(function(l) { return l.trim(); })
        .filter(function(l) { return l && !l.startsWith('--'); });
    if (!lines.length) {
        resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⚠ 无可执行的命令</div>';
        _execCancelFlags[qid] = false;
        if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
        return;
    }
    var allResults = [];
    var pending = 0;

    lines.forEach(function(cmd, i) {
        pending++;
        eel.redis_execute(activeConnData, cmd)(function(r) {
            var resultHtml = '';
            if (!r || !r.ok) {
                resultHtml = '<span style="color:#e74c3c;">❌ ' + escapeHtml(r ? r.msg : '执行失败') + '</span>';
            } else {
                var res = r.result;
                var display;
                if (res === null || res === undefined) {
                    display = '(nil)';
                } else if (typeof res === 'object') {
                    if (Array.isArray(res)) {
                        display = res.map(function(item, idx) {
                            if (Array.isArray(item)) return (idx + 1) + ') ' + item[0] + ' [' + item[1] + ']';
                            return (idx + 1) + ') ' + escapeHtml(String(item));
                        }).join('\n');
                    } else {
                        display = JSON.stringify(res, null, 2);
                    }
                } else {
                    display = String(res);
                }
                resultHtml = '<span style="white-space:pre-wrap;">' + escapeHtml(display) + '</span>'
                    + (r.info && r.info.elapsed ? ' <span style="color:#555;font-size:10px;">(' + r.info.elapsed + ')</span>' : '');
            }
            allResults[i] = resultHtml;
            pending--;
            if (pending === 0) {
                if (_execCancelFlags[qid]) {
                    _execCancelFlags[qid] = false;
                    if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
                    resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⏸ 执行已取消</div>';
                    return;
                }
                _execCancelFlags[qid] = false;
                if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
                // 渲染所有结果
                var html = '';
                lines.forEach(function(cmd2, j) {
                    html += '<div style="margin-bottom:12px;">'
                        + '<div style="color:#2ecc71;font-family:Consolas,monospace;font-size:12px;margin-bottom:4px;">&gt; ' + escapeHtml(cmd2) + '</div>'
                        + '<div style="color:#e0e0e0;font-family:Consolas,monospace;font-size:12px;padding-left:8px;">' + (allResults[j] || '') + '</div>'
                        + '</div>';
                });
                resultsDiv.innerHTML = html;
            }
        });
    });
}

function redisExecCmd(cid) {
    var input = document.getElementById('redis_cmd_input');
    var cmd = input ? input.value.trim() : '';
    if (!cmd) return;
    var resultDiv = document.getElementById('redis_cmd_result');
    if (resultDiv) resultDiv.innerHTML = '<div style="color:#888;">⏳ 执行中...</div>';
    eel.redis_execute(activeConnData, cmd)(function(r) {
        if (!resultDiv) return;
        if (!r || !r.ok) {
            resultDiv.innerHTML = '<div style="color:#e74c3c;">❌ '+(r?r.msg:'执行失败')+'</div>';
            return;
        }
        var res = r.result;
        var display;
        if (res === null || res === undefined) {
            display = '(nil)';
        } else if (typeof res === 'object') {
            if (Array.isArray(res)) {
                display = res.map(function(item,i){
                    if (Array.isArray(item)) return (i+1)+') '+item[0]+' ['+item[1]+']';
                    return (i+1)+') '+escapeHtml(String(item));
                }).join('\n');
            } else {
                display = JSON.stringify(res, null, 2);
            }
        } else {
            display = String(res);
        }
        resultDiv.innerHTML = '<div style="color:#2ecc71;">> '+escapeHtml(cmd)+'</div><div style="margin-top:4px;">'+escapeHtml(display)+'</div>';
    });
}
