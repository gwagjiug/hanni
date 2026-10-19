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
- 글의 핵심 주제와 분명히 맞는 기존 카테고리를 선택하고, 없으면 새 카테고리를 제안해요.
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

기존 카테고리에는 항목만 추가하며 README 전체를 재정렬하지 않아요. 새 카테고리는 README 마지막에 독립된 `##` 섹션으로 추가합니다. 이름 전체가 일치해야 같은 카테고리로 취급하므로 `AI`와 `AI & Engineering`은 서로 다른 분류예요. 같은 slug가 이미 있으면 canonical URL의 짧은 hash를 덧붙입니다.

모델은 카테고리 이름을 고르기 전에 제목과 Pin의 핵심 주제와 분류 이유를 먼저 판단하도록 지시해요. 기존 목록은 재사용 후보이지 선택 범위를 제한하는 목록이 아닙니다. 단어가 겹치거나 부수적으로 언급됐다는 이유만으로 기존 분류에 넣지 않으며, 주제와 직접 맞는 분류가 없거나 연관성이 약하면 글 한 편만으로도 새 카테고리를 제안해요. 같은 의미의 기존 분류가 있다면 이름만 바꾼 새 분류를 만들지 않습니다.

새로 제안하는 카테고리 이름은 제목과 Pin의 언어에 관계없이 영어로 작성해요. 기존 카테고리를 재사용할 때는 이름을 번역하거나 바꾸지 않고 그대로 사용합니다. 분류 이유와 PR 제목·본문은 한국어로 작성합니다.

글의 형식이나 출처가 아니라 주제를 분류합니다. 예를 들어 삶과 건강에 관한 수필은 글이라는 이유로 `writing`에 넣지 않고, 글쓰기 자체가 주제일 때만 해당 분류를 사용해요. 서버 캐싱을 `Frontend Architecture`에 넣거나 AI를 잠깐 언급한 글을 AI 분류에 넣지 않도록 기준을 명시합니다.

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

| 행동 | 결과                                                                   |
| ---- | ---------------------------------------------------------------------- |
| 수정 | 변경안을 고친 뒤 다시 검증해요. 모델은 재호출하지 않습니다.            |
| 승인 | 승인을 저장하고 최신 `archive/main`을 재검사한 뒤 Draft PR을 만듭니다. |
| 취소 | 실행을 끝내고 GitHub에는 아무것도 만들지 않습니다.                     |

승인하지 않은 실행은 24시간 뒤 만료됩니다.

분석 중에는 같은 Discord 응답을 현재 작업에 맞게 갱신해요. `/hanni-status`에서는 현재 작업, 마지막 진행 시각, 재시도 횟수와 Cloudflare Workflow 상태를 확인할 수 있습니다.

### Durable PR publication

승인 응답을 보내기 전에 D1 트랜잭션으로 승인한 초안의 정확한 JSON·SHA-256,
승인자·시각, 대상 저장소·기준 브랜치와 발행 의도를 저장하고 실행을
`CREATING_PR`로 전환합니다. 승인 이후에는 초안을 수정하거나 취소할 수 없어요.
HTTP 요청의 `waitUntil`은 Workflow 실행 요청만 담당하며 GitHub 쓰기를 직접 실행하지 않습니다.

PR 발행은 별도 `ArchivePublicationWorkflow`가 실행합니다.

- Workflow ID는 실행 ID, 브랜치는 `hanni/archive-<전체 실행 ID>`로 고정합니다.
- 처음 파일을 준비할 때 최신 archive를 재검증하고 변경 내용을 저장합니다.
  이후 복구에서는 그 내용을 재사용하며 승인한 Pin과 대상 저장소를 바꾸지 않아요.
- commit SHA를 먼저 D1에 저장한 뒤 브랜치를 게시합니다.
  같은 이름의 브랜치가 다른 SHA를 가리키면 덮어쓰거나 삭제하지 않고 중단합니다.
- 기존 PR은 닫혔거나 ready 상태로 바뀐 경우까지 조회합니다.
  승인된 대상·브랜치·commit과 일치하면 재사용하고, 모호하거나 충돌하면 새 PR을 만들지 않아요.
- PR URL을 먼저 저장한 다음 실행 완료를 기록합니다.
  GitHub 응답 유실이나 완료 기록 실패를 PR 미생성으로 단정하지 않습니다.

발행 결과는 승인 여부와 별개로 `archive_publications.outcome`에 기록해요.

| 결과        | 의미                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| `requested` | 승인을 저장했으며 GitHub 쓰기 시도 전입니다.                                            |
| `attempted` | 쓰기 시도 구간에 진입했지만 원격 실행이나 성공을 증명하지 않습니다.                     |
| `unknown`   | API 또는 저장소 오류로 결과 확인·복구가 필요합니다. 이미 PR URL을 관측했을 수도 있어요. |
| `succeeded` | PR URL과 실행 완료를 저장했습니다.                                                      |
| `failed`    | 승인 불일치나 브랜치·PR 충돌 등 자동 진행을 중단해야 하는 확정 오류입니다.              |

5분 cron이 미발송 의도와 오류로 끝난 Workflow를 다시 실행합니다.
정상 실행 중인 인스턴스는 중복 시작하지 않고, 조회한 상태가 `paused` 또는
`terminated`인 동안에는 강제로 다시 켜지 않아요. Workflow 인스턴스 중지는 승인
취소가 아니므로, Cloudflare 보관 기간이 끝나 인스턴스 기록이 사라지면 남아 있는
발행 의도에서 다시 실행될 수 있습니다. 수동 복구 시 `RUN_ID`를
`/hanni-status`의 실행 ID로 바꿔주세요.

```bash
# 일시중지한 인스턴스 재개
npx wrangler workflows instances resume hanni-archive-publication RUN_ID
# 종료한 인스턴스 또는 오류 인스턴스를 D1 체크포인트에서 다시 실행
npx wrangler workflows instances restart hanni-archive-publication RUN_ID
```

`unknown`에서는 복구에 필요한 승인 초안과 준비한 파일 본문을 D1에 유지합니다.
성공 또는 확정 실패 시에는 본문을 지우고 승인·대상·commit·PR URL 등 메타데이터만 남겨요.
새 PR 발행 Workflow의 단계 출력에는 Pin이나 파일 본문을 저장하지 않습니다.
Discord 완료 알림은 best effort이며 실패해도 이미 저장한 PR 성공을 뒤집지 않아요.
관측한 PR URL은 `/hanni-status`에서도 확인할 수 있습니다.

이 구조는 외부 API의 exactly-once 실행이나 장애 이후의 무조건 성공을 보장하지 않습니다.
특히 외부 사용자의 동시 force-push와 PR 생성은 하나의 원자적 작업으로 묶을 수 없어요.
승인과 외부 작업 결과를 구분하는 원칙은
[oh-my-hermes의 external effect receipts](https://github.com/rlaope/oh-my-hermes/blob/365b37af6a842a3f33bb52f6c8f3abcd9ea0e992/src/workflows/external_effect_receipts.py)를 참고했습니다.

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
- PR 파일을 처음 준비할 때 최신 `archive/main`을 다시 읽습니다.
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
Cloudflare Analysis Workflow
        └── Web metadata / GitHub read / Model / Discord preview
        ↓
Approval transaction (D1 snapshot + publication intent)
        ↓
Cloudflare Publication Workflow ← Cron recovery
        ├── Archive revalidation & commit checkpoint
        ├── GitHub branch / Draft PR reconciliation
        └── Result persistence / Discord notification
        ↓
Cloudflare D1 / Cost metrics & OpenTelemetry
```

Hanni는 자유형 ReAct loop 대신 명시적인 상태 전이를 사용해요. 분석과 PR 발행은 별도 Cloudflare Workflow의 개별 단계로 실행하므로 Worker 요청이 끝난 뒤에도 상태를 보존합니다. 자연어 판단이 필요한 카테고리와 PR 문구만 모델에 맡기고 URL 검증, Markdown 생성, 권한, 승인, GitHub 쓰기는 코드가 처리해요.

```text
RECEIVED
→ VALIDATING
→ ANALYZING
→ AWAITING_APPROVAL
→ CREATING_PR
→ COMPLETED
```

모델 출력은 JSON Schema와 Zod로 검증하고, JSON 또는 schema가 잘못된 경우에만
애플리케이션 안에서 한 번 재시도해요. 모델 단계의 Workflow 자동 재시도는
사용하지 않아 중첩 호출을 막습니다. 불완전 응답과 refusal은 반복하지 않고
실패 원인을 구분하며, 성공 여부와 관계없이 API가 반환한 token 사용량과 예상
비용을 D1에 기록합니다.

### Repository layout

```text
src/
├── agent/          # 상태 전이와 실제 실행 circuit breaker
├── discord/        # command, modal, component handler
├── evals/          # AX 평가
├── policies/       # URL, scope, 권한
├── skills/         # archive-url workflow
├── storage/        # D1 실행 상태와 승인·발행 기록
├── telemetry/      # Cloudflare custom span과 attribute redaction
├── tools/          # Discord, GitHub, OpenAI, Web
├── workflows/      # durable 분석·PR 발행 단계와 복구 dispatch
└── index.ts        # Discord Interaction entrypoint
```

## Observability

OpenAI 응답의 input, cached input, output token을 바탕으로 실행 비용을 추정해요. `/hanni-cost`에서는 이번 달 실행 수, 성공과 실패, token 합계, 예상 비용, 가장 큰 실행 비용을 확인할 수 있습니다.

D1에는 큰 실행 상태와 함께 `current_step`, `last_heartbeat_at`, `retry_count`, `workflow_instance_id`를 저장해요. 5분 동안 heartbeat가 없는 분석 실행은 cron이 `FAILED_TIMEOUT`으로 종료합니다. 단계별 구조화 로그와 Worker invocation log는 Cloudflare Workers Logs에서 확인할 수 있어요.

`/hanni-status`는 승인 전에는 분석 Workflow, 승인 후에는 PR 발행 Workflow의 상태를
표시합니다. 발행 Workflow가 `errored`여도 결과가 불확실하면 실행은 `CREATING_PR`와
복구 대기 상태를 유지하며 최근 오류와 이미 관측한 PR URL을 보여줘요.

```bash
npx wrangler tail hanni
npx wrangler workflows instances describe hanni-archive-analysis latest
npx wrangler workflows instances describe hanni-archive-publication latest
```

Cloudflare Workers tracing은 Worker와 Workflow 실행, 외부 `fetch`, D1 호출을
자동으로 계측해 Cloudflare Dashboard에 저장해요. Hanni는 다음 외부 작업에
업무 이름을 붙인 custom span도 남깁니다.

- `github.read_archive`
- `web.fetch_metadata`
- `llm.prepare_entry`
- `github.revalidate`
- `github.create_archive_commit`
- `github.ensure_archive_branch`
- `github.ensure_archive_draft_pr`

Hanni가 직접 추가하는 custom span에는 실행 ID, 읽기·쓰기 구분, 모델명, Pin
개수처럼 제한된 정보만 기록하며 Pin 원문, prompt, response와 secret은 넣지
않아요.

## Development

타입, lint, format과 테스트를 한 번에 확인하려면 다음 명령을 실행해요.

```bash
npm run validate
```

개별 검사는 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`로 실행할 수 있어요.

### Binding types

`wrangler.jsonc`의 바인딩이나 변수를 바꾼 뒤에는 선언을 직접 수정하지 않고 다시 생성합니다.
secret 필드는 `src/types.ts`에 선언하며 아래 명령은 로컬 secret 파일을 읽지 않아요.

```bash
npx wrangler types src/worker-bindings.d.ts \
  --env-interface CloudflareBindings --include-runtime=false \
  --strict-vars=false --env-file=/dev/null
```
