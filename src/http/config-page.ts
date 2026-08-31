/**
 * Config management page — view and edit the proxy's own configuration, with
 * a provider/region status strip. Saving writes config.local.jsonc and hot-
 * reloads the running proxy (POST /api/config). Built on the shared shell.
 *
 * Access is gated by the inbound key (authenticateManagement on the server),
 * so an authenticated operator may view and edit the real credentials here.
 * Credentials are masked by default in the UI with a per-field reveal toggle,
 * so a screenshot / screen-share does not leak them; the short-lived minted
 * SigV4 token is never sent to the browser (metadata only).
 */
import { DEFAULT_BEDROCK_HOSTS } from "../config.ts";
import { jsonForScript, renderShell } from "./shell.ts";

export function renderConfigPageHtml(chatEnabled: boolean): string {
  const body = `
  <div class="max-w-3xl">
    <h1 class="text-xl font-semibold mb-1">Configuration</h1>
    <p class="text-sm text-slate-500 mb-4">Edits are saved to the config file and hot-reloaded (no restart). Local pod — no gating.</p>

    <!-- Provider / region status -->
    <div class="mb-6">
      <div class="text-xs uppercase tracking-wide text-slate-500 mb-2">Provider status <span class="text-slate-400 normal-case" x-text="status.totalModels?('· '+status.totalModels+' models total'):''"></span></div>
      <div class="flex flex-wrap gap-3">
        <template x-for="r in status.regions" :key="r.key">
          <div class="rounded-lg border px-4 py-2" :class="tone(regionState(r))">
            <div class="flex items-center gap-2">
              <span class="inline-block w-2 h-2 rounded-full" :class="dot(regionState(r))"></span>
              <span class="font-medium" x-text="'bedrock · '+r.key+' → '+r.awsRegion"></span>
            </div>
            <div class="text-xs text-slate-500" x-text="regionDetail(r)"></div>
          </div>
        </template>
        <template x-for="e in (status.external||[])" :key="e.key">
          <div class="rounded-lg border px-4 py-2" :class="tone(externalState(e))">
            <div class="flex items-center gap-2">
              <span class="inline-block w-2 h-2 rounded-full" :class="dot(externalState(e))"></span>
              <span class="font-medium" x-text="e.key+' · '+e.type"></span>
            </div>
            <div class="text-xs text-slate-500" x-text="externalDetail(e)"></div>
          </div>
        </template>
        <div x-show="status.regions.length===0" class="text-sm text-slate-400">loading…</div>
      </div>
    </div>

    <!-- Editable form (only rendered once cfg has loaded, so bindings never
         evaluate against a null cfg). -->
    <template x-if="cfg">
    <div class="space-y-4">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label class="block">
          <span class="text-xs uppercase tracking-wide text-slate-500">Primary region</span>
          <select x-model="cfg.primaryRegion" class="mt-1 w-full px-2 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
            <template x-for="r in cfg.regions" :key="r.key"><option :value="r.key" x-text="r.key"></option></template>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase tracking-wide text-slate-500">Profile preference</span>
          <select x-model="cfg.profilePreference" class="mt-1 w-full px-2 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
            <option value="global">global</option><option value="regional">regional</option><option value="auto">auto</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs uppercase tracking-wide text-slate-500">Refresh interval (minutes)</span>
          <input type="number" min="1" x-model.number="cfg.refreshIntervalMinutes" class="mt-1 w-full px-2 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm" />
        </label>
      </div>

      <div class="flex flex-wrap gap-6">
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" x-model="cfg.claudeFallbackToMantle" /> claudeFallbackToMantle</label>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" x-model="cfg.logging.enabled" /> logging.enabled</label>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" x-model="cfg.chatPage.enabled" /> chatPage.enabled</label>
      </div>

      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs uppercase tracking-wide text-slate-500">Regions</span>
          <button @click="cfg.regions.push({key:'us',awsRegion:'us-east-1'})" class="text-xs px-2 py-1 rounded bg-slate-200 dark:bg-slate-700">+ add</button>
        </div>
        <template x-for="(r,i) in cfg.regions" :key="i">
          <div class="flex gap-2 mb-2">
            <input x-model="r.key" placeholder="key (us/eu)" class="w-28 px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm" />
            <input x-model="r.awsRegion" placeholder="aws region" class="grow px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm" />
            <button @click="cfg.regions.splice(i,1)" class="px-2 py-1 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-600 text-sm">remove</button>
          </div>
        </template>
      </div>

      <!-- Bedrock credential + effective auth (real minted token, not "dev").
           The block is optional: absent means Bedrock is disabled. -->
      <template x-if="cfg.providers.bedrock">
      <div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs uppercase tracking-wide text-slate-500">Bedrock credential</span>
          <div class="flex items-center gap-2">
            <button @click="disableBedrock()" class="text-xs px-2 py-1 rounded bg-slate-200 dark:bg-slate-700">disable</button>
            <button @click="loadAuth()" class="text-xs px-2 py-1 rounded bg-slate-200 dark:bg-slate-700">↻ re-mint</button>
          </div>
        </div>
        <input :type="reveal.bedrock?'text':'password'" x-model="cfg.providers.bedrock.credential" spellcheck="false"
          class="w-full px-2 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-mono" />
        <label class="flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" x-model="reveal.bedrock" /> reveal</label>
        <span class="text-xs text-slate-400">Set a long-term Bedrock API key, or <code>dev</code> to mint short-lived SigV4 tokens from AWS env creds. Leave empty to disable Bedrock (external providers only).</span>
        <template x-if="auth.bedrock">
          <div class="text-xs space-y-1">
            <div><span class="text-slate-500">mode:</span> <b x-text="auth.bedrock.mode"></b>
              <template x-if="auth.bedrock.region"><span class="text-slate-500"> · region <span x-text="auth.bedrock.region"></span></span></template>
              <template x-if="auth.bedrock.expiresInSeconds"><span class="text-slate-500"> · expires in <span x-text="auth.bedrock.expiresInSeconds"></span>s</span></template>
            </div>
            <template x-if="auth.bedrock.mode==='disabled' && auth.bedrock.reason">
              <div class="text-amber-600 dark:text-amber-400" x-text="auth.bedrock.reason"></div>
            </template>
            <template x-if="auth.bedrock.awsPresent">
              <div class="text-slate-500">AWS env:
                <span x-text="'ACCESS_KEY_ID '+(auth.bedrock.awsPresent.AWS_ACCESS_KEY_ID?'✓':'✗')"></span>,
                <span x-text="'SECRET '+(auth.bedrock.awsPresent.AWS_SECRET_ACCESS_KEY?'✓':'✗')"></span>,
                <span x-text="'SESSION_TOKEN '+(auth.bedrock.awsPresent.AWS_SESSION_TOKEN?'✓':'✗')"></span>
              </div>
            </template>
            <template x-if="auth.bedrock.error">
              <div class="text-rose-600" x-text="'error: '+auth.bedrock.error"></div>
            </template>
            <template x-if="auth.bedrock.mode==='dev-sigv4' && auth.bedrock.tokenAvailable">
              <div class="text-emerald-600">✓ short-lived SigV4 token can be minted (not shown — regenerated per request)</div>
            </template>
          </div>
        </template>
      </div>
      </template>
      <div x-show="cfg && !cfg.providers.bedrock"
        class="rounded-lg border border-dashed border-slate-300 dark:border-slate-600 p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <b class="text-sm">Bedrock disabled</b>
          <div class="text-xs text-slate-500 mt-0.5">No providers.bedrock block configured — the proxy runs on external providers only.</div>
        </div>
        <button @click="enableBedrock()" class="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm">Enable Bedrock</button>
      </div>

      <!-- External (non-Bedrock) providers -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs uppercase tracking-wide text-slate-500">External providers</span>
          <button @click="addProvider()" class="text-xs px-2 py-1 rounded bg-slate-200 dark:bg-slate-700">+ add provider</button>
        </div>
        <template x-for="key in externalKeys()" :key="key">
          <div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3 mb-3 space-y-2">
            <div class="flex items-center justify-between">
              <b class="font-mono text-sm" x-text="key"></b>
              <button @click="removeProvider(key)" class="px-2 py-1 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-600 text-xs">remove</button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label class="block"><span class="text-xs text-slate-500">type</span>
                <select x-model="cfg.providers[key].type" class="mt-1 w-full px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
                  <option value="anthropic">anthropic (passthrough)</option><option value="openai">openai (mantle)</option>
                </select>
              </label>
              <label class="block"><span class="text-xs text-slate-500">auth</span>
                <select x-model="cfg.providers[key].auth" class="mt-1 w-full px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
                  <option value="x-api-key">x-api-key</option><option value="bearer">bearer</option>
                </select>
              </label>
            </div>
            <label class="block"><span class="text-xs text-slate-500">baseUrl</span>
              <input x-model="cfg.providers[key].baseUrl" class="mt-1 w-full px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-mono" />
            </label>
            <label class="block"><span class="text-xs text-slate-500">modelsUrl (runtime discovery endpoint)</span>
              <input x-model="cfg.providers[key].modelsUrl" class="mt-1 w-full px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-mono" />
            </label>
            <label class="block"><span class="text-xs text-slate-500">credential (API key)</span>
              <input :type="reveal[key]?'text':'password'" x-model="cfg.providers[key].credential" spellcheck="false" class="mt-1 w-full px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-mono" />
              <label class="flex items-center gap-2 text-xs text-slate-500 mt-1"><input type="checkbox" x-model="reveal[key]" /> reveal</label>
            </label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" x-model="cfg.providers[key].countTokens" /> countTokens (upstream supports Anthropic count_tokens)</label>
          </div>
        </template>
        <div x-show="externalKeys().length===0" class="text-sm text-slate-400">No external providers configured.</div>
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button @click="save()" :disabled="saving" class="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm disabled:opacity-50" x-text="saving?'Saving…':'Save & reload'"></button>
        <span class="text-sm" :class="msgOk?'text-emerald-600':'text-rose-600'" x-text="msg"></span>
      </div>
    </div>
    </template>
  </div>`;

  const script = `
  function configPage(){return{
    cfg:null, loaded:false, saving:false, msg:'', msgOk:true, status:{regions:[]}, auth:{}, reveal:{},
    async init(){ await this.loadStatus(); await this.loadCfg(); await this.loadAuth(); setInterval(()=>this.loadStatus(),15000); },
    async loadCfg(){ try{ this.cfg=await (await window.adminFetch('/api/config')).json(); this.loaded=true; }catch(e){ this.msg='load failed: '+e; this.msgOk=false; } },
    // External providers are every providers.* key except "bedrock" (the on-disk
    // flat shape). Expose helpers so the form edits them in place.
    externalKeys(){ return Object.keys(this.cfg.providers).filter(k=>k!=='bedrock'); },
    async loadStatus(){ try{ this.status=await (await window.adminFetch('/api/config/status')).json(); }catch(e){ console.error('config status load failed',e); } },
    async loadAuth(){ try{ this.auth=await (await window.adminFetch('/api/config/auth')).json(); }catch(e){ console.error('config auth load failed',e); } },
    // Status-strip tones: ok=green, skipped/disabled=amber (actionable: set the
    // key), error=rose (discovery failed — detail shown on the card).
    tone(s){ return s==='ok' ? 'border-emerald-400/60 bg-emerald-50 dark:bg-emerald-900/20'
      : (s==='skipped'||s==='disabled') ? 'border-amber-400/60 bg-amber-50 dark:bg-amber-900/20'
      : 'border-rose-400/60 bg-rose-50 dark:bg-rose-900/20'; },
    dot(s){ return s==='ok'?'bg-emerald-500':(s==='skipped'||s==='disabled')?'bg-amber-500':'bg-rose-500'; },
    regionState(r){ return r.disabled?'disabled':(r.active?'ok':'error'); },
    regionDetail(r){ return r.error ? r.awsRegion+' · '+r.error : r.total+' models (converse '+r.converse+' / mantle '+r.mantle+')'; },
    externalState(e){ return e.active?'ok':(e.state==='skipped'?'skipped':'error'); },
    externalDetail(e){ return (e.detail?e.detail+' · ':'')+e.total+' models · '+e.baseUrl; },
    enableBedrock(){ this.cfg.providers.bedrock={type:'bedrock',credential:'',hosts:${jsonForScript(DEFAULT_BEDROCK_HOSTS)}}; },
    disableBedrock(){ delete this.cfg.providers.bedrock; },
    addProvider(){
      const name=prompt('Provider id (e.g. deepseek, zai, gemini):'); if(!name)return;
      if(this.cfg.providers[name]){ this.msg='provider "'+name+'" already exists'; this.msgOk=false; return; }
      this.cfg.providers[name]={type:'anthropic',auth:'x-api-key',baseUrl:'',modelsUrl:'',credential:'',countTokens:false};
    },
    removeProvider(key){ delete this.cfg.providers[key]; },
    async save(){
      this.saving=true; this.msg='';
      try{
        const res=await window.adminFetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(this.cfg)});
        const j=await res.json();
        if(res.ok){ this.msg=j.message||'saved'; this.msgOk=true; await this.loadStatus(); await this.loadAuth(); }
        else { this.msg=(j.error&&j.error.message)||j.error||'save failed'; this.msgOk=false; }
      }catch(e){ this.msg='save failed: '+e; this.msgOk=false; }
      this.saving=false;
    }
  };}`;

  return renderShell({
    title: "claude-code-provider-proxy — config",
    active: "config",
    chatEnabled,
    xData: "configPage()",
    body,
    script,
  });
}
