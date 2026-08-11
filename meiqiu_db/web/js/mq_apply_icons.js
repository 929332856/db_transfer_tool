// ★ MQ Emoji → SVG 自动替换器
// 在 DOMContentLoaded 时遍历文本节点，把 emoji 替换为 inline SVG
// 用户指定的 logo / WHERE 漏斗 不替换（在排除列表）
(function () {
    'use strict';
    if (!window.MQ_ICON_ALIAS) return;

    // 排除的元素选择器：这些容器内的 emoji 不动
    var EXCLUDE_PARENT = [
        '.logo',          // 顶部 logo
        '.funnel-icon',   // WHERE 漏斗
        '#funnel_icon',
        '.no-replace'
    ];

    // 排除的文本：含这些文字的整段不替换
    var EXCLUDE_TEXT = [
        'WHERE'  // WHERE 标签内的漏斗 emoji 已经在 ALIAS 中，但用户要求保留，这里跳过 .funnel-icon 父级即可
    ];

    function isExcluded(node) {
        var p = node.parentElement;
        while (p) {
            for (var i = 0; i < EXCLUDE_PARENT.length; i++) {
                try {
                    if (p.matches && p.matches(EXCLUDE_PARENT[i])) return true;
                } catch (e) {}
                if (p.classList && p.classList.contains(EXCLUDE_PARENT[i].replace('.', '').replace('#', ''))) {
                    // 简单 class 匹配
                    var cls = EXCLUDE_PARENT[i].replace('.', '');
                    if (p.classList.contains(cls)) return true;
                }
            }
            p = p.parentElement;
        }
        return false;
    }

    var alias = window.MQ_ICON_ALIAS;
    var pattern = /[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2010-\u2015]|[\u2190-\u21FF]|[\u2300-\u23FF]|[\u25A0-\u25FF]|[\u2600-\u26FF]|[\u2700-\u27BF]|[\u2900-\u297F]|[\u2B00-\u2BFF]|[\uFE00-\uFE0F]|[\u1F000-\u1FFFF]/g;
    // 简化：扫常见 emoji 范围
    var SIMPLE = /[\u2700-\u27BF]|[\u2190-\u21FF]|[\u2300-\u23FF]|[\u25A0-\u25FF]|[\u2600-\u26FF\u2700-\u27BF]|[\u2900-\u297F]|[\u2B00-\u2BFF]|[\uD83C-\uD83E][\uDC00-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uFE00-\uFE0F]|[\u1F000-\u1F02F]|[\u1F0A0-\u1F0FF]|[\u1F100-\u1F1FF]|[\u1F200-\u1F2FF]|[\u1F300-\u1F5FF]|[\u1F600-\u1F64F]|[\u1F680-\u1F6FF]|[\u1F700-\u1F77F]|[\u1F780-\u1F7FF]|[\u1F800-\u1F8FF]|[\u1F900-\u1F9FF]|[\u1FA00-\u1FA6F]|[\u1FA70-\u1FAFF]/g;

    function findEmojis(s) {
        if (!s) return null;
        var m = s.match(SIMPLE);
        return m;
    }

    function replaceTextNode(textNode) {
        if (isExcluded(textNode)) return;
        var text = textNode.nodeValue;
        var m = text.match(SIMPLE);
        if (!m) return;

        // 命中 emoji 替换
        var out = '';
        var last = 0;
        var re = new RegExp(SIMPLE.source, 'g');
        var mm;
        while ((mm = re.exec(text)) !== null) {
            out += text.substring(last, mm.index);
            var e = mm[0];
            var svg = alias[e];
            if (svg) {
                out += svg;
            } else {
                out += e;  // 没命中 alias 的 emoji 保持原样
            }
            last = mm.index + e.length;
        }
        if (last < text.length) out += text.substring(last);

        if (out !== text) {
            // 用 span 包裹以保留事件
            var span = document.createElement('span');
            span.innerHTML = out;
            var parent = textNode.parentNode;
            while (span.firstChild) parent.insertBefore(span.firstChild, textNode);
            parent.removeChild(textNode);
        }
    }

    function walk(root) {
        // 创建 TreeWalker 遍历文本节点
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                if (!n.nodeValue || n.nodeValue.length < 1) return NodeFilter.FILTER_REJECT;
                if (isExcluded(n)) return NodeFilter.FILTER_REJECT;
                // script/style 跳过
                var p = n.parentElement;
                while (p) {
                    if (p.tagName === 'SCRIPT' || p.tagName === 'STYLE' || p.tagName === 'NOSCRIPT') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    p = p.parentElement;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        var nodes = [];
        var n;
        while ((n = walker.nextNode())) nodes.push(n);
        // 倒序替换避免位置错乱
        for (var i = nodes.length - 1; i >= 0; i--) {
            replaceTextNode(nodes[i]);
        }
    }

    function apply() {
        walk(document.body);
    }

    // 首次加载
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }
    // 监听 DOM 变化（动态生成的内容）
    var obs = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
            for (var j = 0; j < muts[i].addedNodes.length; j++) {
                var n = muts[i].addedNodes[j];
                if (n.nodeType === 1) walk(n);
                else if (n.nodeType === 3) replaceTextNode(n);
            }
        }
    });
    function startObs() {
        obs.observe(document.body, { childList: true, subtree: true });
    }
    if (document.body) startObs();
    else document.addEventListener('DOMContentLoaded', startObs);

    // 暴露手动调用（动态拼接 innerHTML 后可手动触发）
    window.MQ_applyIcons = apply;
})();
