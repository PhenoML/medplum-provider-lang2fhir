// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Card, Group, Stack, Text, Textarea, Title } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { DocumentReference, Encounter, Patient, Practitioner } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconInfoCircle, IconSparkles } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { executeBotByName } from '../../utils/bots';
import { showErrorNotification, showSuccessNotification } from '../../utils/notifications';

export interface SoapNotePanelProps {
  /** The chart-note transcript (dictated or pasted) to generate the SOAP note from. */
  transcript: string;
  patient: WithId<Patient>;
  encounter: WithId<Encounter>;
  practitioner?: WithId<Practitioner>;
  /** When the chart note is signed and locked, the note can be generated/reviewed but not saved. */
  disabled?: boolean;
}

// Output of the scribe-soap-note bot (kept local — the UI does not import from src/bots).
interface SoapNoteResult {
  note: string;
  warnings?: string[];
  createdResources?: string[];
}

// LOINC "Progress note" — the closest standard code for a SOAP visit note.
const PROGRESS_NOTE_CODING = { system: 'http://loinc.org', code: '11506-3', display: 'Progress note' };
const CLINICAL_NOTE_CATEGORY = {
  system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category',
  code: 'clinical-note',
  display: 'Clinical Note',
};

// SOAP-note scribe: from the "Fill chart note" transcript, run the PhenoML pipeline
// (transcribe → lang2fhir → FHIR → summary) via the scribe-soap-note bot. The bot extracts clinical
// FHIR resources, saves them to the patient chart, and returns a narrative SOAP note. The clinician
// reviews/edits the note and saves it as a DocumentReference (which then appears in the Documents tab
// and Timeline). Mirrors the review-before-persist pattern used elsewhere.
export const SoapNotePanel = ({ transcript, patient, encounter, practitioner, disabled }: SoapNotePanelProps): JSX.Element => {
  const medplum = useMedplum();
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true);
    try {
      const result = await executeBotByName<SoapNoteResult>(medplum, 'scribe-soap-note', {
        transcript,
        patient,
        encounter: createReference(encounter),
      });
      setNote(result.note ?? '');
      setWarnings(result.warnings?.length ? result.warnings : undefined);
      setSaved(false);
      const count = result.createdResources?.length ?? 0;
      showSuccessNotification({
        title: 'Note generated',
        message: count
          ? `${count} clinical resource${count === 1 ? '' : 's'} saved to the chart — review the note and save it`
          : 'Review the note below and save it to the chart',
      });
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!note?.trim()) {
      return;
    }
    setSaving(true);
    try {
      const attachment = await medplum.createAttachment({
        data: note,
        contentType: 'text/plain',
        filename: 'soap-note.txt',
      });
      await medplum.createResource<DocumentReference>({
        resourceType: 'DocumentReference',
        status: 'current',
        docStatus: 'preliminary',
        type: { coding: [PROGRESS_NOTE_CODING], text: 'SOAP note' },
        category: [{ coding: [CLINICAL_NOTE_CATEGORY] }],
        subject: createReference(patient),
        context: { encounter: [createReference(encounter)] },
        date: new Date().toISOString(),
        author: practitioner ? [createReference(practitioner)] : undefined,
        content: [{ attachment }],
      });
      setSaved(true);
      showSuccessNotification({ title: 'Saved', message: 'Note saved to the patient Documents tab' });
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card withBorder shadow="sm">
      <Title order={4} mb="xs">
        Note
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        Generate a note from the chart-note transcript above using PhenoML (transcribe → lang2fhir → FHIR → summary).
        Extracted clinical resources are saved to the chart; review the note, then save it as a document.
      </Text>
      <Button
        onClick={() => handleGenerate().catch(showErrorNotification)}
        loading={generating}
        disabled={!transcript.trim() || disabled}
        leftSection={<IconSparkles size={16} />}
      >
        Generate note
      </Button>

      {note !== undefined && (
        <Stack gap="sm" mt="md">
          <Textarea
            label="Note"
            value={note}
            onChange={(event) => {
              setNote(event.currentTarget.value);
              setSaved(false);
            }}
            autosize
            minRows={10}
            maxRows={24}
            disabled={disabled}
          />
          {warnings && (
            <Alert icon={<IconInfoCircle size={16} />} color="yellow" variant="light">
              <Text size="sm">Some template fields were unresolved: {warnings.join('; ')}</Text>
            </Alert>
          )}
          <Group justify="flex-end">
            {saved && (
              <Text size="sm" c="green">
                Saved
              </Text>
            )}
            <Button
              onClick={() => handleSave().catch(showErrorNotification)}
              loading={saving}
              disabled={disabled || saved || !note.trim()}
            >
              Save to chart
            </Button>
          </Group>
        </Stack>
      )}
    </Card>
  );
};
