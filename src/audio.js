// Audio system: looping BGM with fade in/out + a procedurally-generated 8-bit
// SFX library tied to the live event feed and the live world state.
// Everything routes through a single AudioContext that we lazily start on the
// first user gesture (browser autoplay policy), so importing this module has
// zero side effects.
//
// SFX coverage:
//   • Per-card spawn vocals  (Knight HUH! Giant ROAR! Goblin gheegheegee!)
//   • Per-unit footsteps     (light tap → goblin, heavy thud → giant)
//   • Per-weapon hit sounds  (sword ching, arrow thwack, gun crack, etc.)
//   • Spell cast + impact    (Fireball whoosh→BOOM, Arrows triple thwip)
//   • Tower / building down  (shockwave + descending wail)
//   • King-tower wake alarm
//   • Procedural crowd       (cheer / boo / oooh murmur)
//   • Match-start fanfare    + win arpeggio / loss cadence / draw chord
//
// Performance notes:
//   • All sounds are pure synth (square / triangle / saw oscillators + filtered
//     white noise). Zero asset files for SFX; only the BGM ships as audio.
//   • At fast simulation speeds (16×/60×) we cap concurrent footsteps and
//     hits per frame and per-actor cooldowns, so a swarm + 60× speed cannot
//     blow the mixer apart.
//   • Per-key throttle keeps repeated events from doubling on the same tick.
//
// Owner cue: each player-flavored effect is pitch-shifted (P0 ×0.92, P1 ×1.10)
// so "mine vs theirs" reads without doubling the sound library.

import { CARDS } from './cards.js';

const NOTES = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00,
  A4: 440.00, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25,
  G5: 783.99, A5: 880.00, C6: 1046.5,
};

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.crowdGain = null;       // dedicated bus so we can sit crowd under SFX
    this.noiseBuffer = null;
    this.bgmAudio = null;
    this.bgmSource = null;
    this.bgmPlaying = false;
    this.muted = false;
    this.musicVolume = 0.45;
    this.sfxVolume = 0.55;
    this.fadeSeconds = 1.6;
    this.lastTriggered = new Map();   // key → performance.now() of last play
    this._readyPromise = null;
    this._fadeOutAt = 0;

    // Footstep accounting (global throttles so a swarm doesn't drown the mix).
    this._lastStepWall = 0;
    this._stepsThisFrame = 0;
    this._stepFrameStamp = 0;
    // Hit accounting (same idea — burst-cap clashes).
    this._hitsThisFrame = 0;
    this._hitFrameStamp = 0;
    // Launches (ranged fires) and deaths — same per-frame cap pattern.
    this._launchesThisFrame = 0;
    this._launchFrameStamp = 0;
    this._deathsThisFrame = 0;
    this._deathFrameStamp = 0;
  }

  ensureReady() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = (async () => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx({ latencyHint: 'interactive' });

      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.master);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxVolume;
      this.sfxGain.connect(this.master);

      // ── SFX loudness normalization ────────────────────────────────────
      // Every synth method writes into a *category bus* (footstep, voice,
      // hit, launch, death, spell, tower, crowd, match). Category gains are
      // tuned so a single nominal sound in any category lands at roughly the
      // same perceived loudness, then everything funnels through a single
      // peak limiter so layered events (Fireball + tower-down + cheer +
      // five voices in the same tick) compress gracefully instead of
      // clipping ugly. User-facing `sfxVolume` sits AFTER the limiter so
      // it scales the whole post-normalized mix.
      this.sfxLimiter = this.ctx.createDynamicsCompressor();
      this.sfxLimiter.threshold.value = -6;      // start limiting at -6 dBFS
      this.sfxLimiter.knee.value = 4;            // soft 4 dB knee
      this.sfxLimiter.ratio.value = 12;          // brick-wall-ish
      this.sfxLimiter.attack.value = 0.003;
      this.sfxLimiter.release.value = 0.12;
      this.sfxLimiter.connect(this.sfxGain);

      // Category trim values (linear gain). Picked from listening to one
      // representative effect per category at sfxVolume = 0.55:
      //   footstep ≪ voice ≈ launch ≈ hit ≈ death  <  spell <  tower
      // Crowd sits just under spells; match cues match crowd level.
      const TRIM = {
        footstep: 0.40,   // ambient, well under hits
        voice:    0.70,
        hit:      0.70,
        launch:   0.65,
        death:    0.70,
        spell:    0.85,   // impactful events
        tower:    0.95,   // biggest events
        crowd:    0.80,
        match:    0.80,   // fanfare / cadence
      };
      this.bus = {};
      for (const [name, g] of Object.entries(TRIM)) {
        const b = this.ctx.createGain();
        b.gain.value = g;
        b.connect(this.sfxLimiter);
        this.bus[name] = b;
      }
      // Back-compat alias used by older code paths.
      this.crowdGain = this.bus.crowd;

      this.noiseBuffer = this._makeNoiseBuffer(2.0);

      this._setupBgmElement();
    })();
    return this._readyPromise;
  }

  // Resolve a category name to its bus node. Falls back to the raw SFX gain
  // before ensureReady() has created the busses (e.g. if a synth method is
  // accidentally called pre-init), so no edit-time route fails silently.
  _bus(name) {
    return (this.bus && this.bus[name]) || this.sfxGain;
  }

  _setupBgmElement() {
    const a = new Audio();
    a.src = this._supportsOgg() ? 'assets/audio/bgm.ogg' : 'assets/audio/bgm.mp3';
    a.loop = true;
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    this.bgmAudio = a;
    this.bgmSource = this.ctx.createMediaElementSource(a);
    this.bgmSource.connect(this.musicGain);
  }

  _supportsOgg() {
    const a = document.createElement('audio');
    return !!a.canPlayType && a.canPlayType('audio/ogg; codecs="vorbis"') !== '';
  }

  _makeNoiseBuffer(seconds) {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * seconds), sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  setMuted(m) {
    this.muted = !!m;
    if (!this.ctx) return;
    const g = this.muted ? 0 : 1;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.linearRampToValueAtTime(g, t + 0.12);
  }

  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.bgmPlaying && this.musicGain) {
      const t = this.ctx.currentTime;
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.linearRampToValueAtTime(this.musicVolume, t + 0.15);
    }
  }

  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
  }

  // ────────────────────────── BGM ──────────────────────────

  async startBgm() {
    await this.ensureReady();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this._fadeOutAt = 0;
    try {
      if (this.bgmAudio.paused) {
        const p = this.bgmAudio.play();
        if (p && typeof p.then === 'function') await p;
      }
    } catch (e) {
      return;
    }
    this.bgmPlaying = true;
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setValueAtTime(Math.max(0.0001, this.musicGain.gain.value), t);
    this.musicGain.gain.linearRampToValueAtTime(this.musicVolume, t + this.fadeSeconds);
  }

  fadeOutBgm(stopAfter = true) {
    if (!this.ctx || !this.bgmPlaying) return;
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setValueAtTime(Math.max(0.0001, this.musicGain.gain.value), t);
    this.musicGain.gain.linearRampToValueAtTime(0.0001, t + this.fadeSeconds);
    if (stopAfter) {
      const stamp = (this._fadeOutAt = performance.now());
      setTimeout(() => {
        if (this._fadeOutAt !== stamp) return;
        try { this.bgmAudio.pause(); } catch (_) {}
        this.bgmPlaying = false;
      }, this.fadeSeconds * 1000 + 60);
    }
  }

  // ────────────────────────── low-level synth primitives ──────────────────────────

  _now(delay = 0) { return this.ctx.currentTime + delay; }

  _env(start, peak, sustain, release, t0, dest) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + start);
    if (sustain > 0) {
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.7), t0 + start + sustain);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + sustain + release);
    g.connect(dest);
    return g;
  }

  _beep({ type = 'square', freq = 440, freqEnd = null, dur = 0.12,
          attack = 0.005, release = 0.06, peak = 0.4, delay = 0, dest = null }) {
    if (!this.ctx) return;
    const t0 = this._now(delay);
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd != null) {
      o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
    }
    const sustain = Math.max(0, dur - attack - release);
    const env = this._env(attack, peak, sustain, release, t0, dest || this.sfxGain);
    o.connect(env);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  _noise({ dur = 0.2, peak = 0.4, filter = 'lowpass', freq = 1200, q = 1,
           freqEnd = null, attack = 0.005, release = 0.1, delay = 0, dest = null }) {
    if (!this.ctx) return;
    const t0 = this._now(delay);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = filter;
    bp.frequency.setValueAtTime(freq, t0);
    bp.Q.value = q;
    if (freqEnd != null) bp.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    const sustain = Math.max(0, dur - attack - release);
    const env = this._env(attack, peak, sustain, release, t0, dest || this.sfxGain);
    src.connect(bp);
    bp.connect(env);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  _ownerMul(owner) {
    if (owner === 0) return 0.92;
    if (owner === 1) return 1.10;
    return 1.0;
  }

  // ────────────────────────── spawn vocals ──────────────────────────
  // Shared shouting primitive — an oscillator (the "vocal cords") squeezed
  // through a bandpass formant filter (the "mouth shape") to give it the
  // illusion of a vowel. Tuning the formant arc over time picks the vowel:
  //   ~600Hz   → "uh"   (Knight HUH)
  //   ~1000Hz  → "ah"   (Archer Hyah)
  //   ~1500Hz  → "ee"   (Goblin gheee)
  //   ~300Hz   → "ohh"  (Giant RAARGH)

  _shout({ owner = null, pitch = 220, pitchEnd = null, dur = 0.18,
           formant = 900, formantEnd = null, q = 4, type = 'sawtooth',
           peak = 0.32, delay = 0, attack = 0.012, release = 0.08, hp = 0,
           dest = null }) {
    if (!this.ctx) return;
    const m = owner != null ? this._ownerMul(owner) : 1;
    const t0 = this._now(delay);
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(pitch * m, t0);
    if (pitchEnd != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, pitchEnd * m), t0 + dur);

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(formant, t0);
    bp.Q.value = q;
    if (formantEnd != null) bp.frequency.exponentialRampToValueAtTime(Math.max(80, formantEnd), t0 + dur);

    const sustain = Math.max(0, dur - attack - release);
    const env = this._env(attack, peak, sustain, release, t0, dest || this.sfxGain);
    o.connect(bp);
    if (hp > 0) {
      const hpf = this.ctx.createBiquadFilter();
      hpf.type = 'highpass';
      hpf.frequency.value = hp;
      bp.connect(hpf);
      hpf.connect(env);
    } else {
      bp.connect(env);
    }
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  voiceKnight(owner) {
    const dest = this._bus('voice');
    this._shout({ owner, pitch: 200, pitchEnd: 130, dur: 0.18,
                  formant: 800, formantEnd: 500, type: 'sawtooth', q: 4,
                  peak: 0.32, dest });
  }

  voiceGiant(owner) {
    // Long sub-bass ROAR with two formant peaks (mouth opening + closing).
    if (!this.ctx) return;
    const dest = this._bus('voice');
    this._shout({ owner, pitch: 75, pitchEnd: 55, dur: 0.85,
                  formant: 320, formantEnd: 180, type: 'sawtooth', q: 3.5,
                  peak: 0.36, attack: 0.05, release: 0.35, dest });
    this._noise({ dur: 0.7, peak: 0.15, filter: 'lowpass', freq: 220, freqEnd: 100,
                  attack: 0.05, release: 0.4, dest });
    this._noise({ dur: 0.12, peak: 0.10, filter: 'bandpass', freq: 350, q: 2,
                  delay: 0.7, release: 0.08, dest });
  }

  voiceArcher(owner) {
    const dest = this._bus('voice');
    this._shout({ owner, pitch: 360, pitchEnd: 290, dur: 0.14,
                  formant: 1500, formantEnd: 900, type: 'triangle', q: 5,
                  peak: 0.28, dest });
  }

  voiceMusketeer(owner) {
    const dest = this._bus('voice');
    this._shout({ owner, pitch: 290, pitchEnd: 240, dur: 0.13,
                  formant: 1100, formantEnd: 800, type: 'sawtooth', q: 5,
                  peak: 0.30, release: 0.05, dest });
  }

  voiceGoblin(owner) {
    const dest = this._bus('voice');
    for (let i = 0; i < 3; i++) {
      const wob = i % 2 === 0 ? 1.0 : 1.08;
      this._shout({
        owner, pitch: 720 * wob, pitchEnd: 880 * wob, dur: 0.07,
        formant: 1900, formantEnd: 1400, type: 'square', q: 6, peak: 0.26,
        attack: 0.004, release: 0.025, hp: 800,
        delay: i * 0.085, dest,
      });
    }
  }

  voiceMinion(owner) {
    if (!this.ctx) return;
    const dest = this._bus('voice');
    const m = this._ownerMul(owner);
    const t0 = this._now();
    const dur = 0.22;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(1300 * m, t0);
    o.frequency.exponentialRampToValueAtTime(900 * m, t0 + dur);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 22;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 90;
    lfo.connect(lfoGain);
    lfoGain.connect(o.frequency);
    const env = this._env(0.005, 0.22, dur - 0.04, 0.05, t0, dest);
    o.connect(env);
    o.start(t0); o.stop(t0 + dur + 0.05);
    lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    this._noise({ dur: 0.18, peak: 0.12, filter: 'highpass', freq: 2400,
                  attack: 0.008, release: 0.08, dest });
  }

  voiceCannon(_owner) {
    // No voice (it's a building) — heavy mechanical clank routed through
    // the launch bus since it's more "weapon" than "vocal".
    const dest = this._bus('launch');
    this._noise({ dur: 0.22, peak: 0.45, filter: 'lowpass', freq: 320,
                  freqEnd: 80, release: 0.16, dest });
    this._beep({ type: 'square', freq: 95, freqEnd: 55, dur: 0.18, peak: 0.20,
                 release: 0.12, delay: 0.02, dest });
    this._noise({ dur: 0.08, peak: 0.18, filter: 'bandpass', freq: 3200, q: 4,
                  delay: 0.04, release: 0.05, dest });
  }

  cardDeploy(owner, card) {
    const def = CARDS[card];
    const kind = def ? def.kind : 'troop';
    const m = this._ownerMul(owner);
    const dest = this._bus('voice'); // deploy thud rides with the vocal

    if (kind === 'building') {
      this._noise({ dur: 0.16, peak: 0.35, filter: 'lowpass', freq: 360 * m,
                    freqEnd: 90, release: 0.1, dest });
    } else {
      this._noise({ dur: 0.08, peak: 0.24, filter: 'lowpass', freq: 700 * m,
                    freqEnd: 200, release: 0.05, dest });
      this._beep({ type: 'triangle', freq: 220 * m, freqEnd: 330 * m, dur: 0.1,
                   peak: 0.16, release: 0.07, delay: 0.005, dest });
    }
    const voice = VOICES[card];
    if (voice) voice.call(this, owner);
  }

  // ────────────────────────── footsteps ──────────────────────────

  _stepLight(owner) {
    const dest = this._bus('footstep');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.045, peak: 0.22, filter: 'bandpass', freq: 1600 * m,
                  q: 1.2, release: 0.035, dest });
  }

  _stepMedium(owner) {
    const dest = this._bus('footstep');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.06, peak: 0.28, filter: 'lowpass', freq: 900 * m,
                  freqEnd: 380, release: 0.045, dest });
    this._beep({ type: 'triangle', freq: 80 * m, dur: 0.04, peak: 0.14,
                 release: 0.03, delay: 0.005, dest });
  }

  _stepHeavy(owner) {
    const dest = this._bus('footstep');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.18, peak: 0.45, filter: 'lowpass', freq: 600 * m,
                  freqEnd: 80, release: 0.13, dest });
    this._beep({ type: 'sawtooth', freq: 60 * m, freqEnd: 38 * m, dur: 0.13,
                 peak: 0.32, release: 0.1, dest });
  }

  // Called from the render loop with the live state. Scans all moving ground
  // units, accumulates distance since their last footstep, and emits a step
  // sound when the stride threshold is crossed. Global caps keep things sane
  // at 60× sim speed and on big swarms.
  tickFootsteps(state) {
    if (!this.ctx || !state || !state.units) return;
    const now = performance.now();
    // Reset per-frame counter on a new frame tick.
    if (this._stepFrameStamp !== now >> 0) {
      this._stepFrameStamp = now >> 0;
      this._stepsThisFrame = 0;
    }
    const MAX_PER_FRAME = 6;
    const MIN_GAP_MS = 22; // global floor between any two footstep cues
    for (const u of state.units) {
      if (this._stepsThisFrame >= MAX_PER_FRAME) break;
      if (!u || u.hp <= 0 || u._building || u.flying) continue;
      if (u.deployTimer > 0) continue;
      const prof = STEP_PROFILE[u.card];
      if (!prof) continue;
      if (!u._stepPos) { u._stepPos = { x: u.x, y: u.y }; continue; }
      const dx = u.x - u._stepPos.x;
      const dy = u.y - u._stepPos.y;
      const d = Math.hypot(dx, dy);
      if (d < prof.stride) continue;
      if (now - this._lastStepWall < MIN_GAP_MS) continue;
      u._stepPos.x = u.x;
      u._stepPos.y = u.y;
      this._lastStepWall = now;
      this._stepsThisFrame += 1;
      if (prof.weight === 'light') this._stepLight(u.owner);
      else if (prof.weight === 'heavy') this._stepHeavy(u.owner);
      else this._stepMedium(u.owner);
    }
  }

  // ────────────────────────── weapon hits ──────────────────────────

  hitKnight(owner)    { this._clashSword(owner); }
  hitGiant(owner)     { this._clashFist(owner); }
  hitGoblins(owner)   { this._clashDagger(owner); }
  hitArchers(_owner)  { this._thwack(_owner); }     // arrow strike
  hitMusketeer(owner) { this._thwack(owner, { sharp: true }); }
  hitCannon(owner)    { this._thudBoom(owner); }
  hitMinions(owner)   { this._splat(owner); }
  hitTower(owner)     { this._thwack(owner, { tower: true }); }

  _clashSword(owner) {
    const dest = this._bus('hit');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.09, peak: 0.35, filter: 'bandpass', freq: 3200 * m,
                  q: 8, attack: 0.002, release: 0.07, dest });
    this._noise({ dur: 0.13, peak: 0.20, filter: 'bandpass', freq: 1600 * m,
                  q: 6, attack: 0.002, release: 0.1, delay: 0.005, dest });
    this._beep({ type: 'square', freq: 1800 * m, freqEnd: 900 * m, dur: 0.08,
                 peak: 0.14, release: 0.06, delay: 0.005, dest });
  }

  _clashFist(owner) {
    const dest = this._bus('hit');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.16, peak: 0.42, filter: 'lowpass', freq: 700 * m,
                  freqEnd: 90, release: 0.12, dest });
    this._beep({ type: 'square', freq: 90 * m, freqEnd: 50 * m, dur: 0.12,
                 peak: 0.22, release: 0.09, dest });
  }

  _clashDagger(owner) {
    const dest = this._bus('hit');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.05, peak: 0.30, filter: 'bandpass', freq: 4200 * m,
                  q: 9, release: 0.035, dest });
    this._beep({ type: 'square', freq: 2400 * m, freqEnd: 1400 * m, dur: 0.04,
                 peak: 0.14, release: 0.03, dest });
  }

  _thwack(owner, opts = {}) {
    const dest = this._bus('hit');
    const m = this._ownerMul(owner);
    const f = opts.sharp ? 5200 * m : 3000 * m;
    this._noise({ dur: opts.tower ? 0.06 : 0.08, peak: opts.sharp ? 0.34 : 0.30,
                  filter: 'bandpass', freq: f, q: opts.sharp ? 9 : 5,
                  release: 0.06, dest });
    if (opts.sharp) {
      this._noise({ dur: 0.05, peak: 0.18, filter: 'highpass', freq: 2400,
                    release: 0.04, delay: 0.005, dest });
    }
  }

  _thudBoom(owner) {
    const dest = this._bus('hit');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.28, peak: 0.45, filter: 'lowpass', freq: 1200,
                  freqEnd: 80, release: 0.22, dest });
    this._beep({ type: 'square', freq: 130 * m, freqEnd: 55 * m, dur: 0.22,
                 peak: 0.28, release: 0.16, dest });
  }

  _splat(owner) {
    const dest = this._bus('hit');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.09, peak: 0.28, filter: 'lowpass', freq: 600 * m,
                  freqEnd: 220, release: 0.07, dest });
    this._beep({ type: 'triangle', freq: 320 * m, freqEnd: 160 * m, dur: 0.06,
                 peak: 0.14, release: 0.04, dest });
  }

  // ────────────────────────── attack launch (the "shoot/swing" sound) ──────────────────────────
  // Distinct from the *impact* sound. Fires at the attacker's position the
  // moment they release; the impact fires later when the projectile lands
  // (or instantly for melee). Melee cards add a brief swoosh prefix to the
  // clash, not a separate launch.

  launchKnight(owner) {
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.07, peak: 0.26, filter: 'bandpass', q: 2.2,
                  freq: 1800 * m, freqEnd: 700, release: 0.05, dest });
  }

  launchGiant(owner) {
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    this._shout({ owner, pitch: 95, pitchEnd: 70, dur: 0.13,
                  formant: 400, formantEnd: 260, type: 'sawtooth', q: 3,
                  peak: 0.24, attack: 0.02, release: 0.08, dest });
    this._noise({ dur: 0.09, peak: 0.12, filter: 'lowpass', freq: 500 * m,
                  freqEnd: 200, release: 0.06, dest });
  }

  launchGoblins(owner) {
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.04, peak: 0.20, filter: 'highpass', freq: 3000 * m,
                  release: 0.03, dest });
  }

  launchArchers(owner) {
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    this._beep({ type: 'triangle', freq: 320 * m, freqEnd: 160 * m, dur: 0.09,
                 peak: 0.32, attack: 0.002, release: 0.06, dest });
    this._beep({ type: 'square', freq: 640 * m, freqEnd: 320 * m, dur: 0.05,
                 peak: 0.14, release: 0.04, delay: 0.002, dest });
    this._noise({ dur: 0.05, peak: 0.12, filter: 'highpass', freq: 2400,
                  release: 0.04, dest });
  }

  launchMusketeer(owner) {
    // Gunpowder CRACK — tuned down from the 0.55+0.32 peak sum because the
    // limiter was hitting hard. The crack still reads as the sharpest hit
    // in the mix; loudness comes from the brightness, not the raw peak.
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.12, peak: 0.42, filter: 'highpass', freq: 1800,
                  attack: 0.001, release: 0.1, dest });
    this._beep({ type: 'square', freq: 180 * m, freqEnd: 70 * m, dur: 0.08,
                 peak: 0.24, release: 0.06, dest });
    this._noise({ dur: 0.18, peak: 0.10, filter: 'bandpass', q: 0.8,
                  freq: 900, freqEnd: 400, release: 0.14, delay: 0.05, dest });
  }

  launchCannon(owner) {
    // Mortar BOOM — tuned down from the worst-offender 0.65+0.38+0.18 peak
    // sum. Big-event feel is preserved by the bus trim (launch=0.65) and
    // the layered low-end thump rather than raw oscillator amplitude.
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.30, peak: 0.45, filter: 'lowpass', freq: 1400,
                  freqEnd: 80, attack: 0.002, release: 0.22, dest });
    this._beep({ type: 'square', freq: 95 * m, freqEnd: 45 * m, dur: 0.2,
                 peak: 0.28, release: 0.14, dest });
    this._beep({ type: 'sawtooth', freq: 150 * m, freqEnd: 60 * m, dur: 0.18,
                 peak: 0.14, release: 0.12, delay: 0.01, dest });
  }

  launchMinions(owner) {
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.07, peak: 0.22, filter: 'lowpass', freq: 800 * m,
                  freqEnd: 300, release: 0.05, dest });
    this._beep({ type: 'triangle', freq: 480 * m, freqEnd: 200 * m, dur: 0.05,
                 peak: 0.10, release: 0.04, dest });
  }

  launchTower(owner, towerKind) {
    const dest = this._bus('launch');
    const m = this._ownerMul(owner);
    const base = towerKind === 'king' ? 240 : 320;
    this._beep({ type: 'triangle', freq: base * m, freqEnd: base * 0.5 * m,
                 dur: 0.10, peak: 0.28, attack: 0.002, release: 0.07, dest });
    this._beep({ type: 'square', freq: base * 2 * m, freqEnd: base * m,
                 dur: 0.06, peak: 0.12, release: 0.05, delay: 0.002, dest });
    this._noise({ dur: 0.06, peak: 0.10, filter: 'highpass', freq: 2200,
                  release: 0.05, dest });
  }

  tickLaunches(state) {
    if (!this.ctx || !state || !state.effects) return;
    const now = performance.now();
    if (this._launchFrameStamp !== now >> 0) {
      this._launchFrameStamp = now >> 0;
      this._launchesThisFrame = 0;
    }
    const MAX_PER_FRAME = 8;
    for (const e of state.effects) {
      if (this._launchesThisFrame >= MAX_PER_FRAME) break;
      if (e.kind !== 'launch' || e._sfxPlayed) continue;
      e._sfxPlayed = true;
      this._launchesThisFrame += 1;
      const card = e.card || 'Tower';
      const key = `launch:${e.owner}:${card}:${e.towerKind || ''}`;
      const last = this.lastTriggered.get(key) || 0;
      // 60 ms per-attacker floor — keeps a 0.9 s hitSpeed unit (Archers)
      // crystal-clear while killing duplicates in the same frame burst.
      if (now - last < 60) continue;
      this.lastTriggered.set(key, now);
      const fn = this[`launch${card}`];
      if (typeof fn === 'function') fn.call(this, e.owner, e.towerKind);
    }
  }

  // ────────────────────────── deaths (per-card scream / grunt) ──────────────────────────

  deathKnight(owner) {
    const dest = this._bus('death');
    this._shout({ owner, pitch: 220, pitchEnd: 90, dur: 0.32,
                  formant: 900, formantEnd: 400, type: 'sawtooth', q: 4,
                  peak: 0.36, attack: 0.01, release: 0.2, dest });
    this._noise({ dur: 0.12, peak: 0.14, filter: 'lowpass', freq: 600,
                  freqEnd: 120, release: 0.09, delay: 0.05, dest });
  }

  deathGiant(owner) {
    // Big death moan + body slam. Layers tuned so the moan and the slam
    // don't both peak at the same time (slam is 0.7s after moan starts).
    const dest = this._bus('death');
    this._shout({ owner, pitch: 80, pitchEnd: 38, dur: 0.95,
                  formant: 360, formantEnd: 140, type: 'sawtooth', q: 3,
                  peak: 0.38, attack: 0.05, release: 0.4, dest });
    this._noise({ dur: 0.8, peak: 0.14, filter: 'lowpass', freq: 180,
                  release: 0.35, delay: 0.05, dest });
    this._noise({ dur: 0.32, peak: 0.38, filter: 'lowpass', freq: 240,
                  freqEnd: 60, attack: 0.002, release: 0.22, delay: 0.7, dest });
    this._beep({ type: 'sawtooth', freq: 60, freqEnd: 30, dur: 0.25,
                 peak: 0.24, release: 0.18, delay: 0.72, dest });
  }

  deathArchers(owner) {
    const dest = this._bus('death');
    this._shout({ owner, pitch: 480, pitchEnd: 340, dur: 0.22,
                  formant: 1700, formantEnd: 1100, type: 'triangle', q: 6,
                  peak: 0.32, attack: 0.005, release: 0.14, dest });
  }

  deathGoblins(owner) {
    const dest = this._bus('death');
    this._shout({ owner, pitch: 600, pitchEnd: 1100, dur: 0.08,
                  formant: 2000, formantEnd: 2400, type: 'square', q: 7,
                  peak: 0.28, attack: 0.003, release: 0.05, hp: 800, dest });
    this._shout({ owner, pitch: 900, pitchEnd: 420, dur: 0.12,
                  formant: 2200, formantEnd: 1200, type: 'square', q: 7,
                  peak: 0.26, attack: 0.003, release: 0.08, hp: 800,
                  delay: 0.08, dest });
  }

  deathMusketeer(owner) {
    const dest = this._bus('death');
    this._shout({ owner, pitch: 380, pitchEnd: 220, dur: 0.28,
                  formant: 1300, formantEnd: 700, type: 'sawtooth', q: 5,
                  peak: 0.34, attack: 0.008, release: 0.18, dest });
  }

  deathMinions(owner) {
    const dest = this._bus('death');
    const m = this._ownerMul(owner);
    this._beep({ type: 'square', freq: 1400 * m, freqEnd: 350 * m, dur: 0.22,
                 peak: 0.26, attack: 0.005, release: 0.16, dest });
    this._noise({ dur: 0.15, peak: 0.12, filter: 'highpass', freq: 2000,
                  release: 0.1, delay: 0.05, dest });
  }

  deathCannon(owner) {
    const dest = this._bus('death');
    const m = this._ownerMul(owner);
    this._noise({ dur: 0.35, peak: 0.40, filter: 'bandpass', q: 3,
                  freq: 1400 * m, freqEnd: 300, attack: 0.005, release: 0.25, dest });
    this._beep({ type: 'sawtooth', freq: 220 * m, freqEnd: 70 * m, dur: 0.28,
                 peak: 0.22, release: 0.18, dest });
    this._noise({ dur: 0.16, peak: 0.15, filter: 'highpass', freq: 2400,
                  release: 0.1, delay: 0.1, dest });
  }

  tickDeaths(state) {
    if (!this.ctx || !state || !state.effects) return;
    const now = performance.now();
    if (this._deathFrameStamp !== now >> 0) {
      this._deathFrameStamp = now >> 0;
      this._deathsThisFrame = 0;
    }
    // Deaths cluster in time (spell wipes!), so cap a bit lower than other
    // surfaces — 4 distinct death cues per frame is plenty to read a wipe.
    const MAX_PER_FRAME = 4;
    for (const e of state.effects) {
      if (this._deathsThisFrame >= MAX_PER_FRAME) break;
      if (e.kind !== 'death' || e._sfxPlayed) continue;
      e._sfxPlayed = true;
      this._deathsThisFrame += 1;
      const card = e.card;
      if (!card) continue;
      const key = `death:${e.owner}:${card}`;
      const last = this.lastTriggered.get(key) || 0;
      // 90 ms per-card floor so a Goblin pack dying in one Fireball still
      // gives you ONE clear squeak rather than four overlapping ones.
      if (now - last < 90) continue;
      this.lastTriggered.set(key, now);
      const fn = this[`death${card}`];
      if (typeof fn === 'function') fn.call(this, e.owner);
    }
  }

  // Process new hit effects since `cursor`. Each effect carries attackerCard
  // (set by the engine). We mark `_sfxPlayed` on the effect so the same hit
  // doesn't fire again next frame. Heavily throttled at fast sim speeds.
  tickHits(state) {
    if (!this.ctx || !state || !state.effects) return;
    const now = performance.now();
    if (this._hitFrameStamp !== now >> 0) {
      this._hitFrameStamp = now >> 0;
      this._hitsThisFrame = 0;
    }
    const MAX_PER_FRAME = 8;
    for (const e of state.effects) {
      if (this._hitsThisFrame >= MAX_PER_FRAME) break;
      if (e.kind !== 'hit' || e._sfxPlayed) continue;
      e._sfxPlayed = true;
      this._hitsThisFrame += 1;
      const card = e.attackerCard || 'Tower';
      const key = `hit:${e.owner}:${card}`;
      // Per-attacker-card 70 ms cooldown to keep machine-gun units from
      // becoming a buzzsaw of identical clicks.
      const last = this.lastTriggered.get(key) || 0;
      if (now - last < 70) continue;
      this.lastTriggered.set(key, now);
      const fn = this[`hit${card}`];
      if (typeof fn === 'function') fn.call(this, e.owner);
      else this._thwack(e.owner);
    }
  }

  // ────────────────────────── crowd ──────────────────────────

  // Procedural arena crowd: filtered white noise as the "rhuuuh" mass plus a
  // handful of tiny square chirps as individual whistlers. Tunable across the
  // full range from a small murmur to a stadium-sized roar.
  _crowd({ size = 'medium', boo = false, dur = 1.6, delay = 0 }) {
    if (!this.ctx) return;
    const dest = this.crowdGain || this.sfxGain;
    const peak = size === 'huge' ? 0.5 :
                 size === 'large' ? 0.4 :
                 size === 'medium' ? 0.3 :
                 size === 'small' ? 0.2 : 0.14;
    const attack = size === 'huge' ? 0.18 : 0.12;
    const release = Math.max(0.3, dur * 0.45);

    // Two noise layers — one for low "rrrr" body, one for high "shhh" sheen.
    if (boo) {
      // Boos are low and droopy: lowpass swept down + descending pitch tail.
      this._noise({ dur, peak: peak * 1.1, filter: 'lowpass', freq: 600,
                    freqEnd: 160, attack: 0.05, release, delay, dest });
      this._beep({ type: 'sawtooth', freq: 220, freqEnd: 110, dur: dur * 0.9,
                   peak: peak * 0.25, release: release * 0.8, delay, dest });
      this._beep({ type: 'sawtooth', freq: 165, freqEnd: 90, dur: dur * 0.9,
                   peak: peak * 0.18, release: release * 0.8,
                   delay: delay + 0.03, dest });
    } else {
      // Cheer body: wide bandpass noise with a slow attack and a tail.
      this._noise({ dur, peak: peak * 0.9, filter: 'bandpass', freq: 800, q: 0.9,
                    freqEnd: 1200, attack, release, delay, dest });
      this._noise({ dur, peak: peak * 0.55, filter: 'highpass', freq: 2200,
                    attack: attack * 1.3, release, delay, dest });
      // Individual whistles / shouts — short rising square chirps. The bigger
      // the cheer the more individuals we hear.
      const voices =
        size === 'huge' ? 8 :
        size === 'large' ? 5 :
        size === 'medium' ? 3 :
        size === 'small' ? 2 : 1;
      for (let i = 0; i < voices; i++) {
        const off = delay + 0.05 + i * (dur * 0.55 / voices) + (i * 0.013);
        const root = 600 + (i * 130) + (i % 2 === 0 ? 0 : 75);
        this._beep({ type: 'square', freq: root, freqEnd: root * 1.6,
                     dur: 0.12, peak: peak * 0.22, release: 0.08, delay: off,
                     dest });
      }
      // Sparkle: a couple of high triangle chirps near the peak.
      this._beep({ type: 'triangle', freq: 1800, freqEnd: 2400, dur: 0.18,
                   peak: peak * 0.2, release: 0.1, delay: delay + attack,
                   dest });
    }
  }

  cheerHuge()   { this._crowd({ size: 'huge',   dur: 2.4 }); }
  cheerLarge()  { this._crowd({ size: 'large',  dur: 1.8 }); }
  cheerMedium() { this._crowd({ size: 'medium', dur: 1.3 }); }
  cheerSmall()  { this._crowd({ size: 'small',  dur: 0.9 }); }
  crowdMurmur() {
    // Quick "oooh" gasp.
    this._crowd({ size: 'small', dur: 0.6 });
  }
  boo()         { this._crowd({ size: 'large', boo: true, dur: 1.6 }); }

  // ────────────────────────── spell SFX ──────────────────────────

  spellCast(owner, card) {
    const dest = this._bus('spell');
    const m = this._ownerMul(owner);
    if (card === 'Fireball') {
      this._noise({ dur: 0.55, peak: 0.42, filter: 'bandpass', q: 1.4,
                    freq: 1600 * m, freqEnd: 220, attack: 0.03, release: 0.25, dest });
      this._beep({ type: 'sawtooth', freq: 180 * m, freqEnd: 60 * m, dur: 0.5,
                   peak: 0.18, release: 0.2, dest });
    } else if (card === 'Arrows') {
      const base = 1400 * m;
      for (let i = 0; i < 3; i++) {
        this._beep({ type: 'triangle', freq: base * (1 - i * 0.08),
                     freqEnd: base * 0.4, dur: 0.08, peak: 0.22, release: 0.05,
                     delay: i * 0.05, dest });
        this._noise({ dur: 0.06, peak: 0.14, filter: 'highpass', freq: 2200,
                      release: 0.04, delay: i * 0.05, dest });
      }
    } else {
      this._noise({ dur: 0.35, peak: 0.38, filter: 'bandpass', q: 1.2,
                    freq: 1200 * m, freqEnd: 280, release: 0.18, dest });
    }
  }

  spellImpact(_owner, card) {
    const dest = this._bus('spell');
    if (card === 'Fireball') {
      // Tuned down from 0.7+0.45+0.18 — the bus + limiter make the impact
      // hit hard at half the raw peak amplitude.
      this._noise({ dur: 0.45, peak: 0.55, filter: 'lowpass', freq: 1800,
                    freqEnd: 110, attack: 0.002, release: 0.3, dest });
      this._beep({ type: 'square', freq: 110, freqEnd: 40, dur: 0.3,
                   peak: 0.32, release: 0.18, dest });
      this._beep({ type: 'sawtooth', freq: 220, freqEnd: 70, dur: 0.25,
                   peak: 0.16, release: 0.15, delay: 0.01, dest });
    } else if (card === 'Arrows') {
      for (let i = 0; i < 5; i++) {
        this._noise({ dur: 0.05, peak: 0.24, filter: 'highpass', freq: 1800,
                      release: 0.03, delay: i * 0.025, dest });
      }
    } else {
      this._noise({ dur: 0.2, peak: 0.42, filter: 'lowpass', freq: 600,
                    freqEnd: 120, release: 0.15, dest });
    }
  }

  // ────────────────────────── event-driven SFX ──────────────────────────

  kingActivated(owner) {
    const dest = this._bus('tower');
    const m = this._ownerMul(owner);
    for (let r = 0; r < 2; r++) {
      this._beep({ type: 'square', freq: NOTES.A4 * m, dur: 0.13, peak: 0.32,
                   attack: 0.01, release: 0.08, delay: r * 0.28, dest });
      this._beep({ type: 'square', freq: NOTES.E4 * m, dur: 0.13, peak: 0.32,
                   attack: 0.01, release: 0.08, delay: r * 0.28 + 0.13, dest });
    }
  }

  buildingExpired(_owner) {
    const dest = this._bus('death');
    this._noise({ dur: 0.32, peak: 0.32, filter: 'lowpass', freq: 600,
                  freqEnd: 80, release: 0.2, dest });
    this._beep({ type: 'triangle', freq: 220, freqEnd: 80, dur: 0.25,
                 peak: 0.14, release: 0.18, dest });
  }

  buildingDestroyed(_owner) {
    const dest = this._bus('tower');
    this._noise({ dur: 0.4, peak: 0.45, filter: 'lowpass', freq: 1400,
                  freqEnd: 80, attack: 0.005, release: 0.28, dest });
    this._beep({ type: 'square', freq: 140, freqEnd: 50, dur: 0.3,
                 peak: 0.22, release: 0.18, dest });
  }

  towerDestroyed(_owner, kind) {
    // Tuned down from 0.75+0.42+0.32 worst-offender stack — the tower bus
    // is the loudest category (0.95) so we don't need huge raw peaks.
    const dest = this._bus('tower');
    const big = kind === 'king';
    this._noise({ dur: big ? 1.1 : 0.7, peak: 0.55, filter: 'lowpass',
                  freq: 2200, freqEnd: 60, attack: 0.003, release: big ? 0.6 : 0.4, dest });
    this._beep({ type: 'square', freq: 220, freqEnd: 55, dur: big ? 0.8 : 0.5,
                 peak: 0.32, release: big ? 0.45 : 0.3, dest });
    this._beep({ type: 'sawtooth', freq: 110, freqEnd: 40, dur: big ? 0.85 : 0.55,
                 peak: 0.24, release: big ? 0.45 : 0.3, delay: 0.02, dest });
    for (let i = 0; i < 4; i++) {
      this._beep({ type: 'triangle', freq: 1200 - i * 180, dur: 0.08,
                   peak: 0.12, release: 0.06, delay: 0.08 + i * 0.07, dest });
    }
  }

  matchStart() {
    const dest = this._bus('match');
    const seq = [NOTES.C5, NOTES.E5, NOTES.G5];
    seq.forEach((f, i) => {
      this._beep({ type: 'square', freq: f, dur: 0.14, peak: 0.32,
                   attack: 0.01, release: 0.08, delay: i * 0.11, dest });
    });
    this._crowd({ size: 'small', dur: 1.1, delay: 0.35 });
  }

  matchEnd(outcome) {
    const dest = this._bus('match');
    if (outcome === 'win') {
      const arp = [NOTES.C5, NOTES.E5, NOTES.G5, NOTES.C6];
      arp.forEach((f, i) => {
        this._beep({ type: 'square', freq: f, dur: 0.18, peak: 0.36,
                     attack: 0.005, release: 0.12, delay: i * 0.12, dest });
        this._beep({ type: 'triangle', freq: f * 2, dur: 0.12, peak: 0.15,
                     release: 0.08, delay: i * 0.12 + 0.01, dest });
      });
      this._crowd({ size: 'huge', dur: 2.6, delay: 0.4 });
    } else if (outcome === 'loss') {
      const cadence = [NOTES.G4, NOTES.F4, NOTES.E4, NOTES.C4];
      cadence.forEach((f, i) => {
        this._beep({ type: 'sawtooth', freq: f, dur: 0.22, peak: 0.32,
                     attack: 0.01, release: 0.15, delay: i * 0.16, dest });
      });
      this._noise({ dur: 0.5, peak: 0.18, filter: 'lowpass', freq: 600,
                    freqEnd: 80, release: 0.3, delay: 0.4, dest });
      this._crowd({ size: 'large', boo: true, dur: 1.8, delay: 0.5 });
    } else {
      this._beep({ type: 'triangle', freq: NOTES.C5, dur: 0.4, peak: 0.3,
                   release: 0.25, dest });
      this._beep({ type: 'triangle', freq: NOTES.G5, dur: 0.4, peak: 0.3,
                   release: 0.25, delay: 0.02, dest });
      this._crowd({ size: 'small', dur: 1.0, delay: 0.3 });
    }
  }

  // Public dispatcher with per-key throttling.
  trigger(key, fn, minGapMs = 0) {
    if (!this.ctx) return;
    if (minGapMs > 0) {
      const now = performance.now();
      const last = this.lastTriggered.get(key) || 0;
      if (now - last < minGapMs) return;
      this.lastTriggered.set(key, now);
    }
    try { fn(); } catch (_) {}
  }
}

// ────────────────────────── per-card tables ──────────────────────────

const VOICES = {
  Knight: AudioEngine.prototype.voiceKnight,
  Giant: AudioEngine.prototype.voiceGiant,
  Archers: AudioEngine.prototype.voiceArcher,
  Musketeer: AudioEngine.prototype.voiceMusketeer,
  Goblins: AudioEngine.prototype.voiceGoblin,
  Minions: AudioEngine.prototype.voiceMinion,
  Cannon: AudioEngine.prototype.voiceCannon,
};

// stride = world-tiles a unit must travel before its next footstep fires;
// weight = which footstep timbre to use (light/medium/heavy).
const STEP_PROFILE = {
  Knight:    { stride: 0.85, weight: 'medium' },
  Giant:     { stride: 1.30, weight: 'heavy'  },
  Archers:   { stride: 0.70, weight: 'medium' },
  Goblins:   { stride: 0.55, weight: 'light'  },
  Musketeer: { stride: 0.80, weight: 'medium' },
};

export const audio = new AudioEngine();

// ────────────────────────── event tap ──────────────────────────

const SFX_TYPES = new Set([
  'play', 'spell', 'kingActivated', 'buildingExpired',
  'buildingDestroyed', 'towerDestroyed', 'end',
]);

export function processEvents(state, sinceIdx, perspective = 0) {
  const events = state.events;
  if (!events || sinceIdx >= events.length) return events ? events.length : 0;
  for (let i = sinceIdx; i < events.length; i++) {
    const ev = events[i];
    if (!SFX_TYPES.has(ev.type)) continue;

    if (ev.type === 'play') {
      audio.trigger(`play:${ev.owner}:${ev.card}`,
        () => audio.cardDeploy(ev.owner, ev.card), 80);
    } else if (ev.type === 'spell') {
      audio.trigger(`cast:${ev.owner}:${ev.card}`,
        () => audio.spellCast(ev.owner, ev.card), 120);
      const delayMs = (state.config && state.config.spellCastDelay
        ? state.config.spellCastDelay : 1.0) * 1000;
      setTimeout(() => {
        audio.spellImpact(ev.owner, ev.card);
        // Real-CR-style cheer on a clean wipe spell (3+ hits — usually a
        // tasty splash that the crowd reacts to).
        if ((ev.hits || 0) >= 3) {
          audio.trigger(`spellHit:${ev.owner}:${i}`,
            () => audio.cheerSmall(), 0);
        }
      }, delayMs);
    } else if (ev.type === 'kingActivated') {
      audio.trigger(`king:${ev.owner}`, () => audio.kingActivated(ev.owner), 100);
      // The whole stadium goes "ooooh".
      audio.trigger(`king_crowd:${ev.owner}`, () => audio.crowdMurmur(), 200);
    } else if (ev.type === 'buildingExpired') {
      audio.trigger(`bexp:${ev.owner}:${ev.card}`,
        () => audio.buildingExpired(ev.owner), 30);
    } else if (ev.type === 'buildingDestroyed') {
      audio.trigger(`bdes:${ev.owner}:${ev.card}`,
        () => audio.buildingDestroyed(ev.owner), 30);
      // Occasional small cheer — every other building goes down with a pop
      // from the crowd. Deterministic via the event index.
      if (i % 2 === 0) {
        audio.trigger(`bdes_crowd:${i}`, () => audio.cheerSmall(), 0);
      }
    } else if (ev.type === 'towerDestroyed') {
      audio.trigger(`tdes:${ev.owner}:${ev.kind}:${ev.side}`,
        () => audio.towerDestroyed(ev.owner, ev.kind), 100);
      // Crown tower goes down — the crowd erupts. King tower is huge; a
      // princess tower draws a "large" cheer.
      const size = ev.kind === 'king' ? 'huge' : 'large';
      audio.trigger(`tdes_crowd:${ev.owner}:${ev.kind}:${ev.side}`,
        () => (size === 'huge' ? audio.cheerHuge() : audio.cheerLarge()), 0);
    } else if (ev.type === 'end') {
      let outcome;
      if (ev.winner === 'draw') outcome = 'draw';
      else outcome = ev.winner === perspective ? 'win' : 'loss';
      audio.trigger(`end`, () => audio.matchEnd(outcome), 0);
    }
  }
  return events.length;
}
