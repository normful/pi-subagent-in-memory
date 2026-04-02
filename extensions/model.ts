import { getModel, getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
}

/**
 * Resolve a model and its API key using ModelRegistry + AuthStorage.
 * Supports subscription/OAuth-based API keys without requiring env vars.
 */
export async function resolveModel(
  provider: string,
  modelId: string,
): Promise<ResolvedModel> {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // Try ModelRegistry first (includes custom models from models.json),
  // fall back to pi-ai's built-in getModel.
  let model: Model<Api> | undefined;
  try {
    model = modelRegistry.find(provider, modelId);
  } catch {
    // ModelRegistry.find may throw if registry failed to load
  }
  if (!model) {
    try {
      model = getModel(provider as any, modelId as any);
    } catch {
      // getModel throws if provider/model combo is unknown
    }
  }
  if (!model) {
    throw new Error(
      `Could not find model ${provider}/${modelId}. Check provider and model parameters.`,
    );
  }

  // Resolve API key: try ModelRegistry, then AuthStorage directly
  let apiKey: string | undefined;
  try {
    apiKey = await modelRegistry.getApiKey(model);
  } catch {
    // Fall back to AuthStorage if ModelRegistry method fails
    apiKey = await authStorage.getApiKey(provider);
  }
  if (!apiKey) {
    throw new Error(
      `No API key for ${provider}. Login or set the appropriate API key env var.`,
    );
  }

  return { model, apiKey };
}
