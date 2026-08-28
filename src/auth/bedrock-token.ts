/**
 * Bedrock outbound credential resolution (DESIGN §8.2, §8.3).
 *
 * Production: the proxy uses a long-term Bedrock API key supplied via config
 * (region-agnostic bearer). This module simply passes it through.
 *
 * Development/testing: a short-lived Bedrock API key can be generated locally
 * from AWS credentials, replicating AWS's official `aws-bedrock-token-generator`
 * algorithm exactly:
 *
 *   1. SigV4-PRESIGN a request:
 *        service   = "bedrock"
 *        method    = POST
 *        host      = bedrock.amazonaws.com
 *        path      = "/"
 *        query     = { Action: "CallWithBearerToken", X-Amz-Expires: <=43200 }
 *   2. token = "bedrock-api-key-" + base64( presignedUrl without "https://" + "&Version=1" )
 *
 * The proxy MUST NOT require the ability to mint keys in production.
 */
import { AwsClient } from "aws4fetch";
import { ConfigError } from "../errors.ts";

const TOKEN_PREFIX = "bedrock-api-key-";
const TOKEN_VERSION = "&Version=1";
const MAX_EXPIRES_SECONDS = 43200; // 12 hours
const DEFAULT_EXPIRES_SECONDS = 3600; // 1 hour for dev tokens
const BEDROCK_SIGNING_HOST = "bedrock.amazonaws.com";
const BEDROCK_ACTION = "CallWithBearerToken";
const BEDROCK_SIGNING_SERVICE = "bedrock";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface GenerateTokenOptions {
  readonly credentials: AwsCredentials;
  readonly region: string;
  /** Requested lifetime in seconds; clamped to (0, 43200]. */
  readonly expiresInSeconds?: number;
}

/**
 * Generate a short-lived Bedrock API key (dev/testing only).
 * Replicates the official token-generator algorithm.
 */
export async function generateShortLivedBedrockToken(
  options: GenerateTokenOptions,
): Promise<string> {
  const { credentials, region } = options;
  const expiresIn = options.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_SECONDS) {
    throw new ConfigError(`expiresInSeconds must be in (0, ${MAX_EXPIRES_SECONDS}]`);
  }
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new ConfigError("AWS credentials require accessKeyId and secretAccessKey");
  }

  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    service: BEDROCK_SIGNING_SERVICE,
    region,
  });

  // Presign POST https://bedrock.amazonaws.com/?Action=CallWithBearerToken&X-Amz-Expires=<n>
  const url = new URL(`https://${BEDROCK_SIGNING_HOST}/`);
  url.searchParams.set("Action", BEDROCK_ACTION);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));

  const signed = await client.sign(url.toString(), {
    method: "POST",
    aws: { signQuery: true },
  });

  const presignedUrl = signed.url; // full https URL with SigV4 query params
  const withoutProtocol = presignedUrl.replace(/^https:\/\//, "");
  const payload = `${withoutProtocol}${TOKEN_VERSION}`;
  const encoded = Buffer.from(payload, "utf-8").toString("base64");
  return `${TOKEN_PREFIX}${encoded}`;
}

/**
 * Resolve the outbound Bedrock credential for production use.
 * Currently a passthrough of the configured long-term key.
 */
export function resolveBedrockCredential(configuredCredential: string): string {
  if (!configuredCredential || configuredCredential.length === 0) {
    throw new ConfigError("No Bedrock credential configured");
  }
  return configuredCredential;
}
