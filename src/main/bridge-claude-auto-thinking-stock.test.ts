import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ompPackageRoot } from "./omp-runtime";
import { INSTALLED_OMP, stockFixtureEnv, stopOmpDaemon } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

const cases = ["adaptive", "budget", "limited", "spend429", "payment", "spent", "credit", "disconnect", "sse"];
const refusals: Record<string, unknown> = {
	limited: { kind: "transient", retryAfterSeconds: 1 },
	spend429: { kind: "monthly" },
	payment: "billing",
	spent: { kind: "console" },
	credit: "lowCredit",
};
const ids = cases.map(c => `fixture-${c}`);
const routes = ["anthropic-api-key", "anthropic-api-key-2"];
const keys = ["dummy-first", "dummy-selected"];

// No external fetch is retained. The stock adapter builds the body, headers and SSE consumer.
const guard = `
for (const [mod, fn] of [['node:https','request'], ['node:https','get'], ['node:tls','connect']])
 require(mod)[fn] = () => { throw Error('External transport disabled'); };
globalThis.calls=[];
globalThis.fetch=Object.assign(async (input, init) => {
 const url=new URL(input instanceof Request ? input.url : input);
 const key=${JSON.stringify(keys)}.indexOf(new Headers(init?.headers ?? input.headers).get('x-api-key'));
 if (url.origin!=='https://api.anthropic.com' || key<0) throw Error('Network disabled');
 if (url.pathname==='/v1/models') return Response.json({data:${JSON.stringify(ids.map(id => ({ id })))},has_more:false});
 if (url.pathname!=='/v1/messages' || init?.method?.toUpperCase()!=='POST') throw Error('Network disabled');
 const b=JSON.parse(init.body); const scenario=b.model.replace('fixture-','');
 const answer=JSON.stringify(b.messages).includes('fixture user turn');
 const ordinal=globalThis.calls.filter(c=>c.scenario===scenario).length;
 const call={scenario,key,answer,thinking:b.thinking?.type,status:200}; globalThis.calls.push(call);
 const error=(status,msg,details,headers)=>{call.status=status;return Response.json({type:'error',error:{type:status===429?'rate_limit_error':'invalid_request_error',message:msg,details}},{status,headers});};
 if (!answer && scenario==='disconnect') throw new TypeError('fixture probe connection lost');
 if (!answer && scenario==='limited') return error(429,'organization limit',{error_code:'ramp_limit_exceeded'},{'retry-after':'1'});
 if (!answer && scenario==='spend429' && ordinal>=7) return error(429,'spending limit',{error_code:'enforced_spend_limit_reached'});
 if (!answer && scenario==='payment') return error(402,'payment required');
 if (!answer && scenario==='spent') return error(400,'You have reached your specified workspace API usage limits.');
 if (!answer && scenario==='credit') return error(400,'Your credit balance is too low to access the Anthropic API');
 if (!answer && ['budget','spend429'].includes(scenario) && b.thinking?.type==='adaptive') return error(400,'unsupported thinking format');
 const events=(!answer && scenario==='sse' && ordinal===0)
  ? [{type:'error',error:{type:'invalid_request_error',message:'fixture in-band error'}}]
  : [{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:b.model,content:[],usage:{input_tokens:1,output_tokens:0}}},
     {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
     {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture answer'}},
     {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
 return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
},{preconnect:()=>{}});`;

const probe = `import {install,methods} from './claude-api-route';
export default function(pi) {
 install(pi);
 pi.on('session_start',()=>{ void (async()=>{
 const session=pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
 const env={pi,session:()=>session,emit:()=>{},context:()=>undefined};
 const rows=[]; let resolutions=0;
 for(const id of ${JSON.stringify(ids)}) {
  const offers=await methods['claude_api.offers']({modelId:id, providers:${JSON.stringify(routes)}},env);
  const selected=await methods['claude_api.select']({provider:${JSON.stringify(routes[1])},ticket:offers.ticket},env);
  const original=session.agent.streamFn;
  const thinking={mode:'effort',unverified:true,efforts:['minimal','low','medium','high','xhigh','max']};
  session.agent.streamFn=function(model,ctx,opts) {
   return original.call(this,{...model,reasoning:true,thinking},ctx,{...opts,reasoning:'high',apiKey:()=>{resolutions++;throw Error('unexpected credential rotation');}});
  };
  let live;
  const off=session.subscribe(e=>{if(e.type==='message_end' && e.message.role==='assistant') live=e.message.claudeApiRoute;});
  try { await session.prompt('fixture user turn'); } finally { off(); session.agent.streamFn=original; }
  const last=session.sessionManager.getBranch().findLast(e=>e.type==='message' && e.message.role==='assistant')?.message;
  rows.push({id,provider:selected.provider,reason:last?.stopReason,receipt:last?.claudeApiRoute,live});
 }
 console.error('THINKING='+JSON.stringify({rows,resolutions,calls:globalThis.calls,intents:session.sessionManager.getBranch().filter(r=>r.customType==='ompdesk.claude-api-dispatch').length}));
 process.exit(0);
 })().catch(e=>{console.error(e);process.exit(1)}); });
}`;

it.skipIf(!existsSync(INSTALLED_OMP))(
	"stock's thinking probes and answer use only the selected key; HTTP account refusals never start the answer",
	async () => {
		const root = ompPackageRoot(INSTALLED_OMP);
		if (!root) throw new Error("Cannot locate installed omp");
		const home = mkdtempSync(join(tmpdir(), "omp-thinking-"));
		const env = stockFixtureEnv(home);
		try {
			const agent = join(home, "agent");
			mkdirSync(agent);
			writeFileSync(
				join(agent, "models.yml"),
				JSON.stringify({
					providers: Object.fromEntries(
						routes.map((id, i) => [
							id,
							{
								api: "anthropic-messages",
								baseUrl: "https://api.anthropic.com",
								auth: "apiKey",
								apiKey: keys[i],
								models: ids.map(id => ({ id, name: id })),
							},
						]),
					),
				}),
			);
			writeFileSync(
				join(agent, "config.yml"),
				JSON.stringify({ modelRoles: { default: `${routes[0]}/${ids[0]}` } }),
			);
			const bridge = join(home, "bridge");
			cpSync(resolve("resources/gui-bridge"), bridge, { recursive: true });
			writeFileSync(join(bridge, "probe.ts"), probe);
			writeFileSync(join(home, "guard.js"), guard);
			const child = spawn(
				"bun",
				[
					"--preload",
					join(home, "guard.js"),
					join(root, "dist", "cli.js"),
					"--mode",
					"rpc",
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"--no-title",
					"--tools=",
					"-e",
					join(bridge, "probe.ts"),
				],
				{ env, cwd: home, stdio: ["pipe", "ignore", "pipe"], timeout: 45_000 },
			);
			let stderr = "";
			child.stderr.setEncoding("utf8").on("data", data => {
				stderr += data;
			});
			const [code] = await once(child, "close");
			expect(code, stderr.slice(-2000)).toBe(0);
			const output = stderr.split("\n").find(line => line.startsWith("THINKING="));
			if (!output) throw new Error("Missing stock response");
			const { calls, rows, resolutions, intents } = JSON.parse(output.slice(9)) as {
				calls: { key: number; scenario: string; answer: boolean; thinking?: string; status: number }[];
				rows: { id: string; provider: string; reason: string; receipt?: { refusal?: unknown }; live?: unknown }[];
				resolutions: number;
				intents: number;
			};
			expect(intents).toBe(cases.length);
			expect(resolutions).toBe(0);
			expect(calls.every(c => c.key === 1)).toBe(true);
			for (const [i, scenario] of cases.entries()) {
				const wire = calls.filter(c => c.scenario === scenario);
				const probes = wire.filter(c => !c.answer);
				const answers = wire.filter(c => c.answer);
				const success = ["adaptive", "budget", "sse"].includes(scenario);
				expect(rows[i]).toMatchObject({ id: ids[i], provider: routes[1] });
				expect(rows[i].receipt).toEqual(rows[i].live);
				expect(rows[i].receipt?.refusal).toEqual(refusals[scenario]);
				if (refusals[scenario]) expect(rows[i].receipt).toMatchObject({ provider: routes[1] });
				if (success) {
					expect(probes).toHaveLength(scenario === "budget" ? 13 : 7);
					expect(answers).toHaveLength(1);
					expect(wire.at(-1)).toMatchObject({
						answer: true,
						thinking: scenario === "budget" ? "enabled" : "adaptive",
					});
					expect(rows[i].reason).toBe("stop");
				} else {
					expect(probes.length).toBeGreaterThan(0);
					expect(probes.length).toBeLessThanOrEqual(scenario === "spend429" ? 13 : 7);
					if (scenario === "spend429") {
						expect(probes.slice(0, 7).some(p => p.key === 1 && p.status === 200)).toBe(true);
						expect(probes[7]).toMatchObject({ key: 1, status: 429 });
					}
					expect(answers).toHaveLength(0);
					expect(["error", "aborted"]).toContain(rows[i].reason);
				}
			}
		} finally {
			stopOmpDaemon(home, env);
			await removeWhenFree(home);
		}
	},
	60_000,
);
