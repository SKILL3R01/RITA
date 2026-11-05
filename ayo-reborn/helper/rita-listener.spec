# -*- mode: python ; coding: utf-8 -*-
# Rita packaged 'ears': one-dir bundle of the fully-local listener —
# wake word (openwakeword/onnxruntime) + whisper STT (faster-whisper/ctranslate2).
# No torch anywhere here; built from Python 3.14 on the release machine.
import os
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

datas = []
datas += collect_data_files('openwakeword')          # melspectrogram / VAD resource onnx files
datas += collect_dynamic_libs('sounddevice')         # portaudio DLL ships inside the package

a = Analysis(
    ['_pack_entry.py'],
    pathex=[os.path.abspath('.')],
    binaries=None,
    datas=datas,
    hiddenimports=[
        'rita_listener', 'rita_listener.main',
        'numpy', 'sounddevice', 'websockets',
        'onnxruntime', 'onnxruntime.capi',
        'openwakeword', 'tqdm',
        'faster_whisper', 'ctranslate2', 'tokenizers', 'huggingface_hub',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=['torch', 'torchaudio', 'torchvision', 'tkinter', 'matplotlib', 'PIL', 'IPython', 'jupyter'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='rita_listener',
    debug=False,
    strip=False,
    upx=False,
    console=True,          # keeps [rita-listener] stdout logging that main.cjs relays
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='rita_listener',
)
