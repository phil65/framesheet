// framesheet in-page video player. Evaluated in a minimal wrapper page; exposes
// window.__framesheetVideo. Shared by both implementations: the Python package loads this
// file as package data and the npm package (js/) embeds a byte-identical copy at build time.
//
// Every frame is drawn into one <canvas> that fills the viewport (object-fit: contain on
// black), so a screenshot shows exactly the decoded frame:
// - <video> (mp4/webm/mov/mkv): muted and paused; seek() sets currentTime, awaits `seeked`
//   and the next presented frame (requestVideoFrameCallback), then draws the video.
// - Animated images (gif/webp): ImageDecoder (WebCodecs) decodes the frame whose
//   [timestamp, timestamp + duration) contains t; no <img> timing is involved.
(() => {
  if (window.__framesheetVideo) return;

  const FRAME_TIMEOUT_MS = 2000;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;display:block";
  document.documentElement.style.cssText = "margin:0;background:#000;overflow:hidden";
  document.body.style.cssText = "margin:0;background:#000;overflow:hidden";
  document.body.appendChild(canvas);
  const state = { decoder: null, video: null, image: null, frames: [], width: 0, height: 0 };

  function once(target, ok, fail) {
    return new Promise((resolve, reject) => {
      const done = (ev) => {
        target.removeEventListener(ok, done);
        if (fail) target.removeEventListener(fail, failed);
        resolve(ev);
      };
      const failed = () => {
        target.removeEventListener(ok, done);
        target.removeEventListener(fail, failed);
        const err = target.error;
        reject(new Error(`media error ${err ? err.code : "?"}: ${err && err.message ? err.message : "cannot decode"}`));
      };
      target.addEventListener(ok, done);
      if (fail) target.addEventListener(fail, failed);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Two animation frames: the drawn canvas has reached the compositor before a screenshot.
  function painted() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // Where the frame sits in the viewport (CSS px, whole device pixels).
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    const s = Math.min(W / state.width, H / state.height);
    const w = Math.round(state.width * s);
    const h = Math.round(state.height * s);
    const x = Math.floor((W - w) / 2);
    const y = Math.floor((H - h) / 2);
    return { dpr, W, H, x, y, w, h };
  }

  function contentBox() {
    const l = layout();
    const r = (v) => Math.round((v / l.dpr) * 100) / 100;
    return [r(l.x), r(l.y), r(l.w), r(l.h)];
  }

  function draw(source) {
    const l = layout();
    if (canvas.width !== l.W) canvas.width = l.W;
    if (canvas.height !== l.H) canvas.height = l.H;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, l.W, l.H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, l.x, l.y, l.w, l.h);
  }

  async function loadVideo(src) {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.style.display = "none";
    const loaded = once(v, "loadeddata", "error");
    v.src = src;
    document.body.appendChild(v);
    await loaded;
    let duration = v.duration;
    if (!Number.isFinite(duration)) {
      // MediaRecorder-style WebM without a duration: seeking far ahead makes it known.
      const changed = once(v, "seeked", "error");
      v.currentTime = 1e101;
      await changed;
      duration = v.duration;
    }
    state.video = v;
    state.width = v.videoWidth;
    state.height = v.videoHeight;
    return {
      decoder: "video",
      duration: Number.isFinite(duration) ? duration : null,
      width: v.videoWidth,
      height: v.videoHeight,
      frame_count: null,
      fps: null,
    };
  }

  async function loadImage(src, type) {
    if (typeof ImageDecoder === "undefined") {
      throw new Error("ImageDecoder (WebCodecs) is not available in this browser: animated images need Chromium >= 94");
    }
    const data = await (await fetch(src)).arrayBuffer();
    const decoder = new ImageDecoder({ data, type });
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const frames = [];
    let width = 0;
    let height = 0;
    for (let i = 0; i < track.frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      frames.push([image.timestamp / 1e6, (image.duration || 0) / 1e6]);
      width = image.displayWidth;
      height = image.displayHeight;
      image.close();
    }
    state.decoder = decoder;
    state.frames = frames;
    state.width = width;
    state.height = height;
    const last = frames[frames.length - 1];
    const duration = last ? last[0] + last[1] : 0;
    return {
      decoder: "image-decoder",
      duration,
      width,
      height,
      frame_count: frames.length,
      fps: duration > 0 ? Math.round((frames.length / duration) * 1000) / 1000 : null,
    };
  }

  async function load(src, decoder, type) {
    const info = decoder === "image-decoder" ? await loadImage(src, type) : await loadVideo(src);
    if (!state.width || !state.height) throw new Error("media has no video frames");
    return info;
  }

  // Seek to t (seconds), draw the frame, return its media time (seconds).
  async function seek(t) {
    if (state.decoder) {
      const frames = state.frames;
      let index = 0;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i][0] <= t + 1e-9) index = i;
        else break;
      }
      const { image } = await state.decoder.decode({ frameIndex: index });
      draw(image);
      image.close();
      await painted();
      return frames[index][0];
    }
    const v = state.video;
    const presented = typeof v.requestVideoFrameCallback === "function"
      ? new Promise((resolve) => v.requestVideoFrameCallback((now, meta) => resolve(meta.mediaTime)))
      : null;
    const seeked = once(v, "seeked", "error");
    v.currentTime = t;
    await seeked;
    let mediaTime = null;
    if (presented) mediaTime = await Promise.race([presented, sleep(FRAME_TIMEOUT_MS).then(() => null)]);
    draw(v);
    await painted();
    return mediaTime;
  }

  window.__framesheetVideo = { load, seek, contentBox };
})();
