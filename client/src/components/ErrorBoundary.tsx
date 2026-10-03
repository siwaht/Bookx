import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
          <div className="flex w-full max-w-2xl flex-col items-center rounded-panel border border-stone-150 bg-paper p-8 shadow-float">
            <span className="mb-6 grid h-14 w-14 flex-shrink-0 place-items-center rounded-2xl bg-clay-50 ring-1 ring-clay-100">
              <AlertTriangle
                size={28}
                strokeWidth={1.75}
                className="text-destructive"
              />
            </span>

            <h2 className="serif mb-5 text-[28px] leading-tight text-ink-950">An unexpected error occurred.</h2>

            <div className="mb-6 w-full overflow-auto rounded-xl border border-stone-150 bg-muted p-4">
              <pre className="mono whitespace-break-spaces text-xs leading-5 text-muted-foreground">
                {this.state.error?.stack}
              </pre>
            </div>

            <button
              onClick={() => window.location.reload()}
              className={cn(
                "btn-primary btn-lg",
                "cursor-pointer"
              )}
            >
              <RotateCcw size={16} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
