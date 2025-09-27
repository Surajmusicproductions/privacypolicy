// script.js

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
  audioCtx.audioWorklet.addModule('recorder-processor.js')
    .then(() => { useWorklet = true; console.log('AudioWorklet loaded'); })
    .catch(err => { console.warn('AudioWorklet not available, using fallback', err); });
}

// Display messages for user (permissions, etc.)
function showMsg(msg, color = '#ff4444') {
  let el = document.getElementById('startMsg');
  if (!el) {
    el = document.createElement('div'); el.id = 'startMsg'; document.body.prepend(el);
  }
  el.innerHTML = msg;
  el.style.cssText = `
    display:block; color:${color}; background:#111a22cc;
    font-weight:bold; border-radius:12px; padding:12px 22px;
    position:fixed; left:50%; top:8%; transform:translate(-50%,0);
    z-index:1000; text-align:center;
  `;
}
function hideMsg() {
  let el = document.getElementById('startMsg');
  if (el) el.style.display = 'none';
}

// Ensure microphone access and set up effects chain
async function ensureMic() {
  if (!micStream) {
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

    // Create a delay with feedback
    delayNode = audioCtx.createDelay(2.0);
    delayGain = audioCtx.createGain();
    delayNode.delayTime.value = 0;
    delayGain.gain.value = 0.5;
    micSource.connect(delayNode);
    delayNode.connect(delayGain);
    delayGain.connect(delayNode);

    // Create a reverb (convolver) with an impulse buffer
    convolver = audioCtx.createConvolver();
    convolver.buffer = createReverbImpulse(3.0, 2.0);
    convolver.normalize = true;
    delayNode.connect(convolver);

    // Dry/Wet gains for reverb mix
    dryGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    dryGain.gain.value = 1;
    wetGain.gain.value = 0;
    micSource.connect(dryGain);
    convolver.connect(wetGain);

    // Route dry and wet to a common MediaStreamDestination for fallback recording
    mixDest = audioCtx.createMediaStreamDestination();
    dryGain.connect(mixDest);
    wetGain.connect(mixDest);
    processedStream = mixDest.stream;

    hideMsg();
  }
}

// Create an impulse response for reverb (decaying noise)
function createReverbImpulse(durationSeconds, decayFactor) {
  const sampleRate = audioCtx.sampleRate;
  const length = sampleRate * durationSeconds;
  const impulse = audioCtx.createBuffer(2, length, sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    let buffer = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      buffer[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayFactor);
    }
  }
  return impulse;
}

// Universal handlers for taps and holds (including touch)
function addTapHandler(btn, handler) {
  if (!btn) return;
  btn.addEventListener('click', handler);
  btn.addEventListener('touchstart', e => { e.preventDefault(); handler(e); }, { passive: false });
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

// Looper class encapsulates one track (1=master, 2-4=slaves)
class Looper {
  constructor(index, recordKey, stopKey) {
    this.index = index;
    this.recordKey = recordKey;
    this.stopKey = stopKey;
    this.state = 'ready';
    this.uiDisabled = false;

    // UI elements for this looper
    this.mainBtn = document.getElementById('mainLooperBtn' + index);
    this.stopBtn = document.getElementById('stopBtn' + index);
    this.looperIcon = document.getElementById('looperIcon' + index);
    this.ledRing = document.getElementById('progressBar' + index);
    this.stateDisplay = document.getElementById('stateDisplay' + index);

    // Loop data
    this.loopBuffer = null;           // Combined audio buffer for loop playback
    this.loopDuration = 0;            // Duration in seconds
    this.loopStartTime = 0;           // AudioContext.currentTime when loop playback started
    this.baseBuffer = null;           // Original (base) loop audio (for undo)
    this.overdubBuffers = [];         // Array of Float32Arrays for each overdub layer

    // For MediaRecorder fallback
    this.mediaRecorder = null;
    this.chunks = [];

    // For AudioWorkletRecorder
    if (useWorklet) {
      // Create a recorder node (no outputs, mono channel)
      this.recorder = new AudioWorkletNode(audioCtx, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1
      });
      // Handle incoming recorded data
      this.recorder.port.onmessage = async (e) => {
        const data = e.data;
        if (data.cmd === 'dump') {
          // Received recorded Float32 data
          const channels = data.channels; // array of Float32Array per channel
          if (channels.length === 0) {
            // No data recorded (empty)
            this._finalizeRecording(new Float32Array(0));
          } else {
            let raw = channels[0]; // we use mono (first channel)
            const firstFrame = data.firstBlockFrame;
            const startFrame = data.startedAtFrame;
            const stopFrame = data.stoppedAtFrame;
            // Trim leading/trailing silence from first/last partial blocks
            const startOffset = Math.max(0, startFrame - firstFrame);
            const endOffset = raw.length - (stopFrame - firstFrame);
            const sliced = raw.slice(startOffset, endOffset);
            this._finalizeRecording(sliced);
          }
        }
      };
      this.recorderConnected = false;
    }

    // Disable slave tracks until master loop set
    if (index >= 2 && dividerSelectors[index]) {
      this.divider = parseFloat(dividerSelectors[index].value);
      dividerSelectors[index].addEventListener('change', e => {
        this.divider = parseFloat(e.target.value);
      });
      this.setDisabled(true);
    } else {
      this.divider = 1;
    }

    // Hook up UI buttons
    addTapHandler(this.mainBtn, async () => {
      await ensureMic();  // ensure audio graph exists
      await this.handleMainButton();
    });
    addHoldHandler(this.stopBtn,
      () => {
        if (this.state === 'ready') return;
        // Long hold: clear loop after 2s
        this.holdTimer = setTimeout(() => { this.clearLoop(); this.holdTimer = null; }, 2000);
      },
      () => {
        if (this.holdTimer) {
          clearTimeout(this.holdTimer);
          this.holdTimer = null;
          // Short tap: stop or resume
          if (this.state === 'playing' || this.state === 'overdub') {
            this.stopPlayback();
          } else if (this.state === 'stopped') {
            this.resumePlayback();
          }
        }
      }
    );

    this.updateUI();
    this.setRingProgress(0);
  }

  // UI helpers (LED ring color, progress, icon, text)
  setLED(color) {
    const colors = { green:'#22c55e', red:'#e11d48', orange:'#f59e0b', gray:'#6b7280' };
    this.ledRing.style.stroke = colors[color] || '#fff';
    this.ledRing.style.filter = (color === 'gray')
      ? 'none'
      : `drop-shadow(0 0 8px ${colors[color]}88)`;
  }
  setRingProgress(ratio) {
    const R = 42, C = 2 * Math.PI * R;
    const offset = C * (1 - ratio);
    this.ledRing.style.strokeDasharray = C;
    this.ledRing.style.strokeDashoffset = offset;
  }
  setIcon(symbol, color) {
    this.looperIcon.textContent = symbol;
    this.looperIcon.style.color = color || '#fff';
  }
  setDisplay(text) { this.stateDisplay.textContent = text; }

  updateUI() {
    // Update UI based on current state
    switch (this.state) {
      case 'ready':
        this.setLED('green'); this.setRingProgress(0);
        this.setIcon('▶'); this.setDisplay('Ready');
        break;
      case 'recording':
        this.setLED('red'); this.setIcon('⦿', '#e11d48');
        this.setDisplay('Recording...');
        break;
      case 'playing':
        this.setLED('green'); this.setIcon('▶');
        this.setDisplay('Playing');
        break;
      case 'overdub':
        this.setLED('orange'); this.setIcon('⦿', '#f59e0b');
        this.setDisplay('Overdubbing');
        break;
      case 'stopped':
        this.setLED('gray'); this.setRingProgress(0);
        this.setIcon('▶', '#aaa'); this.setDisplay('Stopped');
        break;
      case 'waiting':
        this.setLED('gray'); this.setRingProgress(0);
        this.setIcon('⏳', '#aaa'); this.setDisplay('Waiting for sync...');
        break;
    }
    // Disable UI if needed (e.g. slave waiting for master)
    if (this.uiDisabled) {
      this.mainBtn.disabled = true; this.stopBtn.disabled = true;
      this.mainBtn.classList.add('disabled-btn'); this.stopBtn.classList.add('disabled-btn');
      this.setDisplay('WAIT: Set Track 1');
    } else {
      this.mainBtn.disabled = false; this.stopBtn.disabled = false;
      this.mainBtn.classList.remove('disabled-btn'); this.stopBtn.classList.remove('disabled-btn');
    }
  }
  setDisabled(val) { this.uiDisabled = val; this.updateUI(); }

  // Handle main button based on state
  async handleMainButton() {
    if (this.state === 'ready') {
      await this.phaseLockedRecording();
    } else if (this.state === 'recording') {
      await this.stopRecordingAndPlay();
    } else if (this.state === 'playing') {
      this.armOverdub();
    } else if (this.state === 'overdub') {
      // Already armed; do nothing (we auto-stop after one loop)
    }
  }

  // ===== Recording =====
  async phaseLockedRecording() {
    // If master or master not set, start immediately
    if (this.index === 1 || !masterIsSet) {
      await this.startRecording();
      return;
    }
    // Slave: wait for next master-loop boundary
    const targetLen = masterLoopDuration * this.divider;
    this.state = 'waiting'; this.updateUI();
    this.setDisplay('Waiting for sync...');
    const now = audioCtx.currentTime;
    const master = loopers[1];
    const masterElapsed = (now - master.loopStartTime) % masterLoopDuration;
    const timeToNext = masterLoopDuration - masterElapsed;
    // Schedule start after delay
    setTimeout(async () => {
      await this.startRecording();
      // Also schedule forced stop at target length (safety)
      setTimeout(() => {
        if (this.state === 'recording') this.stopRecordingAndPlay();
      }, targetLen * 1000 + 20);
    }, timeToNext * 1000);
  }

  async startRecording() {
    this.state = 'recording';
    this.updateUI();
    this.setRingProgress(0);
    this.chunks = [];

    // Connect recorder node if using AudioWorklet
    if (useWorklet && this.recorder && !this.recorderConnected) {
      dryGain.connect(this.recorder);
      wetGain.connect(this.recorder);
      this.recorderConnected = true;
    }

    if (useWorklet && this.recorder) {
      // **Worklet path:** arm recording immediately
      const startFrame = Math.ceil(audioCtx.currentTime * audioCtx.sampleRate);
      this.recorder.port.postMessage({ cmd:'reset' });
      this.recorder.port.postMessage({ cmd:'armAtFrame', frame: startFrame });
    } else {
      // **MediaRecorder path:** start recording the processed stream
      this.mediaRecorder = new MediaRecorder(processedStream);
      this.mediaRecorder.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
      this.mediaRecorder.start();
      // Visualize recording progress (max 12s or loop length)
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
  }

  async stopRecordingAndPlay() {
    if (this.state !== 'recording') return;
    this.state = 'playing'; this.updateUI();

    if (useWorklet && this.recorder) {
      // **Worklet path:** stop and dump buffers
      const stopFrame = Math.ceil(audioCtx.currentTime * audioCtx.sampleRate);
      this.recorder.port.postMessage({ cmd:'stopAtFrame', frame: stopFrame });
      // Give a tiny delay for final block capture, then request dump
      setTimeout(() => {
        this.recorder.port.postMessage({ cmd:'dump' });
      }, 20);
      // The onmessage handler will call _finalizeRecording()
    } else {
      // **MediaRecorder path:** stop recorder
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        const arrayBuf = await blob.arrayBuffer();
        audioCtx.decodeAudioData(arrayBuf, (buffer) => {
          // Save base buffer for overdub mixing
          this.baseBuffer = buffer;
          this.loopBuffer = buffer;
          this.loopDuration = buffer.duration;
          if (this.index === 1) {
            // Master track set loop length and BPM
            masterLoopDuration = this.loopDuration;
            masterBPM = Math.round(60 / masterLoopDuration * 4); // assuming 4/4
            masterIsSet = true;
            bpmLabel.textContent = `BPM: ${masterBPM}`;
            // Enable slave tracks
            for (let k = 2; k <= 4; k++) loopers[k].setDisabled(false);
          }
          this.startPlayback(true);
        });
      };
      this.mediaRecorder.stop();
    }
  }

  // Finalize after AudioWorklet dump (slices are raw PCM)
  _finalizeRecording(floatArray) {
    // Create AudioBuffer from Float32Array
    const length = floatArray.length;
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    buffer.copyToChannel(floatArray, 0, 0);
    // Save base buffer
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
  }

  // Start loop playback, optionally re-aligning to master
  startPlayback(resetPhase) {
    if (!this.loopBuffer) return;
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch(e) { /* ignore */ }
    }
    this.sourceNode = audioCtx.createBufferSource();
    this.sourceNode.buffer = this.loopBuffer;
    this.sourceNode.loop = true;
    this.sourceNode.connect(audioCtx.destination);

    // Align slave track to master's loop phase
    let offset = 0;
    if (this.index !== 1 && masterIsSet && loopers[1].sourceNode) {
      const masterNow = audioCtx.currentTime - loopers[1].loopStartTime;
      offset = masterNow % masterLoopDuration;
      if (offset < 0) offset = 0;
    }
    this.loopStartTime = audioCtx.currentTime - offset;
    this.sourceNode.start(0, offset);
    this.state = 'playing';
    this.updateUI();
    this.animateProgress();
  }

  // Stop and restart (resume) playback
  stopPlayback() {
    if (this.sourceNode) { try { this.sourceNode.stop(); } catch(e) {} }
    this.state = 'stopped'; this.updateUI();
  }
  resumePlayback() { this.startPlayback(); }

  // Begin overdub: schedule recording at next loop boundary
  armOverdub() {
    if (this.state !== 'playing') return;
    this.state = 'overdub'; this.updateUI();
    const now = audioCtx.currentTime;
    const loopStart = this.loopStartTime;
    const elapsed = (now - loopStart) % this.loopDuration;
    const delay = this.loopDuration - elapsed;
    // Schedule actual recording
    setTimeout(() => this.startOverdubRecording(), delay * 1000);
  }

  startOverdubRecording() {
    // Start a recording of exactly one loop cycle
    if (useWorklet && this.recorder) {
      const nowFrame = Math.ceil(audioCtx.currentTime * audioCtx.sampleRate);
      const elapsedFrames = (nowFrame - Math.round(this.loopStartTime * audioCtx.sampleRate)) % Math.round(this.loopDuration * audioCtx.sampleRate);
      const armFrame = nowFrame + (Math.round(this.loopDuration * audioCtx.sampleRate) - elapsedFrames);
      const stopFrame = armFrame + Math.round(this.loopDuration * audioCtx.sampleRate);
      // Reset recorder and arm/stop
      this.recorder.port.postMessage({ cmd:'reset' });
      this.recorder.port.postMessage({ cmd:'armAtFrame', frame: armFrame });
      this.recorder.port.postMessage({ cmd:'stopAtFrame', frame: stopFrame });
      // Dump after recording
      setTimeout(() => {
        this.recorder.port.postMessage({ cmd:'dump' });
      }, this.loopDuration * 1000 + 50);
    } else {
      // Fallback: use MediaRecorder over the next loop duration
      this.overdubChunks = [];
      this.mediaRecorder = new MediaRecorder(processedStream);
      this.mediaRecorder.ondataavailable = e => { if (e.data.size) this.overdubChunks.push(e.data); };
      this.mediaRecorder.start();
      setTimeout(() => this.finishOverdub(), this.loopDuration * 1000);
    }
  }

  async finishOverdub() {
    // Called after one loop duration for overdub
    if (useWorklet) {
      // Worklet path: data will arrive via onmessage handler after dump
      // (We handle it in _finalizeOverdub)
    } else {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.onstop = async () => {
          const odBlob = new Blob(this.overdubChunks, { type: 'audio/webm' });
          const origBuf = this.loopBuffer;
          const arrayBuf = await odBlob.arrayBuffer();
          audioCtx.decodeAudioData(arrayBuf, (newBuf) => {
            this._mixOverdub(newBuf.getChannelData(0));
          });
        };
        this.mediaRecorder.stop();
      }
    }
  }

  // For AudioWorklet: finalize after overdub dump
  _finalizeOverdub(floatArray) {
    this._mixOverdub(floatArray);
  }

  // Mix a new overdub Float32Array into the loop
  _mixOverdub(newData) {
    if (!this.baseBuffer) return;
    const baseData = this.baseBuffer.getChannelData(0);
    const length = baseData.length;
    // Add newData to base + any existing overdubs
    let out = new Float32Array(length);
    // Start with base buffer
    for (let i = 0; i < length; i++) {
      out[i] = baseData[i];
    }
    // Mix previous overdubs
    for (let layer of this.overdubBuffers) {
      for (let i = 0; i < length; i++) {
        out[i] += layer[i] || 0;
      }
    }
    // Mix new overdub layer
    for (let i = 0; i < length; i++) {
      out[i] += newData[i] || 0;
    }
    // Save the new overdub layer for undo
    this.overdubBuffers.push(newData);
    // Create a new AudioBuffer for playback
    const newBuf = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    newBuf.copyToChannel(out, 0, 0);
    this.loopBuffer = newBuf;
    this.loopDuration = newBuf.duration;
    // Restart playback to include new layer (aligned)
    this.startPlayback(true);
  }

  // Undo the latest overdub layer
  undoOverdub() {
    if (this.overdubBuffers.length === 0) return;
    this.overdubBuffers.pop();
    // Recompute mix: base + remaining layers
    const baseData = this.baseBuffer.getChannelData(0);
    const length = baseData.length;
    let out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = baseData[i];
    for (let layer of this.overdubBuffers) {
      for (let i = 0; i < length; i++) out[i] += layer[i] || 0;
    }
    const newBuf = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    newBuf.copyToChannel(out, 0, 0);
    this.loopBuffer = newBuf;
    this.loopDuration = newBuf.duration;
    // Restart playback to reflect removal
    this.startPlayback(true);
  }

  // Clear the loop entirely (long-hold Stop)
  clearLoop() {
    if (this.sourceNode) { try { this.sourceNode.stop(); } catch(e) {} }
    this.loopBuffer = null; this.loopDuration = 0;
    this.baseBuffer = null; this.overdubBuffers = [];
    this.state = 'ready'; this.updateUI();
    if (this.index === 1) {
      // If master is cleared, reset all
      masterLoopDuration = null; masterBPM = null; masterIsSet = false;
      bpmLabel.textContent = `BPM: --`;
      for (let k = 2; k <= 4; k++) {
        loopers[k].setDisabled(true);
        loopers[k].clearLoop();
      }
    }
  }

  // Progress ring animation for playback
  animateProgress() {
    if (this.state === 'playing' && this.loopDuration > 0 && this.sourceNode) {
      const pos = (audioCtx.currentTime - this.loopStartTime) % this.loopDuration;
      this.setRingProgress(pos / this.loopDuration);
      requestAnimationFrame(() => this.animateProgress());
    } else {
      this.setRingProgress(0);
    }
  }
}

// Initialize loopers (keys W/S, E/D, R/F, T/G)
const keyMap = [
  { rec: 'w', stop: 's' },
  { rec: 'e', stop: 'd' },
  { rec: 'r', stop: 'f' },
  { rec: 't', stop: 'g' }
];
window.loopers = [];
for (let i = 1; i <= 4; i++) {
  loopers[i] = new Looper(i, keyMap[i-1].rec, keyMap[i-1].stop);
}

// Keyboard shortcuts: record/stop per track
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  for (let i = 1; i <= 4; i++) {
    if (key === keyMap[i-1].rec) {
      loopers[i].mainBtn.click();
      e.preventDefault();
    }
    if (key === keyMap[i-1].stop) {
      if (loopers[i].state === 'playing' || loopers[i].state === 'overdub') {
        loopers[i].stopPlayback();
      } else if (loopers[i].state === 'stopped') {
        loopers[i].resumePlayback();
      }
      e.preventDefault();
    }
  }
});

// ====== Reverb and Delay UI Controls ======
// Reverb knob: adjusts mix between dryGain and wetGain
const reverbKnob = document.getElementById('reverbKnob');
const knobIndicator = document.getElementById('knobIndicator');
const reverbValueDisplay = document.getElementById('reverbValue');
addKnobDragHandler(
  reverbKnob,
  () => reverbLevel,
  (val) => {
    reverbLevel = Math.max(0, Math.min(100, Math.round(val)));
    dryGain.gain.value = (100 - reverbLevel) / 100;
    wetGain.gain.value = reverbLevel / 100;
    reverbValueDisplay.textContent = reverbLevel + '%';
  },
  reverbValueDisplay, knobIndicator, 0, 100, 2.7, '%'
);
if (knobIndicator) knobIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

// Delay knob: sets delayTime
const delayKnob = document.getElementById('delayKnob');
const delayIndicator = document.getElementById('delayKnobIndicator');
const delayValueDisplay = document.getElementById('delayValue');
let delayMaxMs = 1000; // 0–1000 ms
addKnobDragHandler(
  delayKnob,
  () => Math.round(delayTime * 1000),
  (val) => {
    let newVal = Math.max(0, Math.min(delayMaxMs, Math.round(val)));
    delayTime = newVal / 1000;
    if (delayNode) delayNode.delayTime.value = delayTime;
    delayValueDisplay.textContent = newVal + ' ms';
  },
  delayValueDisplay, delayIndicator, 0, delayMaxMs, 0.27, ' ms'
);
if (delayIndicator) delayIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

// Resume AudioContext on first user interaction
window.addEventListener('click', () => {
  if (audioCtx.state === 'suspended') { audioCtx.resume(); hideMsg(); }
}, { once: true });
window.addEventListener('touchstart', () => {
  if (audioCtx.state === 'suspended') { audioCtx.resume(); hideMsg(); }
}, { once: true });
if (audioCtx.state === 'suspended') {
  showMsg("👆 Tap anywhere to start audio!", "#22ff88");
}
