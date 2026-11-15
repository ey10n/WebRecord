'use strict';

const KBPS = 192;
const SILENCE_THRESHOLD = 0.003; // 前後の無音カット判定
const PAD_SEC = 0.1;
const HEAD_SKIP_SEC = 1; // 画面収録開始時の「ピコン」音を除去
const MIN_LENGTH = 1; // カット後に残す長さの最小値（秒）
const LISTEN_LENGTH = 3; // 試聴する長さ（秒）

const $ = (id) => document.getElementById(id);
const pickBtn = $('pick');
const saveBtn = $('save');
const fileInput = $('file');
const statusEl = $('status');
const bar = $('bar');
const preview = $('preview');
const trimBox = $('trim');
const reconvertBtn = $('reconvert');

let mp3File = null;
let buffer = null; // 読み込んだ音声全体（AudioBuffer）
let full = 0; // 音声全体の長さ（秒）
let start = 0; // 残す範囲（音声全体の先頭からの秒数）
let end = 0;
let encoded = null; // 今の MP3 にした範囲 { start, end }
let busy = false;

pickBtn.onclick = () => fileInput.click();

fileInput.onchange = () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) load(file);
};

// 「MP3を保存」→ 名前を付けて保存（拡張子 .mp3 は自動で付ける）
const nameDlg = $('nameDlg');
const nameInput = $('nameInput');

saveBtn.onclick = () => {
  if (!mp3File) return;
  nameInput.value = mp3File.name.replace(/\.mp3$/i, '');
  if (!nameDlg.showModal) { // <dialog> 非対応の古いブラウザ
    const name = prompt('ファイル名', nameInput.value);
    if (name != null) saveAs(name);
    return;
  }
  nameDlg.showModal();
  nameInput.focus();
  nameInput.setSelectionRange(0, nameInput.value.length);
};

$('nameCancel').onclick = () => nameDlg.close();

// 共有シートはタップ直後でないと開けないので、保存ボタンの submit の中で直接呼ぶ
$('nameForm').onsubmit = (e) => {
  e.preventDefault();
  nameDlg.close();
  saveAs(nameInput.value);
};

async function saveAs(rawName) {
  const name = rawName.trim().replace(/\.mp3$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
    || mp3File.name.replace(/\.mp3$/i, '');
  // 次に保存するときも同じ名前を出す
  mp3File = new File([mp3File], `${name}.mp3`, { type: 'audio/mpeg' });
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
}

reconvertBtn.onclick = () => convert();

async function load(file) {
  setBusy(true);
  stopListen();
  mp3File = null;
  buffer = null;
  encoded = null;
  saveBtn.disabled = true;
  trimBox.hidden = true;
  reconvertBtn.hidden = true;
  preview.hidden = true;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.removeAttribute('src');
  setStatus('音声を読み込み中…');
  setProgress(null);

  try {
    const audio = await decode(await file.arrayBuffer());
    const [s, e] = findSound(getChannels(audio), audio.sampleRate);
    if (e <= s) throw new Error('音声が入っていません（無音）');
    buffer = audio;
    full = audio.length / audio.sampleRate;
    start = s / audio.sampleRate;
    end = e / audio.sampleRate;
    trimBox.hidden = false;
    render();
  } catch (e) {
    console.error(e);
    setStatus('変換できませんでした：' + (e && e.message ? e.message : e), true);
    setProgress(null);
    setBusy(false);
    return;
  }
  await convert();
}

// 今の範囲を MP3 にする
async function convert() {
  if (!buffer) return;
  setBusy(true);
  stopListen();
  saveBtn.disabled = true;
  reconvertBtn.hidden = true;
  setStatus('MP3に変換中…');
  setProgress(0);

  try {
    const sr = buffer.sampleRate;
    const range = { start, end };
    const s = Math.max(0, Math.round(range.start * sr));
    const e = Math.min(buffer.length, Math.round(range.end * sr));
    const blob = await encode(getChannels(buffer).map((c) => c.slice(s, e)), sr);

    mp3File = new File([blob], `rec-${timestamp()}.mp3`, { type: 'audio/mpeg' });
    encoded = range;
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    setStatus(`完了：${formatTime(range.end - range.start)}・${(blob.size / 1048576).toFixed(1)} MB` +
      `（元 ${formatTime(full)}、前 ${formatTime(range.start)}・後 ${formatTime(full - range.end)} カット）`);
  } catch (e) {
    console.error(e);
    setStatus('変換できませんでした：' + (e && e.message ? e.message : e), true);
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

function getChannels(audio) {
  const channels = [];
  for (let i = 0; i < Math.min(2, audio.numberOfChannels); i++) channels.push(audio.getChannelData(i));
  return channels;
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
  const skip = Math.min(n, Math.round(HEAD_SKIP_SEC * sampleRate));
  let s = skip;
  while (s < n && !loud(s)) s++;
  let e = n;
  while (e > s && !loud(e - 1)) e--;
  const pad = Math.round(PAD_SEC * sampleRate);
  return [Math.max(skip, s - pad), Math.min(n, e + pad)];
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

// ---- 頭と末尾のカット（AnalogicPlayer の「頭と末尾をカット」画面と同じ構成） ----

const points = {
  start: {
    el: document.querySelector('[data-point="start"]'),
    get: () => start,
    set: (v) => { start = v; },
    range: () => [0, Math.max(0, end - MIN_LENGTH)],
    listen: () => [start, Math.min(end, start + LISTEN_LENGTH)],
    previewLabel: (t) => `<span class="ic">⤓</span>プレビューの再生位置（${formatTimeTenths(t)}）を頭にする`,
  },
  end: {
    el: document.querySelector('[data-point="end"]'),
    get: () => end,
    set: (v) => { end = v; },
    range: () => [Math.min(full, start + MIN_LENGTH), full],
    listen: () => [Math.max(start, end - LISTEN_LENGTH), end],
    previewLabel: (t) => `<span class="ic">⤒</span>プレビューの再生位置（${formatTimeTenths(t)}）を末尾にする`,
  },
};

for (const p of Object.values(points)) {
  const slider = p.el.querySelector('input');
  slider.oninput = () => setPoint(p, Number(slider.value));
  for (const btn of p.el.querySelectorAll('.steps button')) {
    holdRepeat(btn, () => setPoint(p, p.get() + Number(btn.dataset.d)));
  }
  p.el.querySelector('.listen').onclick = () => startListen(...p.listen());
  p.el.querySelector('.fromPreview').onclick = () => {
    const t = previewTime();
    if (t != null) setPoint(p, t);
  };
}

$('reset').onclick = () => {
  start = 0;
  end = full;
  changed();
};

function setPoint(p, value) {
  const [lo, hi] = p.range();
  p.set(clamp(Math.round(value * 100) / 100, lo, hi));
  changed();
}

// 範囲を変えたら、今の MP3 と違うときだけ保存を止めて変換し直しを促す
// （byUser が false のときは、変換エラーなどの表示を消さないよう状態表示は変えない）
function changed(byUser = true) {
  render();
  if (busy || !encoded) return;
  const same = Math.abs(start - encoded.start) < 0.005 && Math.abs(end - encoded.end) < 0.005;
  saveBtn.disabled = !same;
  reconvertBtn.hidden = same;
  if (!same && byUser) setStatus('範囲を変えました。「この範囲でMP3に変換」を押してください');
}

function render() {
  if (!buffer) return;
  const pct = (t) => (full > 0 ? (t / full) * 100 : 0);
  const keep = $('keep');
  keep.style.left = pct(start) + '%';
  keep.style.width = pct(end - start) + '%';
  $('rbar').setAttribute('aria-label', `残す範囲 ${formatTimeTenths(start)} から ${formatTimeTenths(end)}`);
  $('fullLen').textContent = formatTimeTenths(full);
  $('keepLen').textContent = formatTimeTenths(end - start);

  const canTrim = full > MIN_LENGTH * 2;
  $('trimBody').hidden = !canTrim;
  $('tooShort').hidden = canTrim;
  $('resetBox').hidden = start <= 0.05 && end >= full - 0.05;

  const pt = previewTime();
  for (const p of Object.values(points)) {
    const [lo, hi] = p.range();
    const slider = p.el.querySelector('input');
    slider.min = lo;
    slider.max = hi;
    slider.value = p.get();
    p.el.querySelector('.time').textContent = formatTimeTenths(p.get());
    const fp = p.el.querySelector('.fromPreview');
    fp.hidden = pt == null;
    if (pt != null) fp.innerHTML = p.previewLabel(pt);
  }
}

// MP3 プレビューの再生位置を、音声全体の先頭からの秒数で返す（再生していなければ null）
// AnalogicPlayer の「デッキの再生位置を頭/末尾にする」に当たる
function previewTime() {
  if (!encoded || preview.hidden || !(preview.currentTime > 0)) return null;
  return Math.min(encoded.end, encoded.start + preview.currentTime);
}

preview.addEventListener('play', stopListen);
for (const ev of ['timeupdate', 'pause', 'seeked', 'emptied']) preview.addEventListener(ev, render);

// 押し続けると繰り返す（SwiftUI の buttonRepeatBehavior と同じ動き）
function holdRepeat(btn, fn) {
  let delay = null;
  let timer = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(timer);
    delay = timer = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (btn.disabled || e.button !== 0) return;
    e.preventDefault();
    stop();
    fn();
    delay = setTimeout(() => { timer = setInterval(fn, 80); }, 400);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // キーボード操作（pointer を伴わないクリック）
  btn.addEventListener('click', (e) => { if (e.detail === 0) fn(); });
}

// ---- 試聴：指定した範囲だけを WAV にして鳴らす（消音スイッチの影響を受けないよう audio 要素で再生） ----

const listener = new Audio();
let listenRange = null;
let listenRaf = 0;

function startListen(from, until) {
  stopListen();
  if (!buffer || until <= from) return;
  preview.pause();
  if (listener.src) URL.revokeObjectURL(listener.src);
  listener.src = URL.createObjectURL(toWav(buffer, from, until));
  listenRange = { from, until };
  listener.play().catch(() => stopListen());
  const tick = () => {
    if (!listenRange) return;
    showPlayhead(listenRange.from + listener.currentTime);
    listenRaf = requestAnimationFrame(tick);
  };
  listenRaf = requestAnimationFrame(tick);
}

function stopListen() {
  cancelAnimationFrame(listenRaf);
  listenRange = null;
  listener.pause();
  showPlayhead(null);
}

listener.onended = stopListen;

function showPlayhead(t) {
  const head = $('phead');
  head.hidden = t == null;
  if (t != null && full > 0) head.style.left = `calc(${(clamp(t, 0, full) / full) * 100}% - 1px)`;
}

function toWav(audio, from, until) {
  const sr = audio.sampleRate;
  const s = Math.max(0, Math.round(from * sr));
  const e = Math.min(audio.length, Math.round(until * sr));
  const chs = getChannels(audio);
  const nch = chs.length;
  const frames = Math.max(0, e - s);
  const view = new DataView(new ArrayBuffer(44 + frames * nch * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + frames * nch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nch, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * nch * 2, true); view.setUint16(32, nch * 2, true);
  view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, frames * nch * 2, true);
  let o = 44;
  for (let i = s; i < e; i++) {
    for (const c of chs) {
      const v = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ---- 共通 ----

function setBusy(value) {
  busy = value;
  pickBtn.disabled = value;
  trimBox.disabled = value;
  if (!value) changed(false);
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', isError);
}

function setProgress(value) {
  bar.hidden = value == null;
  if (value != null) bar.value = value;
}

function clamp(t, lo, hi) {
  return Math.min(Math.max(t, lo), hi);
}

function formatTime(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// AnalogicPlayer と同じ「分:秒.1/10秒」表示
function formatTimeTenths(sec) {
  const tenths = Math.floor(Math.max(0, sec) * 10 + 1e-6);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(Math.floor(tenths / 600))}:${p(Math.floor(tenths / 10) % 60)}.${tenths % 10}`;
}

function timestamp() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
