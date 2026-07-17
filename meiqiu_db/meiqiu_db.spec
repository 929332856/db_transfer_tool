# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# 收集各包的子模块（字符串列表，用于 hiddenimports）
eel_subs = collect_submodules('eel')
sa_subs = collect_submodules('sqlalchemy')
py_subs = collect_submodules('MySQLdb')
bt_subs = collect_submodules('bottle')
pg_subs = collect_submodules('psycopg2')
or_subs = collect_submodules('oracledb')
ms_subs = collect_submodules('pymssql')
redis_subs = collect_submodules('redis')
cr_subs = collect_submodules('cryptography')  # oracle thin 模式依赖
flask_subs = collect_submodules('flask')
wt_subs = collect_submodules('waitress')
wv_subs = collect_submodules('webview')
fc_subs = collect_submodules('flask_cors')

# 收集各包的数据文件（元组列表，用于 datas）
eel_datas = collect_data_files('eel')
sa_datas = collect_data_files('sqlalchemy')
py_datas = collect_data_files('MySQLdb')
bt_datas = collect_data_files('bottle')
pg_datas = collect_data_files('psycopg2')
or_datas = collect_data_files('oracledb')
ms_datas = collect_data_files('pymssql')
redis_datas = collect_data_files('redis')

all_hidden = (eel_subs + sa_subs + py_subs + bt_subs + pg_subs + or_subs + ms_subs +
              redis_subs + cr_subs + flask_subs + wt_subs + wv_subs + fc_subs +
              ['db_transfer_eel', 'modules', 'modules.config_state', 'modules.table_ops',
               'modules.table_design', 'modules.transfer_engine', 'modules.export_import',
               'modules.db_manage', 'modules.redis_ops', 'modules.datagrip_import',
               'modules.tree_manager'])
all_extra_datas = [
    ('web', 'web'),
    ('app', 'app'),
    ('db_transfer_eel.py', '.'),      # ★ 主业务模块（.py 源码）
    ('modules', 'modules'),            # ★ 子模块目录
] + eel_datas + sa_datas + py_datas + bt_datas + pg_datas + or_datas + ms_datas + redis_datas

if Path('db_profiles.json').exists():
    all_extra_datas.append(('db_profiles.json', '.'))
if Path('dist/navicat_tree.json').exists():
    all_extra_datas.append(('dist/navicat_tree.json', '.'))
elif Path('navicat_tree.json').exists():
    all_extra_datas.append(('navicat_tree.json', '.'))

a = Analysis(
    ['main.py'],  # ★ 入口改为 main.py（Flask + PyWebView）
    pathex=[],
    binaries=[],
    datas=all_extra_datas,
    hiddenimports=all_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'customtkinter',
        'matplotlib',
        'numpy',
        'pandas',
        'PIL',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='mqdb',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlement_file=None,
    icon='web/mqdb.ico',
)
