/**
 * EmptyState — the designed zero-state every list/feed/vault must ship. An empty
 * surface is NOT a blank: illustration + one value line + one primary action.
 * (Apple Review 4.2: an app that looks empty/unfinished gets rejected. And a blank
 * screen is the craft failure this whole kit exists to prevent.)
 */
import type { ReactNode } from "react";
import { space, fontSize, lineHeight } from "./tokens";
import { CraftButton } from "./CraftButton";

export interface EmptyStateProps {
  /** An illustration/icon node. Always provide one — never a bare blank. */
  illustration: ReactNode;
  title: string;
  /** One line on the value / what to do. Keep it short and concrete. */
  message: string;
  /** The single primary action that moves the user toward the aha moment. */
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ illustration, title, message, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: space.base,
        padding: space.xl,
        maxWidth: 360,
        margin: "0 auto",
      }}
    >
      <div aria-hidden style={{ width: 160, height: 160, display: "grid", placeItems: "center" }}>
        {illustration}
      </div>
      <h2 style={{ fontSize: fontSize.title, lineHeight: lineHeight.heading, margin: 0 }}>{title}</h2>
      <p style={{ fontSize: fontSize.body, lineHeight: lineHeight.body, opacity: 0.8, margin: 0 }}>
        {message}
      </p>
      {actionLabel && onAction && (
        <CraftButton size="comfortable" onClick={onAction} style={{ marginTop: space.sm }}>
          {actionLabel}
        </CraftButton>
      )}
    </div>
  );
}
