// Small shared building blocks.
import type { ReactNode } from 'react';

export function Panel({
  title,
  actions,
  className,
  busy,
  children,
}: {
  title: string;
  actions?: ReactNode;
  className?: string;
  /** True while this panel's data is being refetched: announced, and dimmed slightly. */
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${className ?? ''}`} aria-label={title} aria-busy={busy ? 'true' : undefined}>
      <div className="panel-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Reserves the final size of content that is still loading, so nothing jumps when it arrives. */
export function Skeleton({ height }: { height: number }) {
  return <span className="skel" style={{ height }} role="progressbar" aria-busy="true" aria-label="Loading" />;
}

/** A failed data source, shown where its content would have been. */
export function ErrorNote({ source, message }: { source: string; message: string }) {
  return (
    <div className="alert" role="alert" data-error-source={source}>
      Could not load {source}: {message}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div className={`segmented ${className ?? ''}`} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
