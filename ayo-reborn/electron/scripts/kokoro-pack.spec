# -*- mode: python ; coding: utf-8 -*-
# Rita packaged live-voice worker: Kokoro-82M onnx engine, no Python needed on
# the user's PC. Model/voice files are downloaded (or resumable) at runtime.
import os

a = Analysis(
    ['kokoro-server.py'],
    pathex=[os.path.abspath('.')],
    binaries=None,
    datas=None,
    hiddenimports=['onnxruntime', 'onnxruntime.capi', 'numpy', 'requests'],
    excludes=['torch', 'tkinter', 'matplotlib', 'PIL'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='kokoro-server',
    debug=False,
    strip=False,
    upx=False,
    console=True,          # keeps the JSON-banner protocol over stdout
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='kokoro-server',
)
