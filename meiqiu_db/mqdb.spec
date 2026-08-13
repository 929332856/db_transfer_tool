# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_data_files

datas = [('web', 'web'), ('app', 'app'), ('db_transfer_eel.py', '.'), ('modules', 'modules')]
datas += collect_data_files('eel')
datas += collect_data_files('sqlalchemy')
datas += collect_data_files('MySQLdb')
datas += collect_data_files('bottle')
datas += collect_data_files('psycopg2')
datas += collect_data_files('oracledb')
datas += collect_data_files('pymssql')
datas += collect_data_files('redis')


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=['db_transfer_eel', 'modules', 'modules.config_state', 'modules.table_ops', 'modules.table_design', 'modules.transfer_engine', 'modules.export_import', 'modules.db_manage', 'modules.redis_ops', 'modules.datagrip_import', 'modules.tree_manager'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['customtkinter', 'matplotlib', 'numpy', 'pandas', 'PIL'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='mqdb',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['web\\mqdb.ico'],
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='mqdb',
)
