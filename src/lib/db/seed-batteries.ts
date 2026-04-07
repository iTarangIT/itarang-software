
import { config } from 'dotenv';
config({ path: '.env.local' });
import { db } from './index';
import { products, productCategories } from './schema';
import { eq } from 'drizzle-orm';

// These match the existing seeded 3W batteries from the Supabase migration
const batterySpecs = [
    { voltage_v: 51, capacity_ah: 105, sku: '3W-51V-105AH', sort_order: 1 },
    { voltage_v: 61, capacity_ah: 105, sku: '3W-61V-105AH', sort_order: 2 },
    { voltage_v: 61, capacity_ah: 132, sku: '3W-61V-132AH', sort_order: 3 },
    { voltage_v: 61, capacity_ah: 153, sku: '3W-61V-153AH', sort_order: 4 },
    { voltage_v: 64, capacity_ah: 105, sku: '3W-64V-105AH', sort_order: 5 },
    { voltage_v: 64, capacity_ah: 132, sku: '3W-64V-132AH', sort_order: 6 },
    { voltage_v: 64, capacity_ah: 153, sku: '3W-64V-153AH', sort_order: 7 },
    { voltage_v: 72, capacity_ah: 105, sku: '3W-72V-105AH', sort_order: 8 },
    { voltage_v: 72, capacity_ah: 132, sku: '3W-72V-132AH', sort_order: 9 },
    { voltage_v: 72, capacity_ah: 153, sku: '3W-72V-153AH', sort_order: 10 },
    { voltage_v: 72, capacity_ah: 232, sku: '3W-72V-232AH', sort_order: 11 },
];

export async function seedBatteries() {
    console.log('🌱 Seeding 3W Battery Products...');

    // Ensure category exists
    let [cat] = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.slug, '3w-batteries'))
        .limit(1);

    if (!cat) {
        [cat] = await db.insert(productCategories).values({
            name: '3W Batteries',
            slug: '3w-batteries',
            is_active: true,
        }).returning();
        console.log('✅ Created category: 3W Batteries');
    }

    const variants = batterySpecs.map(spec => ({
        category_id: cat.id,
        name: `3W Battery ${spec.voltage_v}V ${spec.capacity_ah}AH`,
        slug: spec.sku.toLowerCase(),
        sku: spec.sku,
        hsn_code: '85076000',
        asset_type: 'Battery',
        voltage_v: spec.voltage_v,
        capacity_ah: spec.capacity_ah,
        is_serialized: true,
        warranty_months: 36,
        status: 'active',
        is_active: true,
        sort_order: spec.sort_order,
    }));

    try {
        await db.insert(products).values(variants).onConflictDoNothing();
        console.log(`✅ Successfully seeded ${variants.length} battery variants.`);
    } catch (error) {
        console.error('❌ Error seeding batteries:', error);
    }
}

if (require.main === module) {
    seedBatteries()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
