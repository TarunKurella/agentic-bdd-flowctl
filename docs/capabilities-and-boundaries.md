# Capabilities and boundaries

Flowctl is deliberately conservative. This document states what version 0.2 can prove, what remains conditional, and what a company pilot must provide.

## Source discovery

### React and TypeScript

Supported patterns include JSX routes, nested and index routes, `createBrowserRouter` object trees, direct navigation, finite static mapped links, rendered source-owned component composition, common form handlers, Fetch, Axios defaults, and `axios.create` base URLs.

Computed route tables, server-driven UI, dynamic component selection, unresolved custom controls, ambiguous handlers, runtime-only options, and unknown event factories remain conditional. Reviewed `analysis.transparentComponents` may identify presentation-only wrappers; it must not hide controls or business behavior.

### Spring-style Java

Supported patterns include request mappings, DTO Bean Validation, annotation security, a deterministic method-aware `SecurityFilterChain` matcher subset, simple top-level throw guards, unique bounded controller-to-service calls, and supported persistence/deletion/authentication effects.

Reflection, ambiguous overloads or implementations, complex control flow, scoped security chains, dynamic authorities, unsupported validators, delegated eligibility policies, and unproved success responses remain conditional.

## Flow generation

A complete happy path must start at a configured entry, traverse source-supported transitions, satisfy all accumulated guards, reach an authoritative successful effect or screen, and avoid error/cancel transitions.

Variants separate behaviorally meaningful differences: actor contracts, branch assignments, active fields, validations, page/action sequences, operations, and visible outcomes. Search is bounded by configured depth and state visits. Coverage reports when those bounds prevent proof.

Flowctl does not generate every Cartesian combination. Data values with identical behavior remain a data class; different source branch assignments remain different variants.

## BDD and Playwright-BDD

Runnable Gherkin is generated only from satisfiable variants. Conditional candidates remain review-only. Stable IDs keep step text composable while an application runtime supplies page, field, action, actor, and assertion implementations.

The package verifies that Playwright-BDD discovers generated step definitions and compiles fixture features. A corporate application must still implement its component/runtime adapter and execute the generated test suite in its own environment.

## AI responsibilities

An approved coding assistant can inspect evidence packets, propose readable labels, reconcile a compiler-listed rule gap, implement general extractor support, and implement application runtime adapters.

It cannot invent graph edges, actors, UAT identifiers, product codes, credentials, approvals, or a passing browser result. Proposal schemas, evidence allowlists, immutable operation identity, literal/path/authority allowlists, validation, and named human approval enforce this boundary.

Ast-grep is used to assemble small investigation packets for the agent. It is not the canonical reasoning engine. Canonical facts come from typed adapters and deterministic graph passes.

## Graphify and LLM Wiki

Graphify contributes architecture/navigation evidence. LLM Wiki contributes glossary and readable semantic context. Both can help an agent locate relevant code and explain intent, but neither can independently create an executable transition, predicate, permission, or success claim.

## Application data

Flowctl may synthesize a value only when supported constraints have a safe concrete representative. Existing entity IDs, authenticated identities, corporate product codes, dynamic runtime options, actor attributes, and secrets require approved application bindings.

These values live in `.flowctl/application-data.local.yaml`, not in environment variables or generated features. Secret-bearing requirements keep only an approved secret reference.

## Pilot readiness

Version 0.2 is suitable for a controlled internal pilot when:

1. the application uses supported React/Spring conventions or receives reviewed extractor extensions;
2. one representative journey can be traced from UI entry to authoritative backend success;
3. coverage and conditional diagnostics are reviewed rather than suppressed;
4. application data providers and reviewer responsibility are defined;
5. a real Playwright runtime adapter and approved no-shell runner are implemented;
6. generated BDD is reviewed alongside its traceability, not as free-form AI output.

It is not yet a general bug-finding product. The planned bug-finding phase will compare independently derived contracts and produce concrete contradiction witnesses, avoiding the circular mistake of deriving and verifying a rule from the same implementation fact.
