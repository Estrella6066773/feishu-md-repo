import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
  padding = true,
}: {
  children: ReactNode;
  className?: string;
  padding?: boolean;
}) {
  return (
    <div className={`card ${padding ? 'card-padded' : ''} ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-header">
      <div>
        <h2 className="card-title">{title}</h2>
        {description ? <p className="card-desc">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'success' | 'danger' | 'warning';
  icon?: ReactNode;
}) {
  const toneClass =
    tone === 'success'
      ? 'stat-success'
      : tone === 'danger'
        ? 'stat-danger'
        : tone === 'warning'
          ? 'stat-warning'
          : '';

  return (
    <div className={`stat-card ${toneClass}`}>
      <div className="stat-card-top">
        <span className="stat-label">{label}</span>
        {icon ? <span className="stat-icon">{icon}</span> : null}
      </div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}
