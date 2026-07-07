// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useMedplum } from '@medplum/react';
import { useEffect, useRef, useState } from 'react';
import { executeBotByName } from '../utils/bots';

// Speech-to-text for the reusable ScribeTextarea. Audio is captured in the browser and transcribed
// by the PhenoML voice API (https://developer.pheno.ml/reference/transcribe) via the voice-transcribe
// Medplum bot — PhenoML credentials must stay server-side, so the browser posts the recorded audio to
// the bot rather than calling the API directly. Transcribed text is delivered via the onTranscript
// callback rather than owned here, so the hook composes with any controlled input.

// Prefer formats the PhenoML voice API accepts (OGG/WebM Opus, WAV, FLAC, MP3).
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export interface UseScribeTranscriptionOptions {
  /** Called with the transcript when a recording finishes transcribing. */
  onTranscript?: (text: string) => void;
}

export interface UseScribeTranscription {
  isRecording: boolean;
  /** True while a finished recording is being transcribed by the bot. */
  isProcessing: boolean;
  /** True while an in-flight transcription is running (disables the mic). */
  isBusy: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return undefined;
  }
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Result is a data URL ("data:<type>;base64,<data>"); strip the prefix.
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function useScribeTranscription(options?: UseScribeTranscriptionOptions): UseScribeTranscription {
  const medplum = useMedplum();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Keep the latest callback so async transcription always reports to the current handler/state.
  const onTranscriptRef = useRef(options?.onTranscript);
  useEffect(() => {
    onTranscriptRef.current = options?.onTranscript;
  });

  const transcribeAudio = async (audioBlob: Blob): Promise<void> => {
    try {
      setIsProcessing(true);
      const audio = await blobToBase64(audioBlob);
      const { transcript } = await executeBotByName<{ transcript: string }>(medplum, 'voice-transcribe', {
        audio,
        contentType: audioBlob.type || undefined,
      });
      if (transcript) {
        onTranscriptRef.current?.(transcript);
      }
    } catch (error) {
      console.error('Transcription error:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const startRecording = async (): Promise<void> => {
    try {
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
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
    isProcessing,
    isBusy: isProcessing,
    startRecording,
    stopRecording,
  };
}
