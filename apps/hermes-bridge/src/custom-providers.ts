import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Reads `custom_providers` from a Hermes profile's config.yaml and fetches the
 * full model list from each provider's OpenAI-compatible `/models` endpoint.
 *
 * The Hermes `model.options` picker only shows the single configured model per
 * custom provider (e.g. "glm-5.2" for Routstr). But each endpoint serves a
 * full catalog at `/v1/models` — Routstr has 20, BitRouter has 17, etc. This
 * module probes those endpoints and returns the complete lists so the model
 * picker can show every available model, not just the configured default.
 *
 * Probing is best-effort: if an endpoint is offline or slow, it falls back to
 * the single configured model and the picker still works. No probe is allowed
 * to block the picker open for more than `PROBE_TIMEOUT_MS`.
 */

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CONCURRENCY = 4;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;

function readYaml(path: string): Rec {
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    return isRec(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type RawCustomProvider = {
  name?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
};

export type CustomProviderModels = {
  /** The provider name as configured (e.g. "Routstr (localhost:8008)"). */
  name: string;
  /** The base URL (e.g. "http://localhost:8008/v1"). */
  baseUrl: string;
  /** The configured default model (fallback if probing fails). */
  configuredModel: string;
  /** All models discovered at /v1/models, or just the configured model. */
  models: string[];
};

function readCustomProviders(hermesHome: string): RawCustomProvider[] {
  const config = readYaml(join(hermesHome, "config.yaml"));
  const raw = config.custom_providers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRec) as RawCustomProvider[];
}

/** Fetch /models from one endpoint with a short timeout. Never throws. */
async function probeModels(
  baseUrl: string,
  apiKey?: string,
): Promise<string[] | null> {
  if (!baseUrl) return null;
  // Normalize: ensure we hit /models (some base_urls end with /v1, some don't)
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const body = (await resp.json()) as unknown;
    if (!isRec(body) || !Array.isArray(body.data)) return null;
    return body.data
      .filter((m): m is Rec => isRec(m) && typeof m.id === "string")
      .map((m) => m.id as string);
  } catch {
    // timeout, connection refused, DNS — the endpoint is offline/unreachable
    return null;
  }
}

/** Probe a small batch of providers in parallel. */
async function probeBatch(
  providers: RawCustomProvider[],
): Promise<CustomProviderModels[]> {
  return Promise.all(
    providers.map(async (p): Promise<CustomProviderModels> => {
      const configuredModel =
        typeof p.model === "string" && p.model.trim() ? p.model.trim() : "";
      const baseUrl = p.base_url ?? "";
      const discovered = baseUrl ? await probeModels(baseUrl, p.api_key) : null;
      return {
        name: p.name ?? p.base_url ?? "custom",
        baseUrl: p.base_url ?? "",
        configuredModel,
        models:
          discovered && discovered.length > 0
            ? discovered
            : configuredModel
              ? [configuredModel]
              : [],
      };
    }),
  );
}

/**
 * Fetch the full model list from every custom provider in the profile's
 * config.yaml. Returns a map keyed by provider name for quick lookup.
 *
 * Probing runs in small concurrent batches so one slow endpoint doesn't
 * stall the whole picker. Endpoints that don't respond within
 * PROBE_TIMEOUT_MS fall back to their configured model only.
 */
export async function fetchCustomProviderModels(
  hermesHome: string,
): Promise<Map<string, CustomProviderModels>> {
  const providers = readCustomProviders(hermesHome);
  const result = new Map<string, CustomProviderModels>();
  if (providers.length === 0) return result;

  // Process in small batches to avoid opening too many connections at once.
  for (let i = 0; i < providers.length; i += PROBE_CONCURRENCY) {
    const batch = providers.slice(i, i + PROBE_CONCURRENCY);
    const resolved = await probeBatch(batch);
    for (const r of resolved) {
      if (r.models.length > 0) result.set(r.name, r);
    }
  }
  return result;
}
