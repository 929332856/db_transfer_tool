/**
 * Flask 适配层 —— 替代 Eel 的 eel.xxx()(callback) 调用
 * 用法：在 index.html 中 <script src="js/eel_adapter.js"></script>
 *       放在 eel.js 之前，之后的代码无需修改
 */
(function() {
    'use strict';

    // 轮询 job 结果（替代 _eelAutoAsync 的部分逻辑）
    var _asyncJobs = {};

    window._pollAsyncJob = function(jobId, callback, timeoutMs, onTimeout) {
        timeoutMs = timeoutMs || 15000;
        var startTime = Date.now();
        (function poll() {
            if (Date.now() - startTime > timeoutMs) {
                if (onTimeout) onTimeout();
                else callback({"ok": false, "msg": "操作超时（" + Math.round(timeoutMs/1000) + "秒）"});
                return;
            }
            fetch('/api/poll/' + jobId, {method:'GET'})
                .then(function(r){ return r.json(); })
                .then(function(result) {
                    if (result && result._pending) {
                        setTimeout(poll, 200);
                    } else {
                        callback(result || {"ok": false, "msg": "无响应"});
                    }
                })
                .catch(function(err) {
                    callback({"ok": false, "msg": "网络错误: " + err.message});
                });
        })();
    };

    // 创建 eel 代理对象
    window.eel = new Proxy({}, {
        get: function(target, prop) {
            if (typeof prop !== 'string' || prop[0] === '_') return undefined;
            return function() {
                var args = Array.prototype.slice.call(arguments);
                return function(callback) {
                    // ★ 构建请求：多个参数 → 完整位置参数
                    // 总是用 arg0,arg1,arg2 格式（最通用）
                    var body = {};
                    for (var i = 0; i < args.length; i++) {
                        body['arg' + i] = args[i];
                    }

                    fetch('/api/' + prop, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(body)
                    })
                    .then(function(r){ return r.json(); })
                    .then(function(result) {
                        if (result && result._async && result._job_id) {
                            window._pollAsyncJob(result._job_id, callback);
                        } else {
                            callback(result);
                        }
                    })
                    .catch(function(err) {
                        callback({"ok": false, "msg": "请求失败: " + err.message});
                    });
                };
            };
        }
    });

    // 兼容 Eel 的工具函数
    if (!window._eelAutoAsync) {
        window._eelAutoAsync = function(eelCall, callback, timeoutMs, onTimeout) {
            eelCall(function(resp) {
                if (resp && resp._async && resp._job_id) {
                    window._pollAsyncJob(resp._job_id, callback, timeoutMs, onTimeout);
                } else {
                    callback(resp);
                }
            });
        };
    }

    console.log('[eel_adapter] Flask 适配层已加载');
})();
