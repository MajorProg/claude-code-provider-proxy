/**
 * Log viewer page — browse deduped system prompts and per-session turns, with
 * markdown-rendered detail, token badges, and ZIP download ("dump") buttons.
 * Built on the shared Tailwind/Alpine shell. Talks to /api/logs/*.
 */
import { renderShell } from "./shell.ts";

export function renderLogViewerHtml(chatEnabled: boolean): string {
  const body = `
  <div class="flex flex-wrap items-center gap-2 mb-3">
    <span class="text-sm text-slate-500 mr-2">Dump:</span>
    <button @click="download('/api/logs/export/sessions?range=all')" class="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm hover:bg-indigo-700">All sessions</button>
    <button @click="download('/api/logs/export/sessions?range=today')" class="px-3 py-1.5 rounded-md bg-slate-200 dark:bg-slate-700 text-sm hover:bg-slate-300">Today</button>
    <button @click="download('/api/logs/export/sessions?range=1h')" class="px-3 py-1.5 rounded-md bg-slate-200 dark:bg-slate-700 text-sm hover:bg-slate-300">Last 1h</button>
    <button @click="download('/api/logs/export/system')" class="px-3 py-1.5 rounded-md bg-slate-200 dark:bg-slate-700 text-sm hover:bg-slate-300">All system prompts</button>
  </div>
  <div class="flex gap-4 h-[calc(100vh-9rem)]">
    <div class="w-80 shrink-0 flex flex-col rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
      <div class="flex p-2 gap-1 border-b border-slate-200 dark:border-slate-700">
        <button @click="tab='sessions';load()" :class="tab==='sessions'?'bg-indigo-600 text-white':'bg-slate-100 dark:bg-slate-700'" class="flex-1 px-2 py-1.5 rounded text-sm">Sessions</button>
        <button @click="tab='system';load()" :class="tab==='system'?'bg-indigo-600 text-white':'bg-slate-100 dark:bg-slate-700'" class="flex-1 px-2 py-1.5 rounded text-sm">System Prompts</button>
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
    <div class="grow overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">
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
    async load(){
      this.loading=true;this.items=[];this.sel=null;this.detail='';
      try{
        if(this.tab==='system'){
          const {data}=await this.j('/api/logs/system');
          this.items=data.map(s=>({key:s.hash,title:s.preview||s.hash.slice(0,16),meta:'seen '+s.count+'× · '+s.lastSeen,kind:'system',hash:s.hash}));
        }else{
          const {data}=await this.j('/api/logs/sessions');
          this.items=data.map(s=>({key:s.id,title:s.id,meta:s.turnCount+' turns · in '+s.inputTokens+' / out '+s.outputTokens+' tok',kind:'session',id:s.id}));
        }
      }catch(e){console.error('logs: load failed',e);this.detail='<div class="text-red-500">error: '+window.esc(e)+'</div>';}
      this.loading=false;
    },
    async select(it){
      this.sel=it;this.detail='<div class="text-slate-400">loading…</div>';
      try{
        if(it.kind==='system'){
          const r=await this.j('/api/logs/system/'+it.hash);
          this.detail='<h2 class="text-lg font-semibold mb-1">System Prompt</h2><div class="text-xs text-slate-500 mb-3">seen '+window.esc(r.count)+'× · first '+window.esc(r.firstSeen)+' · last '+window.esc(r.lastSeen)+'</div><div class="md">'+window.mdRender(window.textOf(r.system))+'</div>';
        }else{
          const {data}=await this.j('/api/logs/sessions/'+encodeURIComponent(it.id));
          let h='<h2 class="text-lg font-semibold mb-3">Session '+window.esc(it.id)+'</h2>';
          for(const t of data){
            h+='<details class="mb-2 border border-slate-200 dark:border-slate-700 rounded-md"><summary class="cursor-pointer px-3 py-2 text-sm">'+window.esc(t.turn)+' — <b>'+window.esc(t.model)+'</b> · in '+window.esc(t.inputTokens)+' / out '+window.esc(t.outputTokens)+' tok · '+window.esc(t.stopReason||'')+'</summary><div class="px-3 pb-3" data-turn="'+window.esc(t.turn)+'"></div></details>';
          }
          this.detail=h;
          this.$nextTick(()=>this.wireTurns(it.id,data));
        }
      }catch(e){console.error('logs: select failed',e);this.detail='<div class="text-red-500">error: '+window.esc(e)+'</div>';}
    },
    wireTurns(id,data){
      document.querySelectorAll('details').forEach((d,i)=>{
        d.addEventListener('toggle',async()=>{
          if(!d.open)return;const box=d.querySelector('[data-turn]');
          if(box.dataset.loaded)return;box.dataset.loaded='1';box.innerHTML='<div class="text-slate-400 text-sm">loading…</div>';
          try{const turn=await this.j('/api/logs/sessions/'+encodeURIComponent(id)+'/'+encodeURIComponent(data[i].turn));box.innerHTML=this.renderTurn(turn);}
          catch(e){console.error('logs: turn load failed',e);box.dataset.loaded='';box.innerHTML='<div class="text-red-500">error: '+window.esc(e)+'</div>';}
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
    renderTurn(turn){
      let h='<div class="flex gap-2 text-xs mb-3">';
      h+='<span class="px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300">in '+window.esc(turn.usage.inputTokens)+' tok</span>';
      h+='<span class="px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300">out '+window.esc(turn.usage.outputTokens)+' tok</span>';
      h+='<span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700">'+(turn.streamed?'streamed':'non-stream')+'</span>';
      h+='<span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700">'+window.esc(turn.backend)+'/'+window.esc(turn.translationPath)+'</span></div>';
      const msgs=turn.messages||[];
      h+='<div class="font-semibold mt-2">Request</div>';
      if(Array.isArray(msgs))for(const m of msgs){h+='<div class="font-medium capitalize mt-2 text-slate-500">'+window.esc(m.role||'')+'</div>'+this.renderBlocks(m.content);}
      else h+='<pre><code>'+window.esc(JSON.stringify(msgs,null,2))+'</code></pre>';
      h+='<div class="font-semibold mt-4">Assistant output</div>'+this.renderBlocks(turn.responseContent);
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
