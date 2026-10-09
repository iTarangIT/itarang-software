/**
 * One-off E-316 walkthrough against a running dev server (default
 * http://localhost:3100), using REAL Supabase sessions for each seat. It drives
 * an existing request through the whole workflow and checks every refusal.
 *
 *   node scripts/_fr-test-requester.js            # throwaway requester login
 *   (raise a request as fr-test-ceo@itarangjosh.com / $FR_E2E_PASSWORD, note its id)
 *   node --import tsx --env-file=.env.local scripts/_e2e-feature-requests.ts <featureRequestId> [baseUrl]
 *   node scripts/_fr-test-requester.js --remove   # afterwards
 *
 * WRITES to the database behind that server (comments, events, attachments).
 */
import { createServerClient } from "@supabase/ssr";

const [frId, base = "http://localhost:3100"] = process.argv.slice(2);
if (!frId) throw new Error("usage: _e2e-feature-requests.ts <featureRequestId> [baseUrl]");

// ID 140: no fixed default password — the test logins use whatever FR_E2E_PASSWORD says.
const E2E_PASSWORD: string = process.env.FR_E2E_PASSWORD ?? "";
if (!E2E_PASSWORD) throw new Error("set FR_E2E_PASSWORD to the test logins' password");

async function login(email: string): Promise<string> {
  const jar = new Map<string, string>();
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await sb.auth.signInWithPassword({ email, password: E2E_PASSWORD });
  if (error) throw new Error(`${email}: ${error.message}`);
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
}

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || extra === undefined ? "" : `  → ${JSON.stringify(extra).slice(0, 300)}`}`);
  if (!ok) failures++;
}

type Res = { status: number; json: any; headers: Headers };
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<Res> {
  const init: RequestInit = { method, headers: { cookie }, redirect: "manual" };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const r = await fetch(base + path, init);
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 200);
  }
  return { status: r.status, json, headers: r.headers };
}

const act = (c: string, body: unknown) => call(c, "POST", `/api/feature-requests/${frId}/actions`, body);
const detail = async (c: string) => (await call(c, "GET", `/api/feature-requests/${frId}`)).json.data;
async function upload(c: string, name: string, content: string, type: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type }));
  const r = await call(c, "POST", "/api/feature-requests/uploads", fd);
  if (r.status !== 201) throw new Error(`upload ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data.id;
}

(async () => {
  const [ceo, kartik, apoorv, aditya, rushikesh] = await Promise.all(
    ["fr-test-ceo", "kartik", "apoorv", "aditya", "rushikesh"].map((u) => login(`${u}@itarangjosh.com`)),
  );
  console.log("5 sessions ready\n");

  let d = await detail(kartik);
  check("starts at Pending Product Review with Kartik", d.request.status === "pending_product_review" && d.request.current_owner_name === "Kartik", d.request);
  check("Kartik sees approve/request_changes/reject", JSON.stringify(d.actions) === '["approve","request_changes","reject"]', d.actions);
  check("the 2 files attached at creation are listed", d.attachments.filter((a: any) => !a.comment_id).length === 2, d.attachments);
  check("CEO can't approve (403)", (await act(ceo, { action: "approve" })).status === 403);
  check("Apoorv can't act at product review (403)", (await act(apoorv, { action: "approve" })).status === 403);
  check("reject without a reason is refused (400)", (await act(kartik, { action: "reject", reason: "  " })).status === 400);
  check("CEO can't create (non-requester) — Kartik POST / is 403", (await call(kartik, "POST", "/api/feature-requests", { title: "x", description: "xxxxxxxxxxxx", priority: "low", module: "x" })).status === 403);

  // Kartik sends it back to the CEO.
  let r = await act(kartik, { action: "request_changes", reason: "Add a mockup of the reassign screen." });
  check("Kartik requests changes", r.status === 200 && r.json.data.status === "changes_requested", r.json);
  d = await detail(ceo);
  check("…it's back with the CEO, who can edit + resubmit", d.canEdit && d.actions.includes("resubmit") && d.request.current_owner_name === "Test CEO", d);
  check("Kartik can no longer edit it", !(await detail(kartik)).canEdit);

  const mock = await upload(ceo, "reassign-mockup.png", "fake-png", "image/png");
  r = await call(ceo, "PATCH", `/api/feature-requests/${frId}`, {
    description: "Sales heads need to move a batch of leads between ASMs in one step. Mockup attached.",
    attachmentIds: [mock],
  });
  check("CEO edits the description + adds a file", r.status === 200, r.json);
  r = await act(ceo, { action: "resubmit", note: "Mockup added." });
  check("CEO resubmits → Pending Product Review", r.json?.data?.status === "pending_product_review", r.json);

  // Discussion: comment, reply, edit, attachments.
  const note = await upload(kartik, "notes.docx", "fake-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  r = await call(kartik, "POST", `/api/feature-requests/${frId}/comments`, { body: "Looks good — does it need an audit trail?", attachmentIds: [note] });
  check("Kartik comments with a file", r.status === 201, r.json);
  d = await detail(ceo);
  const kComment = d.comments.find((c: any) => c.kind === "comment" && c.author_name === "Kartik");
  r = await call(ceo, "POST", `/api/feature-requests/${frId}/comments`, { body: "Yes, log every move.", parentId: kComment.id });
  check("CEO replies", r.status === 201, r.json);
  check("CEO can't edit Kartik's comment (403)", (await call(ceo, "PATCH", `/api/feature-requests/comments/${kComment.id}`, { body: "hijack" })).status === 403);
  r = await call(kartik, "PATCH", `/api/feature-requests/comments/${kComment.id}`, { body: "Looks good — should it keep an audit trail of every move?" });
  check("Kartik edits his own comment", r.status === 200, r.json);
  check("a claimed file can't be re-used", (await call(ceo, "POST", `/api/feature-requests/${frId}/comments`, { body: "x", attachmentIds: [note] })).status === 400);
  check("an empty comment is refused", (await call(ceo, "POST", `/api/feature-requests/${frId}/comments`, { body: " " })).status === 400);

  r = await act(kartik, { action: "approve", note: "Good to go." });
  check("Kartik approves → Pending Technical Review", r.json?.data?.status === "pending_tech_review", r.json);

  // Apoorv sends it back to Kartik, not the CEO.
  check("tech request_changes needs a comment (400)", (await act(apoorv, { action: "request_changes", reason: "", target: "product_reviewer" })).status === 400);
  r = await act(apoorv, { action: "request_changes", reason: "Clarify the max batch size.", target: "product_reviewer" });
  check("Apoorv sends it back to Kartik", r.json?.data?.status === "changes_requested", r.json);
  d = await detail(kartik);
  check("…Kartik owns it and can resubmit; CEO can't", d.request.current_owner_name === "Kartik" && d.actions.includes("resubmit") && !(await detail(ceo)).actions.includes("resubmit"), d.actions);
  r = await act(kartik, { action: "resubmit", note: "Max 500 leads per batch." });
  check("Kartik resubmits → straight back to Pending Technical Review", r.json?.data?.status === "pending_tech_review", r.json);

  r = await act(apoorv, { action: "approve" });
  check("Apoorv approves → Ready for Assignment", r.json?.data?.status === "ready_for_assignment", r.json);
  const devs = (await detail(apoorv)).members.filter((m: any) => m.seat === "developer");
  const adityaId = devs.find((m: any) => m.name === "Aditya").id;
  check("Kartik can't assign (403)", (await act(kartik, { action: "assign", developerId: adityaId })).status === 403);
  r = await act(apoorv, { action: "assign", developerId: adityaId, note: "Please take this." });
  check("Apoorv assigns Aditya → Assigned", r.json?.data?.status === "assigned", r.json);

  check("Rushikesh can't move Aditya's request (403)", (await act(rushikesh, { action: "set_status", toStatus: "in_development" })).status === 403);
  check("Aditya can't skip ahead (400)", (await act(aditya, { action: "set_status", toStatus: "testing" })).status === 400);
  for (const to of ["in_development", "testing", "in_development", "testing", "ready_for_deployment", "deployed"]) {
    r = await act(aditya, { action: "set_status", toStatus: to });
    check(`Aditya → ${to}`, r.json?.data?.status === to, r.json);
  }
  const shot = await upload(aditya, "deployed.png", "fake-png", "image/png");
  r = await act(aditya, { action: "set_status", toStatus: "closed", note: "Shipped in release 42.", attachmentIds: [shot] });
  check("Aditya → closed, with a screenshot", r.json?.data?.status === "closed", r.json);

  // Final state: history is all there, files download, comments still allowed.
  d = await detail(rushikesh);
  check("closed_at is set", !!d.request.closed_at);
  check("no actions left for anyone", d.actions.length === 0 && (await detail(aditya)).actions.length === 0);
  const kinds = d.comments.map((c: any) => c.kind);
  console.log("\n  timeline:", kinds.join(" → "));
  check(
    "every step is in the timeline",
    ["created", "changes_requested", "edited", "resubmission", "comment", "approval", "assignment", "status_change"].every((k) => kinds.includes(k)),
    kinds,
  );
  check("the reply hangs off Kartik's comment", d.comments.some((c: any) => c.parent_id === kComment.id));
  const edited = d.comments.find((c: any) => c.id === kComment.id);
  check("comment edit history kept", edited.edits.length === 1 && edited.edits[0].previous_body.startsWith("Looks good — does it"), edited);
  check("5 files total (2 create + mockup + notes + screenshot)", d.attachments.length === 5, d.attachments.map((a: any) => a.file_name));
  // create, 2 send-backs, edit, 2 resubmits, 2 approvals, assign, 7 status moves
  check("event log has every transition (16)", d.events.length === 16, d.events.length);

  const file = d.attachments.find((a: any) => a.file_name === "spec.pdf");
  const dl = await call(rushikesh, "GET", `/api/feature-requests/attachments/${file.id}`);
  check("Rushikesh downloads spec.pdf as an attachment", dl.status === 200 && (dl.headers.get("content-disposition") ?? "").startsWith("attachment"), dl.headers.get("content-disposition"));
  const anon = await call("", "GET", `/api/feature-requests/attachments/${file.id}`);
  check("no session → no file", anon.status !== 200, anon.status);
  check("comments still allowed after Closed", (await call(rushikesh, "POST", `/api/feature-requests/${frId}/comments`, { body: "Verified on sandbox." })).status === 201);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
