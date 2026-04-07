
import { config } from 'dotenv';
import path from 'path';

// Load env vars from .env.local FIRST
config({ path: path.resolve(process.cwd(), '.env.local') });

import { v4 as uuidv4 } from 'uuid';

const USERS = [
    { email: 'ceo@itarang.com', name: 'Sanchit Gupta', role: 'ceo', phone: '+91 98765 00001' },
    { email: 'business@itarang.com', name: 'Rajesh Kumar', role: 'business_head', phone: '+91 98765 00002' },
    { email: 'sales.head@itarang.com', name: 'Priya Singh', role: 'sales_head', phone: '+91 98765 00003' },
    { email: 'finance@itarang.com', name: 'Amit Verma', role: 'finance_controller', phone: '+91 98765 00004' },
    { email: 'service@itarang.com', name: 'Vikram Singh', role: 'service_engineer', phone: '+91 98765 00005' },
    { email: 'operations@itarang.com', name: 'Neha Sharma', role: 'sales_order_manager', phone: '+91 98765 00006' },
    { email: 'sales.manager@itarang.com', name: 'Rohan Mehta', role: 'sales_manager', phone: '+91 98765 00007' }
];

async function seed() {
    // Dynamic imports to ensure env vars are loaded
    const { db } = await import('./index');
    const {
        users,
        oems,
        products,
        productCategories,
        leads,
        leadAssignments,
        provisions,
        orders,
        accounts,
        inventory,
        deals,
        oemInventoryForPDI,
        pdiRecords,
        slas
    } = await import('./schema');
    const { eq } = await import('drizzle-orm');

    console.log('🌱 Starting Full Dashboard Seed...');

    // 1. Seed/Sync Users
    console.log('👤 Seeding Users...');
    const userMap = new Map<string, string>(); // role -> id

    for (const u of USERS) {
        // Try to find existing user first to avoid PK violations if they exist
        // In a real scenario, we might want to use upsert, but users usually come from Auth
        // For this mock seed, we'll check by email.

        let userId = uuidv4();

        // Check if exists in DB (maybe synced from Auth or seeded before)
        const existing = await db.select().from(users).where(eq(users.email, u.email)).limit(1);

        if (existing.length > 0) {
            userId = existing[0].id;
            console.log(`   - Found existing user: ${u.role} (${userId})`);
        } else {
            console.log(`   - Creating new user: ${u.role}`);
            await db.insert(users).values({
                id: userId,
                email: u.email,
                name: u.name,
                role: u.role,
                phone: u.phone,
                is_active: true,
                created_at: new Date(),
                updated_at: new Date()
            });
        }
        userMap.set(u.role, userId);
    }

    const ceoId = userMap.get('ceo')!;
    const salesHeadId = userMap.get('sales_head')!;
    const salesManagerId = userMap.get('sales_manager')!;
    const serviceEngId = userMap.get('service_engineer')!;

    // 2. Seed/Find OEMs
    console.log('🏭 Seeding OEMs...');
    const oemsData = [
        {
            id: 'OEM-SEED-001',
            business_entity_name: 'Livguard Energy Technologies',
            gstin: '06AAACL1234A1Z1',
            status: 'active',
            created_by: ceoId,
            bank_account_number: '1234567890',
            ifsc_code: 'HDFC0000123'
        },
        {
            id: 'OEM-SEED-002',
            business_entity_name: 'Exide Industries',
            gstin: '19AAACE1234E1Z1',
            status: 'active',
            created_by: ceoId,
            bank_account_number: '0987654321',
            ifsc_code: 'ICIC0000999'
        }
    ];

    const oemIdMap = new Map<string, string>(); // gstin -> id

    for (const oem of oemsData) {
        // Check if exists by GSTIN
        const existing = await db.select().from(oems).where(eq(oems.gstin, oem.gstin)).limit(1);
        if (existing.length > 0) {
            console.log(`   - Found existing OEM: ${oem.business_entity_name} (${existing[0].id})`);
            oemIdMap.set(oem.gstin, existing[0].id);
        } else {
            console.log(`   - Creating new OEM: ${oem.business_entity_name}`);
            await db.insert(oems).values(oem);
            oemIdMap.set(oem.gstin, oem.id);
        }
    }

    const livguardId = oemIdMap.get('06AAACL1234A1Z1')!;
    const exideId = oemIdMap.get('19AAACE1234E1Z1')!;
    const oemIds = [livguardId, exideId]; // Update oemIds array to use resolved IDs

    // 3. Seed Product Categories + Products
    console.log('🔋 Seeding Products...');
    let [cat3w] = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.slug, '3w-batteries'))
        .limit(1);
    if (!cat3w) {
        [cat3w] = await db.insert(productCategories).values({
            name: '3W Batteries',
            slug: '3w-batteries',
            is_active: true,
        }).returning();
    }

    const seedProducts = await db.insert(products).values([
        {
            category_id: cat3w.id,
            name: '3W Battery 51V 105AH',
            slug: '3w-battery-51v-105ah',
            sku: '3W-51V-105AH',
            hsn_code: '85076000',
            asset_type: 'Battery',
            voltage_v: 51,
            capacity_ah: 105,
            is_serialized: true,
            warranty_months: 36,
            status: 'active',
            is_active: true,
            sort_order: 1,
        },
        {
            category_id: cat3w.id,
            name: '3W Battery 61V 105AH',
            slug: '3w-battery-61v-105ah',
            sku: '3W-61V-105AH',
            hsn_code: '85076000',
            asset_type: 'Battery',
            voltage_v: 61,
            capacity_ah: 105,
            is_serialized: true,
            warranty_months: 36,
            status: 'active',
            is_active: true,
            sort_order: 2,
        },
        {
            category_id: cat3w.id,
            name: '3W Charger 72V 15A',
            slug: '3w-charger-72v-15a',
            sku: '3W-CHG-72V-15A',
            hsn_code: '85044030',
            asset_type: 'Charger',
            is_serialized: true,
            warranty_months: 12,
            status: 'active',
            is_active: true,
            sort_order: 12,
        },
    ]).onConflictDoNothing().returning();

    const productIds = seedProducts.map(p => p.id);

    // 4. Seed Accounts (Dealers)
    console.log('🤝 Seeding Accounts...');
    const accountIds = ['ACC-SEED-001', 'ACC-SEED-002', 'ACC-SEED-003'];
    await db.insert(accounts).values([
        {
            id: accountIds[0],
            business_name: 'Rahul Motors (North West)',
            owner_name: 'Rahul Sharma',
            status: 'active',
            shipping_address: 'Jaipur, Rajasthan'
        },
        {
            id: accountIds[1],
            business_name: 'Green Energy NCR',
            owner_name: 'Suresh Raina',
            status: 'active',
            shipping_address: 'Noida, UP'
        },
        {
            id: accountIds[2],
            business_name: 'South Auto Spares',
            owner_name: 'Venkatesh',
            status: 'active',
            shipping_address: 'Bangalore, Karnataka'
        }
    ]).onConflictDoNothing();

    // 5. Seed Leads & Assignments
    console.log('📈 Seeding Leads...');
    const leadsData = [
        // Hot Lead (Sales Manager)
        {
            id: 'LEAD-SEED-001',
            lead_source: 'digital_marketing',
            interest_level: 'hot',
            lead_status: 'qualified',
            owner_name: 'Amit',
            owner_contact: '9999999999',
            state: 'Delhi',
            city: 'New Delhi',
            uploader_id: salesManagerId
        },
        // Warm Lead (Sales Manager)
        {
            id: 'LEAD-SEED-002',
            lead_source: 'call_center',
            interest_level: 'warm',
            lead_status: 'new',
            owner_name: 'Sumit',
            owner_contact: '8888888888',
            state: 'Haryana',
            city: 'Gurugram',
            uploader_id: salesManagerId
        },
        // Converted Lead (Sales Head)
        {
            id: 'LEAD-SEED-003',
            lead_source: 'dealer_referral',
            interest_level: 'hot',
            lead_status: 'converted',
            owner_name: 'Rahul Motors',
            owner_contact: '7777777777',
            state: 'Rajasthan',
            city: 'Jaipur',
            uploader_id: salesHeadId
        },
        // Pending Approval Lead (Business Head)
        {
            id: 'LEAD-SEED-004',
            lead_source: 'ground_sales',
            interest_level: 'hot',
            lead_status: 'qualified', // Or pending_l1_approval equivalent?
            owner_name: 'Big Buyer',
            owner_contact: '6666666666',
            state: 'Karnataka',
            city: 'Bangalore',
            uploader_id: salesHeadId
        }
    ];

    await db.insert(leads).values(leadsData).onConflictDoNothing();

    // Assign leads
    await db.insert(leadAssignments).values([
        { id: 'ASSIGN-001', lead_id: 'LEAD-SEED-001', lead_owner: salesManagerId, assigned_by: salesHeadId },
        { id: 'ASSIGN-002', lead_id: 'LEAD-SEED-002', lead_owner: salesManagerId, assigned_by: salesHeadId },
        { id: 'ASSIGN-003', lead_id: 'LEAD-SEED-003', lead_owner: salesHeadId, assigned_by: ceoId },
    ]).onConflictDoNothing();


    // 6. Seed Deals (Revenue Data)
    console.log('💰 Seeding Deals...');
    const dealIds = ['DEAL-SEED-001', 'DEAL-SEED-002', 'DEAL-SEED-003', 'DEAL-SEED-004', 'DEAL-SEED-005'];

    // Historical deals for trend
    const historicalDeals = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        historicalDeals.push({
            id: `DEAL-TREND-${i}`,
            lead_id: 'LEAD-SEED-003',
            products: [{ product_id: productIds[0], quantity: Math.floor(Math.random() * 10) + 1, unit_price: 35000, gst_percent: 18 }],
            line_total: (35000 * 5).toString(),
            gst_amount: (35000 * 5 * 0.18).toString(),
            total_payable: (35000 * 5 * 1.18).toString(),
            payment_term: 'advance',
            deal_status: 'converted',
            created_by: salesHeadId,
            created_at: date
        });
    }

    await db.insert(deals).values([
        ...historicalDeals,
        // Converted Deal (Revenue for CEO)
        {
            id: dealIds[0],
            lead_id: 'LEAD-SEED-003',
            products: [{ product_id: productIds[0], quantity: 10, unit_price: 35000, gst_percent: 18 }],
            line_total: '350000',
            gst_amount: '63000',
            total_payable: '413000',
            payment_term: 'advance',
            deal_status: 'converted',
            created_by: salesHeadId,
            created_at: new Date()
        },
        // Pending L2 Approval (For Business Head Queue)
        {
            id: dealIds[1],
            lead_id: 'LEAD-SEED-004',
            products: [{ product_id: productIds[0], quantity: 50, unit_price: 34000, gst_percent: 18 }],
            line_total: '1700000',
            gst_amount: '306000',
            total_payable: '2006000',
            payment_term: 'credit',
            deal_status: 'pending_approval_l2',
            created_by: salesHeadId,
            created_at: new Date()
        }
    ]).onConflictDoNothing();

    // 7. Seed Inventory & Provisions
    console.log('🏭 Seeding Inventory & Provisions...');
    const provIds = ['PROV-SEED-001', 'PROV-SEED-002', 'PROV-SEED-003'];
    await db.insert(provisions).values([
        {
            id: provIds[0],
            oem_id: livguardId,
            oem_name: 'Livguard',
            products: [{ product_id: productIds[0], quantity: 20 }],
            expected_delivery_date: new Date(),
            status: 'completed',
            created_by: ceoId
        },
        {
            id: provIds[1],
            oem_id: exideId,
            oem_name: 'Exide',
            products: [{ product_id: productIds[1], quantity: 15 }],
            expected_delivery_date: new Date(Date.now() + 86400000 * 3),
            status: 'pending',
            created_by: ceoId
        },
        {
            id: provIds[2],
            oem_id: livguardId,
            oem_name: 'Livguard',
            products: [{ product_id: productIds[2], quantity: 50 }],
            expected_delivery_date: new Date(Date.now() + 86400000 * 5),
            status: 'acknowledged',
            created_by: ceoId
        }
    ]).onConflictDoNothing();

    // Inventory Items (Available)
    const invIds = Array.from({ length: 10 }, (_, i) => `INV-SEED-${i + 1}`);
    const invValues = invIds.map(id => ({
        id,
        product_id: productIds[0],
        oem_id: oemIds[0],
        oem_name: 'Livguard',
        asset_category: '3W',
        asset_type: 'Battery',
        model_type: 'With IOT 51.2 V-105AH',
        serial_number: `BAT-${id}`,
        manufacturing_date: new Date(),
        expiry_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 3),
        inventory_amount: '30000',
        gst_percent: '18',
        gst_amount: '5400',
        final_amount: '35400',
        oem_invoice_number: 'INV-OEM-001',
        oem_invoice_date: new Date(),
        status: 'available', // Checked by CEO dashboard for Inventory Value
        created_by: ceoId
    }));
    await db.insert(inventory).values(invValues).onConflictDoNothing();


    // 8. Seed Orders (Sales Order Manager & Finance)
    console.log('🚚 Seeding Orders...');
    // Order 1: Unpaid, Credit (Outstanding Credit Calculation)
    const order1Id = 'ORD-SEED-001';
    await db.insert(orders).values({
        id: order1Id,
        provision_id: 'PROV-SEED-001', // Ideally invalid link but schema fk might pass if prov exists. 
        // Actually order provision_id refers to Procurement Provision? 
        // No, Orders are Sales Orders. PROVISIONS are Procurement.
        // Wait, schema says orders.provision_id references provisions.id?
        // Line 505: provision: one(provisions, ...)
        // Line 365: provision_id varchar references provisions.id
        oem_id: oemIds[0],
        account_id: accountIds[0],
        order_items: [{ inventory_id: 'INV-SOLD-FAKE', amount: 413000 }],
        total_amount: '413000',
        payment_term: 'credit',
        credit_period_days: 30,
        payment_status: 'unpaid', // For Finance Outstanding
        order_status: 'delivered',
        created_by: salesHeadId,
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 15) // 15 days ago
    }).onConflictDoNothing();

    // Order 2: Pending Dispatch (For Sales Order Manager)
    await db.insert(orders).values({
        id: 'ORD-SEED-002',
        provision_id: 'PROV-SEED-001',
        oem_id: oemIds[0],
        account_id: accountIds[1],
        order_items: [],
        total_amount: '200000',
        payment_term: 'advance',
        payment_status: 'paid',
        delivery_status: 'pending',
        // Line 391 order_status: ... in_transit, delivered
        // Line 392 delivery_status: pending, in_transit
        // Let's set order_status='payment_made' and delivery_status='pending' for "Pending Dispatch"
        // Wait, Route.ts queries: shipping_status? 
        // Line 240: count(sql`CASE WHEN shipping_status = 'pending' THEN 1 END`)
        // BUT Schema `orders` (Line 363) DOES NOT HAVE `shipping_status`.
        // It has `delivery_status`.
        // This means the API Route is likely Broken/Mocked aggressively or using a field that doesn't exist.
        // I will fix this in Route Refactor. I will use `delivery_status`.

        delivery_status: 'pending',
        created_by: salesManagerId
    }).onConflictDoNothing();

    // Order 3: In Transit
    await db.insert(orders).values({
        id: 'ORD-SEED-003',
        provision_id: 'PROV-SEED-001',
        oem_id: oemIds[0],
        account_id: accountIds[2],
        order_items: [],
        total_amount: '150000',
        payment_term: 'advance',
        payment_status: 'paid',
        order_status: 'in_transit',
        delivery_status: 'in_transit',
        created_by: salesManagerId
    }).onConflictDoNothing();


    // Historical orders for trend (Last 7 days)
    console.log('📦 Seeding Historical Orders...');
    const historicalOrders = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);

        // Received volume (Created on this day)
        const receivedCount = Math.floor(Math.random() * 5) + 3;
        for (let j = 0; j < receivedCount; j++) {
            historicalOrders.push({
                id: `ORD-HIST-REC-${i}-${j}`,
                provision_id: provIds[0],
                oem_id: oemIds[0],
                account_id: accountIds[0],
                order_items: [],
                total_amount: '100000',
                payment_term: 'advance',
                payment_status: 'paid',
                order_status: 'payment_made',
                delivery_status: 'pending',
                created_by: salesManagerId,
                created_at: date,
                updated_at: date
            });
        }

        // Dispatched volume (Updated to in_transit on this day)
        const dispatchedCount = Math.floor(Math.random() * 4) + 2;
        for (let j = 0; j < dispatchedCount; j++) {
            historicalOrders.push({
                id: `ORD-HIST-DISP-${i}-${j}`,
                provision_id: provIds[0],
                oem_id: oemIds[0],
                account_id: accountIds[1],
                order_items: [],
                total_amount: '120000',
                payment_term: 'advance',
                payment_status: 'paid',
                order_status: 'in_transit',
                delivery_status: 'in_transit',
                created_by: salesManagerId,
                created_at: new Date(date.getTime() - 86400000),
                updated_at: date
            });
        }
    }
    await db.insert(orders).values(historicalOrders).onConflictDoNothing();


    // 9. Seed PDI Records (Service Engineer)
    console.log('🔧 Seeding PDI Records...');
    // We need oem_inventory_for_pdi first
    // Link to one of the seeded inventories
    const pdiInvId = 'INV-SEED-1';
    const pdiReqId = 'PDIREQ-SEED-001';

    await db.insert(oemInventoryForPDI).values({
        id: pdiReqId,
        provision_id: 'PROV-SEED-001',
        inventory_id: pdiInvId,
        oem_id: oemIds[0],
        pdi_status: 'completed'
    }).onConflictDoNothing();

    // Passed PDI
    await db.insert(pdiRecords).values({
        id: 'PDI-SEED-001',
        oem_inventory_id: pdiReqId,
        provision_id: 'PROV-SEED-001',
        service_engineer_id: serviceEngId,
        physical_condition: 'OK - No issues',
        discharging_connector: 'SB75',
        charging_connector: 'SB50',
        productor_sticker: 'Available - OK',
        voltage: '51.2',
        latitude: '28.7041',
        longitude: '77.1025',
        pdi_status: 'pass',
        inspected_at: new Date()
    }).onConflictDoNothing();

    // Failed PDI (Need another inventory item)
    const pdiInvId2 = 'INV-SEED-2';
    const pdiReqId2 = 'PDIREQ-SEED-002';

    await db.insert(oemInventoryForPDI).values({
        id: pdiReqId2,
        provision_id: 'PROV-SEED-001',
        inventory_id: pdiInvId2,
        oem_id: oemIds[0],
        pdi_status: 'completed'
    }).onConflictDoNothing();

    await db.insert(pdiRecords).values({
        id: 'PDI-SEED-002',
        oem_inventory_id: pdiReqId2,
        provision_id: 'PROV-SEED-001',
        service_engineer_id: serviceEngId,
        physical_condition: 'Damaged exterior',
        discharging_connector: 'SB75',
        charging_connector: 'SB50',
        productor_sticker: 'Available - damage',
        voltage: '40.0', // Low voltage
        latitude: '28.7041',
        longitude: '77.1025',
        pdi_status: 'fail',
        failure_reason: 'Low Voltage & Damaged',
        inspected_at: new Date()
    }).onConflictDoNothing();


    console.log('✅ Full Dashboard Seed Completed Successfully!');
    process.exit(0);
}

seed().catch(err => {
    console.error('❌ Formatting Error:', err);
    process.exit(1);
});
