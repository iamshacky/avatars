// Very small DOM renderer that manipulates a #mouth element's height.
export class Dom2DRenderer {
  constructor(rootEl) {
    this.mouthEl = rootEl.querySelector('#mouth');
  }
  setMouthOpen(amount) {
    const min = 10, max = 100;
    const h = Math.round(min + (max - min) * amount);
    this.mouthEl.style.height = `${h}px`;
  }
  render() {}
}
