import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

const PROBE = `
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as presentation from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { InstructionQueueView } from "./composer-queue";
import { ManualInstructionArchive } from "./composer-manual";
export default function(pi) {
 pi.on("session_start", async () => {
  try {
   const session=pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const image={type:"image",data:"aGk=",mimeType:"image/png"};
   const root=(text,time)=>({role:"user",content:[{type:"text",text},image],attribution:"user",timestamp:time,provenance:{source:"user-outbox",id:"original-"+time}});
   const make=(messages)=>{session.agent.replaceQueues(messages,[]);return new InstructionQueueView(session,presentation,()=>false)};
   const first=root("equal",1),second=root("equal",2),imageOnly={...root("",3),content:[image]};
   const view=make([first,second,imageOnly]);
   const before=view.snapshot();
   session.agent.prioritizeSteering([second]);
   const after=view.snapshot();
   const manager=SessionManager.create(process.env.PI_CODING_AGENT_DIR,join(process.env.PI_CODING_AGENT_DIR,"manual-records"));
   const archive=new ManualInstructionArchive(manager,()=>{});
   const withdrawn=await archive.withdraw(view,before.instance,before.entries[1].id,"draft");
   const repeat=await archive.withdraw(view,before.instance,before.entries[1].id,"draft");
   const remaining=session.agent.peekSteeringQueue();
   let stale=false;try{await archive.withdraw(view,"old-instance",before.entries[0].id,"draft")}catch{stale=true}
   let conflictingIntent=false;try{await archive.withdraw(view,before.instance,before.entries[1].id,"discard")}catch{conflictingIntent=true}
   const removedImage=await archive.withdraw(view,before.instance,before.entries[2].id,"discard");
   await archive.acknowledge(removedImage.recoveryId,{kind:"discard"});
   await archive.acknowledge(removedImage.recoveryId,{kind:"discard"});
   const file=manager.getSessionFile();
   await manager.close();
   const reopened=await SessionManager.open(file,undefined,undefined,{throwIfMissing:true});
   const recovery=new ManualInstructionArchive(reopened,()=>{});
   const recovered=await recovery.recover();
   await recovery.acknowledge(recovered.entries[0].recoveryId,{kind:"draft",draftId:"draft-one"});
   await recovery.acknowledge(recovered.entries[0].recoveryId,{kind:"draft",draftId:"draft-one"});
   let secondOwner=false;try{await recovery.acknowledge(recovered.entries[0].recoveryId,{kind:"draft",draftId:"draft-two"})}catch{secondOwner=true}
   const afterAck=await recovery.recover();
   await reopened.close();

   const pre=root("pre-save",4),preView=make([pre]);
   const preManager=SessionManager.create(process.env.PI_CODING_AGENT_DIR,join(process.env.PI_CODING_AGENT_DIR,"pre-save"));
   const appendPre=preManager.appendCustomEntry.bind(preManager);
   preManager.appendCustomEntry=()=>{throw new Error("injected pre-save failure")};
   const preArchive=new ManualInstructionArchive(preManager,()=>{});
   let preError=false;try{await preArchive.withdraw(preView,preView.instance,preView.snapshot().entries[0].id,"draft")}catch{preError=true}
   const preUnchanged=session.agent.peekSteeringQueue()[0]===pre;
   preManager.appendCustomEntry=appendPre;
   await preManager.close();

   const post=root("post-withdraw",5),postView=make([post]);
   const postId=postView.snapshot().entries[0].id;
   const postManager=SessionManager.create(process.env.PI_CODING_AGENT_DIR,join(process.env.PI_CODING_AGENT_DIR,"post-save"));
   const appendPost=postManager.appendCustomEntry.bind(postManager);
   postManager.appendCustomEntry=(type,data)=>{if(data?.state==="withdrawn")throw new Error("injected completion failure");return appendPost(type,data)};
   const postArchive=new ManualInstructionArchive(postManager,()=>{});
   let postError=false;try{await postArchive.withdraw(postView,postView.instance,postId,"discard")}catch{postError=true}
   const postWasRemoved=session.agent.peekSteeringQueue().length===0;
   postManager.appendCustomEntry=appendPost;
   let retryUnconfirmed=false;try{await postArchive.withdraw(postView,postView.instance,postId,"discard")}catch(error){retryUnconfirmed=String(error).includes("unconfirmed")}
   const postFile=postManager.getSessionFile();
   await postManager.close();
   const postOpen=await SessionManager.open(postFile,undefined,undefined,{throwIfMissing:true});
   const postRecovery=new ManualInstructionArchive(postOpen,()=>{});
   const postRecovered=await postRecovery.recover();
   let unknownDiscard=false;
   try{await postRecovery.acknowledge(postRecovered.entries[0].recoveryId,{kind:"discard"})}catch{unknownDiscard=true}
   await postOpen.close();

   const crash=root("before-withdraw-crash",6),crashView=make([crash]);
   const crashManager=SessionManager.create(process.env.PI_CODING_AGENT_DIR,join(process.env.PI_CODING_AGENT_DIR,"prepared-crash"));
   let boundaries=0,crashError=false;
   const crashArchive=new ManualInstructionArchive(crashManager,()=>{if(++boundaries===2)throw new Error("simulated receiver replacement after prepare flush")});
   try{await crashArchive.withdraw(crashView,crashView.instance,crashView.snapshot().entries[0].id,"draft")}catch{crashError=true}
   const crashOriginalUnchanged=session.agent.peekSteeringQueue()[0]===crash;
   const crashFile=crashManager.getSessionFile();
   await crashManager.close();
   const crashOpen=await SessionManager.open(crashFile,undefined,undefined,{throwIfMissing:true});
   const crashRecovered=await new ManualInstructionArchive(crashOpen,()=>{}).recover();
   await crashOpen.close();

   const agentRoot={role:"user",content:"agent-owned",attribution:"agent",timestamp:7};
   const agentView=make([agentRoot]);
   const agentCapture=agentView.capture(agentView.instance,agentView.snapshot().entries[0].id);
   console.error("INSTRUCTION_QUEUE="+JSON.stringify({
    before,after,withdrawn,repeat,remainingOriginals:remaining[0]===first&&remaining[1]===imageOnly,
    stale,recovered,afterAck,secondOwner,preError,preUnchanged,postError,postWasRemoved,retryUnconfirmed,postRecovered,
    unknownDiscard,conflictingIntent,removedImage,
    crashError,crashOriginalUnchanged,crashRecovered,agentEditable:agentCapture!==undefined,agentUnchanged:session.agent.peekSteeringQueue()[0]===agentRoot
   }));
  } catch(error) {console.error("INSTRUCTION_QUEUE_ERROR="+String(error?.stack??error));}
  process.exit(0);
 });
}
`;

describe.skipIf(!existsSync(INSTALLED_OMP))("original instruction handoff on the installed stock journal", () => {
	it("keeps duplicate text and image-only identities and durably returns the selected original once", () => {
		const report = runBridgeProbe(PROBE, "INSTRUCTION_QUEUE");
		expect(report.remainingOriginals).toBe(true);
		expect(report.stale).toBe(true);
		expect(report.repeat).toEqual(report.withdrawn);
		expect(report.withdrawn).toMatchObject({
			removed: true,
			entry: {
				text: "equal",
				images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
				envelope: { provenance: { source: "user-outbox", id: "original-2" } },
			},
		});
		expect(report.before).toMatchObject({ entries: [{ id: "1" }, { id: "2" }, { id: "3", text: "[Image]" }] });
		expect(report.after).toEqual(report.before);
		expect(report.recovered).toMatchObject({ entries: [{ state: "withdrawn", entry: { text: "equal" } }] });
		expect(report.afterAck).toEqual({ entries: [] });
		expect(report.secondOwner).toBe(true);
		expect(report.conflictingIntent).toBe(true);
		expect(report.removedImage).toMatchObject({
			removed: true,
			intent: "discard",
			entry: { text: "[Image]", images: [{ data: "aGk=" }] },
		});
		expect(report.preError).toBe(true);
		expect(report.preUnchanged).toBe(true);
		expect(report.postError).toBe(true);
		expect(report.postWasRemoved).toBe(true);
		expect(report.retryUnconfirmed).toBe(true);
		expect(report.postRecovered).toMatchObject({
			entries: [{ state: "unconfirmed", entry: { text: "post-withdraw", images: [{ data: "aGk=" }] } }],
		});
		expect(report.unknownDiscard).toBe(true);
		expect(report.crashError).toBe(true);
		expect(report.crashOriginalUnchanged).toBe(true);
		expect(report.crashRecovered).toMatchObject({
			entries: [{ state: "unconfirmed", entry: { text: "before-withdraw-crash" } }],
		});
		expect(report.agentEditable).toBe(false);
		expect(report.agentUnchanged).toBe(true);
	}, 120_000);
});
