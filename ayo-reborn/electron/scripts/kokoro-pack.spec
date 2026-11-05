# -*- mode: python ; coding: utf-8 -*-
# Rita packaged live-voice worker: Kokoro-82M onnx engine, no Python needed on
# the user's PC. Model/voice files are downloaded (or resumable) at runtime.
import os
from PyInstaller.utils.hooks import collect_data_files

# kokoro_onnx: config.json | language_tags: language-code json db |
# espeakng_loader: the espeak-ng-data tree phonemizer resolves at synth time |
# phonemizer: smsg tables if any
datas = []
datas += collect_data_files('kokoro_onnx')
datas += collect_data_files('language_tags')
datas += collect_data_files('espeakng_loader')
datas += collect_data_files('phonemizer')

a = Analysis(
    ['kokoro-server.py'],
    pathex=[os.path.abspath('.')],
    binaries=None,
    datas=datas,
    hiddenimports=[
        'onnxruntime', 'onnxruntime.capi', 'numpy', 'requests',
        'language_tags', 'espeakng_loader', 'phonemizer', 'colorlog',
    ],
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
