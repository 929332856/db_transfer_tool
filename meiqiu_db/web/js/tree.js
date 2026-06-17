"use strict";
// tree.js — 模块加载器
// 请按依赖顺序加载以下模块：
//   1. tree_core.js     — 基础工具 + 全局状态 + 图标
//   2. tree_tooltip.js  — 字段注释悬浮
//   3. tree_panels.js   — 面板切换 + 连接列表渲染
//   4. tree_context.js  — 数据库右键菜单 + 分类展开
//   5. tree_categories.js — 分类点击 → 右侧面板
//   6. tree_objpanel.js — 对象面板渲染
//   7. tree_tabs.js     — Tab 溢出折叠
//   8. tree_table.js    — 表操作 + WHERE 过滤 + 表格渲染
//   9. tree_designer.js — 设计器交互
//  10. tree_query.js    — 查询编辑器
//  11. tree_redis_panel.js — Redis 面板
//  12. tree_dom.js      — 局部 DOM 操作
//  13. tree_drag.js     — 拖拽复制/移动
//  14. tree_manage.js   — 菜单/管理/导入导出/数据加载
//  15. tree_redis.js    — Redis 值编辑
//
// ★ 初始化逻辑已移动到 tree_init.js
// ★ 请更新 index.html 按上述顺序加载所有模块
console.log("tree.js loader — modules loaded via index.html");
// ==================== 初始化（已移至文件顶部 ====================

// ★ 全局 selectionchange：可靠跟踪 SQL 文本框选区变化，同步"执行/执行选中"按钮
// mouseup/keyup 无法覆盖所有场景（如点击已选中文本折叠选区），selectionchange 最可靠
document.addEventListener('selectionchange', function() {
    var el = document.activeElement;
    if (!el || el.tagName !== 'TEXTAREA' || !el.id || el.id.indexOf('sq_') !== 0) return;
    var qid = el.id.substring(3);
    var btn = document.getElementById('btn_exe_' + qid);
    if (!btn || btn.textContent.indexOf('⏹') === 0) return; // 执行中不更新
    var s = el.selectionStart, e = el.selectionEnd;
    var newLabel = (s !== e) ? '▶ 执行选中' : '▶ 执行';
    if (btn.textContent !== newLabel) btn.textContent = newLabel;
});

// ★ 全局点击处理：点击非 grip 格子的区域时取消所有行选中
(function() {
    function _isGripOrInside(el) {
        while (el) {
            if (el.classList && el.classList.contains('row-sel-grip')) return true;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON' || el.tagName === 'SELECT') return true;
            if (el.classList && (el.classList.contains('btn') || el.classList.contains('ctx-menu') || el.classList.contains('obj-tab') || el.classList.contains('tab-close'))) return true;
            el = el.parentElement;
        }
        return false;
    }
    document.addEventListener('click', function(e) {
        if (_isGripOrInside(e.target)) return;
        var anyCleared = false;
        // ★ 点击空白区域时，把所有查询执行按钮从"执行选中"恢复为"执行"（textarea 失焦后选中状态不再有意义）
        var allExeBtns = document.querySelectorAll('[id^="btn_exe_"]');
        for (var bi = 0; bi < allExeBtns.length; bi++) {
            var beb = allExeBtns[bi];
            if (beb.textContent === '▶ 执行选中') beb.textContent = '▶ 执行';
        }
        // 清除所有数据表的行选中（通过 window._selRows_ 引用 mutate 对象）
        var allWraps = document.querySelectorAll('.data-table-wrap');
        for (var w = 0; w < allWraps.length; w++) {
            var wrap = allWraps[w];
            var tid = wrap.id;
            var selRows = window['_selRows_'+tid];
            if (selRows && Object.keys(selRows).length > 0) {
                for (var k in selRows) delete selRows[k];
                anyCleared = true;
            }
            wrap.querySelectorAll('.row-sel-grip.selected').forEach(function(g) { g.classList.remove('selected'); });
            wrap.querySelectorAll('tr.row-selected').forEach(function(tr) { tr.classList.remove('row-selected'); });
        }
        if (anyCleared && typeof updateDeleteBtn === 'function') updateDeleteBtn();
        // 清除查询结果选择
        if (typeof _queryEditStates !== 'undefined') {
            for (var qk in _queryEditStates) {
                var es = _queryEditStates[qk];
                if (es && es.selectedRows && Object.keys(es.selectedRows).length > 0) {
                    es.selectedRows = {};
                    es._lastClickedIdx = -1;
                    var qrWrap = document.getElementById('qr_' + qk);
                    if (qrWrap) {
                        qrWrap.querySelectorAll('.row-sel-grip.selected').forEach(function(g) { g.classList.remove('selected'); });
                        qrWrap.querySelectorAll('tr.row-selected').forEach(function(tr) { tr.classList.remove('row-selected'); });
                    }
                    if (typeof _qUpdateBtns === 'function') _qUpdateBtns(qk);
                }
            }
        }
    });
})();
