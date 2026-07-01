// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { ResourceType, Questionnaire } from '@medplum/fhirtypes';
import { Document, QuestionnaireForm, useResource } from '@medplum/react';
import type { JSX } from 'react';
import { useParams } from 'react-router';

export function QuestionnairePreviewPage(): JSX.Element | null {
  const { resourceType, id } = useParams() as { resourceType: ResourceType; id: string };
  const resource = useResource<Questionnaire>({ reference: resourceType + '/' + id });

  if (!resource) {
    return null;
  }
  
  return (
    <Document>
      <QuestionnaireForm
        questionnaire={{ reference: resourceType + '/' + id }}
        onSubmit={() => alert('You submitted the preview')}
      />
    </Document>
  );
}
