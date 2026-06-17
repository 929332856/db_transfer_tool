// ==================== Tab 溢出折叠 ====================
function collapseOverflowTabs() {
    var bar = document.getElementById('obj_tabs_bar');
    if (!bar) return;

    // 移除旧的更多按钮和下拉
    var oldMore = bar.querySelector('.obj-tabs-more-btn');
    if (oldMore) oldMore.remove();

    // 恢复所有 tab 显示
    var allTabs = Array.from(bar.querySelectorAll('.obj-tab'));
    allTabs.forEach(function(t) { t.style.display = ''; });

    if (allTabs.length <= 1) return;

    var maxW = bar.clientWidth;
    // 搜索框宽度
    var searchWrap = bar.querySelector('.obj-search-wrap');
    var reserved = (searchWrap ? searchWrap.offsetWidth + 8 : 0) + 52; // 搜索框 + "⋯" 按钮 + 内边距
    if (reserved > maxW * 0.4) reserved = Math.floor(maxW * 0.4); // 防止搜索框占太多

    // 找到 home tab 和 active tab
    var homeTab = bar.querySelector('[data-tabid="obj_home"]');
    var activeTab = bar.querySelector('.obj-tab.active');

    // 从右往左填充可见 tab，home 和 active 强制可见
    var available = maxW - reserved;
    var visibleTabs = [];
    var hideTabs = [];

    for (var i = allTabs.length - 1; i >= 0; i--) {
        var t = allTabs[i];
        var w = t.offsetWidth;
        if (t === homeTab || t === activeTab) {
            visibleTabs.unshift(t);
            available -= w; // 必显的 tab 直接从可用空间扣除
            continue;
        }
        if (available >= w) {
            visibleTabs.unshift(t);
            available -= w;
        } else {
            hideTabs.push(t);
        }
    }

    if (hideTabs.length === 0) return;

    // 隐藏溢出的 tab
    hideTabs.forEach(function(t) { t.style.display = 'none'; });

    // 收集隐藏 tab 的 id
    window._hiddenTabIds = hideTabs.map(function(t) { return t.getAttribute('data-tabid'); });

    // 在 home tab 后面插入 "⋯" 按钮
    var moreBtn = document.createElement('span');
    moreBtn.className = 'obj-tab obj-tabs-more-btn';
    moreBtn.setAttribute('data-tabid', '__more__');
    moreBtn.textContent = '⋯';
    moreBtn.title = '展开隐藏的标签页';
    moreBtn.onclick = function(e) { e.stopPropagation(); showCollapsedTabs(e); };
    if (homeTab && homeTab.nextSibling) {
        bar.insertBefore(moreBtn, homeTab.nextSibling);
    } else {
        bar.appendChild(moreBtn);
    }
}

function showCollapsedTabs(e) {
    var hidden = window._hiddenTabIds || [];
    if (!hidden.length) return;

    // 关闭已存在的下拉
    var old = document.getElementById('tabs_collapse_dropdown');
    if (old) { old.remove(); return; }

    var dd = document.createElement('div');
    dd.id = 'tabs_collapse_dropdown';
    dd.style.cssText = 'position:fixed;background:#2a2a2a;border:1px solid #555;border-radius:6px;padding:6px 0;z-index:99999;min-width:200px;max-height:360px;overflow-y:auto;box-shadow:0 6px 24px rgba(0,0,0,.5);';

    var rect = e.target.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.left = rect.left + 'px';

    hidden.forEach(function(tabId) {
        var tab = objectTabs.find(function(t) { return t.id === tabId; });
        if (!tab) return;
        var icon = tab.type === 'ddl' ? '🔧 ' : tab.type === 'data' ? '📊 ' : tab.type === 'query' ? '📝 ' : '📋 ';
        var item = document.createElement('div');
        item.style.cssText = 'padding:7px 16px;font-size:12px;color:#ccc;white-space:nowrap;display:flex;align-items:center;';
        item.innerHTML = '<span style="flex:1;">' + icon + escapeHtml(tab.label) + '</span>' +
            '<span style="font-size:10px;color:#888;margin-left:12px;" onclick="event.stopPropagation();closeTab(\'' + tabId + '\');var d=document.getElementById(\'tabs_collapse_dropdown\');if(d)d.remove();">✕</span>';
        item.onmouseover = function() { this.style.background = '#3a3a3a'; };
        item.onmouseout = function() { this.style.background = ''; };
        item.onclick = function() {
            switchObjTab(tabId);
            dd.remove();
        };
        dd.appendChild(item);
    });

    document.body.appendChild(dd);

    // 点击外部关闭
    setTimeout(function() {
        function outsideClick(ev) {
            if (!dd.contains(ev.target) && ev.target !== e.target) {
                dd.remove();
                document.removeEventListener('click', outsideClick);
            }
        }
        document.addEventListener('click', outsideClick);
    }, 10);
}

// 监听面板尺寸变化，重新计算溢出
var _collapseOverflowTimer = 0;
(function initTabCollapseObserver() {
    setTimeout(function() {
        var panel = document.getElementById('object_panel');
        if (!panel) return;
        function debouncedCollapse() {
            if (_collapseOverflowTimer) return;
            _collapseOverflowTimer = setTimeout(function() {
                _collapseOverflowTimer = 0;
                collapseOverflowTabs();
            }, 50);
        }
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(debouncedCollapse).observe(panel);
        } else {
            window.addEventListener('resize', debouncedCollapse);
        }
    }, 200);
})();

function highlightTableRow() {
    if (!activeObjTab || activeObjTab==='obj_home') return;
    var tn = activeObjTab.replace(/^(data_|ddl_|query_)/,'');
    document.querySelectorAll('#obj_content .exp-table tbody tr').forEach(function(r){
        var td = r.querySelector('td');
        if (td && td.textContent.trim()===tn) { r.style.background='#3a5a8a'; r.scrollIntoView({block:'center'}); }
    });
}

function addOrUpdateTab(id, label, type, content, db, cid) {
    var ex = objectTabs.find(function(t){return t.id===id;});
    if (ex) { ex.content = content; if(db!==undefined)ex.db=db; if(cid!==undefined)ex.cid=cid; }
    else objectTabs.push({id:id,label:label,type:type,content:content,db:db||'',cid:cid||activeConnId||''});
    activeObjTab = id;
    renderObjectPanel();
}
