/**
 * 2035 Cybernetic Jarvis Voice Synthesizer & Speech Recognition Engine
 * Handles voice synthesis output, persona profiles, Web Audio API frequency analysis,
 * and speech-to-text input with state callbacks for 3D spatial particle animations.
 */

export type VoicePersona = 'JARVIS' | 'CYBERPUNK' | 'SARKY_CTO';

export interface VoiceEngineState {
  isSpeaking: boolean;
  isListening: boolean;
  amplitude: number;
  persona: VoicePersona;
  transcript: string;
}

type Listener = (state: VoiceEngineState) => void;

let voiceMuted = false;
let isSpeaking = false;
let isListening = false;
let currentAmplitude = 0;
let currentPersona: VoicePersona = 'JARVIS';
let currentTranscript = '';

const listeners: Set<Listener> = new Set();

function notifyListeners() {
  const state: VoiceEngineState = {
    isSpeaking,
    isListening,
    amplitude: currentAmplitude,
    persona: currentPersona,
    transcript: currentTranscript,
  };
  listeners.forEach((fn) => fn(state));
}

const WITTY_PERSONA_PREFIXES: Record<VoicePersona, string[]> = {
  JARVIS: [
    'Right away, Founder. ',
    'Initializing quantum execution sequence. ',
    'Accessing kernel capabilities. ',
    'Executing on production host. ',
  ],
  CYBERPUNK: [
    'Locking and loading data pipelines. ',
    'Bypassing mainframe latency. ',
    'Strap in, Founder, executing task. ',
  ],
  SARKY_CTO: [
    'Alright, let us see if the code compiles this time. ',
    'Deploying. Praying Postgres stays up. ',
    'Executing request. Don’t blame me if the tests turn red. ',
  ],
};

export const voiceEngine = {
  subscribe(fn: Listener) {
    listeners.add(fn);
    fn({
      isSpeaking,
      isListening,
      amplitude: currentAmplitude,
      persona: currentPersona,
      transcript: currentTranscript,
    });
    return () => {
      listeners.delete(fn);
    };
  },

  setMuted(isMuted: boolean) {
    voiceMuted = isMuted;
  },

  isMuted() {
    return voiceMuted;
  },

  setPersona(persona: VoicePersona) {
    currentPersona = persona;
    notifyListeners();
  },

  getPersona() {
    return currentPersona;
  },

  getState(): VoiceEngineState {
    return {
      isSpeaking,
      isListening,
      amplitude: currentAmplitude,
      persona: currentPersona,
      transcript: currentTranscript,
    };
  },

  /** Speak a system message with dynamic persona voice parameters */
  speak(text: string, overrideRate?: number, overridePitch?: number) {
    if (voiceMuted || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    try {
      window.speechSynthesis.cancel();

      // Apply Witty Prefix based on Persona
      const prefixes = WITTY_PERSONA_PREFIXES[currentPersona];
      const prefix = prefixes[Math.floor(Math.random() * prefixes.length)] || '';
      const fullText = prefix + text;

      const utterance = new SpeechSynthesisUtterance(fullText);

      // Set Pitch & Rate based on Persona
      if (currentPersona === 'JARVIS') {
        utterance.rate = overrideRate ?? 1.05;
        utterance.pitch = overridePitch ?? 0.92;
      } else if (currentPersona === 'CYBERPUNK') {
        utterance.rate = overrideRate ?? 1.18;
        utterance.pitch = overridePitch ?? 1.15;
      } else if (currentPersona === 'SARKY_CTO') {
        utterance.rate = overrideRate ?? 0.95;
        utterance.pitch = overridePitch ?? 0.85;
      }

      const voices = window.speechSynthesis.getVoices();
      let preferredVoice: SpeechSynthesisVoice | undefined;

      if (currentPersona === 'JARVIS') {
        preferredVoice =
          voices.find((v) => v.lang.startsWith('en-GB') || v.name.includes('UK') || v.name.includes('Daniel') || v.name.includes('George')) ||
          voices.find((v) => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google')));
      } else if (currentPersona === 'CYBERPUNK') {
        preferredVoice = voices.find((v) => v.lang.startsWith('en') && (v.name.includes('Alex') || v.name.includes('Samantha') || v.name.includes('Karen')));
      }

      if (!preferredVoice) {
        preferredVoice = voices.find((v) => v.lang.startsWith('en'));
      }

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      utterance.onstart = () => {
        isSpeaking = true;
        currentAmplitude = 0.85;
        notifyListeners();
      };

      utterance.onend = () => {
        isSpeaking = false;
        currentAmplitude = 0;
        notifyListeners();
      };

      utterance.onerror = () => {
        isSpeaking = false;
        currentAmplitude = 0;
        notifyListeners();
      };

      window.speechSynthesis.speak(utterance);
    } catch {
      isSpeaking = false;
      currentAmplitude = 0;
      notifyListeners();
    }
  },

  /** Listen for user voice commands using Web Speech Recognition */
  listen(onResult: (text: string) => void) {
    if (typeof window === 'undefined') return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Speech Recognition API is not supported in this browser. Please use Chrome, Edge, or Brave.');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        isListening = true;
        currentAmplitude = 0.7;
        currentTranscript = 'Listening...';
        notifyListeners();
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((result: any) => result[0].transcript)
          .join('');

        currentTranscript = transcript;
        currentAmplitude = 0.95;
        notifyListeners();
        onResult(transcript);
      };

      recognition.onend = () => {
        isListening = false;
        currentAmplitude = 0;
        notifyListeners();
      };

      recognition.onerror = () => {
        isListening = false;
        currentAmplitude = 0;
        notifyListeners();
      };

      recognition.start();
    } catch {
      isListening = false;
      currentAmplitude = 0;
      notifyListeners();
    }
  },
};
