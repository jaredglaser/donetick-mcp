import { describe, expect, test } from "bun:test";
import { createProbeGate } from "../probe";
import type { DonetickClient } from "@/client";

/** Sequenced responses, so a test can make the instance come up mid-run. */
function fakeClient(responses: Array<unknown | Error>) {
  const calls: string[] = [];
  const client = {
    get: async (path: string) => {
      calls.push(path);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as DonetickClient;
  return { client, calls };
}

const baseUrl = "https://tasks.example.test";

describe("createProbeGate", () => {
  test("a healthy probe leaves no reason and costs nothing to re-check", async () => {
    const fake = fakeClient([[]]);
    const gate = createProbeGate(fake.client, baseUrl);

    await gate.run();

    expect(await gate.reason()).toBeUndefined();
    expect(await gate.reason()).toBeUndefined();
    // One call total: the startup probe. A healthy gate must not add a request
    // to every tool call.
    expect(fake.calls.length).toBe(1);
  });

  test("reports the failure while the instance is still down", async () => {
    const fake = fakeClient([new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED")]);
    const gate = createProbeGate(fake.client, baseUrl);

    await gate.run();

    expect(await gate.reason()).toMatch(/ECONNREFUSED/);
  });

  test("recovers once the instance comes up, instead of latching the startup failure", async () => {
    // The bug this exists for: a desktop client starts this server at login,
    // alongside the containers it talks to. Losing that race once used to answer
    // every request for the life of the process with a stale complaint about an
    // instance that had been healthy for hours.
    const fake = fakeClient([new Error("connect ECONNREFUSED"), []]);
    const gate = createProbeGate(fake.client, baseUrl);

    await gate.run();
    expect(await gate.reason()).toBeUndefined();
  });

  test("stops re-probing once recovered", async () => {
    const fake = fakeClient([new Error("connect ECONNREFUSED"), [], []]);
    const gate = createProbeGate(fake.client, baseUrl);

    await gate.run();
    await gate.reason();
    await gate.reason();

    // Startup probe plus the one recovery re-probe. The third response is never
    // consumed, because a recovered gate goes back to costing nothing.
    expect(fake.calls.length).toBe(2);
  });

  test("a 200 that is not a chore array is treated as a wrong URL, not as success", async () => {
    // Donetick serves the frontend HTML with a 200 on an unmatched path, so a
    // wrong DONETICK_URL fails by handing back a web page rather than by erroring.
    // This is the case the probe exists for at all.
    const fake = fakeClient(["<!doctype html><html>", "<!doctype html><html>"]);
    const gate = createProbeGate(fake.client, baseUrl);

    await gate.run();

    expect(await gate.reason()).toMatch(/did not return a chore array/);
    expect(await gate.reason()).toMatch(/DONETICK_URL/);
  });

  test("recovers from a wrong-shape answer too, not just from a thrown error", async () => {
    const fake = fakeClient(["<!doctype html><html>", []]);
    const gate = createProbeGate(fake.client, baseUrl);

    await gate.run();
    expect(await gate.reason()).toBeUndefined();
  });

  test("reason() before any run is undefined, so a call is never blocked by a probe that has not finished", async () => {
    // run() is deliberately not awaited at startup: serveStdio has to be listening
    // first. A call that arrives during the probe must go to Donetick and get a
    // real answer rather than be refused by a gate that knows nothing yet.
    const fake = fakeClient([[]]);
    const gate = createProbeGate(fake.client, baseUrl);

    expect(await gate.reason()).toBeUndefined();
    expect(fake.calls.length).toBe(0);
  });
});
