/* ===========================================================
   진진 숏폼 편집기 — app.js
   9:16 숏폼(쇼츠·릴스·클립) 편집기 · 100% 브라우저 실행
   - 사진/영상 클립 타임라인 (분할·순서·트림)
   - 구간 자막 / 상단 타이틀 / 스티커 (드래그·핀치)
   - 원본 소리 + 내 목소리(녹음·파일) + BGM 3층 믹싱
   - WebCodecs(H.264+AAC) → MP4, 없으면 MediaRecorder(MP4/WebM)
   =========================================================== */
'use strict';
(function () {

let W = 1080, H = 1920;
const FPS = 30;

/* ---------------------------------------------------------
   0. 유틸
   --------------------------------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function MS() { return Math.min(W, H); }

function fmtT(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
function fmtShort(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.round(t - m * 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
let toastTimer = null;
function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------------------------------------------------
   1. 상태
   --------------------------------------------------------- */
const DEF_STYLE = {
  font: "'Noto Sans KR', sans-serif",
  weight: 900,
  size: 0.105,          // 화면 짧은 변 대비 글자 크기
  color: '#ffffff',
  strokeW: 0.16,        // 글자 크기 대비 외곽선 두께
  strokeColor: '#1a1208',
  shadow: true,
  bgColor: '#000000',
  bgAlpha: 0,           // 0~1
  bgPad: 0.34,
  bgRadius: 0.24,
  align: 'center',
  lineHeight: 1.28,
  letterSp: 0,
  maxW: 0.86,
  x: 0.5,
  y: 0.78,
  rot: 0,
};

const state = {
  clips: [],
  items: [],        // 자막·타이틀·스티커
  audios: [],       // BGM
  voices: [],       // 내 목소리·나레이션
  srcMute: false,
  srcVolume: 1,
  guide: 'none',
  selId: null,
  selClipId: null,
  t: 0,
  playing: false,
  defSt: Object.assign({}, DEF_STYLE),
  stickerLib: [],
  exporting: false,
  aspect: 'portrait',
};

const canvas = $('#stage');
const ctx = canvas.getContext('2d', { alpha: false });

/* ---------------------------------------------------------
   2. 미디어 · 클립
   --------------------------------------------------------- */
function makeVideoEl(url) {
  const v = document.createElement('video');
  v.src = url;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.muted = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  return v;
}
function waitEvent(el, name, ms) {
  return new Promise((res, rej) => {
    let done = false;
    const ok = () => { if (!done) { done = true; cleanup(); res(); } };
    const bad = () => { if (!done) { done = true; cleanup(); rej(new Error(name)); } };
    const timer = setTimeout(bad, ms || 15000);
    function cleanup() { clearTimeout(timer); el.removeEventListener(name, ok); el.removeEventListener('error', bad); }
    el.addEventListener(name, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

async function addFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  showBusy('사진·영상을 읽는 중…');
  let added = 0, failed = 0;
  for (const f of list) {
    try {
      if (f.type.startsWith('video/')) { await addVideoClip(f); added++; }
      else if (f.type.startsWith('image/')) { await addImageClip(f); added++; }
      else { failed++; }
    } catch (e) { console.warn('media add failed', f.name, e); failed++; }
  }
  hideBusy();
  renderStrip();
  renderSubList(); renderTitleList();
  if (added) {
    $('#emptyHint').hidden = true;
    if (state.clips.length === added) { seekTo(0); }
    toast(failed ? `${added}개 추가 · ${failed}개 실패` : `${added}개 추가했습니다`);
  } else if (failed) {
    toast('이 파일은 열 수 없습니다 (MP4·MOV·JPG·PNG 권장)');
  }
  render();
}

async function addVideoClip(file) {
  const url = URL.createObjectURL(file);
  const el = makeVideoEl(url);
  await waitEvent(el, 'loadedmetadata', 20000);
  if (el.readyState < 2) { try { await waitEvent(el, 'loadeddata', 15000); } catch (e) { } }
  const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
  if (!dur) { URL.revokeObjectURL(url); throw new Error('duration'); }
  const clip = {
    id: uid(), kind: 'video', file, url, el, name: file.name,
    srcDuration: dur, inPoint: 0, duration: Math.min(dur, 180),
    audioBuffer: null, audioState: 'pending',
  };
  state.clips.push(clip);
  // 소리 추출(실패해도 편집은 계속)
  decodeClipAudio(clip);
  return clip;
}

async function addImageClip(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode().catch(() => waitEvent(img, 'load', 15000));
  state.clips.push({
    id: uid(), kind: 'image', file, url, el: img, name: file.name,
    srcDuration: null, inPoint: 0, duration: 3, audioBuffer: null, audioState: 'none',
  });
  return state.clips[state.clips.length - 1];
}

async function decodeClipAudio(clip) {
  try {
    const buf = await decodeAudioBlob(clip.file);
    clip.audioBuffer = buf && buf.duration > 0.05 ? buf : null;
    clip.audioState = clip.audioBuffer ? 'ok' : 'none';
  } catch (e) {
    clip.audioBuffer = null;
    clip.audioState = 'fail';
  }
  updateAudioNote();
}

/* 클립 시간 계산 */
function clipSpans() {
  let acc = 0;
  return state.clips.map(c => { const s = { clip: c, start: acc, end: acc + c.duration }; acc += c.duration; return s; });
}
function clipStart(clip) {
  let acc = 0;
  for (const c of state.clips) { if (c.id === clip.id) return acc; acc += c.duration; }
  return 0;
}
function clipAt(t) {
  let acc = 0;
  for (const c of state.clips) { if (t < acc + c.duration - 1e-6) return c; acc += c.duration; }
  return state.clips[state.clips.length - 1] || null;
}
function totalDuration() { return state.clips.reduce((a, c) => a + (c.duration || 0), 0); }

/* ---------------------------------------------------------
   3. 그리기
   --------------------------------------------------------- */
function drawClipFrame(c2, c, t) {
  const el = c.el;
  if (!el) return;
  let vw = 0, vh = 0;
  if (c.kind === 'video') {
    if (el.readyState < 2) return;
    vw = el.videoWidth; vh = el.videoHeight;
  } else {
    if (!el.complete || !el.naturalWidth) return;
    vw = el.naturalWidth; vh = el.naturalHeight;
  }
  if (!vw || !vh) return;
  const sc = Math.max(W / vw, H / vh);
  const dw = vw * sc, dh = vh * sc;
  try { c2.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch (e) { }
}

function wrapText(c2, text, maxW) {
  const out = [];
  const paras = String(text).split('\n');
  for (const para of paras) {
    if (!para) { out.push(''); continue; }
    // 공백 단위 우선, 한 덩어리가 넘치면 글자 단위
    const words = para.split(/(\s+)/).filter(s => s !== '');
    let line = '';
    const pushChar = (str) => {
      for (const ch of str) {
        const test = line + ch;
        if (c2.measureText(test).width > maxW && line) { out.push(line); line = ch; }
        else line = test;
      }
    };
    for (const w of words) {
      if (w.trim() === '') { if (line) line += w; continue; }
      const test = line + w;
      if (c2.measureText(test).width > maxW && line) {
        out.push(line.replace(/\s+$/, ''));
        line = '';
        if (c2.measureText(w).width > maxW) pushChar(w);
        else line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

function drawTextItem(c2, it) {
  const text = String(it.text || '');
  if (!text.trim()) { it._box = null; return; }
  const fs = it.size * MS();
  c2.save();
  c2.font = `${it.weight} ${fs}px ${it.font}`;
  c2.textBaseline = 'middle';
  try { if ('letterSpacing' in c2) c2.letterSpacing = `${(it.letterSp || 0)}px`; } catch (e) { }
  const maxW = Math.max(60, it.maxW * W);
  const lines = wrapText(c2, text, maxW);
  const lh = fs * it.lineHeight;
  let blockW = 0;
  for (const ln of lines) blockW = Math.max(blockW, c2.measureText(ln).width);
  blockW = Math.min(blockW, maxW);
  const blockH = lines.length * lh;
  const cx = it.x * W, cy = it.y * H;
  const padX = fs * it.bgPad * 0.68, padY = fs * it.bgPad * 0.52;
  const bx = cx - blockW / 2 - padX, by = cy - blockH / 2 - padY;
  const bw = blockW + padX * 2, bh = blockH + padY * 2;
  it._box = { x: bx, y: by, w: bw, h: bh };

  if (it.bgAlpha > 0.001) {
    c2.save();
    c2.globalAlpha = it.bgAlpha;
    c2.fillStyle = it.bgColor;
    roundRect(c2, bx, by, bw, bh, Math.min(it.bgRadius * fs, bh / 2));
    c2.fill();
    c2.restore();
  }

  const align = it.align || 'center';
  c2.textAlign = align;
  const x = align === 'center' ? cx : align === 'left' ? bx + padX : bx + bw - padX;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const y = cy - blockH / 2 + lh * (i + 0.5);
    if (it.shadow) {
      c2.shadowColor = 'rgba(0,0,0,.55)';
      c2.shadowBlur = fs * 0.16;
      c2.shadowOffsetY = fs * 0.03;
    } else {
      c2.shadowColor = 'transparent'; c2.shadowBlur = 0; c2.shadowOffsetY = 0;
    }
    if (it.strokeW > 0.001) {
      c2.lineJoin = 'round'; c2.miterLimit = 2;
      c2.lineWidth = Math.max(1, fs * it.strokeW);
      c2.strokeStyle = it.strokeColor;
      c2.strokeText(lines[i], x, y);
    }
    c2.shadowColor = 'transparent'; c2.shadowBlur = 0; c2.shadowOffsetY = 0;
    c2.fillStyle = it.color;
    c2.fillText(lines[i], x, y);
  }
  c2.restore();
}

function drawStickerItem(c2, it) {
  const img = it.img;
  if (!img) return;
  const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
  if (!nw || !nh) return;
  const w = it.w * W, h = w * nh / nw;
  c2.save();
  c2.globalAlpha = clamp(it.opacity, 0, 1);
  c2.translate(it.x * W, it.y * H);
  if (it.rot) c2.rotate(it.rot * Math.PI / 180);
  try { c2.drawImage(img, -w / 2, -h / 2, w, h); } catch (e) { }
  c2.restore();
  const r = Math.hypot(w, h) / 2;
  it._box = { x: it.x * W - r, y: it.y * H - r, w: r * 2, h: r * 2 };
}

function drawSelection(c2, it) {
  const b = it._box;
  if (!b) return;
  c2.save();
  c2.strokeStyle = 'rgba(255,138,76,.95)';
  c2.lineWidth = Math.max(2, W / 360);
  c2.setLineDash([W / 90, W / 130]);
  if (it.kind === 'stk') {
    const nw = it.img.naturalWidth || 1, nh = it.img.naturalHeight || 1;
    const w = it.w * W, h = w * nh / nw;
    c2.translate(it.x * W, it.y * H);
    if (it.rot) c2.rotate(it.rot * Math.PI / 180);
    c2.strokeRect(-w / 2, -h / 2, w, h);
    c2.setLineDash([]);
    c2.fillStyle = 'rgba(255,138,76,.95)';
    c2.beginPath(); c2.arc(w / 2, h / 2, W / 60, 0, Math.PI * 2); c2.fill();
  } else {
    c2.strokeRect(b.x, b.y, b.w, b.h);
    c2.setLineDash([]);
    c2.fillStyle = 'rgba(255,138,76,.95)';
    c2.beginPath(); c2.arc(b.x + b.w, b.y + b.h, W / 60, 0, Math.PI * 2); c2.fill();
  }
  c2.restore();
}

function drawScene(c2, t, opts) {
  opts = opts || {};
  c2.save();
  c2.fillStyle = '#0b0907';
  c2.fillRect(0, 0, W, H);
  const clip = clipAt(t);
  if (clip) drawClipFrame(c2, clip, t);

  const visible = state.items.filter(it => t >= it.start - 1e-6 && t <= it.end + 1e-6);
  for (const it of visible) {
    if (it.kind === 'stk') drawStickerItem(c2, it);
    else drawTextItem(c2, it);
  }
  if (!opts.forExport && state.selId) {
    const sel = visible.find(i => i.id === state.selId);
    if (sel) drawSelection(c2, sel);
  }
  c2.restore();
}

function render() {
  drawScene(ctx, state.t, {});
  updateTimeUI();
}
function renderForExport(c2, w, h, t) {
  c2.save();
  c2.setTransform(w / W, 0, 0, h / H, 0, 0);
  drawScene(c2, t, { forExport: true });
  c2.restore();
}

/* ---------------------------------------------------------
   4. 재생 엔진
   --------------------------------------------------------- */
let rafId = null, lastTs = 0;

function updateTimeUI() {
  const dur = totalDuration();
  $('#tNow').textContent = fmtT(state.t);
  $('#tTotal').textContent = fmtT(dur);
  const sc = $('#scrub');
  const p = dur > 0 ? clamp(state.t / dur, 0, 1) : 0;
  sc.value = String(Math.round(p * 1000));
  sc.style.setProperty('--p', (p * 100).toFixed(1) + '%');
}
function updatePlayUI() {
  const b = $('#btnPlay');
  b.textContent = state.playing ? '❚❚' : '▶';
  b.setAttribute('aria-label', state.playing ? '일시정지' : '재생');
}

function syncMediaAt(t, playing) {
  const active = clipAt(t);
  for (const c of state.clips) {
    if (c.kind !== 'video') continue;
    const el = c.el;
    if (!el) continue;
    if (c === active) {
      const local = t - clipStart(c);
      const want = clamp(c.inPoint + local, 0, Math.max(0, (c.inPoint + c.duration) - 0.03));
      if (playing) {
        if (el.paused) {
          try { el.currentTime = want; } catch (e) { }
          const pr = el.play();
          if (pr && pr.catch) pr.catch(() => { });
        } else if (Math.abs(el.currentTime - want) > 0.3) {
          try { el.currentTime = want; } catch (e) { }
        }
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - want) > 0.05) { try { el.currentTime = want; } catch (e) { } }
      }
    } else if (!el.paused) {
      el.pause();
    }
  }
}

async function play() {
  const dur = totalDuration();
  if (dur <= 0.05) { toast('먼저 사진이나 영상을 올려 주세요'); return; }
  if (state.t >= dur - 0.02) state.t = 0;
  ensureAudio();
  if (ac.state === 'suspended') { try { await ac.resume(); } catch (e) { } }
  state.playing = true;
  lastTs = 0;
  stopAllSources();
  syncMediaAt(state.t, true);
  liveSources = scheduleAudio(ac, masterGain, ac.currentTime + 0.05, state.t);
  updatePlayUI();
  rafId = requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  stopAllSources();
  syncMediaAt(state.t, false);
  updatePlayUI();
  render();
}

function tick(ts) {
  if (!state.playing) return;
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  const dur = totalDuration();
  state.t += dt;
  if (state.t >= dur) {
    state.t = dur;
    render();
    pause();
    return;
  }
  syncMediaAt(state.t, true);
  render();
  rafId = requestAnimationFrame(tick);
}

function seekTo(t, opts) {
  const dur = totalDuration();
  state.t = clamp(t, 0, dur);
  const wasPlaying = state.playing;
  if (wasPlaying) {
    stopAllSources();
    liveSources = scheduleAudio(ac, masterGain, ac.currentTime + 0.04, state.t);
  }
  syncMediaAt(state.t, wasPlaying);
  render();
}

function togglePlay() { state.playing ? pause() : play(); }

/* ---------------------------------------------------------
   5. 오디오 엔진 (재생 + 오프라인 믹싱)
   --------------------------------------------------------- */
let ac = null, masterGain = null, comp = null;
let liveSources = [];

function ensureAudio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ac = new AC();
    masterGain = ac.createGain();
    masterGain.gain.value = 0.95;
    comp = ac.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.15;
    masterGain.connect(comp);
    comp.connect(ac.destination);
  }
  return ac;
}
function stopAllSources() {
  for (const s of liveSources) { try { s.stop(); } catch (e) { } }
  liveSources = [];
}
async function decodeAudioBlob(blob) {
  ensureAudio();
  const arr = await blob.arrayBuffer();
  return await new Promise((res, rej) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; res(b); } };
    const bad = (e) => { if (!settled) { settled = true; rej(e || new Error('decode')); } };
    try {
      const p = ac.decodeAudioData(arr, ok, bad);
      if (p && p.then) p.then(ok, bad);
    } catch (e) { bad(e); }
  });
}

/* 한 아이템(BGM/나레이션) 예약 */
function scheduleAudioItem(c2, dest, item, at, fromT, total) {
  if (!item.buffer) return null;
  const vol = item.vol == null ? 1 : item.vol;
  if (vol <= 0.001) return null;
  const start = item.start || 0;
  const end = Math.min(item.end != null ? item.end : total, total);
  const s = Math.max(start, fromT);
  const segLen = end - s;
  if (segLen < 0.03) return null;
  const when = at + (s - fromT);
  if (when < at - 0.001) return null;
  const bufDur = item.buffer.duration;
  const offset = s - start;
  const src = c2.createBufferSource();
  src.buffer = item.buffer;
  let playLen = segLen;
  if (item.loop) {
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = bufDur;
    const off = offset % bufDur;
    src.start(when, off, segLen);
    playLen = segLen;
  } else {
    if (offset >= bufDur - 0.02) return null;
    playLen = Math.min(segLen, bufDur - offset);
    src.start(when, offset, playLen);
  }
  const g = c2.createGain();
  const fi = Math.min(item.fadeIn || 0, playLen / 2);
  const fo = Math.min(item.fadeOut || 0, playLen / 2);
  g.gain.setValueAtTime(0, when);
  if (fi > 0.01) g.gain.linearRampToValueAtTime(vol, when + fi);
  else g.gain.setValueAtTime(vol, when);
  if (fo > 0.01) {
    g.gain.setValueAtTime(vol, when + playLen - fo);
    g.gain.linearRampToValueAtTime(0, when + playLen);
  }
  src.connect(g); g.connect(dest);
  return src;
}

/* 원본 + 나레이션 + BGM 전체 예약 */
function scheduleAudio(c2, dest, at, fromT) {
  const total = totalDuration();
  const out = [];
  if (!state.srcMute && state.srcVolume > 0.001) {
    for (const c of state.clips) {
      if (!c.audioBuffer) continue;
      const cs = clipStart(c);
      const segStart = Math.max(cs, fromT);
      const segEnd = Math.min(cs + c.duration, total);
      if (segEnd - segStart < 0.03) continue;
      const when = at + (segStart - fromT);
      if (when < at - 0.001) continue;
      const off = c.inPoint + (segStart - cs);
      const len = Math.min(segEnd - segStart, Math.max(0, c.audioBuffer.duration - off));
      if (len < 0.03) continue;
      const src = c2.createBufferSource();
      src.buffer = c.audioBuffer;
      const g = c2.createGain();
      g.gain.value = state.srcVolume;
      src.connect(g); g.connect(dest);
      try { src.start(when, off, len); out.push(src); } catch (e) { }
    }
  }
  for (const item of state.voices) {
    const s = scheduleAudioItem(c2, dest, item, at, fromT, total);
    if (s) out.push(s);
  }
  for (const item of state.audios) {
    const s = scheduleAudioItem(c2, dest, item, at, fromT, total);
    if (s) out.push(s);
  }
  return out;
}

function hasAnyAudio() {
  const src = !state.srcMute && state.srcVolume > 0.001 && state.clips.some(c => c.audioBuffer && c.duration > 0.05);
  return src || state.voices.length > 0 || state.audios.length > 0;
}

/* ---------------------------------------------------------
   6. 타임라인 UI
   --------------------------------------------------------- */
function drawThumb(cv, c) {
  const g = cv.getContext('2d');
  g.fillStyle = '#241c14';
  g.fillRect(0, 0, cv.width, cv.height);
  const el = c.el;
  try {
    if (c.kind === 'image') {
      if (!el.complete || !el.naturalWidth) return;
      const sc = Math.max(cv.width / el.naturalWidth, cv.height / el.naturalHeight);
      const dw = el.naturalWidth * sc, dh = el.naturalHeight * sc;
      g.drawImage(el, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
    } else if (el.readyState >= 2) {
      const sc = Math.max(cv.width / el.videoWidth, cv.height / el.videoHeight);
      const dw = el.videoWidth * sc, dh = el.videoHeight * sc;
      g.drawImage(el, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
    }
  } catch (e) { }
}

function renderStrip() {
  const strip = $('#strip');
  strip.innerHTML = '';
  state.clips.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'clip' + (c.id === state.selClipId ? ' sel' : '');
    d.dataset.id = c.id;
    const cv = document.createElement('canvas');
    cv.width = 144; cv.height = 112;
    d.appendChild(cv);
    const meta = document.createElement('div');
    meta.className = 'cmeta';
    meta.innerHTML = `<span>${fmtShort(c.duration)}</span><i>${i + 1}</i>`;
    d.appendChild(meta);
    const badge = document.createElement('span');
    badge.className = 'cbad';
    badge.textContent = c.kind === 'video' ? '영상' : '사진';
    d.appendChild(badge);
    d.addEventListener('click', () => selectClip(c.id));
    strip.appendChild(d);
    drawThumb(cv, c);
    if (c.kind === 'video' && c.el.readyState < 2) {
      c.el.addEventListener('loadeddata', () => drawThumb(cv, c), { once: true });
    }
  });
  updateClipTools();
}

function selectClip(id) {
  state.selClipId = id;
  renderStrip();
  render();
}

function updateClipTools() {
  const c = state.clips.find(x => x.id === state.selClipId);
  const tools = $('#clipTools');
  if (!c) { tools.hidden = true; $('#tlHint').textContent = state.clips.length ? '클립을 눌러 선택' : '사진·영상을 올리면 클립이 생깁니다'; return; }
  tools.hidden = false;
  $('#tlHint').textContent = `${state.clips.indexOf(c) + 1}번째 클립 선택됨`;
  $('#clipIn').value = c.kind === 'video' ? c.inPoint.toFixed(1) : '';
  $('#clipIn').disabled = c.kind !== 'video';
  $('#clipLen').value = c.duration.toFixed(1);
  $('#clipSrc').textContent = `${c.name}${c.kind === 'video' ? ' · ' + fmtShort(c.srcDuration) : ''}`;
}

function splitClip() {
  const c = clipAt(state.t);
  if (!c) { toast('재생 위치에 클립이 없습니다'); return; }
  const cs = clipStart(c);
  const local = state.t - cs;
  if (local < 0.25 || local > c.duration - 0.25) { toast('클립 가운데쯤에서 나눌 수 있습니다'); return; }
  const right = Object.assign({}, c, {
    id: uid(),
    inPoint: c.inPoint + local,
    duration: c.duration - local,
  });
  if (c.kind === 'video') {
    right.el = makeVideoEl(c.url);
    right.audioBuffer = c.audioBuffer;
    right.audioState = c.audioState;
  }
  c.duration = local;
  const idx = state.clips.indexOf(c);
  state.clips.splice(idx + 1, 0, right);
  state.selClipId = right.id;
  renderStrip();
  toast('클립을 나눴습니다');
}

function moveClip(dir) {
  const c = state.clips.find(x => x.id === state.selClipId);
  if (!c) { toast('클립을 먼저 선택하세요'); return; }
  const i = state.clips.indexOf(c);
  const j = i + dir;
  if (j < 0 || j >= state.clips.length) return;
  state.clips.splice(i, 1);
  state.clips.splice(j, 0, c);
  renderStrip();
  render();
}

function deleteClip() {
  const c = state.clips.find(x => x.id === state.selClipId);
  if (!c) { toast('클립을 먼저 선택하세요'); return; }
  state.clips = state.clips.filter(x => x.id !== c.id);
  state.selClipId = null;
  state.t = clamp(state.t, 0, totalDuration());
  renderStrip();
  render();
  if (!state.clips.length) { $('#emptyHint').hidden = false; }
  toast('클립을 삭제했습니다');
}

/* ---------------------------------------------------------
   7. 아이템(자막·타이틀·스티커)
   --------------------------------------------------------- */
function defaultDuration() { const d = totalDuration(); return d > 0.2 ? d : 5; }

function addTextItem(kind) {
  const dur = totalDuration();
  const base = Object.assign({}, state.defSt);
  const isTitle = kind === 'title';
  const it = Object.assign({ id: uid(), kind }, base, {
    text: isTitle ? '여기를 눌러 제목을 쓰세요' : '자막을 입력하세요',
    start: isTitle ? 0 : clamp(state.t, 0, Math.max(0, dur - 0.2)),
    end: isTitle ? (dur || 5) : Math.min(dur || 5, clamp(state.t, 0, Math.max(0, dur - 0.2)) + 3),
    x: 0.5,
    y: isTitle ? 0.15 : 0.78,
    size: isTitle ? (state.aspect === 'portrait' ? 0.088 : 0.055) : base.size,
    maxW: 0.88,
  });
  if (it.end - it.start < 0.5) it.end = it.start + 0.5;
  if (!isTitle && !dur) { it.start = 0; it.end = 3; }
  state.items.push(it);
  selectItem(it.id);
  switchTab(isTitle ? 'title' : 'sub');
  renderSubList(); renderTitleList();
  render();
  const ed = isTitle ? $('#ttlText') : $('#subText');
  setTimeout(() => { ed.focus(); ed.select(); }, 60);
  return it;
}

function addStickerInstance(imgItem) {
  const dur = defaultDuration();
  const it = {
    id: uid(), kind: 'stk', img: imgItem.img, name: imgItem.name,
    start: 0, end: dur, x: 0.5, y: 0.4, w: 0.35, rot: 0, opacity: 1,
  };
  state.items.push(it);
  selectItem(it.id);
  switchTab('sticker');
  renderStickerList();
  render();
  return it;
}

function byId(id) { return state.items.find(i => i.id === id) || null; }
function selectedItem() { return byId(state.selId); }

function selectItem(id) {
  state.selId = id;
  renderSubList(); renderTitleList(); renderStickerList();
  syncSubEditor(); syncTitleEditor(); syncStickerEditor(); syncStylePanel();
  render();
}

function deleteItem(id) {
  state.items = state.items.filter(i => i.id !== id);
  if (state.selId === id) state.selId = null;
  renderSubList(); renderTitleList(); renderStickerList();
  syncSubEditor(); syncTitleEditor(); syncStickerEditor(); syncStylePanel();
  render();
}

function duplicateItem(id) {
  const it = byId(id);
  if (!it) return;
  const cp = Object.assign({}, it, { id: uid() });
  const shift = Math.min(0.4, Math.max(0.1, it.end - it.start));
  cp.start = it.start + 0.2;
  cp.end = it.end + 0.2;
  state.items.push(cp);
  selectItem(cp.id);
  render();
}

/* ---------- 목록 ---------- */
function renderSubList() {
  const box = $('#subList');
  const subs = state.items.filter(i => i.kind === 'sub').sort((a, b) => a.start - b.start);
  if (!subs.length) { box.innerHTML = '<div class="list-empty">아직 자막이 없습니다</div>'; return; }
  box.innerHTML = '';
  subs.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (it.id === state.selId ? ' on' : '');
    row.innerHTML = `<span class="t">${fmtShort(it.start)}~${fmtShort(it.end)}</span>
      <span class="tx">${esc(String(it.text).replace(/\n/g, ' ') || '(빈 자막)')}</span>
      <button class="del" title="삭제" data-del="${it.id}">✕</button>`;
    row.addEventListener('click', (e) => {
      if (e.target.dataset.del) { deleteItem(e.target.dataset.del); return; }
      state.t = clamp(it.start + 0.05, 0, totalDuration());
      syncMediaAt(state.t, false);
      selectItem(it.id);
    });
    box.appendChild(row);
  });
}

function renderTitleList() {
  const box = $('#titleList');
  const list = state.items.filter(i => i.kind === 'title');
  if (!list.length) { box.innerHTML = '<div class="list-empty">아직 타이틀이 없습니다</div>'; return; }
  box.innerHTML = '';
  list.forEach(it => {
    const row = document.createElement('div');
    row.className = 'row' + (it.id === state.selId ? ' on' : '');
    row.innerHTML = `<span class="t">${fmtShort(it.start)}~${fmtShort(it.end)}</span>
      <span class="tx">${esc(String(it.text).replace(/\n/g, ' ') || '(빈 타이틀)')}</span>
      <button class="del" title="삭제" data-del="${it.id}">✕</button>`;
    row.addEventListener('click', (e) => {
      if (e.target.dataset.del) { deleteItem(e.target.dataset.del); return; }
      state.t = clamp(it.start + 0.05, 0, totalDuration());
      syncMediaAt(state.t, false);
      selectItem(it.id);
    });
    box.appendChild(row);
  });
}

function renderStickerList() {
  const box = $('#stickerList');
  const list = state.items.filter(i => i.kind === 'stk');
  if (!list.length) { box.innerHTML = '<div class="list-empty">아직 스티커가 없습니다</div>'; return; }
  box.innerHTML = '';
  list.forEach(it => {
    const row = document.createElement('div');
    row.className = 'row' + (it.id === state.selId ? ' on' : '');
    row.innerHTML = `<span class="ico">🖼️</span><span class="tx">${esc(it.name || '스티커')} · ${fmtShort(it.start)}~${fmtShort(it.end)}</span>
      <button class="del" title="삭제" data-del="${it.id}">✕</button>`;
    row.addEventListener('click', (e) => {
      if (e.target.dataset.del) { deleteItem(e.target.dataset.del); return; }
      selectItem(it.id);
    });
    box.appendChild(row);
  });
}

function renderStickerGallery() {
  const box = $('#stickerGallery');
  box.innerHTML = '';
  state.stickerLib.forEach(s => {
    const d = document.createElement('div');
    d.className = 'gitem';
    d.title = '눌러서 얹기';
    const im = document.createElement('img');
    im.src = s.url; im.alt = s.name;
    d.appendChild(im);
    d.addEventListener('click', () => addStickerInstance(s));
    box.appendChild(d);
  });
}

/* ---------- 편집기 동기화 ---------- */
function syncSubEditor() {
  const it = selectedItem();
  const isSub = it && it.kind === 'sub';
  $('#subEditor').hidden = !isSub;
  if (!isSub) return;
  $('#subText').value = it.text || '';
  $('#subStart').value = it.start.toFixed(1);
  $('#subEnd').value = it.end.toFixed(1);
  $('#subSize').value = Math.round(it.size * MS());
  $('#subSizeVal').textContent = Math.round(it.size * MS()) + 'px';
  $('#subX').value = (it.x * 100).toFixed(1);
  $('#subXVal').textContent = Math.round(it.x * 100) + '%';
  $('#subY').value = (it.y * 100).toFixed(1);
  $('#subYVal').textContent = Math.round(it.y * 100) + '%';
}
function syncTitleEditor() {
  const it = selectedItem();
  const isT = it && it.kind === 'title';
  $('#titleEditor').hidden = !isT;
  if (!isT) return;
  $('#ttlText').value = it.text || '';
  $('#ttlStart').value = it.start.toFixed(1);
  $('#ttlEnd').value = it.end.toFixed(1);
  $('#ttlSize').value = Math.round(it.size * MS());
  $('#ttlSizeVal').textContent = Math.round(it.size * MS()) + 'px';
  $('#ttlY').value = (it.y * 100).toFixed(1);
  $('#ttlYVal').textContent = Math.round(it.y * 100) + '%';
  $('#ttlColor').value = it.color; $('#ttlHex').value = it.color;
  $('#ttlAlign').value = it.align || 'center';
}
function syncStickerEditor() {
  const it = selectedItem();
  const isS = it && it.kind === 'stk';
  $('#stickerEditor').hidden = !isS;
  if (!isS) return;
  $('#stkSize').value = Math.round(it.w * 100);
  $('#stkSizeVal').textContent = Math.round(it.w * 100) + '%';
  $('#stkRot').value = Math.round(it.rot || 0);
  $('#stkRotVal').textContent = Math.round(it.rot || 0) + '°';
  $('#stkOpacity').value = Math.round((it.opacity == null ? 1 : it.opacity) * 100);
  $('#stkOpVal').textContent = Math.round((it.opacity == null ? 1 : it.opacity) * 100) + '%';
  $('#stkStart').value = it.start.toFixed(1);
  $('#stkEnd').value = it.end.toFixed(1);
}

function syncStylePanel() {
  const it = selectedItem();
  const target = it && it.kind !== 'stk' ? it : state.defSt;
  $('#styleTarget').textContent = it && it.kind !== 'stk'
    ? (it.kind === 'sub' ? '선택한 자막' : '선택한 타이틀')
    : '새 기본값';
  $('#fontSel').value = target.font;
  $('#weightSel').value = String(target.weight);
  $('#alignSel').value = target.align || 'center';
  $('#colorSel').value = target.color; $('#colorHex').value = target.color;
  $('#strokeColor').value = target.strokeColor; $('#strokeHex').value = target.strokeColor;
  $('#strokeW').value = Math.round((target.strokeW || 0) * 100);
  $('#strokeVal').textContent = Math.round((target.strokeW || 0) * 100) + '%';
  $('#shadowOn').checked = !!target.shadow;
  $('#bgColor').value = target.bgColor; $('#bgHex').value = target.bgColor;
  $('#bgAlpha').value = Math.round((target.bgAlpha || 0) * 100);
  $('#bgAlphaVal').textContent = Math.round((target.bgAlpha || 0) * 100) + '%';
  $('#bgRadius').value = Math.round((target.bgRadius || 0) * 50);
  $('#bgRadVal').textContent = String(Math.round((target.bgRadius || 0) * 50));
  $('#lineHeight').value = Math.round((target.lineHeight || 1.28) * 100);
  $('#lineHeightVal').textContent = (target.lineHeight || 1.28).toFixed(2);
  $('#letterSp').value = Math.round(target.letterSp || 0);
  $('#letterSpVal').textContent = Math.round(target.letterSp || 0) + 'px';
  const fp = $('#fontPreview');
  fp.style.fontFamily = target.font;
  fp.style.fontWeight = String(target.weight);
}

/* 스타일 적용 */
function applyStyle(mut, label) {
  const it = selectedItem();
  if (it && it.kind !== 'stk') { mut(it); }
  else { mut(state.defSt); }
  render();
  if (label) toast(label);
}
const STYLE_KEYS = ['font', 'weight', 'color', 'strokeW', 'strokeColor', 'shadow', 'bgColor', 'bgAlpha', 'bgPad', 'bgRadius', 'align', 'lineHeight', 'letterSp', 'maxW'];

/* ---------------------------------------------------------
   8. 스테이지 포인터 (이동·핀치·크기)
   --------------------------------------------------------- */
const touch = $('#touch');
const pointers = new Map();
let drag = null;

function stagePoint(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width * W, y: (ev.clientY - r.top) / r.height * H };
}
function visibleItemsNow() {
  return state.items.filter(it => state.t >= it.start - 1e-6 && state.t <= it.end + 1e-6);
}
function hitTest(x, y) {
  const list = visibleItemsNow();
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i], b = it._box;
    if (!b) continue;
    if (x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8) return it;
  }
  return null;
}
function nearHandle(it, p) {
  const b = it._box;
  if (!b) return false;
  return Math.hypot(p.x - (b.x + b.w), p.y - (b.y + b.h)) < W / 24;
}

touch.addEventListener('pointerdown', (e) => {
  if (state.exporting) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { touch.setPointerCapture(e.pointerId); } catch (err) { }
  if (pointers.size === 2) {
    const it = selectedItem();
    if (!it) return;
    const pts = Array.from(pointers.values());
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    drag = { mode: 'pinch', id: it.id, d0: Math.max(10, d), w0: it.kind === 'stk' ? it.w : it.size, isStk: it.kind === 'stk' };
    touch.classList.add('grabbing');
    return;
  }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const p = stagePoint(e);
  const hit = hitTest(p.x, p.y);
  if (!hit) { state.selId = null; syncStylePanel(); syncSubEditor(); syncTitleEditor(); syncStickerEditor(); render(); return; }
  if (state.selId !== hit.id) selectItem(hit.id);
  if (nearHandle(hit, p)) {
    drag = { mode: 'resize', id: hit.id, p0: p, w0: hit.kind === 'stk' ? hit.w : hit.size, isStk: hit.kind === 'stk' };
  } else {
    drag = { mode: 'move', id: hit.id, dx: p.x - hit.x * W, dy: p.y - hit.y * H };
  }
  touch.classList.add('grabbing');
});

touch.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) return;
  const it = byId(drag.id);
  if (!it) return;

  if (drag.mode === 'pinch' && pointers.size >= 2) {
    const pts = Array.from(pointers.values());
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const ratio = d / drag.d0;
    if (drag.isStk) it.w = clamp(drag.w0 * ratio, 0.03, 1.4);
    else it.size = clamp(drag.w0 * ratio, 12 / MS(), 300 / MS());
    afterItemChange(it, true);
    return;
  }
  const p = stagePoint(e);
  if (drag.mode === 'move') {
    it.x = clamp((p.x - drag.dx) / W, 0.02, 0.98);
    it.y = clamp((p.y - drag.dy) / H, 0.02, 0.98);
    afterItemChange(it, false);
  } else if (drag.mode === 'resize') {
    const cx = it.x * W, cy = it.y * H;
    const dNow = Math.hypot(p.x - cx, p.y - cy);
    const d0 = Math.hypot(drag.p0.x - cx, drag.p0.y - cy) || 1;
    const ratio = dNow / d0;
    if (drag.isStk) it.w = clamp(drag.w0 * ratio, 0.03, 1.4);
    else it.size = clamp(drag.w0 * ratio, 12 / MS(), 300 / MS());
    afterItemChange(it, true);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) { drag = null; touch.classList.remove('grabbing'); }
  else if (drag && drag.mode === 'pinch' && pointers.size === 1) { drag = null; touch.classList.remove('grabbing'); }
}
touch.addEventListener('pointerup', endPointer);
touch.addEventListener('pointercancel', endPointer);

function afterItemChange(it, sizeChanged) {
  render();
  if (sizeChanged) {
    if (it.kind === 'sub') {
      $('#subSize').value = Math.round(it.size * MS());
      $('#subSizeVal').textContent = Math.round(it.size * MS()) + 'px';
    } else if (it.kind === 'title') {
      $('#ttlSize').value = Math.round(it.size * MS());
      $('#ttlSizeVal').textContent = Math.round(it.size * MS()) + 'px';
    } else if (it.kind === 'stk') {
      $('#stkSize').value = Math.round(it.w * 100);
      $('#stkSizeVal').textContent = Math.round(it.w * 100) + '%';
    }
  }
}

/* ---------------------------------------------------------
   9. 안전영역 가이드
   --------------------------------------------------------- */
const GUIDES = {
  shorts: { top: 0.055, bottom: 0.17, right: 0.14, label: '쇼츠' },
  reels: { top: 0.13, bottom: 0.25, right: 0.16, label: '릴스' },
  clip: { top: 0.08, bottom: 0.16, right: 0.13, label: '클립' },
};
function renderGuides() {
  const box = $('#guides');
  box.innerHTML = '';
  if (state.guide === 'none' || state.aspect !== 'portrait') return;
  const list = state.guide === 'all' ? Object.keys(GUIDES) : [state.guide];
  const merged = { top: 0, bottom: 0, right: 0 };
  list.forEach(k => {
    const g = GUIDES[k]; if (!g) return;
    merged.top = Math.max(merged.top, g.top);
    merged.bottom = Math.max(merged.bottom, g.bottom);
    merged.right = Math.max(merged.right, g.right);
  });
  const mk = (cls, style, label) => {
    const d = document.createElement('div');
    d.className = 'gz ' + cls;
    Object.assign(d.style, style);
    if (label) {
      const l = document.createElement('span');
      l.className = 'glabel';
      l.textContent = label;
      l.style.left = '6px'; l.style.top = '4px';
      d.appendChild(l);
    }
    box.appendChild(d);
  };
  mk('top', { left: '0', right: '0', top: '0', height: (merged.top * 100) + '%' },
    state.guide === 'all' ? '상단 UI' : GUIDES[state.guide].label + ' 상단');
  mk('bottom', { left: '0', right: '0', bottom: '0', height: (merged.bottom * 100) + '%' },
    state.guide === 'all' ? '하단 설명·버튼' : '자막 안전선');
  mk('right', { right: '0', top: (merged.top * 100) + '%', bottom: (merged.bottom * 100) + '%', width: (merged.right * 100) + '%' },
    '아이콘');
}

/* ---------------------------------------------------------
   9-b. 화면 비율 (9:16 / 16:9)
   --------------------------------------------------------- */
function syncSizeOptions() {
  const sel = $('#expSize');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = state.aspect === 'portrait'
    ? '<option value="1080">1080 × 1920 (권장)</option><option value="720">720 × 1280 (가볍게)</option>'
    : '<option value="1920">1920 × 1080 (권장)</option><option value="1280">1280 × 720 (가볍게)</option>';
  if (Array.from(sel.options).some(o => o.value === cur)) sel.value = cur;
}

function setAspect(a, silent) {
  state.aspect = a === 'landscape' ? 'landscape' : 'portrait';
  if (state.aspect === 'portrait') { W = 1080; H = 1920; } else { W = 1920; H = 1080; }
  canvas.width = W; canvas.height = H;
  const sb = $('#stageBox');
  if (sb) sb.dataset.aspect = state.aspect;
  $$('#aspectChips .chip').forEach(c => c.classList.toggle('on', c.dataset.aspect === state.aspect));
  state.defSt.size = state.aspect === 'portrait' ? 0.105 : 0.075;
  if (state.aspect === 'landscape') state.guide = 'none';
  $$('#guideChips .chip').forEach(c => {
    c.disabled = state.aspect === 'landscape';
    c.classList.toggle('on', c.dataset.guide === state.guide);
  });
  syncSizeOptions();
  renderGuides();
  render();
  if (!silent) toast(state.aspect === 'portrait' ? '9:16 세로 모드로 바꿨습니다' : '16:9 가로 모드로 바꿨습니다 (안전영역 잠금)');
}

/* ---------------------------------------------------------
   9-c. 글 → 자동 자막
   --------------------------------------------------------- */
function autoClean(t) {
  return String(t || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function autoUnits(body, maxLen) {
  const text = autoClean(body);
  const out = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/^[\s>*#•·‣▶■□○●\-–—]+/, '').replace(/^\d{1,2}[).]\s*/, '').trim();
    if (!line || line.length < 5) continue;
    if (/^(구독|좋아요|공잠|댓글|이웃|카카오|문의|광고|Copyright|ⓒ)/i.test(line)) continue;
    const sents = line.match(/[^.!?。？！]+[.!?。？！]*/g) || [line];
    for (let s of sents) {
      s = s.trim();
      if (!s || s.length < 5) continue;
      if (s.length <= maxLen) { out.push(s); continue; }
      const parts = s
        .replace(/([,，、])\s*/g, '$1|')
        .replace(/\s(그리고|하지만|그런데|그래서|또한|특히|즉|결국|다만|그러나|위해|때문에|경우)\s/g, '|$1 ')
        .split('|');
      for (let p of parts) {
        p = p.trim().replace(/[,，、]$/, '');
        if (!p) continue;
        if (p.length <= maxLen) { out.push(p); continue; }
        let buf = '';
        for (const word of p.split(/\s+/)) {
          if (!word) continue;
          if (buf && (buf.length + 1 + word.length) > maxLen) { out.push(buf); buf = word; }
          else buf = buf ? buf + ' ' + word : word;
        }
        if (buf) out.push(buf);
      }
    }
  }
  return out;
}

function planAuto(body, countOpt, maxLen) {
  const units = autoUnits(body, maxLen);
  if (!units.length) return [];
  const total = totalDuration();
  let target = countOpt > 0 ? countOpt : clamp(Math.round(units.length / 2), 4, 8);
  if (total > 0) target = Math.min(target, Math.max(2, Math.floor(total / 1.2)));
  target = Math.max(1, Math.min(target, units.length));

  // 1) 처음엔 문장 단위 그대로
  let segs = units.slice();

  // 2) 너무 많으면 가장 짧은 이웃끼리 합치기 (문장을 버리지 않는다)
  const hardMax = Math.round(maxLen * 1.5);
  let guard = 0;
  while (segs.length > target && guard++ < 60) {
    let bi = -1, bl = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      const l = segs[i].length + segs[i + 1].length;
      if (l <= hardMax && l < bl) { bl = l; bi = i; }
    }
    if (bi < 0) { // 다 길면 어쩔 수 없이 가장 짧은 쌍이라도 합친다
      for (let i = 0; i < segs.length - 1; i++) {
        const l = segs[i].length + segs[i + 1].length;
        if (l < bl) { bl = l; bi = i; }
      }
    }
    if (bi < 0) break;
    segs.splice(bi, 2, trimTo(segs[bi] + ' ' + segs[bi + 1], hardMax));
  }

  // 3) 너무 적으면 가장 긴 구간을 단어 경계에서 나누기
  guard = 0;
  while (segs.length < target && guard++ < 12) {
    let li = -1, ll = 0;
    segs.forEach((t, i) => { if (t.length > ll && t.indexOf(' ') > 0) { ll = t.length; li = i; } });
    if (li < 0) break;
    const words = segs[li].split(' ');
    const mid = Math.ceil(words.length / 2);
    const a = words.slice(0, mid).join(' ');
    const b = words.slice(mid).join(' ');
    if (!a || !b) break;
    segs.splice(li, 1, a, b);
  }
  return segs.map(t => trimTo(t, hardMax));
}

function trimTo(t, maxLen) {
  t = String(t).replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  let cut = t.slice(0, maxLen);
  const sp = cut.lastIndexOf(' ');
  if (sp > maxLen * 0.55) cut = cut.slice(0, sp);
  return cut.replace(/[,，、.。]$/, '') + '…';
}

function computeAutoSegments(body, countOpt, maxLen) {
  const groups = planAuto(body, countOpt, maxLen);
  if (!groups.length) return [];
  const total = totalDuration();
  if (!total) return groups.map((t, i) => ({ text: t, start: i * 3, end: i * 3 + 3 }));
  const weights = groups.map(g => Math.max(8, g.length));
  const wsum = weights.reduce((a, b) => a + b, 0);
  let cum = 0;
  const cumArr = weights.map(w => (cum += w));
  return groups.map((g, i) => {
    const s = total * (i ? cumArr[i - 1] : 0) / wsum;
    const e = total * cumArr[i] / wsum;
    return { text: g, start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10 };
  });
}

function readAutoForm() {
  return {
    title: autoClean($('#autoTitleIn').value).split('\n')[0].slice(0, 60),
    body: $('#autoBody').value,
    count: parseInt($('#autoCount').value, 10) || 0,
    len: parseInt($('#autoLen').value, 10) || 28,
  };
}

let autoPreviewTimer = null;
function renderAutoPreview() {
  const f = readAutoForm();
  const segs = f.body.trim().length > 10 ? computeAutoSegments(f.body, f.count, f.len) : [];
  $('#autoCount2').textContent = segs.length ? segs.length + '개' : '0개';
  const list = $('#autoList');
  if (!segs.length) {
    list.innerHTML = '<li class="ap-empty">본문을 붙여넣으면 여기에 구간이 보입니다</li>';
    return;
  }
  list.innerHTML = segs.map(s =>
    `<li><span class="ap-t">${fmtShort(s.start)}~${fmtShort(s.end)}</span>${esc(s.text)}</li>`).join('');
}
function scheduleAutoPreview() {
  clearTimeout(autoPreviewTimer);
  autoPreviewTimer = setTimeout(renderAutoPreview, 220);
}

function openAutoModal() {
  $('#autoModal').hidden = false;
  renderAutoPreview();
  setTimeout(() => { try { $('#autoBody').focus(); } catch (e) { } }, 80);
}

function applyAuto() {
  const f = readAutoForm();
  if (autoClean(f.body).length < 20) { toast('본문을 20자 이상 붙여넣어 주세요'); return; }
  const segs = computeAutoSegments(f.body, f.count, f.len);
  if (!segs.length) { toast('자막으로 나눌 문장을 찾지 못했습니다'); return; }

  if ($('#autoReplace').checked) {
    state.items = state.items.filter(i => i.kind !== 'sub');
  }
  const base = Object.assign({}, state.defSt);
  const y = state.aspect === 'portrait' ? 0.78 : 0.82;
  const subs = segs.map(s => Object.assign({}, base, {
    id: uid(), kind: 'sub', text: s.text, start: s.start, end: s.end,
    x: 0.5, y, maxW: 0.86,
    size: state.aspect === 'portrait' ? 0.105 : 0.075,
  }));
  state.items.push(...subs);

  const total = totalDuration() || (segs[segs.length - 1].end || 5);
  if ($('#autoTitleOn').checked) {
    const titleText = f.title || segs[0].text;
    let t = state.items.find(i => i.kind === 'title');
    if (t) { t.text = titleText; t.start = 0; t.end = total; }
    else {
      state.items.push(Object.assign({}, base, {
        id: uid(), kind: 'title', text: titleText, start: 0, end: total,
        x: 0.5, y: state.aspect === 'portrait' ? 0.15 : 0.18,
        size: state.aspect === 'portrait' ? 0.088 : 0.06, maxW: 0.88,
      }));
    }
  }

  $('#autoModal').hidden = true;
  switchTab('sub');
  state.t = 0;
  syncMediaAt(0, false);
  renderSubList(); renderTitleList(); renderStickerList();
  state.selId = subs[0] ? subs[0].id : null;
  syncSubEditor(); syncStylePanel(); syncTitleEditor(); syncStickerEditor();
  render();
  if (!totalDuration()) {
    toast(`자막 ${subs.length}개를 만들었습니다 · 사진·영상을 올리면 시간이 자동으로 맞춰집니다`, 4200);
  } else {
    toast(`자막 ${subs.length}개${$('#autoTitleOn').checked ? ' · 타이틀 1개' : ''}를 채웠습니다`, 3000);
  }
}

/* ---------------------------------------------------------
   10. 오디오 목록 UI
   --------------------------------------------------------- */
function audioRow(item, kind) {
  const wrap = document.createElement('div');
  wrap.className = 'arow';
  wrap.dataset.id = item.id;
  const isBgm = kind === 'bgm';
  const lenTxt = item.buffer ? fmtShort(item.buffer.duration) : '–';
  wrap.innerHTML = `
    <div class="ah">
      <span>${isBgm ? '🎵' : '🎙️'}</span>
      <span class="nm">${esc(item.name || (isBgm ? '배경음악' : '내 목소리'))}<small>길이 ${lenTxt} · 시작 ${item.start.toFixed(1)}초${item.loop ? ' · 반복' : ''}</small></span>
      <button class="playmini" data-act="prev">▶ 들어보기</button>
      <button class="del" data-act="del">✕</button>
    </div>
    <div class="agrid">
      <label>음량 <b>${Math.round(item.vol * 100)}%</b><input type="range" min="0" max="150" step="1" value="${Math.round(item.vol * 100)}" data-k="vol"></label>
      <label>시작(초) <b>${item.start.toFixed(1)}</b><input type="range" min="0" max="${Math.max(30, Math.ceil(totalDuration() || 10))}" step="0.1" value="${item.start}" data-k="start"></label>
      <label>페이드 인 <b>${item.fadeIn.toFixed(1)}초</b><input type="range" min="0" max="5" step="0.1" value="${item.fadeIn}" data-k="fadeIn"></label>
      <label>페이드 아웃 <b>${item.fadeOut.toFixed(1)}초</b><input type="range" min="0" max="5" step="0.1" value="${item.fadeOut}" data-k="fadeOut"></label>
      ${isBgm ? `<label class="chk"><input type="checkbox" data-k="loop" ${item.loop ? 'checked' : ''}> 반복 재생</label>` : ''}
    </div>`;
  wrap.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    if (k === 'loop') item.loop = e.target.checked;
    else item[k] = parseFloat(e.target.value) / (k === 'vol' ? 100 : 1);
    refreshAudioRowLabels(wrap, item, kind);
    if (state.playing) { stopAllSources(); liveSources = scheduleAudio(ac, masterGain, ac.currentTime + 0.03, state.t); }
  });
  wrap.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'del') {
      if (kind === 'bgm') state.audios = state.audios.filter(a => a.id !== item.id);
      else state.voices = state.voices.filter(a => a.id !== item.id);
      renderAudioLists(); updateAudioNote();
      toast('삭제했습니다');
    } else if (act === 'prev') {
      previewBuffer(item.buffer, item.vol);
    }
  });
  return wrap;
}
function refreshAudioRowLabels(wrap, item, kind) {
  const b = wrap.querySelectorAll('.agrid b');
  if (b[0]) b[0].textContent = Math.round(item.vol * 100) + '%';
  if (b[1]) b[1].textContent = item.start.toFixed(1);
  if (b[2]) b[2].textContent = item.fadeIn.toFixed(1) + '초';
  if (b[3]) b[3].textContent = item.fadeOut.toFixed(1) + '초';
}

let previewSrc = null;
function previewBuffer(buffer, vol) {
  if (!buffer) return;
  ensureAudio();
  if (ac.state === 'suspended') ac.resume();
  try { if (previewSrc) previewSrc.stop(); } catch (e) { }
  const s = ac.createBufferSource();
  s.buffer = buffer;
  const g = ac.createGain();
  g.gain.value = vol == null ? 1 : vol;
  s.connect(g); g.connect(ac.destination);
  s.start();
  previewSrc = s;
}

function renderAudioLists() {
  const bgm = $('#bgmList'), voice = $('#voiceList');
  if (!state.audios.length) bgm.innerHTML = '<div class="list-empty">아직 배경음악이 없습니다</div>';
  else { bgm.innerHTML = ''; state.audios.forEach(a => bgm.appendChild(audioRow(a, 'bgm'))); }
  if (!state.voices.length) voice.innerHTML = '<div class="list-empty">아직 나레이션이 없습니다</div>';
  else { voice.innerHTML = ''; state.voices.forEach(v => voice.appendChild(audioRow(v, 'voice'))); }
}

function updateAudioNote() {
  const c = state.clips.filter(x => x.kind === 'video');
  if (!c.length) { $('#audioNote').textContent = '영상에 소리가 있으면 자동으로 함께 저장됩니다. (브라우저가 소리를 못 읽는 형식이면 무음으로 처리됩니다)'; return; }
  const okCount = c.filter(x => x.audioBuffer).length;
  const failCount = c.filter(x => x.audioState === 'fail').length;
  if (failCount && !okCount) {
    $('#audioNote').textContent = '올린 영상의 소리를 이 브라우저가 읽지 못했습니다. 원본 소리 없이 저장되니, 나레이션·BGM으로 소리를 넣어 주세요.';
  } else if (okCount) {
    $('#audioNote').textContent = `영상 ${okCount}개에서 소리를 찾았습니다. 원본 소리·나레이션·BGM이 함께 저장됩니다.`;
  }
}

/* 파일 → 오디오 아이템 */
async function addAudioFiles(files, kind) {
  const list = Array.from(files || []);
  if (!list.length) return;
  showBusy('소리를 읽는 중…');
  let n = 0;
  for (const f of list) {
    try {
      const buf = await decodeAudioBlob(f);
      if (!buf || !buf.duration) throw new Error('empty');
      const item = {
        id: uid(), kind,
        name: f.name.replace(/\.[^.]+$/, ''),
        buffer: buf,
        vol: kind === 'bgm' ? 0.5 : 1,
        fadeIn: kind === 'bgm' ? 0.8 : 0,
        fadeOut: kind === 'bgm' ? 1.0 : 0,
        loop: kind === 'bgm',
        start: kind === 'bgm' ? 0 : clamp(state.t, 0, Math.max(0, totalDuration())),
      };
      if (kind === 'bgm') state.audios.push(item); else state.voices.push(item);
      n++;
    } catch (e) {
      console.warn('audio decode fail', f.name, e);
    }
  }
  hideBusy();
  renderAudioLists(); updateAudioNote();
  toast(n ? `${n}개 소리를 추가했습니다` : '소리를 읽지 못했습니다 (MP3·M4A·WAV 권장)');
}

/* ---------------------------------------------------------
   11. 마이크 녹음
   --------------------------------------------------------- */
let recTimer = null, recObj = null, lastRecUrl = null;

function recMessage(msg) { $('#recState').innerHTML = msg; }

async function startRecording() {
  if (recObj) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    recMessage('이 브라우저에서는 마이크 녹음을 지원하지 않습니다. 휴대폰은 <b>크롬</b> 또는 <b>삼성 인터넷</b>으로 열어 주세요.');
    toast('녹음을 지원하지 않는 브라우저입니다');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = err && err.name;
    let guide;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      guide = '마이크 권한이 막혀 있습니다. 주소창 왼쪽 <b>자물쇠(⋮)</b> → <b>마이크</b> → <b>허용</b>으로 바꾼 뒤 다시 눌러 주세요.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      guide = '마이크를 찾지 못했습니다. 마이크가 연결돼 있는지 확인해 주세요.';
    } else if (name === 'NotReadableError') {
      guide = '다른 앱이 마이크를 쓰고 있습니다. 통화·녹음 앱을 끄고 다시 시도해 주세요.';
    } else {
      guide = '마이크를 열지 못했습니다: ' + (err && err.message ? esc(err.message) : '알 수 없는 오류');
    }
    recMessage(guide);
    toast('마이크를 열 수 없습니다');
    return;
  }
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  let mime = '';
  for (const m of cands) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) { mime = m; break; } } catch (e) { } }
  let mr;
  try {
    mr = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 }) : new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    recMessage('이 브라우저의 녹음 형식을 지원하지 않습니다. <b>🗣️ 음성 파일</b>로 넣어 주세요.');
    return;
  }
  const chunks = [];
  const startT = clamp(state.t, 0, Math.max(0, totalDuration()));
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(recTimer);
    const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
    hideRecUI();
    if (!chunks.length) { toast('녹음된 소리가 없습니다'); return; }
    showBusy('녹음을 저장하는 중…');
    try {
      const buf = await decodeAudioBlob(blob);
      if (!buf || buf.duration < 0.2) throw new Error('short');
      const n = state.voices.filter(v => v.recorded).length + 1;
      state.voices.push({
        id: uid(), kind: 'voice', name: '내 목소리 ' + n, buffer: buf,
        vol: 1, fadeIn: 0, fadeOut: 0, loop: false, start: startT, recorded: true,
      });
      try { if (lastRecUrl) URL.revokeObjectURL(lastRecUrl); } catch (e) { }
      lastRecUrl = URL.createObjectURL(blob);
      renderAudioLists(); updateAudioNote();
      recMessage(`녹음 완료 · <b>${fmtShort(buf.duration)}</b> · ${startT.toFixed(1)}초 위치에 넣었습니다. 아래 목록에서 음량·시작 위치를 조절하세요.`);
      toast('녹음을 나레이션으로 넣었습니다');
    } catch (e) {
      console.warn(e);
      recMessage('녹음은 됐지만 이 브라우저에서 다시 읽지 못했습니다. <b>🗣️ 음성 파일</b>로 저장해 올려 주세요.');
      toast('녹음 파일을 읽지 못했습니다');
    } finally { hideBusy(); }
  };
  try { mr.start(250); } catch (e) { recMessage('녹음을 시작하지 못했습니다.'); return; }
  recObj = { mr, stream, startT, t0: performance.now() };
  $('#btnRec').hidden = true;
  $('#btnRecStop').hidden = false;
  $('#btnRecCancel').hidden = false;
  $('#recTime').hidden = false;
  $('.recdock').classList.add('rec');
  if (lastRecUrl) $('#btnRecPreview').hidden = true;
  recMessage('녹음 중입니다. 영상을 재생해 두고 말하면 그 위치부터 나레이션이 들어갑니다.');
  const tickRec = () => {
    if (!recObj) return;
    const s = (performance.now() - recObj.t0) / 1000;
    $('#recClock').textContent = fmtShort(s);
  };
  recTimer = setInterval(tickRec, 200);
  tickRec();
}

function stopRecording() {
  if (!recObj) return;
  try { recObj.mr.stop(); } catch (e) { hideRecUI(); }
}

function hideRecUI() {
  recObj = null;
  clearInterval(recTimer); recTimer = null;
  $('#btnRec').hidden = false;
  $('#btnRecStop').hidden = true;
  $('#btnRecCancel').hidden = true;
  $('#recTime').hidden = true;
  $('.recdock').classList.remove('rec');
  if (lastRecUrl) $('#btnRecPreview').hidden = false;
}

/* ---------------------------------------------------------
   12. 미리듣기(TTS)
   --------------------------------------------------------- */
function loadVoices() {
  if (!('speechSynthesis' in window)) {
    $('#speakVoice').innerHTML = '<option value="">지원 안 함</option>';
    return;
  }
  const all = speechSynthesis.getVoices();
  const ko = all.filter(v => (v.lang || '').toLowerCase().startsWith('ko'));
  const list = ko.length ? ko : all;
  const sel = $('#speakVoice');
  const prev = sel.value;
  sel.innerHTML = '<option value="">기본</option>' + list.map((v, i) =>
    `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  if (prev) sel.value = prev;
}
function speakPreview() {
  if (!('speechSynthesis' in window)) { toast('이 브라우저는 읽어주기를 지원하지 않습니다'); return; }
  const text = $('#speakText').value.trim();
  if (!text) { toast('대본을 먼저 입력해 주세요'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  const name = $('#speakVoice').value;
  if (name) { const v = speechSynthesis.getVoices().find(x => x.name === name); if (v) u.voice = v; }
  u.rate = parseInt($('#speakRate').value, 10) / 100;
  speechSynthesis.speak(u);
}

/* ---------------------------------------------------------
   13. 내보내기
   --------------------------------------------------------- */
function showBusy(msg) { $('#busyMsg').textContent = msg || '처리 중…'; $('#busy').hidden = false; }
function hideBusy() { $('#busy').hidden = true; }

function showExportUI() {
  $('#exportBar').hidden = false;
  $('#exportFill').style.width = '0%';
  $('#exportMsg').textContent = '준비 중…';
  $('#exportDownload').hidden = true;
  $('#btnExport').disabled = true;
}
function hideExportUI() { $('#btnExport').disabled = false; }
function setProgress(p, msg) {
  $('#exportFill').style.width = clamp(p * 100, 0, 100).toFixed(1) + '%';
  if (msg) $('#exportMsg').textContent = msg;
}

async function pickAvcCodec(w, h) {
  if (typeof VideoEncoder === 'undefined') return null;
  const cands = ['avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4D0032', 'avc1.4D0028', 'avc1.42E032', 'avc1.42E028'];
  for (const codec of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 8000000, framerate: FPS });
      if (r && r.supported) return codec;
    } catch (e) { }
  }
  return null;
}
async function pickAudioCodec() {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const c of ['mp4a.40.2', 'opus']) {
    try {
      const r = await AudioEncoder.isConfigSupported({ codec: c, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      if (r && r.supported) return c;
    } catch (e) { }
  }
  return null;
}

async function renderMix(duration) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  const sr = 48000;
  const frames = Math.max(1, Math.ceil(duration * sr));
  const oac = new OAC(2, frames, sr);
  const comp2 = oac.createDynamicsCompressor();
  comp2.threshold.value = -6; comp2.knee.value = 12; comp2.ratio.value = 4;
  comp2.connect(oac.destination);
  const nodes = scheduleAudio(oac, comp2, 0, 0);
  if (!nodes.length) return null;
  const buf = await oac.startRendering();
  return buf;
}

async function exportWebCodecs(duration, outW, outH) {
  const vcodec = await pickAvcCodec(outW, outH);
  if (!vcodec) return null;
  const wantAudio = hasAnyAudio();
  let audioBuf = null, acodec = null;
  if (wantAudio) {
    setProgress(0.01, '소리를 섞는 중…');
    try { audioBuf = await renderMix(duration); } catch (e) { console.warn('mix fail', e); audioBuf = null; }
    if (audioBuf) acodec = await pickAudioCodec();
  }
  setProgress(0.04, '인코더 준비 중…');

  const Muxer = window.Mp4Muxer && window.Mp4Muxer.Muxer;
  if (!Muxer || !window.Mp4Muxer.ArrayBufferTarget) return null;

  const muxer = new Muxer({
    target: new window.Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: outW, height: outH },
    audio: (audioBuf && acodec) ? { codec: acodec === 'mp4a.40.2' ? 'aac' : 'opus', sampleRate: 48000, numberOfChannels: 2 } : undefined,
    fastStart: 'in-memory',
  });

  let encError = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encError = e; } },
    error: (e) => { encError = e; },
  });
  venc.configure({
    codec: vcodec, width: outW, height: outH,
    bitrate: Math.max(outW, outH) >= 1080 ? 9000000 : 5500000,
    framerate: FPS, latencyMode: 'quality',
  });

  // 오디오 먼저 인코딩 (영상은 실시간 렌더)
  if (audioBuf && acodec) {
    const aenc = new AudioEncoder({
      output: (chunk, meta) => { try { muxer.addAudioChunk(chunk, meta); } catch (e) { encError = e; } },
      error: (e) => { encError = e; },
    });
    aenc.configure({ codec: acodec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
    const CH = Math.min(2, audioBuf.numberOfChannels);
    const FR = 1024, SR = 48000;
    for (let off = 0; off < audioBuf.length; off += FR) {
      const n = Math.min(FR, audioBuf.length - off);
      const data = new Float32Array(n * 2);
      for (let ch = 0; ch < 2; ch++) {
        const src = ch < CH ? audioBuf.getChannelData(ch).subarray(off, off + n) : new Float32Array(n);
        data.set(src, ch * n);
      }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(off / SR * 1e6), data });
      try { aenc.encode(ad); } catch (e) { encError = e; }
      ad.close();
      if (aenc.encodeQueueSize > 30) await sleep(0);
      if (off % (FR * 200) === 0) await sleep(0);
    }
    try { await aenc.flush(); } catch (e) { encError = e; }
    aenc.close();
  }

  // 실시간 렌더 + 인코딩
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d', { alpha: false });

  stopAllSources();
  state.t = 0;
  syncMediaAt(0, false);
  await sleep(120);

  let frameIdx = 0, nextAt = 0;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      if (encError) { resolve(); return; }
      const now = (performance.now() - t0) / 1000;
      let guard = 0;
      while (nextAt <= now && guard < 3) {
        const tt = Math.min(nextAt, duration);
        syncMediaAt(tt, true);
        renderForExport(octx, outW, outH, tt);
        try {
          const vf = new VideoFrame(out, { timestamp: Math.round(tt * 1e6), duration: Math.round(1e6 / FPS) });
          venc.encode(vf, { keyFrame: frameIdx % (FPS * 2) === 0 });
          vf.close();
        } catch (e) { encError = e; }
        frameIdx++;
        nextAt += 1 / FPS;
        guard++;
        if (venc.encodeQueueSize > 8) break;
      }
      setProgress(clamp(now / duration, 0, 1), '녹화 중 ' + Math.round(clamp(now / duration, 0, 1) * 100) + '%');
      if (now >= duration) { resolve(); return; }
      setTimeout(step, venc.encodeQueueSize > 8 ? 12 : 0);
    };
    step();
  });

  syncMediaAt(0, false);
  if (encError) throw encError;
  setProgress(1, '마무리 중…');
  try { await venc.flush(); } catch (e) { }
  venc.close();
  await muxer.finalize();
  const buffer = muxer.target.buffer;
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    ext: 'mp4',
    mime: 'video/mp4',
    note: (audioBuf && acodec === 'opus') ? 'opus' : (audioBuf ? 'aac' : 'silent'),
  };
}

async function exportRecorder(duration) {
  if (!window.MediaRecorder || !canvas.captureStream) return null;
  // H.264+AAC MP4를 낼 수 있는 브라우저(사파리 등)를 먼저, 그다음 WebM(유튜브 호환),
  // 마지막에 코덱 미지정 video/mp4(크롬은 VP9+Opus로 담아 호환성이 떨어짐).
  const types = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  let mime = '';
  for (const t of types) { try { if (MediaRecorder.isTypeSupported(t)) { mime = t; break; } } catch (e) { } }
  if (!mime) return null;

  const AC = ensureAudio();
  if (AC.state === 'suspended') { try { await AC.resume(); } catch (e) { } }
  const stream = canvas.captureStream(FPS);
  const dest = AC.createMediaStreamDestination();
  masterGain.connect(dest);
  dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));

  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 9000000, audioBitsPerSecond: 128000 });
  } catch (e) {
    try { masterGain.disconnect(dest); } catch (err) { }
    return null;
  }
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });

  state.t = 0;
  syncMediaAt(0, false);
  await sleep(120);
  const lead = 0.15;
  stopAllSources();
  liveSources = scheduleAudio(AC, masterGain, AC.currentTime + lead, 0);
  try { rec.start(250); } catch (e) { try { masterGain.disconnect(dest); } catch (err) { } return null; }
  await sleep(lead * 1000);

  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const now = (performance.now() - t0) / 1000;
      const tt = Math.min(now, duration);
      syncMediaAt(tt, true);
      drawScene(ctx, tt, { forExport: true });
      setProgress(clamp(now / duration, 0, 1), '녹화 중 ' + Math.round(clamp(now / duration, 0, 1) * 100) + '%');
      if (now >= duration) { resolve(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  try { rec.stop(); } catch (e) { }
  await stopped;
  stopAllSources();
  try { masterGain.disconnect(dest); } catch (e) { }
  stream.getTracks().forEach(t => t.stop());
  const type = (rec.mimeType || mime).split(';')[0];
  const ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
  return { blob: new Blob(chunks, { type }), ext, mime: type, note: ext === 'webm' ? 'webm' : 'rec' };
}

const FORCE_RECORDER = /[?&]rec=1/.test(location.search);

async function doExport() {
  if (state.exporting) return;
  const duration = totalDuration();
  if (duration < 0.2) { toast('먼저 사진이나 영상을 올려 주세요'); return; }
  const size = parseInt($('#expSize').value, 10) || 0;
  const dims = state.aspect === 'portrait'
    ? (size === 720 ? [720, 1280] : [1080, 1920])
    : (size === 1280 ? [1280, 720] : [1920, 1080]);
  $('#exportModal').hidden = true;
  pause();
  state.exporting = true;
  showExportUI();
  let wakeLock = null;
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { }
  const t0 = Date.now();
  try {
    await document.fonts.ready.catch(() => { });
    let result = null;
    try {
      if (!FORCE_RECORDER) result = await exportWebCodecs(duration, dims[0], dims[1]);
      else setProgress(0.02, '녹화 방식으로 저장 중…');
    } catch (e) {
      console.warn('webcodecs export failed', e);
      result = null;
    }
    if (!result) {
      setProgress(0.02, '이 브라우저 방식으로 저장 중…');
      result = await exportRecorder(duration);
    }
    if (!result || !result.blob || result.blob.size < 1000) throw new Error('저장 파일을 만들지 못했습니다');

    const name = `숏폼영상-${stamp()}.${result.ext}`;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    const dl = $('#exportDownload');
    dl.href = url; dl.download = name; dl.hidden = false;

    const mb = (result.blob.size / 1048576).toFixed(1);
    let msg = `저장 완료 · ${name} (${mb}MB)`;
    if (result.note === 'opus') msg += ' · 소리는 Opus로 들어갔습니다';
    if (result.note === 'webm') msg += ' · WebM 형식';
    setProgress(1, msg);
    if (result.ext === 'webm') {
      toast('저장 완료(.webm). MP4가 필요하면 크롬·엣지·사파리 최신에서 다시 저장해 주세요.', 5200);
    } else if (result.note === 'opus') {
      toast('MP4로 저장했습니다. (이 브라우저는 AAC 대신 Opus로 소리를 넣습니다)', 4800);
    } else {
      toast('MP4로 저장했습니다 · ' + mb + 'MB', 3600);
    }
    console.log('export', result.ext, result.note, result.blob.size, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  } catch (err) {
    console.error(err);
    setProgress(0, '저장 실패: ' + (err && err.message ? err.message : '알 수 없는 오류'));
    toast('저장에 실패했습니다. 화면을 켜 둔 채 다시 시도해 주세요.', 4200);
  } finally {
    state.exporting = false;
    hideExportUI();
    seekTo(0);
    try { if (wakeLock) wakeLock.release(); } catch (e) { }
  }
}

async function openExportModal() {
  if (!state.clips.length) { toast('먼저 사진이나 영상을 올려 주세요'); return; }
  const dur = totalDuration();
  syncSizeOptions();
  const v = parseInt($('#expSize').value, 10) || 0;
  const dims = state.aspect === 'portrait'
    ? (v === 720 ? [720, 1280] : [1080, 1920])
    : (v === 1280 ? [1280, 720] : [1920, 1080]);
  $('#expInfo').innerHTML = `길이 <b>${fmtShort(dur)}</b> · 저장에 약 <b>${Math.ceil(dur)}초</b> 걸립니다.`;
  $('#exportModal').hidden = false;
  let cap = '확인 중…';
  try {
    const codec = await pickAvcCodec(dims[0], dims[1]);
    const au = await pickAudioCodec();
    if (codec && au === 'mp4a.40.2') cap = '<b>MP4 (H.264 + AAC)</b> — 가장 호환성 좋은 형식으로 저장됩니다';
    else if (codec && au) cap = '<b>MP4 (H.264 + Opus)</b> — 영상은 MP4, 소리는 Opus로 저장됩니다';
    else if (codec) cap = hasAnyAudio() ? '<b>MP4 (H.264)</b> — 소리는 녹화 방식으로 함께 넣습니다' : '<b>MP4 (H.264)</b> — 소리 없음';
    else if (window.MediaRecorder) cap = '<b>녹화 방식</b> — 브라우저에 따라 MP4 또는 WebM으로 저장됩니다';
    else cap = '이 브라우저는 영상 저장을 지원하지 않습니다';
  } catch (e) { cap = '저장 방식을 확인하지 못했습니다'; }
  $('#expInfo').innerHTML = `길이 <b>${fmtShort(dur)}</b> · ${dims[0]}×${dims[1]} · 약 <b>${Math.ceil(dur)}초</b><br>${cap}`;
}

/* ---------------------------------------------------------
   14. 탭 · 모달 · 초기화
   --------------------------------------------------------- */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('on', p.dataset.panel === name));
}

function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    switchTab(b.dataset.tab);
  });
}

function initEvents() {
  /* 파일 추가 */
  $('#btnAdd').addEventListener('click', () => $('#fileMedia').click());
  $('#fileMedia').addEventListener('change', async (e) => {
    await addFiles(e.target.files);
    e.target.value = '';
  });

  /* 재생 */
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#scrub').addEventListener('input', (e) => {
    const dur = totalDuration();
    seekTo((parseInt(e.target.value, 10) / 1000) * dur);
  });
  $('#btnExport').addEventListener('click', openExportModal);
  $('#btnDoExport').addEventListener('click', doExport);
  $('#expSize').addEventListener('change', openExportModal);

  /* 타임라인 */
  $('#btnSplit').addEventListener('click', splitClip);
  $('#btnMoveL').addEventListener('click', () => moveClip(-1));
  $('#btnMoveR').addEventListener('click', () => moveClip(1));
  $('#btnDelClip').addEventListener('click', deleteClip);
  $('#clipIn').addEventListener('input', (e) => {
    const c = state.clips.find(x => x.id === state.selClipId);
    if (!c || c.kind !== 'video') return;
    const v = clamp(parseFloat(e.target.value) || 0, 0, Math.max(0, c.srcDuration - 0.3));
    c.inPoint = v;
    c.duration = Math.min(c.duration, Math.max(0.3, c.srcDuration - v));
    $('#clipLen').value = c.duration.toFixed(1);
    renderStrip(); render();
  });
  $('#clipLen').addEventListener('input', (e) => {
    const c = state.clips.find(x => x.id === state.selClipId);
    if (!c) return;
    let v = parseFloat(e.target.value) || 0.3;
    v = clamp(v, 0.3, c.kind === 'video' ? Math.max(0.3, c.srcDuration - c.inPoint) : 60);
    c.duration = v;
    renderStrip(); render();
  });

  /* 자막 */
  $('#btnAddSub').addEventListener('click', () => addTextItem('sub'));
  $('#subText').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    it.text = e.target.value; render(); renderSubList();
  });
  $('#subStart').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    const v = Math.max(0, parseFloat(e.target.value) || 0);
    it.start = Math.min(v, it.end - 0.2); render(); renderSubList(); $('#subStart').value = it.start.toFixed(1);
  });
  $('#subEnd').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    const v = Math.max(0, parseFloat(e.target.value) || 0);
    it.end = Math.max(v, it.start + 0.2); render(); renderSubList(); $('#subEnd').value = it.end.toFixed(1);
  });
  $('#subStartNow').addEventListener('click', () => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    it.start = Math.min(state.t, it.end - 0.2); if (it.start < 0) it.start = 0;
    syncSubEditor(); renderSubList(); render();
  });
  $('#subEndNow').addEventListener('click', () => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    it.end = Math.max(state.t, it.start + 0.2);
    syncSubEditor(); renderSubList(); render();
  });
  $('#subLen3').addEventListener('click', () => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    it.end = it.start + 3;
    syncSubEditor(); renderSubList(); render();
  });
  $('#subSize').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    it.size = parseInt(e.target.value, 10) / MS();
    $('#subSizeVal').textContent = e.target.value + 'px';
    render();
  });
  $('#subX').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    it.x = parseInt(e.target.value, 10) / 100;
    $('#subXVal').textContent = e.target.value + '%';
    render();
  });
  $('#subY').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    it.y = parseInt(e.target.value, 10) / 100;
    $('#subYVal').textContent = e.target.value + '%';
    render();
  });
  $$('[data-subpos]').forEach(b => b.addEventListener('click', () => {
    const it = selectedItem(); if (!it || it.kind !== 'sub') return;
    const p = b.dataset.subpos;
    it.y = p === 'top' ? 0.16 : p === 'mid' ? 0.5 : p === 'low' ? 0.78 : 0.72;
    syncSubEditor(); render();
  }));
  $('#btnDupSub').addEventListener('click', () => { if (state.selId) duplicateItem(state.selId); });
  $('#btnDelSub').addEventListener('click', () => { if (state.selId) deleteItem(state.selId); });

  /* 타이틀 */
  $('#btnAddTitle').addEventListener('click', () => addTextItem('title'));
  $('#ttlText').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    it.text = e.target.value; render(); renderTitleList();
  });
  $('#ttlStart').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    it.start = Math.max(0, Math.min(parseFloat(e.target.value) || 0, it.end - 0.2));
    render(); renderTitleList(); $('#ttlStart').value = it.start.toFixed(1);
  });
  $('#ttlEnd').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    it.end = Math.max(parseFloat(e.target.value) || 0, it.start + 0.2);
    render(); renderTitleList(); $('#ttlEnd').value = it.end.toFixed(1);
  });
  $('#ttlSize').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    it.size = parseInt(e.target.value, 10) / MS();
    $('#ttlSizeVal').textContent = e.target.value + 'px';
    render();
  });
  $('#ttlY').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    it.y = parseInt(e.target.value, 10) / 100;
    $('#ttlYVal').textContent = e.target.value + '%';
    render();
  });
  $('#ttlColor').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    it.color = e.target.value; $('#ttlHex').value = e.target.value; render();
  });
  $('#ttlHex').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    if (/^#[0-9a-f]{6}$/i.test(e.target.value)) { it.color = e.target.value; $('#ttlColor').value = e.target.value; render(); }
  });
  $('#ttlAlign').addEventListener('change', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'title') return;
    it.align = e.target.value; render();
  });
  $('#btnDupTtl').addEventListener('click', () => { if (state.selId) duplicateItem(state.selId); });
  $('#btnDelTtl').addEventListener('click', () => { if (state.selId) deleteItem(state.selId); });

  /* 스티커 */
  $('#btnAddSticker').addEventListener('click', () => $('#fileSticker').click());
  $('#fileSticker').addEventListener('change', async (e) => {
    await addStickerFiles(e.target.files);
    e.target.value = '';
  });
  $('#stkSize').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'stk') return;
    it.w = parseInt(e.target.value, 10) / 100;
    $('#stkSizeVal').textContent = e.target.value + '%'; render();
  });
  $('#stkRot').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'stk') return;
    it.rot = parseInt(e.target.value, 10);
    $('#stkRotVal').textContent = e.target.value + '°'; render();
  });
  $('#stkOpacity').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'stk') return;
    it.opacity = parseInt(e.target.value, 10) / 100;
    $('#stkOpVal').textContent = e.target.value + '%'; render();
  });
  $('#stkStart').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'stk') return;
    it.start = Math.max(0, Math.min(parseFloat(e.target.value) || 0, it.end - 0.2));
    render(); renderStickerList();
  });
  $('#stkEnd').addEventListener('input', (e) => {
    const it = selectedItem(); if (!it || it.kind !== 'stk') return;
    it.end = Math.max(parseFloat(e.target.value) || 0, it.start + 0.2);
    render(); renderStickerList();
  });
  $('#btnStkFront').addEventListener('click', () => {
    const it = selectedItem(); if (!it || it.kind !== 'stk') return;
    state.items = state.items.filter(x => x.id !== it.id); state.items.push(it);
    render();
  });
  $('#btnStkBack').addEventListener('click', () => {
    const it = selectedItem(); if (!it || it.kind !== 'stk') return;
    state.items = state.items.filter(x => x.id !== it.id); state.items.unshift(it);
    render();
  });
  $('#btnDupStk').addEventListener('click', () => { if (state.selId) duplicateItem(state.selId); });
  $('#btnDelStk').addEventListener('click', () => { if (state.selId) deleteItem(state.selId); });

  /* 스타일 */
  $('#fontSel').addEventListener('change', (e) => {
    const f = e.target.value;
    document.fonts.load(`900 100px ${f}`).catch(() => { });
    applyStyle(it => { it.font = f; });
    const sel = selectedItem();
    $('#fontPreview').style.fontFamily = sel && sel.kind !== 'stk' ? sel.font : state.defSt.font;
  });
  $('#weightSel').addEventListener('change', (e) => applyStyle(it => { it.weight = parseInt(e.target.value, 10); }));
  $('#alignSel').addEventListener('change', (e) => applyStyle(it => { it.align = e.target.value; }));
  colorPair('#colorSel', '#colorHex', (v) => applyStyle(it => { it.color = v; }));
  colorPair('#strokeColor', '#strokeHex', (v) => applyStyle(it => { it.strokeColor = v; }));
  colorPair('#bgColor', '#bgHex', (v) => applyStyle(it => { it.bgColor = v; }));
  $('#strokeW').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) / 100;
    $('#strokeVal').textContent = e.target.value + '%';
    applyStyle(it => { it.strokeW = v; });
  });
  $('#shadowOn').addEventListener('change', (e) => applyStyle(it => { it.shadow = e.target.checked; }));
  $('#bgAlpha').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) / 100;
    $('#bgAlphaVal').textContent = e.target.value + '%';
    applyStyle(it => { it.bgAlpha = v; });
  });
  $('#bgRadius').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) / 50;
    $('#bgRadVal').textContent = e.target.value;
    applyStyle(it => { it.bgRadius = v; });
  });
  $('#lineHeight').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) / 100;
    $('#lineHeightVal').textContent = v.toFixed(2);
    applyStyle(it => { it.lineHeight = v; });
  });
  $('#letterSp').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('#letterSpVal').textContent = v + 'px';
    applyStyle(it => { it.letterSp = v; });
  });
  $('#btnApplyAllSub').addEventListener('click', () => {
    const src = (selectedItem() && selectedItem().kind === 'sub') ? selectedItem() : state.defSt;
    state.items.filter(i => i.kind === 'sub').forEach(it => STYLE_KEYS.forEach(k => { if (src[k] !== undefined) it[k] = src[k]; }));
    render(); toast('모든 자막에 적용했습니다');
  });
  $('#btnApplyAllTitle').addEventListener('click', () => {
    const src = (selectedItem() && selectedItem().kind === 'title') ? selectedItem() : state.defSt;
    state.items.filter(i => i.kind === 'title').forEach(it => STYLE_KEYS.forEach(k => { if (src[k] !== undefined) it[k] = src[k]; }));
    render(); toast('모든 타이틀에 적용했습니다');
  });
  $$('.preset').forEach(b => b.addEventListener('click', () => {
    const p = b.dataset.preset;
    applyStyle(it => {
      if (p === 'clean') { it.color = '#ffffff'; it.strokeW = 0.14; it.strokeColor = '#000000'; it.shadow = true; it.bgAlpha = 0; it.weight = 900; }
      if (p === 'bold') { it.color = '#ffe14d'; it.strokeW = 0.2; it.strokeColor = '#1a1208'; it.shadow = true; it.bgAlpha = 0; it.weight = 900; }
      if (p === 'box') { it.color = '#ffffff'; it.strokeW = 0; it.bgAlpha = 0.78; it.bgColor = '#000000'; it.shadow = false; it.weight = 700; }
      if (p === 'mint') { it.color = '#eafff4'; it.strokeW = 0.1; it.strokeColor = '#0d3b2b'; it.bgAlpha = 0.55; it.bgColor = '#0d3b2b'; it.shadow = false; }
    });
    syncStylePanel();
    toast('스타일을 적용했습니다');
  }));

  /* 오디오 */
  $('#srcMute').addEventListener('change', (e) => {
    state.srcMute = e.target.checked;
    if (state.playing) { stopAllSources(); liveSources = scheduleAudio(ac, masterGain, ac.currentTime + 0.03, state.t); }
  });
  $('#srcVol').addEventListener('input', (e) => {
    state.srcVolume = parseInt(e.target.value, 10) / 100;
    $('#srcVolVal').textContent = e.target.value + '%';
    if (state.playing) { stopAllSources(); liveSources = scheduleAudio(ac, masterGain, ac.currentTime + 0.03, state.t); }
  });
  $('#btnAddBgm').addEventListener('click', () => $('#fileBgm').click());
  $('#fileBgm').addEventListener('change', async (e) => { await addAudioFiles(e.target.files, 'bgm'); e.target.value = ''; });
  $('#btnAddVoice').addEventListener('click', () => $('#fileVoice').click());
  $('#fileVoice').addEventListener('change', async (e) => { await addAudioFiles(e.target.files, 'voice'); e.target.value = ''; });

  /* 녹음 */
  $('#btnRec').addEventListener('click', startRecording);
  $('#btnRecStop').addEventListener('click', stopRecording);
  $('#btnRecCancel').addEventListener('click', () => {
    if (!recObj) return;
    const r = recObj;
    try { r.mr.onstop = null; r.mr.stop(); } catch (e) { }
    r.stream.getTracks().forEach(t => t.stop());
    hideRecUI();
    recMessage('녹음을 취소했습니다.');
    toast('녹음을 버렸습니다');
  });
  $('#btnRecPreview').addEventListener('click', () => {
    if (!lastRecUrl) return;
    const a = new Audio(lastRecUrl);
    a.play().catch(() => toast('미리듣기를 열 수 없습니다'));
  });

  /* 미리듣기 */
  $('#btnSpeak').addEventListener('click', speakPreview);
  $('#btnSpeakStop').addEventListener('click', () => { try { speechSynthesis.cancel(); } catch (e) { } });
  $('#speakRate').addEventListener('input', (e) => { $('#speakRateVal').textContent = (parseInt(e.target.value, 10) / 100).toFixed(1); });
  if ('speechSynthesis' in window) {
    loadVoices();
    try { speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch (e) { }
  }

  /* 안전영역 */
  $('#guideChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    state.guide = b.dataset.guide;
    $$('#guideChips .chip').forEach(c => c.classList.toggle('on', c === b));
    renderGuides();
  });

  /* 화면 비율 */
  $('#aspectChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (state.exporting) { toast('저장 중에는 비율을 바꿀 수 없습니다'); return; }
    if (state.playing) pause();
    setAspect(b.dataset.aspect);
  });

  /* 글 → 자동 자막 */
  $$('.js-auto').forEach(b => b.addEventListener('click', openAutoModal));
  $('#btnAutoApply').addEventListener('click', applyAuto);
  ['#autoBody', '#autoTitleIn', '#autoCount', '#autoLen'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', scheduleAutoPreview);
    el.addEventListener('change', scheduleAutoPreview);
  });

  /* 도움말 */
  $('#btnHelp').addEventListener('click', () => { $('#helpModal').hidden = false; });
  $$('[data-close]').forEach(el => el.addEventListener('click', (e) => {
    const m = e.target.closest('.modal'); if (m) m.hidden = true;
  }));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selId) { e.preventDefault(); deleteItem(state.selId); }
  });

  /* 드래그앤드롭 */
  ['dragover', 'drop'].forEach(ev => document.addEventListener(ev, (e) => e.preventDefault()));
  $('#stageBox').addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      const media = Array.from(files).filter(f => f.type.startsWith('video/') || f.type.startsWith('image/'));
      if (media.length) await addFiles(media);
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) pause(); });
}

function colorPair(colorSel, hexSel, cb) {
  const c = $(colorSel), h = $(hexSel);
  c.addEventListener('input', (e) => { h.value = e.target.value; cb(e.target.value); });
  h.addEventListener('input', (e) => {
    if (/^#[0-9a-f]{6}$/i.test(e.target.value)) { c.value = e.target.value; cb(e.target.value); }
  });
}

async function addStickerFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  showBusy('스티커를 읽는 중…');
  for (const f of list) {
    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => waitEvent(img, 'load', 10000));
      const item = { id: uid(), name: f.name.replace(/\.[^.]+$/, ''), img, url };
      state.stickerLib.push(item);
      renderStickerGallery();
      addStickerInstance(item);
    } catch (e) { console.warn('sticker fail', f.name, e); }
  }
  hideBusy();
  toast('스티커를 올렸습니다 · 화면에서 끌어 옮기세요');
}

/* ---------------------------------------------------------
   15. 시작
   --------------------------------------------------------- */
let inited = false;
function init() {
  if (inited) return;
  inited = true;
  initTabs();
  initEvents();
  setAspect(state.aspect, true);
  renderGuides();
  renderStrip();
  renderAudioLists();
  syncStylePanel();
  render();
  // 기본 폰트 미리 로드
  try { document.fonts.load('900 100px "Noto Sans KR"').catch(() => { }); } catch (e) { }
  // 서비스 워커·외부 전송 없음
  window.__VS = { state, render, totalDuration, seekTo, setAspect, applyAuto, computeAutoSegments, autoUnits, addItemForTest: addTextItem }; // 디버그용
}

document.addEventListener('DOMContentLoaded', init);
if (document.readyState === 'interactive' || document.readyState === 'complete') init();

})();
