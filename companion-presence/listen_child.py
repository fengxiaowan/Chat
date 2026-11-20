# -*- coding: utf-8 -*-
# 小喵 · 语音识别子进程（Python + Vosk 本地识别）
# 用法：python listen_child.py --result <path> --live <path> --max-sec <seconds>
# 做一次 N 秒语音识别：
#   - 实时把识别文字（已确认 + 当前猜测）写到 live 文件，供主进程显示在图标下方
#   - 最终结果写到 result 文件（UTF-8），然后退出
# 用 Vosk 本地模型，绕过 Windows SAPI 的权限墙（普通桌面进程可用）。

import sys, os, json, time, argparse
sys.stdout.reconfigure(encoding='utf-8')

import numpy as np
import sounddevice as sd
from vosk import Model, KaldiRecognizer

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vosk-model')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--result', required=True)
    ap.add_argument('--live', default=None)
    ap.add_argument('--max-sec', type=float, default=12.0)
    ap.add_argument('--silence-sec', type=float, default=1.3)
    args = ap.parse_args()

    result_file = args.result
    live_file = args.live
    max_sec = args.max_sec
    silence_sec = args.silence_sec

    def write_text(path, text):
        try:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(text)
        except Exception:
            pass

    # 初始化空文件
    write_text(result_file, '')
    if live_file:
        write_text(live_file, '')

    try:
        model = Model(MODEL_DIR)
        rec = KaldiRecognizer(model, 16000)

        confirmed = ''      # 已确认的最终文字（累积）
        last_partial = ''   # 当前猜测
        last_heard = time.time()
        last_live_write = 0.0
        done = {'stop': False}

        def callback(indata, frames, t, status):
            nonlocal confirmed, last_heard, last_partial, last_live_write
            if status:
                return
            # sounddevice 默认 float32，转 16bit PCM 给 Vosk
            pcm = (indata[:, 0] * 32767.0).astype('int16').tobytes()
            if rec.AcceptWaveform(pcm):
                r = json.loads(rec.Result())
                txt = r.get('text', '')
                if txt:
                    confirmed += txt
                    last_partial = ''
                    last_heard = time.time()
            else:
                p = json.loads(rec.PartialResult())
                last_partial = p.get('partial', '')
                # 有声音就刷新 last_heard（partial 非空代表正在说话）
                if last_partial:
                    last_heard = time.time()

            # 实时写 live 文件（限频 120ms）
            now = time.time()
            if live_file and (now - last_live_write >= 0.12):
                live_text = (confirmed + last_partial).strip()
                write_text(live_file, live_text)
                last_live_write = now

            # 静音超时 → 结束
            if confirmed and (now - last_heard) >= silence_sec:
                done['stop'] = True

        with sd.InputStream(samplerate=16000, channels=1, dtype='float32', callback=callback):
            start = time.time()
            while time.time() - start < max_sec:
                time.sleep(0.08)
                if done['stop']:
                    break

        # 收尾：拿最后一部分
        final = json.loads(rec.FinalResult())
        if final.get('text'):
            confirmed += final['text']

        result = confirmed.strip()
        write_text(result_file, result)
        if live_file:
            write_text(live_file, result)
    except Exception:
        # 出错也写空结果，保证主进程能读到（不会卡在等待）
        write_text(result_file, '')
        if live_file:
            write_text(live_file, '')

if __name__ == '__main__':
    main()
