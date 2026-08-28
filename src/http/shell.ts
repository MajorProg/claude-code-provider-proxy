/**
 * Shared HTML shell for the built-in web UI (registry, chat, logs).
 *
 * Uses Tailwind (Play CDN) + Alpine.js (CDN) for a clean look with no build
 * step. The proxy always needs outbound internet for the LLM providers, so a
 * CDN dependency for the UI adds no new constraint.
 *
 * No credentials are ever embedded in served HTML: the chat page calls the
 * server-side /api/chat endpoint, which holds the real provider credential.
 */

export interface ShellOptions {
  readonly title: string;
  readonly active: "registry" | "chat" | "logs" | "config";
  readonly chatEnabled: boolean;
  /** Alpine x-data expression for the page root. */
  readonly xData: string;
  /** Body HTML (inside the main container). */
  readonly body: string;
  /** Extra page-specific <script> (Alpine component defs etc.). */
  readonly script?: string;
}

/**
 * Escape a string for safe interpolation into HTML text/attribute context.
 * Covers the five significant characters; use for any server- or discovery-
 * derived value placed into markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value to JSON safe to embed inside an inline <script> block.
 * Escapes `<` (and U+2028/U+2029) so a value containing `</script>` or a line
 * separator cannot break out of the script context.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function navLink(href: string, label: string, key: string, active: string): string {
  const base =
    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors hover:bg-slate-200/60 dark:hover:bg-slate-700/60";
  const on = "bg-indigo-600 text-white hover:bg-indigo-600";
  return `<a href="${href}" class="${base} ${active === key ? on : ""}">${label}</a>`;
}

/** Render a full HTML page with the shared Tailwind/Alpine shell + top nav. */
export function renderShell(opts: ShellOptions): string {
  const chatTab = opts.chatEnabled ? navLink("/chat", "Chat", "chat", opts.active) : "";
  return `<!doctype html>
<html lang="en" class="h-full">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'media'};</script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>
<style>
  [x-cloak]{display:none!important;}
  .md h1{font-size:1.25rem;font-weight:700;margin:.75rem 0 .35rem;}
  .md h2{font-size:1.1rem;font-weight:700;margin:.65rem 0 .3rem;}
  .md h3{font-size:1rem;font-weight:600;margin:.55rem 0 .3rem;}
  .md p{margin:.4rem 0;} .md ul{list-style:disc;margin:.4rem 0 .4rem 1.25rem;}
  .md pre{background:rgba(120,120,140,.15);padding:.7rem;border-radius:.5rem;overflow-x:auto;margin:.5rem 0;}
  .md code{font-family:ui-monospace,Menlo,monospace;font-size:.88em;}
  .md pre code{white-space:pre;}
</style>
</head>
<body class="h-full bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-100" x-data="${opts.xData}" x-cloak>
  <header class="flex items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-slate-50/90 dark:bg-slate-900/90 backdrop-blur z-10">
    <span class="font-semibold text-indigo-600 dark:text-indigo-400 mr-2">claude-code-provider-proxy</span>
    <nav class="flex gap-1">
      ${navLink("/", "Registry", "registry", opts.active)}
      ${chatTab}
      ${navLink("/logs", "Logs", "logs", opts.active)}
      ${navLink("/config", "Config", "config", opts.active)}
    </nav>
  </header>
  <main class="p-4">${opts.body}</main>
  ${opts.script ? `<script>${opts.script}</script>` : ""}
  <script>
  // Shared tiny markdown renderer (safe subset), exposed as window.mdRender.
  window.mdRender=function(src){
    if(src==null)return'';src=String(src);
    const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const blocks=[];src=src.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g,(_,c)=>{blocks.push(c);return '\\u0000'+(blocks.length-1)+'\\u0000';});
    let h=esc(src);
    h=h.replace(/^###\\s+(.*)$/gm,'<h3>$1</h3>').replace(/^##\\s+(.*)$/gm,'<h2>$1</h2>').replace(/^#\\s+(.*)$/gm,'<h1>$1</h1>');
    h=h.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/(^|[^*])\\*([^*]+)\\*/g,'$1<i>$2</i>');
    h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
    h=h.replace(/^\\s*[-*]\\s+(.*)$/gm,'<li>$1</li>').replace(/(<li>[\\s\\S]*?<\\/li>)/g,'<ul>$1</ul>');
    h=h.replace(/\\n\\n+/g,'<br><br>');
    h=h.replace(/\\u0000(\\d+)\\u0000/g,(_,i)=>'<pre><code>'+esc(blocks[+i])+'</code></pre>');
    return h;
  };
  window.textOf=function(s){
    if(typeof s==='string')return s;
    if(Array.isArray(s))return s.map(b=>b&&b.text?b.text:JSON.stringify(b)).join('\\n');
    return JSON.stringify(s,null,2);
  };
  // HTML-escape helper for client code that builds markup strings (log viewer).
  // Prevents stored model/tool output from executing when injected via innerHTML.
  window.esc=function(s){
    return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  };
  // Admin key handling for the gated management API (config/logs/chat).
  // The key is the proxy's inbound key (PROXY_INBOUND_KEY). It is held only in
  // this tab's sessionStorage and sent as a Bearer header on each fetch — never
  // embedded in served HTML. adminFetch prompts once, and re-prompts on 401.
  window.getAdminKey=function(force){
    let k=sessionStorage.getItem('ccpp_admin_key');
    if(!k||force){
      k=window.prompt('Enter proxy admin key (PROXY_INBOUND_KEY):','');
      if(k){sessionStorage.setItem('ccpp_admin_key',k);} else {throw new Error('admin key required');}
    }
    return k;
  };
  window.adminFetch=async function(url,opts){
    opts=opts||{};
    // 'x-ccpp-csrf' is a custom header only same-origin script can set; the
    // server requires it on state-changing management POSTs (CSRF defense).
    const base={authorization:'Bearer '+window.getAdminKey(false),'x-ccpp-csrf':'1'};
    const headers=Object.assign({},opts.headers,base);
    let res=await fetch(url,Object.assign({},opts,{headers}));
    if(res.status===401){
      // Stored key was wrong/stale — prompt again once and retry.
      const retry=Object.assign({},opts.headers,{authorization:'Bearer '+window.getAdminKey(true),'x-ccpp-csrf':'1'});
      res=await fetch(url,Object.assign({},opts,{headers:retry}));
    }
    return res;
  };
  </script>
</body>
</html>`;
}
