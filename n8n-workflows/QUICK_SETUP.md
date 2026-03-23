# Quick Setup: n8n Postgres Credential for Supabase

## Your Supabase Connection Details

Based on your `.env.local` file:

```
Project: eahydskawkcbhppnnvev
Region: ap-south-1
Password: MYsupabase@2025
```

---

## Create Postgres Credential in n8n

1. **Login:** https://n8n.srv1128060.hstgr.cloud
2. **Go to:** Settings → Credentials → Add Credential
3. **Select:** Postgres
4. **Enter these exact values:**

```
Credential Name: Supabase Postgres - itarang v4

Host: db.eahydskawkcbhppnnvev.supabase.co
Database: postgres
User: postgres
Password: MYsupabase@2025
Port: 6543

SSL: ✓ Enabled
```

> **Important:** Use port **6543** (connection pooler) for n8n, not 5432.

5. **Click "Test"** - should show success
6. **Click "Save"**

---

## Update Your Workflow

1. Open workflow: `itarang_v4_1_bolna_webhook_receiver`
2. For each of the 7 Postgres nodes, just update the credential:
   - Click node
   - Change **Credential** dropdown to: `Supabase Postgres - itarang v4`
   - Save

**That's it!** Keep all SQL queries exactly as they are.

---

## Test It

```bash
curl -X POST https://n8n.srv1128060.hstgr.cloud/webhook/bolna/itarang-v4 \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "call_initiated",
    "body": {
      "call_id": "test-new-credential-001"
    }
  }'
```

Check Supabase Table Editor → `bolna_calls` for the new record.

---

## Summary

✅ **Keep using Postgres nodes** - Don't change to Supabase nodes  
✅ **Just update the credential** - Point to Supabase's database  
✅ **No code changes needed** - All SQL queries work as-is  

This is the correct way to use Supabase with n8n when you need raw SQL!
