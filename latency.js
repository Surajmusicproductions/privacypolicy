// latency.js
// Latency utilities for the looper.
// Exports: latency.init(audioCtx, micStreamOptional), latency.measureOnce(), latency.startAutoMonitor(), latency.getLatencyMs(), latency.alignFloat32(buf), latency.analyzeWithModel(bufferOrArray)
// Usage: include before script.js, call latency.init(audioCtx, micStream) after ensureMic() resolves.

const latency = (() => {
  let audioCtx = null;
  let micStream = null;       // MediaStream from getUserMedia (optional; will prompt if missing)
  let micSource = null;       // MediaStreamAudioSourceNode
  let processedDestination = null; // optional processed stream destination if you want to record post-fx
  let lastEstimates = [];     // circular buffer of recent ms estimates
  const maxHistory = 7;
  let measuring = false;

  // config
  const DEFAULT_CLICK_MS = 6;
  const DEFAULT_RECORD_SEC = 1.0;
  const MAX_SEARCH_SEC = 1.0;

  function init(ctx, optMicStream=null, optProcessedDest=null) {
    audioCtx = ctx || (window.audioCtx || null);
    if (!audioCtx) throw new Error("audioCtx not provided to latency.init");
    micStream = optMicStream || (window.micStream || null);
    processedDestination = optProcessedDest || (window.mixDest || null);
    if (micStream && !micSource) {
      micSource = audioCtx.createMediaStreamSource(micStream);
    }
    return true;
  }

  // small helper: create click buffer
  function makeClickBuffer(clickMs = DEFAULT_CLICK_MS) {
    const sr = audioCtx.sampleRate;
    const len = Math.max(1, Math.floor(clickMs / 1000 * sr));
    const b = audioCtx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    // impulse + short banded tone so correlation is robust
    for (let i=0;i<len;i++) {
      const env = Math.exp(-i/(len*0.15));
      d[i] = (i === 0 ? 1.0 : 0.6 * Math.sin(2*Math.PI*180*i/sr)) * env;
    }
    return d; // Float32Array
  }

  // naive cross-correlation search (reference small => OK). returns bestLagSamples and correlation
  function findBestLag(ref, target, sr, maxLagSec = MAX_SEARCH_SEC) {
    const maxLag = Math.min(Math.floor(maxLagSec*sr), Math.max(0, target.length - ref.length));
    let bestCorr = -Infinity;
    let bestLag = 0;
    // precompute ref energy
    let refEnergy = 0;
    for (let i=0;i<ref.length;i++) refEnergy += ref[i]*ref[i];
    refEnergy = Math.sqrt(refEnergy) + 1e-9;
    for (let lag = 0; lag <= maxLag; lag++) {
      let dot = 0;
      let targEnergy = 0;
      for (let i=0;i<ref.length;i++) {
        const a = ref[i];
        const b = target[lag + i] || 0;
        dot += a * b;
        targEnergy += b*b;
      }
      const norm = refEnergy * Math.sqrt(targEnergy + 1e-9);
      const corr = (norm > 0) ? (dot / norm) : 0;
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    return { bestLag, bestCorr, maxLag };
  }

  // assemble Float32 from Float32Array chunks (similar to your recorder logic)
  function concatChunks(chunks) {
    const total = chunks.reduce((s,c)=>s + (c.length||0), 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // measure once: plays click and records mic for `recordSec`. returns object {latencyMs, corr, sampleRate}
  async function measureOnce({clickMs = DEFAULT_CLICK_MS, recordSec = DEFAULT_RECORD_SEC} = {}) {
    if (!audioCtx) init(window.audioCtx || null, window.micStream || null, window.mixDest || null);
    if (!audioCtx) throw new Error("audioCtx not initialized: call latency.init(audioCtx, micStream)");

    // ensure mic
    if (!micStream) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }});
        micSource = audioCtx.createMediaStreamSource(micStream);
      } catch (e) {
        throw new Error("Mic access failed: " + e.message);
      }
    }

    // create click data
    const sr = audioCtx.sampleRate;
    const clickRef = makeClickBuffer(clickMs);

    // create a buffer source to play the click to the destination (speakers)
    const clickBuf = audioCtx.createBuffer(1, clickRef.length, sr);
    clickBuf.copyToChannel(clickRef, 0, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = clickBuf;
    src.loop = false;

    // capture mic into ScriptProcessor or Worklet capture depending on availability
    const chunks = [];
    const bufferSize = 4096;
    let proc = null;
    // prefer AudioWorklet if available and the page uses recorder-processor — but for portability use ScriptProcessor here
    try {
      proc = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      micSource.connect(proc);
      // don't route processor to destination (silent)
      proc.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
      };
    } catch (e) {
      // if ScriptProcessor unavailable, fallback to MediaRecorder on processedDestination (if available)
      if (processedDestination && processedDestination.stream) {
        return await measureViaMediaRecorder(clickRef, clickMs, recordSec);
      } else {
        throw new Error("Unable to create recorder node for latency measurement: " + e.message);
      }
    }

    // schedule start slightly in future to avoid race
    const playTime = audioCtx.currentTime + 0.05;
    src.connect(audioCtx.destination);
    src.start(playTime);

    // allow recordSec (plus small safety) then stop
    await new Promise(res => setTimeout(res, Math.round((recordSec + 0.12) * 1000)));

    // cleanup
    try { proc.disconnect(); micSource.disconnect(proc); } catch(e) {}
    try { src.stop(); src.disconnect(); } catch(e) {}

    const rec = concatChunks(chunks);
    const {bestLag, bestCorr} = findBestLag(clickRef, rec, sr, Math.min(MAX_SEARCH_SEC, recordSec));
    const latencySeconds = bestLag / sr;
    const latencyMs = latencySeconds * 1000;

    // store median-ish
    lastEstimates.push(latencyMs);
    if (lastEstimates.length > maxHistory) lastEstimates.shift();

    return { latencyMs, correlation: bestCorr, sampleRate: sr, rawLagSamples: bestLag };
  }

  // fallback measurement using MediaRecorder if ScriptProcessor not available
  async function measureViaMediaRecorder(clickRef, clickMs, recordSec) {
    // connect click to destination
    const sr = audioCtx.sampleRate;
    const clickBuf = audioCtx.createBuffer(1, clickRef.length, sr);
    clickBuf.copyToChannel(clickRef, 0, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = clickBuf;
    src.loop = false;
    src.connect(audioCtx.destination);

    // record processedDestination.stream (should include mic via your graph)
    if (!processedDestination || !processedDestination.stream) throw new Error("processedDestination.stream required for MediaRecorder fallback");

    const mr = new MediaRecorder(processedDestination.stream);
    const blobs = [];
    mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) blobs.push(ev.data); };
    mr.start();

    const playTime = audioCtx.currentTime + 0.05;
    src.start(playTime);
    await new Promise(r => setTimeout(r, Math.round((recordSec + 0.15) * 1000)));
    mr.stop();

    const arrBuf = await new Promise((resolve, reject) => {
      mr.onstop = async () => {
        try {
          const blob = new Blob(blobs, { type: blobs[0]?.type || 'audio/webm' });
          const ab = await blob.arrayBuffer();
          resolve(ab);
        } catch (e) { reject(e); }
      };
    });

    const decoded = await audioCtx.decodeAudioData(arrBuf);
    const rec = decoded.getChannelData(0);
    const {bestLag, bestCorr} = findBestLag(clickRef, rec, sr, Math.min(MAX_SEARCH_SEC, recordSec));
    const latencySeconds = bestLag / sr;
    const latencyMs = latencySeconds * 1000;
    lastEstimates.push(latencyMs);
    if (lastEstimates.length > maxHistory) lastEstimates.shift();
    return { latencyMs, correlation: bestCorr, sampleRate: sr, rawLagSamples: bestLag };
  }

  function getLatencyMs() {
    if (lastEstimates.length === 0) return null;
    // return median to avoid jitter
    const sorted = lastEstimates.slice().sort((a,b)=>a-b);
    const mid = Math.floor(sorted.length / 2);
    return (sorted.length % 2 === 1) ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
  }

  // Shift/align Float32Array by measured latency (trim head by latencySamples)
  function alignFloat32(floatArray) {
    const latMs = getLatencyMs();
    if (!latMs || latMs <= 1) return floatArray; // nothing to do
    const sr = (audioCtx && audioCtx.sampleRate) ? audioCtx.sampleRate : (44100);
    const latencySamples = Math.round((latMs / 1000) * sr);
    if (latencySamples <= 0) return floatArray;
    if (latencySamples >= floatArray.length) return new Float32Array(0);
    // create subarray that removes initial latencySamples
    // optionally add small crossfade at boundaries in host code
    return floatArray.subarray(latencySamples);
  }

  // Simple auto monitor: repeatedly measure every X ms and update history
  async function startAutoMonitor({intervalMs=8000, durationSec=0.9} = {}) {
    if (measuring) return;
    measuring = true;
    try {
      while (measuring) {
        try {
          await measureOnce({recordSec: durationSec});
        } catch(e) {
          console.warn('latency monitor measure failed', e);
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    } finally {
      measuring = false;
    }
  }
  function stopAutoMonitor() { measuring = false; }

  // Placeholder: if you add a TFJS onset model, call analyzeWithModel(audioBufferOrFloat32)
  // This function checks for global `tf` and a loaded model at latency.model
  async function analyzeWithModel(bufferOrArray) {
    if (typeof tf === 'undefined') {
      throw new Error("TensorFlow.js not found. Include TFJS to use model analysis.");
    }
    if (!latency.model) {
      throw new Error("No model loaded. Set latency.model to a tf.Model (tfjs) before calling analyzeWithModel.");
    }
    // Convert to mono Float32Array
    let arr;
    if (bufferOrArray instanceof AudioBuffer) {
      arr = bufferOrArray.getChannelData(0);
    } else if (Array.isArray(bufferOrArray) || bufferOrArray instanceof Float32Array) {
      arr = (bufferOrArray instanceof Float32Array) ? bufferOrArray : concatChunks(bufferOrArray);
    } else {
      throw new Error("Unsupported buffer type for analyzeWithModel");
    }
    // Example: compute mel-spectrogram / log-mel externally or inside tf model.
    // The model should accept a 2D or 3D tensor and return desired outputs.
    // User/Dev: implement normalization & framing consistent with training.
    const inputTensor = tf.tensor(arr).expandDims(0).expandDims(-1); // shape [1, N, 1]
    const out = await latency.model.predict(inputTensor);
    return out;
  }

  // quick helper to set a TFJS model into this namespace
  function setModel(m) { latency.model = m; }

  // expose public API
  return {
    init,
    measureOnce,
    startAutoMonitor,
    stopAutoMonitor,
    getLatencyMs,
    alignFloat32,
    analyzeWithModel,
    setModel
  };
})();

// export for global access
if (typeof window !== 'undefined') window.latency = latency;
