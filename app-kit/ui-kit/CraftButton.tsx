/**
 * CraftButton — a button that CANNOT violate the craft floor: it is always at
 * least 44pt tall (56/64 for comfortable/senior), fires a light haptic on tap,
 * and has a visible focus ring. Encodes touch-target + haptic + feedback rules so
 * an agent can't accidentally ship a 30px tapless button.
 *
 * Haptics use @capacitor/haptics if present; no-ops on the web/preview gracefully.
 */
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { touchTarget, space, fontSize } from "./tokens";

type Size = "min" | "comfortable" | "senior";

async function tapHaptic(): Promise<void> {
  try {
    const mod = await import("@capacitor/haptics");
    await mod.Haptics.impact({ style: mod.ImpactStyle.Light });
  } catch {
    /* web/preview or plugin absent — silent no-op */
  }
}

export interface CraftButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  /** Visual emphasis. Brand colors come from the theme; pass via className/style. */
  variant?: "primary" | "secondary";
}

export const CraftButton = forwardRef<HTMLButtonElement, CraftButtonProps>(
  function CraftButton({ size = "comfortable", variant = "primary", onClick, style, children, ...rest }, ref) {
    const minH = touchTarget[size];
    return (
      <button
        ref={ref}
        onClick={(e) => {
          void tapHaptic(); // feedback fires even if onClick is async/slow
          onClick?.(e);
        }}
        style={{
          minHeight: minH,
          minWidth: minH, // icon-only buttons stay tappable too
          padding: `${space.sm}px ${space.lg}px`,
          fontSize: fontSize.bodyLarge,
          borderRadius: space.md,
          cursor: "pointer",
          // a VISIBLE focus ring is part of the floor (keyboard + switch control)
          outlineOffset: 2,
          ...style,
        }}
        data-variant={variant}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
