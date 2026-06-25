/**
 * tokens.ts — the fleet design tokens as typed TS (mirror of
 * app-kit/design-tokens.json). The brand-agnostic foundation; a per-app theme
 * overrides ONLY `fonts` and `palette`. Everything else is fleet-law.
 *
 * Drop-in: copy app-kit/ui-kit/* into the app (e.g. src/ui/) until @otchealth/ui
 * is published. Source of the rules: app-kit/AI-AGENT-APP-BUILDING-BIBLE.md Part 2.
 */

/** 8pt grid — every margin/padding is one of these. Never eyeball. */
export const space = { xs: 4, sm: 8, md: 12, base: 16, lg: 24, xl: 32, xxl: 48, xxxl: 64 } as const;

/** Type scale (pt). Senior/kid apps default body to 18-20. At most TWO families. */
export const fontSize = { caption: 13, body: 16, bodyLarge: 18, title: 22, h2: 28, h1: 34 } as const;
export const lineHeight = { body: 1.5, heading: 1.2 } as const;

/** Touch targets (pt). Apple floor 44; senior/kid 56-64. */
export const touchTarget = { min: 44, comfortable: 56, senior: 64 } as const;

/** Motion — 100-500ms, consistent easing. Always gate on prefers-reduced-motion. */
export const motion = {
  duration: { fast: 150, base: 250, slow: 400 },
  easing: {
    entrance: "cubic-bezier(0,0,0.2,1)",
    move: "cubic-bezier(0.4,0,0.2,1)",
    exit: "cubic-bezier(0.4,0,1,1)",
  },
} as const;

/** Contrast floors (WCAG). Body >=4.5:1, large >=3:1. */
export const contrast = { bodyMin: 4.5, largeMin: 3.0 } as const;

/** Per-app theme: the ONLY values an app overrides. */
export interface Theme {
  fonts: { display: string; body: string };
  palette: {
    primary: string;
    surface: string;
    onSurface: string;
    danger: string;
    success: string;
    warning: string;
  };
  /** true for senior/kid apps -> larger defaults (body 20, target 64). */
  largeDefaults?: boolean;
}

/** True when the user has prefers-reduced-motion set. Use to skip non-essential motion. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
