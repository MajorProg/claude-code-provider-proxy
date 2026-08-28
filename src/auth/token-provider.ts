import { ConfigError } from "../errors.ts";
/**
 * Resolve the outbound Bedrock region-token provider (DESIGN §8.2, §8.3).
 *
 * Production: a long-term Bedrock API key from config — region-agnostic, so the
 * same token is returned for every region.
 *
 * Development: if the configured credential is the literal sentinel "dev" (or
 * empty) AND AWS credentials are present in the environment, mint a short-lived
 * region-scoped token per region. This lets the proxy run locally against live
 * Bedrock without a long-term key.
 */
import type { RegionTokenProvider } from "../model/catalog.ts";
import {
  type AwsCredentials,
  generateShortLivedBedrockToken,
  resolveBedrockCredential,
} from "./bedrock-token.ts";

const DEV_SENTINELS = new Set(["", "dev", "DEV"]);

/** Dev-token lifetime and the refresh skew (re-mint this early before expiry). */
const DEV_TOKEN_TTL_SECONDS = 3600;
const DEV_TOKEN_SKEW_MS = 5 * 60 * 1000; // re-mint 5 min before expiry

export function createBedrockTokenProvider(
  configuredCredential: string,
  env: Record<string, string | undefined> = Bun.env,
): RegionTokenProvider {
  const useDev = DEV_SENTINELS.has(configuredCredential);

  if (!useDev) {
    const key = resolveBedrockCredential(configuredCredential);
    // Long-term key is region-agnostic: same token for all regions.
    return () => key;
  }

  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new ConfigError(
      "Dev mode requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, " +
        "or set a real long-term Bedrock API key in config",
    );
  }
  const credentials: AwsCredentials = {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };

  // Cache minted tokens per region: short-lived Bedrock tokens are valid for
  // DEV_TOKEN_TTL_SECONDS but region-scoped, so re-signing (SigV4) on every
  // discovery call and every /api/config/auth hit is wasteful. Key by region;
  // de-dup concurrent mints for the same region via the stored in-flight
  // promise. Refresh a skew before expiry so a token never expires mid-request.
  interface CacheEntry {
    token: Promise<string>;
    /** Epoch ms after which this entry must be re-minted (undefined = still in flight). */
    expiresAt: number | undefined;
  }
  const cache = new Map<string, CacheEntry>();

  return (awsRegion: string): Promise<string> => {
    const now = Date.now();
    const cached = cache.get(awsRegion);
    // Reuse an in-flight mint, or a resolved token that is still fresh.
    if (cached && (cached.expiresAt === undefined || cached.expiresAt > now)) {
      return cached.token;
    }
    const entry: CacheEntry = { expiresAt: undefined, token: Promise.resolve("") };
    entry.token = generateShortLivedBedrockToken({
      credentials,
      region: awsRegion,
      expiresInSeconds: DEV_TOKEN_TTL_SECONDS,
    })
      .then((token) => {
        entry.expiresAt = Date.now() + DEV_TOKEN_TTL_SECONDS * 1000 - DEV_TOKEN_SKEW_MS;
        return token;
      })
      .catch((err) => {
        // A failed mint must not be cached — drop the entry so the next call retries.
        cache.delete(awsRegion);
        throw err;
      });
    cache.set(awsRegion, entry);
    return entry.token;
  };
}
