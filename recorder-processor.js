// recorder-processor.js
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffers = [];
    this._recording = false;
    this._armedFrame = null;
    this._stopFrame = null;
    this._frameCounter = 0;
    this._firstBlockFrame = null;
    this.port.onmessage = (e) => {
      const data = e.data || {};
      if (data.cmd === 'reset') {
        this._buffers = [];
        this._recording = false;
        this._armedFrame = null;
        this._stopFrame = null;
        this._firstBlockFrame = null;
      } else if (data.cmd === 'armAtFrame') {
        this._armedFrame = Number(data.frame);
      } else if (data.cmd === 'stopAtFrame') {
        this._stopFrame = Number(data.frame);
      } else if (data.cmd === 'dump') {
        const numBlocks = this._buffers.length;
        if (!numBlocks) {
          this.port.postMessage({
            cmd: 'dump',
            channels: [],
            length: 0,
            sampleRate: sampleRate,
            firstBlockFrame: this._firstBlockFrame,
            startedAtFrame: this._armedFrame,
            stoppedAtFrame: this._stopFrame
          });
          this._buffers = [];
          this._firstBlockFrame = null;
          this._recording = false;
          this._armedFrame = null;
          this._stopFrame = null;
          return;
        }
        const numCh = this._buffers[0].length;
        const blockFrames = this._buffers[0][0].length;
        const frames = numBlocks * blockFrames;
        const chans = Array.from({ length: numCh }, () => new Float32Array(frames));
        let offset = 0;
        for (const block of this._buffers) {
          for (let ch = 0; ch < numCh; ch++) {
            chans[ch].set(block[ch], offset);
          }
          offset += blockFrames;
        }
        this.port.postMessage({
          cmd: 'dump',
          channels: chans,
          length: frames,
          sampleRate: sampleRate,
          firstBlockFrame: this._firstBlockFrame,
          startedAtFrame: this._armedFrame,
          stoppedAtFrame: this._stopFrame
        }, chans.map(c => c.buffer));
        // clear internal state after dump
        this._buffers = [];
        this._firstBlockFrame = null;
        this._recording = false;
        this._armedFrame = null;
        this._stopFrame = null;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const blockFrames = (input && input[0] && input[0].length) ? input[0].length : 128;
    const blockStart = this._frameCounter;
    const blockEnd = this._frameCounter + blockFrames;

    // Decide to arm
    if (!this._recording && this._armedFrame !== null) {
      if (this._armedFrame >= blockStart && this._armedFrame < blockEnd) {
        this._recording = true;
        // notify main thread exactly where we started (first stored block frame)
        this._firstBlockFrame = blockStart;
        this.port.postMessage({ cmd: 'started', firstBlockFrame: this._firstBlockFrame, armedFrame: this._armedFrame });
      } else if (this._armedFrame < blockStart) {
        this._recording = true;
        this._firstBlockFrame = blockStart;
        this.port.postMessage({ cmd: 'started', firstBlockFrame: this._firstBlockFrame, armedFrame: this._armedFrame });
      }
    }

    if (this._recording && input && input.length) {
      const copy = input.map(ch => new Float32Array(ch));
      if (this._firstBlockFrame === null) this._firstBlockFrame = blockStart;
      this._buffers.push(copy);
    }

    // Decide to stop
    if (this._recording && this._stopFrame !== null) {
      if (this._stopFrame >= blockStart && this._stopFrame < blockEnd) {
        // will stop; still capture this block then post a stopped event
        this._recording = false;
        this.port.postMessage({ cmd: 'stopped', stoppedAtFrame: this._stopFrame, blockEnd });
      } else if (this._stopFrame <= blockStart) {
        this._recording = false;
        this.port.postMessage({ cmd: 'stopped', stoppedAtFrame: this._stopFrame, blockEnd });
      }
    }

    this._frameCounter += blockFrames;
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
