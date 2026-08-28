/**
 * Built-in chat test page (opt-in via config.chatPage.enabled).
 *
 * A thin client of the server-side POST /api/chat endpoint: the browser never
 * holds any credential. Model picker is populated from /v1/models; supports a
 * system prompt, multi-turn conversation, and streaming responses rendered as
 * markdown with token usage.
 */
import { renderShell } from "./shell.ts";

export function renderChatPageHtml(): string {
  const body = `
  <div class="flex gap-4 h-[calc(100vh-6rem)]">
    <div class="w-[28rem] shrink-0 flex flex-col gap-3">
      <div>
        <label class="text-xs uppercase tracking-wide text-slate-500">Model</label>
        <select x-model="providerFilter" @change="ensureModel()" class="w-full mt-1 px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
          <option value="">all providers</option>
          <template x-for="p in providers()" :key="p"><option :value="p" x-text="p"></option></template>
        </select>
        <input type="text" x-model="modelSearch" @input="ensureModel()" placeholder="search e.g. deepseek, sonnet…"
          class="w-full mt-2 px-2 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm" />
        <select x-model="model" size="8" class="w-full mt-2 px-1 py-1 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs font-mono">
          <template x-for="m in filteredModels()" :key="m"><option :value="m" x-text="m"></option></template>
        </select>
        <div class="text-xs text-slate-400 mt-1" x-text="filteredModels().length+' / '+models.length+' models · selected: '+(model||'none')"></div>
      </div>
      <div class="grow flex flex-col">
        <label class="text-xs uppercase tracking-wide text-slate-500">System prompt</label>
        <textarea x-model="system" class="mt-1 grow px-2 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm resize-none"></textarea>
      </div>
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" x-model="stream" /> stream</label>
      <button @click="reset()" class="px-3 py-1.5 rounded-md bg-slate-200 dark:bg-slate-700 text-sm hover:bg-slate-300">New conversation</button>
      <div class="text-xs text-slate-500" x-text="usageLine"></div>
    </div>
    <div class="grow flex flex-col rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
      <div class="grow overflow-y-auto p-4 space-y-4" id="thread">
        <template x-for="(m,i) in messages" :key="i">
          <div>
            <div class="text-xs uppercase tracking-wide" :class="m.role==='user'?'text-emerald-600':'text-indigo-600'" x-text="m.role"></div>
            <div class="md" x-html="window.mdRender(m.text)"></div>
          </div>
        </template>
        <div x-show="pending" class="text-slate-400 text-sm">…</div>
      </div>
      <div class="border-t border-slate-200 dark:border-slate-700 p-3 flex gap-2">
        <textarea x-model="input" @keydown.enter.prevent="send()" rows="1" placeholder="Message…"
          class="grow px-3 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm resize-none"></textarea>
        <button @click="send()" :disabled="pending||!input.trim()" class="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm disabled:opacity-50">Send</button>
      </div>
    </div>
  </div>`;

  const script = `
  function chat(){return{
    models:[], model:'', providerFilter:'', modelSearch:'',
    system:'You are a helpful assistant.', stream:true,
    input:'', messages:[], pending:false, usageLine:'',
    async init(){
      try{const {data}=await (await fetch('/v1/models')).json();
        this.models=data.map(m=>m.id).sort();
        this.ensureModel();
      }catch(e){this.usageLine='failed to load models: '+e;}
    },
    providers(){return [...new Set(this.models.map(m=>m.split('.')[0]))].sort();},
    filteredModels(){
      const q=this.modelSearch.toLowerCase();
      return this.models.filter(m=>{
        if(this.providerFilter && m.split('.')[0]!==this.providerFilter) return false;
        if(q && !m.toLowerCase().includes(q)) return false;
        return true;
      });
    },
    // Keep a valid selection: if the current model is filtered out, pick the first match.
    ensureModel(){
      const list=this.filteredModels();
      if(!list.includes(this.model)) this.model=list.length?list[0]:'';
    },
    reset(){this.messages=[];this.usageLine='';},
    async send(){
      const text=this.input.trim(); if(!text||this.pending)return;
      this.input=''; this.messages.push({role:'user',text});
      // Reactive index for the assistant message — mutate via this.messages[idx]
      // so Alpine tracks updates (a captured local object ref would not react).
      const idx=this.messages.push({role:'assistant',text:''})-1;
      this.pending=true;
      // Build Anthropic messages array from the thread (drop the empty placeholder).
      const apiMessages=this.messages.slice(0,idx).map(m=>({role:m.role,content:m.text}));
      try{
        const res=await window.adminFetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({model:this.model,system:this.system,messages:apiMessages,stream:this.stream})});
        if(!res.ok){this.messages[idx].text='**error '+res.status+'**: '+(await res.text());this.pending=false;return;}
        if(this.stream&&res.headers.get('content-type')?.includes('event-stream')){
          await this.readStream(res,idx);
        }else{
          const j=await res.json();
          this.messages[idx].text=(j.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('')||'(no text in response)';
          if(j.usage)this.usageLine='in '+j.usage.input_tokens+' / out '+j.usage.output_tokens+' tok';
          this.scroll();
        }
      }catch(e){this.messages[idx].text='**error**: '+e;}
      this.pending=false;
    },
    async readStream(res,idx){
      const reader=res.body.getReader();const dec=new TextDecoder();let buf='';let inTok=0,outTok=0;
      for(;;){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
        let nl;while((nl=buf.indexOf('\\n'))>=0){const line=buf.slice(0,nl);buf=buf.slice(nl+1);
          if(!line.startsWith('data:'))continue;const p=line.slice(5).trim();if(!p)continue;
          try{const ev=JSON.parse(p);
            if(ev.type==='content_block_delta'&&ev.delta&&ev.delta.type==='text_delta'){this.messages[idx].text+=ev.delta.text;this.scroll();}
            else if(ev.type==='message_start'&&ev.message&&ev.message.usage){inTok=ev.message.usage.input_tokens||0;}
            else if(ev.type==='message_delta'&&ev.usage){if(ev.usage.output_tokens!=null)outTok=ev.usage.output_tokens;if(ev.usage.input_tokens)inTok=ev.usage.input_tokens;}
          }catch(_){}
        }
      }
      if(!this.messages[idx].text)this.messages[idx].text='(no content received)';
      this.usageLine='in '+inTok+' / out '+outTok+' tok';
    },
    scroll(){this.$nextTick(()=>{const t=document.getElementById('thread');if(t)t.scrollTop=t.scrollHeight;});}
  };}`;

  return renderShell({
    title: "claude-code-llm-proxy — chat",
    active: "chat",
    chatEnabled: true,
    xData: "chat()",
    body,
    script,
  });
}
