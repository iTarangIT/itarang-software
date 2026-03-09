
import { db } from '../src/lib/db';
import { accounts, leads } from '../src/lib/db/schema';

async function verify() {
    try {
        console.log('Verifying DB...');
        const allAccounts = await db.select().from(accounts);
        console.log('Accounts found:', allAccounts.length);
        if (allAccounts.length > 0) {
            console.log('First account ID:', allAccounts[0].id);
        }

        const allLeads = await db.select().from(leads).limit(1);
        console.log('Leads table accessible');
    } catch (e: any) {
        console.error('Verification failed:', e.message);
    }
}

verify();
