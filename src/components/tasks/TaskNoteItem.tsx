// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Badge, Card, Divider, Group, List, Stack, Text, Title } from '@mantine/core';
import { formatDateTime, getDisplayString } from '@medplum/core';
import type { Annotation } from '@medplum/fhirtypes';
import { ResourceAvatar, useResource } from '@medplum/react';
import React from 'react';

interface TaskNoteItemProps {
  note: Annotation;
  index: number;
}

interface TrialRecommendation {
  priority: string;
  nctId: string;
  url: string;
  reasoning: string;
  eligibility: string;
  medicationConsiderations?: string;
  nextSteps?: string;
}

interface ClinicalTrialsAnalysis {
  patientSummary: string;
  recommendations: TrialRecommendation[];
  overallAssessment: string;
  priorityActions: string[];
}

function parseClinicalTrialsAnalysis(text: string): ClinicalTrialsAnalysis | null {
  if (!text.includes('Clinical Trials Analysis') || !text.includes('TRIAL RECOMMENDATIONS:')) {
    return null;
  }

  const lines = text.split('\n');
  const analysis: ClinicalTrialsAnalysis = {
    patientSummary: '',
    recommendations: [],
    overallAssessment: '',
    priorityActions: []
  };

  let currentSection = '';
  let currentRecommendation: Partial<TrialRecommendation> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith('PATIENT SUMMARY:')) {
      currentSection = 'patient';
      analysis.patientSummary = trimmed.replace('PATIENT SUMMARY:', '').trim();
    } else if (trimmed.startsWith('TRIAL RECOMMENDATIONS:')) {
      currentSection = 'recommendations';
    } else if (trimmed.startsWith('OVERALL ASSESSMENT:')) {
      currentSection = 'assessment';
      analysis.overallAssessment = trimmed.replace('OVERALL ASSESSMENT:', '').trim();
    } else if (trimmed.startsWith('PRIORITY ACTIONS:')) {
      currentSection = 'actions';
    } else if (currentSection === 'patient' && trimmed) {
      analysis.patientSummary += (analysis.patientSummary ? ' ' : '') + trimmed;
    } else if (currentSection === 'recommendations') {
      if (trimmed.match(/^\d+\.\s+(HIGH|MEDIUM|LOW)\s+PRIORITY$/)) {
        if (currentRecommendation.priority) {
          analysis.recommendations.push(currentRecommendation as TrialRecommendation);
        }
        currentRecommendation = { priority: trimmed.match(/(HIGH|MEDIUM|LOW)/)?.[1] || '' };
      } else if (trimmed.startsWith('NCT ID:')) {
        currentRecommendation.nctId = trimmed.replace('NCT ID:', '').trim();
      } else if (trimmed.startsWith('Trial URL:')) {
        currentRecommendation.url = trimmed.replace('Trial URL:', '').trim();
      } else if (trimmed.startsWith('Reasoning:')) {
        currentRecommendation.reasoning = trimmed.replace('Reasoning:', '').trim();
      } else if (trimmed.startsWith('Eligibility:')) {
        currentRecommendation.eligibility = trimmed.replace('Eligibility:', '').trim();
      } else if (trimmed.startsWith('Medication Considerations:')) {
        currentRecommendation.medicationConsiderations = trimmed.replace('Medication Considerations:', '').trim();
      } else if (trimmed.startsWith('Next Steps:')) {
        currentRecommendation.nextSteps = trimmed.replace('Next Steps:', '').trim();
      }
    } else if (currentSection === 'assessment' && trimmed) {
      analysis.overallAssessment += (analysis.overallAssessment ? ' ' : '') + trimmed;
    } else if (currentSection === 'actions' && trimmed.match(/^\d+\.\s+/)) {
      analysis.priorityActions.push(trimmed.replace(/^\d+\.\s+/, ''));
    }
  }

  // Add the last recommendation
  if (currentRecommendation.priority) {
    analysis.recommendations.push(currentRecommendation as TrialRecommendation);
  }

  return analysis;
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'HIGH': return 'red';
    case 'MEDIUM': return 'orange';
    case 'LOW': return 'blue';
    default: return 'gray';
  }
}

function formatClinicalTrialsNote(analysis: ClinicalTrialsAnalysis): React.JSX.Element {
  return (
    <Stack gap="lg">
      {/* Patient Summary */}
      <Card withBorder p="md">
        <Title order={4} mb="sm">Patient Summary</Title>
        <Text size="sm">{analysis.patientSummary}</Text>
      </Card>

      {/* Trial Recommendations */}
      <Stack gap="md">
        <Title order={4}>Trial Recommendations ({analysis.recommendations.length})</Title>
        {analysis.recommendations.map((rec, index) => (
          <Card key={index} withBorder p="md">
            <Group align="center" mb="sm">
              <Badge color={getPriorityColor(rec.priority)} variant="filled">
                {rec.priority} PRIORITY
              </Badge>
              <Text fw={600}>{rec.nctId}</Text>
              {rec.url && (
                <Anchor href={rec.url} target="_blank" size="sm">
                  View Trial
                </Anchor>
              )}
            </Group>
            
            <Stack gap="xs">
              <div>
                <Text fw={500} size="sm">Reasoning:</Text>
                <Text size="sm" c="dimmed">{rec.reasoning}</Text>
              </div>
              
              <div>
                <Text fw={500} size="sm">Eligibility Assessment:</Text>
                <Text size="sm" c="dimmed">{rec.eligibility}</Text>
              </div>
              
              {rec.medicationConsiderations && (
                <div>
                  <Text fw={500} size="sm">Medication Considerations:</Text>
                  <Text size="sm" c="dimmed">{rec.medicationConsiderations}</Text>
                </div>
              )}
              
              {rec.nextSteps && (
                <div>
                  <Text fw={500} size="sm">Next Steps:</Text>
                  <Text size="sm" c="dimmed">{rec.nextSteps}</Text>
                </div>
              )}
            </Stack>
          </Card>
        ))}
      </Stack>

      {/* Overall Assessment */}
      <Card withBorder p="md">
        <Title order={4} mb="sm">Overall Assessment</Title>
        <Text size="sm">{analysis.overallAssessment}</Text>
      </Card>

      {/* Priority Actions */}
      {analysis.priorityActions.length > 0 && (
        <Card withBorder p="md">
          <Title order={4} mb="sm">Priority Actions</Title>
          <List size="sm">
            {analysis.priorityActions.map((action, index) => (
              <List.Item key={index}>{action}</List.Item>
            ))}
          </List>
        </Card>
      )}
    </Stack>
  );
}

function renderTextWithLinks(text: string): React.ReactNode {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);

  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      return (
        <Anchor key={index} href={part} target="_blank" rel="noopener noreferrer">
          {part}
        </Anchor>
      );
    }
    return part;
  });
}

export function TaskNoteItem(props: TaskNoteItemProps): React.JSX.Element {
  const { note } = props;
  const author = useResource(note.authorReference);
  const clinicalAnalysis = note.text ? parseClinicalTrialsAnalysis(note.text) : null;

  return (
    <Stack gap="md" pt="sm" pb="sm">
      <Group align="center" gap="xs">
        <ResourceAvatar value={note.authorReference} radius="xl" size={36} />
        <Text fw={500}>{author && getDisplayString(author)}</Text>
        <Text>{formatDateTime(note.time ?? '')}</Text>
      </Group>
      {clinicalAnalysis ? (
        formatClinicalTrialsNote(clinicalAnalysis)
      ) : (
        <Text style={{ whiteSpace: 'pre-wrap' }}>{note.text ? renderTextWithLinks(note.text) : ''}</Text>
      )}
      <Divider />
    </Stack>
  );
}
