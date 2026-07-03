// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// Mojibake sequences produced when a UTF-8 en/em-dash is re-decoded as Mac Roman or CP1252
// during upload (e.g. "–" rendered as "‚Äì"). Strip them so fax subjects read cleanly even when
// the stored value was corrupted at ingest time.
const MOJIBAKE_SEQUENCES = ['‚Äì', '‚Äî', 'â€“', 'â€”'];

// Removes mojibake dash artifacts and collapses the surrounding whitespace.
export function cleanFaxText(text: string | undefined): string {
  if (!text) {
    return '';
  }
  let out = text;
  for (const seq of MOJIBAKE_SEQUENCES) {
    out = out.split(seq).join(' ');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function formatFaxNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value;
}
