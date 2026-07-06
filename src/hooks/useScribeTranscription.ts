// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { env, pipeline } from '@huggingface/transformers';
import { useEffect, useRef, useState } from 'react';

// Browser-side speech-to-text using a Whisper model that runs entirely in the browser (no hosted
// transcribe API). Extracted from ResourceLang2FHIRCreatePage so the visit-scribe flow (and later
// phases) can reuse the same capture mechanism. Text can also be set/pasted directly, so the flow
// works without a microphone.

env.allowLocalModels = false;
env.useBrowserCache = true;

const WHISPER_MODEL = 'Xenova/whisper-tiny.en';

export interface UseScribeTranscription {
  /** The accumulated transcript. Editable/pasteable via setTranscript. */
  transcript: string;
  setTranscript: React.Dispatch<React.SetStateAction<string>>;
  isRecording: boolean;
  isModelLoading: boolean;
  isProcessing: boolean;
  /** True while the model or an in-flight transcription blocks recording/submit. */
  isBusy: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}

export function useScribeTranscription(): UseScribeTranscription {
  const [transcript, setTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const whisperRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const initWhisper = async (): Promise<void> => {
    if (whisperRef.current) {
      return;
    }
    try {
      setIsModelLoading(true);
      whisperRef.current = await pipeline('automatic-speech-recognition', WHISPER_MODEL);
    } catch (error) {
      console.error('Failed to initialize Whisper:', error);
    } finally {
      setIsModelLoading(false);
    }
  };

  // Warm up the model on mount so the mic responds quickly.
  useEffect(() => {
    initWhisper().catch(console.error);
  }, []);

  const transcribeAudio = async (audioBlob: Blob): Promise<void> => {
    let audioContext: AudioContext | undefined;
    try {
      setIsProcessing(true);
      const arrayBuffer = await audioBlob.arrayBuffer();
      audioContext = new AudioContext({ sampleRate: 16000 });
      const audioData = await audioContext.decodeAudioData(arrayBuffer);
      const audioArray = audioData.getChannelData(0);
      const result = await whisperRef.current(audioArray);
      setTranscript((prev) => prev + (prev.length > 0 ? ' ' : '') + result.text);
    } catch (error) {
      console.error('Transcription error:', error);
    } finally {
      setIsProcessing(false);
      await audioContext?.close();
    }
  };

  const startRecording = async (): Promise<void> => {
    if (!whisperRef.current) {
      await initWhisper();
    }
    try {
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/wav' });
        transcribeAudio(audioBlob).catch(console.error);
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000); // Collect data every second
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
    }
  };

  const stopRecording = (): void => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  return {
    transcript,
    setTranscript,
    isRecording,
    isModelLoading,
    isProcessing,
    isBusy: isModelLoading || isProcessing,
    startRecording,
    stopRecording,
  };
}
