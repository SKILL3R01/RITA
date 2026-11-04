# Rita signature voice cloner — Chatterbox TTS (Resemble AI, MIT license, fully local).
# Pre-generates the canned assistant phrases as WAVs in the USER'S OWN voice from their
# recorded reference. Replaces the CSM-1B cloner (that model's cloning ceiling was the
# "basic robotic" sound). Heavy synthesis → deliberately pre-generated, never live.
#
# Usage:
#   python chatterbox-clone.py --phrases <phrases.json> --out <dir> --voice <20s user wav>
# Output contract (parsed by main.cjs): "[cb] ..." progress lines, "CB-DONE good/total".
import argparse
import hashlib
import json
import os
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--phrases', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--voice', required=True, help='user reference wav (their own voice)')
    ap.add_argument('--exaggeration', type=float, default=0.5, help='emotion strength 0-1')
    ap.add_argument('--cfg', type=float, default=0.5, help='pace adherence 0-1 (lower = steadier)')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--fresh', action='store_true', help='regenerate every line')
    args = ap.parse_args()

    import torch
    import torchaudio
    from chatterbox.tts import ChatterboxTTS

    print('[cb] loading Chatterbox (CPU — first run downloads ~1 GB, then cached)...', flush=True)
    t0 = time.time()
    try:
        model = ChatterboxTTS.from_pretrained(device='cpu')
    except Exception as e:
        print(f'[cb] model load failed: {str(e)[:400]}', flush=True)
        print('CB-DONE 0/0 (load failed)', flush=True)
        return
    print(f'[cb] loaded in {time.time() - t0:.0f}s', flush=True)
    torch.set_num_threads(max(2, (os.cpu_count() or 8) - 2))

    os.makedirs(args.out, exist_ok=True)
    phrases = json.load(open(args.phrases, encoding='utf-8-sig'))
    if args.fresh:
        import glob
        for old in glob.glob(os.path.join(args.out, 'line-*.wav')):
            print(f'[cb] --fresh: removing cached {os.path.basename(old)}', flush=True)
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
        dub = f'{fn}.tmp.wav'
        ok = False
        for attempt in range(3):
            t1 = time.time()
            seed = args.seed + attempt * 101
            try:
                torch.manual_seed(seed)
                wav = model.generate(text, audio_prompt_path=args.voice,
                                     exaggeration=args.exaggeration, cfg_weight=args.cfg)
                # stdlib WAV writer: soundfile here writes 0-byte files (broken libsndfile chain)
                import wave
                import numpy as np
                a = np.clip(wav.detach().cpu().float().numpy().reshape(-1), -1.0, 1.0)
                pcm = (a * 32767.0).astype(np.int16)
                with wave.open(dub, 'wb') as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(int(model.sr))
                    w.writeframes(pcm.tobytes())
            except Exception as e:
                print(f'[cb] "{text}" attempt {attempt + 1} crashed: {str(e)[:200]}', flush=True)
                continue
            gen_s = time.time() - t1
            total_audio_s += gen_s
            fd, vd, pk = wav_quality(dub)
            if not is_dud(fd, vd, pk):
                os.replace(dub, fn)
                ok = True
                good += 1
                print(f'[cb] "{text}" -> line-{key} OK ({fd:.1f}s voiced {vd:.1f}s, {gen_s:.0f}s gen, seed {seed})', flush=True)
                break
            print(f'[cb] "{text}" attempt {attempt + 1} sounds wrong ({fd:.2f}s voiced {vd:.2f}s peak {pk:.3f}) — new seed…', flush=True)
            if os.path.exists(dub):
                os.remove(dub)
        if not ok:
            print(f'[cb] "{text}" -> gave up; the piper voice will speak this line instead', flush=True)
            if os.path.exists(fn):
                os.remove(fn)
    print(f'CB-DONE {good}/{n_total} lines usable, {total_audio_s:.0f}s total generate time', flush=True)


def wav_quality(path):
    """Return (full_seconds, voiced_seconds, peak) for a generated wav, or (0,0,0) unreadable."""
    import wave
    import numpy as np
    try:
        with wave.open(path, 'rb') as w:
            sr = w.getframerate()
            data = w.readframes(w.getnframes())
    except Exception:
        return 0.0, 0.0, 0.0
    a = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
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
    above = amps > thresh
    voiced = 0
    gaps = 0
    for v in above:
        if v:
            voiced += 1
            gaps = 0
        elif gaps < 6:  # bridge ≤180 ms so words don't split
            voiced += 1
            gaps += 1
        else:
            gaps = 0
    return n / sr, voiced * win / sr, peak


def is_dud(full_s, voiced_s, peak):
    return full_s < 0.45 or voiced_s < 0.25 or peak < 0.012


if __name__ == '__main__':
    main()
