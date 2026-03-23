import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env.local') });

import { db } from './index';
import { users } from './schema';
import { v4 as uuidv4 } from 'uuid';

async function seedUsers() {
    console.log('👤 Seeding initial users...');

    const initialUsers = [
        {
            id: uuidv4(),
            email: 'ceo@itarang.com',
            name: 'Sanchit Gupta',
            role: 'ceo',
            phone: '+91 98765 00001',
            is_active: true,
        },
        {
            id: uuidv4(),
            email: 'business@itarang.com',
            name: 'Rajesh Kumar',
            role: 'business_head',
            phone: '+91 98765 00002',
            is_active: true,
        },
        {
            id: uuidv4(),
            email: 'sales.head@itarang.com',
            name: 'Priya Singh',
            role: 'sales_head',
            phone: '+91 98765 00003',
            is_active: true,
        },
        {
            id: uuidv4(),
            email: 'finance@itarang.com',
            name: 'Amit Verma',
            role: 'finance_controller',
            phone: '+91 98765 00004',
            is_active: true,
        },
    ];

    try {
        await db.insert(users).values(initialUsers).onConflictDoNothing();
        console.log(`✅ Successfully seeded ${initialUsers.length} users.`);
        console.table(initialUsers.map(u => ({ email: u.email, role: u.role, name: u.name })));
    } catch (error) {
        console.error('❌ Error seeding users:', error);
        throw error;
    }

    process.exit(0);
}

seedUsers().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
