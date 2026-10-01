// One-off: make the CRM's analyst service account the OWNER of a tenant on the Data Analyst
// agent. Needed once per agent deployment: a new account gets 403 onboarding_required on every
// call until POST /auth/provision runs. Owner is also what confirming an "unverified" Google
// link needs. Safe to re-run — an already-provisioned account is just reported.
//
//   node --env-file=.env.local scripts/_provision-analyst-tenant.mjs
//
// Uses the same ANALYST_* settings as src/lib/analyst/client.ts. The service user itself must
// already exist in the AGENT's Supabase project (Auth → Users → Add user, auto-confirm).

const need = ["ANALYST_API_URL", "ANALYST_SUPABASE_URL", "ANALYST_SUPABASE_KEY", "ANALYST_SERVICE_EMAIL", "ANALYST_SERVICE_PASSWORD"];
const missing = need.filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error("missing:", missing.join(", "));
  process.exit(1);
}
const api = process.env.ANALYST_API_URL.trim().replace(/\/+$/, "");
const supabase = process.env.ANALYST_SUPABASE_URL.trim().replace(/\/+$/, "");
const tenantName = process.argv[2] ?? "iTarang";

const login = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: process.env.ANALYST_SUPABASE_KEY.trim(), "content-type": "application/json" },
  body: JSON.stringify({ email: process.env.ANALYST_SERVICE_EMAIL.trim(), password: process.env.ANALYST_SERVICE_PASSWORD }),
});
const session = await login.json();
if (!login.ok) {
  console.error("sign-in failed:", session.error_description ?? session.msg ?? login.status);
  process.exit(1);
}
const auth = { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" };

console.log("waking the agent…");
await fetch(`${api}/health`, { signal: AbortSignal.timeout(90_000) }).catch(() => {});

let me = await fetch(`${api}/auth/me`, { headers: auth });
if (me.status === 403) {
  console.log(`not provisioned yet — creating tenant "${tenantName}"`);
  const res = await fetch(`${api}/auth/provision`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_name: tenantName }) });
  if (!res.ok) {
    console.error("provision failed:", res.status, await res.text());
    process.exit(1);
  }
  me = await fetch(`${api}/auth/me`, { headers: auth });
}
const user = await me.json();
if (!me.ok) {
  console.error("/auth/me failed:", me.status, user);
  process.exit(1);
}
console.log({ email: user.email, role: user.role, tenant: user.tenant_name, plan: user.plan });
if (user.role !== "owner") console.warn("warning: not the tenant owner — confirming unverified Google links will be refused");
