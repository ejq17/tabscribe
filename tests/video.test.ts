import { beforeEach, describe, expect, it } from 'vitest';
import { formatTime, parseTime, parseYouTubeUrl } from '../src/video/youtube';
import { createSyncController, nearestRate, type SyncController, type TransportEvent, type TransportHooks } from '../src/video/sync';
import type { VideoPlayer, VideoState } from '../src/video/player';

describe('youtube urls and times', () => {
  const ID = 'dQw4w9WgXcQ';
  it('parses every URL form', () => {
    expect(parseYouTubeUrl(ID)).toEqual({ id: ID });
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}`)).toEqual({ id: ID });
    expect(parseYouTubeUrl(`youtube.com/watch?feature=x&v=${ID}`)).toEqual({ id: ID });
    expect(parseYouTubeUrl(`https://youtu.be/${ID}`)).toEqual({ id: ID });
    expect(parseYouTubeUrl(`https://www.youtube.com/shorts/${ID}`)).toEqual({ id: ID });
    expect(parseYouTubeUrl(`https://www.youtube.com/embed/${ID}`)).toEqual({ id: ID });
    expect(parseYouTubeUrl(`https://music.youtube.com/watch?v=${ID}&list=abc`)).toEqual({ id: ID });
    expect(parseYouTubeUrl(`  https://m.youtube.com/watch?v=${ID}  `)).toEqual({ id: ID });
  });
  it('reads t= / start= in several formats', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=90`)).toEqual({ id: ID, t: 90 });
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)).toEqual({ id: ID, t: 90 });
    expect(parseYouTubeUrl(`https://www.youtube.com/embed/${ID}?start=75`)).toEqual({ id: ID, t: 75 });
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=01:30`)).toEqual({ id: ID, t: 90 });
  });
  it('rejects things that are not videos', () => {
    for (const bad of ['', 'hello', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/', 'https://youtu.be/']) {
      expect(parseYouTubeUrl(bad)).toBeNull();
    }
  });
  it('parses and formats times', () => {
    expect(parseTime('1:30')).toBe(90);
    expect(parseTime('90')).toBe(90);
    expect(parseTime('1m30s')).toBe(90);
    expect(parseTime('1h2m3s')).toBe(3723);
    expect(parseTime('01:02:03')).toBe(3723);
    expect(parseTime('0:75')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(formatTime(90)).toBe('1:30');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(3723)).toBe('1:02:03');
    expect(formatTime(-4)).toBe('0:00');
  });
  it('picks the nearest available rate', () => {
    expect(nearestRate([0.25, 0.5, 1, 1.5, 2], 0.8)).toBe(1);
    expect(nearestRate([0.25, 0.5, 1, 1.5, 2], 0.6)).toBe(0.5);
  });
});

class FakeVideo implements VideoPlayer {
  time = 0;
  state: VideoState = 'paused';
  rate = 1;
  calls: string[] = [];
  private cbs = new Set<(s: VideoState) => void>();
  load() {}
  play() { this.calls.push('play'); this.set('playing'); }
  pause() { this.calls.push('pause'); this.set('paused'); }
  seek(sec: number) { this.calls.push(`seek:${sec}`); this.time = sec; }
  getTime() { return this.time; }
  getState() { return this.state; }
  setRate(r: number) { this.rate = r; }
  getAvailableRates() { return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]; }
  setVolume() {}
  destroy() {}
  onStateChange(cb: (s: VideoState) => void) { this.cbs.add(cb); return () => this.cbs.delete(cb); }
  /** the state changes on its own, the way the YouTube UI would */
  set(s: VideoState) { this.state = s; this.cbs.forEach((c) => c(s)); }
}

/** A transport that, like the real one, echoes its own actions as events. */
class FakeTransport implements TransportHooks {
  playing = false;
  sec = 0;
  calls: string[] = [];
  private cbs = new Set<(e: TransportEvent) => void>();
  isPlaying() { return this.playing; }
  getSeconds() { return this.sec; }
  play(sec: number) { this.calls.push(`play:${sec}`); this.playing = true; this.sec = sec; this.emit({ type: 'play', sec }); }
  pause() { this.calls.push('pause'); this.playing = false; this.emit({ type: 'pause' }); }
  seek(sec: number) {
    this.calls.push(`seek:${sec}`);
    this.sec = sec;
    this.emit(this.playing ? { type: 'play', sec } : { type: 'seek', sec });
  }
  subscribe(cb: (e: TransportEvent) => void) { this.cbs.add(cb); return () => this.cbs.delete(cb); }
  emit(e: TransportEvent) { this.cbs.forEach((c) => c(e)); }
}

describe('sync controller', () => {
  let t = 0;
  let v: FakeVideo;
  let tr: FakeTransport;
  let ctl: SyncController;
  let startSec = 10;
  const advance = (ms: number) => {
    t += ms;
    if (tr.playing) tr.sec += ms / 1000;
    if (v.state === 'playing') v.time += ms / 1000;
  };
  beforeEach(() => {
    t = 100000;
    startSec = 10;
    v = new FakeVideo();
    tr = new FakeTransport();
    ctl = createSyncController(v, tr, { getStartSec: () => startSec, getRate: () => 1, now: () => t, intervalMs: 0 });
  });

  it('transport play seeks the video to startSec + tab position, then plays', () => {
    tr.sec = 4;
    tr.play(4);
    expect(v.calls).toEqual(['seek:14', 'play']);
    expect(v.state).toBe('playing');
  });

  it('transport pause and stop pause the video', () => {
    tr.play(0);
    tr.pause();
    expect(v.state).toBe('paused');
    tr.play(0);
    tr.emit({ type: 'stop' });
    expect(v.state).toBe('paused');
  });

  it('transport seek moves the video and keeps the play state', () => {
    tr.seek(6);
    expect(v.time).toBe(16);
    expect(v.state).toBe('paused');
    tr.play(0);
    advance(100);
    tr.seek(20); // emits a restart while playing
    expect(v.time).toBe(30);
    expect(v.state).toBe('playing');
  });

  it('maps tab speed to the nearest video rate', () => {
    tr.emit({ type: 'rate', rate: 0.6 });
    expect(v.rate).toBe(0.5);
    tr.emit({ type: 'rate', rate: 1.9 });
    expect(v.rate).toBe(2);
  });

  it('corrects drift above 0.25 s but not below', () => {
    tr.play(0);
    advance(2000); // past the settle window
    v.time += 0.2;
    v.calls.length = 0;
    ctl.tick();
    expect(v.calls).toEqual([]);
    v.time += 0.2; // now 0.4 off
    ctl.tick();
    expect(v.calls).toEqual([`seek:${startSec + tr.sec}`]);
  });

  it('ignores drift checks while the player settles after a seek', () => {
    tr.play(0);
    advance(300);
    v.time += 0.5;
    v.calls.length = 0;
    ctl.tick();
    expect(v.calls).toEqual([]);
  });

  it('video PLAYING while stopped starts the transport at videoTime - startSec', () => {
    v.time = 25;
    v.set('playing');
    expect(tr.calls).toEqual(['play:15']);
    expect(v.calls).toEqual([]); // the echo does not re-seek the video
  });

  it('video PAUSED pauses a playing transport, once', () => {
    tr.play(0);
    advance(50);
    v.set('paused');
    expect(tr.calls).toEqual(['play:0', 'pause']);
    expect(tr.playing).toBe(false);
  });

  it('a 1.5 s video jump seeks the tab, without echoing back to the video', () => {
    tr.play(0);
    advance(2000);
    v.time += 30; // user scrubbed forward
    v.calls.length = 0;
    tr.calls.length = 0;
    ctl.tick();
    expect(tr.calls).toEqual([`seek:${v.time - startSec}`]);
    expect(v.calls).toEqual([]);
  });

  it('a scrub of the paused video moves the tab cursor', () => {
    ctl.tick();
    v.time = 40;
    ctl.tick();
    expect(tr.calls).toEqual(['seek:30']);
    expect(tr.playing).toBe(false);
  });

  it('controller-issued seeks are not mistaken for user scrubs', () => {
    tr.play(0);
    tr.seek(50);
    advance(1100);
    tr.calls.length = 0;
    ctl.tick();
    ctl.tick();
    expect(tr.calls).toEqual([]);
  });

  it('scrubbing before startSec parks the tab at 0, then starts it when the video arrives', () => {
    tr.play(0);
    advance(2000);
    v.time = 3; // before startSec (10)
    ctl.tick();
    expect(tr.playing).toBe(false);
    expect(tr.sec).toBe(0);
    expect(ctl.isParked()).toBe(true);
    advance(2000); // settle passes; video keeps playing 3 -> 5
    ctl.tick();
    expect(tr.playing).toBe(false);
    advance(5100); // video reaches 10.1
    ctl.tick();
    expect(tr.playing).toBe(true);
    expect(tr.calls[tr.calls.length - 1]).toMatch(/^play:0\.\d+/);
    expect(ctl.isParked()).toBe(false);
  });

  it('video PLAYING before startSec leaves the tab at 0 until it reaches the start', () => {
    v.time = 4;
    v.set('playing');
    expect(tr.playing).toBe(false);
    expect(ctl.isParked()).toBe(true);
    advance(6100);
    ctl.tick();
    expect(tr.playing).toBe(true);
  });

  it('dispose stops reacting', () => {
    ctl.dispose();
    tr.play(0);
    expect(v.calls).toEqual([]);
  });
});
