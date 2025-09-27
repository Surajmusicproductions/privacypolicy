// recorder-processor.js
// AudioWorkletProcessor for frame-accurate recording and dumping of audio blocks.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffers = [];           // Collected audio blocks (each is [channel][Float32Array])
    this._recording = false;
    this._armedFrame = null;      // Frame index to start recording
    this._stopFrame = null;       // Frame index to stop recording
    this._frameCounter = 0;       // Global frame index in context
    this._firstBlockFrame = null; // Frame index of first stored block
    this.port.onmessage = (e) => {
      const data = e.data || {};
      if (data.cmd === 'reset') {
        // Clear buffer state (keep frame counter running)
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
        // Dump all recorded samples to the main thread
        const numBlocks = this._buffers.length;
        if (numBlocks === 0) {
          // No data: send empty reply
          this.port.postMessage({
            cmd: 'dump',
            channels: [], length: 0, sampleRate: sampleRate,
            firstBlockFrame: this._firstBlockFrame,
            startedAtFrame: this._armedFrame,
            stoppedAtFrame: this._stopFrame
          });
        } else {
          const numCh = this._buffers[0].length;
          const blockFrames = this._buffers[0][0].length;
          const totalFrames = numBlocks * blockFrames;
          // Allocate arrays for each channel
          const channels = Array.from({length: numCh}, () => new Float32Array(totalFrames));
          let offset = 0;
          for (let block of this._buffers) {
            for (let ch = 0; ch < numCh; ch++) {
              channels[ch].set(block[ch], offset);
            }
            offset += blockFrames;
          }
          // Send transfer message
          this.port.postMessage({
            cmd: 'dump',
            channels: channels,
            length: totalFrames,
            sampleRate: sampleRate,
            firstBlockFrame: this._firstBlockFrame,
            startedAtFrame: this._armedFrame,
            stoppedAtFrame: this._stopFrame
          }, channels.map(c => c.buffer));
        }
      }
    };
  }

  process(inputs) {
    const input = inputs[0]; // Array of channels
    const blockFrames = (input && input[0]) ? input[0].length : 128;
    const blockStart = this._frameCounter;
    const blockEnd = this._frameCounter + blockFrames;

    // Check if we should start recording in this block
    if (!this._recording && this._armedFrame !== null) {
      if ((this._armedFrame >= blockStart && this._armedFrame < blockEnd)
          || (this._armedFrame < blockStart)) {
        this._recording = true;
      }
    }

    // If recording, copy the audio block
    if (this._recording && input.length > 0) {
      const copy = input.map(ch => new Float32Array(ch));
      if (this._firstBlockFrame === null) {
        this._firstBlockFrame = blockStart;
      }
      this._buffers.push(copy);
    }

    // Check if we should stop recording in this block
    if (this._recording && this._stopFrame !== null) {
      if ((this._stopFrame >= blockStart && this._stopFrame < blockEnd)
          || (this._stopFrame <= blockStart)) {
        // Stop recording (capture this block fully then stop)
        this._recording = false;
      }
    }

    this._frameCounter += blockFrames;
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
