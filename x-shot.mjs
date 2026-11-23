import { chromium } from "playwright";
import { renderQueueShell } from "./src/gateway/apply-queue-page.ts";
import { APPLY_QUEUE_SCRIPT } from "./src/gateway/apply-queue-script.ts";
const data = {counts:{ready:2,answer:1,mac:1,site:1},groups:[{id:"ready",title:"Ready to send"},{id:"answer",title:"Need one answer"},{id:"mac",title:"Need a click on your Mac"},{id:"site",title:"Need you on the site"}],macOnline:false,items:[
{id:"1",group:"ready",company:"ReadyCo",title:"Backend Engineer",jobUrl:"https://x.test/1",reason:"5 of 5 fields filled, no bot check",answerUrl:"https://a.test/apply/t1",createdAt:1,canSend:true},
{id:"2",group:"ready",company:"NoSnapCo",title:"Data Engineer",jobUrl:"https://x.test/2",reason:"5 of 5 fields filled",canSend:false},
{id:"3",group:"answer",company:"AskCo",title:"Platform Engineer",jobUrl:"https://x.test/3",reason:"1 required question unanswered: Why us?",answerUrl:"https://a.test/apply/t3",createdAt:1,canSend:false},
{id:"4",group:"mac",company:"MacCo",title:"SRE",jobUrl:"https://x.test/4",reason:"CAPTCHA on the form",canSend:false},
{id:"5",group:"site",company:"SiteCo",title:"Developer",jobUrl:"https://x.test/5",reason:"Workday: needs an account",answerUrl:"https://a.test/apply/t5",createdAt:1,canSend:false}]};
const html = renderQueueShell("n0nce").replace(/<script nonce="n0nce">[\s\S]*?<\/script>/, "<script>"+APPLY_QUEUE_SCRIPT+"</script>");
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:390,height:900}});
await p.addInitScript(()=>{window.Telegram={WebApp:{initData:"x",ready(){},expand(){}}}});
await p.route("**/apply/api/queue",r=>r.fulfill({json:data}));
await p.route("http://q.test/apply/queue",r=>r.fulfill({contentType:"text/html",body:html}));
await p.goto("http://q.test/apply/queue"); await p.waitForSelector(".q");
await p.screenshot({path:"docs/sessions/assets/apply-queue-mini-app.png",fullPage:true});
await b.close();
