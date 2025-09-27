// script.js (patched)
// Master audio context and global variables
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let micStream = null, micSource = null;
let dryGain = null, wetGain = null, convolver = null, delayNode = null, delayGain = null;
let mixDest = null, processedStream = null;
let reverbLevel = 0, delayTime = 0;
let masterLoopDuration = null, masterBPM = null, masterIsSet = false;

// HTML elements
const dividerSelectors = [
  null,
  null,
  document.getElementById('divider2'),
  document.getElementById('divider3'),
  document.getElementById('divider4'),
];
const bpmLabel = document.getElementById('bpmLabel');

// Flag: use AudioWorklet if available
let useWorklet = false;
if (audioCtx.audioWorklet) {
  // begin loading the module; useWorklet will be set on success
  audioCtx.audioWorklet.addModule('recorder-processor.js')
    .then(() => { useWorklet = true; console.log('AudioWorklet module loaded'); })
    .catch(err => { useWorklet = false; console.warn('AudioWorklet not available', err); });
}

// UI message helpers
function showMsg(msg, color = '#ff4444') {
  let el = document.getElementById('startMsg');
  if (!el) { el = document.createElement('div'); el.id = 'startMsg'; document.body.prepend(el); }
  el.innerHTML = msg;
  el.style.cssText = `
    display:block; color:${color}; background:#111a22cc;
    font-weight:bold; border-radius:12px; padding:12px 22px;
    position:fixed; left:50%; top:8%; transform:translate(-50%,0);
    z-index:1000; text-align:center;
  `;
}
function hideMsg() { const el = document.getElementById('startMsg'); if (el) el.style.display = 'none'; }

// Ensure mic + FX graph is ready
async function ensureMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showMsg("❌ Microphone not supported on this device/browser!");
    throw new Error("getUserMedia not supported.");
  }
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true
    }});
  } catch (e) {
    showMsg("❌ Microphone access denied!<br>Enable permission in app settings.", "#ff4444");
    throw e;
  }
  audioCtx.resume();
  micSource = audioCtx.createMediaStreamSource(micStream);

  // Delay + feedback nodes
  delayNode = audioCtx.createDelay(2.0);
  delayGain = audioCtx.createGain();
  delayNode.delayTime.value = 0;
  delayGain.gain.value = 0.5;
  micSource.connect(delayNode);
  delayNode.connect(delayGain);
  delayGain.connect(delayNode);

  // Reverb (convolver)
  convolver = audioCtx.createConvolver();
  convolver.buffer = createReverbImpulse(3.0, 2.0);
  convolver.normalize = true;
  delayNode.connect(convolver);

  // Dry/Wet gains
  dryGain = audioCtx.createGain();
  wetGain = audioCtx.createGain();
  dryGain.gain.value = 1;
  wetGain.gain.value = 0;
  micSource.connect(dryGain);
  convolver.connect(wetGain);

  // Destination stream (for MediaRecorder fallback)
  mixDest = audioCtx.createMediaStreamDestination();
  dryGain.connect(mixDest);
  wetGain.connect(mixDest);
  processedStream = mixDest.stream;

  hideMsg();
}

function createReverbImpulse(durationSeconds, decayFactor) {
  const sampleRate = audioCtx.sampleRate;
  const length = sampleRate * durationSeconds;
  const impulse = audioCtx.createBuffer(2, length, sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const buffer = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      buffer[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayFactor);
    }
  }
  return impulse;
}

// basic tap/hold helpers (touch-friendly)
function addTapHandler(btn, handler) {
  if (!btn) return;
  btn.addEventListener('click', handler);
  btn.addEventListener('touchstart', function(e) { e.preventDefault(); handler(e); }, { passive: false });
}
function addHoldHandler(btn, onStart, onEnd) {
  let hold = false;
  btn.addEventListener('mousedown', e => { hold = true; onStart(e); });
  btn.addEventListener('touchstart', e => { hold = true; onStart(e); }, { passive: false });
  btn.addEventListener('mouseup', e => { if (hold) onEnd(e); hold = false; });
  btn.addEventListener('mouseleave', e => { if (hold) onEnd(e); hold = false; });
  btn.addEventListener('touchend', e => { if (hold) onEnd(e); hold = false; }, { passive: false });
  btn.addEventListener('touchcancel', e => { if (hold) onEnd(e); hold = false; }, { passive: false });
}

// --- ADD MISSING addKnobDragHandler (copied from previous working version) ---
function addKnobDragHandler(knobElem, getValue, setValue, display, indicator, min=0, max=100, angleScale=2.7, units='%') {
  let dragging=false, startY=0, startValue=0;
  function dragStart(e) {
    e.preventDefault();
    dragging=true;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startValue = getValue();
    document.addEventListener('mousemove', dragMove);
    document.addEventListener('mouseup', dragEnd);
    document.addEventListener('touchmove', dragMove, { passive: false });
    document.addEventListener('touchend', dragEnd, { passive: false });
  }
  function dragMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    let newVal = Math.max(min, Math.min(max, Math.round(startValue + (startY - clientY))));
    setValue(newVal);
    if (display) display.textContent = newVal + units;
    if (indicator) indicator.style.transform = 'translateX(-50%) rotate(' + ((newVal - 50) * angleScale) + 'deg)';
  }
  function dragEnd(e) {
    dragging = false;
    document.removeEventListener('mousemove', dragMove);
    document.removeEventListener('mouseup', dragEnd);
    document.removeEventListener('touchmove', dragMove);
    document.removeEventListener('touchend', dragEnd);
  }
  if (!knobElem) return;
  knobElem.addEventListener('mousedown', dragStart);
  knobElem.addEventListener('touchstart', dragStart, { passive: false });
}

// ===== LOOPER CLASS (tracks) =====
class Looper {
  constructor(index, recordKey, stopKey) {
    this.index = index;
    this.recordKey = recordKey;
    this.stopKey = stopKey;

    // UI
    this.mainBtn = document.getElementById('mainLooperBtn' + index);
    this.stopBtn = document.getElementById('stopBtn' + index);
    this.looperIcon = document.getElementById('looperIcon' + index);
    this.ledRing = document.getElementById('progressBar' + index);
    this.stateDisplay = document.getElementById('stateDisplay' + index);

    // state & buffers
    this.state = 'ready';
    this.uiDisabled = false;
    this.loopBuffer = null;     // full mixed buffer for playback (AudioBuffer)
    this.baseBuffer = null;     // original recorded base AudioBuffer (AudioBuffer)
    this.overdubBuffers = [];   // array of Float32Array layers (for undo)
    this.loopDuration = 0;
    this.loopStartTime = 0;

    // recorder placeholders
    this.mediaRecorder = null;
    this.chunks = [];
    this.recorder = null;            // AudioWorkletNode (created lazily)
    this.recorderConnected = false;

    // config
    this.divider = (index >=2 && dividerSelectors[index]) ? parseFloat(dividerSelectors[index].value) : 1;
    if (index >= 2 && dividerSelectors[index]) {
      dividerSelectors[index].addEventListener('change', e => { this.divider = parseFloat(e.target.value); });
      this.setDisabled(true);
    }

    // UI events
    addTapHandler(this.mainBtn, async () => { await ensureMic(); await this.handleMainButton(); });
    addHoldHandler(this.stopBtn,
      () => { if (this.state === 'ready') return; this.holdTimer = setTimeout(()=>{ this.clearLoop(); this.holdTimer = null; }, 2000); },
      () => {
        if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer=null;
          if (this.state === 'playing' || this.state === 'overdub') this.stopPlayback();
          else if (this.state === 'stopped') this.resumePlayback();
        }
      });

    this.updateUI();
    this.setRingProgress(0);
  }

  setLED(color) {
    const colors = { green:'#22c55e', red:'#e11d48', orange:'#f59e0b', gray:'#6b7280' };
    this.ledRing.style.stroke = colors[color] || '#fff';
    this.ledRing.style.filter = (color === 'gray') ? 'none' : `drop-shadow(0 0 8px ${colors[color]}88)`;
  }
  setRingProgress(ratio) {
    const RADIUS = 42, CIRCUM = 2 * Math.PI * RADIUS;
    this.ledRing.style.strokeDasharray = CIRCUM;
    this.ledRing.style.strokeDashoffset = CIRCUM * (1 - ratio);
  }
  setIcon(symbol, color) { this.looperIcon.textContent = symbol; this.looperIcon.style.color = color || '#fff'; }
  setDisplay(text) { this.stateDisplay.textContent = text; }

  updateUI(){
    switch(this.state){
      case 'ready': this.setLED('green'); this.setRingProgress(0); this.setIcon('▶'); this.setDisplay('Ready'); break;
      case 'recording': this.setLED('red'); this.setIcon('⦿','#e11d48'); this.setDisplay('Recording...'); break;
      case 'playing': this.setLED('green'); this.setIcon('▶'); this.setDisplay('Playing'); break;
      case 'overdub': this.setLED('orange'); this.setIcon('⦿','#f59e0b'); this.setDisplay('Overdubbing'); break;
      case 'stopped': this.setLED('gray'); this.setRingProgress(0); this.setIcon('▶','#aaa'); this.setDisplay('Stopped'); break;
      case 'waiting': this.setLED('gray'); this.setRingProgress(0); this.setIcon('⏳','#aaa'); this.setDisplay('Waiting for sync...'); break;
    }
    if (this.uiDisabled) {
      this.mainBtn.disabled = true; this.stopBtn.disabled = true;
      this.mainBtn.classList.add('disabled-btn'); this.stopBtn.classList.add('disabled-btn');
      this.setDisplay('WAIT: Set Track 1');
    } else {
      this.mainBtn.disabled = false; this.stopBtn.disabled = false;
      this.mainBtn.classList.remove('disabled-btn'); this.stopBtn.classList.remove('disabled-btn');
    }
  }
  setDisabled(val){ this.uiDisabled = val; this.updateUI(); }

  async handleMainButton(){
    if (this.state === 'ready') await this.phaseLockedRecording();
    else if (this.state === 'recording') await this.stopRecordingAndPlay();
    else if (this.state === 'playing') this.armOverdub();
    else if (this.state === 'overdub') { /* already armed, will auto-stop after loop */ }
  }

  // Create AudioWorkletNode lazily and install message handler
  _ensureRecorderNode() {
    if (!useWorklet) return false;
    if (this.recorder) return true;
    try {
      this.recorder = new AudioWorkletNode(audioCtx, 'recorder-processor', { numberOfInputs:1, numberOfOutputs:0, channelCount:1 });
      // message handler: route dump responses according to current state (initial vs overdub)
      this.recorder.port.onmessage = (e) => {
        const data = e.data || {};
        if (data.cmd === 'dump') {
          // convert transferred channels to Float32Array (mono expected)
          const channels = data.channels || [];
          if (channels.length === 0) {
            // empty recording
            if (this.state === 'overdub' && this.baseBuffer) {
              this._finalizeOverdub(new Float32Array(0));
            } else {
              this._finalizeRecording(new Float32Array(0));
            }
          } else {
            let raw = channels[0];
            const firstFrame = data.firstBlockFrame || 0;
            const startedAtFrame = data.startedAtFrame || 0;
            const stoppedAtFrame = data.stoppedAtFrame || (startedAtFrame + raw.length);
            const startOffset = Math.max(0, startedAtFrame - firstFrame);
            const endOffset = raw.length - (stoppedAtFrame - firstFrame);
            const sliced = raw.slice(startOffset, endOffset);
            if (this.state === 'overdub' && this.baseBuffer) {
              this._finalizeOverdub(sliced);
            } else {
              this._finalizeRecording(sliced);
            }
          }
        }
      };
      this.recorderConnected = false;
      return true;
    } catch (err) {
      console.warn('Failed to create recorder node:', err);
      this.recorder = null;
      return false;
    }
  }

  // ===== Recording flow =====
  async phaseLockedRecording() {
    if (!processedStream) await ensureMic();
    if (this.index === 1 || !masterIsSet) {
      await this.startRecording();
      return;
    }
    const targetLen = masterLoopDuration * this.divider;
    this.state = 'waiting'; this.updateUI(); this.setDisplay('Waiting for sync...');
    const now = audioCtx.currentTime;
    const master = loopers[1];
    const masterElapsed = (now - master.loopStartTime) % masterLoopDuration;
    const timeToNext = masterLoopDuration - masterElapsed;
    setTimeout(async () => {
      await this.startRecording();
      setTimeout(()=> { if (this.state === 'recording') this.stopRecordingAndPlay(); }, targetLen * 1000 + 20);
    }, timeToNext * 1000);
  }

  async startRecording() {
    this.state = 'recording'; this.updateUI(); this.setRingProgress(0);
    this.chunks = [];

    // Try worklet path (create recorder node lazily)
    if (useWorklet) {
      const ok = this._ensureRecorderNode();
      if (ok) {
        // connect the mic FX graph into the recorder node (if not already)
        if (!this.recorderConnected) {
          try {
            dryGain.connect(this.recorder);
            wetGain.connect(this.recorder);
            this.recorderConnected = true;
          } catch(e) { console.warn('connect to recorder failed', e); }
        }
        // arm at current frame (record until stopAtFrame posted)
        const startFrame = Math.ceil(audioCtx.currentTime * audioCtx.sampleRate);
        this.recorder.port.postMessage({ cmd:'reset' });
        this.recorder.port.postMessage({ cmd:'armAtFrame', frame: startFrame });
        // we'll call stopAtFrame when user ends recording
        return;
      }
      // if recorder creation failed, fall back to MediaRecorder automatically
    }

    // Fallback MediaRecorder path (still works; less precise)
    this.mediaRecorder = new MediaRecorder(processedStream);
    this.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mediaRecorder.start();

    // progress visual (safety max)
    const startTime = Date.now();
    const maxTime = this.index >= 2 && masterLoopDuration ? masterLoopDuration * this.divider * 1000 : 12000;
    const animate = () => {
      if (this.state === 'recording') {
        const elapsed = (Date.now() - startTime) / maxTime;
        this.setRingProgress(Math.min(elapsed, 1));
        if (elapsed < 1) requestAnimationFrame(animate);
        else this.stopRecordingAndPlay();
      }
    };
    animate();
  }

  async stopRecordingAndPlay() {
    if (this.state !== 'recording') return;
    this.state = 'playing'; this.updateUI();

    if (useWorklet && this.recorder) {
      // stop at present frame and request dump
      const stopFrame = Math.ceil(audioCtx.currentTime * audioCtx.sampleRate);
      this.recorder.port.postMessage({ cmd:'stopAtFrame', frame: stopFrame });
      setTimeout(()=>{ try{ this.recorder.port.postMessage({ cmd:'dump' }); }catch(e){console.warn('dump err',e);} }, 20);
      // result handled via recorder.port.onmessage -> _finalizeRecording / _finalizeOverdub
      return;
    }

    // MediaRecorder fallback: stop and decode
    if (this.mediaRecorder) {
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        const arr = await blob.arrayBuffer();
        audioCtx.decodeAudioData(arr, (buffer) => {
          // base buffer set for initial recording
          this.baseBuffer = buffer;
          this.loopBuffer = buffer;
          this.loopDuration = buffer.duration;
          if (this.index === 1) {
            masterLoopDuration = this.loopDuration;
            masterBPM = Math.round(60 / masterLoopDuration * 4);
            masterIsSet = true;
            bpmLabel.textContent = `BPM: ${masterBPM}`;
            for (let k = 2; k <= 4; k++) loopers[k].setDisabled(false);
          }
          this.startPlayback(true);
        });
      };
      this.mediaRecorder.stop();
    }
  }

  // Called by worklet dump handler when this is a base recording (not overdub)
  _finalizeRecording(floatArray) {
    // floatArray is Float32Array PCM
    const length = floatArray.length || 0;
    const buff = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    if (length) buff.copyToChannel(floatArray, 0, 0);
    this.baseBuffer = buff;
    this.loopBuffer = buff;
    this.loopDuration = buff.duration;
    if (this.index === 1) {
      masterLoopDuration = this.loopDuration;
      masterBPM = Math.round(60 / masterLoopDuration * 4);
      masterIsSet = true;
      bpmLabel.textContent = `BPM: ${masterBPM}`;
      for (let k = 2; k <= 4; k++) loopers[k].setDisabled(false);
    }
    this.startPlayback(true);
  }

  startPlayback(resetPhase) {
    if (!this.loopBuffer) return;
    if (this.sourceNode) try{ this.sourceNode.stop(); } catch(e) {}
    this.sourceNode = audioCtx.createBufferSource();
    this.sourceNode.buffer = this.loopBuffer;
    this.sourceNode.loop = true;
    this.sourceNode.connect(audioCtx.destination);

    let offset = 0;
    if (this.index !== 1 && masterIsSet && loopers[1].sourceNode) {
      const masterNow = audioCtx.currentTime - loopers[1].loopStartTime;
      offset = masterNow % masterLoopDuration;
      if (offset < 0) offset = 0;
    }
    this.loopStartTime = audioCtx.currentTime - offset;
    this.sourceNode.start(0, offset);
    this.state = 'playing'; this.updateUI();
    this.animateProgress();
  }

  stopPlayback() { if (this.sourceNode) try{ this.sourceNode.stop(); }catch(e){}; this.state='stopped'; this.updateUI(); }
  resumePlayback(){ this.startPlayback(); }

  // === Overdub ===
  armOverdub() {
    if (this.state !== 'playing') return;
    this.state='overdub'; this.updateUI();
    const now = audioCtx.currentTime;
    const elapsed = (now - this.loopStartTime) % this.loopDuration;
    const delay = this.loopDuration - elapsed;
    setTimeout(()=> this.startOverdubRecording(), delay * 1000);
  }

  startOverdubRecording(){
    if (!this.loopBuffer) return;
    // ensure recorder exists if using worklet
    if (useWorklet) {
      const ok = this._ensureRecorderNode();
      if (ok) {
        if (!this.recorderConnected) {
          try { dryGain.connect(this.recorder); wetGain.connect(this.recorder); this.recorderConnected=true; }
          catch(e){ console.warn('connect recorder failed', e); }
        }
        const nowFrame = Math.ceil(audioCtx.currentTime * audioCtx.sampleRate);
        const loopFrames = Math.round(this.loopDuration * audioCtx.sampleRate);
        // compute when the next loop boundary will occur in frames
        const loopStartFrame = Math.round(this.loopStartTime * audioCtx.sampleRate);
        const elapsedFrames = (nowFrame - loopStartFrame) % loopFrames;
        const armFrame = nowFrame + (loopFrames - elapsedFrames);
        const stopFrame = armFrame + loopFrames;
        this.recorder.port.postMessage({ cmd:'reset' });
        this.recorder.port.postMessage({ cmd:'armAtFrame', frame: armFrame });
        this.recorder.port.postMessage({ cmd:'stopAtFrame', frame: stopFrame });
        // schedule dump after full loop (with tiny headroom)
        setTimeout(()=> { try{ this.recorder.port.postMessage({ cmd:'dump' }); } catch(e){ console.warn('dump err', e); } }, this.loopDuration * 1000 + 60);
        return;
      }
      // fall back to MediaRecorder below
    }

    // MediaRecorder fallback: record for exactly one loop duration
    this.overdubChunks = [];
    this.mediaRecorder = new MediaRecorder(processedStream);
    this.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) this.overdubChunks.push(e.data); };
    this.mediaRecorder.start();
    setTimeout(()=> this.finishOverdub(), this.loopDuration * 1000);
  }

  // MediaRecorder path completes overdub recording here
  async finishOverdub() {
    if (!this.mediaRecorder) return;
    if (this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.onstop = async () => {
        const odBlob = new Blob(this.overdubChunks, { type: 'audio/webm' });
        const arr = await odBlob.arrayBuffer();
        audioCtx.decodeAudioData(arr, (newBuf) => {
          // mix in the overdub channel (mono assumed)
          this._mixOverdub(newBuf.getChannelData(0));
        });
      };
      this.mediaRecorder.stop();
    }
  }

  // For worklet dumps that are overdubs
  _finalizeOverdub(floatArray) {
    this._mixOverdub(floatArray);
  }

  // mixing routine: baseBuffer + existing layers + newData -> new loopBuffer
  _mixOverdub(newData) {
    if (!this.baseBuffer) return;
    const base = this.baseBuffer.getChannelData(0);
    const len = base.length;
    // normalize sizes: newData length should equal len, but clip/zero-pad if needed
    const layer = new Float32Array(len);
    layer.set(newData.subarray(0, Math.min(newData.length, len)));
    if (newData.length < len) {
      // zero tail remains
    }
    // Rebuild output by summing base + existing overdubs + new layer
    const out = new Float32Array(len);
    for (let i=0;i<len;i++) out[i] = base[i];
    for (let existing of this.overdubBuffers) {
      for (let i=0;i<len;i++) out[i] += existing[i] || 0;
    }
    for (let i=0;i<len;i++) out[i] += layer[i] || 0;
    // Save this layer for undo
    this.overdubBuffers.push(layer);
    // Create new AudioBuffer for playback
    const newBuf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    newBuf.copyToChannel(out, 0, 0);
    this.loopBuffer = newBuf;
    this.loopDuration = newBuf.duration;
    // restart playback aligned
    this.startPlayback(true);
  }

  undoOverdub() {
    if (this.overdubBuffers.length === 0) return;
    this.overdubBuffers.pop();
    // recompute mix
    const base = this.baseBuffer.getChannelData(0);
    const len = base.length;
    const out = new Float32Array(len);
    for (let i=0;i<len;i++) out[i] = base[i];
    for (let layer of this.overdubBuffers) {
      for (let i=0;i<len;i++) out[i] += layer[i] || 0;
    }
    const newBuf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    newBuf.copyToChannel(out, 0, 0);
    this.loopBuffer = newBuf;
    this.loopDuration = newBuf.duration;
    this.startPlayback(true);
  }

  clearLoop() {
    if (this.sourceNode) try{ this.sourceNode.stop(); }catch(e){}
    this.loopBuffer = null; this.loopDuration = 0;
    this.baseBuffer = null; this.overdubBuffers = [];
    this.state = 'ready'; this.updateUI();
    if (this.index === 1) {
      masterLoopDuration = null; masterBPM = null; masterIsSet = false;
      bpmLabel.textContent = `BPM: --`;
      for (let k=2;k<=4;k++) { loopers[k].setDisabled(true); loopers[k].clearLoop(); }
    }
  }

  animateProgress() {
    if (this.state === 'playing' && this.loopDuration > 0 && this.sourceNode) {
      const pos = (audioCtx.currentTime - this.loopStartTime) % this.loopDuration;
      this.setRingProgress(pos / this.loopDuration);
      requestAnimationFrame(()=>this.animateProgress());
    } else {
      this.setRingProgress(0);
    }
  }
}

// Initialize loopers
const keyMap = [
  { rec:'w', stop:'s' },
  { rec:'e', stop:'d' },
  { rec:'r', stop:'f' },
  { rec:'t', stop:'g' }
];
window.loopers = [];
for (let i=1;i<=4;i++) loopers[i] = new Looper(i, keyMap[i-1].rec, keyMap[i-1].stop);

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  for (let i=1;i<=4;i++){
    if (key === keyMap[i-1].rec) { loopers[i].mainBtn.click(); e.preventDefault(); }
    if (key === keyMap[i-1].stop) {
      if (loopers[i].state === 'playing' || loopers[i].state === 'overdub') loopers[i].stopPlayback();
      else if (loopers[i].state === 'stopped') loopers[i].resumePlayback();
      e.preventDefault();
    }
  }
});

// Reverb knob wiring
const reverbKnob = document.getElementById('reverbKnob');
const knobIndicator = document.getElementById('knobIndicator');
const reverbValueDisplay = document.getElementById('reverbValue');
addKnobDragHandler(
  reverbKnob,
  () => reverbLevel,
  (val) => {
    reverbLevel = Math.max(0, Math.min(100, Math.round(val)));
    if (dryGain && wetGain) {
      dryGain.gain.value = (100 - reverbLevel) / 100;
      wetGain.gain.value = reverbLevel / 100;
    }
    reverbValueDisplay.textContent = reverbLevel + '%';
  },
  reverbValueDisplay, knobIndicator, 0, 100, 2.7, '%'
);
if (knobIndicator) knobIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

// Delay knob
const delayKnob = document.getElementById('delayKnob');
const delayKnobIndicator = document.getElementById('delayKnobIndicator');
const delayValueDisplay = document.getElementById('delayValue');
let delayMaxMs = 1000;
addKnobDragHandler(
  delayKnob,
  () => Math.round(delayTime * 1000),
  (val) => {
    let newVal = Math.max(0, Math.min(delayMaxMs, Math.round(val)));
    delayTime = newVal / 1000;
    if (delayNode) delayNode.delayTime.value = delayTime;
    delayValueDisplay.textContent = newVal + ' ms';
  },
  delayValueDisplay, delayKnobIndicator, 0, delayMaxMs, 0.27, ' ms'
);
if (delayKnobIndicator) delayKnobIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

// Resume audio on first gesture
function resumeAudio() {
  if (audioCtx.state === 'suspended') { audioCtx.resume(); hideMsg(); }
}
window.addEventListener('click', resumeAudio, { once: true });
window.addEventListener('touchstart', resumeAudio, { once: true });
if (audioCtx.state === 'suspended') showMsg("👆 Tap anywhere to start audio!", "#22ff88");
