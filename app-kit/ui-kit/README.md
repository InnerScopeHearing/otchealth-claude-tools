# ui-kit — drop-in $10M craft primitives

The shared design system as **drop-in source** (the proven boot-gate model), so apps
adopt the craft floor TODAY without waiting on a published `@otchealth/ui` package.
This directory IS the content of that eventual package.

## What's here
| File | Encodes the rule |
|---|---|
| `tokens.ts` | The fleet tokens (8pt grid, type scale, 44/56/64pt targets, 100-500ms motion, contrast floors) + `Theme` (the only per-app override: fonts + palette) + `prefersReducedMotion()`. |
| `CraftButton.tsx` | A button that **can't** be smaller than 44pt, fires a light haptic on tap, has a visible focus ring. |
| `Skeleton.tsx` | Shape-of-content loaders (never a bare spinner) + a ready-made `SkeletonList`. |
| `EmptyState.tsx` | The designed zero-state (illustration + value line + one action) every list must ship. |

The other two required patterns already live in `skills/boot-gate/templates/`:
`ErrorBoundary.tsx` (visible fallback, never a silent screen) and `main-boot.tsx`
(`SplashScreen.hide()` in `finally`). Adopt all of them together.

## Adopt
1. Copy `app-kit/ui-kit/*` into the app (e.g. `src/ui/`). Peer deps: `react`,
   `@capacitor/haptics` (optional — degrades to no-op).
2. Define the app `Theme` (fonts + palette only) and inject `skeletonKeyframes` once
   at root.
3. Use `CraftButton` for every button, `SkeletonList`/`Skeleton` for every load,
   `EmptyState` for every empty list. Pair with the boot-gate ErrorBoundary + boot
   pattern.
4. Verify with the boot-gate (render gate confirms no blank screens; a11y check
   confirms the 44pt+ targets).

## Productization (next, needs an infra decision)
To become a real published `@otchealth/ui` the fleet `import`s, pick a consumption
mechanism (npm registry / GitHub Packages / git submodule) + a build (tsup/vite) +
versioning. That is a CTO/Matt call; until then these drop-in primitives deliver the
same craft floor with zero infra. Rules source: `app-kit/AI-AGENT-APP-BUILDING-BIBLE.md`.
