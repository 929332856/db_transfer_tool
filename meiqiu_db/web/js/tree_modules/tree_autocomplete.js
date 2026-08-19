// ==================== SQL 自动补全 ====================
// 输入时实时弹出提示，Tab 补全第一个，↑↓ 切换，Esc 关闭

// SQL 关键字
var _SQL_KEYWORDS = [
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','DROP',
    'CREATE','ALTER','TABLE','INDEX','VIEW','PROCEDURE','FUNCTION','TRIGGER','PACKAGE',
    'JOIN','LEFT','RIGHT','INNER','OUTER','ON','AND','OR','NOT','IN','EXISTS','BETWEEN',
    'LIKE','IS','NULL','ORDER','BY','GROUP','HAVING','ASC','DESC','LIMIT','OFFSET',
    'UNION','ALL','DISTINCT','AS','CASE','WHEN','THEN','ELSE','END','BEGIN','DECLARE',
    'COMMIT','ROLLBACK','GRANT','REVOKE','TRUNCATE','MERGE','EXCEPTION','RAISE',
    'COUNT','SUM','AVG','MAX','MIN','COALESCE','NVL','CAST','CONCAT','SUBSTR','REPLACE',
    'TRIM','UPPER','LOWER','LENGTH','TO_CHAR','TO_DATE','TO_TIMESTAMP','SYSDATE','SYSTIMESTAMP',
    'IF','ELSE','LOOP','WHILE','FOR','CURSOR','OPEN','CLOSE','FETCH','EXIT','RETURN',
    'VARCHAR2','NUMBER','INTEGER','DATE','TIMESTAMP','CLOB','BLOB','BOOLEAN',
    'PRIMARY','KEY','FOREIGN','REFERENCES','CONSTRAINT','UNIQUE','CHECK','DEFAULT',
    'CASCADE','RESTRICT','NO','ACTION','SEQUENCE','NEXTVAL','CURRVAL','DUAL',
    'EXPLAIN','ANALYZE','DESCRIBE','SHOW','USE','DATABASE','SCHEMA',
    'OVER','PARTITION','ROW_NUMBER','RANK','DENSE_RANK','LAG','LEAD','ROWS','RANGE'
];

var _acState = {
    qid: null, visible: false, items: [], selectedIdx: 0,
    prefix: '', popup: null, cid: null, db: null, tableCache: null,
    ta: null, _triggerTimer: null, _requestToken: 0
};

// Close a floating completion popup when the user clicks outside the editor/popup.
(function _initAutocompleteOutsideClick() {
    document.addEventListener('mousedown', function(e) {
        if (!_acState.visible) return;
        var target = e.target;
        var ta = _acState.ta;
        var popup = _acState.popup;
        if ((ta && (target === ta || (ta.contains && ta.contains(target)))) ||
            (popup && (target === popup || (popup.contains && popup.contains(target))))) return;
        _acHide();
    });
})();

// ★ 初始化
function _initAutocomplete(ta, qid, cid, db) {
    if (!ta) return;
    if (ta._autocompleteInitialized) return;
    ta._autocompleteInitialized = true;
    // ★ 使用捕获阶段+stopImmediatePropagation，确保先于 _editorIndent 触发，阻止 Tab 触发插入空格
    ta.addEventListener('keydown', function(e) {
        if (_acState.visible) {
            if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); _acSelect((_acState.selectedIdx + 1) % _acState.items.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); _acSelect((_acState.selectedIdx - 1 + _acState.items.length) % _acState.items.length); return; }
            if (e.key === 'Tab') {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.shiftKey) {
                    _acHide();
                    if (typeof _editorOutdent === 'function') _editorOutdent(ta);
                } else {
                    _acApply(ta, true);
                }
                return;
            }
            // Let the browser handle native undo; only hide the completion popup.
            if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { _acHide(); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _acHide(); return; }
            if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); _acApply(ta, false); return; }
        }
    }, true);
    ta.addEventListener('input', function() {
        _acDebounceTrigger(ta, qid, cid, db);
    });
    ta.addEventListener('blur', function() {
        setTimeout(function(){ _acHide(); }, 150);
    });
}

// ★ 防抖触发：输入后 200ms 检测
function _acDebounceTrigger(ta, qid, cid, db) {
    if (_acState._triggerTimer) clearTimeout(_acState._triggerTimer);
    _acState._triggerTimer = setTimeout(function() {
        _acTrigger(ta, qid, cid, db);
    }, 200);
}

// ★ 触发补全
function _acTrigger(ta, qid, cid, db) {
    var prefix = _acGetPrefix(ta);
    var requestToken = ++_acState._requestToken;
    // 至少输入 2 个字符才提示
    if (!prefix || prefix.length < 2) { _acHide(); return; }

    // 如果已可见且前缀没变（只是继续输入），走过滤逻辑
    if (_acState.visible && _acState.qid === qid && _acState.prefix && prefix.indexOf(_acState.prefix) === 0) {
        _acFilter(ta, prefix);
        return;
    }

    var keywords = _SQL_KEYWORDS.filter(function(k) {
        return k.toUpperCase().indexOf(prefix.toUpperCase()) === 0;
    });

    // 判断是否在 FROM/JOIN/INTO/UPDATE/TABLE 等关键字后面 → 优先查表名
    var beforePrefix = _acGetBeforePrefix(ta);
    var needTables = /\b(FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE|REFERENCES)\s*$/i.test(beforePrefix);

    if (needTables) {
        _acLoadTables(cid, db, function(tables) {
            if (requestToken !== _acState._requestToken ||
                document.getElementById('sq_' + qid) !== ta ||
                document.activeElement !== ta || _acGetPrefix(ta) !== prefix) return;
            var matched = (tables || []).filter(function(t) {
                return t.toUpperCase().indexOf(prefix.toUpperCase()) === 0;
            });
            var allItems = matched.concat(
                keywords.filter(function(k) { return matched.indexOf(k) === -1; })
            );
            if (allItems.length > 0) _acShow(ta, qid, allItems, prefix);
            else _acHide();
        });
    } else {
        if (keywords.length > 0) _acShow(ta, qid, keywords, prefix);
        else _acHide();
    }
}

// ★ 过滤
function _acFilter(ta, prefix) {
    if (!prefix || prefix.length < 2) { _acHide(); return; }
    var filtered = _acState.items.filter(function(item) {
        return item.toUpperCase().indexOf(prefix.toUpperCase()) === 0;
    });
    if (filtered.length === 0) { _acHide(); return; }
    _acState.prefix = prefix;
    _acRender(filtered, 0);
}

// ★ 光标前的词
function _acGetPrefix(ta) {
    var pos = ta.selectionStart, val = ta.value, start = pos;
    while (start > 0 && /[a-zA-Z0-9_]/.test(val[start - 1])) start--;
    return val.substring(start, pos);
}

// ★ 光标前内容
function _acGetBeforePrefix(ta) {
    var pos = ta.selectionStart, val = ta.value, start = pos;
    while (start > 0 && /[a-zA-Z0-9_]/.test(val[start - 1])) start--;
    return val.substring(0, start).trim().toUpperCase();
}

// ★ 加载表名（缓存）
function _acLoadTables(cid, db, callback) {
    var key = cid + '_' + (db || '');
    if (_acState.tableCache && _acState.tableCache[key]) { callback(_acState.tableCache[key]); return; }
    if (!cid || !treeData || !treeData.connections || !treeData.connections[cid]) { callback([]); return; }
    var conn = treeData.connections[cid];
    loadCategoryItems(conn, db || '', 'tables', function(items) {
        var names = (items || []).map(function(it) { return it.name || it; });
        if (!_acState.tableCache) _acState.tableCache = {};
        _acState.tableCache[key] = names;
        callback(names);
    }, '');
}

// ★ 显示下拉
function _acShow(ta, qid, items, prefix) {
    _acState.qid = qid; _acState.ta = ta; _acState.prefix = prefix; _acState.items = items;
    _acState.cid = _acGetCurrentCid(); _acState.db = activeDatabase || '';
    _acRender(items, 0);
    _acState.visible = true;
}

// ★ 渲染
function _acRender(items, selectedIdx) {
    var popup = _acState.popup;
    if (!popup) {
        popup = document.createElement('div');
        popup.className = 'ac-popup';
        document.body.appendChild(popup);
        _acState.popup = popup;
    }
    _acState.selectedIdx = Math.min(selectedIdx, Math.max(0, items.length - 1));
    popup.innerHTML = items.map(function(item, i) {
        var cls = i === _acState.selectedIdx ? 'ac-item ac-selected' : 'ac-item';
        return '<div class="'+cls+'" onmousedown="event.preventDefault();_acClickItem('+i+')">'+escapeHtml(item)+'</div>';
    }).join('');
    popup.style.display = 'block';

    var ta = _acState.ta || document.getElementById('sq_' + _acState.qid);
    if (ta) {
        var rect = ta.getBoundingClientRect();
        var pos = ta.selectionStart, val = ta.value;
        var lineStart = val.lastIndexOf('\n', pos - 1) + 1;
        var col = pos - lineStart;
        // ★ 1-indexed → 0-indexed
        var lineNo = (val.substring(0, pos).match(/\n/g) || []).length;
        var lineH = 18, charW = 7.26, prefix = _acState.prefix || '';
        var padTop = 10;  // CSS 中 textarea 的 padding-top
        // ★ 从顶部滚出的行数（考虑 padding）
        var scrolledLines = Math.floor(Math.max(0, ta.scrollTop - padTop) / lineH);
        // ★ 光标在可见区域中的相对行号（0-indexed）
        var row = lineNo - scrolledLines;
        // ★ 限制在 textarea 可视范围内
        var visibleRows = Math.max(1, Math.floor((ta.clientHeight - padTop * 2) / lineH));
        if (row >= visibleRows) row = visibleRows - 1;
        if (row < 0) row = 0;
        // ★ popup 默认显示在当前行下方一行位置（不会挡住 SQL）
        var top = rect.top + padTop + (row + 1) * lineH + 2;
        var left = rect.left + 10 + (col - prefix.length) * charW;
        // ★ 估算 popup 高度（每个 item 约 24px，至少 60px，最多 200px）
        var popupH = Math.min(200, Math.max(60, items.length * 24));
        // ★ 如果下方空间不够，弹到上方
        if (top + popupH > window.innerHeight - 8) {
            top = rect.top + padTop + row * lineH - popupH - 2;
            if (top < 8) {
                // 上下都不够 → 贴在 textarea 底部上沿
                top = Math.max(8, rect.top + ta.clientHeight - popupH - 4);
            }
        }
        if (left + 200 > window.innerWidth) left = Math.max(8, window.innerWidth - 210);
        popup.style.top = top + 'px';
        popup.style.left = left + 'px';
    }
}

function _acSelect(idx) {
    _acState.selectedIdx = idx;
    var items = _acState.popup.querySelectorAll('.ac-item');
    items.forEach(function(el, i) { el.className = i === idx ? 'ac-item ac-selected' : 'ac-item'; });
}

function _acClickItem(idx) {
    var ta = _acState.ta || document.getElementById('sq_' + _acState.qid);
    _acState.selectedIdx = idx;
    if (ta) _acApply(ta, false);
}

// ★ 应用补全（tabKey=true 时总是补全第一个；false 时用选中的）
function _acApply(ta, tabKey) {
    if (!_acState.visible) return;
    var idx = tabKey ? 0 : _acState.selectedIdx;
    var item = _acState.items[idx];
    if (!item) { _acHide(); return; }
    var prefix = _acState.prefix || '';
    var pos = ta.selectionStart;
    var replaceStart = Math.max(0, pos - prefix.length);
    var before = ta.value.substring(0, replaceStart);
    var after = ta.value.substring(pos);
    var expected = before + item + after;

    // Use the browser editing command so completion is added to textarea's native undo stack.
    ta.focus();
    ta.setSelectionRange(replaceStart, pos);
    var inputSeen = false;
    var markInput = function() { inputSeen = true; };
    ta.addEventListener('input', markInput);
    var commandOk = false;
    try { commandOk = document.execCommand('insertText', false, item); } catch (ignore) {}
    ta.removeEventListener('input', markInput);
    if (!commandOk || ta.value !== expected) {
        if (typeof ta.setRangeText === 'function') ta.setRangeText(item, replaceStart, pos, 'end');
        else ta.value = expected;
    }
    ta.selectionStart = ta.selectionEnd = replaceStart + item.length;
    _acHide();
    if (!inputSeen) ta.dispatchEvent(new Event('input', { bubbles: true }));
    if (_acState._triggerTimer) { clearTimeout(_acState._triggerTimer); _acState._triggerTimer = null; }
    // ★ 清除防抖定时器，避免重新触发下拉框
    if (_acState._triggerTimer) { clearTimeout(_acState._triggerTimer); _acState._triggerTimer = null; }
    // ★ 这里是代码修改 textarea.value，不会自动触发 input；手动同步编辑器状态和行号。
    if (typeof _queryTextareaChanged === 'function') _queryTextareaChanged(ta.id.replace(/^sq_/, ''), ta);
    if (typeof _syncLineGutter === 'function') _syncLineGutter(ta.id.replace(/^sq_/, ''), ta);
    if (typeof _applySqlHighlightDebounced === 'function') {
        _applySqlHighlightDebounced(ta.id.replace(/^sq_/, ''), ta);
    }
}

function _acHide() {
    _acState.visible = false;
    _acState.ta = null;
    _acState._requestToken++;
    if (_acState.popup) _acState.popup.style.display = 'none';
    if (_acState._triggerTimer) { clearTimeout(_acState._triggerTimer); _acState._triggerTimer = null; }
}

function _acGetCurrentCid() { return activeConnId || ''; }
