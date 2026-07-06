// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Textarea } from '@mantine/core';
import type { TextareaProps } from '@mantine/core';
import { IconMicrophone, IconMicrophoneOff } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useScribeTranscription } from '../hooks/useScribeTranscription';
import { showErrorNotification } from '../utils/notifications';

export interface ScribeTextareaProps extends Omit<TextareaProps, 'value' | 'onChange' | 'rightSection'> {
  value: string;
  /** Called with the new full text on typing or when a voice transcription is appended. */
  onChange: (value: string) => void;
}

// A Mantine Textarea with a built-in dictation mic. Speech is transcribed in the browser (Whisper)
// and appended to the current value, so the "scribe" capability can be dropped onto any free text
// box. The Whisper model loads lazily on the first mic click.
export function ScribeTextarea({ value, onChange, disabled, ...props }: ScribeTextareaProps): JSX.Element {
  const { isRecording, isBusy, startRecording, stopRecording } = useScribeTranscription({
    onTranscript: (text) => onChange(value + (value.trim().length > 0 ? ' ' : '') + text),
  });

  const toggleRecording = (): void => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording().catch(showErrorNotification);
    }
  };

  return (
    <Textarea
      {...props}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.value)}
      rightSectionPointerEvents="all"
      rightSectionProps={{ style: { alignItems: 'flex-start', paddingTop: 6 } }}
      rightSection={
        <ActionIcon
          variant="subtle"
          color={isRecording ? 'red' : 'gray'}
          onClick={toggleRecording}
          disabled={disabled || isBusy}
          loading={isBusy}
          title={isRecording ? 'Stop dictation' : 'Dictate'}
          aria-label={isRecording ? 'Stop dictation' : 'Dictate'}
        >
          {isRecording ? <IconMicrophoneOff size={18} /> : <IconMicrophone size={18} />}
        </ActionIcon>
      }
    />
  );
}
