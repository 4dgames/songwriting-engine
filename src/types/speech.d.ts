// Ensure Web Speech API types are available in strict builds
// These are part of the DOM spec but not always included in all TS environments

interface Window {
  SpeechRecognition: typeof SpeechRecognition;
  webkitSpeechRecognition: typeof SpeechRecognition;
}
