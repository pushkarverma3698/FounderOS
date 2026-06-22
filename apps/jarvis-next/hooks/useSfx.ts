"use client";

import { useCallback, useRef, useState } from "react";

export function useSfx() {
  const [sfxOn, setSfxOn] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Initialize AudioContext on first user interaction
  const initAudio = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        audioCtxRef.current = new AudioCtx();
      }
    }
    if (audioCtxRef.current?.state === "suspended") {
      void audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  const toggleSfx = useCallback(() => {
    setSfxOn((prev) => {
      const next = !prev;
      if (next) {
        initAudio();
      }
      return next;
    },);
  }, [initAudio]);

  // Play a quick, clean synthetic sound
  const playTone = useCallback(
    ({
      freqs,
      duration = 0.1,
      type = "sine" as OscillatorType,
      gainValues = [0.08, 0],
      times = [0, duration],
    }: {
      freqs: number[];
      duration?: number;
      type?: OscillatorType;
      gainValues?: number[];
      times?: number[];
    }) => {
      if (!sfxOn) return;
      const ctx = initAudio();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = type;
      
      // Handle frequency sweep
      if (freqs.length === 1) {
        osc.frequency.setValueAtTime(freqs[0], now);
      } else if (freqs.length > 1) {
        osc.frequency.setValueAtTime(freqs[0], now);
        // Linear ramp to next frequencies
        freqs.forEach((f, idx) => {
          if (idx > 0) {
            osc.frequency.exponentialRampToValueAtTime(f, now + (duration * idx) / (freqs.length - 1));
          }
        });
      }

      // Gain (Volume) envelope
      gainNode.gain.setValueAtTime(0, now);
      gainValues.forEach((g, idx) => {
        gainNode.gain.linearRampToValueAtTime(g, now + times[idx]);
      });

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + duration);
    },
    [sfxOn, initAudio]
  );

  const playTransmit = useCallback(() => {
    // Elegant rising sine wave (cybernetic transmit)
    playTone({
      freqs: [220, 480],
      duration: 0.18,
      gainValues: [0.06, 0.04, 0],
      times: [0.02, 0.08, 0.18],
    });
  }, [playTone]);

  const playReceive = useCallback(() => {
    // Beautiful major-third dual chime (response complete)
    if (!sfxOn) return;
    const ctx = initAudio();
    if (!ctx) return;
    const now = ctx.currentTime;

    const playNode = (freq: number, delay: number, volume: number) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + delay);
      
      gainNode.gain.setValueAtTime(0, now + delay);
      gainNode.gain.linearRampToValueAtTime(volume, now + delay + 0.04);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.35);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.4);
    };

    // F#5 followed by A#5 (futuristic chime)
    playNode(369.99, 0, 0.05);
    playNode(466.16, 0.08, 0.04);
  }, [sfxOn, initAudio]);

  const playStatus = useCallback(() => {
    // Quick micro-chime (tool call or route step)
    playTone({
      freqs: [180, 240],
      duration: 0.06,
      gainValues: [0.03, 0],
      times: [0.01, 0.06],
    });
  }, [playTone]);

  const playMic = useCallback(() => {
    // Tactile interface micro-click for voice recording toggle
    playTone({
      freqs: [880, 440],
      duration: 0.04,
      type: "sine",
      gainValues: [0.05, 0],
      times: [0.005, 0.04],
    });
  }, [playTone]);

  return {
    sfxOn,
    toggleSfx,
    playTransmit,
    playReceive,
    playStatus,
    playMic,
  };
}
