/**
 * Providers serving-state page — discovery state plus the LIVE per-key 429
 * cooldown view: each pool key of each external provider shows ok, or benched
 * with its reinstatement time (local date) and a ticking dd:hh:mm countdown.
 *
 * Data comes from GET /api/providers/status (inbound-key gated); the countdown
 * ticks client-side against the server-reported clock (skew-corrected) and the
 * page re-polls so a reinstatement shows up without a manual refresh. All
 * values render via x-text — never innerHTML — so provider/model strings from
 * config cannot inject markup.
 */
import { renderShell } from "./shell.ts";

export function renderProvidersPageHtml(chatEnabled: boolean): string {
  const body = `
  <div class="max-w-3xl">
    <h1 class="text-xl font-semibold mb-1">Providers</h1>
    <p class="text-sm text-slate-500 mb-4">Discovery state and per-key 429 cooldowns. A benched key reinstates automatically at the shown time — no restart needed.</p>

    <!-- Bedrock summary -->
    <template x-if="data">
      <div class="mb-4 rounded-lg border px-4 py-2 flex items-center gap-2" :class="tone(data.bedrock.enabled?'ok':'disabled')">
        <span class="inline-block w-2 h-2 rounded-full" :class="dot(data.bedrock.enabled?'ok':'disabled')"></span>
        <span class="font-medium">bedrock</span>
        <span class="text-xs text-slate-500" x-text="data.bedrock.enabled?'enabled':('disabled · '+data.bedrock.reason)"></span>
      </div>
    </template>

    <!-- External providers -->
    <div class="space-y-3">
      <template x-for="p in (data?data.providers:[])" :key="p.key">
        <div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="inline-block w-2 h-2 rounded-full" :class="dot(p.state)"></span>
            <span class="font-medium" x-text="p.key"></span>
            <span class="text-xs text-slate-400" x-text="p.type"></span>
            <span class="text-xs text-slate-500" x-text="stateText(p)"></span>
          </div>
          <div class="text-xs text-slate-500 mt-0.5" x-show="p.detail||p.inactiveReason||p.baseUrl"
            x-text="[p.detail||p.inactiveReason,p.baseUrl].filter(Boolean).join(' · ')"></div>

          <!-- Flat credential pool -->
          <template x-if="p.keys">
            <div class="mt-2">
              <div class="grid grid-cols-[minmax(6rem,1fr)_auto_auto] gap-x-3 items-baseline text-xs text-slate-400 mb-1">
                <span>key</span><span>reinstates</span><span>in (dd:hh:mm)</span>
              </div>
              <template x-for="k in p.keys" :key="k.label">
                <div class="grid grid-cols-[minmax(6rem,1fr)_auto_auto] gap-x-3 items-baseline text-sm py-0.5 border-t border-slate-100 dark:border-slate-800">
                  <span class="min-w-0">
                    <span class="flex items-center gap-2 min-w-0">
                      <span class="inline-block w-2 h-2 rounded-full shrink-0" :class="k.status==='cooldown'?'bg-amber-500':'bg-emerald-500'"></span>
                      <span class="font-mono truncate" x-text="keyName(k)"></span>
                    </span>
                    <span class="block text-[11px] leading-tight text-slate-400 dark:text-slate-500 truncate" x-show="k.last429At" x-text="quotaLine(k)"></span>
                  </span>
                  <span class="text-xs text-slate-500 whitespace-nowrap tabular-nums" x-text="k.status==='cooldown'?localTime(k.cooldownUntilMs):'—'"></span>
                  <span class="font-mono whitespace-nowrap tabular-nums"
                    :class="k.status==='cooldown'?'text-amber-600 dark:text-amber-400':'text-slate-400'"
                    x-text="k.status==='cooldown'?countdown(k.cooldownUntilMs):'ready'"></span>
                </div>
              </template>
            </div>
          </template>

          <!-- Multi-region pools -->
          <template x-if="p.regions">
            <div class="mt-2 space-y-2">
              <template x-for="r in p.regions" :key="r.region">
                <div>
                  <div class="flex items-center gap-2 text-xs text-slate-500">
                    <span class="inline-block w-1.5 h-1.5 rounded-full" :class="dot(r.state)"></span>
                    <span x-text="r.region"></span>
                    <span x-show="r.inactiveReason" x-text="r.inactiveReason"></span>
                  </div>
                  <template x-for="k in r.keys" :key="k.label">
                    <div class="grid grid-cols-[minmax(6rem,1fr)_auto_auto] gap-x-3 items-baseline text-sm py-0.5 border-t border-slate-100 dark:border-slate-800">
                      <span class="min-w-0">
                        <span class="flex items-center gap-2 min-w-0">
                          <span class="inline-block w-2 h-2 rounded-full shrink-0" :class="k.status==='cooldown'?'bg-amber-500':'bg-emerald-500'"></span>
                          <span class="font-mono truncate" x-text="keyName(k)"></span>
                        </span>
                        <span class="block text-[11px] leading-tight text-slate-400 dark:text-slate-500 truncate" x-show="k.last429At" x-text="quotaLine(k)"></span>
                      </span>
                      <span class="text-xs text-slate-500 whitespace-nowrap tabular-nums" x-text="k.status==='cooldown'?localTime(k.cooldownUntilMs):'—'"></span>
                      <span class="font-mono whitespace-nowrap tabular-nums"
                        :class="k.status==='cooldown'?'text-amber-600 dark:text-amber-400':'text-slate-400'"
                        x-text="k.status==='cooldown'?countdown(k.cooldownUntilMs):'ready'"></span>
                    </div>
                  </template>
                </div>
              </template>
            </div>
          </template>
        </div>
      </template>
      <div x-show="data && data.providers.length===0" class="text-sm text-slate-400">No external providers configured.</div>
      <div x-show="!data" class="text-sm text-slate-400">loading…</div>
    </div>
  </div>`;

  const script = `
  function providersPage(){return{
    data:null, now:Date.now(), skewMs:0,
    async init(){
      await this.load();
      setInterval(()=>this.load(),10000);
      setInterval(()=>{ this.now=Date.now(); },1000);
    },
    async load(){
      try{
        const before=Date.now();
        const j=await (await window.adminFetch('/api/providers/status')).json();
        // Snapshot the browser<->server clock difference at load so countdowns
        // stay true even when the client clock drifts.
        this.skewMs=j.serverNow-(before+Date.now())/2;
        this.data=j;
      }catch(e){ console.error('providers status load failed',e); }
    },
    // Status-strip tones: ok=green, skipped/disabled=amber, error=rose.
    tone(s){ return s==='ok' ? 'border-emerald-400/60 bg-emerald-50 dark:bg-emerald-900/20'
      : (s==='skipped'||s==='disabled') ? 'border-amber-400/60 bg-amber-50 dark:bg-amber-900/20'
      : 'border-rose-400/60 bg-rose-50 dark:bg-rose-900/20'; },
    dot(s){ return s==='ok'?'bg-emerald-500':(s==='skipped'||s==='disabled')?'bg-amber-500':'bg-rose-500'; },
    stateText(p){ return p.state+' · '+p.models+' model'+(p.models===1?'':'s'); },
    // "primary" or "primary · Chimera Developer 2" (optional display name).
    keyName(k){ return k.name?(k.label+' · '+k.name):k.label; },
    // Quota history sub-line — the REAL provider-side reset stamp, kept even
    // after the (clamped, 1h-max) cooldown expires: "last 429 … · quota resets …".
    quotaLine(k){ return 'last 429 '+this.localTime(k.last429At)+(k.quotaResetAt?(' · quota resets '+this.localTime(k.quotaResetAt)):''); },
    localTime(ms){ return new Date(ms).toLocaleString(); },
    remaining(ms){ return Math.max(0,ms-(this.now+this.skewMs)); },
    // dd:hh:mm — days : hours : minutes, ticking with the 1s clock.
    countdown(ms){
      const totalMin=Math.floor(this.remaining(ms)/60000);
      const d=Math.floor(totalMin/1440), h=Math.floor((totalMin%1440)/60), m=totalMin%60;
      const p=(n)=>String(n).padStart(2,'0');
      return p(d)+':'+p(h)+':'+p(m);
    }
  };}`;

  return renderShell({
    title: "claude-code-provider-proxy — providers",
    active: "providers",
    chatEnabled,
    xData: "providersPage()",
    body,
    script,
  });
}
