// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { createReference } from '@medplum/core';
import type { Encounter, Patient, Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { QuestionnaireForm, useMedplum } from '@medplum/react';
import { IconSparkles } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { ScribeTextarea } from '../ScribeTextarea';
import { executeBotByName } from '../../utils/bots';
import { showErrorNotification, showSuccessNotification } from '../../utils/notifications';
import { SCREENING_QUESTIONNAIRE_URLS, scoreQuestionnaireResponse } from '../../utils/screening';

export interface ScribePanelProps {
  encounter: Encounter;
  patient: Patient;
  /** When the chart note is signed and locked, generated responses can be reviewed but not saved. */
  disabled?: boolean;
}

interface ScreeningResult {
  questionnaire: Questionnaire;
  response: QuestionnaireResponse;
  saved: boolean;
}

// Screening scribe: capture (speak or paste) a visit transcript, run the scribe-fill bot to pre-fill
// the GAD-7 and PHQ-9 screening questionnaires, let the clinician review/edit the answers, then save
// each as a QuestionnaireResponse linked to the encounter. Rendered within the Note & Tasks tab.
// Mirrors the Phase 1 review-before-persist flow — the bot returns unsaved resources and nothing is
// persisted until the clinician saves.
export const ScribePanel = ({ encounter, patient, disabled }: ScribePanelProps): JSX.Element => {
  const medplum = useMedplum();
  const [transcript, setTranscript] = useState('');
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<Record<string, ScreeningResult>>({});

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true);
    try {
      const encounterRef = createReference(encounter);
      const generated: Record<string, ScreeningResult> = {};
      for (const url of SCREENING_QUESTIONNAIRE_URLS) {
        const questionnaire = await medplum.searchOne('Questionnaire', { url });
        if (!questionnaire) {
          throw new Error(`Questionnaire ${url} not found. Import the screening questionnaires first (Get Started).`);
        }
        const response = await executeBotByName<QuestionnaireResponse>(medplum, 'scribe-fill', {
          transcript,
          questionnaire,
          patient,
          encounter: encounterRef,
        });
        generated[url] = { questionnaire, response, saved: false };
      }
      setResults(generated);
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setGenerating(false);
    }
  };

  const handleChange = (url: string, response: QuestionnaireResponse): void => {
    setResults((prev) => {
      const existing = prev[url];
      if (!existing) {
        return prev;
      }
      return { ...prev, [url]: { ...existing, response: { ...existing.response, item: response.item }, saved: false } };
    });
  };

  const handleSave = async (url: string): Promise<void> => {
    const result = results[url];
    if (!result) {
      return;
    }
    try {
      const saved = await medplum.createResource<QuestionnaireResponse>({
        ...result.response,
        status: 'completed',
        questionnaire: result.questionnaire.url,
        subject: createReference(patient),
        encounter: createReference(encounter),
        authored: new Date().toISOString(),
      });
      setResults((prev) => ({ ...prev, [url]: { ...result, response: saved, saved: true } }));
      showSuccessNotification({
        title: 'Saved',
        message: `${result.questionnaire.title ?? result.questionnaire.name ?? 'Response'} linked to encounter`,
      });
    } catch (err) {
      showErrorNotification(err);
    }
  };

  return (
    <Stack gap="md">
      <Card withBorder shadow="sm">
        <Title order={4} mb="xs">
          Screening scribe
        </Title>
        <Text size="sm" c="dimmed" mb="sm">
          Speak or paste a visit transcript, then generate scored GAD-7 and PHQ-9 responses to review and save.
        </Text>
        <ScribeTextarea
          placeholder="Speak using the microphone, or paste a visit transcript here..."
          autosize
          minRows={4}
          maxRows={12}
          value={transcript}
          onChange={setTranscript}
        />
        <Button
          mt="md"
          onClick={() => handleGenerate().catch(showErrorNotification)}
          loading={generating}
          disabled={!transcript.trim()}
          leftSection={<IconSparkles size={16} />}
        >
          Generate screening questionnaires
        </Button>
      </Card>

      {SCREENING_QUESTIONNAIRE_URLS.map((url) => {
        const result = results[url];
        if (!result) {
          return null;
        }
        const score = scoreQuestionnaireResponse(result.response, result.questionnaire);
        return (
          <Card withBorder shadow="sm" key={url}>
            <Group justify="space-between" mb="sm">
              <Title order={4}>{result.questionnaire.title ?? result.questionnaire.name}</Title>
              <Badge size="lg" variant="light">
                Score: {score}
              </Badge>
            </Group>
            <QuestionnaireForm
              questionnaire={result.questionnaire}
              questionnaireResponse={result.response}
              excludeButtons={true}
              onChange={(response) => handleChange(url, response)}
            />
            <Group justify="flex-end" mt="md">
              {result.saved && (
                <Text size="sm" c="green">
                  Saved
                </Text>
              )}
              <Button onClick={() => handleSave(url).catch(showErrorNotification)} disabled={disabled || result.saved}>
                Save to encounter
              </Button>
            </Group>
          </Card>
        );
      })}
    </Stack>
  );
};
