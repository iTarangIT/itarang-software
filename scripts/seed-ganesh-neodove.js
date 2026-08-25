/**
 * Seeds the NeoDove "ganesh" campaign + its ASM login.
 *
 *   ASM login:  ganesh@itarangjosh.com / Ganesh_Sales@2026   (role: asm)
 *   Campaign:   CRM_NEODOVE_3 (ganesh)  ->  NEODOVE_PUSH_ENDPOINT_CRM_NEODOVE_4
 *
 * TWO SEPARATE SYSTEMS, ONE STRING BETWEEN THEM. NeoDove has no campaign
 * creation API and no read API — the campaign itself was created by hand in
 * their UI. What this seeds is the CRM-side mapping row: the audience we intend
 * to push, the NAME of the env var holding the Custom Integration URL (never
 * the URL — that URL *is* the credential, see src/lib/neodove/config.ts), and
 * `neodove_campaign_name`, which must match the NeoDove UI string EXACTLY
 * because inbound dispositions are matched on it and nothing else.
 *
 * The env var is CRM_NEODOVE_4 while the NeoDove campaign is named
 * "CRM_NEODOVE_3 (ganesh)". That mismatch is NeoDove's, not a typo here — their
 * campaign really is the 4th integration but carries a _3 label. The ref and
 * the name are independent strings; both are copied verbatim from their source.
 *
 * The ASM user is wired in as the campaign's `crm_owner_user_id` (E-237), so a
 * lead pushed into this campaign lands in Ganesh's ASM workspace instead of
 * nobody's. `asm` is one of the two roles assignLeadOwner lifts lead_status for
 * — see NEODOVE_ASSIGNEE_ROLES.
 *
 * Idempotent: re-running resets the password, refreshes app_metadata, and
 * updates (not duplicates) both rows.
 *
 * Usage: node --env-file=.env.local scripts/seed-ganesh-neodove.js
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { createClient } = require('@supabase/supabase-js');
const postgres = require('postgres');

const USER = {
    email: 'ganesh@itarangjosh.com',
    password: 'Ganesh_Sales@2026',
    name: 'Ganesh',
    role: 'asm',
};

const CAMPAIGN = {
    // The row this script first seeded (NDC-20260825-401) was deleted as a
    // duplicate: the same campaign had also been created through the UI, which
    // is the row this id now points at. Keeping the id in sync with the
    // surviving row is what keeps a re-run an UPDATE instead of a third
    // duplicate — and the name/endpoint guards below would refuse the insert
    // anyway. There is no DELETE endpoint on /api/neodove/campaigns, so a
    // duplicate can only be cleared from the database by hand.
    id: 'NDC-20260825-332',
    // Both sides carry the NeoDove UI string, matching the three rows already
    // in the table — the CRM list is only useful if it reads like their console.
    name: 'CRM_NEODOVE_3 (ganesh)',
    neodoveCampaignName: 'CRM_NEODOVE_3 (ganesh)',
    pushEndpointRef: 'NEODOVE_PUSH_ENDPOINT_CRM_NEODOVE_4',
    updateEndpointRef: 'NEODOVE_UPDATE_ENDPOINT_CRM_NEODOVE_4',
    audienceFilter: { category: 'all' },
    mirrorConfig: {
        pipeline: 'Sales',
        managedBy: 'Chirag garg',
        leadDistribution: 'on_demand',
        observedAt: '2026-08-25T06:22:00.000Z',
    },
};

for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) {
    if (!process.env[key]) {
        console.error(`${key} is not set — run with --env-file=.env.local`);
        process.exit(1);
    }
}

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    max: 1,
});

async function seedUser() {
    console.log(`ASM login: ${USER.email}`);

    const { data: { users: authUsers }, error: listErr } =
        await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) throw new Error(`listUsers: ${listErr.message}`);

    // Supabase Auth lowercases emails; compare case-insensitively so a
    // mixed-case duplicate isn't created alongside the real account.
    const existing = authUsers.find(
        (a) => (a.email || '').toLowerCase() === USER.email.toLowerCase()
    );

    let authId;
    if (existing) {
        authId = existing.id;
        const { error } = await supabase.auth.admin.updateUserById(authId, {
            password: USER.password,
            app_metadata: { ...(existing.app_metadata || {}), role: USER.role },
        });
        if (error) throw new Error(`updateUserById: ${error.message}`);
        console.log(`  auth user existed — password + role refreshed (${authId})`);
    } else {
        const { data: created, error } = await supabase.auth.admin.createUser({
            email: USER.email,
            password: USER.password,
            email_confirm: true,
            app_metadata: { role: USER.role },
        });
        if (error) throw new Error(`createUser: ${error.message}`);
        authId = created.user.id;
        console.log(`  auth user created (${authId})`);
    }

    // Keyed on id, not email: auth-utils resolves the session user by id, and a
    // users row under a different id is invisible to it no matter how the email
    // reads.
    await sql`
        INSERT INTO users (id, email, name, role, is_active, must_change_password, created_at, updated_at)
        VALUES (${authId}::uuid, ${USER.email}, ${USER.name}, ${USER.role}, true, false, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            is_active = true,
            must_change_password = false,
            updated_at = NOW()
    `;
    console.log('  users row ready');

    const { error: loginErr } = await supabase.auth.signInWithPassword({
        email: USER.email,
        password: USER.password,
    });
    if (loginErr) throw new Error(`login test: ${loginErr.message}`);
    console.log('  login verified');

    return authId;
}

async function seedCampaign(ownerUserId) {
    console.log(`\nCampaign: ${CAMPAIGN.name}`);

    // Guard the string the whole integration hangs on: two CRM campaigns sharing
    // a neodove_campaign_name make inbound dispositions ambiguous, because that
    // name is the only key NeoDove sends back.
    const clash = await sql`
        SELECT id FROM neodove_campaigns
         WHERE neodove_campaign_name = ${CAMPAIGN.neodoveCampaignName}
           AND id <> ${CAMPAIGN.id}
    `;
    if (clash.length) {
        throw new Error(
            `neodove_campaign_name "${CAMPAIGN.neodoveCampaignName}" is already on ` +
                `campaign ${clash[0].id} — inbound dispositions would be ambiguous.`
        );
    }

    // Same guard for the endpoint ref: two campaigns pointing at one Custom
    // Integration URL both deliver into the same NeoDove campaign, silently.
    const dupRef = await sql`
        SELECT id FROM neodove_campaigns
         WHERE push_endpoint_ref = ${CAMPAIGN.pushEndpointRef}
           AND id <> ${CAMPAIGN.id}
    `;
    if (dupRef.length) {
        throw new Error(
            `push_endpoint_ref ${CAMPAIGN.pushEndpointRef} is already used by ${dupRef[0].id}.`
        );
    }

    await sql`
        INSERT INTO neodove_campaigns (
            id, name, neodove_campaign_name, push_endpoint_ref, update_endpoint_ref,
            audience_filter, mirror_config, crm_owner_user_id, status,
            created_at, updated_at
        ) VALUES (
            ${CAMPAIGN.id}, ${CAMPAIGN.name}, ${CAMPAIGN.neodoveCampaignName},
            ${CAMPAIGN.pushEndpointRef}, ${CAMPAIGN.updateEndpointRef},
            ${sql.json(CAMPAIGN.audienceFilter)}, ${sql.json(CAMPAIGN.mirrorConfig)},
            ${ownerUserId}, 'draft', NOW(), NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            neodove_campaign_name = EXCLUDED.neodove_campaign_name,
            push_endpoint_ref = EXCLUDED.push_endpoint_ref,
            update_endpoint_ref = EXCLUDED.update_endpoint_ref,
            audience_filter = EXCLUDED.audience_filter,
            mirror_config = EXCLUDED.mirror_config,
            crm_owner_user_id = EXCLUDED.crm_owner_user_id,
            updated_at = NOW()
    `;
    console.log(`  row ready (${CAMPAIGN.id}) -> owner ${ownerUserId}`);

    // isEndpointWired() is what the Send-to-NeoDove dropdown gates on. It reads
    // process.env at request time, so a ref with no value looks fine here and
    // fails at push — check it now, in this process, against the same env.
    if (!process.env[CAMPAIGN.pushEndpointRef]) {
        console.warn(
            `  WARNING: ${CAMPAIGN.pushEndpointRef} is not set in this environment — ` +
                `the campaign will show as unwired until it is.`
        );
    } else {
        console.log(`  ${CAMPAIGN.pushEndpointRef} resolves — campaign is wired`);
    }
}

(async () => {
    try {
        const authId = await seedUser();
        await seedCampaign(authId);
        console.log('\n──────────────────────────────────────────────');
        console.log(`  ${USER.email}  /  ${USER.password}  ->  /asm`);
        console.log(`  ${CAMPAIGN.name}  (${CAMPAIGN.id})`);
        console.log('──────────────────────────────────────────────\n');
        await sql.end();
        process.exit(0);
    } catch (err) {
        console.error('Fatal:', err.message || err);
        try {
            await sql.end();
        } catch {}
        process.exit(1);
    }
})();
