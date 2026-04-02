import React from 'react';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  style?: React.CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, borderRadius = 6, style }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius, flexShrink: 0, ...style }}
      aria-hidden="true"
    />
  );
}

export function CardSkeleton() {
  return (
    <div style={{
      padding: 18, background: 'var(--bg-surface)',
      borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <Skeleton width={42} height={42} borderRadius="var(--radius-md)" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Skeleton width="65%" height={14} />
        <Skeleton width="35%" height={10} />
      </div>
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
        <Skeleton width={60} height={16} borderRadius={20} />
        <Skeleton width={70} height={10} />
      </div>
    </div>
  );
}

export function PageSkeleton({ lines = 5 }: { lines?: number }) {
  return (
    <div style={{ padding: '32px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Skeleton width="40%" height={24} />
      <Skeleton width="60%" height={12} />
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} width={`${85 - i * 8}%`} height={12} />
        ))}
      </div>
    </div>
  );
}
