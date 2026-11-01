'use strict';

const KBPS = 192;
const SILENCE_THRESHOLD = 0.003; // 前後の無音カット判定
const PAD_SEC = 0.1;

const $ = (id) => document.getElementById(id);
const pickBtn = $('pick');
const saveBtn = $('save');
const fileInput = $('file');
const statusEl = $('status');
const bar = $('bar');
const preview = $('preview');

let mp3File = null;

pickBtn.onclick = () => fileInput.click();

fileInput.onchange = () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) convert(file);
};

saveBtn.onclick = async () => {
  if (!mp3File) return;
  if (navigator.canShare && navigator.canShare({ files: [mp3File] })) {
    try {
      await navigator.share({ files: [mp3File] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(mp3File);
  a.download = mp3File.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
};

async function convert(file) {
  pickBtn.disabled = true;
  saveBtn.disabled = true;
  mp3File = null;
  preview.hidden = true;
  if (preview.src) URL.revokeObjectURL(preview.src);
  setStatus('音声を読み込み中…');
  setProgress(null);

  try {
    const audio = await decode(await file.arrayBuffer());
    const channels = [];
    for (let i = 0; i < Math.min(2, audio.numberOfChannels); i++) channels.push(audio.getChannelData(i));

    const [start, end] = findSound(channels, audio.sampleRate);
    if (end <= start) throw new Error('音声が入っていません（無音）');

    setStatus('MP3に変換中…');
    setProgress(0);
    const blob = await encode(channels.map((c) => c.slice(start, end)), audio.sampleRate);

    mp3File = new File([blob], `rec-${timestamp()}.mp3`, { type: 'audio/mpeg' });
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    const sr = audio.sampleRate;
    setStatus(`完了：${formatTime((end - start) / sr)}・${(blob.size / 1048576).toFixed(1)} MB` +
      `（元 ${formatTime(channels[0].length / sr)}、前 ${formatTime(start / sr)}・後 ${formatTime((channels[0].length - end) / sr)} カット）`);
    saveBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus('変換できませんでした：' + (e && e.message ? e.message : e), true);
  } finally {
    setProgress(null);
    pickBtn.disabled = false;
  }
}

async function decode(buf) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    // 古いSafariはPromise版がないためコールバック版を使う
    return await new Promise((resolve, reject) =>
      ctx.decodeAudioData(buf, resolve, (err) => reject(err || new Error('この形式は読み込めません'))));
  } finally {
    if (ctx.close) ctx.close();
  }
}

function findSound(channels, sampleRate) {
  const n = channels[0].length;
  const loud = (i) => channels.some((c) => Math.abs(c[i]) > SILENCE_THRESHOLD);
  let start = 0;
  while (start < n && !loud(start)) start++;
  let end = n;
  while (end > start && !loud(end - 1)) end--;
  const pad = Math.round(PAD_SEC * sampleRate);
  return [Math.max(0, start - pad), Math.min(n, end + pad)];
}

function encode(channels, sampleRate) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('worker.js');
    worker.onmessage = ({ data }) => {
      if (data.progress != null) {
        setProgress(data.progress);
      } else if (data.blob) {
        worker.terminate();
        resolve(data.blob);
      } else if (data.error) {
        worker.terminate();
        reject(new Error(data.error));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'エンコードに失敗しました'));
    };
    worker.postMessage({ channels, sampleRate, kbps: KBPS }, channels.map((c) => c.buffer));
  });
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', isError);
}

function setProgress(value) {
  bar.hidden = value == null;
  if (value != null) bar.value = value;
}

function formatTime(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function timestamp() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
