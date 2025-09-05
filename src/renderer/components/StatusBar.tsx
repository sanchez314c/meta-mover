import React from 'react';
import {
  StatusBar as StatusBarStyled,
  StatusLeft,
  StatusRight,
  StatusDot,
  StatusDivider,
  AppVersion,
  ProcessingSpinner,
} from '../styles/components';

interface StatusBarProps {
  status: 'ready' | 'processing' | 'error';
  statusText: string;
  itemCountText: string;
}

export function StatusBarComponent({ status, statusText, itemCountText }: StatusBarProps) {
  return (
    <StatusBarStyled>
      <StatusLeft>
        {status === 'processing' ? <ProcessingSpinner /> : <StatusDot $status={status} />}
        <span>Status: {statusText}</span>
        <StatusDivider>|</StatusDivider>
        <span>{itemCountText}</span>
      </StatusLeft>
      <StatusRight>
        <AppVersion>v1.0.0</AppVersion>
      </StatusRight>
    </StatusBarStyled>
  );
}
