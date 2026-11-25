/**
 * Every main-process string (the text-field context menu, dialogs, coded failures) in both UI
 * languages. Pure data, apart from `i18n.ts` (which needs electron), so tests
 * can hold it against the renderer's names for the same things.
 */
import NATIVE_LABELS from "../../native/ompdesk/crates/tauri-shell/src/native_labels.json";
import type { UiLanguage } from "../shared/ui-language";

export const MAIN_TEXT = {
	"dialog.openProject": { en: "Open project", ko: "프로젝트 열기" },
	"web.unknownDevice.title": { en: "An unknown device tried to connect", ko: "알 수 없는 기기가 접속을 시도했어요" },
	"web.unknownDevice.body": {
		en: "Mobile web refused it (no paired device). Nothing to do unless it was you.",
		ko: "모바일 웹이 거부했어요(페어링된 기기가 아니에요). 직접 시도한 게 아니라면 할 일은 없어요.",
	},
	// A scheduled run's answer sent where its schedule says (`ScheduleDraft.resultsTo`).
	"schedules.result.title": { en: "Scheduled run: {name}", ko: "예약 실행: {name}" },
	"schedules.result.note": {
		en: 'The scheduled run "{name}" finished. Its answer:',
		ko: '예약 실행 "{name}"이 끝났어요. 답:',
	},
	// Files main could not save for lack of space (disk-full-notice.ts): one notice, closed once they are saved.
	"diskFull.title": { en: "Disk is full", ko: "디스크가 가득 찼어요" },
	"diskFull.body": {
		en: "OMPdesk couldn't save {what}; it will retry.",
		ko: "디스크가 가득 차서 {what} 저장에 실패했어요. 자동으로 다시 시도할게요.",
	},
	// An omp runners found breaking this release, which OMPdesk holds back (the core's tools/omp/hold.rs): once, then after a day.
	"ompHold.title": { en: "omp {version} is on hold", ko: "omp {version} 판을 보류하고 있어요" },
	"ompHold.body": {
		en: "It failed OMPdesk's checks, so this computer stays on omp {installed}. OMPdesk moves on by itself once a fix is out.",
		ko: "OMPdesk 검사를 통과하지 못해서 이 컴퓨터는 omp {installed} 판을 그대로 써요. 고친 판이 나오면 저절로 올라가요.",
	},
	"ompHold.bodyDays": {
		en: "On hold for {days} day(s): it failed OMPdesk's checks, so this computer stays on omp {installed}. OMPdesk moves on by itself once a fix is out.",
		ko: "{days}일째 보류 중이에요. OMPdesk 검사를 통과하지 못해서 이 컴퓨터는 omp {installed} 판을 그대로 써요. 고친 판이 나오면 저절로 올라가요.",
	},
	// A newer omp that has waited 6 h or more for runners' verdict (the core's tools/omp/hold.rs): then again every 24 h.
	"ompHold.verifyingTitle": {
		en: "omp {version} is still waiting for OMPdesk's checks",
		ko: "omp {version} 판이 아직 OMPdesk 검사를 기다리고 있어요",
	},
	"ompHold.verifyingBody": {
		en: "It has waited {hours} hours (checks usually take under an hour), so this computer stays on omp {installed}. Update now in Settings › Updates & about installs it anyway.",
		ko: "{hours}시간째 기다리고 있어서(보통 한 시간 안에 끝나요) 이 컴퓨터는 omp {installed} 판을 그대로 써요. 설정 › 업데이트 및 정보에서 지금 업데이트를 누르면 바로 설치돼요.",
	},
	"ompHold.verifyingBodyDays": {
		en: "It has waited {days} day(s) (checks usually take under an hour), so this computer stays on omp {installed}. Update now in Settings › Updates & about installs it anyway.",
		ko: "{days}일째 기다리고 있어서(보통 한 시간 안에 끝나요) 이 컴퓨터는 omp {installed} 판을 그대로 써요. 설정 › 업데이트 및 정보에서 지금 업데이트를 누르면 바로 설치돼요.",
	},
	// A window whose page stopped answering a second time within the hour and was started again (window.ts).
	"rendererHang.title": { en: "OMPdesk's window stopped responding again", ko: "OMPdesk 창이 또 멈췄어요" },
	"rendererHang.body": {
		en: "Its page was started again by itself, with its tabs and sessions. Nothing was lost.",
		ko: "창의 화면을 자동으로 다시 띄웠어요. 탭과 세션은 그대로예요.",
	},
	// Tabs a lost core took that have no omp again minutes later (sidecar.ts `onRecoveryStuck`): one notice per loss.
	"recovery.stuckTitle": { en: "Sessions did not come back", ko: "세션이 다시 열리지 않았어요" },
	"recovery.stuckBody": {
		en: "{count} session(s) still have no agent {minutes} min after OMPdesk's background process restarted. Press Restart on each one.",
		ko: "OMPdesk 백그라운드 프로세스가 다시 시작된 뒤 {minutes}분이 지나도 세션 {count}개에 에이전트가 없어요. 각 세션에서 다시 시작을 눌러 주세요.",
	},
	"recovery.stuckTab": {
		en: "This session's agent did not come back after OMPdesk's background process restarted. Press Restart.",
		ko: "OMPdesk 백그라운드 프로세스가 다시 시작된 뒤 이 세션의 에이전트가 돌아오지 않았어요. 다시 시작을 눌러 주세요.",
	},
	// The line a side-panel terminal shows between its saved output and the new shell after OMPdesk restarted.
	"terminal.restored": {
		en: "Restored after a restart: earlier output above, a new shell below",
		ko: "재시작 후 복원됨: 위는 이전 출력, 아래는 새 셸",
	},
	// A paired device's session here waits on a call that device runs while it is away (host-services.ts `#syncHostWait`).
	"remote.hostWait.title": { en: "Waiting for {device}", ko: "{device} 연결 대기 중" },
	"remote.hostWait.body": {
		en: "{session} waits for {device} to come back.",
		ko: "‘{session}’ 세션이 {device}의 재연결을 기다리고 있어요.",
	},
	"remote.hostWait.bodyUntitled": {
		en: "A session waits for {device} to come back.",
		ko: "세션 하나가 {device}의 재연결을 기다리고 있어요.",
	},
	"menu.addToDictionary": { en: "Add to dictionary", ko: "사전에 추가" },
	"menu.copyImage": { en: "Copy Image", ko: "이미지 복사" },
	"crash.body": {
		en: "This window crashed repeatedly and can't recover on its own. The failure is in the runtime log ({logPath}). Restarting may help; send the log via Help → Send Feedback so we can fix it.",
		ko: "이 창이 반복해서 충돌해 스스로 복구할 수 없어요. 실패 내용은 런타임 로그({logPath})에 있어요. 재시작하면 해결될 수 있어요. 도움말 → 피드백 보내기로 로그를 보내 주시면 수정에 도움이 돼요.",
	},
	"crash.close": { en: "Close", ko: "닫기" },
	"crash.title": { en: "OMPdesk window crashed", ko: "OMPdesk 창이 충돌했어요" },
	// The text-field context menu's edit items have the app menu's words (the shell's, `native_labels.json`).
	"menu.undo": NATIVE_LABELS["menu.undo"],
	"menu.redo": NATIVE_LABELS["menu.redo"],
	"menu.cut": NATIVE_LABELS["menu.cut"],
	"menu.copy": NATIVE_LABELS["menu.copy"],
	"menu.paste": NATIVE_LABELS["menu.paste"],
	"menu.selectAll": NATIVE_LABELS["menu.selectAll"],
	"agentControl.stopTitle": {
		en: "An agent wants to stop a session",
		ko: "에이전트가 세션을 중단하려고 해요",
	},
	"agentControl.stopMessage": {
		en: "The agent in “{caller}” wants to stop the work of “{target}”. Stop it?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션의 작업을 중단하려고 해요. 중단할까요?",
	},
	"agentControl.closeMessage": {
		en: "The agent in “{caller}” wants to stop “{target}” and close its tab (the session stays saved). Continue?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션을 중단하고 탭을 닫으려고 해요(세션은 저장돼 있어요). 계속할까요?",
	},
	"agentControl.deleteMessage": {
		en: "The agent in “{caller}” wants to stop “{target}”, close its tab and DELETE the saved session. This can't be undone. Continue?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션을 중단하고 탭을 닫은 뒤 저장된 세션을 삭제하려고 해요. 되돌릴 수 없어요. 계속할까요?",
	},
	"agentControl.mergeTitle": {
		en: "An agent wants to merge a branch",
		ko: "에이전트가 브랜치를 병합하려고 해요",
	},
	"agentControl.mergeMessage": {
		en: "The agent in “{caller}” wants to merge branch {branch} (from “{target}”) into {base} in {cwd}. Nothing is pushed. Merge?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션의 {branch} 브랜치를 {cwd}의 {base} 브랜치에 병합하려고 해요. 푸시는 하지 않아요. 병합할까요?",
	},
	"agentControl.scheduleTitle": {
		en: "An agent wants to schedule a run",
		ko: "에이전트가 예약 실행을 만들려고 해요",
	},
	"agentControl.scheduleMessage": {
		en: "The agent in “{caller}” wants to run “{name}” {when} in {folder} while OMPdesk is open. It runs without auto-approve. Schedule it?",
		ko: "“{caller}”의 에이전트가 OMPdesk가 켜져 있는 동안 {folder} 폴더에서 “{name}” 작업을 {when} 실행하도록 예약하려고 해요. 자동 승인 없이 실행돼요. 예약할까요?",
	},
	// Every precheck raises this card, whatever else agents may do: it is a command this computer runs.
	"agentControl.schedulePrecheckMessage": {
		en: "The agent in “{caller}” wants “{name}” ({when}, in {folder}) to run this command before each start, and to start only when it succeeds: {command}. Allow it?",
		ko: "“{caller}”의 에이전트가 “{name}”({when}, {folder})을 시작할 때마다 먼저 이 명령을 실행하고, 성공할 때만 시작하도록 하려고 해요: {command}. 허용할까요?",
	},
	"agentControl.botTitle": {
		en: "An agent wants to make a bot",
		ko: "에이전트가 봇을 만들려고 해요",
	},
	"agentControl.botMessage": {
		en: "The agent in “{caller}” wants to make the bot “{name}”: a folder on this computer whose sessions are its chats. Nothing is sent to it until you write to it. Make it?",
		ko: "“{caller}”의 에이전트가 “{name}” 봇을 만들려고 해요. 이 컴퓨터의 폴더 하나이고, 그 폴더의 세션이 봇의 대화예요. 직접 말을 걸기 전에는 아무것도 보내지 않아요. 만들까요?",
	},
	"agentControl.autopilotTitle": {
		en: "An agent wants to start Autopilot",
		ko: "에이전트가 오토파일럿을 시작하려고 해요",
	},
	"agentControl.autopilotMessage": {
		en: "The agent in “{caller}” wants to start Autopilot on {folder}: an unattended loop that keeps changing the repository in its own worktree. Branch: {branch}. Ship level: {ship}. Start it?",
		ko: "“{caller}”의 에이전트가 {folder} 폴더에서 오토파일럿을 시작하려고 해요. 별도 워크트리에서 저장소를 계속 고쳐 가는 자동 반복이에요. 브랜치: {branch}. 반영 수준: {ship}. 시작할까요?",
	},
	"agentControl.autopilotShipCommit": { en: "commits only (nothing is pushed)", ko: "커밋만(푸시는 안 해요)" },
	"agentControl.autopilotShipPush": { en: "pushes every green cycle", ko: "초록 사이클마다 푸시" },
	"agentControl.autopilotShipRelease": {
		en: "pushes and RELEASES (a version is published)",
		ko: "푸시하고 릴리스까지(새 버전이 공개돼요)",
	},
	"agentControl.autopilotBranchNew": { en: "a new autopilot/<date> branch", ko: "새 autopilot/<날짜> 브랜치" },
	"agentControl.autopilotBranchDefault": {
		en: "{name} (the default branch: work and pushes land on it directly)",
		ko: "{name}(기본 브랜치: 작업과 푸시가 바로 여기에 반영돼요)",
	},
	"agentControl.answeredBy": { en: "Answered by an agent ({by})", ko: "에이전트가 답함 ({by})" },
	"agentControl.appTitle": {
		en: "An agent wants to change the app",
		ko: "에이전트가 앱을 조작하려고 해요",
	},
	"agentControl.appMessage": {
		en: "The agent in “{caller}” wants to do this: {what}. Allow it?",
		ko: "“{caller}”의 에이전트가 다음 작업을 하려고 해요: {what}. 허용할까요?",
	},
	"agentControl.appChanged": { en: "Agent changed: {what} → {value}", ko: "에이전트가 바꿈: {what} → {value}" },
	"agentControl.unansweredTitle": {
		en: "“{child}” is waiting for an answer",
		ko: "“{child}” 세션이 답을 기다려요",
	},
	"agentControl.unansweredMessage": {
		en: "“{opener}” ended its turn without answering: {question}",
		ko: "“{opener}” 세션이 답하지 않고 차례를 마쳤어요: {question}",
	},
	// Autopilot (src/main/autopilot.ts): notifications and the readable failures of a start.
	"autopilot.paused.title": { en: "Autopilot paused", ko: "오토파일럿이 멈췄어요" },
	"autopilot.ended.title": { en: "Autopilot ended", ko: "오토파일럿이 끝났어요" },
	"autopilot.summary": {
		en: "{branch}: {cycles} cycles ({green} green), {commits} commits; {shipped}. Stopped: {reason}",
		ko: "{branch}: 사이클 {cycles}개(초록 {green}개), 커밋 {commits}개. {shipped}. 멈춘 이유: {reason}",
	},
	"autopilot.summary.landed": {
		en: "{landed} of {commits} landed on {target}",
		ko: "{target}에 {commits}개 중 {landed}개 반영",
	},
	"autopilot.summary.pr": {
		en: "{target} is protected: {landed} of {commits} landed, the rest waits in {url}",
		ko: "보호된 브랜치 {target}: {commits}개 중 {landed}개만 반영, 나머지는 {url}에서 기다려요",
	},
	"autopilot.summary.pushed": { en: "pushed to {target}", ko: "{target}에 푸시함" },
	"autopilot.summary.notPushed": { en: "the last commit is not pushed", ko: "마지막 커밋은 푸시 안 됨" },
	"autopilot.summary.local": { en: "kept on this computer", ko: "이 컴퓨터에만 있음" },
	"autopilot.land.prTitle": {
		en: "Autopilot can't push to the default branch",
		ko: "오토파일럿이 기본 브랜치에 푸시할 수 없어요",
	},
	"autopilot.land.prBody": {
		en: "{branch} is protected. Green cycles now go to one pull request instead: {url}",
		ko: "{branch} 브랜치가 보호되어 있어요. 이제 초록 사이클은 풀 리퀘스트 하나로 올라가요: {url}",
	},
	"autopilot.reason.user": { en: "Ended by you.", ko: "직접 끝냈어요." },
	"autopilot.reason.user_pause": { en: "Paused by you.", ko: "직접 일시정지했어요." },
	"autopilot.reason.user_abort": { en: "Stopped by you.", ko: "직접 멈췄어요." },
	"autopilot.reason.tab_closed": { en: "Its tab was closed.", ko: "탭이 닫혔어요." },
	"autopilot.reason.repo_gone": {
		en: "The repository folder is gone ({detail}).",
		ko: "저장소 폴더가 사라졌어요({detail}).",
	},
	"autopilot.reason.ban_violation": {
		en: "Autopilot's safety check saw a git change it did not expect ({detail}) and paused the run. Check it, then Resume to continue.",
		ko: "오토파일럿 안전 점검이 예상하지 못한 git 변경을 보고 멈췄어요({detail}). 확인한 뒤 재개하면 이어서 돌아요.",
	},
	"autopilot.reason.budget": { en: "The token limit was reached.", ko: "토큰 상한에 도달했어요." },
	"autopilot.reason.time": { en: "The time limit was reached.", ko: "시간 상한에 도달했어요." },
	"autopilot.reason.cycles": { en: "The cycle limit was reached.", ko: "사이클 상한에 도달했어요." },
	"autopilot.reason.cost": { en: "The cost limit was reached.", ko: "비용 상한에 도달했어요." },
	"autopilot.reason.app_closed": {
		en: "OMPdesk was closed; press Resume to continue.",
		ko: "OMPdesk가 닫혀 있었어요. 이어서 하려면 재개를 누르세요.",
	},
	"autopilot.reason.agent_done": { en: "The agent declared the work done.", ko: "에이전트가 작업이 끝났다고 했어요." },
	"autopilot.release.ok": { en: "Release {version} succeeded.", ko: "릴리스 {version} 성공." },
	"autopilot.release.failed": { en: "Release {version} failed.", ko: "릴리스 {version} 실패." },
	"autopilot.release.title": { en: "Autopilot release", ko: "오토파일럿 릴리스" },
	"autopilot.denied": {
		en: "Denied a request that breaks a hard limit: {reason}",
		ko: "금지된 요청을 거절했어요: {reason}",
	},
	"autopilot.err.guideTooLarge": {
		en: "The Autopilot guide is too large (limit 256 KB). Shorten it, then start again.",
		ko: "오토파일럿 가이드가 너무 커요(최대 256KB). 줄인 뒤 다시 시작하세요.",
	},
	"autopilot.err.guideCommit": {
		en: "Could not commit AUTOPILOT.md to the new Autopilot branch:",
		ko: "새 오토파일럿 브랜치에 AUTOPILOT.md를 커밋하지 못했어요:",
	},
	"autopilot.err.notRepo": {
		en: "Autopilot needs a git repository with at least one commit.",
		ko: "오토파일럿은 커밋이 하나 이상 있는 git 저장소에서만 시작할 수 있어요.",
	},
	"autopilot.err.detached": {
		en: "Check out a branch first: Autopilot cuts its worktree from the current branch.",
		ko: "먼저 브랜치를 체크아웃하세요. 오토파일럿은 현재 브랜치에서 워크트리를 만들어요.",
	},
	"autopilot.err.branchExists": {
		en: "A branch named {branch} already exists. Pick it from the list, or name the new branch differently.",
		ko: "{branch}라는 브랜치가 이미 있어요. 목록에서 고르거나 새 브랜치 이름을 바꾸세요.",
	},
	"autopilot.err.branchInvalid": {
		en: "{branch} is not a valid git branch name.",
		ko: "git 브랜치 이름으로 쓸 수 없어요: {branch}",
	},
	"autopilot.err.branchMissing": {
		en: "The branch {branch} does not exist (any more). Pick another one.",
		ko: "{branch} 브랜치가 (더 이상) 없어요. 다른 브랜치를 고르세요.",
	},
	"autopilot.err.onBase": {
		en: "This run works on or pushes to the default branch itself: there is nothing to merge or open a pull request for.",
		ko: "이 실행은 기본 브랜치에서 돌거나 기본 브랜치로 푸시해요. 병합하거나 PR을 열 것이 없어요.",
	},
	"autopilot.err.running": {
		en: "This session is already an Autopilot run.",
		ko: "이 세션은 이미 오토파일럿 실행 중이에요.",
	},
	"autopilot.err.device": {
		en: "Autopilot runs only on this computer, not on a paired device.",
		ko: "오토파일럿은 이 컴퓨터에서만 실행돼요(페어링된 기기에서는 안 돼요).",
	},
	"autopilot.err.noRelease": {
		en: "No release procedure was found in this repository's rules files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, RELEASING.md, docs/release*).",
		ko: "이 저장소의 규칙 파일(AGENTS.md, CLAUDE.md, CONTRIBUTING.md, RELEASING.md, docs/release*)에서 릴리스 절차를 찾지 못했어요.",
	},
	"autopilot.err.noRun": { en: "This session is not an Autopilot run.", ko: "이 세션은 오토파일럿 실행이 아니에요." },
	"autopilot.err.noCommit": { en: "That cycle made no commit to revert.", ko: "되돌릴 커밋이 없는 사이클이에요." },
	"autopilot.err.localOnly": {
		en: "Autopilot is controlled from the OMPdesk window on this computer.",
		ko: "오토파일럿은 이 컴퓨터의 OMPdesk 창에서만 제어해요.",
	},
	"omp.bunTooOld": {
		en: "omp at {bin} needs Bun {minimum} or newer, but {bun} is {bunVersion}. OMPdesk is upgrading Bun on its own; this tab starts once it is done.",
		ko: "{bin}의 omp는 Bun {minimum} 이상이 필요한데 {bun}은 {bunVersion}이에요. OMPdesk가 알아서 Bun을 업그레이드하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.cannotRun": {
		en: "omp at {bin} could not run ({detail}). OMPdesk is reinstalling it on its own; this tab starts once it is done.",
		ko: "{bin}의 omp를 실행할 수 없어요 ({detail}). OMPdesk가 알아서 다시 설치하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.compiled": {
		en: "omp at {bin} is a standalone build, which OMPdesk can't load its features into. OMPdesk is reinstalling it as the package on its own; this tab starts once it is done.",
		ko: "{bin}의 omp는 단독 실행 파일 빌드라서 OMPdesk 기능을 불러올 수 없어요. OMPdesk가 알아서 패키지로 다시 설치하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.notFound": {
		en: "omp is not installed. OMPdesk is installing it on its own; this tab starts once it is done.",
		ko: "omp가 설치되어 있지 않아요. OMPdesk가 알아서 설치하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.sessionOwned": {
		en: "This session is still open in another omp (a terminal, or OMPdesk's last launch closing). Opening it here too would split it into a second file. Close the other one: it opens here by itself then, or press Restart.",
		ko: "이 세션이 아직 다른 omp(터미널, 또는 닫히는 중인 이전 OMPdesk)에 열려 있어요. 여기서도 열면 세션이 두 파일로 갈라져요. 다른 쪽을 닫으면 여기서 알아서 열려요. 다시 시작을 눌러도 돼요.",
	},
	"omp.overrideMissing": {
		en: "OMP_GUI_OMP points at a missing file ({path}). Fix or unset it, then press Restart.",
		ko: "OMP_GUI_OMP가 가리키는 파일이 없어요 ({path}). 값을 고치거나 지운 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.tooOld": {
		en: "omp {version} is too old; this app needs {minimum} or newer. OMPdesk is updating it on its own; this tab starts once it is done.",
		ko: "omp {version}은 너무 오래된 버전이에요. 이 앱은 {minimum} 이상이 필요해요. OMPdesk가 알아서 업데이트하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"quit.keepWorking": { en: "Keep working", ko: "계속 사용" },
	"quit.quitAnyway": { en: "Quit anyway", ko: "그래도 종료" },
	"quit.workingBody": {
		en: "Still working: {working} of {total} session{totalPlural}, in {windows} window{windowsPlural}. Quitting stops them and their agents.",
		ko: "{windows}개 창에서 세션 {total}개 중 {working}개가 아직 실행 중이에요. 종료하면 세션과 에이전트가 모두 중단돼요.",
	},
	"quit.workingTitle": { en: "Sessions are still running", ko: "아직 실행 중인 세션이 있어요" },
	"restart.body": {
		en: "OMPdesk's installed files were replaced while it was running, so this window can no longer load them reliably. Still working: {working} of {total} session{totalPlural}.",
		ko: "OMPdesk 실행 중에 설치 파일이 교체되어 이 창에서 더 이상 안정적으로 불러올 수 없어요. 세션 {total}개 중 {working}개가 아직 실행 중이에요.",
	},
	"restart.later": { en: "Later", ko: "나중에" },
	"restart.now": { en: "Restart now", ko: "지금 재시작" },
	"restart.title": { en: "Restart to finish updating", ko: "업데이트를 마치려면 재시작하세요" },
	// Batched completion notifications (notification-batch.ts): "3 tasks finished · 1 needs you".
	"batch.finished.one": { en: "{count} task finished", ko: "작업 {count}개 완료" },
	"batch.finished.other": { en: "{count} tasks finished", ko: "작업 {count}개 완료" },
	"batch.failed": { en: "{count} failed", ko: "{count}개 실패" },
	"batch.needsYou.one": { en: "{count} needs you", ko: "{count}개 확인 필요" },
	"batch.needsYou.other": { en: "{count} need you", ko: "{count}개 확인 필요" },
	"batch.more": { en: "{list} +{count} more", ko: "{list} 외 {count}개" },
	// A finished turn whose last reply waits for the person (notify-triage.ts), in the renderer's `attention.question`
	// word; {title} is the tab's title.
	"notify.needsInput": { en: "Needs input · {title}", ko: "답변 필요 · {title}" },
	// Web Push to a paired phone (web/web-push-notifier.ts). The body reads like the desktop banner's; a device that
	// hides content gets only the title, and the batch summary above.
	"push.complete": { en: "Complete", ko: "완료" },
	"push.error": { en: "Stopped with error", ko: "오류로 중단됨" },
	"push.errorDetail": { en: "Stopped with error: {error}", ko: "오류로 중단됨: {error}" },
	"push.ask": { en: "Waiting for your input", ko: "입력을 기다리고 있어요" },
	"push.hidden.completion": { en: "A task finished", ko: "작업이 끝났어요" },
	"push.hidden.error": { en: "A task stopped with an error", ko: "작업이 오류로 중단됐어요" },
	"push.hidden.ask": { en: "A task needs you", ko: "작업에 확인이 필요해요" },
	// The test banner and the test push Settings sends (ipc.ts `SYSTEM_NOTIFY_TEST`, `WebHost.testPush`).
	"push.test.title": { en: "OMPdesk", ko: "OMPdesk" },
	"push.test.body": { en: "Test notification", ko: "테스트 알림" },
	// Status of a tab whose omp runs on a paired device that is unreachable.
	"remote.offline": {
		en: "The device running this session is offline. Reconnecting…",
		ko: "이 세션을 실행하는 기기가 오프라인이에요. 다시 연결하는 중이에요…",
	},
	// Status of a host tab whose host leaves its start unanswered for now; the tab waits and asks again
	// (src/main/remote/remote-sidecar.ts).
	"remote.tabUnanswered": {
		en: "{device} has not answered yet. Waiting for it; nothing was stopped.",
		ko: "{device}에서 아직 응답이 없어요. 기다리는 중이고, 멈춘 건 없어요.",
	},
	"remote.signInRelay.title": {
		en: "Sign-in not finished yet",
		ko: "아직 로그인이 끝나지 않았어요",
	},
	"remote.signInRelay.failed": {
		en: "OMPdesk couldn't pass this sign-in on to {device}. Copy this page's full address from the address bar and paste it into the sign-in panel in OMPdesk, or reload this page once {device} is connected again.",
		ko: "OMPdesk가 이 로그인을 {device}에 전달하지 못했어요. 주소창에서 이 페이지의 전체 주소를 복사해 OMPdesk 로그인 패널에 붙여 넣거나, {device}에 다시 연결되면 이 페이지를 새로 고쳐 주세요.",
	},
	// Stats bridge failures that reach the renderer (toasts, the stats page).
	"stats.notReady": {
		en: "OMPdesk keeps starting it in the background. Stats appear here as soon as it answers.",
		ko: "OMPdesk가 백그라운드에서 계속 시작하고 있어요. 응답하면 바로 여기에 통계가 표시돼요.",
	},
	"stats.notRunning": {
		en: "The stats server isn't running. Restart OMPdesk to bring it back.",
		ko: "통계 서버가 실행되고 있지 않아요. OMPdesk를 다시 시작하면 복구돼요.",
	},
	"updates.checkFailed": {
		en: "Couldn't check for updates. Check your connection and try again.",
		ko: "업데이트를 확인하지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
	},
	"updates.downloadFailed": {
		en: "The installer download failed. Check your connection and try again.",
		ko: "설치 프로그램을 다운로드하지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
	},
	"updates.hashMismatch": {
		en: "The downloaded installer failed SHA-512 verification and was removed. Try the update again.",
		ko: "다운로드한 설치 프로그램이 SHA-512 검증에 실패해 삭제했어요. 업데이트를 다시 시도하세요.",
	},
	"updates.installerMissing": {
		en: "This release does not include an installer for this computer.",
		ko: "이 릴리스에는 이 컴퓨터에 맞는 설치 프로그램이 없어요.",
	},
	"updates.failed": {
		en: "Couldn't finish the update. Try again later.",
		ko: "업데이트를 마치지 못했어요. 잠시 후 다시 시도하세요.",
	},
	"updates.noResult": {
		en: "The update check ended without a result. Try again in a moment.",
		ko: "업데이트 확인이 결과 없이 끝났어요. 잠시 후 다시 시도해 주세요.",
	},
	"updates.openInstallerFailed": {
		en: "The installer was downloaded, but macOS could not open it.",
		ko: "설치 프로그램을 다운로드했지만 macOS에서 열 수 없어요.",
	},
	"updates.releaseInvalid": {
		en: "The latest release has no valid update information, so OMPdesk can't update from it.",
		ko: "최신 릴리스에 올바른 업데이트 정보가 없어서 OMPdesk를 업데이트할 수 없어요.",
	},
	"updates.restartWork.and": { en: " and ", ko: ", " },
	"updates.restartWork.body": {
		en: "{work} will be interrupted and started again after the restart.",
		ko: "재시작하면 중단되고, 재시작 뒤 처음부터 다시 시작돼요: {work}",
	},
	"updates.restartWork.cancel": { en: "Cancel", ko: "취소" },
	"updates.restartWork.jobs": { en: "{count} background job{plural}", ko: "백그라운드 작업 {count}개" },
	"updates.restartWork.restart": { en: "Restart", ko: "재시작" },
	"updates.restartWork.subagents": { en: "{count} subagent{plural}", ko: "서브에이전트 {count}개" },
	"updates.restartWork.unknown": {
		en: "{count} session{plural} that did not answer",
		ko: "응답하지 않은 세션 {count}개의 작업",
	},
	"updates.restartWork.title": { en: "Background work is still running", ko: "백그라운드 작업이 아직 실행 중이에요" },
	"updates.unsupportedArchitecture": {
		en: "This Mac architecture does not have a supported installer.",
		ko: "이 Mac 아키텍처를 지원하는 설치 프로그램이 없어요.",
	},
} satisfies Record<string, Record<UiLanguage, string>>;

export type MainTextKey = keyof typeof MAIN_TEXT;
