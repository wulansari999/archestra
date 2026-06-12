import config from "@/config";
import logger from "@/logging";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import { ApiError } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import type { ModelInfo } from "./types";

/**
 * Fetches the models available to the Copilot subscription behind the given
 * GitHub OAuth token. `apiKey` is the GitHub token; the Copilot fetch wrapper
 * exchanges it for the short-lived bearer the /models endpoint requires.
 *
 * Copilot lists every model it knows about; entries disabled by org policy
 * (`policy.state: "disabled"`) or hidden from pickers
 * (`model_picker_enabled: false` — dated snapshots, embeddings, etc.) are
 * filtered out to mirror what official Copilot clients offer.
 */
export async function fetchGithubCopilotModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm["github-copilot"].baseUrl;
  const copilotFetch = createGithubCopilotFetch({ githubToken: apiKey });

  const response = await copilotFetch(joinBaseUrl(baseUrl, "/models"), {
    headers: { ...(extraHeaders ?? {}) },
  });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText.slice(0, 500) },
      "Failed to fetch GitHub Copilot models",
    );
    // The Copilot fetch wrapper reports token-exchange failures as an
    // OpenAI-shaped error Response; surface its curated message (e.g. "no
    // Copilot subscription") so key validation shows the real cause.
    if (response.status === 401) {
      throw new ApiError(401, extractErrorMessage(errorText));
    }
    throw new Error(
      `Failed to fetch GitHub Copilot models: ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    data?: GithubCopilotModel[];
  };

  return (Array.isArray(payload.data) ? payload.data : [])
    .filter(
      (model) =>
        model.model_picker_enabled !== false &&
        model.policy?.state !== "disabled",
    )
    .map((model) => ({
      id: model.id,
      displayName: model.name || model.id,
      provider: "github-copilot" as const,
      capabilities: {
        contextLength:
          model.capabilities?.limits?.max_context_window_tokens ?? null,
        supportsToolCalling: model.capabilities?.supports?.tool_calls ?? null,
      },
    }));
}

// ===== Internal helpers =====

function extractErrorMessage(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // not JSON — fall through to the generic message
  }
  return "GitHub token was rejected by the Copilot API";
}

interface GithubCopilotModel {
  id: string;
  name?: string;
  model_picker_enabled?: boolean;
  policy?: { state?: string };
  capabilities?: {
    limits?: { max_context_window_tokens?: number };
    supports?: { tool_calls?: boolean };
  };
}
