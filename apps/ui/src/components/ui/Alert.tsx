type Tone = 'info' | 'success' | 'warning' | 'danger';

const toneClass: Record<Tone, string> = {
  info: 'alert-info',
  success: 'alert-success',
  warning: 'alert-warning',
  danger: 'alert-danger',
};

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`alert ${toneClass[tone]}`} role="alert">
      {title ? <div className="alert-title">{title}</div> : null}
      <div className="alert-body">{children}</div>
    </div>
  );
}
