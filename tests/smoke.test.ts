/**
 * Module import smoke test.
 *
 * Imports every module under src/ so that (a) import-time errors surface as a
 * test failure, and (b) coverage no longer hides files that no other test
 * imports — the whole-project coverage number stops being flattered by the
 * subset of "loaded" files. This runs hermetically: server.ts and cli/index.ts
 * guard their entrypoints with `import.meta.main`, so importing them does NOT
 * start Bun.serve or run the CLI.
 *
 * Keep this list in sync with `src/**` (a missing module simply isn't covered;
 * a renamed one fails the typecheck via the static import).
 */
import { describe, expect, test } from "bun:test";

import * as auth_bedrockMode from "../src/auth/bedrock-mode.ts";
import * as auth_bedrockToken from "../src/auth/bedrock-token.ts";
import * as auth_inbound from "../src/auth/inbound.ts";
import * as auth_tokenProvider from "../src/auth/token-provider.ts";
import * as cli_bindIp from "../src/cli/bind-ip.ts";
import * as cli_bootstrap from "../src/cli/bootstrap.ts";
import * as cli_claude from "../src/cli/claude.ts";
import * as cli_deps from "../src/cli/deps.ts";
import * as cli_env from "../src/cli/env.ts";
import * as cli_index from "../src/cli/index.ts";
import * as cli_util from "../src/cli/util.ts";
import * as config from "../src/config.ts";
import * as errors from "../src/errors.ts";
import * as http_chatPage from "../src/http/chat-page.ts";
import * as http_configPage from "../src/http/config-page.ts";
import * as http_logViewerPage from "../src/http/log-viewer-page.ts";
import * as http_registryPage from "../src/http/registry-page.ts";
import * as http_shell from "../src/http/shell.ts";
import * as http_upstream from "../src/http/upstream.ts";
import * as http_zip from "../src/http/zip.ts";
import * as ir_types from "../src/ir/types.ts";
import * as logging_capture from "../src/logging/capture.ts";
import * as logging_logStore from "../src/logging/log-store.ts";
import * as logging_logger from "../src/logging/logger.ts";
import * as model_canonicalId from "../src/model/canonical-id.ts";
import * as model_catalog from "../src/model/catalog.ts";
import * as paths_converse from "../src/paths/converse.ts";
import * as paths_mantle from "../src/paths/mantle.ts";
import * as paths_passthrough from "../src/paths/passthrough.ts";
import * as paths_relay from "../src/paths/relay.ts";
import * as router from "../src/router.ts";
import * as server from "../src/server.ts";
import * as stream_anthropicSse from "../src/stream/anthropic-sse.ts";
import * as stream_converseEvents from "../src/stream/converse-events.ts";
import * as stream_openaiSse from "../src/stream/openai-sse.ts";

describe("module import smoke", () => {
  test("every src module imports without a side-effecting entrypoint", () => {
    const modules = {
      "auth/bedrock-mode": auth_bedrockMode,
      "auth/bedrock-token": auth_bedrockToken,
      "auth/inbound": auth_inbound,
      "auth/token-provider": auth_tokenProvider,
      "cli/bind-ip": cli_bindIp,
      "cli/bootstrap": cli_bootstrap,
      "cli/claude": cli_claude,
      "cli/deps": cli_deps,
      "cli/env": cli_env,
      "cli/index": cli_index,
      "cli/util": cli_util,
      config,
      errors,
      "http/chat-page": http_chatPage,
      "http/config-page": http_configPage,
      "http/log-viewer-page": http_logViewerPage,
      "http/registry-page": http_registryPage,
      "http/shell": http_shell,
      "http/upstream": http_upstream,
      "http/zip": http_zip,
      "ir/types": ir_types,
      "logging/capture": logging_capture,
      "logging/log-store": logging_logStore,
      "logging/logger": logging_logger,
      "model/canonical-id": model_canonicalId,
      "model/catalog": model_catalog,
      "paths/converse": paths_converse,
      "paths/mantle": paths_mantle,
      "paths/passthrough": paths_passthrough,
      "paths/relay": paths_relay,
      router,
      server,
      "stream/anthropic-sse": stream_anthropicSse,
      "stream/converse-events": stream_converseEvents,
      "stream/openai-sse": stream_openaiSse,
    };
    for (const [name, mod] of Object.entries(modules)) {
      expect(mod, `module ${name} should load to an object`).toBeDefined();
      expect(typeof mod, `module ${name}`).toBe("object");
    }
    // Sanity: the two guarded entrypoints still export their testable seams.
    expect(typeof server.createFetchHandler).toBe("function");
    expect(typeof server.buildRuntime).toBe("function");
  });
});
