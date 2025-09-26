// Looper Pedal Board – Phase-Locked Multi-Track Version (WORKLET-based recording & overdub)
// REPLACE ENTIRE FILE with this content.

let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let micStream = null, micSource = null, dryGain = null, wetGain = null, convolver = null, delayNode = null, delayGain = null, mixDest = null, processedStream = null;
let reverbLevel = 0, delayTime = 0;
let masterLoopDuration = null, masterBPM = null, masterIsSet = false;

// Recorder worklet node
let recorderNode = null;

// UI element references (some are resolved after DOM)
const dividerSelectors = [
  null,
  null,
  document.getElementById('divider2'),
  document.getElementById('divider3'),
  document.getElementById('divider4'),
];
const bpmLabel = document.getElementById('bpmLabel');

function showMsg(msg, color = '#ff4444') {
  let el = document.getElementById('startMsg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'startMsg';
    document.body.prepend(el);
  }
  el.innerHTML = msg;
  el.style.display = 'block';
  el.style.color = color;
  el.style.background = '#111a22cc';
  el.style.fontWeight = 'bold';
  el.style.borderRadius = '12px';
  el.style.padding = '12px 22px';
  el.style.position = 'fixed';
  el.style.left = '50%';
  el.style.top = '8%';
  el.style.transform = 'translate(-50%,0)';
  el.style.zIndex = 1000;
  el.style.textAlign = "center";
}
function hideMsg() {
  let el = document.getElementById('startMsg');
  if (el) el.style.display = 'none';
}

// ------------------ WORKLET + HELPERS ------------------

// convert audio time (seconds) to absolute frame index (rounded)
function timeToFrame(t) {
  return Math.round(t * audioCtx.sampleRate);
}
function frameToTime(frame) {
  return frame / audioCtx.sampleRate;
}

// ensure recorder worklet is loaded and node is created
async function ensureWorklet() {
  if (!audioCtx.audioWorklet) {
    console.warn('AudioWorklet not supported in this browser.');
    return;
  }
  if (recorderNode) return;
  // load worklet module - make sure recorder-processor.js exists at site root
  await audioCtx.audioWorklet.addModule('recorder-processor.js');
  recorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor');
}

// request a dump from the worklet and wait for its response
function requestDumpFromWorklet() {
  return new Promise((resolve) => {
    function onmsg(e) {
      const d = e.data || {};
      if (d.cmd === 'dump') {
        recorderNode.port.removeEventListener('message', onmsg);
        resolve(d);
      }
    }
    recorderNode.port.addEventListener('message', onmsg);
    recorderNode.port.postMessage({ cmd: 'dump' });
  });
}

// ------------------ AUDIO & MIC SETUP ------------------
async function ensureMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showMsg("❌ Microphone not supported on this device/browser!");
    throw new Error("getUserMedia not supported.");
  }
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    } });
  } catch (e) {
    showMsg("❌ Microphone access denied!<br>Enable permission in app settings.", "#ff4444");
    throw e;
  }
  await audioCtx.resume();
  micSource = audioCtx.createMediaStreamSource(micStream);

  // Delay node
  delayNode = audioCtx.createDelay(2.0);
  delayGain = audioCtx.createGain();
  delayNode.delayTime.value = 0;
  delayGain.gain.value = 0.5;

  // Reverb node
  convolver = audioCtx.createConvolver();
  convolver.buffer = createReverbImpulse(3.0, 2.0);
  convolver.normalize = true;

  dryGain = audioCtx.createGain();
  wetGain = audioCtx.createGain();
  dryGain.gain.value = 1;
  wetGain.gain.value = 0;

  // Routing: mic → [dry] + [delay→(feedback)→reverb] → mix → out
  micSource.connect(dryGain);
  micSource.connect(delayNode);
  delayNode.connect(delayGain);
  delayGain.connect(delayNode);
  delayNode.connect(convolver);
  convolver.connect(wetGain);

  // keep mixDest for processedStream (useful for MediaStream usage)
  mixDest = audioCtx.createMediaStreamDestination();
  dryGain.connect(mixDest);
  wetGain.connect(mixDest);
  processedStream = mixDest.stream;

  // ensure worklet and create recorderNode
  await ensureWorklet();

  // --- IMPORTANT CHANGE: connect the node outputs directly to the worklet
  // rather than round-tripping through mixDest.stream -> createMediaStreamSource.
  // Connect dry + wet into recorderNode so the worklet sees the audio directly.
  try {
    if (recorderNode) {
      // disconnect any previous connections safely (defensive)
      try { dryGain.disconnect(recorderNode); } catch (e) {}
      try { wetGain.disconnect(recorderNode); } catch (e) {}
      dryGain.connect(recorderNode);
      wetGain.connect(recorderNode);
      console.log('ensureMic: connected dryGain & wetGain -> recorderNode');
    }
  } catch (err) {
    console.warn('Could not connect gains to recorderNode:', err);
  }

  // listen for debug messages from the worklet
  if (recorderNode && !recorderNode._debugAttached) {
    recorderNode.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.cmd === 'started') {
        console.log('Worklet STARTED capture', d);
      } else if (d.cmd === 'stopped') {
        console.log('Worklet STOPPED capture', d);
      } else if (d.cmd === 'dump') {
        console.log('Worklet DUMP returned', d);
      } else {
        // keep generic log for future messages
        console.log('Worklet msg:', d);
      }
    };
    recorderNode._debugAttached = true;
  }

  hideMsg();
}


function createReverbImpulse(durationSeconds, decayFactor) {
  const sampleRate = audioCtx.sampleRate;
  const length = sampleRate * durationSeconds;
  const impulse = audioCtx.createBuffer(2, length, sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const buffer = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      buffer[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayFactor);
    }
  }
  return impulse;
}

// ------------------ UI helpers ------------------
function addTapHandler(btn, handler) {
  if (!btn) return;
  btn.addEventListener('click', handler);
  btn.addEventListener('touchstart', function(e) {
    e.preventDefault(); handler(e);
  }, { passive: false });
}
function addHoldHandler(btn, onStart, onEnd) {
  let hold = false;
  btn.addEventListener('mousedown', function(e) { hold = true; onStart(e); });
  btn.addEventListener('touchstart', function(e) { hold = true; onStart(e); }, { passive: false });
  btn.addEventListener('mouseup', function(e) { if (hold) onEnd(e); hold = false; });
  btn.addEventListener('mouseleave', function(e) { if (hold) onEnd(e); hold = false; });
  btn.addEventListener('touchend', function(e) { if (hold) onEnd(e); hold = false; }, { passive: false });
  btn.addEventListener('touchcancel', function(e) { if (hold) onEnd(e); hold = false; }, { passive: false });
}
function addKnobDragHandler(knobElem, getValue, setValue, display, indicator, min=0, max=100, angleScale=2.7, units='%') {
  let dragging = false, startY = 0, startValue = 0;
  function dragStart(e) {
    e.preventDefault();
    dragging = true;
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

// ------------------ LOOPER CLASS ------------------
class Looper {
  constructor(index, recordKey, stopKey) {
    this.index = index;
    this.mainBtn = document.getElementById('mainLooperBtn' + index);
    this.stopBtn = document.getElementById('stopBtn' + index);
    this.looperIcon = document.getElementById('looperIcon' + index);
    this.ledRing = document.getElementById('progressBar' + index);
    this.stateDisplay = document.getElementById('stateDisplay' + index);
    this.recordKey = recordKey;
    this.stopKey = stopKey;
    this.state = 'ready';
    this.chunks = [];
    this.loopBuffer = null;
    this.sourceNode = null;
    this.loopStartTime = 0;
    this.loopDuration = 0;
    this.holdTimer = null;
    this.divider = 1;
    this.uiDisabled = false;
    this._isRecordingFlag = false; // internal flag for worklet-based recording
    this._armedStartFrame = null;
    this.updateUI();
    this.setRingProgress(0);

    if (index >= 2 && dividerSelectors[index]) {
      this.divider = parseFloat(dividerSelectors[index].value);
      dividerSelectors[index].addEventListener('change', e => {
        this.divider = parseFloat(e.target.value);
      });
      this.setDisabled(true);
    }

    addTapHandler(this.mainBtn, async () => {
      await ensureMic();
      await this.handleMainButton();
    });
    addHoldHandler(this.stopBtn, () => {
      if (this.state === 'ready') return;
      this.holdTimer = setTimeout(() => {
        this.clearLoop();
        this.holdTimer = null;
      }, 2000);
    }, () => {
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
        if (this.state === 'playing' || this.state === 'overdub') {
          this.stopPlayback();
        } else if (this.state === 'stopped') {
          this.resumePlayback();
        }
      }
    });
  }

  setLED(color) {
    const colors = { green: '#22c55e', red: '#e11d48', orange: '#f59e0b', gray: '#6b7280' };
    this.ledRing.style.stroke = colors[color] || '#fff';
    this.ledRing.style.filter = (color === 'gray') ? 'none' : 'drop-shadow(0 0 8px ' + (colors[color] + '88') + ')';
  }
  setRingProgress(ratio) {
    const RADIUS = 42, CIRCUM = 2 * Math.PI * RADIUS;
    const offset = CIRCUM * (1 - ratio);
    this.ledRing.style.strokeDasharray = CIRCUM;
    this.ledRing.style.strokeDashoffset = offset;
  }
  setIcon(symbol, color) {
    this.looperIcon.textContent = symbol;
    this.looperIcon.style.color = color ? color : '#fff';
  }
  setDisplay(text) { this.stateDisplay.textContent = text; }
  updateUI() {
    switch (this.state) {
      case 'ready': this.setLED('green'); this.setRingProgress(0); this.setIcon('▶'); this.setDisplay('Ready'); break;
      case 'recording': this.setLED('red'); this.setIcon('⦿', '#e11d48'); this.setDisplay('Recording...'); break;
      case 'playing': this.setLED('green'); this.setIcon('▶'); this.setDisplay('Playing'); break;
      case 'overdub': this.setLED('orange'); this.setIcon('⦿', '#f59e0b'); this.setDisplay('Overdubbing'); break;
      case 'stopped': this.setLED('gray'); this.setRingProgress(0); this.setIcon('▶', '#aaa'); this.setDisplay('Stopped'); break;
      case 'waiting': this.setLED('gray'); this.setRingProgress(0); this.setIcon('⏳', '#aaa'); this.setDisplay('Waiting for sync...'); break;
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
  setDisabled(val) { this.uiDisabled = val; this.updateUI(); }

  async handleMainButton() {
    if (this.state === 'ready') {
      await this.phaseLockedRecording();
    } else if (this.state === 'recording') {
      await this.stopRecordingAndPlay();
    } else if (this.state === 'playing') {
      this.armOverdub();
    } else if (this.state === 'overdub') {
      this.finishOverdub();
    }
  }

  // ===== PHASE-LOCKED MULTI-TRACK RECORDING (WORKLET-based) =====
  async phaseLockedRecording() {
    if (!processedStream) await ensureMic();
    // Master: immediate record on tap (user stops it)
    if (this.index === 1 || !masterIsSet) {
      await this.startRecording();
      return;
    }

    // For slave tracks: compute absolute audio time of next master boundary and arm at that frame
    const targetLen = masterLoopDuration * this.divider;
    this.state = 'waiting'; this.updateUI();
    this.setDisplay('Waiting for sync...');

    // Find time to next master boundary using audio clock
    const now = audioCtx.currentTime;
    const master = loopers[1];
    const masterElapsed = (now - master.loopStartTime) % masterLoopDuration;
    const timeToNextBoundary = masterLoopDuration - masterElapsed;
    const startTime = now + timeToNextBoundary;
    // call precise start (no reliance on setTimeout to start capturing)
    await this._startPhaseLockedRecording(targetLen, startTime);
  }

  // targetLen seconds, startTime absolute audioCtx.currentTime time
  async _startPhaseLockedRecording(targetLen, startTime) {
    // calculate frames for worklet
    const startFrame = timeToFrame(startTime);
    const stopFrame = timeToFrame(startTime + targetLen);

    // reset recorder worklet and arm/stop at exact frames
    recorderNode.port.postMessage({ cmd: 'reset' });
    recorderNode.port.postMessage({ cmd: 'armAtFrame', frame: startFrame });
    recorderNode.port.postMessage({ cmd: 'stopAtFrame', frame: stopFrame });

    // UI: schedule progress starting at startTime
    this.state = 'recording'; this.updateUI();
    const now = audioCtx.currentTime;
    const waitUntilStart = Math.max(0, (startTime - now) * 1000);
    const recDurMs = targetLen * 1000;

    setTimeout(() => {
      const startMs = Date.now();
      const self = this;
      function animateRec() {
        if (self.state === 'recording') {
          const elapsed = (Date.now() - startMs) / recDurMs;
          self.setRingProgress(Math.min(elapsed, 1));
          if (elapsed < 1) requestAnimationFrame(animateRec);
          if (elapsed >= 1) {
            // nothing here - we'll gather dump after stop
          }
        }
      }
      animateRec();
    }, waitUntilStart);

    // wait slightly after stopFrame to ensure worklet flushed captured blocks
    const waitMs = Math.max(0, (stopFrame / audioCtx.sampleRate - audioCtx.currentTime) * 1000 + 40);
    await new Promise(r => setTimeout(r, waitMs));

    // request dump from worklet
    const data = await requestDumpFromWorklet();
    if (!data || !data.channels || data.length === 0) {
      // nothing recorded
      this.state = 'ready'; this.updateUI();
      return;
    }

    // Trim edges precisely using returned metadata
    const framesReturned = data.length;
    const firstBlockFrame = (typeof data.firstBlockFrame === 'number') ? data.firstBlockFrame : null;
    const startedAtFrame = (typeof data.startedAtFrame === 'number') ? data.startedAtFrame : null;
    const stoppedAtFrame = (typeof data.stoppedAtFrame === 'number') ? data.stoppedAtFrame : null;

    // Determine trim offsets (if metadata present)
    let trimStart = 0, trimEnd = 0;
    if (firstBlockFrame !== null && startedAtFrame !== null) {
      trimStart = Math.max(0, startedAtFrame - firstBlockFrame);
    }
    if (firstBlockFrame !== null && stoppedAtFrame !== null) {
      trimEnd = Math.max(0, (firstBlockFrame + framesReturned) - stoppedAtFrame);
    }
    const finalFrames = Math.max(0, framesReturned - trimStart - trimEnd);
    const sampleRate = data.sampleRate || audioCtx.sampleRate;

    // Build AudioBuffer from trimmed arrays
    const numCh = data.channels.length || 1;
    const buf = audioCtx.createBuffer(numCh, finalFrames, sampleRate);
    for (let ch = 0; ch < numCh; ch++) {
      const full = data.channels[ch];
      // slice from trimStart .. trimStart + finalFrames
      const slice = full.subarray(trimStart, trimStart + finalFrames);
      buf.copyToChannel(slice, ch, 0);
    }

    // store loop buffer and start playback synced to master
    this.loopBuffer = buf;
    this.loopDuration = buf.duration;
    if (this.index === 1) {
      masterLoopDuration = this.loopDuration;
      masterBPM = Math.round(60 / masterLoopDuration * 4);
      masterIsSet = true;
      bpmLabel.textContent = `BPM: ${masterBPM}`;
      for (let k = 2; k <= 4; ++k) loopers[k].setDisabled(false);
    }
    this.startPlayback(true);
  }

  // Master/manual recording (tap to start, tap to stop) - uses worklet, records until user taps stop
  async startRecording() {
    await ensureMic();
    // reset and arm at a tiny offset so the worklet has time to engage
    recorderNode.port.postMessage({ cmd: 'reset' });
    const armTime = audioCtx.currentTime + 0.02; // 20ms margin
    const armFrame = timeToFrame(armTime);
    recorderNode.port.postMessage({ cmd: 'armAtFrame', frame: armFrame });
    this._armedStartFrame = armFrame;
    this._isRecordingFlag = true;

    // UI
    this.state = 'recording';
    this.updateUI();

    // animate progress (max length fallback)
    const startMs = Date.now();
    let recMax = 12000;
    if (this.index >= 2 && masterLoopDuration) { recMax = masterLoopDuration * this.divider * 1000; }
    const self = this;
    function animateRec() {
      if (self.state === 'recording') {
        let elapsed = (Date.now() - startMs) / recMax;
        self.setRingProgress(Math.min(elapsed, 1));
        if (elapsed < 1) requestAnimationFrame(animateRec);
        if (elapsed >= 1) {
          // auto-stop after recMax
          self.stopRecordingAndPlay();
        }
      }
    }
    animateRec();
  }

  // User tapped to stop a manual recording (master)
  async stopRecordingAndPlay() {
    if (!this._isRecordingFlag && !this.state) {
      // no active recording
      return;
    }
    // ask worklet to stop at a tiny offset (give audio thread a bit to process)
    const stopTime = audioCtx.currentTime + 0.02;
    const stopFrame = timeToFrame(stopTime);
    recorderNode.port.postMessage({ cmd: 'stopAtFrame', frame: stopFrame });
    this.state = 'playing';
    this.updateUI();
    this._isRecordingFlag = false;

    // wait for worklet flush
    const waitMs = Math.max(0, (stopFrame / audioCtx.sampleRate - audioCtx.currentTime) * 1000 + 40);
    await new Promise(r => setTimeout(r, waitMs));

    // request dump
    const data = await requestDumpFromWorklet();
    if (!data || !data.channels || data.length === 0) {
      this.state = 'ready'; this.updateUI();
      return;
    }

    // trim using metadata
    const framesReturned = data.length;
    const firstBlockFrame = (typeof data.firstBlockFrame === 'number') ? data.firstBlockFrame : null;
    const startedAtFrame = (typeof data.startedAtFrame === 'number') ? data.startedAtFrame : null;
    const stoppedAtFrame = (typeof data.stoppedAtFrame === 'number') ? data.stoppedAtFrame : null;

    let trimStart = 0, trimEnd = 0;
    if (firstBlockFrame !== null && startedAtFrame !== null) trimStart = Math.max(0, startedAtFrame - firstBlockFrame);
    if (firstBlockFrame !== null && stoppedAtFrame !== null) trimEnd = Math.max(0, (firstBlockFrame + framesReturned) - stoppedAtFrame);
    const finalFrames = Math.max(0, framesReturned - trimStart - trimEnd);
    const sampleRate = data.sampleRate || audioCtx.sampleRate;
    const numCh = data.channels.length || 1;
    const buf = audioCtx.createBuffer(numCh, finalFrames, sampleRate);
    for (let ch = 0; ch < numCh; ch++) {
      const full = data.channels[ch];
      const slice = full.subarray(trimStart, trimStart + finalFrames);
      buf.copyToChannel(slice, ch, 0);
    }

    // save buffer and start loop playback
    this.loopBuffer = buf;
    this.loopDuration = buf.duration;
    if (this.index === 1) {
      masterLoopDuration = this.loopDuration;
      masterBPM = Math.round(60 / masterLoopDuration * 4); // Assume 4/4 bar
      masterIsSet = true;
      bpmLabel.textContent = `BPM: ${masterBPM}`;
      for (let k = 2; k <= 4; ++k) loopers[k].setDisabled(false);
    }
    this.startPlayback(true);
  }

  // Start playback, optionally reset phase to master
  startPlayback(resetPhase) {
    if (!this.loopBuffer) return;
    if (this.sourceNode) { try { this.sourceNode.stop(); } catch (e) {} }
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
    this.state = 'playing';
    this.updateUI();
    this.animateProgress();
  }

  stopPlayback() {
    if (this.sourceNode) { try { this.sourceNode.stop(); } catch (e) {} }
    this.state = 'stopped'; this.updateUI();
  }
  resumePlayback() { this.startPlayback(); }

  // Arm overdub to begin at next loop boundary
  armOverdub() {
    if (this.state !== 'playing') return;
    this.state = 'overdub'; this.updateUI();
    const now = audioCtx.currentTime;
    const elapsed = (now - this.loopStartTime) % this.loopDuration;
    const nextBoundaryTime = now + (this.loopDuration - elapsed);
    // start overdub recording for one full loop at exact frame
    this.startOverdubRecording(nextBoundaryTime);
  }

  // Start overdub for one loop, startTime is absolute audio time to begin recording
  async startOverdubRecording(startTime) {
    if (!recorderNode) await ensureWorklet();
    const startFrame = timeToFrame(startTime);
    const stopFrame = timeToFrame(startTime + this.loopDuration);

    // reset & arm/stop
    recorderNode.port.postMessage({ cmd: 'reset' });
    recorderNode.port.postMessage({ cmd: 'armAtFrame', frame: startFrame });
    recorderNode.port.postMessage({ cmd: 'stopAtFrame', frame: stopFrame });

    // UI: show progress synced
    const now = audioCtx.currentTime;
    const waitUntilStart = Math.max(0, (startTime - now) * 1000);
    setTimeout(() => {
      const startMs = Date.now();
      const self = this;
      function animateRec() {
        if (self.state === 'overdub') {
          const elapsed = (Date.now() - startMs) / (self.loopDuration * 1000);
          self.setRingProgress(Math.min(elapsed, 1));
          if (elapsed < 1) requestAnimationFrame(animateRec);
        }
      }
      animateRec();
    }, waitUntilStart);

    // wait until after stopFrame then request dump
    const waitMs = Math.max(0, (stopFrame / audioCtx.sampleRate - audioCtx.currentTime) * 1000 + 40);
    await new Promise(r => setTimeout(r, waitMs));

    const data = await requestDumpFromWorklet();
    if (!data || !data.channels || data.length === 0) {
      this.state = 'playing'; this.updateUI();
      return;
    }

    // Trim like other flows
    const framesReturned = data.length;
    const firstBlockFrame = (typeof data.firstBlockFrame === 'number') ? data.firstBlockFrame : null;
    const startedAtFrame = (typeof data.startedAtFrame === 'number') ? data.startedAtFrame : null;
    const stoppedAtFrame = (typeof data.stoppedAtFrame === 'number') ? data.stoppedAtFrame : null;

    let trimStart = 0, trimEnd = 0;
    if (firstBlockFrame !== null && startedAtFrame !== null) trimStart = Math.max(0, startedAtFrame - firstBlockFrame);
    if (firstBlockFrame !== null && stoppedAtFrame !== null) trimEnd = Math.max(0, (firstBlockFrame + framesReturned) - stoppedAtFrame);
    const finalFrames = Math.max(0, framesReturned - trimStart - trimEnd);
    const sampleRate = data.sampleRate || audioCtx.sampleRate;
    const numCh = data.channels.length || 1;

    // Build overdub buffer
    const odBuf = audioCtx.createBuffer(numCh, finalFrames, sampleRate);
    for (let ch = 0; ch < numCh; ch++) {
      const full = data.channels[ch];
      const slice = full.subarray(trimStart, trimStart + finalFrames);
      odBuf.copyToChannel(slice, ch, 0);
    }

    // Mix overdub buffer into existing loopBuffer sample-accurately
    this.mixOverdubIntoLoop(odBuf);
  }

  // Mix newBuf into this.loopBuffer (sample-accurate overlay starting at loop boundary)
  mixOverdubIntoLoop(newBuf) {
    if (!this.loopBuffer) {
      // if no existing loop, just adopt the overdub buffer
      this.loopBuffer = newBuf;
      this.loopDuration = newBuf.duration;
      this.startPlayback(true);
      return;
    }

    // We want to overlay newBuf aligned to loop start. Both should have same sampleRate for clean mixing.
    const sr = this.loopBuffer.sampleRate;
    const targetLen = Math.max(this.loopBuffer.length, newBuf.length);
    const outBuf = audioCtx.createBuffer(Math.max(this.loopBuffer.numberOfChannels, newBuf.numberOfChannels), targetLen, sr);

    // For each channel, sum samples (handle channels mismatches)
    for (let ch = 0; ch < outBuf.numberOfChannels; ch++) {
      const out = outBuf.getChannelData(ch);
      const orig = (ch < this.loopBuffer.numberOfChannels) ? this.loopBuffer.getChannelData(ch) : null;
      const nov = (ch < newBuf.numberOfChannels) ? newBuf.getChannelData(ch) : null;
      for (let i = 0; i < targetLen; i++) {
        const a = orig ? (orig[i] || 0) : 0;
        const b = nov ? (nov[i] || 0) : 0;
        out[i] = a + b;
      }
    }

    // Replace loopBuffer and restart playback (phase-locked)
    this.loopBuffer = outBuf;
    this.loopDuration = outBuf.duration;
    this.startPlayback(true);
  }

  // finishOverdub kept for compatibility (calls mix done above)
  finishOverdub() {
    // In this architecture startOverdubRecording performs the dump & mixing
    if (this.state === 'overdub') {
      this.state = 'playing';
      this.updateUI();
    }
  }

  clearLoop() {
    if (this.sourceNode) { try { this.sourceNode.stop(); } catch (e) {} }
    this.loopBuffer = null; this.loopDuration = 0; this.state = 'ready'; this.updateUI();
    if (this.index === 1) {
      masterLoopDuration = null; masterBPM = null; masterIsSet = false;
      bpmLabel.textContent = `BPM: --`;
      for (let k = 2; k <= 4; ++k) loopers[k].setDisabled(true);
      for (let k = 2; k <= 4; ++k) loopers[k].clearLoop();
    }
  }
  animateProgress() {
    if (this.state === 'playing' && this.loopDuration > 0 && this.sourceNode) {
      const now = audioCtx.currentTime;
      const position = (now - this.loopStartTime) % this.loopDuration;
      this.setRingProgress(position / this.loopDuration);
      requestAnimationFrame(this.animateProgress.bind(this));
    } else {
      this.setRingProgress(0);
    }
  }
}

// ------------------ INITIALIZE LOOPERS ------------------
const keyMap = [
  { rec: 'w', stop: 's' },
  { rec: 'e', stop: 'd' },
  { rec: 'r', stop: 'f' },
  { rec: 't', stop: 'g' }
];
window.loopers = [];
for (let i = 1; i <= 4; i++) {
  loopers[i] = new Looper(i, keyMap[i - 1].rec, keyMap[i - 1].stop);
}

// ------------------ GLOBAL KEYBOARD SHORTCUTS ------------------
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  for (let i = 1; i <= 4; i++) {
    if (key === keyMap[i - 1].rec) {
      loopers[i].mainBtn.click();
      e.preventDefault();
    }
    if (key === keyMap[i - 1].stop) {
      if (loopers[i].state === 'playing' || loopers[i].state === 'overdub') {
        loopers[i].stopPlayback();
      } else if (loopers[i].state === 'stopped') {
        loopers[i].resumePlayback();
      }
      e.preventDefault();
    }
  }
});

// ------------------ REVERB & DELAY KNOBS ------------------
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
  },
  reverbValueDisplay, knobIndicator, 0, 100, 2.7, '%'
);
if (knobIndicator) knobIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

const delayKnob = document.getElementById('delayKnob');
const delayKnobIndicator = document.getElementById('delayKnobIndicator');
const delayValueDisplay = document.getElementById('delayValue');
let delayMaxMs = 1000; // 0-1000 ms (1s)
addKnobDragHandler(
  delayKnob,
  () => Math.round(delayTime * 1000),
  (val) => {
    let newVal = Math.max(0, Math.min(delayMaxMs, Math.round(val)));
    delayTime = newVal / 1000;
    if (delayNode) delayNode.delayTime.value = delayTime;
  },
  delayValueDisplay, delayKnobIndicator, 0, delayMaxMs, 0.27, ' ms'
);
if (delayKnobIndicator) delayKnobIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

// ------------------ AUDIO CONTEXT RESUME ------------------
function resumeAudio() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
    hideMsg();
  }
}
window.addEventListener('click', resumeAudio, { once: true });
window.addEventListener('touchstart', resumeAudio, { once: true });
if (audioCtx.state === 'suspended') {
  showMsg("👆 Tap anywhere to start audio!", "#22ff88");
}
