type Tone = 'default' | 'blue' | 'green' | 'amber' | 'red';

const toneClass: Record<Tone, string> = {
  default: 'badge-default',
  blue: 'badge-blue',
  green: 'badge-green',
  amber: 'badge-amber',
  red: 'badge-red',
};

export function Badge({ children, tone = 'default' }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`badge ${toneClass[tone]}`}>{children}</span>;
}
