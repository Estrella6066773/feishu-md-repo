export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <span className={`spinner ${className}`} aria-hidden />;
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner className="h-6 w-6" />
      <span>{label}</span>
    </div>
  );
}
