/** Fully synthesised soundscape: nothing to download, and everything follows the real weather numbers. */
export class Soundscape {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rainGain!: GainNode;
  private humGain!: GainNode;
  private noise!: AudioBuffer;
  private birdTimer = 2;
  private cricketGain!: GainNode;

  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ctx.destination);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const data = noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2 + white * 0.08;
    }
    this.noise = noise;
    const loop = (filter: BiquadFilterNode) => {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      source.connect(filter);
      source.start();
    };
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 340;
    this.windFilter.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter.connect(this.windGain).connect(this.master);
    loop(this.windFilter);
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = "highpass";
    rainFilter.frequency.value = 1500;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainFilter.connect(this.rainGain).connect(this.master);
    loop(rainFilter);
    const hum = ctx.createBiquadFilter();
    hum.type = "lowpass";
    hum.frequency.value = 190;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    hum.connect(this.humGain).connect(this.master);
    loop(hum);
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 17;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    const tone = ctx.createOscillator();
    tone.frequency.value = 4300;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(toneGain.gain);
    tone.connect(toneGain).connect(this.cricketGain).connect(this.master);
    lfo.start();
    tone.start();
  }

  update(dt: number, args: { volume: number; ambience: number; wind: number; rain: number; urban: number; night: number; greenery: number; temp: number; day: number; altitude: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(args.volume, t, 0.2);
    const a = args.ambience;
    this.windGain.gain.setTargetAtTime(Math.min(0.5, (args.wind * 0.03 + Math.max(0, args.altitude) * 0.002) * a), t, 0.6);
    this.windFilter.frequency.setTargetAtTime(220 + args.wind * 42 + Math.sin(t * 0.7) * 50, t, 0.6);
    this.rainGain.gain.setTargetAtTime(Math.min(0.42, Math.pow(args.rain, 0.5) * 0.12) * a, t, 0.8);
    this.humGain.gain.setTargetAtTime(args.urban * 0.5 * a, t, 1);
    this.cricketGain.gain.setTargetAtTime(args.night * args.greenery * (args.temp > 13 ? 0.014 : 0) * a, t, 2);
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 2.5 + Math.random() * 9;
      if (args.day > 0.4 && args.rain < 0.3 && args.wind < 11 && Math.random() < 0.3 + args.greenery * 0.7) this.bird(a);
    }
  }

  private bird(level: number) {
    const ctx = this.ctx!;
    const base = 2100 + Math.random() * 2400;
    const notes = 2 + Math.floor(Math.random() * 5);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.master);
    let at = ctx.currentTime;
    for (let i = 0; i < notes; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const length = 0.05 + Math.random() * 0.1;
      osc.frequency.setValueAtTime(base * (1 + Math.random() * 0.25), at);
      osc.frequency.exponentialRampToValueAtTime(base * (0.8 + Math.random() * 0.6), at + length);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.018 * level, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0005, at + length);
      osc.connect(gain).connect(pan);
      osc.start(at);
      osc.stop(at + length + 0.02);
      at += length + 0.03 + Math.random() * 0.08;
    }
  }

  private burst(frequency: number, q: number, length: number, gainValue: number, type: BiquadFilterType = "bandpass", delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    const at = ctx.currentTime + delay;
    gain.gain.setValueAtTime(gainValue, at);
    gain.gain.exponentialRampToValueAtTime(0.0003, at + length);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(at, Math.random() * 3.5);
    source.stop(at + length + 0.02);
  }

  step(surface: "erba" | "pietra" | "terra" | "tetto", wet: number, level: number) {
    const f = { erba: 1200, pietra: 650, terra: 480, tetto: 900 }[surface];
    this.burst(f * (0.85 + Math.random() * 0.3), surface === "erba" ? 0.7 : 1.5, 0.11, (surface === "pietra" ? 0.46 : 0.3) * level);
    if (wet > 0.3) this.burst(2600, 1, 0.08, 0.1 * level * wet);
  }

  shutter() {
    this.burst(3000, 2, 0.03, 0.5);
    this.burst(1600, 2, 0.05, 0.4, "bandpass", 0.07);
  }

  beep() {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 2200;
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0005, ctx.currentTime + 0.09);
    osc.connect(gain).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  }

  thunder(distance: number) {
    const delay = distance / 343;
    const level = Math.min(1, 900 / distance);
    this.burst(90, 0.4, 3.5, 1.3 * level, "lowpass", delay);
    this.burst(180, 0.5, 1.6, 0.8 * level, "lowpass", delay + 0.1);
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
