# Hanni

Discord에서 발견한 글과 문장을 [`gwagjiug/archive`](https://github.com/gwagjiug/archive) Draft PR로 옮겨주는 개인용 AI 에이전트예요.

```text
/hanni url:https://example.com/article pin:첫 번째 문장 pin-2:두 번째 문장
```

URL과 보관할 문장을 입력하면 Hanni가 문서 제목과 카테고리를 확인해 archive 형식에 맞는 변경안을 Discord 스레드에 보여줘요. 내용을 수정하거나 취소할 수 있으며, 승인한 경우에만 Draft PR을 만듭니다.

```text
URL 입력
→ Pin 작성
→ 중복·문서 정보 확인
→ 변경안 미리보기
→ 수정 또는 승인
→ Draft PR
```

## What Hanni does

Hanni는 사용자가 직접 고른 문장을 archive에 보관하는 과정만 맡아요.

- 한 URL에 Pin을 최대 10개까지 받아요.
- 원문의 title과 canonical URL을 확인합니다.
- archive에 같은 URL이나 파일이 있는지 검사합니다.
- 기존 카테고리를 선택하거나 새 카테고리를 제안해요.
- `README.md` 항목과 `pins/<slug>.md` 파일을 만듭니다.
- PR 제목과 본문 초안을 작성합니다.
- Discord 스레드에서 전체 변경안을 보여줘요.
- 제목, 카테고리, slug, Pin, PR 문구를 수정할 수 있습니다.
- 승인한 변경만 `gwagjiug/archive`에 Draft PR로 올립니다.
- 실행별 token 사용량과 예상 비용을 기록해요.

Hanni는 범용 챗봇이 아니에요. 일반 Discord 메시지는 읽지 않고 `/hanni`, `/hanni-cost`, `/hanni-status` 명령만 처리합니다. 글을 요약하거나 Pin을 대신 고르지 않으며, PR merge와 `main` 직접 push 기능도 없어요.

## Archive output

Hanni는 archive의 기존 형식을 그대로 따릅니다.

`README.md`:

```md
## AI & Engineering

- [문서 제목](https://example.com/article) ([pins](pins/article.md))
```

`pins/article.md`:

```md
# 문서 제목

[원문](https://example.com/article)

## Pins

> 다시 꺼내 보고 싶은 문장
```

기존 카테고리에는 항목만 추가하며 README 전체를 재정렬하지 않아요. 같은 slug가 이미 있으면 canonical URL의 짧은 hash를 덧붙입니다.

## Discord workflow

`/hanni` 명령에서 URL을 입력하고 `Tab`을 누르면 첫 번째 Pin 입력란으로 이동해요. Pin을 더 남기고 싶다면 `pin-2`부터 `pin-10`까지 선택해서 추가할 수 있습니다.

```text
첫 번째 Pin

두 번째 Pin
```

분석을 마치면 전용 스레드에 다음 내용을 표시합니다.

- 문서 제목과 URL
- 선택한 카테고리
- 생성할 Pin 파일 경로
- README 변경 내용
- Pin 파일 내용
- PR 제목과 본문
- 사용 모델과 token 사용량
- 예상 실행 비용

스레드에서는 세 가지 행동을 선택할 수 있어요.

| 행동 | 결과                                                        |
| ---- | ----------------------------------------------------------- |
| 수정 | 변경안을 고친 뒤 다시 검증해요. 모델은 재호출하지 않습니다. |
| 승인 | 최신 `archive/main`을 재검사한 뒤 Draft PR을 만듭니다.      |
| 취소 | 실행을 끝내고 GitHub에는 아무것도 만들지 않습니다.          |

승인하지 않은 실행은 24시간 뒤 만료됩니다.

분석 중에는 같은 Discord 응답을 현재 작업에 맞게 갱신해요. `/hanni-status`에서는 현재 작업, 마지막 진행 시각, 재시도 횟수와 Cloudflare Workflow 상태를 확인할 수 있습니다.

## Safety

Hanni의 행동 범위는 프롬프트만으로 제한하지 않아요.

- Discord 요청의 Ed25519 서명을 검증합니다.
- 허용한 서버, 채널, 사용자만 실행할 수 있어요.
- 일반 메시지를 받는 Gateway와 Message Content Intent는 사용하지 않습니다.
- `http`와 `https` 공개 URL만 허용해요.
- localhost, private IP, link-local 주소와 metadata endpoint를 차단합니다.
- Pin과 웹 metadata는 명령이 아닌 데이터로 취급해요.
- 모델에 GitHub Tool과 자격 증명을 제공하지 않습니다.
- GitHub에 쓰기 전 반드시 사용자 승인을 확인해요.
- 승인 시점에 최신 `archive/main`을 다시 읽습니다.
- 중복 클릭과 동일 URL의 동시 실행을 차단해요.

GitHub App은 `gwagjiug/archive` 한 저장소에만 설치하며 다음 권한만 사용합니다.

- Metadata: read
- Contents: read/write
- Pull requests: read/write

Actions, Secrets, Administration, Issues, Workflows 권한과 merge 기능은 사용하지 않아요.

## Architecture

```text
Discord HTTP Interaction
        ↓
Scope & Permission Policy
        ↓
Cloudflare Workflow
        └── archive-url skill
              ├── Web metadata
              ├── GitHub read
              ├── Structured model output
              ├── Discord preview
              └── GitHub Draft PR
        ↓
Cloudflare D1
        ↓
Cost metrics & OpenTelemetry
```

Hanni는 자유형 ReAct loop 대신 명시적인 상태 전이를 사용해요. 분석은 Cloudflare Workflow의 개별 단계로 실행하므로 Worker 요청이 끝난 뒤에도 상태를 보존하고, 실패한 외부 조회는 정해진 범위에서만 재시도합니다. 자연어 판단이 필요한 카테고리와 PR 문구만 모델에 맡기고 URL 검증, Markdown 생성, 권한, 승인, GitHub 쓰기는 코드가 처리해요.

```text
RECEIVED
→ VALIDATING
→ ANALYZING
→ AWAITING_APPROVAL
→ CREATING_PR
→ COMPLETED
```

모델 출력은 JSON Schema와 Zod로 검증하고, 구조화 출력이 잘못된 경우에만 한 번 재시도해요. 실행 상태와 승인 대기 데이터, token 사용량과 예상 비용은 D1에 저장합니다.

### Repository layout

```text
src/
├── agent/          # 상태 전이와 실제 실행 circuit breaker
├── discord/        # command, modal, component handler
├── evals/          # AX 평가
├── policies/       # URL, scope, 권한
├── skills/         # archive-url workflow
├── storage/        # D1 run store
├── telemetry/      # OTLP trace와 redaction
├── tools/          # Discord, GitHub, OpenAI, Web
├── workflows/      # durable archive 분석 단계
└── index.ts        # Discord Interaction entrypoint
```

## Observability

OpenAI 응답의 input, cached input, output token을 바탕으로 실행 비용을 추정해요. `/hanni-cost`에서는 이번 달 실행 수, 성공과 실패, token 합계, 예상 비용, 가장 큰 실행 비용을 확인할 수 있습니다.

D1에는 큰 실행 상태와 함께 `current_step`, `last_heartbeat_at`, `retry_count`, `workflow_instance_id`를 저장해요. 5분 동안 heartbeat가 없는 분석 실행은 cron이 `FAILED_TIMEOUT`으로 종료합니다. 단계별 구조화 로그와 Worker invocation log는 Cloudflare Workers Logs에서 확인할 수 있어요.

```bash
npx wrangler tail hanni
npx wrangler workflows instances describe hanni-archive-analysis latest
```

OpenTelemetry는 다음 외부 작업을 계측해요.

- `github.read_archive`
- `web.fetch_metadata`
- `llm.prepare_entry`
- `github.revalidate`
- `github.create_archive_draft_pr`

Pin 원문, 전체 URL, Discord 메시지, prompt, response와 secret은 trace attribute에 남기지 않아요. OTLP endpoint를 설정하지 않으면 D1의 상태와 비용 집계만 사용합니다.

## Development

타입, lint, format과 테스트를 한 번에 확인하려면 다음 명령을 실행해요.

```bash
npm run validate
```

개별 검사는 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`로 실행할 수 있어요.
