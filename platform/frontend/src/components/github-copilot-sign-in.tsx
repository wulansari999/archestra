"use client";

import { Check, Copy, Github, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type GithubCopilotDeviceStart,
  usePollGithubCopilotDeviceFlow,
  useStartGithubCopilotDeviceFlow,
} from "@/lib/github-copilot-auth.query";

interface GithubCopilotSignInProps {
  /** Receives the user's GitHub OAuth token once the device flow completes. */
  onToken: (token: string) => void;
  disabled?: boolean;
}

/**
 * "Sign in with GitHub" device flow (RFC 8628): shows a one-time code the
 * user enters at github.com, then polls until GitHub hands back the OAuth
 * token that becomes the GitHub Copilot provider key.
 */
export function GithubCopilotSignIn({
  onToken,
  disabled,
}: GithubCopilotSignInProps) {
  const start = useStartGithubCopilotDeviceFlow();
  const poll = usePollGithubCopilotDeviceFlow();
  const [flow, setFlow] = useState<GithubCopilotDeviceStart | null>(null);
  const [completed, setCompleted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  // Mutation fns in a ref so the polling effect doesn't restart per render.
  const pollRef = useRef(poll.mutateAsync);
  pollRef.current = poll.mutateAsync;
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(copyResetTimeout.current), []);

  useEffect(() => {
    if (!flow || completed) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    let intervalMs = Math.max(flow.interval, 1) * 1000;
    const deadline = Date.now() + flow.expiresIn * 1000;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setExpired(true);
        setFlow(null);
        return;
      }
      const result = await pollRef.current(flow.deviceCode);
      if (cancelled) return;
      if (!result) {
        // request failed (toast already shown) — abandon this flow
        setFlow(null);
        return;
      }
      if (result.status === "complete") {
        setCompleted(true);
        onTokenRef.current(result.accessToken);
        return;
      }
      if (result.status === "slow_down") {
        intervalMs += 5000;
      }
      timeout = setTimeout(tick, intervalMs);
    };

    timeout = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [flow, completed]);

  const begin = async () => {
    setExpired(false);
    setCompleted(false);
    const result = await start.mutateAsync();
    if (result) setFlow(result);
  };

  if (completed) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="h-4 w-4 text-green-500" />
        GitHub account linked — the token has been filled in above.
      </p>
    );
  }

  if (flow) {
    return (
      <div className="space-y-2 rounded-md border p-3">
        <p className="text-xs text-muted-foreground">
          Open{" "}
          <Link
            href={flow.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            {flow.verificationUri}
          </Link>{" "}
          and enter this code:
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest">
            {flow.userCode}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={async () => {
              await navigator.clipboard.writeText(flow.userCode);
              setCodeCopied(true);
              clearTimeout(copyResetTimeout.current);
              copyResetTimeout.current = setTimeout(
                () => setCodeCopied(false),
                2000,
              );
            }}
          >
            {codeCopied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Waiting for authorization…
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || start.isPending}
        onClick={begin}
      >
        {start.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Github className="mr-2 h-4 w-4" />
        )}
        Sign in with GitHub
      </Button>
      {expired && (
        <p className="text-xs text-destructive">
          The sign-in expired before it was authorized — try again.
        </p>
      )}
    </div>
  );
}
