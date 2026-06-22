"""
DataGrip 连接导入
解析 dataSources.xml + dataSources.local.xml，导入为 MQDB 连接
"""
import eel
import re
import xml.etree.ElementTree as ET


# ==================== 驱动类型映射 ====================
DRIVER_TO_DB_TYPE = {
    'mysql.8': 'mysql',
    'mysql': 'mysql',
    'postgresql': 'postgresql',
    'redis': 'redis',
    'oracle': 'oracle',
    'mssql': 'mssql',
}

# DBMS 到驱动回退映射（dataSources.local.xml 中 dbms 字段）
DBMS_TO_DB_TYPE = {
    'MYSQL': 'mysql',
    'OCEANBASE': 'ob-mysql',
    'POSTGRES': 'postgresql',
    'REDIS': 'redis',
    'ORACLE': 'oracle',
    'MSSQL': 'mssql',
}


def _parse_jdbc_url(url: str):
    """
    解析 JDBC URL，提取 host 和 port
    支持格式:
      jdbc:mysql://host:port
      jdbc:postgresql://host:port/db
      jdbc:redis://host:port/db
    """
    if not url:
        return None, None
    match = re.match(r'jdbc:(\w+)://([^:/]+):(\d+)', url)
    if match:
        return match.group(2), match.group(3)
    return None, None


def _driver_to_db_type(driver_ref: str, dbms: str = '') -> str:
    """将 DataGrip driver-ref 转换为 MQDB db_type"""
    dt = DRIVER_TO_DB_TYPE.get(driver_ref, '')
    if dt:
        # OceanBase 用 mysql.8 驱动，但 dbms 是 OCEANBASE
        if dbms.upper() == 'OCEANBASE' and dt == 'mysql':
            return 'ob-mysql'
        return dt
    # 回退：从 dbms 推断
    return DBMS_TO_DB_TYPE.get(dbms.upper(), 'mysql')


@eel.expose
def datagrip_parse_import(xml_content: str, local_xml_content: str):
    """
    解析 DataGrip 的 dataSources.xml 和 dataSources.local.xml
    返回连接列表和分组信息

    dataSources.xml 结构:
      <data-source name="连接名" group="分组名" uuid="...">
        <driver-ref>mysql.8</driver-ref>
        <jdbc-url>jdbc:mysql://host:port</jdbc-url>
      </data-source>

    dataSources.local.xml 结构:
      <data-source name="连接名" uuid="...">
        <user-name>root</user-name>
      </data-source>

    匹配规则: 通过 name 比对两个文件
    没有 group 属性的连接 = 根级连接（不放入文件夹）
    """
    try:
        # ========== 解析 dataSources.xml ==========
        root = ET.fromstring(xml_content)
        sources = {}  # name -> {name, group, db_type, host, port, uuid}

        for ds in root.findall('.//data-source'):
            name = ds.get('name', '')
            group = ds.get('group', '')  # 空字符串 = 无分组
            uuid = ds.get('uuid', '')

            driver_ref_el = ds.find('driver-ref')
            driver_ref = driver_ref_el.text.strip() if driver_ref_el is not None and driver_ref_el.text else 'mysql.8'

            jdbc_url_el = ds.find('jdbc-url')
            jdbc_url = jdbc_url_el.text.strip() if jdbc_url_el is not None and jdbc_url_el.text else ''

            host, port = _parse_jdbc_url(jdbc_url)

            if not name:
                continue

            sources[name] = {
                'name': name,
                'group': group,
                'db_type': 'mysql',  # 默认，后续从 local 补齐
                'host': host or '',
                'port': port or '3306',
                'uuid': uuid,
                'driver_ref': driver_ref,
            }

        # ========== 解析 dataSources.local.xml ==========
        local_root = ET.fromstring(local_xml_content)
        local_sources = {}  # name -> {user, dbms}

        for ds in local_root.findall('.//data-source'):
            name = ds.get('name', '')
            user_el = ds.find('user-name')
            user_name = user_el.text.strip() if user_el is not None and user_el.text else ''

            # 从 database-info 获取 dbms
            db_info = ds.find('database-info')
            dbms = ''
            if db_info is not None:
                dbms = db_info.get('dbms', '')

            if not name:
                continue

            local_sources[name] = {
                'user': user_name,
                'dbms': dbms,
            }

        # ========== 匹配合并 ==========
        connections = []
        groups = set()

        for name, src in sources.items():
            local = local_sources.get(name, {})
            dbms = local.get('dbms', '')

            # 确定 db_type：优先从 driver_ref + dbms 推断
            db_type = _driver_to_db_type(src.get('driver_ref', 'mysql.8'), dbms)

            # Redis JDBC URL 特殊处理（去掉 /0 等数据库后缀）
            host = src['host']
            port = src['port']

            conn = {
                'name': name,
                'group': src['group'],
                'host': host,
                'port': port,
                'user': local.get('user', ''),
                'pwd': '',  # DataGrip 不导出密码
                'db_type': db_type,
            }
            connections.append(conn)
            if src['group']:
                groups.add(src['group'])

        return {
            'ok': True,
            'connections': connections,
            'groups': sorted(list(groups)),
            'count': len(connections),
        }

    except ET.ParseError as e:
        return {'ok': False, 'msg': f'XML 解析错误: {str(e)}'}
    except Exception as e:
        return {'ok': False, 'msg': f'导入失败: {str(e)}'}
