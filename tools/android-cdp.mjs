// Evaluate JS in the JellyShell Android app's WebView over CDP (emulator or USB device).
//   adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof <pkg>)
//   node tools/android-cdp.mjs '<js expression>'          -> prints JSON result (promises awaited)
//   node tools/android-cdp.mjs --login <creds.json>     -> fills + submits the password form ({username, password}, e.g. from tools/cert-account.py)
//   CDP_PORT (default 9333) = the forwarded port
import fs from 'fs';
const args = process.argv.slice(2);
let expr = args[0];
if (args[0] === '--login') {
  const c = JSON.parse(fs.readFileSync(args[1]));
  expr = `(async()=>{const seg=document.querySelector('[data-fkey=seg-pw]');seg&&seg.click();await new Promise(r=>setTimeout(r,500));
const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
set(ins[0],${JSON.stringify(c.username)});set(ins[1],${JSON.stringify(c.password)});await new Promise(r=>setTimeout(r,300));
const b=[...document.querySelectorAll('button,.focusable')].find(e=>/^\\s*sign in\\s*$/i.test(e.textContent));b&&b.click();return !!b})()`;
}
const port = process.env.CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id === 1) {
    console.log(JSON.stringify(d.result.result.value ?? d.result.exceptionDetails?.exception?.description ?? d.result));
    ws.close();
  }
};
