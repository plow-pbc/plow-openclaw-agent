import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { notificationControl } from "../plugin/experience.ts";
import { readExperience } from "../plugin/experience-state.ts";

const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line" };
async function fixture(t: TestContext) {
  process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "plow-notification-stress-"));
  const root = process.env.OPENCLAW_STATE_DIR;
  process.env.PLOW_AGENT_TOKEN = "fixture";
  t.after(() => rm(root, { recursive: true, force: true }));
}

const overlapOrders = [
  { conversations: ["cht_home", "owner"], sessions: ["agent:main:main", "agent:main:main"], destination: "cht_home", orders: [[0, 1], [1, 0]] },
  { conversations: ["cht_source", "cht_target", "owner"], sessions: ["agent:main:plow:chat:group:cht_source", "agent:main:plow:chat:group:cht_target", "agent:main:plow:chat:group:cht_source"], destination: "cht_target", orders: [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] },
];
test("all 40 room/global and three-scope pause/resume orders retain a one-shot job until its last gate opens", async t => {
  await fixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ uid: "cht_home", status: "active", participants: [
    { type: "member", role: "owner" }, { type: "agent", relationship: "self", line: { uid: account.lineUid } },
  ] }], has_more: false }));
  for (const pattern of overlapOrders) {
    const scopes = pattern.conversations.map(conversation => ({ account, conversation }));
    const contexts = pattern.sessions.map(sessionKey => ({ agentId: "main", sessionKey, assertInvocationCurrent() {} }));
    for (const pauseOrder of pattern.orders) for (const resumeOrder of pattern.orders) {
      const scenario = `${pattern.conversations}; pause=${pauseOrder}; resume=${resumeOrder}`;
      const paused = new Set<number>();
      const job = { id: "one-shot", name: "Reminder", enabled: true, configRevision: "original", deleteAfterRun: true,
        owner: { sessionKey: contexts[0].sessionKey, accountId: "chat" }, delivery: { channel: "plow", to: pattern.destination, accountId: "chat" } };
      let updates = 0;
      const gateway = { async request(method: string, params: any) {
        if (method === "cron.list") return { jobs: [structuredClone(job)], hasMore: false };
        if (method === "cron.update") {
          assert.equal(params.expectedConfigRevision, job.configRevision, scenario);
          job.enabled = params.patch.enabled; job.configRevision = `revision-${++updates}`;
        }
        return structuredClone(job);
      } };
      for (const index of pauseOrder) {
        await notificationControl(gateway, scopes[index], contexts[index], "pause", scopes[index].conversation === "owner");
        paused.add(index);
        assert.equal(job.enabled, false, scenario);
      }
      for (const index of resumeOrder) {
        await notificationControl(gateway, scopes[index], contexts[index], "resume", scopes[index].conversation === "owner");
        paused.delete(index);
        assert.equal(job.enabled, paused.size === 0, scenario);
      }
      assert.equal(updates, 2, scenario);
      for (const scope of scopes) {
        const state = await readExperience(scope);
        assert.equal(state.paused, false, scenario);
        assert.deepEqual(state.suspendedJobs, [], scenario);
      }
    }
  }
});

test("pausing across page boundaries cannot reorder disabled jobs ahead of unread jobs", async t => {
  await fixture(t);
  const scope = { account, conversation: "cht_room" }, ctx = { agentId: "main", sessionKey: "room-session", assertInvocationCurrent() {} };
  const jobs = Array.from({ length: 205 }, (_, i) => ({ id: `job-${i}`, name: String(i).padStart(3, "0"), enabled: true,
    configRevision: `original-${i}`, owner: { sessionKey: ctx.sessionKey, accountId: "chat" } }));
  const gateway = { async request(method: string, params: any) {
    if (method === "cron.list") {
      // Native sorting defaults to nextRunAtMs: disabling a job removes its next run.
      const sorted = jobs.toSorted((a, b) => (params.sortBy === "name" ? 0 : Number(b.enabled) - Number(a.enabled)) || a.name.localeCompare(b.name));
      return { jobs: structuredClone(sorted.slice(params.offset, params.offset + params.limit)), hasMore: params.offset + params.limit < jobs.length, nextOffset: params.offset + params.limit };
    }
    const job = jobs.find(job => job.id === params.id)!;
    if (method === "cron.update") {
      assert.equal(params.expectedConfigRevision, job.configRevision);
      job.enabled = params.patch.enabled; job.configRevision += "-updated";
    }
    return structuredClone(job);
  } };
  await notificationControl(gateway, scope, ctx, "pause", false);
  assert.equal(jobs.filter(job => job.enabled).length, 0);
  assert.equal((await readExperience(scope)).suspendedJobs.length, jobs.length);
  await notificationControl(gateway, scope, ctx, "resume", false);
  assert.ok(jobs.every(job => job.enabled));
  assert.deepEqual((await readExperience(scope)).suspendedJobs, []);
});
