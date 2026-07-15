// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box } from '@mantine/core';
import type { JSX } from 'react';
import { buildHighlightSegments } from '../../../utils/citations';
import type { ReviewCodeItem } from '../../../utils/citations';

export interface HighlightedNoteProps {
  noteText: string;
  items: ReviewCodeItem[];
  activeKey?: string;
  onSpanClick?: (key: string) => void;
}

export function HighlightedNote(props: HighlightedNoteProps): JSX.Element {
  const { noteText, items, activeKey, onSpanClick } = props;
  return (
    <Box style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
      {buildHighlightSegments(noteText, items).map((segment, index) => {
        const cited = segment.keys.length > 0;
        const active = Boolean(activeKey && segment.keys.includes(activeKey));
        let backgroundColor: string | undefined;
        if (cited) {
          backgroundColor = active ? 'var(--mantine-color-yellow-4)' : 'var(--mantine-color-yellow-2)';
        }
        return (
          <Box
            component="span"
            key={`${index}-${segment.text}`}
            onClick={cited ? () => onSpanClick?.(segment.keys[0]) : undefined}
            style={{
              backgroundColor,
              borderRadius: cited ? 3 : undefined,
              cursor: cited ? 'pointer' : undefined,
            }}
          >
            {segment.text}
          </Box>
        );
      })}
    </Box>
  );
}
