# Alibaba Regional Routing Implementation

## Summary

Successfully implemented multi-regional routing for external providers, enabling Alibaba Token Plan (free dev tier) routing via Singapore while supporting PAYG routing via workspace-dedicated endpoints.

**Changes**: 4 files modified, 0 new files, all tests passing (488/0)

## Implementation Details

### 1. Config Schema Extension (`src/config.ts`)

**Added**: `ExternalProviderRegion` interface with fields:
- `hostTemplate?: string` - Host template with `{workspaceId}` and `{region}` placeholders
- `basePath?: string` - Path appended after templated host
- `workspaceId?: string` - Value substituted for `{workspaceId}`
- `region?: string` - Value substituted for `{region}`
- `credential?: string` - Region-specific credential (falls back to provider-level)
- `modelsUrl: string` - Discovery endpoint for this region
- `billingMode?: "token-plan" | "payg"` - Billing mode indicator

**Added**: `regions?: Record<string, ExternalProviderRegion>` field to `ExternalProviderConfig`

**Backward Compatible**: Existing single-endpoint providers work unchanged.

### 2. Type System Updates (`src/model/catalog.ts`)

**Changed**: `DiscoveredModel.regionKey` type from `RegionKey | "global"` to `string`
- Now accepts arbitrary region codes (e.g., "ap-southeast-1", "eu-central-1")
- Bedrock still uses "us", "eu", "global"
- Single-endpoint external providers still use "global"
- Multi-region providers use actual region codes

**Changed**: `catalogKey()` and `Catalog.get()` to accept `string` instead of `RegionKey | "global"`

### 3. Multi-Region Discovery (`src/model/catalog.ts`)

**Extended**: `discoverExternalCatalog()` to handle multi-region providers:
- Parallel discovery from all configured regional endpoints
- Each region gets its own `SourceStatus` (tracked independently for backoff)
- Models tagged with region code instead of "global"
- Graceful 404 handling (workspace hosts may not serve `/api/v1/models`)
- Per-region credential resolution with fallback

**Backward Compatible**: Single-endpoint providers unchanged.

### 4. Routing Logic (`src/router.ts`)

**Updated**: `routeExternal()` to support multi-region providers:
- Select region from `provider.regions[profilePrefix]`
- Build origin from region-specific host template
- Use region-specific credential with fallback to provider-level
- Error if region not configured

**Backward Compatible**: Single-endpoint providers continue using `externalProviderOrigin(provider)`.

## Usage Examples

### Single-Endpoint Provider (Existing, Unchanged)

```jsonc
{
  "alibaba": {
    "type": "anthropic",
    "credential": "${ALIBABA_API_KEY}",
    "baseUrl": "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    "modelsUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models"
  }
}
```

Usage: `alibaba.anthropic.global.qwen3-max`

### Multi-Region Provider (New)

```jsonc
{
  "alibaba": {
    "type": "anthropic",
    "auth": "x-api-key",
    "credential": "${ALIBABA_API_KEY_INTL}",
    "regions": {
      "ap-southeast-1": {
        "hostTemplate": "dashscope-intl.aliyuncs.com",
        "basePath": "/apps/anthropic",
        "modelsUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
        "billingMode": "token-plan"
      },
      "eu-central-1": {
        "hostTemplate": "{workspaceId}.eu-central-1.maas.aliyuncs.com",
        "workspaceId": "${ALIBABA_WORKSPACE_ID_EU}",
        "basePath": "/apps/anthropic",
        "credential": "${ALIBABA_API_KEY_EU}",
        "modelsUrl": "https://${ALIBABA_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/api/v1/models",
        "billingMode": "payg"
      }
    }
  }
}
```

Usage:
- **Singapore (Token Plan)**: `alibaba.anthropic.ap-southeast-1.qwen3-max`
- **EU Workspace (PAYG)**: `alibaba.anthropic.eu-central-1.qwen3-max`

## Regional Endpoints

Based on live verification:

| Region | Host | Type | Billing |
|--------|------|------|---------|
| ap-southeast-1 | dashscope-intl.aliyuncs.com | Shared international | Token Plan ✓ |
| eu-central-1 | ws-{id}.eu-central-1.maas.aliyuncs.com | Workspace-dedicated | PAYG only |
| us-east-1 | ws-{id}.us-east-1.maas.aliyuncs.com | Workspace-dedicated | PAYG only |
| ap-northeast-1 | ws-{id}.ap-northeast-1.maas.aliyuncs.com | Workspace-dedicated | PAYG only |

**Key Insight**: Singapore workspace host does NOT serve `/api/v1/models` (404); uses the shared international host `dashscope-intl.aliyuncs.com`.

## Benefits

1. **Cost Optimization**: Route dev traffic via Singapore to consume Token Plan (free tier)
2. **Flexibility**: Support multiple billing modes (Token Plan vs PAYG) in same config
3. **Credential Isolation**: Region-specific credentials never cross boundaries
4. **Backward Compatible**: Existing configs work unchanged
5. **Extensible**: Pattern applies to other multi-region providers

## Testing

All tests pass:
- **Unit**: 488 pass, 40 skip, 0 fail
- **Type**: `bun run typecheck` ✓
- **Lint**: `bun run lint` ✓
- **Format**: `bun run format` ✓

**No ENV parameter changes** - uses existing `${ENV_VAR}` interpolation mechanism.

## Files Modified

1. `src/config.ts` - Added `ExternalProviderRegion` interface and `regions` field
2. `src/model/catalog.ts` - Multi-region discovery + type updates
3. `src/router.ts` - Regional routing logic
4. `tests/*` - All existing tests continue to pass

## Migration Path

**No migration required** - fully backward compatible.

**Opt-in**: Add `regions` map to existing provider config to enable regional routing.
