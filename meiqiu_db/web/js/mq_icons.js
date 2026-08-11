// ★ MQ 现代线性 SVG 图标库
// 用法：MQ_ICON.save → 返回 inline SVG 字符串，可直接拼接到 innerHTML
// 设计风格：24x24 viewBox，1.6 描边，圆角端点，跟主流开源 UI 库 (Lucide / Tabler) 一致
(function (global) {
    'use strict';
    // 通用属性
    var A = 'width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0"';

    // 工具：生成 SVG
    function svg(body) {
        return '<svg ' + A + '>' + body + '</svg>';
    }
    // 工具：生成带填充色的彩色 SVG（数据库品牌图标用）
    function svgC(body, fillColor, strokeColor) {
        var sa = strokeColor ? 'stroke="' + strokeColor + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"' : 'stroke="none"';
        return '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="' + fillColor + '" ' + sa + ' style="vertical-align:-2px;display:inline-block;flex-shrink:0">' + body + '</svg>';
    }

    var I = {
        // ========== 操作类 ==========
        save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
        cancel: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
        confirm: svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
        edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
        delete: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
        close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
        add: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
        minus: svg('<line x1="5" y1="12" x2="19" y2="12"/>'),
        refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),

        // ========== 状态/反馈 ==========
        success: svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
        error: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
        warn: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
        info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
        tip: svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.9.7 1.5 1.8 1.5 3v.3a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V17a4 4 0 0 1 1.5-3A7 7 0 0 0 12 2z"/>'),

        // ========== 数据库品牌 logo（使用 database/ 目录下的 .svg 图片） ==========
        dbMysql:     '<img src="database/mysql.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbOceanBase: '<img src="database/oceanbase.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbPostgres:  '<img src="database/postgres.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbOracle:    '<img src="database/oracle.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbMssql:     '<img src="database/sqlserver.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbRedis:     '<img src="database/redis.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbMongo:     '<img src="database/mongodb.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbMaria:     '<img src="database/mariadb.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbTidb:      '<img src="database/tidb.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbDm:        '<img src="database/dm.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',
        dbUnknown:   '<img src="database/unknown.svg" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0">',

        // ========== 文件/目录 ==========
        folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
        folderOpen: svg('<path d="M6 14l1.5-1.5h11A2.4 2.4 0 0 0 20 10V8a2 2 0 0 0-2-2h-7l-2-3H4a2 2 0 0 0-2 2v11"/><path d="M2 16l3-7h17l-3 7H2z"/>'),
        file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>'),
        table: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>'),
        view: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
        column: svg('<line x1="6" y1="3" x2="6" y2="21"/><line x1="18" y1="3" x2="18" y2="21"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>'),
        index: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><circle cx="6" cy="6" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="6" cy="18" r="1.5"/>'),
        proc: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
        func: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/>'),
        viewIcon: svg('<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>'),
        trigger: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
        export: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
        import: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),

        // ========== 工具 ==========
        play: svg('<polygon points="5 3 19 12 5 21 5 3"/>'),
        stop: svg('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
        search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
        funnel: svg('<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>'),
        settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
        tool: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
        download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
        upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),

        // ========== 数据/图表 ==========
        chart: svg('<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>'),
        count: svg('<path d="M3 3h18v18H3z"/><path d="M7 8h10M7 12h10M7 16h6"/>'),

        // ========== 时间/状态 ==========
        clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
        loading: svg('<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>'),

        // ========== 包/模块 ==========
        pkg: svg('<path d="M12 2l9 4.5v11L12 22l-9-4.5v-11L12 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="9.5" x2="15" y2="12.5"/><line x1="9" y1="12.5" x2="15" y2="9.5"/>'),
        archive: svg('<path d="M20 7l-2 14H6L4 7"/><rect x="2" y="3" width="20" height="4" rx="1"/>'),
        link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
        unlock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
        lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
        globe: svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
        star: svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
        fire: svg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
        gift: svg('<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>'),
        cake: svg('<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16h16"/><path d="M2 21h20"/><path d="M12 3v6"/><path d="M9 6h6"/>'),

        // ========== 文本/编辑 ==========
        text: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
        copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
        clean: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),

        // ========== 用户/系统 ==========
        home: svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
        monitor: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
        zap: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
        award: svg('<circle cx="12" cy="8" r="6"/><polyline points="15.477 12.89 17 22 12 19 7 22 8.523 12.89"/>'),
        target: svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>')
    };

    // 兼容历史 emoji 别名：返回 SVG 字符串（替换时直接当 innerHTML 拼接）
    var ALIAS = {
        '✅': I.success, '✔': I.success, '✓': I.success,
        '❌': I.error, '✕': I.close, '✗': I.close,
        '⚠️': I.warn, '⚠': I.warn,
        '💡': I.tip,
        '⏳': I.loading, '⏱': I.clock, '⏲': I.clock, '⌛': I.clock,
        '🔧': I.tool, '🔍': I.search, '🔗': I.link,
        '📁': I.folder, '📂': I.folderOpen, '📋': I.copy, '🔄': I.refresh,
        '↩': I.refresh,
        '💾': I.save, '🗑': I.delete,
        '📥': I.import, '📤': I.export,
        '▶': I.play, '⏹': I.stop,
        '📊': I.chart, '📈': I.chart, '📉': I.chart, '📌': I.target,
        '🔒': I.lock, '🔓': I.unlock, '🌐': I.globe,
        '🔴': I.dbOracle, '🟢': I.dbMssql,
        '📦': I.pkg, '📄': I.file, '📝': I.text, '🧹': I.clean,
        '🎉': I.gift, '🎊': I.gift, '🏆': I.award, '🥇': I.award,
        '🎯': I.target, '🚀': I.zap, '🌟': I.star, '🔥': I.fire,
        '💬': I.copy, '📞': I.tool, '📧': I.text,
        '🏠': I.home, '🏢': I.monitor, '⚙': I.settings, '🛠': I.tool, '🧰': I.tool,
        '💻': I.monitor, '🖥': I.monitor, '📱': I.monitor,
        '⌨': I.tool, '🖱': I.tool, '🖨': I.tool, '💽': I.dbMysql, '🗄': I.dbMysql, '🗂': I.folder,
        '📅': I.clock, '⏰': I.clock,
        '🌙': I.dbMysql, '☀': I.dbMysql, '⭐': I.star,
        '💧': I.dbOceanBase, '🌊': I.dbOceanBase, '🐘': I.dbPostgres, '🐬': I.dbMysql,
        '🗃': I.dbRedis, '🗒': I.dbMysql, '📑': I.dbMysql, '🎁': I.gift,
        '✎': I.edit
    };

    global.MQ_ICON = I;
    global.MQ_ICON_ALIAS = ALIAS;

    // 兼容旧调用：MQ_ICON.emoji('✅') → 返回 svg 字符串
    global.MQ_ICON.emoji = function (e) { return ALIAS[e] || e; };
})(window);
