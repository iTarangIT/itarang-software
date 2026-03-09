# N8N Workflow Import Instructions

## Using the Migrated Workflow JSON

I've created a pre-migrated workflow JSON with all Postgres nodes replaced by Supabase nodes.

**File:** [itarang_v4_1_bolna_webhook_receiver_MIGRATED.json](file:///Users/apoorvgupta/Library/CloudStorage/OneDrive-Personal/Documents/Apoorv/Sanchit%20EV%20Business/v4%20design/ui/v4_1-itarang/n8n-workflows/itarang_v4_1_bolna_webhook_receiver_MIGRATED.json)

---

## Import Steps

### 1. Setup Supabase Credential First

Before importing, create your Supabase credential in n8n:

1. Login to n8n: https://n8n.srv1128060.hstgr.cloud
2. Go to **Settings** → **Credentials**
3. Click **Add Credential**
4. Select **Supabase API**
5. Configure:
   - **Name:** `Supabase - itarang v4`
   - **Host:** `https://vfefaofazapbfuxavxrp.supabase.co`
   - **Service Role Key:** (from your `.env.local`)
6. Click **Save**
7. **Copy the credential ID** (you'll need this)

### 2. Update the JSON File

Open the migrated JSON file and replace all instances of:

```json
"REPLACE_WITH_YOUR_SUPABASE_CREDENTIAL_ID"
```

With your actual Supabase credential ID from step 1.

**Find and replace:**
- Search: `REPLACE_WITH_YOUR_SUPABASE_CREDENTIAL_ID`
- Replace: Your actual credential ID (e.g., `abc123def456`)

### 3. Import to n8n

1. Go to **Workflows** in n8n
2. Click **Import from File**
3. Select the updated JSON file
4. Click **Import**

### 4. Verify Connections

After import, open the workflow and verify:

- [ ] All Supabase nodes show green checkmarks
- [ ] Credential is properly linked
- [ ] All connections between nodes are intact
- [ ] Switch node conditions are correct

### 5. Test the Workflow

Activate the workflow and test with curl:

```bash
curl -X POST https://n8n.srv1128060.hstgr.cloud/webhook/bolna/itarang-v4 \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "call_initiated",
    "body": {
      "call_id": "test-import-001"
    }
  }'
```

### 6. Deactivate Old Workflow

Once verified:
1. Deactivate the old `itarang_v4_1_bolna_webhook_receiver` workflow
2. Rename the new workflow (remove "_MIGRATED")
3. Keep the old one as backup (or delete after confirming)

---

## What Was Changed

The migrated workflow has:

✅ **7 Postgres nodes replaced** with Supabase nodes:
1. Update Call Initiated
2. Update Phase Changed
3. Update Call Paused
4. Update Call Resumed
5. Update Call Ended
6. Append Transcript Chunk
7. Store Full Transcript

✅ **SQL queries corrected** to use `initiated_at` instead of `started_at`

✅ **All connections preserved** - workflow logic unchanged

✅ **Credentials ready** - just need to add your credential ID

---

## Troubleshooting

### Issue: "Credential not found"
- Make sure you created the Supabase credential first
- Verify the credential ID matches exactly

### Issue: "Invalid JSON"
- Check you didn't break any JSON syntax when replacing credential ID
- Use a JSON validator if needed

### Issue: "Node execution failed"
- Check that `bolna_calls` table exists in Supabase
- Verify service role key has correct permissions
- Test SQL queries directly in Supabase SQL Editor

---

## Quick Import (Alternative)

If you don't want to manually replace credential IDs:

1. Import the JSON as-is
2. Open each Supabase node
3. Manually select your Supabase credential from dropdown
4. Save the workflow

This takes a bit longer but doesn't require editing the JSON file.
