"""
Redis 操作
"""
import eel
import time
import sys
import os
import json
from modules import BASE_DIR

# Helper functions defined inline in this module

# ==================== Redis 操作 ====================
def _get_redis(conn_data, db=None):
    import redis as rds
    target_db = db if db is not None else int(conn_data.get('db','0') or '0')
    try:
        return rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                         password=conn_data.get('pwd') or None,
                         db=target_db,
                         socket_connect_timeout=5, socket_timeout=30,
                         decode_responses=False,
                         protocol=2)
    except TypeError:
        return rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                         password=conn_data.get('pwd') or None,
                         db=target_db,
                         socket_connect_timeout=5, socket_timeout=30,
                         decode_responses=False)


def _smart_decode(raw):
    """智能解码 Redis 返回的 bytes，依次尝试 UTF-8 / GBK / Latin-1"""
    if isinstance(raw, str):
        return raw
    if not isinstance(raw, bytes):
        return str(raw)
    for enc in ('utf-8', 'gbk', 'gb2312', 'gb18030', 'latin-1'):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', errors='replace')


def _decode_all(obj):
    """递归解码 Redis 返回结果中所有 bytes（支持 dict/list/tuple/set）"""
    if isinstance(obj, dict):
        return {_smart_decode(k): _decode_all(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_decode_all(item) for item in obj]
    elif isinstance(obj, set):
        return {_smart_decode(item) for item in obj}
    elif isinstance(obj, (bytes, bytearray)):
        return _smart_decode(obj)
    return obj


@eel.expose
def redis_get_databases(conn_data):
    """获取 Redis 的所有数据库列表及键数量"""
    import redis as rds
    try:
        r = rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                       password=conn_data.get('pwd') or None,
                       socket_connect_timeout=5, socket_timeout=10,
                       decode_responses=True, encoding='utf-8', encoding_errors='replace')
        # 获取数据库数量配置
        try:
            db_count = int(r.config_get('databases').get('databases', 16))
        except Exception:
            db_count = 16
        db_count = min(db_count, 16)  # 最多扫描16个
        
        databases = []
        for db_idx in range(db_count):
            key_count = 0
            try:
                r2 = rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                                password=conn_data.get('pwd') or None,
                                db=db_idx,
                                socket_connect_timeout=3, socket_timeout=5,
                                decode_responses=True, encoding='utf-8', encoding_errors='replace',
                                protocol=2)
                key_count = r2.dbsize()
            except TypeError:
                try:
                    r2 = rds.Redis(host=conn_data['host'], port=int(conn_data.get('port','6379')),
                                    password=conn_data.get('pwd') or None,
                                    db=db_idx,
                                    socket_connect_timeout=3, socket_timeout=5,
                                    decode_responses=True, encoding='utf-8', encoding_errors='replace')
                    key_count = r2.dbsize()
                except Exception:
                    pass
            except Exception:
                # 如果 dbsize 失败，尝试通过 SELECT + DBSIZE 在主连接上查询
                try:
                    r.execute_command('SELECT', db_idx)
                    key_count = r.dbsize()
                except Exception:
                    pass
            databases.append({"db": db_idx, "keys": key_count})
        
        return {"ok": True, "databases": databases}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_get_keys(conn_data, pattern='*', limit=100, db=None):
    """获取 Redis 的 key 列表，按分组组织，使用 SCAN 避免阻塞"""
    # 日志记录辅助函数（同时输出到控制台和文件）
    def _log_redis(msg):
        # 打印到控制台（exe运行时不可见，除非console=True）
        print(f"[Redis] {msg}")
        # 强制写入 exe/脚本目录下的 redis_debug.log 文件
        try:
            import os, sys, time
            
            # 确定目标目录
            if getattr(sys, 'frozen', False):
                # 打包exe环境：exe所在目录
                base_dir = os.path.dirname(sys.executable)
                print(f"[Redis] EXE环境，基目录: {base_dir}")
            else:
                # Python脚本环境：脚本所在目录
                base_dir = os.path.dirname(os.path.abspath(__file__))
                print(f"[Redis] Python环境，脚本目录: {base_dir}")
            
            log_file = os.path.join(base_dir, "redis_debug.log")
            print(f"[Redis] 日志文件目标路径: {log_file}")
            
            # 确保目录存在
            os.makedirs(base_dir, exist_ok=True)
            
            # 写入日志（追加模式）
            with open(log_file, "a", encoding="utf-8") as f:
                timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                f.write(f"{timestamp} [Redis] {msg}\n")
                f.flush()  # 立即刷新，确保数据写入磁盘
            
            # 存储日志路径到全局变量
            if '__redis_log_path' not in globals():
                globals()['__redis_log_path'] = log_file
                print(f"[Redis] 日志文件已创建: {log_file}")
            
        except Exception as e:
            print(f"[Redis] 严重错误: 无法写入日志文件 {log_file}: {e}")
            # 尝试备用方案：写入临时目录
            try:
                import tempfile
                temp_log = os.path.join(tempfile.gettempdir(), "redis_debug.log")
                with open(temp_log, "a", encoding="utf-8") as f:
                    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                    f.write(f"{timestamp} [Redis] {msg}\n")
                print(f"[Redis] 已写入临时文件: {temp_log}")
            except Exception as e2:
                print(f"[Redis] 备用日志写入也失败: {e2}")
    
    # 首次调用时显示日志文件位置
    if not hasattr(_log_redis, '_initialized'):
        _log_redis._initialized = True
        if '__redis_log_path' in globals():
            print(f"[Redis] 日志文件位置: {globals()['__redis_log_path']}")
    
    try:
        import time
        start_time = time.time()
        _log_redis(f"开始获取 keys，pattern={pattern}, limit={limit}, db={db}")
        r = _get_redis(conn_data, db=db)
        # 测试连接是否真的可用
        try:
            r.ping()
            _log_redis("连接测试成功")
        except Exception as ping_err:
            _log_redis(f"连接测试失败: {ping_err}")
            return {"ok": False, "msg": f"Redis连接失败: {ping_err}"}
        
        keys = []
        cursor = 0
        max_iterations = 10  # 最多迭代10次，防止无限循环
        iteration = 0
        max_scantime = 8.0  # SCAN操作最多8秒，超时则返回已获取的keys
        
        # 使用 SCAN 命令增量获取 keys，避免 KEYS 命令阻塞
        _log_redis("开始 SCAN 迭代")
        while iteration < max_iterations:
            iteration += 1
            try:
                cursor, batch = r.scan(cursor=cursor, match=pattern, count=300)  # 每次扫描300个key
                keys.extend(batch)
                _log_redis(f"迭代 {iteration}: cursor={cursor}, 本次获取 {len(batch)} keys, 累计 {len(keys)} keys")
                
                # 达到限制或扫描完成
                if len(keys) >= limit or cursor == 0:
                    if cursor == 0:
                        _log_redis("SCAN 完成，cursor=0")
                    else:
                        _log_redis(f"达到限制 {limit} keys")
                    break
                
                # 检查是否超时
                if time.time() - start_time > max_scantime:
                    _log_redis(f"SCAN 超时（{max_scantime}秒），返回已获取的keys")
                    break
                    
            except Exception as scan_err:
                _log_redis(f"SCAN 出错: {scan_err}")
                # 如果扫描出错，返回已获取的keys
                break
        
        scan_time = time.time() - start_time
        _log_redis(f"SCAN 完成，耗时 {scan_time:.2f} 秒，共获取 {len(keys)} keys")
        
        # 如果实际获取的键超过限制，截断
        has_more = len(keys) > limit
        if has_more:
            keys = keys[:limit]
        
        # 所有 key 统一放入一个"键"文件夹，不做按前缀分组
        result = [{"group": "键", "keys": [_smart_decode(k) for k in keys]}]
        
        # 获取总键数（可能较慢，但提供近似值）
        try:
            total = r.dbsize()
            _log_redis(f"dbsize() 成功，总键数: {total}")
        except Exception as dbsize_err:
            _log_redis(f"dbsize() 失败: {dbsize_err}")
            total = len(keys)  # 失败时使用当前获取的数量作为近似值
        
        total_time = time.time() - start_time
        _log_redis(f"函数总耗时 {total_time:.2f} 秒，返回 {len(result)} 个分组")
        return_result = {"ok": True, "groups": result, "total": total}
        _log_redis(f"返回数据结构: ok={return_result['ok']}, groups数量={len(result)}, total={total}")
        # 调试：打印返回值摘要
        print(f"[DEBUG] Redis函数准备返回: ok=True, total={total}, groups={len(result)}")
        
        # 详细调试：检查返回值是否可序列化
        try:
            import json
            test_json = json.dumps(return_result)
            _log_redis(f"返回值JSON序列化测试通过，长度: {len(test_json)} 字符")
        except Exception as json_err:
            _log_redis(f"返回值JSON序列化失败: {json_err}")
            # 尝试诊断哪个字段有问题
            for key, value in return_result.items():
                try:
                    json.dumps({key: value})
                except Exception as field_err:
                    _log_redis(f"字段 '{key}' 无法序列化: {field_err}, 类型: {type(value)}")
                    if key == 'groups':
                        for i, group in enumerate(value):
                            try:
                                json.dumps(group)
                            except Exception as group_err:
                                _log_redis(f"分组 {i} ('{group.get('group', '未知')}') 无法序列化: {group_err}")
                                if 'keys' in group:
                                    for j, k in enumerate(group['keys'][:3]):  # 只检查前3个key
                                        try:
                                            json.dumps(k)
                                        except Exception as key_err:
                                            _log_redis(f"key {j} ('{k[:50]}...') 无法序列化: {key_err}, 类型: {type(k)}")
        
        # 记录返回值摘要到日志
        _log_redis(f"准备返回: total={total}, groups={len(result)}, keys示例={sum(len(g['keys']) for g in result)}")
        
        # Eel调试信息
        print(f"[EEL-DEBUG] 返回值类型: {type(return_result)}")
        print(f"[EEL-DEBUG] 返回值键: {list(return_result.keys())}")
        print(f"[EEL-DEBUG] groups数量: {len(return_result.get('groups', []))}")
        
        return return_result
    except Exception as e:
        _log_redis(f"异常: {e}")
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_get_key_info(conn_data, key, db=None):
    """获取单个 key 的详细信息（类型、TTL、值）"""
    try:
        r = _get_redis(conn_data, db=db)
        ktype = _smart_decode(r.type(key))  # decode_responses=False 返回 bytes，需解码
        ttl = r.ttl(key)
        info = {"key": key, "type": ktype, "ttl": ttl, "ttl_str": _format_ttl(ttl)}
        if ktype == 'string':
            info["value"] = _smart_decode(r.get(key))
        elif ktype == 'hash':
            info["value"] = {_smart_decode(k): _smart_decode(v) for k, v in r.hgetall(key).items()}
        elif ktype == 'list':
            vals = r.lrange(key, 0, 99)
            info["value"] = [_smart_decode(v) for v in vals]
            info["length"] = r.llen(key)
        elif ktype == 'set':
            members = r.smembers(key)
            info["value"] = [_smart_decode(m) for m in list(members)[:100]]
            info["length"] = r.scard(key)
        elif ktype == 'zset':
            items = r.zrange(key, 0, 99, withscores=True)
            info["value"] = [(_smart_decode(it[0]), it[1]) for it in items]
            info["length"] = r.zcard(key)
        return {"ok": True, "info": info}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_get_keys_meta(conn_data, keys, db=None):
    """批量获取 key 的元数据（类型、TTL、大小），使用 pipeline 优化"""
    try:
        r = _get_redis(conn_data, db=db)
        if not keys:
            return {"ok": True, "meta": {}}
        # 使用 pipeline 批量获取
        pipe = r.pipeline(transaction=False)
        for k in keys:
            pipe.type(k)
            pipe.ttl(k)
        results = pipe.execute()
        meta = {}
        for i, k in enumerate(keys):
            idx = i * 2
            ktype = _smart_decode(results[idx])
            ttl_val = results[idx + 1]
            size_str = ''
            # 根据类型获取大小
            try:
                if ktype == 'string':
                    size_str = r.strlen(k)
                elif ktype == 'hash':
                    size_str = r.hlen(k)
                elif ktype == 'list':
                    size_str = r.llen(k)
                elif ktype == 'set':
                    size_str = r.scard(k)
                elif ktype == 'zset':
                    size_str = r.zcard(k)
            except:
                pass
            # 格式化 TTL 显示
            if ttl_val < 0:
                ttl_str = 'No TTL'
            elif ttl_val == 0:
                ttl_str = '已过期'
            else:
                ttl_str = _format_ttl(ttl_val)
            meta[k] = {
                'type': ktype,
                'ttl': ttl_val,
                'ttl_str': ttl_str,
                'size': size_str,
                'size_str': format_size(size_str) if isinstance(size_str, int) else str(size_str),
            }
        return {"ok": True, "meta": meta}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _redis_check_type(r, key, expected_type, cmd_name, alt_cmd):
    """检查 Redis key 类型，如果不匹配返回友好错误提示"""
    try:
        ktype = r.type(key)
        if isinstance(ktype, bytes):
            ktype = ktype.decode()
        if ktype and ktype != 'none' and ktype != expected_type:
            return {"ok": False, "msg": f"Key 类型为 {ktype}，不能使用 {cmd_name} 命令。请使用: {alt_cmd}"}
    except Exception:
        pass  # 类型检查失败不阻塞，让原命令报错
    return None


@eel.expose
def redis_execute(conn_data, command):
    """执行 Redis 命令并返回结果"""
    try:
        r = _get_redis(conn_data)
        parts = command.strip().split()
        if not parts:
            return {"ok": False, "msg": "空命令"}
        cmd = parts[0].upper()
        args = parts[1:]
        if cmd == 'GET':
            if args:
                key = args[0]
                chk = _redis_check_type(r, key, 'string', 'GET',
                    f'HGETALL {key} / LRANGE {key} 0 -1 / SMEMBERS {key} / ZRANGE {key} 0 -1 WITHSCORES')
                if chk: return chk
                result = r.get(key)
            else:
                result = None
        elif cmd == 'SET':
            r.set(*args)
            result = "OK"
        elif cmd == 'DEL':
            result = r.delete(*args)
        elif cmd == 'KEYS':
            result = r.keys(args[0] if args else '*')
        elif cmd == 'TYPE':
            result = r.type(args[0]) if args else None
        elif cmd == 'TTL':
            result = r.ttl(args[0]) if args else None
        elif cmd == 'EXISTS':
            result = r.exists(*args)
        elif cmd == 'DBSIZE':
            result = r.dbsize()
        elif cmd == 'FLUSHDB':
            result = "危险操作，请在 redis-cli 中手动执行"
        elif cmd == 'SCAN':
            cursor = int(args[0]) if args else 0
            match = args[1] if len(args) > 1 else '*'
            result = list(r.scan(cursor=cursor, match=match, count=50))
        elif cmd == 'PING':
            result = r.ping()
        elif cmd == 'INFO':
            section = args[0] if args else 'server'
            result = r.info(section)
        elif cmd == 'HGETALL':
            if args:
                chk = _redis_check_type(r, args[0], 'hash', 'HGETALL',
                    f'GET {args[0]} / LRANGE {args[0]} 0 -1 / SMEMBERS {args[0]} / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
                result = r.hgetall(args[0])
            else:
                result = {}
        elif cmd == 'HGET':
            if len(args) >= 2:
                chk = _redis_check_type(r, args[0], 'hash', 'HGET',
                    f'GET {args[0]} / LRANGE {args[0]} 0 -1 / SMEMBERS {args[0]} / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
                result = r.hget(args[0], args[1])
            else:
                result = None
        elif cmd == 'LRANGE':
            if args:
                chk = _redis_check_type(r, args[0], 'list', 'LRANGE',
                    f'GET {args[0]} / HGETALL {args[0]} / SMEMBERS {args[0]} / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
            key = args[0] if args else ''
            start = int(args[1]) if len(args) > 1 else 0
            end = int(args[2]) if len(args) > 2 else -1
            result = r.lrange(key, start, end)
        elif cmd == 'SMEMBERS':
            if args:
                chk = _redis_check_type(r, args[0], 'set', 'SMEMBERS',
                    f'GET {args[0]} / HGETALL {args[0]} / LRANGE {args[0]} 0 -1 / ZRANGE {args[0]} 0 -1 WITHSCORES')
                if chk: return chk
            result = list(r.smembers(args[0])) if args else []
        elif cmd == 'ZRANGE':
            if args:
                chk = _redis_check_type(r, args[0], 'zset', 'ZRANGE',
                    f'GET {args[0]} / HGETALL {args[0]} / LRANGE {args[0]} 0 -1 / SMEMBERS {args[0]}')
                if chk: return chk
            key = args[0] if args else ''
            start = int(args[1]) if len(args) > 1 else 0
            end = int(args[2]) if len(args) > 2 else -1
            result = r.zrange(key, start, end, withscores=True)
        elif cmd == 'LPUSH':
            r.lpush(*args)
            result = "OK"
        elif cmd == 'RPUSH':
            r.rpush(*args)
            result = "OK"
        elif cmd == 'SADD':
            r.sadd(*args)
            result = "OK"
        elif cmd == 'ZADD':
            r.zadd(*args)
            result = "OK"
        else:
            # 通用执行（注意安全）
            result = r.execute_command(cmd, *args)
        return {"ok": True, "result": _decode_all(result)}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_delete_key(conn_data, key, db=None):
    """删除 Redis key"""
    try:
        r = _get_redis(conn_data, db=db)
        count = r.delete(key)
        return {"ok": True, "msg": f"已删除 {count} 个 key"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


# ==================== Redis 值编辑 ====================

@eel.expose
def redis_set_string(conn_data, key, value, db=None):
    """保存 Redis string 类型的值"""
    try:
        r = _get_redis(conn_data, db=db)
        r.set(key, value)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_hash(conn_data, key, fields, deletes, db=None):
    """修改 Redis hash：fields={field:value,...} 批量更新，deletes=[field,...] 批量删除"""
    try:
        r = _get_redis(conn_data, db=db)
        if deletes:
            for f in deletes:
                r.hdel(key, f)
        if fields:
            r.hset(key, mapping=fields)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_list(conn_data, key, items, db=None):
    """覆盖 Redis list 的全部内容"""
    try:
        r = _get_redis(conn_data, db=db)
        r.delete(key)
        if items:
            r.rpush(key, *items)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_set(conn_data, key, members, db=None):
    """覆盖 Redis set 的全部成员"""
    try:
        r = _get_redis(conn_data, db=db)
        r.delete(key)
        if members:
            r.sadd(key, *members)
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_set_zset(conn_data, key, items, db=None):
    """覆盖 Redis zset 的全部成员，items=[(member,score),...]"""
    try:
        r = _get_redis(conn_data, db=db)
        r.delete(key)
        if items:
            r.zadd(key, dict(items))
        return {"ok": True, "msg": "保存成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_append_list(conn_data, key, value, db=None):
    """往 Redis list 尾部追加元素"""
    try:
        r = _get_redis(conn_data, db=db)
        r.rpush(key, value)
        return {"ok": True, "msg": "追加成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_append_set(conn_data, key, member, db=None):
    """往 Redis set 添加成员"""
    try:
        r = _get_redis(conn_data, db=db)
        r.sadd(key, member)
        return {"ok": True, "msg": "添加成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@eel.expose
def redis_append_zset(conn_data, key, member, score, db=None):
    """往 Redis zset 添加成员"""
    try:
        r = _get_redis(conn_data, db=db)
        r.zadd(key, {member: score})
        return {"ok": True, "msg": "添加成功"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def _format_ttl(ttl):
    if ttl == -1: return "永久"
    if ttl == -2: return "已过期"
    if ttl > 86400: return f"{ttl//86400} 天"
    if ttl > 3600: return f"{ttl//3600} 小时"
    if ttl > 60: return f"{ttl//60} 分钟"
    return f"{ttl} 秒"


def format_size(size_val):
    """格式化大小显示（字节→KB/MB）"""
    if not isinstance(size_val, (int, float)) or size_val < 0:
        return str(size_val) if size_val else '0 B'
    if size_val < 1024:
        return f"{size_val} B"
    elif size_val < 1024 * 1024:
        return f"{size_val / 1024:.1f} KB"
    else:
        return f"{size_val / (1024*1024):.1f} MB"
