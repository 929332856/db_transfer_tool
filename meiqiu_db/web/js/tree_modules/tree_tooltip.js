// ==================== 字段注释悬浮 Tooltip ====================
var _fieldCmtTooltip = null;
var _fieldCmtHideTimer = null;

function _ensureFieldCmtTooltip() {
    if (_fieldCmtTooltip) return;
    _fieldCmtTooltip = document.createElement('div');
    _fieldCmtTooltip.className = 'field-cmt-tooltip';
    _fieldCmtTooltip.innerHTML = '<div class="cmt-col-name"></div><div class="cmt-col-type"></div><div class="cmt-col-comment"></div>';
    document.body.appendChild(_fieldCmtTooltip);

    // ★ 使用 mouseover（而非 mousemove），每进入一个元素只触发一次，性能更好且更可靠
    document.addEventListener('mouseover', function(e) {
        var th = e.target ? e.target.closest('th[data-cmt]') : null;
        if (!th) { return; }
        var cmt = th.getAttribute('data-cmt') || '';
        if (!cmt) { return; }
        _showFieldCmt(th, cmt, '');
    });

    // ★ 鼠标离开 th 时隐藏
    document.addEventListener('mouseout', function(e) {
        var th = e.target ? e.target.closest('th[data-cmt]') : null;
        if (th) { _hideFieldCmtTooltipDelayed(); }
    });
}

function _showFieldCmt(thEl, cmt, cType) {
    clearTimeout(_fieldCmtHideTimer);
    if (!_fieldCmtTooltip) return;
    var nameEl = _fieldCmtTooltip.querySelector('.cmt-col-name');
    var typeEl = _fieldCmtTooltip.querySelector('.cmt-col-type');
    var cmtEl = _fieldCmtTooltip.querySelector('.cmt-col-comment');
    // 只展示注释，不展示字段名和类型
    if (nameEl) nameEl.textContent = '';
    if (typeEl) typeEl.textContent = '';
    if (cmtEl) cmtEl.textContent = cmt || '';
    _fieldCmtTooltip.style.display = 'block';
    // ★ 先渲染再取真实尺寸，避免预估偏差导致越界
    var ttW = _fieldCmtTooltip.offsetWidth || 360;
    var ttH = _fieldCmtTooltip.offsetHeight || 36;
    // 定位：显示在字段 th 正下方，优先向右展开避免被截断
    var rect = thEl.getBoundingClientRect();
    var left = rect.left;
    var top = rect.bottom + 2;
    // 右边界：优先显示在字段下方右对齐（th 的右边缘对齐 tooltip 右边缘），更不容易溢出
    if (left + ttW > window.innerWidth - 6) {
        left = Math.max(4, rect.right - ttW);
        if (left + ttW > window.innerWidth - 6) left = Math.max(4, window.innerWidth - ttW - 6);
    }
    // 下边界
    if (top + ttH > window.innerHeight - 6) top = rect.top - ttH - 2;
    if (top < 4) top = 4;
    if (left < 4) left = 4;
    _fieldCmtTooltip.style.left = left + 'px';
    _fieldCmtTooltip.style.top = top + 'px';
}

function _hideFieldCmtTooltipDelayed() {
    clearTimeout(_fieldCmtHideTimer);
    if (!_fieldCmtTooltip) return;
    _fieldCmtHideTimer = setTimeout(function() {
        if (_fieldCmtTooltip) _fieldCmtTooltip.style.display = 'none';
    }, 150);
}

// 在页面加载完成后初始化
(function() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _ensureFieldCmtTooltip);
    } else {
        _ensureFieldCmtTooltip();
    }
})();
