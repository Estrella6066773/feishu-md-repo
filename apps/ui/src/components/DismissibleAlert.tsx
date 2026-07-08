import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';

export interface DismissibleAlertProps {
  tone: 'success' | 'danger' | 'warning' | 'info';
  title: string;
  children: ReactNode;
  onDismiss: () => void;
}

export function DismissibleAlert({ tone, title, children, onDismiss }: DismissibleAlertProps) {
  return (
    <Alert tone={tone} title={title}>
      {children}
      <button type="button" className="ml-3 text-xs underline opacity-80" onClick={onDismiss}>
        关闭
      </button>
    </Alert>
  );
}
