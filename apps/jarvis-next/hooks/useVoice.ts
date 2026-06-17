"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognitionEventLike {
  results: { [index: number]: { [index: number]: { transcript: string } } };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function useVoice() {
  const [voiceOn, setVoiceOn] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const speak = useCallback(
    (text: string) => {
      if (!voiceOn || typeof window === "undefined") return;
      window.speechSynthesis.cancel();
      const clean = text.replace(/<[^>]+>/g, "").slice(0, 500);
      const utter = new SpeechSynthesisUtterance(clean);
      utter.rate = 0.92;
      utter.pitch = 0.85;
      utter.volume = 0.9;
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        voices.find((v) => /google uk english male|daniel|alex|fred/i.test(v.name)) ??
        voices.find((v) => v.lang.startsWith("en") && v.name.toLowerCase().includes("male")) ??
        voices.find((v) => v.lang.startsWith("en"));
      if (preferred) utter.voice = preferred;
      utter.onstart = () => setSpeaking(true);
      utter.onend = () => setSpeaking(false);
      utter.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utter);
    },
    [voiceOn],
  );

  const startListening = useCallback((onTranscript: (text: string) => void) => {
    const rec = getRecognition();
    if (!rec) return false;
    recognitionRef.current?.stop();
    recognitionRef.current = rec;
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-GB";
    rec.onresult = (ev) => {
      const text = ev.results[0]?.[0]?.transcript?.trim();
      if (text) onTranscript(text);
    };
    rec.onend = () => setRecognizing(false);
    rec.onerror = () => setRecognizing(false);
    rec.start();
    setRecognizing(true);
    return true;
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setRecognizing(false);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.speechSynthesis.getVoices();
    }
    return () => {
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  return { voiceOn, setVoiceOn, speaking, recognizing, speak, startListening, stopListening };
}
