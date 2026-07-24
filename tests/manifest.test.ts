import { toAIToolMap } from "@absolutejs/manifest";
import { describe, expect, test } from "bun:test";
import { createErrorTracker, createMemoryIssueStore } from "../src";
import { manifest } from "../src/manifest";

const toolsFor = (tracker: ReturnType<typeof createErrorTracker>) =>
  toAIToolMap(manifest, {
    enforce: async (_request, execute) => execute(),
    runtime: tracker,
  });

describe("durable issue manifest tools", () => {
  test("reads and changes durable issues through guarded contracts", async () => {
    const tracker = createErrorTracker({
      project: "project-1",
      store: createMemoryIssueStore(),
    });
    const captured = await tracker.captureException(new Error("route failed"));
    const tools = toolsFor(tracker);
    const listIssues = tools.list_issues;
    const issueEvents = tools.issue_events;
    const setIssueState = tools.set_issue_state;
    if (!listIssues || !issueEvents || !setIssueState)
      throw new Error("Durable issue tools were not bridged");
    const listed = await listIssues.handler({
      limit: 20,
      project: "project-1",
    });
    const events = await issueEvents.handler({
      fingerprint: captured.fingerprint,
      limit: 20,
      project: "project-1",
    });
    const changed = await setIssueState.handler({
      fingerprint: captured.fingerprint,
      project: "project-1",
      reason: "Operator confirmed the issue is resolved.",
      state: "resolved",
    });

    expect(JSON.parse(listed)).toMatchObject([
      {
        fingerprint: captured.fingerprint,
        project: "project-1",
        state: "unresolved",
      },
    ]);
    expect(JSON.parse(events)).toMatchObject([
      {
        fingerprint: captured.fingerprint,
        project: "project-1",
      },
    ]);
    expect(JSON.parse(changed)).toEqual({
      fingerprint: captured.fingerprint,
      project: "project-1",
      state: "resolved",
    });
    expect(listIssues.authorization).toMatchObject({
      approval: "never",
      effects: ["read"],
      requiredScopes: ["errors:read"],
    });
    expect(setIssueState.authorization).toMatchObject({
      approval: "policy",
      effects: ["write"],
      idempotency: { mode: "host" },
      requiredScopes: ["errors:write"],
      reversible: false,
    });
  });

  test("fails closed when the tracker has no durable query surface", async () => {
    const tracker = createErrorTracker();
    const listIssues = toolsFor(tracker).list_issues;
    if (!listIssues) throw new Error("Durable issue list tool was not bridged");
    const result = await listIssues.handler({ limit: 20 });

    expect(result).toBe("durable issue list storage is unavailable");
  });
});
