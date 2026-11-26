/**
 * The bot templates' words for the person (`components/bots/bot-templates.ts`): name, line, first chat, example post.
 * Not in the catalogs: only the templates dialog, New bot and the palette show them, all off the phone's first screen.
 */

import type { Lang } from "../lib/i18n";

export type BotTemplateWords = { name: string; line: string; first: string; example: string };
type Words = BotTemplateWords;

const en: Record<string, Words> = {
	"pr-review": {
		name: "Pull request review",
		line: "Reviews pull requests you're asked to review and lists risky changes.",
		first: "Asks which repositories to watch, then reviews the newest one waiting on you.",
		example: "PR #412 changes the retry loop: a failed upload now retries forever (upload.ts:88). Merge after a cap.",
	},
	"bug-investigation": {
		name: "Bug investigation",
		line: "Reproduces a reported bug and finds where it starts.",
		first: "Asks for a bug to start with and how you run the project.",
		example: 'Reproduced: an empty title crashes the export (exporter.ts:41). Fix: default to "Untitled".',
	},
	"dependency-updates": {
		name: "Dependency updates",
		line: "Checks for outdated and vulnerable packages and proposes upgrades.",
		first: "Lists the projects it found and the upgrades that are safe today.",
		example: "3 safe patches, 1 minor to test (vite 6.2), 1 advisory: lodash < 4.17.21. Branches ready on your word.",
	},
	"unreviewed-work": {
		name: "Unreviewed agent work",
		line: "A daily list of finished agent work nobody has looked at yet.",
		first: "Looks at what your agents finished this week and lists what nobody opened.",
		example: '2 sessions finished overnight and nobody looked: "Fix flaky login test", "Docs for /export".',
	},
	"workspace-cleanup": {
		name: "Workspace cleanup",
		line: "Finds finished or abandoned workspaces and offers to remove them.",
		first: "Lists the worktrees and branches that look finished.",
		example: "5 worktrees are merged and clean; 2 were untouched for 3 weeks. Remove them?",
	},
	"security-check": {
		name: "Security check",
		line: "Looks at merged changes for leaked secrets and risky code.",
		first: "Checks last week's merges and says what it found.",
		example: "High: an API key in config/dev.json (merged Tuesday). Rotate it first, then remove it from history.",
	},
	release: {
		name: "Release readiness",
		line: "Tracks what's blocking the next release.",
		first: "Finds the last release and what blocks the next one.",
		example: "Not ready: 1 failing check on main, 2 open PRs marked for 2.4.",
	},
	"release-notes": {
		name: "Release notes",
		line: "Drafts the next release's notes from merged pull requests.",
		first: "Reads the last notes to learn their style, then drafts the next ones.",
		example: "Draft for 2.4: 3 features, 7 fixes, written in your changelog's voice.",
	},
	"ci-failures": {
		name: "CI failures",
		line: "Explains failed checks and keeps a list of flaky ones.",
		first: "Reads the newest failed check and asks how your CI is reached.",
		example: "Flaky: e2e/login timed out, passed on rerun (3rd time this week). Real: unit/cart broke in a1b2c3.",
	},
	"deploy-watch": {
		name: "Deploy watch",
		line: "Posts what changed in each deploy and flags failed ones.",
		first: "Helps set up the webhook your deploy tool calls.",
		example: "Deploy 1.18 is out: 4 PRs, the new checkout page. No errors in the first 10 minutes.",
	},
	support: {
		name: "Support triage",
		line: "Keeps a list of questions nobody has answered.",
		first: "Asks where your questions come in and how it can read them.",
		example: '3 questions wait for an answer, the oldest for 2 days: "How do I reset my workspace?"',
	},
	feedback: {
		name: "Feedback digest",
		line: "Turns feedback into a weekly list of themes.",
		first: "Asks where feedback lands, then reads the last week of it.",
		example: "Top theme this week: search is slow on big projects (9 people, up from 4).",
	},
	"bug-intake": {
		name: "Bug report intake",
		line: "Turns bug reports into tracked issues with repro steps.",
		first: "Asks where bugs are reported and where issues go.",
		example: 'Drafted: "Export fails on empty title" with 3 steps and the log. File it?',
	},
	"issue-triage": {
		name: "GitHub issue triage",
		line: "Labels new issues, finds duplicates and asks for missing details.",
		first: "Asks which repositories to watch, then triages the newest issues.",
		example: "#88 looks like #61 (same stack trace). Proposed labels: bug, export.",
	},
	briefing: {
		name: "Project briefing",
		line: "A weekly brief on the projects you pick.",
		first: "Asks which projects matter, then writes this week's brief.",
		example: "Done: billing v2 merged. Next: the migration. Blocked: waiting on the design review.",
	},
	"docs-upkeep": {
		name: "Docs upkeep",
		line: "Flags docs that no longer match merged code.",
		first: "Reads the docs and the newest merges and lists what drifted.",
		example: "docs/api.md still documents ?limit, removed in #301.",
	},
	"spec-drafts": {
		name: "Spec drafting",
		line: "Turns a discussion into a short spec you can share.",
		first: "Asks for a discussion to start with.",
		example: "Spec drafted: Problem, Goal, Proposal, 3 open questions for you.",
	},
	"backlog-cleanup": {
		name: "Backlog cleanup",
		line: "Finds stale, duplicate and unowned issues.",
		first: "Asks where your backlog lives and reads it.",
		example: "12 issues untouched for 90 days, 3 duplicates, 5 with no owner.",
	},
	"incident-notes": {
		name: "Incident notes",
		line: "Keeps an incident's timeline and drafts the write-up.",
		first: "Explains how to hand it an incident and keeps the timeline from there.",
		example: "14:02 alerts fired · 14:09 rollback started · 14:15 recovered. Write-up drafted.",
	},
	"oncall-handoff": {
		name: "On-call handoff",
		line: "A weekly summary of alerts, incidents and open follow-ups.",
		first: "Asks where alerts and incidents are, then writes this week's handoff.",
		example: "This week: 6 alerts (2 real), 1 incident, 3 follow-ups still open.",
	},
	followup: {
		name: "Replies you owe",
		line: "Reminds you of replies you still owe.",
		first: "Asks which conversations to watch.",
		example: "You owe 2 replies: Dana's question on the roadmap, the vendor's contract email.",
	},
	standup: {
		name: "Daily standup notes",
		line: "What you and your agents did yesterday, and what's next.",
		first: "Reads yesterday's sessions and commits and writes today's notes.",
		example: "Yesterday: merged the export fix. Today: the migration. Blocked: nothing.",
	},
	"email-digest": {
		name: "Email digest",
		line: "Twice a day, the emails that need a reply from you.",
		first: "Helps add your mailbox in Settings › Schedules › Email accounts.",
		example: "4 emails need you; 1 is urgent: the contract signature due today.",
	},
	"meeting-prep": {
		name: "Meeting prep",
		line: "Before each meeting, the issues, pull requests and docs it's about.",
		first: "Helps add your calendar's feed and sets up the prep routine.",
		example: "Design review in 15 minutes: PR #420, the spec draft and 2 open questions.",
	},
};

const ko: Record<string, Words> = {
	"pr-review": {
		name: "풀 리퀘스트 리뷰",
		line: "리뷰를 요청받은 풀 리퀘스트를 읽고 위험한 변경을 정리해요.",
		first: "지켜볼 저장소를 묻고, 기다리는 가장 최근 PR부터 리뷰해요.",
		example:
			"PR #412가 재시도 루프를 바꿔요. 업로드가 실패하면 끝없이 재시도해요(upload.ts:88). 횟수 제한을 넣고 병합하세요.",
	},
	"bug-investigation": {
		name: "버그 조사",
		line: "보고된 버그를 재현하고 어디서 시작되는지 찾아요.",
		first: "처음 볼 버그와 프로젝트 실행 방법을 물어요.",
		example: '재현했어요. 제목이 비면 내보내기가 멈춰요(exporter.ts:41). 기본값 "Untitled"로 고치면 돼요.',
	},
	"dependency-updates": {
		name: "의존성 업데이트",
		line: "오래되거나 취약한 패키지를 찾아 업그레이드를 제안해요.",
		first: "찾은 프로젝트와 오늘 안전하게 올릴 수 있는 것을 정리해요.",
		example:
			"안전한 패치 3개, 테스트할 마이너 1개(vite 6.2), 보안 공지 1건(lodash < 4.17.21). 말씀하시면 브랜치를 만들게요.",
	},
	"unreviewed-work": {
		name: "아무도 안 본 에이전트 작업",
		line: "끝났지만 아무도 보지 않은 에이전트 작업을 매일 정리해요.",
		first: "이번 주에 끝난 에이전트 작업 중 아무도 열지 않은 것을 정리해요.",
		example: '밤사이 끝난 세션 2개를 아무도 안 봤어요. "불안정한 로그인 테스트 수정", "/export 문서".',
	},
	"workspace-cleanup": {
		name: "작업 공간 정리",
		line: "끝났거나 방치된 작업 공간을 찾아 지울지 물어요.",
		first: "끝난 것 같은 워크트리와 브랜치를 정리해요.",
		example: "워크트리 5개는 병합됐고 깨끗해요. 2개는 3주째 그대로예요. 지울까요?",
	},
	"security-check": {
		name: "보안 점검",
		line: "병합된 변경에서 새어 나간 비밀과 위험한 코드를 찾아요.",
		first: "지난주 병합을 점검하고 찾은 것을 알려요.",
		example: "높음: config/dev.json에 API 키가 있어요(화요일 병합). 먼저 키를 바꾸고 기록에서 지우세요.",
	},
	release: {
		name: "릴리스 준비",
		line: "다음 릴리스를 막는 것을 지켜봐요.",
		first: "지난 릴리스를 찾고 다음 릴리스를 막는 것을 정리해요.",
		example: "아직이에요. main의 실패한 검사 1개, 2.4로 표시된 열린 PR 2개가 남았어요.",
	},
	"release-notes": {
		name: "릴리스 노트",
		line: "병합된 풀 리퀘스트로 다음 릴리스 노트 초안을 써요.",
		first: "지난 노트로 문체를 익히고 다음 노트 초안을 써요.",
		example: "2.4 초안: 기능 3개, 수정 7개를 변경 기록의 말투로 썼어요.",
	},
	"ci-failures": {
		name: "CI 실패",
		line: "실패한 검사를 설명하고 불안정한 테스트 목록을 관리해요.",
		first: "가장 최근 실패를 읽고 CI에 어떻게 닿는지 물어요.",
		example:
			"불안정: e2e/login 시간 초과, 재실행에서 통과(이번 주 세 번째). 진짜 실패: unit/cart가 a1b2c3에서 깨졌어요.",
	},
	"deploy-watch": {
		name: "배포 지켜보기",
		line: "배포마다 바뀐 것을 알리고 실패한 배포를 짚어요.",
		first: "배포 도구가 부를 웹훅을 같이 설정해요.",
		example: "1.18 배포 완료: PR 4개, 새 결제 페이지. 처음 10분 동안 오류 없음.",
	},
	support: {
		name: "지원 분류",
		line: "아무도 답하지 않은 질문을 정리해요.",
		first: "질문이 어디로 들어오고 어떻게 읽을 수 있는지 물어요.",
		example: '답을 기다리는 질문이 3개예요. 가장 오래된 건 이틀째예요: "작업 공간을 어떻게 초기화하나요?"',
	},
	feedback: {
		name: "피드백 요약",
		line: "피드백을 주제별로 묶어 매주 정리해요.",
		first: "피드백이 어디에 쌓이는지 묻고 지난주 것을 읽어요.",
		example: "이번 주 가장 큰 주제: 큰 프로젝트에서 검색이 느려요(4명에서 9명으로 늘었어요).",
	},
	"bug-intake": {
		name: "버그 접수",
		line: "버그 제보를 재현 단계가 있는 이슈로 만들어요.",
		first: "버그가 어디로 제보되고 이슈는 어디에 두는지 물어요.",
		example: '초안: "제목이 비면 내보내기 실패", 단계 3개와 로그 포함. 등록할까요?',
	},
	"issue-triage": {
		name: "GitHub 이슈 분류",
		line: "새 이슈에 라벨을 제안하고 중복을 찾고 빠진 정보를 물어요.",
		first: "지켜볼 저장소를 묻고 가장 최근 이슈부터 분류해요.",
		example: "#88은 #61과 같아 보여요(스택이 같아요). 제안 라벨: bug, export.",
	},
	briefing: {
		name: "프로젝트 브리핑",
		line: "고른 프로젝트를 매주 정리해요.",
		first: "어떤 프로젝트가 중요한지 묻고 이번 주 브리핑을 써요.",
		example: "끝남: billing v2 병합. 다음: 마이그레이션. 막힘: 디자인 리뷰 대기.",
	},
	"docs-upkeep": {
		name: "문서 관리",
		line: "병합된 코드와 맞지 않게 된 문서를 짚어요.",
		first: "문서와 최근 병합을 읽고 어긋난 곳을 정리해요.",
		example: "docs/api.md가 #301에서 없어진 ?limit을 아직 설명해요.",
	},
	"spec-drafts": {
		name: "스펙 초안",
		line: "논의를 공유할 수 있는 짧은 스펙으로 만들어요.",
		first: "처음 다룰 논의를 물어요.",
		example: "스펙 초안: 문제, 목표, 제안, 열린 질문 3개.",
	},
	"backlog-cleanup": {
		name: "백로그 정리",
		line: "오래됐거나 중복되거나 담당자가 없는 이슈를 찾아요.",
		first: "백로그가 어디 있는지 묻고 읽어요.",
		example: "90일째 그대로인 이슈 12개, 중복 3개, 담당자 없는 이슈 5개.",
	},
	"incident-notes": {
		name: "장애 기록",
		line: "장애 타임라인을 기록하고 보고서 초안을 써요.",
		first: "장애를 넘기는 방법을 알려 주고 그때부터 타임라인을 써요.",
		example: "14:02 알림 · 14:09 롤백 시작 · 14:15 복구. 보고서 초안을 썼어요.",
	},
	"oncall-handoff": {
		name: "온콜 교대 노트",
		line: "한 주의 알림, 장애, 남은 후속 작업을 정리해요.",
		first: "알림과 장애가 어디 있는지 묻고 이번 주 교대 노트를 써요.",
		example: "이번 주: 알림 6건(진짜 2건), 장애 1건, 남은 후속 작업 3개.",
	},
	followup: {
		name: "답장 챙기기",
		line: "아직 하지 않은 답장을 알려 줘요.",
		first: "지켜볼 대화를 물어요.",
		example: "답장할 게 2개 있어요: 로드맵에 대한 Dana의 질문, 업체의 계약 메일.",
	},
	standup: {
		name: "데일리 스탠드업",
		line: "어제 나와 에이전트들이 한 일과 오늘 할 일을 정리해요.",
		first: "어제의 세션과 커밋을 읽고 오늘 노트를 써요.",
		example: "어제: 내보내기 수정 병합. 오늘: 마이그레이션. 막힘: 없음.",
	},
	"email-digest": {
		name: "메일 요약",
		line: "하루 두 번, 답장이 필요한 메일을 정리해요.",
		first: "설정 › 예약 실행 › 메일 계정에 메일함을 추가하도록 도와요.",
		example: "답장이 필요한 메일 4통, 그중 1통은 급해요: 오늘까지인 계약 서명.",
	},
	"meeting-prep": {
		name: "회의 준비",
		line: "회의마다 관련 이슈, 풀 리퀘스트, 문서를 모아 줘요.",
		first: "캘린더 피드를 추가하고 준비 루틴을 설정하도록 도와요.",
		example: "15분 뒤 디자인 리뷰: PR #420, 스펙 초안, 열린 질문 2개.",
	},
};

const WORDS: Record<Lang, Record<string, Words>> = { en, ko };

/** One template's words in `lang`, English for an id the language lacks. */
export function botTemplateWords(lang: Lang, id: string): Words {
	return WORDS[lang][id] ?? en[id] ?? { name: id, line: "", first: "", example: "" };
}
