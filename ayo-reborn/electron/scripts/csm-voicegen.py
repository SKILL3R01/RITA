# Rita signature voice generator — Sesame CSM-1B (Apache-2.0 mirror unsloth/csm-1b), CPU, fully local.
# Pre-generates canned assistant phrases as WAVs; the app plays them instantly at runtime.
#
# Usage:
#   python csm-voicegen.py --phrases <phrases.json> --out <dir> [--voice <24kHz wav>]
# --voice: optional reference audio (voice cloning). 24 kHz mono recommended.
# First run loads the model (~1-2 min on CPU); each line is slow-pregenerated once.
import argparse
import hashlib
import json
import os
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--phrases', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--voice', default='', help='24 kHz wav used as speaker context (voice cloning)')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--fresh', action='store_true', help='regenerate every line even if a cached one looks fine')
    args = ap.parse_args()

    import torch
    from transformers import CsmForConditionalGeneration, AutoProcessor
    model_id = os.environ.get('RITA_CSM_MODEL', 'unsloth/csm-1b')

    print('[csm] loading model (CPU)...', flush=True)
    t0 = time.time()
    processor = AutoProcessor.from_pretrained(model_id)
    model = CsmForConditionalGeneration.from_pretrained(model_id, device_map='cpu')
    print(f'[csm] loaded in {time.time() - t0:.0f}s', flush=True)
    torch.set_num_threads(max(2, (os.cpu_count() or 8) - 2))

    os.makedirs(args.out, exist_ok=True)
    reference = None
    if args.voice:
        import soundfile as sf
        audio, sr = sf.read(args.voice, dtype='float32')
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        want = getattr(processor.feature_extractor, 'sampling_rate', 24000)
        if sr != want:
            from scipy.signal import resample_poly
            import math
            g = math.gcd(int(want), int(sr))
            audio = resample_poly(audio, want // g, sr // g).astype('float32')
            print(f'[csm] resampled reference {sr} -> {want} Hz', flush=True)
        reference = audio
        print(f'[csm] using reference voice: {os.path.basename(args.voice)} ({len(audio) / want:.1f}s)', flush=True)

    phrases = json.load(open(args.phrases, encoding='utf-8-sig'))
    if args.fresh:
        import glob
        for old in glob.glob(os.path.join(args.out, 'line-*.wav')):
            print(f'[csm] --fresh: removing cached {os.path.basename(old)}', flush=True)
            os.remove(old)
    total_audio_s = 0.0
    good = 0
    n_total = 0
    for text in phrases:
        text = str(text).strip()
        if not text:
            continue
        n_total += 1
        key = hashlib.sha1(text.strip().lower().encode('utf-8')).hexdigest()[:12]
        fn = os.path.join(args.out, f'line-{key}.wav')
        # a broken cached line (silence/click from an earlier run) must not survive
        if os.path.exists(fn):
            fd0, vd0, pk0 = wav_quality(fn)
            if is_dud(fd0, vd0, pk0):
                print(f'[csm] cached "{text}" is broken ({fd0:.2f}s voiced {vd0:.2f}s peak {pk0:.3f}) — regenerating', flush=True)
                os.remove(fn)
        ok = False
        for attempt in range(3):
            t1 = time.time()
            seed = args.seed + attempt * 101
            generate_line(processor, model, text, fn, reference, seed)
            gen_s = time.time() - t1
            total_audio_s += gen_s
            fd, vd, pk = wav_quality(fn)
            if not is_dud(fd, vd, pk):
                ok = True
                good += 1
                print(f'[csm] "{text}" -> line-{key} OK ({fd:.1f}s voiced {vd:.1f}s, {gen_s:.0f}s gen, seed {seed})', flush=True)
                break
            print(f'[csm] "{text}" attempt {attempt + 1} looks empty ({fd:.2f}s voiced {vd:.2f}s peak {pk:.3f}) — new seed…', flush=True)
            if attempt < 2 and os.path.exists(fn):
                os.remove(fn)
        if not ok:
            print(f'[csm] "{text}" -> line-{key} GAVE UP after 3 attempts — the piper voice will speak this line instead', flush=True)
            if os.path.exists(fn):
                os.remove(fn)
    print(f'CSM-DONE {good}/{n_total} lines usable, {total_audio_s:.0f}s total generate time', flush=True)


def wav_quality(path):
    """Return (full_seconds, voiced_seconds, peak) for a generated wav, or (0,0,0) unreadable."""
    import soundfile as sf
    import numpy as np
    try:
        a, sr = sf.read(path, dtype='float32')
    except Exception:
        return 0.0, 0.0, 0.0
    if a.ndim > 1:
        a = a.mean(axis=1)
    n = len(a)
    if n == 0:
        return 0.0, 0.0, 0.0
    win = max(1, int(sr * 0.03))
    m = (n // win) * win
    amps = np.sqrt(np.sum(a[:m].reshape(-1, win) ** 2, axis=1)) / win
    peak = float(np.max(np.abs(a))) or 0.0
    thresh = max(0.015, peak * 0.12)
    # count voiced blocks, closing gaps of up to 180 ms so words don't split
    above = amps > thresh
    voiced = 0
    gaps = 0
    for v in above:
        if v:
            voiced += 1
            gaps = 0
        elif gaps < 6:
            voiced += 1
            gaps += 1
        else:
            gaps = 0
    return n / sr, voiced * win / sr, peak


def is_dud(full_s, voiced_s, peak):
    return full_s < 0.45 or voiced_s < 0.25 or peak < 0.012


def generate_line(processor, model, text, fn, reference, seed):
    convo = []
    if reference is not None:
        convo.append({'role': '0', 'content': [{'type': 'audio', 'audio': reference}]})
    convo.append({'role': '0', 'content': [{'type': 'text', 'text': text}]})
    inputs = processor.apply_chat_template(convo, tokenize=True, return_dict=True)
    torch.manual_seed(seed)
    try:
        out_audio = model.generate(**inputs, output_audio=True, max_new_tokens=420)
    except TypeError:
        out_audio = model.generate(**inputs, output_audio=True)
    processor.save_audio(out_audio, fn)


if __name__ == '__main__':
    main()
