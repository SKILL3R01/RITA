# Rita live TTS worker — Kokoro-82M (fully local, Apache-2.0).
# Backend: kokoro-onnx only (spacy-free, runs on the same onnxruntime the wake
# model already uses). The torch `kokoro` package needs spacy→thinc→blis, which
# has no wheels for Python 3.14 — it is deliberately NOT a fallback here.
# A long-running process so streamed sentences pay ~0 model-load cost:
#   stdin : one JSON object per line  {"id": N, "text": "...", "out": "path.wav", "speed": 1.0, "voice": "bf_emma" (optional)}
#   stdout: one JSON object per line  {"id": N, "ok": true, "ms": …} / {"ok": false, "error": …}
# First stdout lines are banners: {"ok": true, "msg": "kokoro loading"/"kokoro ready"/"downloading …", ...}
import os
import sys
import json
import time

# The official onnx build of Kokoro-82M ships on the kokoro-onnx GitHub releases
# (the HF token-required mirrors 401/404 anonymously — verified 2026-11-03).
_MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'
_VOICES_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'


def _banner(msg, extra=None):
    """Progress banners must be ok:true — main.cjs treats ok:false as a load failure."""
    o = {"ok": True, "msg": msg}
    if extra:
        o.update(extra)
    print(json.dumps(o), flush=True)


def _espeak_env():
    """Point phonemizer at the espeak-ng library the espeakng-loader wheel ships."""
    try:
        import espeakng_loader
        os.environ.setdefault('PHONEMIZER_ESPEAK_LIBRARY', espeakng_loader.get_library_path())
        os.environ.setdefault('PHONEMIZER_ESPEAK_LIBRARY_DATA', espeakng_loader.get_data_path())
    except Exception:
        pass


def _models_dir():
    base = os.environ.get('APPDATA')
    d = os.path.join(base, 'rita-assistant', 'tts-models') if base else os.path.join(os.path.dirname(__file__), 'tts-models')
    os.makedirs(d, exist_ok=True)
    return d


def _download(filename, url):
    dst = os.path.join(_models_dir(), filename)
    if os.path.exists(dst) and os.path.getsize(dst) > 1_000_000:
        return dst
    import urllib.request
    _banner(f'downloading {filename}…')
    part = dst + '.part'
    urllib.request.urlretrieve(url, part)
    os.replace(part, dst)
    return dst


def make_synth(args):
    """Load kokoro-onnx once; return synth(text, out, speed, voice)."""
    _espeak_env()
    from kokoro_onnx import Kokoro
    model = _download('kokoro-v1.0.onnx', _MODEL_URL)
    voices = _download('voices-v1.0.bin', _VOICES_URL)
    kokoro = Kokoro(model, voices)

    def synth(text, out, speed, voice):
        # British voices (bf_/bm_) want en-gb phonemization; everything else en-us
        lang = 'en-gb' if voice.startswith('b') else 'en-us'
        audio, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang)
        if audio is None or len(audio) == 0:
            raise RuntimeError('no audio produced')
        import soundfile as sf
        sf.write(out, audio, int(sr))
        return time.monotonic()

    return synth


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--lang', default='b')
    ap.add_argument('--voice', default='bf_emma')
    ap.add_argument('--speed', type=float, default=1.0)
    try:
        args = ap.parse_args()
        voice = args.voice.strip() or 'bf_emma'
    except SystemExit:
        raise

    _banner('kokoro loading', {'voice': voice})
    try:
        synth = make_synth(args)
    except SystemExit:
        raise
    except Exception as e:
        print(json.dumps({'ok': False, 'msg': 'kokoro load failed', 'error': str(e)[:300]}), flush=True)
        return 1

    _banner('kokoro ready', {'voice': voice})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"bad request: {e}"}), flush=True)
            continue
        rid = req.get('id')
        text = str(req.get('text') or '').strip()
        out = str(req.get('out') or '')
        speed = float(req.get('speed') or (args.speed if args else 1.0)) or 1.0
        v = str(req.get('voice') or voice).strip() or 'bf_emma'
        if not text or not out:
            print(json.dumps({"id": rid, "ok": False, "error": "missing text/out"}), flush=True)
            continue
        t0 = time.monotonic()
        try:
            synth(text, out, speed, v)
            dur = None
            try:
                import soundfile as sf
                info = sf.info(out)
                dur = round(info.duration, 2)
            except Exception:
                pass
            print(json.dumps({"id": rid, "ok": True, "ms": int((time.monotonic() - t0) * 1000), "dur": dur}), flush=True)
        except Exception as e:
            print(json.dumps({"id": rid, "ok": False, "error": str(e)[:300]}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
