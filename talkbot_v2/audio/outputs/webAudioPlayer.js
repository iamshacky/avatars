// Unified playback + analyser hookup for the browser.
export class WebAudioPlayer {
  constructor(audioEl) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.audioEl = audioEl;
    this.src = this.ctx.createMediaElementSource(audioEl);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.7; // nicer for mouths
    this.src.connect(this.analyser);
    this.analyser.connect(this.ctx.destination); // or skip to mute
  }
  async play(urlOrArrayBuffer) {
    await this.ctx.resume();
    if (typeof urlOrArrayBuffer === 'string') {
      this.audioEl.src = urlOrArrayBuffer;
      await this.audioEl.play();
    } else {
      // if you later fetch bytes manually and want to decode -> MediaSource route
      const blob = new Blob([urlOrArrayBuffer]);
      this.audioEl.src = URL.createObjectURL(blob);
      await this.audioEl.play();
    }
  }
  getAnalyser() { return this.analyser; }
}
