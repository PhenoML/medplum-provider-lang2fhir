// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { BotEvent, MedplumClient } from '@medplum/core';
import { PhenoMLClient, phenoml } from 'phenoml';

/**
 * A Medplum Bot that executes PhenoML workflows.
 *
 * This bot takes a workflow ID and input data, executes the workflow
 * using the PhenoML SDK, and returns the workflow execution results.
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_EMAIL: Your PhenoML API email
 * - PHENOML_PASSWORD: Your PhenoML API password
 */

export interface WorkflowBotInput {
  /** The ID of the workflow to execute */
  workflowId: string;
  /** Input data for the workflow execution */
  inputData: Record<string, unknown>;
}

export interface WorkflowBotOutput {
  /** Whether the workflow execution was successful */
  success: boolean;
  /** Status message with execution details */
  message: string;
  /** The workflow ID that was executed */
  workflowId: string;
  /** Results from the workflow execution */
  results?: phenoml.workflows.ExecuteWorkflowResponse['results'];
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<WorkflowBotInput>
): Promise<WorkflowBotOutput> {
  try {
    const { workflowId, inputData } = event.input;

    // Validate required inputs
    if (!workflowId) {
      throw new Error('Workflow ID is required');
    }
    if (!inputData || typeof inputData !== 'object') {
      throw new Error('Input data is required and must be an object');
    }

    // Get PhenoML credentials from secrets
    const email = event.secrets['PHENOML_EMAIL']?.valueString;
    const password = event.secrets['PHENOML_PASSWORD']?.valueString;

    if (!email || !password) {
      throw new Error('PhenoML credentials (PHENOML_EMAIL and PHENOML_PASSWORD) are required');
    }

    // Initialize PhenoML client with automatic auth handling
    const client = new PhenoMLClient({
      username: email,
      password,
      baseUrl: 'http://localhost:8090',  // Local PhenoML server
    });

    // Execute the workflow
    const result = await client.workflows.execute(workflowId, {
      input_data: inputData,
    });

    return {
      success: result.success ?? false,
      message: result.message ?? 'Workflow executed',
      workflowId,
      results: result.results,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow execution failed: ${errorMessage}`);
  }
}
