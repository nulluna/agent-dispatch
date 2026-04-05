# dispatch-refactor-architect

## Purpose

Use this skill when the user asks to refactor, redesign, or re-architect a dispatch/relay project while preserving existing external behavior.

This skill is for projects that have characteristics like:
- ingress routing to upstream targets
- relay/proxy request forwarding
- backend selection strategies such as poll/hash/sticky routing
- stateful behavior such as challenge cookies, affinity, or auth-like identifiers
- response rewriting such as `Location` / `Refresh`
- retry logic, cache probing, or negative-cache behavior

This skill does **not** directly implement code changes. It first forces Claude to understand the existing behavior model and then produce a behavior-preserving refactor architecture.

## Trigger Conditions

Trigger this skill when the user says things like:
- 重构这个 dispatch 项目
- 用更好的方案重写这套逻辑
- 先理解这个仓库，再给我新的架构方案
- 重新整理 relay / poll / hash / challenge / negative-cache 这套系统

Do **not** trigger this skill for:
- a small bugfix
- a single failing test
- a minor env/header/path change
- simple code explanation requests

## Core Rule

Before proposing any refactor architecture, Claude must:
1. read the current code
2. read the current tests
3. extract the current behavior model
4. separate **external behavior requirements** from **internal implementation details**

No architecture proposal is allowed before those steps are complete.

## Required Reading Order

Claude must first inspect the current codebase in this order:

1. config/runtime setup
2. routing / ingress parsing
3. dispatch / main orchestration
4. strategy / backend selection
5. negative-cache behavior
6. headers / response rewriting
7. error handling
8. worker entrypoint
9. tests for dispatch and strategy

For this repository, the high-value files usually include:
- `src/config.ts`
- `src/routing.ts`
- `src/dispatch.ts`
- `src/strategy.ts`
- `src/negative-cache.ts`
- `src/headers.ts`
- `src/errors.ts`
- `src/index.ts`
- `test/dispatch.test.ts`
- `test/strategy.test.ts`
- `test/negative-cache.test.ts`

## Mandatory Behavior Extraction

Before giving any redesign proposal, Claude must produce a concise behavior map covering at least:

- ingress path parsing
- relay URL construction
- request header filtering / forwarding
- backend selection (`poll`, `hash`, sticky rules)
- sticky identifier resolution priority
- challenge affinity recording and reuse
- negative-cache semantics
- retry behavior and when multiple relay attempts are expected
- redirect / refresh rewriting behavior
- env/config surface
- observability/logging behavior

For each item, Claude must distinguish:
- **External behavior**: what callers/clients observe
- **Internal mechanism**: how the current implementation achieves it

## Non-Negotiable Guardrails

Default rule: **preserve existing behavior unless the user explicitly approves behavior changes**.

Claude must assume the following are behavior-sensitive and cannot be casually changed:
- routing semantics
- `http` vs `https` path meaning
- trailing slash preservation
- sticky identifier priority
- `poll` / `hash` selection semantics
- challenge affinity semantics
- negative-cache cacheability / probe semantics
- redirect status preservation
- `Location` / `Refresh` rewriting semantics
- request count semantics (single relay vs retry/probe)

Claude must not:
- change behavior because the new design looks cleaner
- infer behavior from implementation alone while ignoring tests
- collapse distinct state models into one generic abstraction without proving equivalence
- confuse retry/probe/client-follow-up traffic with one another

## Required Analysis Output

Claude must structure the response in this order:

### 1. Current behavior map
List the system capabilities and what they do from the caller/client perspective.

### 2. Hidden constraints
List the non-obvious behavior rules that are easy to miss if someone only reads implementation code.

### 3. Architecture pain points
Identify where complexity is concentrated, where responsibilities are mixed, and where behavior is hard to verify safely.

### 4. Behavior-preserving refactor proposal
Provide a better architecture that keeps the observed behavior stable.

This proposal must include:
- module decomposition
- responsibility boundaries
- state ownership boundaries
- data flow between modules
- what should become pure functions
- what must remain orchestration/stateful

### 5. Migration strategy
Provide a safe incremental migration order.

### 6. Regression strategy
Explain which tests protect behavior and what additional tests are needed before any migration.

## Preferred Refactor Heuristics

When proposing a better design, prefer:
- smaller modules with one clear responsibility
- explicit state boundaries
- pure behavior helpers for parsing/rewriting/selection logic
- orchestration separated from policy decisions
- behavior-first test coverage
- narrow interfaces between modules

Avoid proposing:
- broad rewrites with no migration sequence
- framework churn unrelated to dispatch behavior
- replacing proven behavior with untested abstractions
- “network layer” mega-modules that mix retry/cache/challenge/redirect logic together

## Output Style

The skill should drive Claude toward:
- concise but structured architecture reasoning
- behavior-first analysis
- clear separation of “what must stay the same” vs “what can be redesigned”
- concrete refactor boundaries, not vague cleanup advice

## Success Condition

The skill has succeeded when Claude produces:
1. an accurate behavior model of the current dispatch system
2. a list of hidden invariants and non-negotiable behavior constraints
3. a cleaner architecture proposal that preserves behavior
4. a migration plan and regression strategy that can be executed safely
