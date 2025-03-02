import { Text, Anchor } from '@mantine/core';
import phenomlLogo from './phenoml.svg';

export function PhenoMLBranding(): JSX.Element {
  return (
    <Anchor href="https://phenoml.com" target="_blank" underline="never" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, whiteSpace: 'nowrap' }}>
      <Text component="span" size="s" c="gray.4">powered by</Text>
      <img src={phenomlLogo} alt="PhenoML" width={50} height={11} style={{ marginLeft: '4px' }} />
    </Anchor>
  );
} 