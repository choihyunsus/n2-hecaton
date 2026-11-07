# N2 헤카톤

AI 호스트를 위한 도구 검색·라우팅·실행 기록 모듈입니다.

[English](README.md)

헤카톤은 호스트가 등록한 함수와 선택한 MCP 도구를 하나의 검색 가능한 카탈로그로 구성합니다. 실행 전에 요청을 기록하고, 실행 결과와 Soul 호환 경험을 함께 저장합니다. 엄격한 N2R 도구 정의로 기존 기능에 입력 스키마·라우팅 정보·사전 조건을 추가할 수 있습니다.

독립 배포판에는 대붕이의 도구 카탈로그, 분류, 라우팅, 실행 검증, 회로 차단기, MCP 가져오기 기능이 포함됩니다. 파일 작업, 명령 실행, 브라우저, 사용자 응답 등 앱별 기능은 호스트 어댑터로 연결합니다. 운영체제 권한과 프로세스 격리도 호스트가 관리합니다.

## 설치

Node.js 22 이상이 필요합니다. SQLite는 `better-sqlite3` 또는 호환되는 Mimir Rust 바인딩을 사용합니다. 환경에 맞는 SQLite 사전 빌드가 없으면 네이티브 빌드 도구가 필요할 수 있습니다.

```sh
npm install https://github.com/choihyunsus/n2-hecaton/releases/download/v1.0.1/n2-hecaton-1.0.1.tgz
```

이 패키지와 버전을 고정한 N2 의존성은 GitHub Releases로 제공합니다. 정확한 의존성 구성은 소스 저장소의 잠금 파일에 기록되어 있습니다.

## 도구 등록과 실행

```js
import { Hecaton } from 'n2-hecaton';

const engine = new Hecaton({
  dbPath: './data/mimir.db', project: 'example', agent: 'worker',
  tools: [{
    name: 'echo', version: '1', description: '입력한 문장을 반환합니다', readOnly: true,
    inputSchema: {
      type: 'object', properties: { text: { type: 'string', maxLength: 1000 } },
      required: ['text'], additionalProperties: false,
    },
    execute: (args, context) => ({ success: true, output: args.text }),
  }],
});

try {
  const receipt = await engine.execute({
    requestId: 'echo-001', sessionId: 'session-001',
    tool: 'echo', arguments: { text: '안녕하세요' },
  });
  console.log(receipt.result, receipt.cached, receipt.experienceId);
} finally {
  await engine.close();
}
```

콜백은 고정된 프로젝트·에이전트·요청·세션 식별자와 `AbortSignal`을 받습니다. 반환값에는 `success`, `output`, 선택적인 JSON `data`와 `modifiedFiles`가 들어갑니다. 클래스 메서드의 원래 인스턴스를 유지하며 메타데이터와 입력 JSON은 실행 전에 복사합니다.

확인된 실행 실패는 `success: false`로 반환합니다. 예외·잘못된 출력·시간 초과가 발생하면 외부 작업이 이미 실행됐을 수 있으므로 결과를 불확실 상태로 기록합니다. 미완료 요청을 반복해도 안전한 도구에만 `idempotent: true`를 지정합니다. 읽기 전용 도구의 기본 멱등성 값은 참이며 파일 변경을 보고하면 거부됩니다.

선택적인 `policy.authorize(request)`가 실행 및 기존 결과 조회를 승인합니다. 취소 신호는 `request.context.signal`로 전달합니다. 기본 정책은 등록된 도구를 허용합니다. 인증 정보와 권한 판단은 호스트 콜백 안에서 관리하고, 동작이 바뀌면 도구·정책 버전도 변경해야 합니다.

## 도구 찾기와 구미호 연결

`list()`로 실행 가능한 도구를 조회하고 `route(query, limit)`로 후보를 찾습니다. 정확한 도구 이름, 등록된 별칭, 10개 영역 분류, 짧은 DNA 표현과 BM25 점수를 사용합니다. 한글 별칭도 지원하며 빈 검색어나 일치하지 않는 검색어는 빈 후보 목록을 반환합니다.

`auto({ requestId, query, arguments })`는 첫 후보를 일반 실행 경로로 실행합니다. 입력을 받을 때 선택한 도구의 스키마를 사용하세요. `asGumihoTools(names)`는 선택한 최대 64개 도구를 공개된 구미호 실행기에 연결합니다. 두 엔진의 프로젝트·에이전트가 같아야 하며 정의를 변경한 뒤에는 도구 선택을 다시 생성합니다.

라우팅 결과에는 직렬화된 바이트 수와 4바이트당 1토큰으로 계산한 추정치가 포함됩니다. 실제 토큰 수와 작업 품질은 연결한 모델·호스트에 따라 달라집니다.

## N2R 도구 정의

```n2
@meta {
  name: "echo_checked"
  handler: "native:echo"
  enforce: strict
  read_only: true
  triggers: ["메아리"]
}
@contract Required {
  scope: request
  precondition { params.text != "" => "text is required" }
}
```

```js
const saved = engine.installSource(source);
const updated = engine.installSource(updatedSource, saved.contentHash);
engine.removeDefinition(updated.name, updated.contentHash);
```

Clotho 4.1.0으로 소스를 해석하고 헤카톤이 지원하는 실행 구문을 적용합니다. `enforce: strict`가 필수이며, 정의 하나는 기존 `native:name` 호스트 기능 또는 가져온 `mcp:서버|인코딩된원격이름` 하나와 연결됩니다. 변경은 이전 내용 해시를 확인한 뒤 원자적으로 저장합니다. 연결할 기능이 없어도 저장된 정의와 진단을 `definitions()`·`problems()`로 확인할 수 있습니다.

지원 범위는 상속한 입력 스키마, 매개변수 설명이 있는 단일 타입 스키마, JSON 입력 스키마, 빈 값 사전 조건, `params.field !~ /pattern/igm`, 차단 패턴, 시간 제한과 `$RESULT` 출력을 가진 단일 실행 단계입니다. 정의의 입력 조건과 연결된 도구의 조건을 함께 검사합니다. 지원 범위를 벗어난 액션·상태 전이·복구 구문·출력 변환·다단계 실행은 등록 때 거부합니다.

Rust 유니코드 정규식은 패턴 4 KiB와 제한된 오토마타 크기를 사용합니다. 입력 스키마는 동기식 draft-07 JSON Schema, 순환 없는 로컬 참조, RE2JS 패턴을 사용합니다. 순환·외부 참조·비동기 검사와 지원하지 않는 정규식은 명시적으로 실패합니다. 읽기 전용·멱등 권한은 실제 호스트 기능의 선언을 따릅니다.

## MCP 도구 가져오기

호스트 어댑터의 `mcpServers`에 서버를 등록합니다. stdio는 실행 파일·인자·환경을 고정하고 `shell: false`로 시작합니다. HTTP는 HTTPS 또는 주소가 명시된 루프백 HTTP를 사용하며 헤더를 고정하고 리다이렉트를 차단합니다. 주소·계정·동작이 바뀌면 설정 버전을 변경합니다.

```js
const analysis = await engine.discoverMcp('local');
const imported = await engine.importMcp({ serverId: 'local', names: ['echo'] });
const receipt = await engine.execute({
  requestId: 'remote-001', tool: imported.installed[0].name,
  arguments: { text: '안녕하세요' },
});
```

영문 안내의 전체 설정 예시와 `examples/mcp-host.cjs`를 참고하세요. 탐색 → 스키마 분석 → 소스 생성 → 일괄 등록 → 등록 확인 순서로 진행합니다. 가져오기 결과의 `executionVerified`는 `false`이며, 실제 실행 성공은 별도로 호출해 확인해야 합니다.

실행 전 원격 도구 메타데이터와 서버 정보가 저장한 정의와 일치하는지 확인합니다. 변경된 도구는 검토 후 이전 해시를 지정해 다시 가져옵니다. 주소·환경·인증 정보는 가져온 정의에 저장하지 않습니다. 원격 서버의 읽기 전용·멱등성 표시는 참고 정보이며, 실제 권한은 호스트의 `toolPermissions`로 부여합니다. 원격 인자의 프로젝트·에이전트 권한은 어댑터 또는 원격 서비스가 처리합니다.

연결은 필요할 때 생성해 재사용합니다. 서버당 작업 1개, 전체 작업 2개를 동시에 실행합니다. 도구 호출 POST는 내부에서 자동 재전송하지 않습니다. SSE GET 재연결은 제한된 횟수로 기존 응답을 복구합니다. 잘못된 UTF-8·과도한 트래픽·프레임 한도 초과는 해당 연결을 종료합니다. 원본 MCP 결과는 결과 크기 한도 안에서 `result.data.mcp`에 보존합니다.

호스트가 샌드박스와 원격 서버 신뢰를 관리합니다. 종료할 때 헤카톤이 직접 실행한 MCP 프로세스의 종료를 기다립니다. 외부 서버가 추가로 실행한 자식 프로세스는 해당 서버·호스트가 관리해야 합니다. 취소를 무시하는 콜백의 실행을 강제로 제한하려면 호스트의 프로세스 격리가 필요합니다.

## 복구와 공통 DB

실행 상태는 `prepared`, `pending`, `completed`, `unknown`, `blocked`입니다. 정책 검사 전에 준비 기록을 남기고, 콜백 호출 전에 `pending`을 확정합니다. 완료된 동일 요청은 저장된 결과를 반환합니다. 같은 식별자에 다른 인자·버전을 사용하면 거부합니다.

`status(requestId)`로 현재 실행 소유자와 복구 필요 여부를 확인합니다. 멱등성이 없는 작업의 결과가 불확실하면 외부 상태를 확인한 뒤 `reconcile(requestId, result, evidence)`로 결과와 근거를 기록합니다. 같은 근거와 결과로 반복 확정할 수 있습니다. 결과 저장에 실패해도 실행 기록을 유지하며, 마무리 저장 재시도 중에는 콜백을 다시 호출하지 않습니다.

프로젝트·에이전트별로 읽기 4개 또는 쓰기 1개를 허용합니다. 임대는 프로세스 ID·nonce·30초 만료와 갱신을 사용합니다. 카탈로그 변경도 쓰기 소유권이 필요합니다. 같은 실제 기능의 별칭들은 회로 차단기를 공유합니다. 실패 3회 후 60초 동안 차단하고 이후 하나의 시험 호출을 허용합니다. 수동 결과 확정과 자동 상태 관측은 별도로 관리합니다.

Mimir의 Soul 공통 테이블을 사용하며 `hecaton_definitions`, `hecaton_calls`, `hecaton_circuits`, `hecaton_statistics`, `hecaton_leases`의 5개 테이블을 추가합니다. `meta`에 모듈 스키마 버전 1과 저장소 UUID를 기록합니다. 공통 필드명은 공개 Soul 저장 계약과 일치합니다. 미래 버전·부분 생성·버전 없는 헤카톤 스키마는 시작 시 거부하여 명시적 이전이 필요합니다.

완료 결과·사용 횟수·`experiences` 기록을 한 트랜잭션으로 저장합니다. 경험에는 도구가 보고한 결과, `verified: false`, 출처와 결과 해시를 기록합니다. 실제 테스트와 독립 검토는 호스트 작업 흐름에 연결합니다. 입력과 출력에 앱 데이터가 포함될 수 있으므로 DB 접근·보관 정책은 호스트가 관리합니다.

`inspectHecaton({ dbPath, project, agent, view })`는 기존 DB를 읽기 전용으로 열어 상태·이력·정의를 조회합니다. 기존 어댑터가 없어도 조회할 수 있으며 `status` 조회에는 `requestId`가 추가로 필요합니다.

## CLI와 MCP 서버

```sh
n2-hecaton call --db ./data/mimir.db --project demo --agent worker --adapter ./node_modules/n2-hecaton/examples/host.cjs --tool echo --request-id demo-001 --args-json '{"text":"안녕하세요"}'
n2-hecaton status --db ./data/mimir.db --project demo --agent worker --request-id demo-001
n2-hecaton mcp --db ./data/mimir.db --project demo --agent worker --adapter ./node_modules/n2-hecaton/examples/host.cjs
```

JSON 인용 방식은 사용 중인 셸에 맞춰야 합니다. `--help`로 16개 명령을 확인할 수 있습니다. `status`, `history`, `definitions`는 읽기 전용 조회이며, 그 밖의 명령은 명시적으로 선택한 로컬 JavaScript 어댑터만 불러옵니다. 종료 코드는 성공 0, 확인된 실행 실패 2, 잘못된 입력·불확실 결과·오류 1입니다.

stdio MCP 서버는 조회·라우팅·실행·정의 관리·원격 탐색과 등록·결과 확정을 위한 16개 도구를 제공합니다. 변경 작업은 짧은 처리 확인값을 반환합니다. 전체 기록은 `hecaton_read`의 유니코드 코드포인트 단위 JSON 조각으로 읽고 각 페이지의 `sha256`이 같은지 확인합니다. EOF·요청 취소·프로세스 신호를 받으면 실행과 연결된 서버를 정리합니다.

## 한도와 검증

| 항목 | 기본값 또는 상한 |
| --- | --- |
| 카탈로그 | 512개 도구, 메타데이터·소스 합계 4 MiB, 사용자 조건 512개 |
| 도구 입력·결과 | 64 KiB·128 KiB, 중첩·요소 수 제한 |
| N2R 소스·스키마 | 64 KiB·32 KiB |
| 콜백 실행 | 최대 120초 |
| 권한 판단 | 기본 30초, 최대 120초 |
| MCP 등록 서버·대기열 | 16개·32개 |
| 원격 탐색 | 15초, 32페이지, 128개 도구, 4 MiB |
| MCP 프레임·트래픽 | 1 MiB, 초당 4 MiB·256개 메시지 |
| MCP 조회 응답 | 60,000바이트, 전체 JSON은 분할 조회 |

1.0.1은 CLI와 기본 MCP 표준 출력에 비동기 쓰기를 적용합니다. Windows에서 출력을 받는 쪽이 멈춰도 취소와 5초 출력 제한을 처리합니다. 출력 시간이 초과되면 CLI가 소유한 엔진과 MCP 연결을 정리한 뒤 자신의 프로세스를 종료합니다. 애플리케이션에 내장한 전송기는 호스트에 I/O 실패를 전달합니다. 운영체제별 프로세스 스트림 동작은 Node 문서에서 확인할 수 있습니다. [Node 프로세스 I/O](https://nodejs.org/api/process.html#a-note-on-process-io)

```sh
npm ci
npm test
npm run typecheck:consumer
```

테스트는 실제 파일 변경, 작업 프로세스 중단, DB 재시작·롤백, 여러 연결의 임대 경쟁, 결과 확정, 컴파일된 조건, 실제 stdio·HTTP MCP 통신, 인증 정보 분리, 응답 유실, SSE 복구, 구미호 연결과 실제 파일 바이트 검증을 다룹니다. 모델 응답은 재현 가능한 테스트 대역을 사용하며 유료 클라우드 모델의 품질 평가는 포함하지 않습니다. CI는 Windows·Linux·macOS에서 소스와 동일한 패키지 파일을 검증합니다. Windows는 POSIX SIGTERM 처리 사례를 건너뛰고 MCP 요청 취소·EOF 종료를 검증합니다.

## 라이선스

헤카톤 소스는 MIT입니다. Mimir·Clotho의 공개된 비상업용·상업용 조건은 각각 `LICENSE-N2-MIMIR`, `LICENSE-N2-CLOTHO`에 보존되어 있으며 해당 의존성을 사용하는 배포에 적용됩니다. 의존성 출처는 `THIRD-PARTY-NOTICES`에서 확인할 수 있습니다.
