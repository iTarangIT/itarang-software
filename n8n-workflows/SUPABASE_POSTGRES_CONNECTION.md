# Supabase Database Connection for n8n (Postgres Node)

## Why This Approach?

The n8n Supabase node doesn't support raw SQL execution. However, Supabase uses PostgreSQL under the hood, so we can use the **Postgres node** and connect it directly to Supabase's database.

---

## Setup Instructions

### Step 1: Get Supabase Connection Details

1. Open **Supabase Dashboard**: https://supabase.com/dashboard
2. Select your project
3. Go to **Settings** → **Database**
4. Find the **Connection string** section
5. Copy the **Connection pooling** string (recommended for n8n)

**Example format:**
```
postgresql://postgres.vfefaofazapbfuxavxrp:[YOUR-PASSWORD]@aws-0-us-west-1.pooler.supabase.com:6543/postgres
```

### Step 2: Parse Connection Details

From the connection string, extract:

| Field | Example | Your Value |
|-------|---------|------------|
| **Host** | `aws-0-us-west-1.pooler.supabase.com` | |
| **Port** | `6543` | |
| **Database** | `postgres` | |
| **User** | `postgres.vfefaofazapbfuxavxrp` | |
| **Password** | Your database password | |

### Step 3: Create Postgres Credential in n8n

1. **Login to n8n:** https://n8n.srv1128060.hstgr.cloud
2. **Go to Settings** → **Credentials**
3. **Click "Add Credential"**
4. **Search for "Postgres"** (NOT Supabase)
5. **Configure:**

```
Credential Name: Supabase Postgres - itarang v4

Connection:
- Host: aws-0-us-west-1.pooler.supabase.com
- Database: postgres
- User: postgres.vfefaofazapbfuxavxrp
- Password: [your-database-password]
- Port: 6543

SSL:
- SSL: Enabled (toggle on)
```

6. **Click "Test"** to verify connection
7. **Click "Save"**

### Step 4: Update Existing Workflow

1. **Open workflow:** `itarang_v4_1_bolna_webhook_receiver`
2. **For each Postgres node:**
   - Click the node
   - Change **Credential** to your new "Supabase Postgres - itarang v4"
   - Keep everything else the same
   - Click **Save**

---

## Connection Pooling vs Direct Connection

**Connection Pooling (Port 6543)** - Recommended
- Better for n8n and serverless environments
- Handles connection limits automatically
- Use this for production

**Direct Connection (Port 5432)** - Alternative
- Direct database access
- May hit connection limits with many workflows
- Use only if pooling has issues

---

## SQL Queries (Already Correct)

Your existing Postgres nodes already have the correct SQL. Just update the credentials:

### Example Node Configuration:

```
Node: Update Call Initiated
Type: Postgres
Credential: Supabase Postgres - itarang v4
Operation: Execute Query
Query: UPDATE bolna_calls 
       SET status = 'initiated', 
           initiated_at = NOW(),
           updated_at = NOW()
       WHERE bolna_call_id = '{{$json.body.call_id}}' 
       RETURNING *;
```

---

## Verification

After updating credentials, test with:

```bash
curl -X POST https://n8n.srv1128060.hstgr.cloud/webhook/bolna/itarang-v4 \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "call_initiated",
    "body": {
      "call_id": "test-postgres-credential-001"
    }
  }'
```

Then check in Supabase → Table Editor → bolna_calls for the new record.

---

## Troubleshooting

### "Connection refused"
- Check host and port are correct
- Verify your IP is allowed (Supabase → Settings → Database → Connection pooling → Allow list)

### "Authentication failed"
- Verify password is correct
- Check user format: `postgres.[project-ref]`

### "SSL required"
- Make sure SSL is enabled in the credential

### "Too many connections"
- Use connection pooling (port 6543) instead of direct connection (5432)

---

## Summary

✅ **No need to change node types** - Keep using Postgres nodes  
✅ **Just update the credential** - Point to Supabase's Postgres database  
✅ **Same SQL queries work** - No code changes needed  
✅ **Better than Supabase node** - Full SQL support  

This is actually the **recommended approach** for using Supabase with n8n when you need raw SQL execution!
