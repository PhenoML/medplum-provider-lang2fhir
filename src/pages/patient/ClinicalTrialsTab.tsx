// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Card, Group, Loader, Stack, Text, Title, Alert, Badge, Divider } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconSearch, IconInfoCircle, IconMapPin, IconStethoscope, IconPill } from '@tabler/icons-react';
import { useState, useEffect, JSX } from 'react';
import { usePatient } from '../../hooks/usePatient';

interface SearchCriteria {
  location?: string;
  conditions: string[];
  medications: string[];
  age?: number;
  sex?: string;
}

/**
 * ClinicalTrialsTab component for searching clinical trials for a patient
 * @returns JSX element for the clinical trials tab
 */
export function ClinicalTrialsTab(): JSX.Element {
  const medplum = useMedplum();
  const patient = usePatient();
  const [loading, setLoading] = useState(false);
  const [searchCriteria, setSearchCriteria] = useState<SearchCriteria | null>(null);
  const [lastSearchResult, setLastSearchResult] = useState<{ trialsFound: number; communicationId: string } | null>(null);

  // Extract patient info for display
  useEffect(() => {
    if (patient) {
      const criteria: SearchCriteria = {
        conditions: [],
        medications: [],
      };

      // Extract location
      if (patient.address && patient.address.length > 0) {
        const address = patient.address[0];
        const locationParts = [address.city, address.state].filter(Boolean);
        criteria.location = locationParts.length > 0 ? locationParts.join(', ') : address.postalCode;
      }

      // Extract age
      if (patient.birthDate) {
        const birth = new Date(patient.birthDate);
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const monthDiff = today.getMonth() - birth.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
          age--;
        }
        criteria.age = age;
      }

      // Extract sex
      if (patient.gender) {
        criteria.sex = patient.gender;
      }

      setSearchCriteria(criteria);
    }
  }, [patient]);

  /**
   * Handles clinical trials search by invoking the clinical trials bot
   */
  const onSearchTrials = async (): Promise<void> => {
    if (!patient?.id) {
      showNotification({
        color: 'red',
        title: 'Error',
        message: 'No patient selected',
      });
      return;
    }

    setLoading(true);
    try {
      // Find the clinical trials bot by name
      const clinicalTrialsBot = await medplum.searchOne('Bot', { name: 'clinical-trials-bot' });
      if (!clinicalTrialsBot?.id) {
        throw new Error('Bot "clinical-trials-bot" not found or invalid');
      }

      const result = await medplum.executeBot(
        clinicalTrialsBot.id,
        {
          patient: patient,
          practitioner: medplum.getProfile(),
        },
        'application/json'
      );

      setLastSearchResult({
        trialsFound: result.trialsFound || 0,
        communicationId: result.communication?.id || 'unknown',
      });

      showNotification({
        color: 'green',
        title: 'Clinical Trials Search Complete',
        message: `Found ${result.trialsFound || 0} clinical trials. Results sent to practitioner.`,
      });
    } catch (error) {
      console.error('Clinical trials search failed:', error);
      showNotification({
        color: 'red',
        title: 'Error',
        message: normalizeErrorString(error),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack>
      <Card withBorder>
        <Group justify="space-between" mb="md">
          <Title order={3}>Clinical Trials Search</Title>
          <Button
            leftSection={<IconSearch size={16} />}
            onClick={onSearchTrials}
            loading={loading}
            disabled={!patient?.id}
          >
            Search Trials
          </Button>
        </Group>
        <Text size="sm" c="dimmed" mb="md">
          Search for clinical trials that match this patient's profile using AI analysis. 
          The search will prioritize local trials but expand geographically to find the best matches.
          Results will be sent as a communication to the practitioner.
        </Text>
      </Card>

      {/* Patient Search Criteria */}
      {searchCriteria && (
        <Card withBorder>
          <Title order={4} mb="md">Search Criteria</Title>
          
          <Group mb="sm">
            <IconMapPin size={16} />
            <Text size="sm" fw={500}>Location:</Text>
            {searchCriteria.location ? (
              <Badge color="blue" variant="light">{searchCriteria.location}</Badge>
            ) : (
              <Text size="sm" c="orange">No address found - will search nationally</Text>
            )}
          </Group>

          {searchCriteria.age && (
            <Group mb="sm">
              <Text size="sm" fw={500}>Age:</Text>
              <Badge color="gray" variant="light">{searchCriteria.age} years</Badge>
            </Group>
          )}

          {searchCriteria.sex && (
            <Group mb="sm">
              <Text size="sm" fw={500}>Sex:</Text>
              <Badge color="gray" variant="light">{searchCriteria.sex}</Badge>
            </Group>
          )}

          <Divider my="md" />

          <Group mb="sm">
            <IconStethoscope size={16} />
            <Text size="sm" fw={500}>Active Conditions:</Text>
          </Group>
          <Text size="sm" c="dimmed" mb="sm">
            Clinical trials will be searched based on the patient's active conditions from their medical record.
          </Text>

          <Group mb="sm">
            <IconPill size={16} />
            <Text size="sm" fw={500}>Current Medications:</Text>
          </Group>
          <Text size="sm" c="dimmed">
            Current medications will be considered for trial eligibility and potential interactions.
          </Text>
        </Card>
      )}

      {loading && (
        <Card withBorder>
          <Group>
            <Loader size="sm" />
            <div>
              <Text>Analyzing patient data and searching clinical trials...</Text>
              <Text size="sm" c="dimmed">
                Searching locally first, then expanding geographically to find the best matches
              </Text>
            </div>
          </Group>
        </Card>
      )}

      {lastSearchResult && (
        <Alert 
          icon={<IconInfoCircle size={16} />} 
          title="Search Completed" 
          color="blue"
        >
          <Text size="sm">
            Found <strong>{lastSearchResult.trialsFound}</strong> recruiting clinical trials.
          </Text>
          <Text size="sm" mt="xs">
            A detailed AI-generated analysis has been sent to the practitioner with:
          </Text>
          <ul style={{ marginTop: '8px', marginBottom: '8px', paddingLeft: '20px' }}>
            <li><Text size="sm">Trial eligibility assessment</Text></li>
            <li><Text size="sm">Geographic feasibility analysis</Text></li>
            <li><Text size="sm">Specific recommendations</Text></li>
            <li><Text size="sm">Next steps for promising trials</Text></li>
            <li><Text size="sm">Contact information and locations</Text></li>
          </ul>
          <Text size="sm" mt="xs">
            You can view the detailed results in the <strong>Communications</strong> tab.
          </Text>
          {lastSearchResult.communicationId !== 'unknown' && (
            <Text size="xs" c="dimmed" mt="xs">
              Communication ID: {lastSearchResult.communicationId}
            </Text>
          )}
        </Alert>
      )}

      {!loading && !lastSearchResult && (
        <Card withBorder>
          <Text ta="center" c="dimmed">
            Click "Search Trials" to analyze this patient's profile and find relevant clinical trials
          </Text>
        </Card>
      )}
    </Stack>
  );
} 