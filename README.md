# N2 Hecaton

Scoped tool discovery, routing and durable execution for AI hosts.

[한국어 안내](README.ko.md)

Hecaton turns explicitly registered host functions and selected MCP tools into a searchable catalog. Each execution records its identity before calling the capability, then commits its result and a Soul-compatible experience together. Strict N2R definitions add schemas, routing metadata and bounded preconditions to existing bindings.

This standalone release carries Daebung's catalog, taxonomy, routing, guarded execution, circuit breaker and MCP import functions. Applications provide filesystem tools, commands, browser operations, user interaction and other application-specific capabilities through host adapters. The application also owns operating-system permissions and process isolation.

## Install

Requires Node.js 22 or later. SQLite uses `better-sqlite3`, or a compatible optional Mimir Rust binding. Installation can require a native compiler when the platform has no matching prebuilt SQLite binary.

```sh
npm install https://github.com/choihyunsus/n2-hecaton/releases/download/v1.0.1/n2-hecaton-1.0.1.tgz
```

GitHub Releases supplies this package and its pinned N2 dependencies. The lockfile records exact dependency resolutions.

## Register and execute

```js
import { Hecaton } from 'n2-hecaton';

const engine = new Hecaton({
  dbPath: './data/mimir.db',
  project: 'example',
  agent: 'worker',
  tools: [{
    name: 'echo',
    version: '1',
    description: 'Return supplied text',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 1000 } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: (args, context) => ({ success: true, output: args.text }),
  }],
});

try {
  const receipt = await engine.execute({
    requestId: 'echo-001',
    sessionId: 'session-001',
    tool: 'echo',
    arguments: { text: 'Hello' },
  });
  console.log(receipt.result, receipt.cached, receipt.experienceId);
} finally {
  await engine.close();
}
```

Callbacks receive immutable project, agent, request and session identities plus an `AbortSignal`. A result contains `success`, `output`, optional JSON `data` and optional `modifiedFiles`. Class methods keep their original receiver. Metadata and input JSON are copied before execution.

Return `success: false` for a known operational failure. Exceptions, invalid output and expired execution deadlines retain uncertainty because an external effect may already have happened. Set `idempotent: true` only when repeating an unfinished invocation is safe. Read-only capabilities default to idempotent, and reported file changes are rejected for read-only tools.

The optional versioned `policy.authorize(request)` controls execution, including access to cached results. Its cancellation signal is `request.context.signal`. Registered tools are allowed by the default policy. Credential material and authorization logic belong in host closures. Change a tool or policy version when its behavior changes.

## Routing

`list()` returns executable tool metadata. `route(query, limit)` ranks the catalog using exact names, registered aliases, ten-domain classification, compact DNA descriptors and BM25 scores. Korean aliases are supported. Empty or unmatched queries return an empty match list.

`auto({ requestId, query, arguments })` selects the top match and uses the normal execution path. Hosts should expose the selected tool's schema when collecting arguments. `asGumihoTools(names)` exports an explicit selection of up to 64 tools for the published Gumiho harness. Both engines must use the same project and agent. Rebuild that selection after changing its definitions.

Routing reports serialized byte counts and a four-bytes-per-token estimate. Actual model token counts and task quality depend on the host and model.

## N2R tool definitions

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
const record = engine.installSource(source);
const revised = engine.installSource(updatedSource, record.contentHash);
engine.removeDefinition(revised.name, revised.contentHash);
```

Definitions are parsed by Clotho 4.1.0 and interpreted through Hecaton's supported runtime subset. `enforce: strict` is required. A definition binds one existing `native:name` host capability or one imported `mcp:server|encodedRemoteName` capability. Source updates use the expected content hash and an atomic revision change. Missing bindings remain inspectable through `definitions()` and `problems()`.

Supported features include inherited schemas, one typed `@schema` with parameter descriptions, explicit JSON input schemas, nonempty-field preconditions, `params.field !~ /pattern/igm` checks, blacklist predicates and one bound workflow step with a timeout and `$RESULT` output. Input checks apply to both the custom definition and its bound capability. Unsupported actions, state transitions, recovery logic, output transformations and multi-step execution fail at registration.

Rust Unicode predicates have a 4 KiB pattern limit and bounded automata. Input schemas use synchronous draft-07 JSON Schema, acyclic local references and RE2JS patterns. Recursive references, external schemas, asynchronous checks and unsupported regex constructs fail explicitly. Host declarations determine read-only and idempotent permissions.

## MCP discovery and import

```js
const engine = new Hecaton({
  dbPath: './data/mimir.db', project: 'example', agent: 'worker', tools: [],
  mcpServers: [{
    id: 'local', version: '1', transport: 'stdio',
    command: process.execPath, args: ['/absolute/path/to/server.js'],
    toolPermissions: { echo: { readOnly: true, timeoutMs: 10000 } },
  }],
});
const analysis = await engine.discoverMcp('local');
const imported = await engine.importMcp({ serverId: 'local', names: ['echo'] });
const receipt = await engine.execute({
  requestId: 'remote-001', tool: imported.installed[0].name, arguments: { text: 'Hello' },
});
await engine.close();
```

Discovery, schema analysis, source generation, atomic registration and registration verification run in order. The import receipt reports `executionVerified: false`. The host tests actual behavior separately and reads the execution receipt. Current remote metadata and server identity must match the pinned definition before a call. Changed metadata requires a reviewed re-import with expected hashes.

MCP servers are configured by the operator. Stdio launches use a fixed executable, arguments and environment, with `shell: false`. HTTP supports HTTPS endpoints and literal loopback HTTP endpoints, fixed headers and no redirects. Change the configuration version when the endpoint, account or capability behavior changes. Endpoint URLs, environment values and credentials stay outside imported definitions.

Remote read-only and idempotence annotations are hints. Explicit `toolPermissions` grant those properties. Remote arguments follow the remote server's schema, and the adapter or remote service implements its own project/agent authorization.

Connections are lazy and reusable, with one operation per server and two overall. Tool-call POSTs have no implicit retry. Bounded SSE GET resumption can recover an existing response. Malformed UTF-8, excess traffic and oversized protocol frames close the affected connection. Raw MCP result data is retained under `result.data.mcp` within the result budget.

The host owns sandboxing and remote trust decisions. Hecaton waits for its directly launched MCP process to exit during shutdown. External servers and the host must manage any descendants they launch. A host callback that ignores cancellation can keep running, so process isolation is required for a hard execution boundary.

## Recovery and storage

Calls progress through `prepared`, `pending`, `completed`, `unknown` or `blocked`. Preparation is journaled before policy checks, and `pending` is committed before the callback. A completed identical request returns its historical result. Conflicting request identities, arguments or versions are rejected.

`status(requestId)` distinguishes a live owner from an interrupted pending call. Uncertain non-idempotent work requires external inspection. After establishing the result, call `reconcile(requestId, result, evidence)`. Identical reconciliation is repeatable. Completed callback work is preserved when result persistence fails, and the callback runs once during finalization retries.

```js
const status = engine.status('remote-001');
// Inspect the remote effect before providing this result and evidence.
engine.reconcile('remote-001', inspectedResult, evidenceNote);
```

Each project/agent scope admits four concurrent readers or one exclusive writer. Leases use a process ID, nonce, 30-second expiry and renewal. Mutating catalog operations also require exclusive ownership. A circuit opens after three observed failures, waits 60 seconds, then admits one probe. Aliases share their bound capability's circuit. Manual reconciliation preserves separate automatic health accounting.

The database uses Mimir's common Soul tables and adds five scoped tables, `hecaton_definitions`, `hecaton_calls`, `hecaton_circuits`, `hecaton_statistics` and `hecaton_leases`. Module schema version 1 and a storage UUID live in `meta`. Common table names and fields match the published Soul storage contract. Future, partial or unversioned Hecaton schemas fail startup for explicit migration.

The final result, usage counters and associated `experiences` row commit together. Experiences record the capability's reported outcome with `verified: false`, source reference and result hash. Native checks or independent review belong in the host workflow. Stored arguments and output can contain application data, so the host controls database access and retention.

`inspectHecaton({ dbPath, project, agent, view })` reads status, history or definitions through a read-only connection and an existing schema. It supports inspection while the original adapter is unavailable. `status` additionally requires `requestId`.

## CLI and MCP server

```sh
n2-hecaton call --db ./data/mimir.db --project demo --agent worker --adapter ./node_modules/n2-hecaton/examples/host.cjs --tool echo --request-id demo-001 --args-json '{"text":"Hello"}'
n2-hecaton status --db ./data/mimir.db --project demo --agent worker --request-id demo-001
n2-hecaton mcp --db ./data/mimir.db --project demo --agent worker --adapter ./node_modules/n2-hecaton/examples/host.cjs
```

Shell JSON quoting varies by platform. `--help` documents all 16 commands. `status`, `history` and `definitions` use read-only inspection. Other commands load only the explicitly selected local JavaScript adapter. Exit codes are 0 for success, 2 for a known execution failure and 1 for invalid input or an uncertain/error outcome.

The stdio MCP server exposes 16 scoped tools for listing, routing, execution, inspection, source management, remote discovery/import and reconciliation. It returns compact mutation receipts and bounded read responses. Use `hecaton_read` for full JSON in Unicode-code-point chunks and compare `sha256` across pages. EOF, cancellation and process signals initiate bounded execution and child-connection shutdown.

## Limits and verification

| Resource | Default or maximum |
| --- | --- |
| Catalog | 512 tools, 4 MiB combined metadata/source, 512 custom predicates |
| Tool input / result | 64 KiB / 128 KiB, bounded nesting and element counts |
| N2R source / schema | 64 KiB / 32 KiB |
| Callback deadline | 120 seconds maximum |
| Authorization deadline | 30 seconds default, 120 seconds maximum |
| Registered MCP servers / queue | 16 / 32 operations |
| Remote discovery | 15 seconds, 32 pages, 128 tools, 4 MiB |
| MCP frame / traffic | 1 MiB / 4 MiB and 256 messages per second |
| MCP read response | 60,000 bytes, full JSON available in chunks |

Version 1.0.1 uses asynchronous writes for CLI and default MCP stdout. Cancellation and five-second output deadlines remain active when a Windows pipe consumer stalls. After an output write expires, the CLI closes its owned engine and MCP connections before terminating its own process. Embedded transports report the I/O failure to their host. Node documents the platform-specific behavior of process streams. [Node process I/O](https://nodejs.org/api/process.html#a-note-on-process-io)

```sh
npm ci
npm test
npm run typecheck:consumer
```

Tests exercise real file effects, worker loss, database restart and rollback, cross-connection leases, reconciliation, compiled predicates, real stdio/HTTP MCP servers, credential isolation, lost acknowledgements, SSE resumption and Gumiho integration with native byte verification. Deterministic model fixtures validate control flow. Paid cloud-model quality is outside these fixtures. CI runs source and the same packaged artifact on Windows, Linux and macOS. Windows skips the catchable POSIX SIGTERM case and exercises MCP cancellation/EOF instead.

## License

Hecaton source uses MIT. Mimir and Clotho retain their published non-commercial/commercial terms, reproduced in `LICENSE-N2-MIMIR` and `LICENSE-N2-CLOTHO`. Their terms apply to deployments using these dependencies. See `THIRD-PARTY-NOTICES` for dependency attribution.
