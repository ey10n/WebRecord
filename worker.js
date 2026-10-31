'use strict';

importScripts('lame.min.js');

const BLOCK = 1152 * 20;

function toInt16(src, start, end) {
  const out = new Int16Array(end - start);
  for (let i = start, j = 0; i < end; i++, j++) {
    const v = Math.max(-1, Math.min(1, src[i]));
    out[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

onmessage = ({ data: { channels, sampleRate, kbps } }) => {
  try {
    const encoder = new lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
    const n = channels[0].length;
    const parts = [];
    let lastReport = 0;

    for (let i = 0; i < n; i += BLOCK) {
      const end = Math.min(n, i + BLOCK);
      const left = toInt16(channels[0], i, end);
      const buf = channels.length > 1
        ? encoder.encodeBuffer(left, toInt16(channels[1], i, end))
        : encoder.encodeBuffer(left);
      if (buf.length) parts.push(new Uint8Array(buf));

      const p = end / n;
      if (p - lastReport >= 0.01) {
        postMessage({ progress: p });
        lastReport = p;
      }
    }

    const tail = encoder.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    postMessage({ blob: new Blob(parts, { type: 'audio/mpeg' }) });
  } catch (e) {
    postMessage({ error: String(e && e.message ? e.message : e) });
  }
};
