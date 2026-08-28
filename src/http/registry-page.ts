/**
 * Registry status page — live view of discovered providers/regions/models.
 * Rendered with the shared Tailwind/Alpine shell. Read-only over the live
 * catalog; contains no hardcoded model data.
 */
import type { ProxyConfig } from "../config.ts";
import { formatCanonicalId } from "../model/canonical-id.ts";
import type { Catalog, DiscoveredModel } from "../model/catalog.ts";
import { jsonForScript, renderShell } from "./shell.ts";

export interface RegistrySnapshot {
  providers: string[];
  primaryRegion: string;
  profilePreference: string;
  regions: { key: string; awsRegion: string }[];
  counts: {
    total: number;
    byBackend: Record<string, number>;
    byRegion: Record<string, number>;
    anthropic: number;
    nonAnthropic: number;
  };
  models: {
    canonicalId: string;
    provider: string;
    backend: string;
    regionKey: string;
    awsRegion: string;
    nativeModelId: string;
    isAnthropic: boolean;
    profiles: string[];
    streaming: boolean;
  }[];
}

function canonicalFor(m: DiscoveredModel): string {
  return formatCanonicalId({
    provider: m.provider,
    backend: m.backend,
    profilePrefix: m.regionKey,
    nativeModelId: m.nativeModelId,
  });
}

export function buildRegistrySnapshot(config: ProxyConfig, catalog: Catalog): RegistrySnapshot {
  const byBackend: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  let anthropic = 0;
  for (const m of catalog.models) {
    byBackend[m.backend] = (byBackend[m.backend] ?? 0) + 1;
    byRegion[m.regionKey] = (byRegion[m.regionKey] ?? 0) + 1;
    if (m.isAnthropic) anthropic++;
  }
  const models = catalog.models
    .map((m) => ({
      canonicalId: canonicalFor(m),
      provider: m.provider,
      backend: m.backend,
      regionKey: m.regionKey,
      awsRegion: m.awsRegion,
      nativeModelId: m.nativeModelId,
      isAnthropic: m.isAnthropic,
      profiles: [...m.profiles],
      streaming: m.streaming,
    }))
    .sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  return {
    providers: [...new Set(catalog.models.map((m) => m.provider))].sort(),
    primaryRegion: config.primaryRegion,
    profilePreference: config.profilePreference,
    regions: config.regions.map((r) => ({ key: r.key, awsRegion: r.awsRegion })),
    counts: {
      total: catalog.models.length,
      byBackend,
      byRegion,
      anthropic,
      nonAnthropic: catalog.models.length - anthropic,
    },
    models,
  };
}

function card(binding: string, label: string): string {
  return `<div class="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-3 bg-white dark:bg-slate-800">
    <div class="text-2xl font-semibold" x-text="${binding}"></div>
    <div class="text-xs uppercase tracking-wide text-slate-500">${label}</div>
  </div>`;
}

export function renderRegistryHtml(snapshot: RegistrySnapshot, chatEnabled: boolean): string {
  const body = `
  <div class="flex items-center justify-between mb-4">
    <div class="text-sm text-slate-500">
      provider <b class="text-slate-700 dark:text-slate-200" x-text="snap.providers.join(', ')"></b> ·
      primary region <b class="text-slate-700 dark:text-slate-200" x-text="snap.primaryRegion"></b> ·
      profile preference <b class="text-slate-700 dark:text-slate-200" x-text="snap.profilePreference"></b> ·
      regions <span x-text="snap.regions.map(r=>r.key+'→'+r.awsRegion).join(', ')"></span>
    </div>
    <div class="text-xs text-slate-400 flex items-center gap-2">
      <span x-show="loading" class="animate-pulse">refreshing…</span>
      <span x-show="!loading && updatedAt" x-text="'updated '+updatedAt"></span>
      <button @click="refresh()" class="px-2 py-1 rounded bg-slate-200 dark:bg-slate-700">↻</button>
    </div>
  </div>
  <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
    ${card("snap.counts.total", "models")}
    ${card("snap.counts.anthropic", "claude")}
    ${card("snap.counts.nonAnthropic", "non-claude")}
    ${card("backendCounts()", "by backend")}
    ${card("regionCounts()", "by region")}
  </div>
  <div class="flex flex-wrap gap-2 mb-3">
    <select x-model="providerFilter" class="px-2 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
      <option value="">all providers</option>
      <template x-for="p in snap.providers" :key="p"><option :value="p" x-text="p"></option></template>
    </select>
    <select x-model="backendFilter" class="px-2 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
      <option value="">all backends</option>
      <template x-for="b in backends()" :key="b"><option :value="b" x-text="b"></option></template>
    </select>
    <input type="text" x-model="filter" placeholder="search models…"
      class="grow min-w-48 px-3 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800" />
    <span class="self-center text-xs text-slate-400" x-text="filtered().length+' / '+snap.models.length"></span>
  </div>
  <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
    <table class="w-full text-sm">
      <thead class="bg-slate-100 dark:bg-slate-800 text-slate-500 text-xs uppercase tracking-wide">
        <tr>
          <th class="text-left px-3 py-2">Canonical ID</th>
          <th class="text-left px-3 py-2">Provider</th>
          <th class="text-left px-3 py-2">Backend</th>
          <th class="text-left px-3 py-2">Region</th>
          <th class="text-left px-3 py-2">Type</th>
          <th class="text-left px-3 py-2">Profiles</th>
          <th class="text-left px-3 py-2">Stream</th>
        </tr>
      </thead>
      <tbody>
        <template x-for="m in filtered()" :key="m.canonicalId">
          <tr class="border-t border-slate-100 dark:border-slate-700/60 hover:bg-slate-50 dark:hover:bg-slate-800/60">
            <td class="px-3 py-1.5 font-mono text-xs" x-text="m.canonicalId"></td>
            <td class="px-3 py-1.5" x-text="m.provider"></td>
            <td class="px-3 py-1.5" x-text="m.backend"></td>
            <td class="px-3 py-1.5"><span x-text="m.regionKey"></span> <span class="text-slate-400" x-text="m.awsRegion?'('+m.awsRegion+')':''"></span></td>
            <td class="px-3 py-1.5"><span x-show="m.isAnthropic" class="inline-block px-1.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 text-xs">claude</span></td>
            <td class="px-3 py-1.5 font-mono text-xs text-slate-400" x-text="m.profiles.join(', ')||'—'"></td>
            <td class="px-3 py-1.5" x-text="m.streaming?'✓':''"></td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>`;

  // The snapshot is seeded so the page has data before the first fetch, then
  // /status.json is polled + refetched on focus so config saves show up live.
  const script = `
  function registry(){return{
    filter:'', providerFilter:'', backendFilter:'', loading:false, updatedAt:'',
    snap:${jsonForScript(snapshot)},
    init(){
      this.refresh();
      setInterval(()=>this.refresh(),15000);
      document.addEventListener('visibilitychange',()=>{ if(!document.hidden) this.refresh(); });
    },
    async refresh(){
      this.loading=true;
      try{ const r=await fetch('/status.json',{cache:'no-store'}); if(r.ok){ this.snap=await r.json(); this.updatedAt=new Date().toLocaleTimeString(); } }
      catch(_){}
      this.loading=false;
    },
    backends(){return [...new Set(this.snap.models.map(m=>m.backend))].sort();},
    backendCounts(){const e=Object.entries(this.snap.counts.byBackend||{});return e.length?e.map(([k,v])=>k+':'+v).join(' · '):'—';},
    regionCounts(){const e=Object.entries(this.snap.counts.byRegion||{});return e.length?e.map(([k,v])=>k+':'+v).join(' · '):'—';},
    filtered(){
      const q=this.filter.toLowerCase();
      return this.snap.models.filter(m=>{
        if(this.providerFilter && m.provider!==this.providerFilter) return false;
        if(this.backendFilter && m.backend!==this.backendFilter) return false;
        if(q && !JSON.stringify(m).toLowerCase().includes(q)) return false;
        return true;
      });
    }
  };}`;

  return renderShell({
    title: "claude-code-llm-proxy — registry",
    active: "registry",
    chatEnabled,
    xData: "registry()",
    body,
    script,
  });
}
