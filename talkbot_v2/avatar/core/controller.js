/*
export class AvatarController {
  constructor(renderer, analyser) {
    this.renderer = renderer;
    this.analyser = analyser;
    this.data = new Uint8Array(analyser.frequencyBinCount);
  }
  update() {
    this.analyser.getByteFrequencyData(this.data);
    // Focus on ~speech band by averaging middle bins
    const start = Math.floor(this.data.length * 0.1);
    const end   = Math.floor(this.data.length * 0.8);
    let sum = 0;
    for (let i = start; i < end; i++) sum += this.data[i];
    const avg = sum / (end - start);
    const openness = Math.min(1, avg / 140); // crude mapping 0..1
    this.renderer.setMouthOpen(openness);
  }
  render() {
    this.renderer.render();
  }
}
*/

/* Below is the replacement for the above */

// avatar/core/controller.js
export class AvatarController {
  constructor(renderer, analyser) {
    this.renderer = renderer;
    this.analyser = analyser;
    this.data = new Uint8Array(analyser.frequencyBinCount);
    this.level = 0; // smoothed 0..1
    this.attack = 0.25; // faster rise
    this.release = 0.08; // slower fall
    this.noiseGate = 0.02; // ignore tiny noise
  }

  update() {
    this.analyser.getByteFrequencyData(this.data);

    // Determine bin range ≈ 200–4000 Hz (speech band)
    const sr = this.analyser.context.sampleRate;            // e.g., 48000
    const n = this.analyser.frequencyBinCount;              // e.g., 256
    const hzPerBin = (sr / 2) / n;                          // Nyquist / bins
    const startHz = 200, endHz = 4000;
    const start = Math.max(0, Math.floor(startHz / hzPerBin));
    const end   = Math.min(n - 1, Math.ceil(endHz / hzPerBin));

    // Compute RMS in that band (scale 0..1)
    let sumSquares = 0;
    let count = 0;
    for (let i = start; i <= end; i++) {
      const v = this.data[i] / 255; // 0..1
      sumSquares += v * v;
      count++;
    }
    const rms = count ? Math.sqrt(sumSquares / count) : 0;

    // Noise gate
    const gated = rms <= this.noiseGate ? 0 : (rms - this.noiseGate) / (1 - this.noiseGate);

    // Attack/decay smoothing
    const a = this.attack, r = this.release;
    const target = Math.min(1, Math.max(0, gated * 1.35)); // slight gain
    this.level = target > this.level
      ? this.level + (target - this.level) * a
      : this.level + (target - this.level) * r;

    this.renderer.setMouthOpen(this.level);
  }

  render() {
    this.renderer.render();
  }
}

