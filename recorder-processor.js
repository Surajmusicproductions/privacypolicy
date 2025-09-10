// recorder-processor.js
// AudioWorkletProcessor implementing multi-track ring buffers, overdub, undo, and dump.
// Copy-paste this file into your project (the same path used by audioCtx.audioWorklet.addModule).

class RecorderProcessor extends AudioWorkletProcessor {
  // static getter for parameterDescriptors if needed (none used here)
  static get parameterDescriptors() { return []; }

  constructor() {
    super();

    // === configurable defaults ===
    this._numTracks = 1;                 // number of virtual loop tracks
    this._numChannels = 2;               // stereo default; will adapt on first process if input provides fewer channels
    this._maxSecondsPerTrack = 120;      // default ring buffer length per track (seconds)
    this._sampleRate = sampleRate;       // sampleRate is global in AudioWorkletProcessor scope
    this._maxSamples = Math.floor(this._sampleRate * this._maxSecondsPerTrack);

    // === core buffers & state ===
    // one big Float32Array per track: length = maxSamples * numChannels
    this._tracks = []; // each entry: { buf: Float32Array, writeIndex, totalWritten, recording, overdubs: [ {startFrame, lengthFrames, buffer} ] , currentOverdubStartFrame }
    for (let t = 0; t < this._numTracks; t++) {
      this._tracks.push(this._makeEmptyTrack());
    }

    // processed frames counter (used for scheduling)
    this._processedFrames = 0;

    // scheduled actions keyed by track
    // format: { startFrame: <frameIndex> (abs), stopFrame: <frameIndex> (abs) }
    this._schedule = new Map();

    // messages from main thread
    this.port.onmessage = (ev) => this._onMessage(ev.data);

    // small perf counters for diagnostics (optional)
    this._processCallCount = 0;
  }

  _makeEmptyTrack() {
    return {
      buf: new Float32Array(this._maxSamples * this._numChannels),
      writeIndex: 0,           // next write position (in frames)
      totalWritten: 0,         // frames written since track reset (grows until maxSamples)
      recording: false,
      overdubs: [],            // array of overdub metadata {startFrame, length, buffer}
      currentOverdubStart: null // frame index when current overdub started, null if not overdubbing
    };
  }

  _ensureTrackCount(n) {
    if (n <= this._tracks.length) return;
    for (let i = this._tracks.length; i < n; i++) {
      this._tracks.push(this._makeEmptyTrack());
    }
    this._numTracks = n;
  }

  _ensureChannels(n) {
    if (n === this._numChannels) return;
    // Recreate buffers to match new channel count
    this._numChannels = n;
    this._maxSamples = Math.floor(this._sampleRate * this._maxSecondsPerTrack);
    for (let t = 0; t < this._tracks.length; t++) {
      const old = this._tracks[t];
      // create new buffer and copy what fits (best-effort)
      const newBuf = new Float32Array(this._maxSamples * this._numChannels);
      const framesToCopy = Math.min(old.totalWritten, this._maxSamples);
      for (let f = 0; f < framesToCopy; f++) {
        for (let ch = 0; ch < Math.min(this._numChannels, old.buf.length / this._maxSamples); ch++) {
          const oldIdx = ((f % this._maxSamples) * (old.buf.length / this._maxSamples)) + ch;
          const newIdx = (f * this._numChannels) + ch;
          newBuf[newIdx] = old.buf[oldIdx] || 0;
        }
      }
      this._tracks[t].buf = newBuf;
      this._tracks[t].writeIndex = framesToCopy % this._maxSamples;
      this._tracks[t].totalWritten = framesToCopy;
    }
  }

  _onMessage(msg) {
    // Supported messages:
    // {cmd:'configure', numTracks, numChannels, maxSecondsPerTrack}
    // {cmd:'start', track: i}           - immediate start recording on track i
    // {cmd:'stop', track: i}            - immediate stop recording on track i
    // {cmd:'scheduleStart', track: i, when: audioContextTimeSeconds} - schedule sample-accurate start
    // {cmd:'scheduleStop', track: i, when: audioContextTimeSeconds}
    // {cmd:'startOverdub', track: i}
    // {cmd:'stopOverdub', track: i}
    // {cmd:'undoOverdub', track: i}
    // {cmd:'dump', track: i}
    // {cmd:'clear', track: i}
    const c = msg.cmd;
    if (c === 'configure') {
      if (msg.numTracks) this._ensureTrackCount(msg.numTracks);
      if (msg.numChannels) this._ensureChannels(msg.numChannels);
      if (msg.maxSecondsPerTrack) {
        this._maxSecondsPerTrack = msg.maxSecondsPerTrack;
        this._maxSamples = Math.floor(this._sampleRate * this._maxSecondsPerTrack);
        // rebuild buffers
        for (let t=0;t<this._tracks.length;t++) {
          this._tracks[t].buf = new Float32Array(this._maxSamples * this._numChannels);
          this._tracks[t].writeIndex = 0;
          this._tracks[t].totalWritten = 0;
          this._tracks[t].overdubs = [];
          this._tracks[t].recording = false;
        }
      }
      this.port.postMessage({ type: 'configured', numTracks: this._tracks.length, numChannels: this._numChannels, maxSeconds: this._maxSecondsPerTrack });
      return;
    }

    if (c === 'start') {
      const tr = this._tracks[msg.track || 0];
      tr.recording = true;
      tr.currentOverdubStart = null; // not overdub by default
      this.port.postMessage({ type: 'started', track: msg.track || 0 });
      return;
    }

    if (c === 'stop') {
      const tr = this._tracks[msg.track || 0];
      tr.recording = false;
      // if we were overdubbing, end overdub and capture buffer
      if (tr.currentOverdubStart !== null) {
        this._finalizeOverdub(msg.track || 0);
      }
      this.port.postMessage({ type: 'stopped', track: msg.track || 0, totalFrames: tr.totalWritten });
      return;
    }

    if (c === 'scheduleStart') {
      // when is audioContext.currentTime seconds (from main thread)
      const when = msg.when;
      const frame = Math.round(when * this._sampleRate);
      this._schedule.set(msg.track || 0, this._schedule.get(msg.track || 0) || {});
      this._schedule.get(msg.track || 0).startFrame = frame;
      this.port.postMessage({ type: 'scheduledStart', track: msg.track || 0, atFrame: frame });
      return;
    }

    if (c === 'scheduleStop') {
      const when = msg.when;
      const frame = Math.round(when * this._sampleRate);
      this._schedule.set(msg.track || 0, this._schedule.get(msg.track || 0) || {});
      this._schedule.get(msg.track || 0).stopFrame = frame;
      this.port.postMessage({ type: 'scheduledStop', track: msg.track || 0, atFrame: frame });
      return;
    }

    if (c === 'startOverdub') {
      const idx = msg.track || 0;
      const tr = this._tracks[idx];
      // mark overdub start at next processed frame
      tr.currentOverdubStart = this._processedFrames;
      tr.recording = true; // keep recording on for overdub writes
      this.port.postMessage({ type: 'overdubStarted', track: idx, atFrame: tr.currentOverdubStart });
      return;
    }

    if (c === 'stopOverdub') {
      const idx = msg.track || 0;
      const tr = this._tracks[idx];
      tr.recording = false;
      if (tr.currentOverdubStart !== null) {
        this._finalizeOverdub(idx);
      }
      this.port.postMessage({ type: 'overdubStopped', track: idx });
      return;
    }

    if (c === 'undoOverdub') {
      const idx = msg.track || 0;
      const tr = this._tracks[idx];
      if (tr.overdubs.length === 0) {
        this.port.postMessage({ type: 'undoFailed', reason: 'no-overdubs', track: idx });
        return;
      }
      // Remove last overdub and subtract its samples from main buffer
      const last = tr.overdubs.pop();
      // last: { startFrame, length, buffer (Float32Array length length*channels) }
      this._applyUndoOverdub(idx, last);
      this.port.postMessage({ type: 'undoDone', track: idx });
      return;
    }

    if (c === 'dump') {
      const idx = msg.track || 0;
      this._dumpTrack(idx);
      return;
    }

    if (c === 'clear') {
      const idx = msg.track || 0;
      this._tracks[idx] = this._makeEmptyTrack();
      this.port.postMessage({ type: 'cleared', track: idx });
      return;
    }
  }

  _finalizeOverdub(trackIndex) {
    const tr = this._tracks[trackIndex];
    const startFrame = tr.currentOverdubStart;
    const endFrame = this._processedFrames;
    let lengthFrames = endFrame - startFrame;
    if (lengthFrames <= 0) {
      tr.currentOverdubStart = null;
      return;
    }
    if (lengthFrames > this._maxSamples) {
      lengthFrames = this._maxSamples;
    }
    // allocate buffer for overdub copy (transferable to main when needed)
    const buf = new Float32Array(lengthFrames * this._numChannels);
    // copy from ring buffer into linear buffer (handle wrap)
    for (let f = 0; f < lengthFrames; f++) {
      const srcFrame = (startFrame + f) % this._maxSamples;
      for (let ch = 0; ch < this._numChannels; ch++) {
        buf[f * this._numChannels + ch] = tr.buf[(srcFrame * this._numChannels) + ch];
      }
    }
    tr.overdubs.push({ startFrame, lengthFrames, buffer: buf });
    tr.currentOverdubStart = null;
  }

  _applyUndoOverdub(trackIndex, overdub) {
    const tr = this._tracks[trackIndex];
    const { startFrame, lengthFrames, buffer } = overdub;
    // subtract overdub buffer from ring buffer (simple undo assuming overdub was additive)
    for (let f = 0; f < lengthFrames; f++) {
      const dstFrame = (startFrame + f) % this._maxSamples;
      for (let ch = 0; ch < this._numChannels; ch++) {
        const i = (dstFrame * this._numChannels) + ch;
        tr.buf[i] -= buffer[f * this._numChannels + ch];
      }
    }
  }

  _dumpTrack(idx) {
    const tr = this._tracks[idx];
    // compute frames to dump = min(totalWritten, maxSamples)
    const frames = Math.min(tr.totalWritten, this._maxSamples);
    // allocate linear buffer to transfer
    const out = new Float32Array(frames * this._numChannels);
    // If writeIndex has wrapped, data is from writeIndex .. end, then 0..writeIndex-1
    let firstPart = 0;
    if (tr.totalWritten >= this._maxSamples) {
      // completely filled and wrapped; newest data is the last maxSamples frames
      // so the logical sequence starts at tr.writeIndex
      firstPart = this._maxSamples - tr.writeIndex;
      // copy from writeIndex .. end
      for (let f = 0; f < firstPart; f++) {
        const src = (tr.writeIndex + f);
        for (let ch = 0; ch < this._numChannels; ch++) {
          out[f * this._numChannels + ch] = tr.buf[src * this._numChannels + ch];
        }
      }
      // copy the remainder from 0 .. writeIndex-1
      for (let f = 0; f < tr.writeIndex; f++) {
        const dstIdx = firstPart + f;
        for (let ch = 0; ch < this._numChannels; ch++) {
          out[dstIdx * this._numChannels + ch] = tr.buf[f * this._numChannels + ch];
        }
      }
    } else {
      // no wrap, data from 0 .. writeIndex-1
      for (let f = 0; f < frames; f++) {
        for (let ch = 0; ch < this._numChannels; ch++) {
          out[f * this._numChannels + ch] = tr.buf[f * this._numChannels + ch];
        }
      }
    }
    // send transferable
    this.port.postMessage({ type: 'dump', track: idx, frames: frames, channels: this._numChannels, sampleRate: this._sampleRate, buffer: out }, [out.buffer]);
  }

  process(inputs, outputs, params) {
    this._processCallCount++;
    const input = inputs[0];
    const frames = (input && input[0]) ? input[0].length : 128;

    // If input exists, adapt channel count if needed
    const realChannels = input && input.length ? input.length : this._numChannels;
    if (realChannels !== this._numChannels) {
      // adjust if input channel count changed (rare)
      this._ensureChannels(realChannels);
    }

    // For each track, check schedule start/stop
    for (let [trackIdx, schedule] of this._schedule.entries()) {
      if (schedule && schedule.startFrame !== undefined && this._processedFrames >= schedule.startFrame) {
        const tr = this._tracks[trackIdx];
        tr.recording = true;
        // mark current overdub start if requested (we treat scheduleStart as simple record start)
        tr.currentOverdubStart = tr.currentOverdubStart === null ? this._processedFrames : tr.currentOverdubStart;
        // remove scheduled start so it only triggers once
        delete schedule.startFrame;
      }
      if (schedule && schedule.stopFrame !== undefined && this._processedFrames >= schedule.stopFrame) {
        const tr = this._tracks[trackIdx];
        tr.recording = false;
        if (tr.currentOverdubStart !== null) this._finalizeOverdub(trackIdx);
        delete schedule.stopFrame;
      }
    }

    if (input && input.length) {
      // Write input frames to all tracks that are recording
      // We iterate frames and channels and copy into each recording track's buffer
      for (let f = 0; f < frames; f++) {
        for (let ch = 0; ch < this._numChannels; ch++) {
          const sample = (input[ch] && input[ch][f] !== undefined) ? input[ch][f] : 0;
          for (let t = 0; t < this._tracks.length; t++) {
            const tr = this._tracks[t];
            if (tr.recording) {
              const writeFrame = tr.writeIndex % this._maxSamples;
              const idx = (writeFrame * this._numChannels) + ch;
              // If overdubbing, additive mix; otherwise overwrite
              if (tr.currentOverdubStart !== null && tr.currentOverdubStart <= this._processedFrames) {
                // overdub: add to existing buffer
                tr.buf[idx] += sample;
              } else {
                // normal record: overwrite
                tr.buf[idx] = sample;
              }
            }
          }
        }
        // advance writeIndex/totalWritten for tracks that are writing
        for (let t = 0; t < this._tracks.length; t++) {
          const tr = this._tracks[t];
          if (tr.recording) {
            tr.writeIndex = (tr.writeIndex + 1) % this._maxSamples;
            tr.totalWritten = Math.min(tr.totalWritten + 1, this._maxSamples);
          }
        }
        this._processedFrames++;
      }
    } else {
      // no input - still advance processedFrames by frames to maintain scheduler progress
      this._processedFrames += frames;
    }

    // We are a recorder-only processor; pass-through output is silence (or we could support monitoring)
    const output = outputs[0];
    if (output && output.length) {
      for (let ch = 0; ch < output.length; ch++) {
        const outCh = output[ch];
        for (let i = 0; i < outCh.length; i++) outCh[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
