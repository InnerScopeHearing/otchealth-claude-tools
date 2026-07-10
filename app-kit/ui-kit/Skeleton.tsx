/**
 * Skeleton — shape-of-content loading placeholder. Required pattern: NEVER a bare
 * spinner; show the shape of what's coming so perceived performance is high
 * (a skeleton at 800ms feels faster than a blank at 400ms). Honors reduced motion.
 */
import type { CSSProperties } from "react";
import { space, prefersReducedMotion } from "./tokens";

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 16, radius = space.xs, style }: SkeletonProps) {
  const animate = !prefersReducedMotion();
  return (
    <div
      aria-hidden
      style={{
        width,
        height,
        borderRadius: radius,
        background:
          "linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.14) 37%, rgba(255,255,255,0.06) 63%)",
        backgroundSize: "400% 100%",
        animation: animate ? "fleet-skeleton 1.4s ease infinite" : undefined,
        ...style,
      }}
    />
  );
}

/** Inject once at app root (or paste into global CSS). */
export const skeletonKeyframes = `
@keyframes fleet-skeleton { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
`;

/** A ready-made list skeleton: N rows of shaped placeholders. */
export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md, padding: space.base }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", gap: space.md, alignItems: "center" }}>
          <Skeleton width={48} height={48} radius={space.md} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: space.sm }}>
            <Skeleton width="60%" height={14} />
            <Skeleton width="40%" height={12} />
          </div>
        </div>
      ))}
    </div>
  );
}
