// recorder.js
// LooperRecorder: simple AudioWorklet-based recorder wrapper for low-latency overdub capture.
// Single-file: creates an AudioWorklet module from a blob and exposes LooperRecorder class.
// Usage:
//   const R = new LooperRecorder(audioCtx, micSource, { channels:1 });
//   R.ondata = (channelsArr) => { /* channelsArr[0] = Float32Array of samples */ };
//   await R.init();
//   R.start();         // start buffering (prerecord)
//   R.markStart();     // mark the exact start boundary (audioCtx.currentTime used by caller)
//   R.stop();          // stop & flush -> calls ondata
//
// Notes: the worklet sends fixed-size frames (128 samples per channel per process call).
// We accumulate frames in the worklet and in main thread; on stop we concatenate and call ondata.
// This avoids MediaRecorder chunking latency and gives sample arrays you can merge into loopBuffer.

(function(global){
  'use strict';

  // audio worklet processor source as a string (kept minimal & robust)
  const workletCode = `
  class LooperRecorderProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this._buffers = []; // array of ArrayBuffers (Float32) per channel concatenation (main-thread-friendly)
      this._channels = (options.processorOptions && options.processorOptions.channels) ? options.processorOptions.channels : 1;
      this._frameCount = 0;
      this._markPositions = []; // time-stamps (in render frames) when markStart is called
      this.port.onmessage = (ev) => {
        const d = ev.data;
        if (!d) return;
        if (d.cmd === 'clear') {
          this._buffers = [];
          this._frameCount = 0;
          this._markPositions = [];
        } else if (d.cmd === 'flush') {
          // send all buffered data (transferably)
          // Interleave by channel into single ArrayBuffer per channel for transfer
          const r = { cmd:'flush-data', channels: [] };
          if (this._frameCount === 0) {
            this.port.postMessage(r);
            return;
          }
          // Build per-channel Float32Array
          const perChan = [];
          for (let c=0;c<this._channels;c++){
            perChan[c] = new Float32Array(this._frameCount);
          }
          // _buffers is array of frames: each frame is Float32Array[numberOfChannels * 128] or nested arrays.
          // We stored frames as Intact nested arrays per process push (see below).
          let writeIndex = 0;
          for (let frame of this._buffers){
            // frame is an array of channel Float32Arrays (frame[ch] length = 128)
            const frameLen = frame[0].length;
            for (let ch=0; ch<this._channels; ch++){
              const src = frame[ch] || frame[0];
              perChan[ch].set(src, writeIndex);
            }
            writeIndex += frameLen;
          }
          // Transfer per-channel ArrayBuffers
          for (let ch=0; ch<this._channels; ch++){
            r.channels.push(perChan[ch].buffer);
          }
          // Send with transfer for speed
          this.port.postMessage(r, r.channels);
          // Clear after flush
          this._buffers = [];
          this._frameCount = 0;
          this._markPositions = [];
        } else if (d.cmd === 'markStart') {
          // record a marker: number of samples so far (we'll convert in main thread)
          this._markPositions.push(this._frameCount);
        } else if (d.cmd === 'setChannels') {
          this._channels = d.channels || this._channels;
        }
      };
    }

    process(inputs, outputs, parameters) {
      // inputs[0] -> input connected (micSource)
      const ins = inputs[0];
      if (!ins || ins.length === 0) {
        return true;
      }
      const channelCount = Math.min(this._channels, ins.length);
      // Copy current block into small Float32Arrays per channel
      const block = [];
      const frameLen = ins[0].length; // typically 128
      for (let ch = 0; ch < channelCount; ch++){
        // copy to avoid sharing underlying memory
        const copy = new Float32Array(frameLen);
        copy.set(ins[ch]);
        block.push(copy);
      }
      // If requested channels > available, duplicate channel 0
      if (channelCount < this._channels) {
        for (let ch = channelCount; ch < this._channels; ch++){
          const copy = new Float32Array(frameLen);
          copy.set(ins[0] || new Float32Array(frameLen));
          block.push(copy);
        }
      }
      this._buffers.push(block);
      this._frameCount += frameLen;
      // keep growing; main thread will flush on stop
      return true;
    }
  }

  registerProcessor('looper-recorder-processor', LooperRecorderProcessor);
  `;

  class LooperRecorder {
    constructor(audioCtx, micSourceNode, opts = {}) {
      if (!audioCtx) throw new Error('audioCtx required');
      if (!micSourceNode) throw new Error('micSource required');
      this.audioCtx = audioCtx;
      this.mic = micSourceNode;
      this.channels = opts.channels || 1;
      this._node = null;
      this._connected = false;
      this.ondata = null; // callback: (channelsFloat32Array) => {}
      this._inited = false;
      this._lastFlushTime = 0;
      this._autoFlushMs = opts.autoFlushMs || 0; // if >0, main thread will request periodic flush (not used by default)
      this._workletUrl = null;
      this._pendingBuffers = []; // in rare cases we might receive multiple flushes; we concat
      this._pendingResolve = null;
      this._isRecording = false;
    }

    async init() {
      if (this._inited) return;
      // create blob URL for worklet code and addModule
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this._workletUrl = url;
      // addModule may throw if AudioWorklet not supported
      await this.audioCtx.audioWorklet.addModule(url);
      // instantiate node
      this._node = new AudioWorkletNode(this.audioCtx, 'looper-recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: this.channels,
        processorOptions: { channels: this.channels }
      });
      // message handler: handle flush-data messages (ArrayBuffers per channel)
      this._node.port.onmessage = (ev) => {
        const d = ev.data;
        if (!d) return;
        if (d.cmd === 'flush-data') {
          // reconstruct Float32Array per channel from transferred buffers
          const channels = (d.channels || []).map(buf => new Float32Array(buf));
          // push to pending and call ondata if stop() requested
          if (this.ondata) {
            // call asynchronously to avoid blocking audio thread
            try { this.ondata(channels); } catch (err) { console.error('ondata handler error', err); }
          } else {
            this._pendingBuffers.push(channels);
          }
        }
      };
      // wire micSource -> worklet (record raw mic BEFORE any global FX)
      // IMPORTANT: the caller should ensure they pass the micSource that is not routed through playback monitor.
      this.mic.connect(this._node);
      // Do NOT connect node to destination (it must not produce audible sound)
      this._connected = true;
      this._inited = true;
    }

    // Start buffering (prerecord)
    start() {
      if (!this._inited) throw new Error('init first');
      // clear previous buffers in processor
      this._node.port.postMessage({ cmd: 'clear' });
      this._isRecording = true;
    }

    // markStart: record marker inside worklet -> main thread can compute exact sample-aligned index
    markStart() {
      if (!this._inited) throw new Error('init first');
      // markStart stores the current accumulated sample count (frameCount) inside the worklet
      this._node.port.postMessage({ cmd: 'markStart' });
    }

    // stop & flush - triggers ondata callback (main thread receives ArrayBuffer per channel)
    stop() {
      if (!this._inited) throw new Error('init first');
      // ask worklet to flush now (worklet will postMessage with 'flush-data')
      this._node.port.postMessage({ cmd: 'flush' });
      this._isRecording = false;
    }

    // convenience: disconnect & release
    destroy() {
      try {
        if (this._node) {
          try { this.mic.disconnect(this._node); } catch(e) {}
          try { this._node.port.postMessage({cmd:'clear'}); } catch(e){}
          try { this._node.disconnect(); } catch(e){}
          this._node = null;
        }
      } catch (e) { /* ignore */ }
      if (this._workletUrl) {
        try { URL.revokeObjectURL(this._workletUrl); } catch (e) {}
        this._workletUrl = null;
      }
      this._inited = false;
    }
  }

  // Export to global namespace as LooperRecorder
  global.LooperRecorder = LooperRecorder;

})(window);
