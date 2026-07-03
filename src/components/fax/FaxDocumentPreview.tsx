// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Flex, Text } from '@mantine/core';
import type { Attachment } from '@medplum/fhirtypes';
import { useCachedBinaryUrl } from '@medplum/react-hooks';
import type { JSX } from 'react';

interface FaxDocumentPreviewProps {
  attachment: Attachment | undefined;
}

// Renders a fax/referral document attachment as an inline preview: images render as <img>,
// everything else (PDFs) renders in an <iframe>. Shared by FaxDetailPanel and the referral
// review screen so both panes look identical.
export function FaxDocumentPreview({ attachment }: FaxDocumentPreviewProps): JSX.Element {
  const rawAttachmentUrl = useCachedBinaryUrl(attachment?.url);
  const attachmentUrl = isValidUrl(rawAttachmentUrl) ? rawAttachmentUrl : undefined;

  if (attachmentUrl && attachment?.contentType?.startsWith('image/')) {
    return (
      <Box p="md" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}>
        <Box
          style={{
            display: 'block',
            maxWidth: 'fit-content',
            borderRadius: 4,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <img
            src={attachmentUrl}
            alt={attachment.title ?? 'Fax attachment'}
            style={{ width: 'auto', maxWidth: '100%', height: 'auto', display: 'block' }}
          />
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              border: '1px solid color-mix(in srgb, var(--mantine-color-gray-3) 50%, transparent)',
              borderRadius: 4,
              pointerEvents: 'none',
              boxSizing: 'border-box',
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box p="md" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {attachmentUrl ? (
        <Box
          style={{
            flex: 1,
            borderRadius: 4,
            overflow: 'hidden',
            border: '1px solid color-mix(in srgb, var(--mantine-color-gray-3) 50%, transparent)',
          }}
        >
          <iframe
            title="Fax attachment"
            width="100%"
            height="100%"
            src={attachmentUrl + '#navpanes=0'}
            allowFullScreen={true}
            style={{ display: 'block', border: 0 }}
          />
        </Box>
      ) : (
        <Flex justify="center" align="center" h={300}>
          <Text c="dimmed">No document attached to this fax</Text>
        </Flex>
      )}
    </Box>
  );
}

function isValidUrl(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.href.length > 0;
  } catch {
    return false;
  }
}
