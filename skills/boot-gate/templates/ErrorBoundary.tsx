/**
 * ErrorBoundary.tsx — a top-level boundary that renders a VISIBLE fallback
 * instead of a silent white/green screen, and reports the crash. Wrap <App/>.
 * Drop into src/boot/.
 */
import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Never swallow silently — report so Sentry/PostHog sees the boot crash.
    (window as unknown as { Sentry?: { captureException?: (e: unknown) => void } })
      .Sentry?.captureException?.(error);
  }

  render(): ReactNode {
    if (this.state.error) {
      // A VISIBLE fallback. Not a blank screen. The render gate passes and a
      // human/tester sees a real message instead of "stuck".
      return (
        <div
          role="alert"
          style={{
            padding: 24,
            fontSize: 18,
            lineHeight: 1.5,
            color: "#111",
            background: "#fff",
            minHeight: "100vh",
          }}
        >
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>
            Something went wrong starting the app.
          </h1>
          <p>Please close and reopen. If it keeps happening, contact support.</p>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 16, opacity: 0.7 }}>
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
