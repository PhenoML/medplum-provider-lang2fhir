// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { env, pipeline } from '@huggingface/transformers';
import { useEffect, useRef, useState } from 'react';

// Browser-side speech-to-text using a Whisper model that runs entirely in the browser (no hosted
// transcribe API). Powers the reusable ScribeTextarea so the mic can live on any free text box.
//
// The model is loaded lazily on the first recording (not on mount), so rendering a scribe-enabled
// text box does not download a model until the user actually clicks the mic. Transcribed text is
// delivered via the onTranscript callback rather than owned here, so the hook composes with any
// controlled input.

env.allowLocalModels = false;
env.useBrowserCache = true;

const WHISPER_MODEL = 'Xenova/whisper-tiny.en';

export interface UseScribeTranscriptionOptions {
  /** Called with each transcribed chunk of text when a recording finishes. */
  onTranscript?: (text: string) => void;
}

export interface UseScribeTranscription {
  isRecording: boolean;
  isModelLoading: boolean;
  isProcessing: boolean;
  /** True while the model is loading or an in-flight transcription is running. */
  isBusy: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}

export function useScribeTranscription(options?: UseScribeTranscriptionOptions): UseScribeTranscription {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const whisperRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Keep the latest callback so async transcription always reports to the current handler/state.
  const onTranscriptRef = useRef(options?.onTranscript);
  useEffect(() => {
    onTranscriptRef.current = options?.onTranscript;
  });

  const initWhisper = async (): Promise<void> => {
    if (whisperRef.current) {
      return;
    }
    setIsModelLoading(true);
    try {
      whisperRef.current = await pipeline('automatic-speech-recognition', WHISPER_MODEL);
    } finally {
      setIsModelLoading(false);
    }
  };

  const transcribeAudio = async (audioBlob: Blob): Promise<void> => {
    let audioContext: AudioContext | undefined;
    try {
      setIsProcessing(true);
      const arrayBuffer = await audioBlob.arrayBuffer();
      audioContext = new AudioContext({ sampleRate: 16000 });
      const audioData = await audioContext.decodeAudioData(arrayBuffer);
      const audioArray = audioData.getChannelData(0);
      const result = await whisperRef.current(audioArray);
      if (result?.text) {
        onTranscriptRef.current?.(result.text);
      }
    } catch (error) {
      console.error('Transcription error:', error);
    } finally {
      setIsProcessing(false);
      await audioContext?.close();
    }
  };

  const startRecording = async (): Promise<void> => {
    // Lazily load the model on first use so scribe-enabled text boxes don't fetch a model just to render.
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
    isRecording,
    isModelLoading,
    isProcessing,
    isBusy: isModelLoading || isProcessing,
    startRecording,
    stopRecording,
  };
}
