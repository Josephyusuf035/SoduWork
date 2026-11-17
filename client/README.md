# SoduWork desktop client

[简体中文](README.zh-CN.md) · **English** · [Developer guide](../docs/development.en.md#desktop-client)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

The desktop uses Electron and native HTML/CSS/JavaScript. The React management UI is a separate application.

## Source map

| Location | Responsibility |
| --- | --- |
| `main.js`, `main/` | Application lifecycle, native windows, device identity, updates, files, and execution runtimes; overlay lifecycle is in `main/desktop-overlay.cjs` |
| `preload.js` | Restricted renderer IPC; no general Node access for pages |
| `desk.html`, `desk-boot.js` | Main workspace loading and startup |
| `index.html` | Transparent pet and shortcut overlay |
| `core/` | State, synchronization, localization, and shared utilities |
| `components/requirements/` | Requirement pool, requirement drawer, dispatch lifecycle, and shared fields |
| Other `components/` directories | Conversations, AI team, and business views; runtime selectors also live under `panels/` |
| `theme/`, `assets/`, `vendor/` | Themes, assets, and licensed renderer dependencies |
| `tests/`, `e2e/` | Unit/contract checks and Electron validation; excluded from product packaging |
| `scripts/`, `build/` | Runtime preparation and native packaging |
| `runner/`, `dist/`, `.runtime/` | Generated Runner, release packages, and runtime resources |

Conversations and task execution share the same session path: `panels-chat` → `conversationSession` → main-process IPC → `agent-runtime` → Pi or Runner. AI team assignments open the corresponding conversation. Requirement drawers expand task traces; legacy detail links resolve the same requirement rather than creating duplicate records.

If a Runner plugin draft check cannot read its files, the conversation reports the failure and stops showing active execution. Existing files remain available and dependent queued work waits for an explicit resume. A failed final check does not replay the completed model request. Cancelling or changing permissions during the check retains the user's new control state.

When the requirement creator and executor are the same person, execution continues in the original conversation. An explicitly selected runtime or model is applied through the normal native selection transaction while retaining the conversation ID and history. Acceptance also reuses the original execution conversation. These rules apply to Pi and every other runtime; only an authoritative missing-archive result permits a new conversation. Temporary read failures, denied access, and unconfirmed runtime switches preserve the original conversation and stop submission.

The desktop rail opens the requirement pool directly. The old task board, detail chat box, and separate AI workstation conversation are retired. The [release scope](../docs/release-scope.en.md) describes the shared structure, assignment rules, and compatibility boundaries.

HTML script order defines dependencies. When splitting scripts, verify resource references, shared state, loading order, and actual Electron behavior.

Desktop Markdown keeps single tildes literal, so ranges such as `3~5` and `7~14` in one paragraph retain their separators. Use `~~text~~` for strikethrough. The shared `core/markdown.js` configuration applies to conversation history, streamed replies, read-aloud text extraction and Markdown previews; saved source text is unchanged.

Conversation automation drafts accept relative delays such as `五分钟后` (in five minutes). The execution instant is anchored to the message submission time and retained when later messages only refine the work. Missing, invalid or ambiguous times require clarification instead of defaulting to daily 18:00. Incomplete task descriptions remain drafts. Users can cancel creation, continue refining the same card, or return to ordinary chat. After creation, explicit edit requests prepare changes for confirmation and update the original schedule ID; cancelling an edit keeps the saved configuration. Disabling stops future automatic runs, while closing the card only dismisses its view. Run `node e2e/automation-sheet-layout.cjs /absolute/evidence/directory` for isolated Electron form and conversation-routing checks using synthetic parser and schedule APIs.

Unconfirmed drafts support repeated time changes. Explicit time-only messages using `后`, `之后`, `以后` or `过后`, such as `修改为10分钟以后`, update the same draft locally, even when model extraction is unavailable. Each delay uses that message's submission time, captured before asynchronous access checks, and synchronizes scheduling annotations in the title, instructions and acceptance criteria without changing unrelated business durations. Restoring the card retains the latest instant; nothing is created until confirmation.

Local draft extraction honors the model's detected output-token parameter. Provider failures retain a safe HTTP status with separate guidance for credentials, access, endpoint/model selection, incompatible parameters, throttling and service outages; raw provider responses remain private and calls are not automatically retried. Failed refinements retain this diagnostic and the original draft. Runner readiness only checks execution prerequisites and does not confirm successful model extraction.

Native history and downloaded conversation replicas retain their account and Hub boundaries when listed, read, restored, or changed, including offline use. Unknown-owner archives require explicit import as separate read-only copies. Cached content does not grant permission to execute a requirement or cloud conversation; resolving a verified native source must preserve its original runtime, model, and permissions.

Work-form conversations show their saved runtime selection in the sidebar before execution, labelled “Selected runtime”. Selection changes and reopening preserve this icon independently of actual execution provenance. Legacy drafts without a saved selection do not infer it from their archive format. Run `node e2e/workspace-runtime-label.cjs /absolute/evidence/directory` to check draft updates, history restoration and narrow sidebar layouts in isolated Electron.

Remote notice history and receipt markers use account-scoped IndexedDB transactions and Web Locks when both browser capabilities are available. Local reminders remain in the existing localStorage cache. Migration retires a legacy snapshot only after a successful durable commit, and a failed write preserves that snapshot for retry. Environments without these capabilities keep the existing cache behavior.

The requirement delivery section can export one acceptance summary as Markdown through the native save dialog. Export requires execution-record access and an existing fixed delivery version. It reads one consistent snapshot, separates current requirement text from recorded acceptance criteria, and leaves missing validation or runtime attribution explicitly unrecorded. Exporting does not approve or change the requirement.

The same section has a collapsed dispatch-instructions history. New desktop dispatches retain the explicitly entered supplementary note and selected/effective submission policy for each admitted conversation turn, including failed attempts. Native, Runner and workflow execution share this receipt path. Retrying the same turn cannot replace its note; later turns retain separate records. Only existing execution viewers can read this history. Old clients and historical entries without an explicit snapshot show missing fields as unrecorded; chat text, truncated legacy context and current routing are never used to reconstruct them.

Conversation analysis and automatic acceptance include the saved requirement, dispatch supplements and review rejection notes. Conflicting business requirements follow the latest recorded time; unrelated requirements remain effective. Unknown or identical timestamps require explicit clarification rather than an invented priority. Generated drafts retain the original timestamps when resent. New reviewer notes are carried separately, and changed history invalidates a prepared review. The fixed delivery version, criterion identifiers and approval permissions remain authoritative. Client and Hub must both be updated to load this history; older services explicitly report missing history. Oversized history is rejected rather than silently truncated.

## Run and verify

Ordinary new chats use a fresh private working directory; the previous chat's
directory and the recent folder picker location are not inherited. Explicitly
selected project folders remain shared. Personal memory excludes automatic
runtime identity and knowledge-cutoff summaries and filters such historical
claims from injected local context. My Memory shows rendered Markdown by default,
with source editing available under Edit Markdown. Existing conversations retain
their history and working directory.

After successfully sending the first message of a new local chat or goal in an
explicitly selected working or project directory, the desktop remembers the
runtime and model used together.
Starting another conversation in that directory, or selecting it in a new draft,
restores that pair when both are available. Preferences belong to the current
Hub, account and device. Cloud execution retains its existing selection flow.
Temporary workspaces do not share directory preferences. If a saved runtime or
model is unavailable, select an available combination explicitly; automatic
fallback does not replace the saved pair. Changes to an unsent draft do not
replace the last-used selection. Codex account sessions without a verified model
selection do not save a directory preference.

For a first local session, run `sh start.sh --desktop` from the repository root. For independent development, keep Hub running and execute:

```sh
cd client
npm ci
npm start
```

Use Node.js 22.19+. A separately started client retains its own profile and Hub connection settings. See the [developer guide](../docs/development.en.md) for service addresses and profile isolation.

The root source launcher prepares both Hub and Runner dependencies in its private `venv/` and explicitly binds the generated desktop to that Python interpreter. Independent `npm start` development uses `../hub-backend/.venv` with `requirements-runner.txt` installed. Both paths execute the current backend source; do not substitute a Runner copied from an old release.

Run `npm test` for unit/contract tests and `npm run check:layout` for source boundaries. Inspect the requirements of each `e2e/` script before using it. Fixture success does not establish real-model or production acceptance.

On Windows, `npm run test:e2e:user:isolated` runs the desktop user journeys with a fresh Electron profile, registered test account, local Hub and simulated provider. Install `hub-backend/requirements-test.txt` in `hub-backend/.venv`, or set `SODUWORK_TEST_PYTHON` to an interpreter with those dependencies. Results are written to `outputs/isolated-user-journeys/report.json`. Set `SODUWORK_JOURNEY_OUTPUT` to select a different evidence directory. To check workspace recovery alone, use `npm run test:e2e:user:isolated -- --only=UJ-09`, which also runs the task creation and assignment needed for recovery.

On Windows, the execution runtime joins a native Job Object before tools initialize. A private Windows PowerShell helper retains the job until shutdown and verifies its processes have exited, including Git Bash descendants whose intermediate Windows parent has already exited. This is lifecycle cleanup, not a security sandbox; Linux and macOS retain their existing process-tree cleanup.

Changing a Pi conversation from read-only to standard or full access rebuilds its tool selection from the configured defaults while preserving the conversation history. Standard access still requires approval for commands, and changing back to read-only removes write and command tools. Run `node --test tests/access-readonly-upgrade.test.cjs` to verify the production session driver with a loopback provider and real file and command operations.

If the model rejects a plugin draft repair, the conversation and queue retain the safe runtime error instead of replacing it with a generic package-validation error. Existing files and tool results remain available; HTTP 403 does not trigger another automatic repair. Static package diagnostics remain attached to the draft separately.

To verify summary export against a disposable authenticated Hub, run `node e2e/acceptance-summary-export.cjs /absolute/evidence/directory /path/to/test/python`. The Python environment needs the backend test dependencies. This exercises native IPC and saved bytes with injected save-dialog choices, not a real model or production account.

For models without an explicit maximum output budget, the desktop, Hub and Runner use 16384 tokens, further bounded by the configured context window. This fallback is not a detected provider limit. Set **Maximum output tokens** in **My Models**, or **Model Catalog** for organization models, to match the deployed service. Reasoning models may need a larger explicit budget to reach tool calls or a final answer. Keep the real context window separate from the output limit; do not shrink it to work around an output-budget rejection. Capability and connection tests use small requests and do not determine the maximum output limit. Output-limit errors identify the setting to adjust and do not trigger automatic retries.

## Packaging

Before distributing native installers, complete the outstanding [distribution materials](../third-party/README.md) and platform acceptance.

On Windows, install `../hub-backend/requirements-runner-build.txt` in the backend build environment, then run `npm run build` or `npm run build-portable`. Packaging rebuilds the single-file Runner from `runner_main.py` and `runner.spec`. Do not reuse an old EXE as build input.

Windows packaging freezes source payloads through `scripts/payload-sources.cjs` to handle filesystems that expose different bytes to different processes. Source changes after manifest generation fail the build. Generated `.runtime/installer/payload-sources/` is not versioned. Native installer builds share resources and should run sequentially.

The interactive Windows installer offers English, Simplified Chinese, Japanese and Korean. It defaults to the Windows UI language, with English as the fallback, and lets the user choose before installation. Silent updates do not show the selector. Installer language does not overwrite the desktop's saved interface language. macOS and Linux retain their platform installation interfaces.

Windows uninstall retains local application data by default. The interactive wizard can optionally remove the current Windows account's `%APPDATA%\SoduWork` directory after a second confirmation. It displays the exact directory before deletion and refuses linked directories. External workspaces, other Windows accounts, Hub service data, and custom `SODUWORK_USER_DATA` locations are outside this cleanup. Silent uninstall and upgrades retain data; the legacy `--delete-app-data` switch is rejected so it cannot bypass confirmation.

Frozen input directories contain at most 64 files to avoid repeated compiler scans. Installation and verification share one extraction function with compression and per-file verification; the verifier documents compatibility exceptions for older installers. Installer fault-injection tests share the build directory and must also run sequentially. Before release, verify the final installer, upgrade, and rollback. Packaging excludes test files and selects only the single-file Runner executable as a Runner resource.

OpenCode is optional and is neither bundled nor downloaded during packaging. There is one lightweight build recipe. Agent identifiers, display metadata, model scope, and permissions come from the shared `../hub-backend/app/agent_catalog.json`, copied into release resources. Avoid a second renderer-owned catalog.

Agent management still detects installed OpenCode and offers explicit installation. `build-light` is retired; the normal build uses the lightweight recipe.

Organization-managed model services are read-only in My Models. Their addresses, credentials, models and capability checks are maintained through the Hub administration UI. Only personal services and device-owned services can be edited or tested from the client. Deploy both Hub and client changes for this boundary. Legacy personal overrides attached to an organization service remain stored but no longer affect its address, credentials or model catalog; organization models use the existing platform quota rules. To use personal credentials, explicitly add a separate personal service.

Device-owned models can be paired with any local managed runtime, including Pi, Qwen, OpenCode, DeepSeek Harness, Kimi and Codex Harness. The Codex account runtime keeps its own model catalog. Local Agent defaults are encrypted and scoped to the current Hub, device and account; conversations, requirement execution and local automations use these selections. New conversations, conversation composers, requirement dispatch and automation forms use the first available model when no model is selected or the selected model has been deleted. Local models precede Hub models, and valid selections remain unchanged. Existing conversation history is retained when the next turn switches to the replacement model. Local model calls do not consume Hub model allowance, but normal account and execution permissions still apply.

In Agent management, a managed runtime with no saved model, or with a deleted model, displays and tests the first available model. The list places local models before Hub models, and valid saved choices remain selected. This fallback does not rewrite the encrypted preference. An empty catalog remains unavailable; a failed secure-store read is reported rather than treated as deletion. Run `node e2e/agent-single-model-default.cjs /absolute/evidence/directory` to verify selection, deletion fallback and probe routing with real Electron UI, encrypted storage and private IPC. Hub and Runner responses in this test are synthetic; it does not call real model services.

Unattended local automations resolve the same fallback before opening their conversation, after verifying ownership of any device model mapping. They retain the saved schedule preference and use the replacement only for execution. Deploy both client and Hub changes for schedules whose saved Hub model has been removed: the Hub must allow the owning desktop to resolve that missing selection. Remote targets and account runtimes retain their existing admission rules. An unreadable or incomplete catalog is not evidence of model deletion; offline local access does not authorize replacing an unverified Hub selection.

Cloud conversations, remote dispatch and Hub-controlled workflows do not accept device-owned model references. Local Agent tests execute through the desktop's private Runner pipe and do not publish model configuration or test logs to Hub. Pi can generate images directly with a local OpenAI-compatible image model; output stays in the local workspace and accepts base64 image data or same-origin result URLs. Local video generation is not provided. Legacy automation model mappings without verifiable account ownership are retained in encrypted storage and require explicit model reselection. The local-model admission E2E exercises default selection, deletion, account isolation and quota behavior with real Electron processes and synthetic loopback services.

See [release scope](../docs/release-scope.en.md), [plugin authoring](../docs/plugin-authoring.en.md), and the [H5 SDK](sdk/README.md).

## Voice input

Use the microphone beside the home or conversation composer and select a speech recognition model from My models. If none is available, Configure in My models opens that page. Add a local model with purpose Speech recognition under an existing or new OpenAI-compatible service, then save. The service URL and API key are reused; chat models are not assumed to support transcription. Organization-managed transcription is not supported yet.

Start recording requests microphone access. Only Stop and transcribe uploads audio to the displayed endpoint. Recordings stay in memory, with a two-minute and 20 MB limit. Review and edit the transcript, then Insert into draft; existing text is preserved and messages are never sent automatically. Cancel, close or switch conversations to release the microphone and discard pending insertion.

Credentials remain in the existing My models secure store; voice input does not keep a separate copy. Requests resolve the latest saved model and credentials, so removed models cannot be used. The service must accept the recorded audio format at `/audio/transcriptions` using multipart requests and JSON responses. Remote services require HTTPS; localhost HTTP is supported. Provider charges may apply.

Official DeepSeek services configured in My models automatically supply speech recognition using the same API key, without adding a speech model. Multiple chat models under a service produce one speech option. A single service is selected automatically; multiple services show a picker. DeepSeek uses `/v1/tools/asr` with automatic language detection; recordings are converted locally to 16kHz mono PCM WAV and limited to 120 seconds and 8 MiB. Other providers still require a compatible transcription model.


Press and hold the microphone (or hold Space/Enter while focused) to record; release to stop and transcribe. Releasing before microphone access is ready cancels capture. Escape, pointer cancellation and window blur cancel without uploading. A persistent status shows preparation and recording progress.

Hold-to-talk inserts recognized text directly into the current editable draft without sending. Recording/transcription errors use an inline notification rather than opening the voice dialog.

<!--
中文开发说明（对应本次修改）：
需求：按住麦克风录音，松开转录并追加当前草稿；复用“我的模型”的地址和凭据，缺配置才引导设置。
实现原因：聊天协议兼容不代表转录兼容，故通用服务使用 audio 用途，官方 DeepSeek 使用独立 ASR 适配，服务内去重。
权限与设备是两个异步阶段；超时、取消和迟到流必须分别处理。音频帧检测只能报告采集异常，不能修复系统 CoreAudio。
白屏恢复只针对未完成的首次导航，有限重试后由原生提示交给用户；不刷新已工作的会话。
package.json 是标准 JSON，不能写入 // 或块注释，否则 npm/构建器解析失败，因此其两项改动在此及 entitlements.mac.plist 说明：
1. build.mac.extendInfo.NSMicrophoneUsageDescription：给发布包的系统授权提示提供真实录音用途，并非自动授予权限。
2. build.mac.entitlements：引用音频输入和 Electron 运行时权限声明；保留 hardenedRuntime，权限仍须用户同意。
源码 .app 的用途说明由 scripts/source-macos-app.cjs 写入，不能依赖发布打包配置自动生效。
English developer notes (covering this change):
Requirement: hold to record, release to transcribe and append to the current draft; reuse My models destinations/credentials and guide setup only when missing.
Rationale: chat compatibility does not imply transcription compatibility. Generic providers need audio purpose; official DeepSeek uses a deduplicated service-level ASR adapter.
Consent and device opening are separate asynchronous stages requiring deadlines, cancellation and late-stream disposal. Frame detection reports failure; it cannot repair system CoreAudio.
Blank-window recovery targets unfinished initial navigation only, with bounded retries and native user recovery; working conversations are not reloaded.
package.json is strict JSON: // and block comments would break npm/build parsing, so its two changes are explained here and in entitlements.mac.plist:
1. build.mac.extendInfo.NSMicrophoneUsageDescription supplies the packaged OS consent purpose, not automatic microphone authorization.
2. build.mac.entitlements references audio-input and Electron runtime permissions, retaining hardenedRuntime and mandatory user consent.
Source bundles receive their purpose text from scripts/source-macos-app.cjs; release packaging settings do not automatically apply to source launch.
-->
