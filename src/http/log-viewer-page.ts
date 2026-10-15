/**
 * Log viewer page — browse the SQLite turn index: sessions and their turns, and
 * the prompt/instruction versions every turn ran under, with per-version
 * orchestration stats, markdown-rendered detail, token/state badges, and ZIP
 * download ("dump") buttons.
 *
 * Reads ONLY the index-backed /api/logs/* routes (no directory scanning):
 *   - /api/logs/sessions            -> sessions + token aggregates
 *   - /api/logs/sessions/<id>       -> that session's turns (index metadata)
 *   - /api/logs/sessions/<id>/<seq> -> one turn (index metadata + decompressed body)
 *   - /api/logs/system              -> prompt/instruction versions + per-version stats
 *   - /api/logs/system/<hash>       -> one version's full content + stats
 * Built on the shared Tailwind/Alpine shell (window.adminFetch/esc/mdRender/textOf).
 */
import { renderShell } from "./shell.ts";

export function renderLogViewerHtml(chatEnabled: boolean): string {
  const body = `
  <div class="flex flex-wrap items-center gap-2 mb-3">
    <span class="text-sm text-slate-500 mr-2">Dump:</span>
    <button @click="download('/api/logs/export/sessions?range=all')" class="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm hover:bg-indigo-700">All sessions</button>
    <button @click="download('/api/logs/export/sessions?range=today')" class="px-3 py-1.5 rounded-md bg-slate-200 dark:bg-slate-700 text-sm hover:bg-slate-300">Today</button>
    <button @click="download('/api/logs/export/sessions?range=1h')" class="px-3 py-1.5 rounded-md bg-slate-200 dark:bg-slate-700 text-sm hover:bg-slate-300">Last 1h</button>
    <button @click="download('/api/logs/export/system')" class="px-3 py-1.5 rounded-md bg-slate-200 dark:bg-slate-700 text-sm hover:bg-slate-300">All prompt versions</button>
  </div>
  <div class="flex gap-4 h-[calc(100vh-9rem)]">
    <div class="w-80 shrink-0 flex flex-col rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
      <div class="flex p-2 gap-1 border-b border-slate-200 dark:border-slate-700">
        <button @click="tab='sessions';load()" :class="tab==='sessions'?'bg-indigo-600 text-white':'bg-slate-100 dark:bg-slate-700'" class="flex-1 px-2 py-1.5 rounded text-sm">Sessions</button>
        <button @click="tab='prompts';load()" :class="tab==='prompts'?'bg-indigo-600 text-white':'bg-slate-100 dark:bg-slate-700'" class="flex-1 px-2 py-1.5 rounded text-sm">Prompt Versions</button>
      </div>
      <div class="overflow-y-auto p-1.5 grow">
        <template x-if="items.length===0"><div class="text-slate-400 text-sm p-2" x-text="loading?'loading…':'nothing captured'"></div></template>
        <template x-for="it in items" :key="it.key">
          <div @click="select(it)" :class="sel&&sel.key===it.key?'ring-1 ring-indigo-500 bg-indigo-50 dark:bg-indigo-900/30':''"
               class="p-2 rounded-md cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700/50">
            <div class="text-sm font-medium break-all" x-text="it.title"></div>
            <div class="text-xs text-slate-500" x-text="it.meta"></div>
          </div>
        </template>
      </div>
    </div>
    <div class="grow overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5" x-ref="pane">
      <div x-show="!sel" class="text-slate-400">Select an item on the left.</div>
      <div x-html="detail"></div>
    </div>
  </div>`;

  const script = `
  function logs(){return{
    tab:'sessions', items:[], sel:null, detail:'', loading:false,
    init(){this.load();},
    async j(u){const r=await window.adminFetch(u);if(!r.ok)throw new Error('GET '+u+' failed: '+r.status);return r.json();},
    // ZIP exports are gated (they contain captured content), so they can't be
    // plain <a> downloads — fetch with the admin key, then save the blob.
    async download(u){
      try{
        const r=await window.adminFetch(u);
        if(!r.ok)throw new Error('GET '+u+' failed: '+r.status);
        const blob=await r.blob();
        const cd=r.headers.get('content-disposition')||'';
        const m=/filename="([^"]+)"/.exec(cd);
        const name=m?m[1]:'export.zip';
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();
        a.remove();URL.revokeObjectURL(a.href);
      }catch(e){console.error('logs: export failed',u,e);alert('export failed: '+e);}
    },
    fmtBytes(n){n=Number(n||0);if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB';},
    jsonOf(s){try{return s?JSON.parse(s):null;}catch(e){return null;}},
    badge(text,cls){return '<span class="px-2 py-0.5 rounded '+(cls||'bg-slate-100 dark:bg-slate-700')+'">'+window.esc(text)+'</span>';},
    // body_state is surfaced as a typed badge so a shed/pruned/truncated payload
    // is visible at a glance rather than silently missing.
    stateBadge(st){
      if(!st||st==='full')return '';
      const cls=st==='pruned'?'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200':st==='shed'?'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200':'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200';
      return ' '+this.badge('body '+st,cls);
    },
    errBadge(ec){return ec?' '+this.badge('error: '+ec,'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200'):'';},
    async load(){
      this.loading=true;this.items=[];this.sel=null;this.detail='';
      try{
        if(this.tab==='prompts'){
          const {data}=await this.j('/api/logs/system');
          this.items=data.map(v=>({key:v.hash,title:v.hash.slice(0,16),meta:(v.stats?v.stats.turns:0)+' turns · '+v.seenCount+'x seen · '+this.fmtBytes((v.systemBytes||0)+(v.toolsBytes||0)),kind:'prompt',hash:v.hash}));
        }else{
          const {data}=await this.j('/api/logs/sessions');
          this.items=data.map(s=>({key:s.id,title:s.id,meta:s.turnCount+' turns · in '+s.inputTokens+' / out '+s.outputTokens+' tok',kind:'session',id:s.id}));
        }
      }catch(e){console.error('logs: load failed',e);this.items=[];this.detail='<div class="text-red-500">error: '+window.esc(e)+'</div>';}
      this.loading=false;
    },
    async select(it){
      this.sel=it;this.detail='<div class="text-slate-400">loading…</div>';
      try{
        if(it.kind==='prompt'){
          const rec=await this.j('/api/logs/system/'+encodeURIComponent(it.hash));
          this.detail=this.renderPrompt(rec);
        }else{
          const {data}=await this.j('/api/logs/sessions/'+encodeURIComponent(it.id));
          let h='<h2 class="text-lg font-semibold mb-3">Session '+window.esc(it.id)+'</h2>';
          for(const t of data){h+=this.turnSummary(t);}
          this.detail=h;
          this.$nextTick(()=>this.wireTurns(it.id));
        }
      }catch(e){console.error('logs: select failed',e);this.detail='<div class="text-red-500">error: '+window.esc(e)+'</div>';}
    },
    turnSummary(t){
      let s='<details class="mb-2 border border-slate-200 dark:border-slate-700 rounded-md" data-turn="'+window.esc(t.seq)+'">';
      s+='<summary class="cursor-pointer px-3 py-2 text-sm">';
      s+='<b>#'+window.esc(t.seq)+'</b> '+window.esc(t.modelServed||t.modelRequested||'-');
      s+=' · in '+(t.inputTokens==null?'-':window.esc(t.inputTokens))+' / out '+(t.outputTokens==null?'-':window.esc(t.outputTokens))+' tok';
      s+=' · '+window.esc(t.stopReason||'-');
      if(t.promptVersion)s+=' · prompt <span class="text-slate-400">'+window.esc(t.promptVersion.slice(0,12))+'</span>';
      s+=this.stateBadge(t.bodyState);
      s+=this.errBadge(t.errorClass);
      if(t.failover)s+=' '+this.badge('failover');
      s+='</summary><div class="px-3 pb-3" data-turn-body></div></details>';
      return s;
    },
    wireTurns(id){
      const pane=this.$refs.pane;if(!pane)return;
      pane.querySelectorAll('details[data-turn]').forEach(d=>{
        d.addEventListener('toggle',async()=>{
          if(!d.open)return;const box=d.querySelector('[data-turn-body]');
          if(box.dataset.loaded)return;box.dataset.loaded='1';box.innerHTML='<div class="text-slate-400 text-sm">loading…</div>';
          try{
            const seq=d.getAttribute('data-turn');
            const r=await this.j('/api/logs/sessions/'+encodeURIComponent(id)+'/'+encodeURIComponent(seq));
            box.innerHTML=this.renderTurn(r.meta,r.body);
          }catch(e){console.error('logs: turn load failed',e);box.dataset.loaded='';box.innerHTML='<div class="text-red-500">error: '+window.esc(e)+'</div>';}
        });
      });
    },
    renderBlocks(content){
      if(!Array.isArray(content))return '<div class="md">'+window.mdRender(window.textOf(content))+'</div>';
      let h='';
      for(const b of content){
        if(b&&b.type==='text')h+='<div class="my-2"><div class="text-xs uppercase text-slate-400">text</div><div class="md">'+window.mdRender(b.text||'')+'</div></div>';
        else if(b&&b.type==='tool_use')h+='<div class="my-2"><div class="text-xs uppercase text-slate-400">tool_use · '+window.esc(b.name||'')+'</div><pre><code>'+window.esc(JSON.stringify(b.input,null,2))+'</code></pre></div>';
        else if(b&&b.type==='tool_result')h+='<div class="my-2"><div class="text-xs uppercase text-slate-400">tool_result</div><pre><code>'+window.esc(typeof b.content==='string'?b.content:JSON.stringify(b.content,null,2))+'</code></pre></div>';
        else h+='<pre><code>'+window.esc(JSON.stringify(b,null,2))+'</code></pre>';
      }
      return h;
    },
    // One turn: index metadata (meta) + the decompressed body (null when
    // shed/pruned). A missing body is explained by its typed state, never blank.
    renderTurn(meta,body){
      const m=meta||{};
      let h='<div class="flex flex-wrap gap-2 text-xs mb-3">';
      if(body){
        h+=this.badge('in '+(body.usage?body.usage.inputTokens:'?')+' tok');
        h+=this.badge('out '+(body.usage?body.usage.outputTokens:'?')+' tok');
        h+=this.badge(body.streamed?'streamed':'non-stream');
        h+=this.badge((body.backend||'')+'/'+(body.translationPath||''));
      }
      if(m.modelServed)h+=this.badge('served '+m.modelServed);
      if(m.latencyMs!=null)h+=this.badge(m.latencyMs+' ms');
      if(m.cacheReadTokens)h+=this.badge('cache read '+m.cacheReadTokens);
      if(m.promptVersion)h+=this.badge('prompt '+m.promptVersion.slice(0,12));
      if(m.toolCalls&&m.toolCalls.length)h+=this.badge('tools: '+m.toolCalls.join(', '));
      if(m.failover)h+=this.badge('failover');
      h+=this.errBadge(m.errorClass);
      h+='</div>';
      if(!body){h+=this.bodyMissing(m);return h;}
      if(m.bodyState==='truncated')h+='<div class="mb-2 rounded-md bg-orange-50 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200 px-3 py-2 text-sm">Body truncated at the configured maxTurnBytes cap; the payload below is clipped.</div>';
      const msgs=body.messages||[];
      h+='<div class="font-semibold mt-2">Request</div>';
      if(body.messagesOmitted){
        // The inbound conversation exceeded the capture body budget, so it was
        // omitted whole rather than stored (metadata survives). Surface that
        // explicitly — an empty message list would read as "no messages sent".
        const o=body.messagesOmitted;
        h+='<div class="mb-2 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-3 py-2 text-sm">Request messages omitted: inbound body '+window.esc(o.inboundBytes)+' bytes exceeded the '+window.esc(o.limitBytes)+'-byte capture bound.</div>';
      }
      else if(Array.isArray(msgs))for(const msg of msgs){h+='<div class="font-medium capitalize mt-2 text-slate-500">'+window.esc(msg.role||'')+'</div>'+this.renderBlocks(msg.content);}
      else h+='<pre><code>'+window.esc(JSON.stringify(msgs,null,2))+'</code></pre>';
      h+='<div class="font-semibold mt-4">Assistant output</div>'+this.renderBlocks(body.responseContent);
      return h;
    },
    bodyMissing(m){
      const st=m&&m.bodyState;
      const head='<div class="rounded-md px-3 py-2 text-sm ';
      if(st==='pruned')return head+'bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200">The body for this turn was PRUNED by retention (older than the configured retentionDays). The index row and every metadata field above survive; only the payload file was deleted.</div>';
      if(st==='shed')return head+'bg-rose-50 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200">The body for this turn was SHED under capture pressure (in-flight byte budget) and was never written. Metadata was still recorded, so the turn is fully visible here.</div>';
      return head+'bg-slate-100 dark:bg-slate-700">No body payload is stored for this turn.</div>';
    },
    // One prompt/instruction version: full content + per-version orchestration stats.
    renderPrompt(rec){
      const st=rec.stats||{};
      const sys=this.jsonOf(rec.systemJson);
      let h='<h2 class="text-lg font-semibold mb-1 break-all">Prompt / instruction version</h2>';
      h+='<div class="text-xs text-slate-500 mb-3 break-all">'+window.esc(rec.hash)+'<br>created '+window.esc(rec.createdAt||'-')+' · last seen '+window.esc(rec.lastSeen||'-')+' · seen '+window.esc(rec.seenCount)+'x · system '+this.fmtBytes(rec.systemBytes)+' · tools '+this.fmtBytes(rec.toolsBytes)+'</div>';
      h+=this.statTiles(st);
      h+='<div class="font-semibold mt-4">System prompt</div><div class="md">'+(sys==null?'<span class="text-slate-400">(no system prompt captured)</span>':window.mdRender(window.textOf(sys)))+'</div>';
      h+=this.toolsBlock(this.jsonOf(rec.toolsJson));
      h+=this.injectedBlock(this.jsonOf(rec.injectedJson));
      return h;
    },
    statTiles(st){
      const tiles=[['turns',st.turns],['sessions',st.sessions],['input tok',st.inputTokens],['output tok',st.outputTokens],['cache read',st.cacheReadTokens],['latency avg',(st.latency?st.latency.avgMs:0)+' ms'],['latency max',(st.latency?st.latency.maxMs:0)+' ms']];
      let h='<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 my-2">';
      for(const t of tiles){h+='<div class="rounded-md border border-slate-200 dark:border-slate-700 p-2"><div class="text-xs text-slate-500">'+window.esc(t[0])+'</div><div class="font-semibold">'+window.esc(t[1]==null?'-':t[1])+'</div></div>';}
      h+='</div>';
      if(st.modelsServed&&st.modelsServed.length)h+='<div class="text-sm mb-1"><span class="text-slate-500">models served:</span> '+st.modelsServed.map(m=>window.esc(m)).join(', ')+'</div>';
      h+=this.histogram('stop reasons',st.stopReasons);
      h+=this.histogram('failures',st.failures);
      h+=this.toolShape(st.toolCallShape);
      return h;
    },
    histogram(label,obj){
      if(!obj)return '';
      const keys=Object.keys(obj);
      if(keys.length===0)return '';
      return '<div class="text-sm mt-1"><span class="text-slate-500">'+window.esc(label)+':</span> '+keys.map(k=>window.esc(k)+' x '+window.esc(obj[k])).join(' · ')+'</div>';
    },
    toolShape(shape){
      if(!shape||shape.length===0)return '';
      return '<div class="text-sm mt-1"><span class="text-slate-500">tool-call shape:</span> '+shape.map(s=>window.esc(s.tool)+' x '+window.esc(s.count)).join(' · ')+'</div>';
    },
    toolsBlock(tools){
      if(!Array.isArray(tools)||tools.length===0)return '';
      let h='<div class="font-semibold mt-4">Tools ('+tools.length+')</div>';
      for(const t of tools){
        h+='<details class="mb-1 border border-slate-200 dark:border-slate-700 rounded-md"><summary class="cursor-pointer px-3 py-2 text-sm"><code>'+window.esc(t&&t.name?t.name:'(unnamed)')+'</code></summary><div class="px-3 pb-3">';
        if(t&&t.description)h+='<div class="md text-sm">'+window.mdRender(String(t.description))+'</div>';
        h+='<pre><code>'+window.esc(JSON.stringify(t&&t.input_schema?t.input_schema:t,null,2))+'</code></pre></div></details>';
      }
      return h;
    },
    injectedBlock(injected){
      if(injected==null)return '';
      if(Array.isArray(injected)&&injected.length===0)return '';
      let h='<div class="font-semibold mt-4">Injected instruction blocks</div>';
      if(Array.isArray(injected))for(const b of injected)h+=this.renderBlocks(b&&b.content!==undefined?b.content:b);
      else h+='<div class="md">'+window.mdRender(window.textOf(injected))+'</div>';
      return h;
    }
  };}`;

  return renderShell({
    title: "claude-code-provider-proxy — logs",
    active: "logs",
    chatEnabled,
    xData: "logs()",
    body,
    script,
  });
}
